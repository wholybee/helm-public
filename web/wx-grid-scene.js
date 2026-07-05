/*
 * Helm — wx-grid-scene.js (WX-33, compositing rework)
 * --------------------------------------------------------------------------
 * WebGPU model-grid renderer: draws weather DIRECTLY from helm.env.grid.v1
 * numeric grids into an OFFSCREEN canvas laid out in geographic space
 * (x linear in longitude, y linear in mercator-y across the pack coverage),
 * then hands that canvas to MapLibre as a canvas source + raster layer
 * inserted BELOW 'route-line'. MapLibre owns ALL projection (mercator,
 * globe, pitch — image sources reproject everywhere), the chart's own
 * symbols/route/AIS stay crisp ON TOP of the weather, and the transparency
 * slider drives the layer's raster-opacity — true see-through-to-the-chart
 * transparency, not a screen overlay dimming toward the page background.
 * Pan/zoom re-renders NOTHING here: the field is a static texture MapLibre
 * warps like any raster. No tiles, no seams, no per-gesture work at all.
 *
 * Per texel the grid is sampled with NODATA-honest manual bilinear,
 * value-lerped between the two bracketing valid times, unit-converted
 * explicitly, and ramped to colour with premultiplied alpha.
 *
 * Data path: HelmWxGridPacks (WX-32 range transport, checksum-verified) ->
 * HelmWxGridDecode (typed bands, tier assembly) -> rg32float textures.
 * Particles: the SAME assembled u/v arrays feed window.__helmWind (the
 * WX-25 engine) via toVelocityGrid — colour and motion share one dataset
 * by construction.
 *
 * Fail-loud (contract §8/§9): the DATA PLANE runs first (manifest, tier,
 * ramp, chunk fetch/decode/assembly — all CPU, all testable without a GPU);
 * the WebGPU capability gate comes last, so 'unsupported_renderer_capability'
 * means exactly that. Every failure carries {code, layer, tier, validTime,
 * chunkKey, packId, action} on status(). There is NO raster/gateway/PNG
 * substitution here.
 * --------------------------------------------------------------------------
 */
