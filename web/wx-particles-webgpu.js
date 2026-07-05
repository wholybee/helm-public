/*
 * Helm — wx-particles-webgpu.js (WX-25)
 * --------------------------------------------------------------------------
 * WebGPU COMPUTE-pass particle advection for the wind/current layer — the
 * follow-on to the WX-19 colorize path. Advects the particle pool in a
 * WGSL compute shader (same u/v field the scalar colorize uses — the WX-19
 * invariant) and draws the trails GPU-side into its own overlay canvas, so
 * high particle counts cost the main thread nothing.
 *
 * Public API — IDENTICAL to HelmWind (wind-layer.js), so the two engines are
 * interchangeable behind window.__helmWind:
 *     load(url) / setData(json) / setVisible(v) / isVisible()
 *     setNeutral(v) / setOpacity(a) / destroy()
 *
 * Engine selection — HelmWindAuto(map):
 *     Returns a facade immediately (sync, same API). It initializes WebGPU in
 *     the background; if the adapter/device/pipelines fail, or the map is in a
 *     projection/pitch this engine can't project (globe, pitch != 0), it
 *     instantiates the untouched CPU engine (HelmWind) and delegates. The
 *     active path is ALWAYS visible: window.__helmWindMode = 'gpu' | 'cpu',
 *     one console line states the path + reason. No silent substitution
 *     (fail-and-fix-early / WX-30 discipline). Opt out: HELM_WX_WEBGPU=false
 *     (same flag the colorize honours).
 *
 * Advection math is the SAME as the CPU engine (speedFactor, soft clamp,
 * degPerPx, cosLat, viewport-biased respawn, NODATA-honest respawn) so the
 * two paths have visual parity by construction. The map is static while
 * particles animate (both engines pause during interaction and reseed on
 * moveend), so geographic -> screen is one affine (mercator) matrix per view,
 * derived EMPIRICALLY from map.project() probes (no assumptions about tile
 * size or internal transform), applied per-vertex on the GPU. Antimeridian:
 * particle lon is wrapped to the world copy nearest the view centre in the
 * shader (Fiji-safe).
 * --------------------------------------------------------------------------
 */