(function (global) {
  'use strict';

  var SENTINEL = 1e30;                  // NaN encoded for WGSL (fast-math NaN is unreliable)
  var UPSCALE = 4, MAX_TEX = 2048;      // offscreen texels per grid cell / hard texture cap
  var SRC_ID = 'helm-wx-grid';          // MapLibre source + layer id
  // Pack values are SI (contract §5); ramps are display units. Explicit per layer — no hidden defaults.
  var UNIT_FACTOR = { wind: 1.9438445, current: 1.9438445, gust: 1.9438445 };   // m/s -> kn; others 1:1
  // Probe/legend display units AFTER conversion (packs store SI; ramps/probe show these).
  var DISPLAY_UNIT = { wind: 'kn', gust: 'kn', current: 'kn', rain: 'mm/h', temp: '°C', sst: '°C',
                       pressure: 'hPa', clouds: '%', cape: 'J/kg', waves: 'm', swell: 'm' };

  function loud(code, message, details) {
    var e = ((global.HelmWxGridPacks && global.HelmWxGridPacks.loudError) ||
             function (c, m, d) { var x = new Error(m || c); x.code = c; x.details = d || {}; return x; })(code, message, details);
    return e;
  }

  var state = {
    _gen: 0,
    on: false, map: null, gpu: null, segs: [],
    manifest: null, manifestUrl: null, layer: null, meta: null,
    frames: {},                          // validTime -> { assembled, tex }
    bracket: null,                       // {a, b, frac}
    opacity: 0.85,
    diagnostics: []
  };

  function D() { return global.HelmWxGridDecode; }
  function P() { return global.HelmWxGridPacks; }

  function record(code, extra) {
    var d = Object.assign({
      code: code, layer: state.layer, tier: state.meta && state.meta.tier,
      packId: state.manifest && state.manifest.packId, at: new Date().toISOString()
    }, extra || {});
    state.diagnostics.push(d);
    if (state.diagnostics.length > 40) state.diagnostics.shift();
    try { console.warn('[wx-grid] ' + code + (extra && extra.action ? ' — ' + extra.action : ''), d); } catch (e) {}
    publish();
    return d;
  }

  function publish() { global.__helmWxGridStatus = status(); }

  function ageSeconds() {
    var gen = state.manifest && state.manifest.generatedAt;
    if (!gen) return null;
    var t = Date.parse(gen);
    return isFinite(t) ? Math.max(0, Math.round((Date.now() - t) / 1000)) : null;
  }

  function status() {
    return {
      state: state.on ? 'on' : 'off',
      packId: state.manifest && state.manifest.packId,
      layer: state.layer,
      tier: state.meta && state.meta.tier,
      kind: state.meta && state.meta.kind,
      frames: state.bracket ? { a: state.bracket.a, b: state.bracket.b, frac: state.bracket.frac } : null,
      validTimes: (state.manifest && state.manifest.run && state.manifest.run.validTimes) || [],
      coverage: state.meta ? { west: state.meta.west, south: state.meta.south, east: state.meta.east,
                               north: state.meta.north, global: !!state.meta.global, tier: state.meta.tier } : null,
      generatedAt: state.manifest && state.manifest.generatedAt,
      ageSeconds: ageSeconds(),
      opacity: state.opacity,
      composited: 'maplibre-raster',
      diagnostics: state.diagnostics.slice(-10)
    };
  }

  // ---- WGSL -----------------------------------------------------------------
  // Vertex: fullscreen triangle over the OFFSCREEN geographic canvas. Fragment:
  // texel -> (lon linear west..east, lat via inverse mercator between the
  // clamped coverage edges) -> fractional grid coords -> NODATA-honest bilinear
  // over the two frame textures, value-lerp, unit convert, ramp, premultiplied
  // alpha. Layer opacity is NOT applied here — MapLibre raster-opacity owns it.

  var WGSL = [
    'struct U {',
    '  west: f32, north: f32, dx: f32, dy: f32,',
    '  gw: f32, gh: f32, wrap: f32, frac: f32,',
    '  unitF: f32, rmin: f32, rspan: f32, segWest: f32,',
    '  vector: f32, mercN: f32, mercS: f32, segEast: f32,',
    '};',
    '@group(0) @binding(0) var<uniform> u: U;',
    '@group(0) @binding(1) var fA: texture_2d<f32>;',   // rg32float; scalar in .r, vector u/v in .rg
    '@group(0) @binding(2) var fB: texture_2d<f32>;',
    '@group(0) @binding(3) var ramp: texture_2d<f32>;',
    '@group(0) @binding(4) var rs: sampler;',
    '',
    'struct VO { @builtin(position) pos: vec4<f32>, @location(0) uv: vec2<f32> };',
    '@vertex fn vs(@builtin(vertex_index) vi: u32) -> VO {',
    '  var p = array<vec2<f32>, 3>(vec2<f32>(-1.0, -3.0), vec2<f32>(3.0, 1.0), vec2<f32>(-1.0, 1.0));',
    '  var o: VO;',
    '  o.pos = vec4<f32>(p[vi], 0.0, 1.0);',
    '  o.uv = vec2<f32>((p[vi].x + 1.0) * 0.5, (1.0 - p[vi].y) * 0.5);',   // uv.y = 0 at the north edge
    '  return o;',
    '}',
    '',
    // NODATA-honest manual bilinear over one frame texture. Returns (value.xy, valid).
    'fn tap(t: texture_2d<f32>, fx0: f32, fy: f32) -> vec3<f32> {',
    '  if (fy < 0.0 || fy > u.gh - 1.0) { return vec3<f32>(0.0, 0.0, 0.0); }',
    '  var fx = fx0;',
    '  if (u.wrap > 0.5) { fx = fx - u.gw*floor(fx/u.gw); }',            // global: wrap columns
    '  else if (fx < 0.0 || fx > u.gw - 1.0) { return vec3<f32>(0.0, 0.0, 0.0); }',
    '  let gwu = i32(u.gw);',
    '  let y0 = u32(clamp(fy, 0.0, u.gh - 1.0));',
    '  let y1 = min(y0 + 1u, u32(u.gh) - 1u);',
    '  var x0 = i32(floor(fx));',
    '  var x1 = x0 + 1;',
    '  if (u.wrap > 0.5) { x0 = ((x0 % gwu) + gwu) % gwu; x1 = (x0 + 1) % gwu; }',
    '  else { x0 = clamp(x0, 0, gwu - 1); x1 = clamp(x1, 0, gwu - 1); }',
    '  let gx = fract(fx); let gy = fract(clamp(fy, 0.0, u.gh - 1.0));',
    '  let p00 = textureLoad(fA_or(t), vec2<u32>(u32(x0), y0), 0).rg;',
    '  let p10 = textureLoad(fA_or(t), vec2<u32>(u32(x1), y0), 0).rg;',
    '  let p01 = textureLoad(fA_or(t), vec2<u32>(u32(x0), y1), 0).rg;',
    '  let p11 = textureLoad(fA_or(t), vec2<u32>(u32(x1), y1), 0).rg;',
    '  let bad = max(max(max(abs(p00.x), abs(p00.y)), max(abs(p10.x), abs(p10.y))),',
    '                max(max(abs(p01.x), abs(p01.y)), max(abs(p11.x), abs(p11.y))));',
    '  if (bad > 1e29) { return vec3<f32>(0.0, 0.0, 0.0); }',
    '  let uv = p00*(1.0-gx)*(1.0-gy) + p10*gx*(1.0-gy) + p01*(1.0-gx)*gy + p11*gx*gy;',
    '  return vec3<f32>(uv, 1.0);',
    '}',
    '',
    '@fragment fn fs(in: VO) -> @location(0) vec4<f32> {',
    // texel -> geographic coords. Rows are linear in MERCATOR-Y because MapLibre
    // maps image/canvas sources linearly into mercator space — linear-in-lat here
    // would smear the field north-south across a wide pack.
    '  let lon = u.segWest + in.uv.x * (u.segEast - u.segWest);',
    '  let merc = mix(u.mercN, u.mercS, in.uv.y);',
    '  let lat = degrees(2.0*atan(exp(merc)) - 1.5707963267949);',
    // segment lon -> the grid's [west, west+360) window (an east-of-180 segment carries
    // rewrapped lons; a global east edge lands exactly on west and wraps in the tap)
    '  let lonG = lon - 360.0*floor((lon - u.west)/360.0);',
    '  let fx = (lonG - u.west)/u.dx;',
    '  let fy = (u.north - lat)/u.dy;',
    '  let a = sampleFrame(0u, fx, fy);',
    '  let b = sampleFrame(1u, fx, fy);',
    '  var val = vec2<f32>(0.0, 0.0);',
    '  var valid = 0.0;',
    '  if (a.z > 0.5 && b.z > 0.5) { val = mix(a.xy, b.xy, u.frac); valid = 1.0; }',   // lerp VALUES then colour (§8)
    '  else if (a.z > 0.5) { val = a.xy; valid = 1.0; }',
    '  else if (b.z > 0.5) { val = b.xy; valid = 1.0; }',
    '  var display = val.x;',
    '  if (u.vector > 0.5) { display = length(val); }',
    '  display = display*u.unitF;',
    '  let t = clamp((display - u.rmin)/max(u.rspan, 1e-6), 0.0, 1.0);',
    '  let c = textureSample(ramp, rs, vec2<f32>(t, 0.5));',   // unconditional -> uniform control flow
    '  let alpha = c.a*valid;',                                // NODATA/out-of-coverage -> fully transparent
    '  return vec4<f32>(c.rgb*alpha, alpha);',                 // premultiplied; slider lives in raster-opacity
    '}'
  ].join('\n');

  // tap() needs a concrete texture per call site (no texture function params in
  // baseline WGSL) — specialize two copies with a tiny preprocessor.
  function buildShader() {
    var body = WGSL;
    var tapSrc = body.slice(body.indexOf('fn tap('), body.indexOf('@fragment'));
    function specialize(name, tex) {
      return tapSrc.replace('fn tap(t: texture_2d<f32>, ', 'fn ' + name + '(')
                   .replace(/fA_or\(t\)/g, tex);
    }
    var sampleDispatch = [
      'fn sampleFrame(which: u32, fx: f32, fy: f32) -> vec3<f32> {',
      '  if (which == 0u) { return tapA(fx, fy); }',
      '  return tapB(fx, fy);',
      '}'
    ].join('\n');
    return body.replace(tapSrc, specialize('tapA', 'fA') + '\n' + specialize('tapB', 'fB') + '\n' + sampleDispatch + '\n');
  }

  // ---- GPU setup ------------------------------------------------------------

  function ensureGpu() {
    if (state.gpu) return Promise.resolve(state.gpu);
    if (typeof navigator === 'undefined' || !navigator.gpu) {
      return Promise.reject(loud('unsupported_renderer_capability', 'WebGPU is unavailable in this browser',
        { action: 'enable WebGPU', capability: 'navigator.gpu' }));
    }
    return navigator.gpu.requestAdapter().then(function (ad) {
      if (!ad) throw loud('unsupported_renderer_capability', 'No WebGPU adapter', { action: 'enable WebGPU' });
      return ad.requestDevice();
    }).then(function (dev) {
      var fmt = navigator.gpu.getPreferredCanvasFormat();
      var mod = dev.createShaderModule({ code: buildShader() });
      var premul = { color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
                     alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' } };
      var pipe = dev.createRenderPipeline({ layout: 'auto',
        vertex: { module: mod, entryPoint: 'vs' },
        fragment: { module: mod, entryPoint: 'fs', targets: [{ format: fmt, blend: premul }] },
        primitive: { topology: 'triangle-list' } });
      state.gpu = {
        device: dev, format: fmt, pipe: pipe,
        sampler: dev.createSampler({ magFilter: 'linear', minFilter: 'linear' }),
        ubuf: dev.createBuffer({ size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
      };
      return state.gpu;
    });
  }

  function mercY(lat) { return Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI / 180) / 2)); }

  // Geographic extent the offscreen canvas covers: the pack coverage, latitudes
  // clamped to web-mercator's ±85° (a global pack's ±90 edge is unmappable), east
  // UNWRAPPED past 180 so an antimeridian-crossing pack stays one continuous quad.
  function renderExtent(meta) {
    var north = Math.min(meta.north, 85), south = Math.max(meta.south, -85);
    var west = meta.west;
    var east = meta.global ? meta.west + 360 : meta.east;
    if (!meta.global && east <= west) east += 360;
    return { west: west, east: east, north: north, south: south, mN: mercY(north), mS: mercY(south) };
  }

  // Globe projection has no world copies: a quad whose east edge passes 180°
  // (mercator x > 1) is culled ENTIRELY — the Fiji route pack crosses 180 by
  // design and simply vanished on the globe. Split a crossing extent at 180
  // into two in-world segments; each gets its own canvas + source below.
  function splitExtent(ext) {
    if (ext.east <= 180) return [ext];
    return [
      Object.assign({}, ext, { east: 180 }),
      Object.assign({}, ext, { west: -180, east: ext.east - 360 })
    ];
  }

  // Offscreen canvases the grid renders into (one per segment). Hidden from the
  // page — MapLibre reads them as canvas sources; they are never composited as
  // DOM. Kept in the document so tooling and the e2e specs can find
  // '.helm-wx-grid-canvas'.
  function makeCanvases() {
    var ext = renderExtent(state.meta);
    var segs = splitExtent(ext);
    var fullW = Math.min(MAX_TEX, Math.max(256, state.meta.width * UPSCALE));
    var aspect = (ext.mN - ext.mS) / ((ext.east - ext.west) * Math.PI / 180);
    var h = Math.min(MAX_TEX, Math.max(256, Math.round(fullW * aspect)));
    while (state.segs.length > segs.length) {
      var dead = state.segs.pop();
      if (dead.canvas && dead.canvas.parentNode) dead.canvas.parentNode.removeChild(dead.canvas);
    }
    for (var i = 0; i < segs.length; i++) {
      var span = segs[i].east - segs[i].west;
      var w = Math.max(64, Math.round(fullW * span / (ext.east - ext.west)));   // uniform texel density
      var s = state.segs[i];
      if (!s) {
        var c = document.createElement('canvas');
        c.className = 'helm-wx-grid-canvas';
        c.style.display = 'none';
        document.body.appendChild(c);
        var ctx = c.getContext('webgpu');
        if (!ctx) throw loud('unsupported_renderer_capability', 'webgpu canvas context unavailable', { action: 'enable WebGPU' });
        ctx.configure({ device: state.gpu.device, format: state.gpu.format, alphaMode: 'premultiplied' });
        s = state.segs[i] = { canvas: c, ctx: ctx };
      }
      if (s.canvas.width !== w || s.canvas.height !== h) { s.canvas.width = w; s.canvas.height = h; }
      s.ext = segs[i];
    }
  }

  // (Re)attach the segment canvases to the map as raster layers UNDER the
  // chart's own features — weather must never paint over the route, AIS or labels.
  function removeFromMap(map) {
    for (var i = 0; i < 4; i++) {
      var id = SRC_ID + '-' + i;
      try { if (map.getLayer(id)) map.removeLayer(id); } catch (e) {}
      try { if (map.getSource(id)) map.removeSource(id); } catch (e) {}
    }
  }
  function addToMap(map) {
    removeFromMap(map);
    var before;
    try { before = map.getLayer('route-line') ? 'route-line' : undefined; } catch (e) {}
    state.segs.forEach(function (s, i) {
      var id = SRC_ID + '-' + i;
      // animate:true — MapLibre re-reads the canvas every frame (its stock video-canvas
      // path). The previous play()/pause() refresh dance could freeze a STALE texture.
      map.addSource(id, {
        type: 'canvas', canvas: s.canvas, animate: true,
        coordinates: [[s.ext.west, s.ext.north], [s.ext.east, s.ext.north], [s.ext.east, s.ext.south], [s.ext.west, s.ext.south]]
      });
      // raster-opacity-transition 0: MapLibre tweens raster-opacity over 300ms by default,
      // and an idle map FREEZES mid-tween — the slider then reads as a permanently
      // washed-out field (chart bleeding through at "opacity 1"). Photoshop dials don't fade.
      map.addLayer({ id: id, type: 'raster', source: id,
        paint: { 'raster-opacity': state.opacity, 'raster-opacity-transition': { duration: 0, delay: 0 },
                 'raster-resampling': 'linear', 'raster-fade-duration': 0 } }, before);
    });
  }

  // Tier field -> rg32float texture (NaN -> SENTINEL). Scalar bands land in .r.
  function uploadFrame(assembled) {
    var m = assembled.meta, dev = state.gpu.device;
    var n = m.width * m.height, data = new Float32Array(n * 2);
    var b0 = assembled.bands[m.bands[0]], b1 = m.bands.length > 1 ? assembled.bands[m.bands[1]] : null;
    for (var i = 0; i < n; i++) {
      var a = b0[i], b = b1 ? b1[i] : 0;
      data[i * 2] = (a === a) ? a : SENTINEL;
      data[i * 2 + 1] = (b === b) ? b : (b1 ? SENTINEL : 0);
    }
    var tex = dev.createTexture({ size: [m.width, m.height], format: 'rg32float',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    dev.queue.writeTexture({ texture: tex }, data, { bytesPerRow: m.width * 8 }, [m.width, m.height]);
    return tex;
  }

  // CPU half of the ramp: domain + LUT bytes (no GPU needed, fail-loud on missing ramp).
  function rampLut(layer) {
    var R = global.HelmWxRamp;
    var stops = R && R.stopsFor ? R.stopsFor(layer) : null;
    if (!stops || !stops.length) throw loud('unsupported_renderer_capability', 'No colour ramp for layer ' + layer, { action: 'add ramp stops' });
    var rmin = stops[0][0], rmax = stops[stops.length - 1][0];
    var lut = new Uint8Array(256 * 4);
    for (var i = 0; i < 256; i++) {
      var v = rmin + (i / 255) * (rmax - rmin);
      var c = R.rampColor(layer, v);                       // [r,g,b,a(0..255)] — layer alpha ramps preserved
      lut[i * 4] = c[0]; lut[i * 4 + 1] = c[1]; lut[i * 4 + 2] = c[2];
      lut[i * 4 + 3] = c.length > 3 ? c[3] : 255;
    }
    return { lut: lut, rmin: rmin, rspan: (rmax - rmin) || 1 };
  }

  function rampTexture(lutInfo) {
    var dev = state.gpu.device;
    var tex = dev.createTexture({ size: [256, 1], format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    dev.queue.writeTexture({ texture: tex }, lutInfo.lut, { bytesPerRow: 1024 }, [256, 1]);
    return tex;
  }

  // ---- data plane -----------------------------------------------------------

  // CPU-only: fetch + decode + assemble one frame. GPU upload happens later so the
  // whole data plane (incl. its fail-loud paths) works and is testable without WebGPU.
  function loadFrame(validTime) {
    if (state.frames[validTime]) return Promise.resolve(state.frames[validTime]);
    var man = state.manifest, layer = state.layer;
    var keys = D().chunkKeysFor(man, layer, validTime);
    if (!keys.length) {
      throw loud('out_of_pack', 'No chunks for ' + layer + ' @ ' + validTime,
        { validTime: validTime, action: 'install pack / wait for model run' });
    }
    return Promise.all(keys.map(function (k) {
      return P().fetchChunk(man, state.manifestUrl, k, state.transport).then(function (env) {
        return D().decodeChunk(env, { chunkKey: k, packId: man.packId });
      });
    })).then(function (decoded) {
      var assembled = D().assembleTier(man, layer, validTime, decoded);
      if (assembled.chunksPlaced < keys.length) {
        // a hole is a REAL signal — visible in status().diagnostics, never papered over
        record('partial_frame', { validTime: validTime, placed: assembled.chunksPlaced, expected: keys.length });
      }
      state.frames[validTime] = { assembled: assembled, tex: null };
      return state.frames[validTime];
    });
  }

  function uploadFrames() {
    for (var vt in state.frames) {
      if (state.frames.hasOwnProperty(vt) && !state.frames[vt].tex) {
        state.frames[vt].tex = uploadFrame(state.frames[vt].assembled);
      }
    }
  }

  // Feed the particle engine from the SAME assembled arrays (value-lerped on CPU
  // at the current frac — matches what the shader draws, contract §8).
  function feedParticles() {
    var w = global.__helmWind;
    if (!w) return;
    if (state.meta.kind !== 'vector') {                      // scalar layer: previous wind trails must not linger
      try { w.setVisible(false); } catch (e) {}
      return;
    }
    // Drawer parity: the #particles checkbox is authoritative when present. Unchecked ->
    // particles stay hidden (explicitly, not silently: the drawer owns that state).
    try {
      var cb = typeof document !== 'undefined' && document.getElementById('particles');
      if (cb && !cb.checked) { w.setVisible(false); return; }
    } catch (e) {}
    var br = state.bracket;
    var A = state.frames[br.a].assembled, B = state.frames[br.b].assembled;
    var lerped = A;
    if (br.frac > 0 && br.b !== br.a) {
      var n = A.meta.width * A.meta.height, u = new Float32Array(n), v = new Float32Array(n);
      var au = A.bands.u, av = A.bands.v, bu = B.bands.u, bv = B.bands.v, f = br.frac;
      for (var i = 0; i < n; i++) {
        u[i] = lerp1(au[i], bu[i], f);
        v[i] = lerp1(av[i], bv[i], f);
      }
      lerped = { meta: A.meta, bands: { u: u, v: v } };
    }
    var unitF = UNIT_FACTOR[state.layer] || 1;
    var vel = D().toVelocityGrid(lerped, unitF);
    var any = false, data = vel[0].data;
    for (var j = 0; j < data.length; j++) { if (data[j] === data[j]) { any = true; break; } }
    if (!any) {
      record('no_vector_data', { validTime: state.bracket.a, action: 'check pack bake coverage' });
      w.setVisible(false);
      return;
    }
    w.setData(vel);
    w.setVisible(true);
  }
  function lerp1(a, b, f) { var ga = a === a, gb = b === b; if (ga && gb) return a + (b - a) * f; if (ga) return a; if (gb) return b; return NaN; }

  // ---- render ---------------------------------------------------------------

  // One fullscreen pass into the offscreen geographic canvas. Runs on enable and
  // time-scrub ONLY — map gestures never reach this (MapLibre warps the texture).
  function render() {
    if (!state.on || !state.gpu || !state.bracket || !state.segs.length) return;
    var g = state.gpu, dev = g.device, m = state.meta, br = state.bracket;
    var fA = state.frames[br.a], fB = state.frames[br.b];
    if (!fA || !fA.tex || !fB || !fB.tex) return;
    var unitF = UNIT_FACTOR[state.layer] || 1;
    state.segs.forEach(function (seg) {
      // one uniform buffer per segment draw: writeBuffer+submit per pass keeps ordering
      dev.queue.writeBuffer(g.ubuf, 0, new Float32Array([
        m.west, m.north, m.dx, m.dy,
        m.width, m.height, m.global ? 1 : 0, br.frac,
        unitF, g.rmin, g.rspan, seg.ext.west,
        m.kind === 'vector' ? 1 : 0, seg.ext.mN, seg.ext.mS, seg.ext.east]));
      var bind = dev.createBindGroup({ layout: g.pipe.getBindGroupLayout(0), entries: [
        { binding: 0, resource: { buffer: g.ubuf } },
        { binding: 1, resource: fA.tex.createView() },
        { binding: 2, resource: fB.tex.createView() },
        { binding: 3, resource: g.rampTex.createView() },
        { binding: 4, resource: g.sampler }] });
      var enc = dev.createCommandEncoder();
      var pass = enc.beginRenderPass({ colorAttachments: [{ view: seg.ctx.getCurrentTexture().createView(),
        clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: 'clear', storeOp: 'store' }] });
      pass.setPipeline(g.pipe);
      pass.setBindGroup(0, bind);
      pass.draw(3);
      pass.end();
      dev.queue.submit([enc.finish()]);
    });
    if (state.map && state.map.triggerRepaint) state.map.triggerRepaint();
  }

  // ---- public ---------------------------------------------------------------

  function enable(map, opts) {
    opts = opts || {};
    if (!opts.manifestUrl) return Promise.reject(loud('missing_manifest', 'enable() needs opts.manifestUrl', {}));
    state.map = map;
    state.layer = opts.layer || 'wind';
    state.transport = opts.transport || (opts.chunkEndpoint ? { chunkEndpoint: opts.chunkEndpoint } : null);
    if (opts.opacity != null) state.opacity = +opts.opacity;
    // Data plane FIRST (all CPU): manifest, tier, ramp domain, chunk fetch/decode/assembly.
    // Every data fail-loud path works — and is testable — without a GPU. The capability
    // gate comes last, so 'unsupported_renderer_capability' means exactly that.
    var lutInfo;
    state.diagnostics = [];                                  // reset FIRST — loadFrame records partial_frame into it
    var gen = ++state._gen;                                  // off/disable during the awaits must win (no ghost re-enable)
    return P().fetchManifest(opts.manifestUrl).then(function (man) {
      // Frames belong to ONE pack identity. A different manifest/pack/run (or layer)
      // must never be served cached frames from a previous one — that would smuggle
      // stale or unverified data past the transport's checksum gate.
      var ident = [opts.manifestUrl, man.packId, man.generatedAt, state.layer].join('|');
      if (state._frameIdent !== ident) {
        for (var k in state.frames) { if (state.frames.hasOwnProperty(k)) { try { state.frames[k].tex && state.frames[k].tex.destroy(); } catch (e) {} } }
        state.frames = {};
        state._frameIdent = ident;
      }
      state.manifest = man; state.manifestUrl = opts.manifestUrl;
      state.meta = D().tierMeta(man, state.layer);
      var R = global.HelmWxRamp;
      if (R && R.clearManifestRamp) R.clearManifestRamp(state.layer);   // canonical RAMPS drive grid LUTs
      lutInfo = rampLut(state.layer);
      state.bracket = D().bracketValidTimes((man.run || {}).validTimes, opts.when);
      return Promise.all([loadFrame(state.bracket.a), loadFrame(state.bracket.b)]);
    }).then(function () {
      return ensureGpu();
    }).then(function (g) {
      if (gen !== state._gen) { publish(); return status(); }   // superseded by disable()/off — stay down
      g.rampTex = rampTexture(lutInfo); g.rmin = lutInfo.rmin; g.rspan = lutInfo.rspan;
      uploadFrames();
      makeCanvases();
      state.on = true;
      render();
      addToMap(map);
      feedParticles();
      publish();
      return status();
    }).catch(function (e) {
      record(e.code || 'enable_failed', Object.assign({ message: e.message, action: (e.details && e.details.action) || undefined }, e.details));
      state.on = false;
      publish();
      throw e;                                                 // fail loud — caller must not paper over this
    });
  }

  function setTime(iso) {
    if (!state.manifest) return Promise.reject(loud('out_of_pack', 'grid scene is not enabled', {}));
    var prev = state.bracket;
    state.bracket = D().bracketValidTimes((state.manifest.run || {}).validTimes, iso);
    return Promise.all([loadFrame(state.bracket.a), loadFrame(state.bracket.b)]).then(function () {
      if (state.gpu) uploadFrames();
      feedParticles(); render(); publish(); return status();
    }).catch(function (e) {
      state.bracket = prev;                                  // the display keeps showing what it SAYS it shows
      record(e.code || 'set_time_failed', { message: e.message });
      render(); publish();
      throw e;
    });
  }

  // WX-26: probe sampler — helm.layer.sample.v1 shape (parity with the old scene's sample()).
  // CPU bilinear over the SAME assembled frames the GPU draws, value-lerped at the current
  // bracket, converted to display units. NODATA-honest: any poisoned corner -> value null.
  function sampleFrameCPU(assembled, lat, lon) {
    var m = assembled.meta;
    var lonN = lon - 360 * Math.floor((lon - m.west) / 360);       // into [west, west+360)
    var fx = (lonN - m.west) / m.dx;
    var fy = (m.north - lat) / m.dy;
    if (fy < 0 || fy > m.height - 1) return null;
    if (!m.global && (fx < 0 || fx > m.width - 1)) return null;
    var x0 = Math.floor(fx), y0 = Math.floor(Math.max(0, Math.min(m.height - 1, fy)));
    var y1 = Math.min(y0 + 1, m.height - 1);
    var x1 = x0 + 1;
    if (m.global) { x0 = ((x0 % m.width) + m.width) % m.width; x1 = (x0 + 1) % m.width; }
    else { x0 = Math.max(0, Math.min(m.width - 1, x0)); x1 = Math.max(0, Math.min(m.width - 1, x1)); }
    var gx = fx - Math.floor(fx), gy = Math.max(0, Math.min(m.height - 1, fy)) - y0;
    var out = {};
    for (var b = 0; b < m.bands.length; b++) {
      var band = assembled.bands[m.bands[b]];
      var p00 = band[y0 * m.width + x0], p10 = band[y0 * m.width + x1];
      var p01 = band[y1 * m.width + x0], p11 = band[y1 * m.width + x1];
      if (p00 !== p00 || p10 !== p10 || p01 !== p01 || p11 !== p11) return null;   // NODATA poisons
      out[m.bands[b]] = p00 * (1 - gx) * (1 - gy) + p10 * gx * (1 - gy) + p01 * (1 - gx) * gy + p11 * gx * gy;
    }
    return out;
  }

  function sample(lat, lon) {
    if (!state.bracket) return Promise.resolve(null);   // data-plane read: works whenever frames are loaded
    var br = state.bracket;
    var A = state.frames[br.a], B = state.frames[br.b];
    if (!A || !B) return Promise.resolve(null);
    var a = sampleFrameCPU(A.assembled, lat, lon);
    var b = sampleFrameCPU(B.assembled, lat, lon);
    var vals = null;
    if (a && b) { vals = {}; for (var k in a) if (a.hasOwnProperty(k)) vals[k] = a[k] + (b[k] - a[k]) * br.frac; }
    else vals = a || b;
    var unitF = UNIT_FACTOR[state.layer] || 1;
    var display = null, uv = null;
    if (vals) {
      if (state.meta.kind === 'vector') {
        display = Math.sqrt(vals.u * vals.u + vals.v * vals.v) * unitF;
        uv = { u: vals.u * unitF, v: vals.v * unitF };
      } else {
        display = vals[state.meta.bands[0]] * unitF;
      }
    }
    return Promise.resolve({
      schema: 'helm.layer.sample.v1',
      layer: state.layer,
      value: display == null ? null : Math.round(display * 10) / 10,
      unit: DISPLAY_UNIT[state.layer] || '',
      vector: uv,
      coverage: vals ? 'in' : 'out',
      advisory: true,
      notForNavigation: true,
      freshness: { generatedAt: state.manifest && state.manifest.generatedAt,
                   validTimeA: br.a, validTimeB: br.b, frac: br.frac, ageSeconds: ageSeconds() },
      sourceRef: { packId: state.manifest && state.manifest.packId,
                   title: 'helm.env.grid.v1 pack · ' + ((state.manifest && state.manifest.source && state.manifest.source.provider) || 'unknown') }
    });
  }

  // Alpha only — colour untouched (§8). The slider drives MapLibre's raster-opacity,
  // so the CHART fades through the weather; the offscreen field is never re-rendered.
  function setOpacity(o) {
    state.opacity = Math.max(0, Math.min(1, +o));
    var map = state.map;
    state.segs.forEach(function (_s, i) {
      var id = SRC_ID + '-' + i;
      try { if (map && map.getLayer(id)) map.setPaintProperty(id, 'raster-opacity', state.opacity); } catch (e) {}
    });
    publish();
  }

  function disable() {
    state._gen++;                                            // invalidate any in-flight enable
    state.on = false;
    var map = state.map;
    if (map) removeFromMap(map);
    var w = global.__helmWind;
    if (w && state.meta && state.meta.kind === 'vector') { try { w.setVisible(false); } catch (e) {} }
    state.segs.forEach(function (s) { if (s.canvas && s.canvas.parentNode) s.canvas.parentNode.removeChild(s.canvas); });
    state.segs = [];
    for (var k in state.frames) { if (state.frames.hasOwnProperty(k)) { try { state.frames[k].tex && state.frames[k].tex.destroy(); } catch (e) {} } }
    state.frames = {};
    state.manifest = null; state.meta = null; state.bracket = null;
    publish();
  }

  global.HelmWxGrid = {
    enable: enable, disable: disable, setTime: setTime, setOpacity: setOpacity, status: status,
    sample: sample,
    _test: { UNIT_FACTOR: UNIT_FACTOR, DISPLAY_UNIT: DISPLAY_UNIT, SENTINEL: SENTINEL,
             buildShader: buildShader, sampleFrameCPU: sampleFrameCPU, renderExtent: renderExtent,
             splitExtent: splitExtent, mercY: mercY }
  };
})(typeof window !== 'undefined' ? window : this);