(function (global) {
  'use strict';

  // Same tunables as wind-layer.js — parity by construction, not by eye.
  var DEFAULTS = {
    particleCount: 30000,  // GPU headroom; actual count still scales with canvas area (same density)
    maxParticleAge: 50,
    fadeOpacity: 0.85,
    lineWidth: 0.9,
    speedFactor: 0.073
  };
  var AREA_PER_PARTICLE = 1050;   // same density as the CPU engine (visual parity)
  var MIN_PARTICLES = 550;
  var BUCKET_MAX_KN = 48;         // ramp domain, matches wind-layer.js buckets
  var NODATA_SENTINEL = 1e30;     // NaN u/v encoded as sentinel (NaN is unreliable through fast-math WGSL)

  // ---- pure helpers (exported for unit tests) -----------------------------

  // Soft speed clamp — byte-for-byte the CPU engine's formula.
  function softClampPx(pxStep) {
    return pxStep > 8 ? 8 + (pxStep - 8) * 0.3 : pxStep;
  }

  // One advection step in geographic degrees — the CPU engine's formula.
  function stepGeo(u, v, degPerPx, cosLat, speedFactor) {
    var spd = Math.sqrt(u * u + v * v);
    var pxStep = softClampPx(spd * speedFactor);
    var stepDeg = pxStep * degPerPx;
    var inv = spd > 1e-6 ? 1 / spd : 0;
    return { dlon: (u * inv) * stepDeg / cosLat, dlat: (v * inv) * stepDeg, spd: spd };
  }

  // Wrap lon into the mercator world copy nearest centerLng (antimeridian-safe draw).
  function normLonNearCenter(lon, centerLng) {
    return lon - 360 * Math.round((lon - centerLng) / 360);
  }

  // WebMercator world coords in [0..1] — matches MapLibre.
  function mercX(lon) { return lon / 360 + 0.5; }
  function mercY(lat) {
    var s = Math.sin(lat * Math.PI / 180);
    s = Math.max(-0.9999, Math.min(0.9999, s));
    return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
  }

  // Affine mercator->CSS-px derived from three map.project() probes at the view
  // centre (exact for pitch-0 views, any bearing/tileSize — no internals assumed).
  //   x' = a*mx + b*my + tx ;  y' = c*mx + d*my + ty
  // p0/pE/pN: projections of centre, centre+dLon, centre+dLat. Pure & testable.
  function affineFromProbes(cLng, cLat, dLon, dLat, p0, pE, pN) {
    var mx0 = mercX(cLng), my0 = mercY(cLat);
    var dmx = mercX(cLng + dLon) - mx0;
    var dmy = mercY(cLat + dLat) - my0;
    if (!dmx || !dmy) return null;
    var a = (pE.x - p0.x) / dmx, c = (pE.y - p0.y) / dmx;   // east probe moves only mercX
    var b = (pN.x - p0.x) / dmy, d = (pN.y - p0.y) / dmy;   // north probe moves only mercY
    return [a, b, p0.x - a * mx0 - b * my0,
            c, d, p0.y - c * mx0 - d * my0];
  }

  // Pack a VELOCITY-format u/v grid into a flat rg float array (NaN -> sentinel).
  function packField(field) {
    var n = field.nx * field.ny, out = new Float32Array(n * 2);
    for (var i = 0; i < n; i++) {
      var u = field.u[i], v = field.v[i];
      out[i * 2] = isFinite(u) ? u : NODATA_SENTINEL;
      out[i * 2 + 1] = isFinite(v) ? v : NODATA_SENTINEL;
    }
    return out;
  }

  // ---- WGSL ----------------------------------------------------------------

  var WGSL_ADVECT = [
    'struct Params {',
    '  degPerPx: f32, cosLat: f32, speedFactor: f32, maxAge: f32,',
    '  west: f32, east: f32, south: f32, north: f32,',        // field bounds (spawn clamp + leave test)
    '  spawnW: f32, spawnE: f32, spawnS: f32, spawnN: f32,',  // spawn box = view ∩ field
    '  lo1: f32, la1: f32, dx: f32, dy: f32,',                // grid header (row 0 = north)
    '  nx: f32, ny: f32, frame: f32, count: f32,',
    '};',
    'struct Particle { lon: f32, lat: f32, age: f32, spd: f32, plon: f32, plat: f32, r0: f32, r1: f32 };',
    '@group(0) @binding(0) var<storage, read_write> ps: array<Particle>;',
    '@group(0) @binding(1) var<uniform> P: Params;',
    '@group(0) @binding(2) var field: texture_2d<f32>;',      // rg32float u/v knots; >=1e29 = NODATA
    '',
    'fn pcg(x: u32) -> u32 {',
    '  var s = x * 747796405u + 2891336453u;',
    '  let w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;',
    '  return (w >> 22u) ^ w;',
    '}',
    'fn rand01(seed: u32) -> f32 { return f32(pcg(seed) & 0xFFFFFFu) / 16777216.0; }',
    '',
    'fn respawn(i: u32, p: ptr<function, Particle>) {',
    '  let base = i * 747u + u32(P.frame) * 2654435761u;',
    '  (*p).lon = mix(P.spawnW, P.spawnE, rand01(base));',
    '  (*p).lat = mix(P.spawnS, P.spawnN, rand01(base + 1u));',
    '  (*p).age = 0.0;',
    '  (*p).spd = 0.0;',                                       // spd 0 => vertex shader draws nothing this frame
    '  (*p).plon = (*p).lon; (*p).plat = (*p).lat;',
    '}',
    '',
    // Manual bilinear over the u/v grid — matches WindField.sample() exactly, including
    // "any NODATA corner poisons the sample" (CPU: NaN*0 = NaN -> !isFinite -> null).
    'fn sampleUV(lon: f32, lat: f32) -> vec3<f32> {',          // (u, v, valid)
    '  let fx = (lon - P.lo1) / P.dx;',
    '  let fy = (P.la1 - lat) / P.dy;',
    '  if (fx < 0.0 || fy < 0.0 || fx > P.nx - 1.0 || fy > P.ny - 1.0) { return vec3<f32>(0.0, 0.0, 0.0); }',
    '  let x0 = u32(fx); let y0 = u32(fy);',
    '  let x1 = min(x0 + 1u, u32(P.nx) - 1u); let y1 = min(y0 + 1u, u32(P.ny) - 1u);',
    '  let gx = fx - f32(x0); let gy = fy - f32(y0);',
    '  let p00 = textureLoad(field, vec2<u32>(x0, y0), 0).rg;',
    '  let p10 = textureLoad(field, vec2<u32>(x1, y0), 0).rg;',
    '  let p01 = textureLoad(field, vec2<u32>(x0, y1), 0).rg;',
    '  let p11 = textureLoad(field, vec2<u32>(x1, y1), 0).rg;',
    '  let bad = max(max(abs(p00.x), abs(p10.x)), max(abs(p01.x), abs(p11.x)));',
    '  if (bad > 1e29) { return vec3<f32>(0.0, 0.0, 0.0); }',
    '  let uv = p00 * (1.0 - gx) * (1.0 - gy) + p10 * gx * (1.0 - gy) + p01 * (1.0 - gx) * gy + p11 * gx * gy;',
    '  return vec3<f32>(uv, 1.0);',
    '}',
    '',
    '@compute @workgroup_size(64)',
    'fn advect(@builtin(global_invocation_id) gid: vec3<u32>) {',
    '  let i = gid.x;',
    '  if (i >= u32(P.count)) { return; }',
    '  var p = ps[i];',
    '  if (p.age >= P.maxAge) { respawn(i, &p); }',
    '  let s = sampleUV(p.lon, p.lat);',
    '  if (s.z < 0.5) {',                                      // out of field / NODATA -> honest respawn
    '    respawn(i, &p); p.age = p.age + 1.0; ps[i] = p; return;',
    '  }',
    '  let spd = length(s.xy);',
    '  var pxStep = spd * P.speedFactor;',
    '  if (pxStep > 8.0) { pxStep = 8.0 + (pxStep - 8.0) * 0.3; }',   // same soft clamp as CPU
    '  let stepDeg = pxStep * P.degPerPx;',
    '  let inv = select(0.0, 1.0 / spd, spd > 1e-6);',
    '  let nlon = p.lon + (s.x * inv) * stepDeg / P.cosLat;',
    '  let nlat = p.lat + (s.y * inv) * stepDeg;',
    '  if (nlon < P.west || nlon > P.east || nlat < P.south || nlat > P.north) {',
    '    respawn(i, &p);',
    '  } else {',
    '    p.plon = p.lon; p.plat = p.lat;',
    '    p.lon = nlon; p.lat = nlat; p.spd = spd;',
    '  }',
    '  p.age = p.age + 1.0;',
    '  ps[i] = p;',
    '}'
  ].join('\n');

  var WGSL_DRAW = [
    'struct View {',
    '  m0: f32, m1: f32, m2: f32, m3: f32, m4: f32, m5: f32,', // mercator->device-px affine
    '  wDev: f32, hDev: f32, centerLng: f32, lineWidth: f32,',
    '  glow: f32, neutral: f32, neutralAlpha: f32, bucketMax: f32,',
    '};',
    'struct Particle { lon: f32, lat: f32, age: f32, spd: f32, plon: f32, plat: f32, r0: f32, r1: f32 };',
    '@group(0) @binding(0) var<storage, read> ps: array<Particle>;',
    '@group(0) @binding(1) var<uniform> V: View;',
    '@group(0) @binding(2) var ramp: texture_2d<f32>;',
    '@group(0) @binding(3) var rs: sampler;',
    '',
    'fn mercPos(lon: f32, lat: f32) -> vec2<f32> {',
    '  let lw = lon - 360.0 * round((lon - V.centerLng) / 360.0);',   // nearest world copy (antimeridian)
    '  let mx = lw / 360.0 + 0.5;',
    '  let s = clamp(sin(lat * 0.017453292519943295), -0.9999, 0.9999);',
    '  let my = 0.5 - log((1.0 + s) / (1.0 - s)) / 12.566370614359172;',
    '  return vec2<f32>(V.m0 * mx + V.m1 * my + V.m2, V.m3 * mx + V.m4 * my + V.m5);',
    '}',
    '',
    'struct VO { @builtin(position) pos: vec4<f32>, @location(0) spd: f32 };',
    '@vertex',
    'fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VO {',
    '  var o: VO;',
    '  let p = ps[ii];',
    '  o.spd = p.spd;',
    '  if (p.spd <= 0.0 || p.age < 1.0) {',                    // just-spawned: nothing to draw
    '    o.pos = vec4<f32>(2.0, 2.0, 0.0, 1.0); return o;',    // off-clip degenerate
    '  }',
    '  let a = mercPos(p.plon, p.plat);',
    '  let b = mercPos(p.lon, p.lat);',
    '  let ab = b - a;',
    '  let len = length(ab);',
    '  if (len < 1e-4 || len > 64.0) {',                       // zero-step or wrapped-copy jump: skip
    '    o.pos = vec4<f32>(2.0, 2.0, 0.0, 1.0); return o;',
    '  }',
    '  let dir = ab / len;',
    '  let n = vec2<f32>(-dir.y, dir.x);',
    '  let bucket = clamp(p.spd / V.bucketMax, 0.0, 1.0);',
    '  var w = V.lineWidth * (0.85 + bucket * 1.2);',          // same width-by-speed as CPU buckets
    '  w = w * select(1.0, 3.2, V.glow > 0.5);',
    '  let ext = dir * (w * 0.5);',                            // round-cap-ish: extend ends by half width
    '  var corner: vec2<f32>;',
    '  switch (vi) {',
    '    case 0u: { corner = a - ext + n * (w * 0.5); }',
    '    case 1u: { corner = a - ext - n * (w * 0.5); }',
    '    case 2u: { corner = b + ext + n * (w * 0.5); }',
    '    case 3u: { corner = b + ext + n * (w * 0.5); }',
    '    case 4u: { corner = a - ext - n * (w * 0.5); }',
    '    default: { corner = b + ext - n * (w * 0.5); }',
    '  }',
    '  let clip = vec2<f32>(corner.x / V.wDev * 2.0 - 1.0, 1.0 - corner.y / V.hDev * 2.0);',
    '  o.pos = vec4<f32>(clip, 0.0, 1.0);',
    '  return o;',
    '}',
    '',
    '@fragment',
    'fn fs(in: VO) -> @location(0) vec4<f32> {',
    '  let t = clamp(in.spd / V.bucketMax, 0.0, 1.0);',
    '  let c = textureSample(ramp, rs, vec2<f32>(t, 0.5));',   // unconditional -> uniform control flow
    '  let rgb = select(c.rgb, vec3<f32>(1.0, 1.0, 1.0), V.neutral > 0.5);',
    '  var a = select(1.0, V.neutralAlpha, V.neutral > 0.5);',
    '  a = a * select(1.0, 0.04, V.glow > 0.5);',              // glow halo alpha, same as CPU
    '  return vec4<f32>(rgb * a, a);',                         // premultiplied out
    '}'
  ].join('\n');

  // Trail fade + final blit share one shader: sample a texture, scale rgba.
  var WGSL_BLIT = [
    'struct B { fade: f32 };',
    '@group(0) @binding(0) var src: texture_2d<f32>;',
    '@group(0) @binding(1) var s: sampler;',
    '@group(0) @binding(2) var<uniform> u: B;',
    'struct VO { @builtin(position) pos: vec4<f32>, @location(0) uv: vec2<f32> };',
    '@vertex fn vs(@builtin(vertex_index) i: u32) -> VO {',
    '  var p = array<vec2<f32>,3>(vec2<f32>(-1.0,-1.0), vec2<f32>(3.0,-1.0), vec2<f32>(-1.0,3.0));',
    '  var o: VO; o.pos = vec4<f32>(p[i], 0.0, 1.0);',
    '  o.uv = vec2<f32>((p[i].x+1.0)*0.5, (1.0-p[i].y)*0.5); return o;',
    '}',
    '@fragment fn fs(in: VO) -> @location(0) vec4<f32> {',
    '  return textureSample(src, s, in.uv) * u.fade;',         // premultiplied: uniform scale fades trails
    '}'
  ].join('\n');

  // ---- GPU engine -----------------------------------------------------------

  function GpuWindLayer(map, gpu, opts) {
    this.map = map;
    this.gpu = gpu;                 // { device, canvasFormat }
    this.opts = Object.assign({}, DEFAULTS, opts || {});
    this._visible = false;
    this._running = false;
    this._raf = null;
    this._destroyed = false;
    this._neutral = false;
    this._neutralAlpha = 0.27;
    this._interacting = false;
    this._frame = 0;
    this._count = 0;
    this.fieldMeta = null;
    this._buildCanvas();
    this._buildStatic();
    this._bindMap();
    this._resize();
  }

  GpuWindLayer.prototype._buildCanvas = function () {
    var mapCanvas = this.map.getCanvas();
    var container = mapCanvas.parentNode;
    var c = document.createElement('canvas');
    c.className = 'helm-wind-canvas helm-wind-canvas-gpu';
    var s = c.style;
    s.position = 'absolute'; s.top = '0'; s.left = '0';
    s.width = '100%'; s.height = '100%';
    s.pointerEvents = 'none'; s.zIndex = '1'; s.display = 'none';
    this.canvas = c;
    this.ctx = c.getContext('webgpu');
    if (!this.ctx) throw new Error('canvas.getContext("webgpu") returned null');
    this.ctx.configure({ device: this.gpu.device, format: this.gpu.canvasFormat, alphaMode: 'premultiplied' });
    (container || mapCanvas.parentNode).appendChild(c);
  };

  GpuWindLayer.prototype._buildStatic = function () {
    var dev = this.gpu.device;
    var advMod = dev.createShaderModule({ code: WGSL_ADVECT });
    var drawMod = dev.createShaderModule({ code: WGSL_DRAW });
    var blitMod = dev.createShaderModule({ code: WGSL_BLIT });
    this.advectPipe = dev.createComputePipeline({ layout: 'auto', compute: { module: advMod, entryPoint: 'advect' } });
    var premul = { color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
                   alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' } };
    this.drawPipe = dev.createRenderPipeline({ layout: 'auto',
      vertex: { module: drawMod, entryPoint: 'vs' },
      fragment: { module: drawMod, entryPoint: 'fs', targets: [{ format: 'rgba8unorm', blend: premul }] },
      primitive: { topology: 'triangle-list' } });
    // fade pass rewrites the whole target (no blend); present-to-canvas blends premultiplied
    this.fadePipe = dev.createRenderPipeline({ layout: 'auto',
      vertex: { module: blitMod, entryPoint: 'vs' },
      fragment: { module: blitMod, entryPoint: 'fs', targets: [{ format: 'rgba8unorm' }] },
      primitive: { topology: 'triangle-list' } });
    this.presentPipe = dev.createRenderPipeline({ layout: 'auto',
      vertex: { module: blitMod, entryPoint: 'vs' },
      fragment: { module: blitMod, entryPoint: 'fs', targets: [{ format: this.gpu.canvasFormat, blend: premul }] },
      primitive: { topology: 'triangle-list' } });
    this.sampler = dev.createSampler({ magFilter: 'linear', minFilter: 'linear' });
    this.paramsBuf = dev.createBuffer({ size: 80, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.viewBuf = dev.createBuffer({ size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.viewGlowBuf = dev.createBuffer({ size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.fadeBuf = dev.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    // present pass blits the trail texture 1:1; layer opacity is CSS on the canvas
    this.presentBuf = dev.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    dev.queue.writeBuffer(this.fadeBuf, 0, new Float32Array([this.opts.fadeOpacity, 0, 0, 0]));
    dev.queue.writeBuffer(this.presentBuf, 0, new Float32Array([1, 0, 0, 0]));
    this._rampTex = this._bakeRamp();
  };

  GpuWindLayer.prototype._bakeRamp = function () {
    var dev = this.gpu.device;
    var R = global.HelmWxRamp, lut = new Uint8Array(256 * 4);
    for (var i = 0; i < 256; i++) {
      var kn = (i / 255) * BUCKET_MAX_KN;
      var css = R ? R.rampCss('wind', kn) : 'rgb(255,255,255)';
      var m = /rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/.exec(css);
      var r = m ? +m[1] : 255, g = m ? +m[2] : 255, b = m ? +m[3] : 255;
      lut[i * 4] = r; lut[i * 4 + 1] = g; lut[i * 4 + 2] = b; lut[i * 4 + 3] = 255;
    }
    var tex = dev.createTexture({ size: [256, 1], format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    dev.queue.writeTexture({ texture: tex }, lut, { bytesPerRow: 256 * 4 }, [256, 1]);
    return tex;
  };

  GpuWindLayer.prototype._bindMap = function () {
    var self = this;
    this._onResize = function () { self._resize(); };
    this._onMoveStart = function () { self._interacting = true; self._presentClear(); };
    this._onMoveEnd = function () { self._interacting = false; if (self._visible) self._reseed(); };
    this.map.on('resize', this._onResize);
    this.map.on('movestart', this._onMoveStart);
    this.map.on('moveend', this._onMoveEnd);
  };

  GpuWindLayer.prototype._unbindMap = function () {
    this.map.off('resize', this._onResize);
    this.map.off('movestart', this._onMoveStart);
    this.map.off('moveend', this._onMoveEnd);
  };

  // Clear the on-screen canvas immediately (stale trails must not smear during pan).
  GpuWindLayer.prototype._presentClear = function () {
    if (this._destroyed || !this._visible) return;
    try {
      var enc = this.gpu.device.createCommandEncoder();
      var pass = enc.beginRenderPass({ colorAttachments: [{ view: this.ctx.getCurrentTexture().createView(),
        clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: 'clear', storeOp: 'store' }] });
      pass.end();
      this.gpu.device.queue.submit([enc.finish()]);
    } catch (e) {}
    this._trailsLive = false;
  };

  GpuWindLayer.prototype._resize = function () {
    if (this._destroyed) return;
    var mapCanvas = this.map.getCanvas();
    var w = mapCanvas.clientWidth || mapCanvas.width;
    var h = mapCanvas.clientHeight || mapCanvas.height;
    var dpr = Math.min(global.devicePixelRatio || 1, 2);
    this._w = w; this._h = h; this._dpr = dpr;
    var wDev = Math.max(1, Math.round(w * dpr)), hDev = Math.max(1, Math.round(h * dpr));
    this.canvas.width = wDev;
    this.canvas.height = hDev;
    this.canvas.style.width = w + 'px';
    this.canvas.style.height = h + 'px';
    var dev = this.gpu.device;
    if (this.trailA) { try { this.trailA.destroy(); this.trailB.destroy(); } catch (e) {} }
    var mk = function () {
      return dev.createTexture({ size: [wDev, hDev], format: 'rgba8unorm',
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING });
    };
    this.trailA = mk(); this.trailB = mk();
    this._trailsLive = false;
    this._budget = Math.round(Math.max(MIN_PARTICLES, Math.min(this.opts.particleCount, (w * h) / AREA_PER_PARTICLE)));
    if (this.fieldMeta && this._visible) this._reseed();
  };

  GpuWindLayer.prototype._spawnBox = function () {
    var f = this.fieldMeta || { west: -180, east: 180, south: -85, north: 85 };
    try {
      var b = this.map.getBounds();
      var w = Math.max(b.getWest(), f.west), e = Math.min(b.getEast(), f.east);
      var s = Math.max(b.getSouth(), f.south), n = Math.min(b.getNorth(), f.north);
      if (e > w && n > s) return { w: w, e: e, s: s, n: n };
    } catch (err) {}
    return { w: f.west, e: f.east, s: f.south, n: f.north };
  };

  // Fresh particle pool seeded like the CPU engine (viewport-biased, random ages).
  GpuWindLayer.prototype._allocParticles = function () {
    var dev = this.gpu.device, n = this._budget;
    this._count = n;
    if (this.particleBuf) { try { this.particleBuf.destroy(); } catch (e) {} }
    this.particleBuf = dev.createBuffer({ size: n * 32, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    var init = new Float32Array(n * 8);
    var sb = this._spawnBox();
    for (var i = 0; i < n; i++) {
      var lon = sb.w + Math.random() * (sb.e - sb.w);
      var lat = sb.s + Math.random() * (sb.n - sb.s);
      init[i * 8] = lon; init[i * 8 + 1] = lat;
      init[i * 8 + 2] = (Math.random() * this.opts.maxParticleAge) | 0;
      init[i * 8 + 3] = 0;
      init[i * 8 + 4] = lon; init[i * 8 + 5] = lat;
    }
    dev.queue.writeBuffer(this.particleBuf, 0, init);
    this._bindGroups();
  };

  GpuWindLayer.prototype._bindGroups = function () {
    var dev = this.gpu.device;
    this.advectBind = dev.createBindGroup({ layout: this.advectPipe.getBindGroupLayout(0), entries: [
      { binding: 0, resource: { buffer: this.particleBuf } },
      { binding: 1, resource: { buffer: this.paramsBuf } },
      { binding: 2, resource: this.fieldTex.createView() }] });
    this.drawBind = dev.createBindGroup({ layout: this.drawPipe.getBindGroupLayout(0), entries: [
      { binding: 0, resource: { buffer: this.particleBuf } },
      { binding: 1, resource: { buffer: this.viewBuf } },
      { binding: 2, resource: this._rampTex.createView() },
      { binding: 3, resource: this.sampler }] });
    this.drawGlowBind = dev.createBindGroup({ layout: this.drawPipe.getBindGroupLayout(0), entries: [
      { binding: 0, resource: { buffer: this.particleBuf } },
      { binding: 1, resource: { buffer: this.viewGlowBuf } },
      { binding: 2, resource: this._rampTex.createView() },
      { binding: 3, resource: this.sampler }] });
  };

  // View-dependent uniforms only (no pool reset) — used by setNeutral/setOpacity.
  GpuWindLayer.prototype._uploadView = function () {
    if (!this.fieldMeta) return;
    var m = this.map, dev = this.gpu.device;
    var c = m.getCenter(), dpr = this._dpr || 1;
    var p0 = m.project([c.lng, c.lat]);
    var pE = m.project([c.lng + 0.01, c.lat]);
    var pN = m.project([c.lng, c.lat + 0.01]);
    var aff = affineFromProbes(c.lng, c.lat, 0.01, 0.01, p0, pE, pN);
    if (!aff) return;
    var view = new Float32Array([
      aff[0] * dpr, aff[1] * dpr, aff[2] * dpr, aff[3] * dpr, aff[4] * dpr, aff[5] * dpr,
      this._w * dpr, this._h * dpr, c.lng, this.opts.lineWidth * dpr,
      0, this._neutral ? 1 : 0, this._neutralAlpha, BUCKET_MAX_KN,
      0, 0]);
    dev.queue.writeBuffer(this.viewBuf, 0, view);
    view[10] = 1;   // glow variant
    dev.queue.writeBuffer(this.viewGlowBuf, 0, view);
  };

  // Full re-anchor for a (new) static view: advection scalars + spawn box + affine + fresh pool.
  GpuWindLayer.prototype._reseed = function () {
    if (!this.fieldMeta || this._destroyed) return;
    var m = this.map, dev = this.gpu.device;
    var c = m.getCenter();
    // degrees-per-CSS-px at centre — same probe the CPU engine uses
    var a = m.project([c.lng, c.lat]), b2 = m.project([c.lng + 0.001, c.lat]);
    var dpx = Math.hypot(b2.x - a.x, b2.y - a.y);
    var degPerPx = dpx > 1e-6 ? 0.001 / dpx : 0.00001;
    var cosLat = Math.max(0.15, Math.cos(c.lat * Math.PI / 180));
    var f = this.fieldMeta, sb = this._spawnBox();
    dev.queue.writeBuffer(this.paramsBuf, 0, new Float32Array([
      degPerPx, cosLat, this.opts.speedFactor, this.opts.maxParticleAge,
      f.west, f.east, f.south, f.north,
      sb.w, sb.e, sb.s, sb.n,
      f.lo1, f.la1, f.dx, f.dy,
      f.nx, f.ny, this._frame, this._budget]));
    this._uploadView();
    this._allocParticles();
    this._trailsLive = false;
  };

  GpuWindLayer.prototype._step = function () {
    if (!this._running) return;
    this._raf = global.requestAnimationFrame(this._stepBound);
    if (this._interacting || !this.fieldMeta || !this.particleBuf) return;
    var dev = this.gpu.device;
    this._frame++;
    dev.queue.writeBuffer(this.paramsBuf, 72, new Float32Array([this._frame]));   // Params.frame
    var enc = dev.createCommandEncoder();

    // 1) advect on GPU
    var cp = enc.beginComputePass();
    cp.setPipeline(this.advectPipe);
    cp.setBindGroup(0, this.advectBind);
    cp.dispatchWorkgroups(Math.ceil(this._count / 64));
    cp.end();

    // 2) trails: fade prev (A -> B), then draw new segments (glow halo + crisp core) into B
    var srcTex = this.trailA, dstTex = this.trailB;
    var rp = enc.beginRenderPass({ colorAttachments: [{ view: dstTex.createView(),
      clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: 'clear', storeOp: 'store' }] });
    if (this._trailsLive) {
      var fadeBind = dev.createBindGroup({ layout: this.fadePipe.getBindGroupLayout(0), entries: [
        { binding: 0, resource: srcTex.createView() },
        { binding: 1, resource: this.sampler },
        { binding: 2, resource: { buffer: this.fadeBuf } }] });
      rp.setPipeline(this.fadePipe);
      rp.setBindGroup(0, fadeBind);
      rp.draw(3);
    }
    rp.setPipeline(this.drawPipe);
    rp.setBindGroup(0, this.drawGlowBind);
    rp.draw(6, this._count);
    rp.setBindGroup(0, this.drawBind);
    rp.draw(6, this._count);
    rp.end();
    this._trailsLive = true;

    // 3) present B to the canvas
    var presentBind = dev.createBindGroup({ layout: this.presentPipe.getBindGroupLayout(0), entries: [
      { binding: 0, resource: dstTex.createView() },
      { binding: 1, resource: this.sampler },
      { binding: 2, resource: { buffer: this.presentBuf } }] });
    var pp = enc.beginRenderPass({ colorAttachments: [{ view: this.ctx.getCurrentTexture().createView(),
      clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: 'clear', storeOp: 'store' }] });
    pp.setPipeline(this.presentPipe);
    pp.setBindGroup(0, presentBind);
    pp.draw(3);
    pp.end();

    dev.queue.submit([enc.finish()]);
    this.trailA = dstTex; this.trailB = srcTex;   // ping-pong
  };

  GpuWindLayer.prototype._start = function () {
    if (this._running || this._destroyed) return;
    this._running = true;
    this._stepBound = this._step.bind(this);
    this._raf = global.requestAnimationFrame(this._stepBound);
  };

  GpuWindLayer.prototype._stop = function () {
    this._running = false;
    if (this._raf) { global.cancelAnimationFrame(this._raf); this._raf = null; }
  };

  // ---- public API (HelmWind-identical) ------------------------------------

  GpuWindLayer.prototype.load = function (url) {
    var self = this;
    return fetch(url, { cache: 'no-cache' })
      .then(function (r) { if (!r.ok) throw new Error('wind.json HTTP ' + r.status); return r.json(); })
      .then(function (json) { return self.setData(json); })
      .catch(function (err) {
        console.warn('[HelmWindGPU] could not load wind data:', err && err.message ? err.message : err);
        return false;
      });
  };

  GpuWindLayer.prototype.setData = function (json) {
    // Parse via the CPU engine's exported WindField — shared semantics, not a copy.
    var f = new global.HelmWind.Field();
    if (!f.build(json)) { this.fieldMeta = null; return false; }
    this.fieldMeta = { nx: f.nx, ny: f.ny, lo1: f.lo1, la1: f.la1, dx: f.dx, dy: f.dy,
      west: f.west, east: f.east, south: f.south, north: f.north };
    var dev = this.gpu.device;
    if (this.fieldTex) { try { this.fieldTex.destroy(); } catch (e) {} }
    this.fieldTex = dev.createTexture({ size: [f.nx, f.ny], format: 'rg32float',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    dev.queue.writeTexture({ texture: this.fieldTex }, packField(f),
      { bytesPerRow: f.nx * 8 }, [f.nx, f.ny]);
    this._reseed();
    if (this._visible) this._start();
    return true;
  };

  GpuWindLayer.prototype.setVisible = function (v) {
    v = !!v;
    if (v === this._visible || this._destroyed) { this._visible = v; return; }
    this._visible = v;
    if (v) {
      this.canvas.style.display = 'block';
      this._resize();
      this._start();
    } else {
      this._stop();
      this.canvas.style.display = 'none';
    }
  };

  GpuWindLayer.prototype.isVisible = function () { return this._visible; };
  GpuWindLayer.prototype.setNeutral = function (v) { this._neutral = !!v; this._uploadView(); };
  GpuWindLayer.prototype.setOpacity = function (a) {
    // WHOLE-LAYER opacity, Photoshop-style: CSS opacity composites the fully-rendered
    // canvas at N% — particles AND trail film fade together, mirroring the field's
    // MapLibre raster-opacity. It must NOT touch _neutralAlpha: coupling the per-segment
    // white alpha to the slider meant "fully opaque weather" cranked every deposit to
    // 0.95 white and the accumulated trail film BLEACHED the colour field underneath.
    // Per-particle alpha stays at its tuned constant (0.27).
    if (this.canvas) this.canvas.style.opacity = String(Math.max(0, Math.min(1, +a || 0)));
  };

  GpuWindLayer.prototype.destroy = function () {
    if (this._destroyed) return;
    this._destroyed = true;
    this._stop();
    this._unbindMap();
    if (this.canvas && this.canvas.parentNode) this.canvas.parentNode.removeChild(this.canvas);
    this.canvas = null;
    var kill = ['particleBuf', 'fieldTex', 'trailA', 'trailB', '_rampTex'];
    for (var i = 0; i < kill.length; i++) { try { this[kill[i]] && this[kill[i]].destroy(); } catch (e) {} }
  };

  // ---- facade: sync API, async GPU init, visible CPU fallback ---------------

  function HelmWindAuto(map, opts) {
    var inner = null;               // resolved engine
    var mode = 'initializing';
    // state fully captures the API surface, so calls made while the GPU is still
    // initializing are replayed from here (no separate queue -> no double-replay).
    var state = { data: null, visible: false, neutral: false, opacity: null, destroyed: false };

    function setMode(m, reason) {
      mode = m;
      global.__helmWindMode = m;
      global.__helmWindModeReason = reason || '';
      console.info('[wx-particles] ' + (m === 'gpu'
        ? 'WebGPU compute advection active'
        : 'CPU particle engine active — ' + reason));
    }

    function replay() {
      if (state.destroyed) { inner.destroy(); return; }
      if (state.data != null) inner.setData(state.data);
      if (state.neutral) inner.setNeutral(true);
      if (state.opacity != null) inner.setOpacity(state.opacity);
      if (state.visible) inner.setVisible(true);
    }

    function fallbackCPU(reason) {
      inner = global.HelmWind(map, opts);
      setMode('cpu', reason);
      replay();
    }

    var flagOff = (global.HELM_WX_WEBGPU === false) ||
      (typeof localStorage !== 'undefined' && localStorage.getItem('helmWxWebgpu') === '0');
    var unprojectable = false, upReason = '';
    try {
      if (map.getPitch && map.getPitch() !== 0) { unprojectable = true; upReason = 'map pitch != 0'; }
      var proj = map.getProjection && map.getProjection();
      if (proj && /globe/i.test((proj.type || proj.name || '') + '')) { unprojectable = true; upReason = 'globe projection'; }
    } catch (e) {}

    if (flagOff) { fallbackCPU('HELM_WX_WEBGPU=false'); }
    else if (typeof navigator === 'undefined' || !navigator.gpu) { fallbackCPU('WebGPU unavailable (no navigator.gpu)'); }
    else if (unprojectable) { fallbackCPU(upReason + ' — mercator-affine draw unsupported'); }
    else {
      navigator.gpu.requestAdapter().then(function (ad) {
        if (!ad) throw new Error('no WebGPU adapter');
        return ad.requestDevice();
      }).then(function (dev) {
        dev.lost.then(function (info) {           // device loss mid-session -> visible CPU fallback
          if (mode === 'gpu') {
            try { inner.destroy(); } catch (e) {}
            fallbackCPU('WebGPU device lost: ' + ((info && info.reason) || 'unknown'));
          }
        });
        inner = new GpuWindLayer(map, { device: dev, canvasFormat: navigator.gpu.getPreferredCanvasFormat() }, opts);
        setMode('gpu');
        replay();
      }).catch(function (err) {
        fallbackCPU('WebGPU init failed: ' + (err && err.message ? err.message : err));
      });
    }

    function call(fn) {
      if (inner) return fn(inner);
      return undefined;             // state already recorded; replay() delivers it post-init
    }

    return {
      load: function (url) {
        return fetch(url, { cache: 'no-cache' })
          .then(function (r) { if (!r.ok) throw new Error('wind.json HTTP ' + r.status); return r.json(); })
          .then(function (json) { state.data = json; var r2 = call(function (e) { return e.setData(json); }); return r2 !== false; })
          .catch(function (err) {
            console.warn('[HelmWind] could not load wind data:', err && err.message ? err.message : err);
            return false;
          });
      },
      setData: function (json) { state.data = json; var r = call(function (e) { return e.setData(json); }); return r === undefined ? true : r; },
      setVisible: function (v) { state.visible = !!v; call(function (e) { e.setVisible(v); }); },
      isVisible: function () { return inner ? inner.isVisible() : state.visible; },
      setNeutral: function (v) { state.neutral = !!v; call(function (e) { e.setNeutral(v); }); },
      setOpacity: function (a) { state.opacity = a; call(function (e) { e.setOpacity(a); }); },
      destroy: function () { state.destroyed = true; call(function (e) { e.destroy(); }); },
      mode: function () { return mode; }
    };
  }

  // test seam: pure math + packing, no GPU required
  HelmWindAuto._test = {
    softClampPx: softClampPx,
    stepGeo: stepGeo,
    normLonNearCenter: normLonNearCenter,
    mercX: mercX,
    mercY: mercY,
    affineFromProbes: affineFromProbes,
    packField: packField,
    NODATA_SENTINEL: NODATA_SENTINEL,
    DEFAULTS: DEFAULTS
  };
  HelmWindAuto.GpuLayer = GpuWindLayer;

  if (typeof module !== 'undefined' && module.exports) module.exports = HelmWindAuto;
  else global.HelmWindAuto = HelmWindAuto;
})(typeof window !== 'undefined' ? window : this);
