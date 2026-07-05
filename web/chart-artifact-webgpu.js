/*
 * Helm — chart-artifact-webgpu.js (WEBGPU-1 + WEBGPU-2)
 * --------------------------------------------------------------------------
 * Browser WebGPU nautical layer: load helm.render.artifact.v1 packets produced
 * by the C++ artifact compiler (ARTIFACT-1) and draw primitive geometry over
 * MapLibre. Chart semantics stay server-side; this module only consumes
 * compiled vertices/indices/draw batches and material/atlas keys.
 *
 * WEBGPU-2 (atlas support): material colors, symbol color, line dash/width,
 * pattern color, and palette/display-state variants (day|dusk|night) are
 * resolved by chart-artifact-atlas.js from the compiler's style/material keys +
 * the ARTIFACT-2 cache display_state. show_text/show_soundings toggles are
 * honored. Real symbol/glyph/pattern *bitmaps* are deferred until upstream
 * ships atlas bytes via atlas_refs[].content_hash; unresolved refs surface as
 * visible diagnostics (window.__helmChartAtlas.diagnostics) rather than silent
 * substitution.
 *
 * Public API — HelmChartArtifactAuto(map, opts):
 *     load(url?) / setArtifact(json) / setVisible(v) / isVisible()
 *     setDisplayState(day|dusk|night) / getPalette() / getDiagnostics()
 *     destroy() / mode()
 *
 * Fallback discipline (matches wx-particles-webgpu.js / WX-25):
 *     window.__helmChartMode = 'gpu' | 'maplibre'
 *     window.__helmChartModeReason = human-readable reason
 *     One console.info line on every path switch. PNG enc-chart is the default;
 *     WebGPU is opt-in (HELM_CHART_WEBGPU=true, localStorage helmChartWebgpu=1,
 *     or ?chartWebgpu=1). Any fallback to MapLibre is explicit and non-silent.
 * --------------------------------------------------------------------------
 */
(function (global) {
  'use strict';

  var SCHEMA = 'helm.render.artifact.v1';
  var ENC_LAYER = 'enc-chart';
  var VERTEX_STRIDE = 4; // x, y, material_index, pick_id

  // Fixture/debug palette only — not S-52 presentation decisions.
  var MATERIAL_RGBA = [
    [0.35, 0.35, 0.40, 0.85],
    [0.12, 0.42, 0.72, 0.55],
    [0.05, 0.55, 0.35, 0.95],
    [0.90, 0.55, 0.10, 0.90],
    [0.85, 0.85, 0.20, 0.90],
    [0.70, 0.20, 0.55, 0.90]
  ];

  function mercX(lon) { return lon / 360 + 0.5; }
  function mercY(lat) {
    var s = Math.sin(lat * Math.PI / 180);
    s = Math.max(-0.9999, Math.min(0.9999, s));
    return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
  }

  function affineFromProbes(cLng, cLat, dLon, dLat, p0, pE, pN) {
    var mx0 = mercX(cLng), my0 = mercY(cLat);
    var dmx = mercX(cLng + dLon) - mx0;
    var dmy = mercY(cLat + dLat) - my0;
    if (!dmx || !dmy) return null;
    var a = (pE.x - p0.x) / dmx, c = (pE.y - p0.y) / dmx;
    var b = (pN.x - p0.x) / dmy, d = (pN.y - p0.y) / dmy;
    return [a, b, p0.x - a * mx0 - b * my0,
            c, d, p0.y - c * mx0 - d * my0];
  }

  function parseArtifactJson(json) {
    if (!json || json.schema_version !== SCHEMA) {
      throw new Error('expected schema ' + SCHEMA);
    }
    var geo = json.geometry || {};
    var verts = geo.vertices_f32;
    var inds = geo.indices_u32;
    if (!Array.isArray(verts) || !Array.isArray(inds)) {
      throw new Error('artifact geometry missing vertices_f32 or indices_u32');
    }
    if (verts.length % VERTEX_STRIDE !== 0) {
      throw new Error('vertices_f32 length must be a multiple of ' + VERTEX_STRIDE);
    }
    var vp = json.viewport || {};
    var bbox = vp.geographic_bbox || {};
    var px = vp.pixel_size || [1, 1];
    return {
      schema_version: json.schema_version,
      artifact_id: json.artifact_id || '',
      viewport: {
        west: +bbox.west || 0,
        south: +bbox.south || 0,
        east: +bbox.east || 0,
        north: +bbox.north || 0,
        pixel_width: +px[0] || 1,
        pixel_height: +px[1] || 1,
        tile: vp.tile || {}
      },
      checksums: json.checksums || {},
      material_table: json.material_table || [],
      draw_batches: (json.draw_batches || []).slice().sort(function (a, b) {
        return (+a.order_bucket || 0) - (+b.order_bucket || 0);
      }),
      pick_records: json.pick_records || [],
      source_model_id: json.source_model_id || '',
      // ARTIFACT-2 cache block (display_state palette, show_text/show_soundings, …).
      // Consumed by the atlas resolver for palette/display-state variants (WEBGPU-2).
      cache: json.cache || null,
      vertices: new Float32Array(verts),
      indices: new Uint32Array(inds)
    };
  }

  // Atlas resolver (WEBGPU-2) is optional; when absent we keep the WEBGPU-1
  // debug palette so the layer still draws. Never a silent chart-color claim.
  function atlas() { return global.HelmChartArtifactAtlas || null; }

  function tilePixelToLonLat(x, y, vp) {
    var pw = vp.pixel_width || 1;
    var ph = vp.pixel_height || 1;
    return {
      lon: vp.west + (x / pw) * (vp.east - vp.west),
      lat: vp.north - (y / ph) * (vp.north - vp.south)
    };
  }

  function isFiniteNumber(v) {
    return typeof v === 'number' && Number.isFinite(v);
  }

  function artifactBbox(artifact) {
    var vp = artifact && artifact.viewport;
    if (!vp) return null;
    var box = {
      west: +vp.west,
      south: +vp.south,
      east: +vp.east,
      north: +vp.north
    };
    if (!isFiniteNumber(box.west) || !isFiniteNumber(box.south) ||
        !isFiniteNumber(box.east) || !isFiniteNumber(box.north)) return null;
    if (box.east < box.west || box.north < box.south) return null;
    return box;
  }

  function bboxIntersects(a, b) {
    if (!a || !b) return false;
    return !(a.east < b.west || a.west > b.east || a.north < b.south || a.south > b.north);
  }

  function boundsToBbox(bounds) {
    if (!bounds) return null;
    if (typeof bounds.getWest === 'function') {
      return {
        west: +bounds.getWest(),
        south: +bounds.getSouth(),
        east: +bounds.getEast(),
        north: +bounds.getNorth()
      };
    }
    if (Array.isArray(bounds) && bounds.length >= 2) {
      var west = Math.min(+bounds[0][0], +bounds[1][0]);
      var east = Math.max(+bounds[0][0], +bounds[1][0]);
      var south = Math.min(+bounds[0][1], +bounds[1][1]);
      var north = Math.max(+bounds[0][1], +bounds[1][1]);
      return { west: west, south: south, east: east, north: north };
    }
    return null;
  }

  function mapBbox(map) {
    try {
      return map && map.getBounds ? boundsToBbox(map.getBounds()) : null;
    } catch (e) {
      return null;
    }
  }

  function artifactIntersectsBounds(artifact, bounds) {
    return bboxIntersects(artifactBbox(artifact), boundsToBbox(bounds) || bounds);
  }

  function artifactIntersectsMap(artifact, map) {
    var mapBox = mapBbox(map);
    if (!mapBox) return true;
    return artifactIntersectsBounds(artifact, mapBox);
  }

  function bboxLabel(box) {
    if (!box) return 'unknown bbox';
    function f(v) { return Number(v).toFixed(4); }
    return f(box.south) + '..' + f(box.north) + ', ' + f(box.west) + '..' + f(box.east);
  }

  function outsideViewportReason(artifact, map) {
    return 'artifact outside current viewport (artifact ' + bboxLabel(artifactBbox(artifact)) +
      ', map ' + bboxLabel(mapBbox(map)) + ')';
  }

  function buildViewUniform(map, artifact, w, h) {
    var vp = artifact.viewport;
    var c = tilePixelToLonLat(vp.pixel_width * 0.5, vp.pixel_height * 0.5, vp);
    var dLon = (vp.east - vp.west) / Math.max(1, vp.pixel_width);
    var dLat = (vp.north - vp.south) / Math.max(1, vp.pixel_height);
    var p0, pE, pN;
    try {
      p0 = map.project([c.lon, c.lat]);
      pE = map.project([c.lon + dLon, c.lat]);
      pN = map.project([c.lon, c.lat + dLat]);
    } catch (e) {
      return null;
    }
    var aff = affineFromProbes(c.lon, c.lat, dLon, dLat, p0, pE, pN);
    if (!aff) return null;
    return new Float32Array([
      vp.west, vp.north,
      (vp.east - vp.west) / Math.max(1, vp.pixel_width),
      (vp.north - vp.south) / Math.max(1, vp.pixel_height),
      aff[0], aff[1], aff[2], aff[3], aff[4], aff[5],
      1 / Math.max(1, w), 1 / Math.max(1, h)
    ]);
  }

  var WGSL = [
    'struct View {',
    '  west: f32, north: f32, dLonPerPx: f32, dLatPerPx: f32,',
    '  a: f32, b: f32, tx: f32, c: f32, d: f32, ty: f32, invW: f32, invH: f32,',
    '};',
    '@group(0) @binding(0) var<uniform> view: View;',
    // WEBGPU-2: per-material RGBA indexed by material_index, filled from the atlas
    // resolver (palette/display-state aware) — replaces the WEBGPU-1 hardcoded switch.
    '@group(0) @binding(1) var<uniform> materials: array<vec4<f32>, 32>;',
    // SCHED-2: zoom/pan blend weight for adjacent-level composite draws.
    '@group(0) @binding(2) var<uniform> blend: vec4<f32>;',
    'struct VSOut { @builtin(position) pos: vec4<f32>, @location(0) color: vec4<f32> };',
    'fn tileToNdc(px: f32, py: f32) -> vec2<f32> {',
    '  let lon = view.west + px * view.dLonPerPx;',
    '  let lat = view.north - py * view.dLatPerPx;',
    '  let mx = lon / 360.0 + 0.5;',
    '  let s = clamp(sin(lat * 3.14159265 / 180.0), -0.9999, 0.9999);',
    '  let my = 0.5 - log((1.0 + s) / (1.0 - s)) / (4.0 * 3.14159265);',
    '  let sx = view.a * mx + view.b * my + view.tx;',
    '  let sy = view.c * mx + view.d * my + view.ty;',
    '  return vec2<f32>(sx * view.invW * 2.0 - 1.0, 1.0 - sy * view.invH * 2.0);',
    '}',
    'fn matColor(idx: f32) -> vec4<f32> {',
    '  let i = min(u32(max(idx, 0.0)), 31u);',
    '  return materials[i];',
    '}',
    '@vertex fn vs(@location(0) tile_xy: vec2<f32>, @location(1) mat_idx: f32) -> VSOut {',
    '  var o: VSOut;',
    '  let ndc = tileToNdc(tile_xy.x, tile_xy.y);',
    '  o.pos = vec4<f32>(ndc, 0.0, 1.0);',
    '  o.color = matColor(mat_idx);',
    '  return o;',
    '}',
    '@fragment fn fs(in: VSOut) -> @location(0) vec4<f32> { return in.color * blend; }'
  ].join('\n');

  function GpuChartArtifactLayer(map, gpu, artifact) {
    this.map = map;
    this.gpu = gpu;
    this.artifact = artifact;
    this._visible = false;
    this._destroyed = false;
    this._raf = null;
    this._palette = (gpu && gpu.palette) || 'day';   // display-state palette (day|dusk|night)
    this._resources = (gpu && gpu.resources) || null; // web atlas fixture resources (optional)
    this._resolvedCache = Object.create(null);
    this._dashBuf = null;
    this._dashCapacity = 0;
    this._compositeEntries = [];
    this._compositeOpts = {};
    this._artifactGpu = Object.create(null);
    this._setMode = (gpu && gpu.setMode) || function () {};
    this._buildCanvas();
    this._buildPipelines();
    if (this.artifact) this._uploadGeometry();
    this._bindMap();
    this._resize();
  }

  GpuChartArtifactLayer.prototype._buildCanvas = function () {
    var mapCanvas = this.map.getCanvas();
    var container = mapCanvas.parentNode;
    var c = document.createElement('canvas');
    c.className = 'helm-chart-artifact-canvas';
    var s = c.style;
    s.position = 'absolute';
    s.top = '0';
    s.left = '0';
    s.width = '100%';
    s.height = '100%';
    s.pointerEvents = 'none';
    s.zIndex = '0';
    s.display = 'none';
    this.canvas = c;
    this.ctx = c.getContext('webgpu');
    if (!this.ctx) throw new Error('canvas.getContext("webgpu") returned null');
    this.ctx.configure({
      device: this.gpu.device,
      format: this.gpu.canvasFormat,
      alphaMode: 'premultiplied'
    });
    (container || mapCanvas.parentNode).appendChild(c);
  };

  GpuChartArtifactLayer.prototype._buildPipelines = function () {
    var dev = this.gpu.device;
    var mod = dev.createShaderModule({ code: WGSL });
    var blend = {
      color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha' },
      alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' }
    };
    var mk = function (topology) {
      return dev.createRenderPipeline({
        layout: 'auto',
        vertex: {
          module: mod,
          entryPoint: 'vs',
          buffers: [{
            arrayStride: VERTEX_STRIDE * 4,
            attributes: [
              { shaderLocation: 0, offset: 0, format: 'float32x2' },
              { shaderLocation: 1, offset: 8, format: 'float32' }
            ]
          }]
        },
        fragment: { module: mod, entryPoint: 'fs', targets: [{ format: this.gpu.canvasFormat, blend: blend }] },
        primitive: { topology: topology }
      });
    }.bind(this);
    this.triPipe = mk('triangle-list');
    this.linePipe = mk('line-list');
    this.pointPipe = mk('point-list');
    this.viewBuf = dev.createBuffer({ size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    // WEBGPU-2: 32 materials * vec4 (16B) = 512B color table, indexed by material_index.
    this.materialsBuf = dev.createBuffer({ size: 512, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.blendBuf = dev.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this._makeViewBind = function (pipe) {
      return dev.createBindGroup({
        layout: pipe.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this.viewBuf } },
          { binding: 1, resource: { buffer: this.materialsBuf } },
          { binding: 2, resource: { buffer: this.blendBuf } }
        ]
      });
    }.bind(this);
    this.viewBindTri = this._makeViewBind(this.triPipe);
    this.viewBindLine = this._makeViewBind(this.linePipe);
    this.viewBindPoint = this._makeViewBind(this.pointPipe);
  };

  GpuChartArtifactLayer.prototype._uploadGeometry = function () {
    var dev = this.gpu.device;
    var art = this.artifact;
    if (!art) return;
    if (this.vertexBuf) { try { this.vertexBuf.destroy(); } catch (e) {} }
    if (this.indexBuf) { try { this.indexBuf.destroy(); } catch (e) {} }
    this.vertexBuf = dev.createBuffer({
      size: art.vertices.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST
    });
    this.indexBuf = dev.createBuffer({
      size: art.indices.byteLength,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST
    });
    dev.queue.writeBuffer(this.vertexBuf, 0, art.vertices);
    dev.queue.writeBuffer(this.indexBuf, 0, art.indices);
  };

  GpuChartArtifactLayer.prototype._ensureArtifactGpu = function (artifact) {
    var id = artifact.artifact_id || (artifact.viewport && artifact.viewport.tile
      ? ('z' + artifact.viewport.tile.z + 'x' + artifact.viewport.tile.x + 'y' + artifact.viewport.tile.y)
      : 'default');
    if (this._artifactGpu[id]) return this._artifactGpu[id];
    var dev = this.gpu.device;
    var row = {
      id: id,
      artifact: artifact,
      vertexBuf: dev.createBuffer({
        size: artifact.vertices.byteLength,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST
      }),
      indexBuf: dev.createBuffer({
        size: artifact.indices.byteLength,
        usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST
      })
    };
    dev.queue.writeBuffer(row.vertexBuf, 0, artifact.vertices);
    dev.queue.writeBuffer(row.indexBuf, 0, artifact.indices);
    this._artifactGpu[id] = row;
    return row;
  };

  // Resolve (and cache) material styles for an artifact under the current
  // display-state palette. Keyed by artifact id + palette so a palette change
  // recomputes. Falls back to the WEBGPU-1 debug palette when the atlas module
  // is absent, so the layer always has colors.
  GpuChartArtifactLayer.prototype._resolvedFor = function (artifact) {
    var A = atlas();
    var id = (artifact.artifact_id || 'default') + '@' + this._palette;
    if (this._resolvedCache[id]) return this._resolvedCache[id];
    var resolved;
    if (A) {
      resolved = A.resolveArtifact(artifact, this._palette, this._resources);
    } else {
      resolved = { palette: this._palette, materials: (artifact.material_table || []).map(function (m, i) {
        var c = MATERIAL_RGBA[i % MATERIAL_RGBA.length];
        return { rgba: c.slice(), visible: true, style_key: (m && m.style_key) || '' };
      }), diagnostics: [], displayState: (artifact.cache && artifact.cache.display_state) || {} };
    }
    this._resolvedCache[id] = resolved;
    return resolved;
  };

  GpuChartArtifactLayer.prototype._writeMaterials = function (resolved) {
    var A = atlas();
    var colors;
    if (A) {
      colors = A.packMaterialColors(resolved.materials, 32);
    } else {
      colors = new Float32Array(32 * 4);
      for (var i = 0; i < resolved.materials.length && i < 32; i++) {
        var c = resolved.materials[i].rgba || [0, 0, 0, 0];
        colors[i * 4] = c[0]; colors[i * 4 + 1] = c[1]; colors[i * 4 + 2] = c[2]; colors[i * 4 + 3] = c[3];
      }
    }
    this.gpu.device.queue.writeBuffer(this.materialsBuf, 0, colors);
  };

  // Build a flat (x,y,mat,pick) line-list vertex array of the DASHED sub-segments
  // for every line batch whose resolved material carries a dash. Dash lengths are
  // pixel-space (S-52 line style), converted to tile-space per segment via the
  // live projection so the pattern holds its on-screen cadence across zoom.
  GpuChartArtifactLayer.prototype._buildDashedVerts = function (artifact, resolved) {
    var A = atlas();
    if (!A) return null;
    var vp = artifact.viewport;
    var verts = artifact.vertices;
    var inds = artifact.indices;
    var out = [];
    var batches = artifact.draw_batches || [];
    for (var bi = 0; bi < batches.length; bi++) {
      var b = batches[bi];
      if (b.topology !== 'line_list') continue;
      var rm = resolved.materials[b.material_index];
      if (!rm || rm.visible === false || !rm.line || !rm.line.dash || !rm.line.dash.length) continue;
      for (var k = 0; k + 1 < b.index_count; k += 2) {
        var i0 = inds[b.first_index + k], i1 = inds[b.first_index + k + 1];
        var x0 = verts[i0 * 4], y0 = verts[i0 * 4 + 1];
        var x1 = verts[i1 * 4], y1 = verts[i1 * 4 + 1];
        var mat = verts[i0 * 4 + 2], pick = verts[i0 * 4 + 3];
        var upp = this._tileUnitsPerPixel(x0, y0, x1, y1, vp);
        var subs = A.dashSegments(x0, y0, x1, y1, rm.line.dash, upp);
        for (var s = 0; s < subs.length; s++) {
          var seg = subs[s];
          out.push(seg[0], seg[1], mat, pick, seg[2], seg[3], mat, pick);
        }
      }
    }
    return out.length ? new Float32Array(out) : null;
  };

  // tile-space units per on-screen pixel along a segment (for dash cadence).
  GpuChartArtifactLayer.prototype._tileUnitsPerPixel = function (x0, y0, x1, y1, vp) {
    try {
      var a = tilePixelToLonLat(x0, y0, vp), b = tilePixelToLonLat(x1, y1, vp);
      var pa = this.map.project([a.lon, a.lat]), pb = this.map.project([b.lon, b.lat]);
      var screen = Math.sqrt((pb.x - pa.x) * (pb.x - pa.x) + (pb.y - pa.y) * (pb.y - pa.y));
      var tile = Math.sqrt((x1 - x0) * (x1 - x0) + (y1 - y0) * (y1 - y0));
      if (screen > 1e-6 && tile > 1e-9) return tile / screen;
    } catch (e) {}
    return 1;
  };

  GpuChartArtifactLayer.prototype._ensureDashBuf = function (byteLength) {
    if (this._dashBuf && this._dashCapacity >= byteLength) return this._dashBuf;
    if (this._dashBuf) { try { this._dashBuf.destroy(); } catch (e) {} }
    var cap = Math.max(byteLength, 1024);
    this._dashBuf = this.gpu.device.createBuffer({ size: cap, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    this._dashCapacity = cap;
    return this._dashBuf;
  };

  GpuChartArtifactLayer.prototype.setDisplayState = function (palette) {
    var A = atlas();
    this._palette = A ? A.normalizePalette(palette) : (palette || 'day');
    this._paletteExplicit = true;
    this._resolvedCache = Object.create(null);
    global.__helmChartPalette = this._palette;
    if (this._visible) this._draw();
  };

  GpuChartArtifactLayer.prototype.getDiagnostics = function () {
    if (!this.artifact) return [];
    return this._resolvedFor(this.artifact).diagnostics || [];
  };

  GpuChartArtifactLayer.prototype.setResources = function (resources) {
    this._resources = resources || null;
    this._resolvedCache = Object.create(null);
    if (this._visible) this._draw();
  };

  GpuChartArtifactLayer.prototype.getPalette = function () { return this._palette; };

  GpuChartArtifactLayer.prototype._bindMap = function () {
    var self = this;
    this._onResize = function () { self._resize(); self._draw(); };
    this._onMove = function () { if (self._visible) self._draw(); };
    this.map.on('resize', this._onResize);
    this.map.on('move', this._onMove);
    this.map.on('moveend', this._onMove);
  };

  GpuChartArtifactLayer.prototype._unbindMap = function () {
    this.map.off('resize', this._onResize);
    this.map.off('move', this._onMove);
    this.map.off('moveend', this._onMove);
  };

  GpuChartArtifactLayer.prototype._resize = function () {
    if (this._destroyed) return;
    var mapCanvas = this.map.getCanvas();
    var w = mapCanvas.clientWidth || mapCanvas.width;
    var h = mapCanvas.clientHeight || mapCanvas.height;
    var dpr = Math.min(global.devicePixelRatio || 1, 2);
    this._w = w;
    this._h = h;
    this.canvas.width = Math.max(1, Math.round(w * dpr));
    this.canvas.height = Math.max(1, Math.round(h * dpr));
    this.canvas.style.width = w + 'px';
    this.canvas.style.height = h + 'px';
  };

  GpuChartArtifactLayer.prototype._pipeForTopology = function (topology) {
    if (topology === 'line_list') return { pipe: this.linePipe, bind: this.viewBindLine };
    if (topology === 'points') return { pipe: this.pointPipe, bind: this.viewBindPoint };
    return { pipe: this.triPipe, bind: this.viewBindTri };
  };

  GpuChartArtifactLayer.prototype._drawArtifact = function (pass, artifact, blendWeight) {
    if (!artifactIntersectsMap(artifact, this.map)) return false;
    var gpuArt = this._ensureArtifactGpu(artifact);
    var view = buildViewUniform(this.map, artifact, this._w, this._h);
    if (!view) return false;
    var dev = this.gpu.device;
    dev.queue.writeBuffer(this.viewBuf, 0, view);
    var w = Math.max(0, Math.min(1, blendWeight == null ? 1 : blendWeight));
    dev.queue.writeBuffer(this.blendBuf, 0, new Float32Array([w, w, w, w]));
    var resolved = this._resolvedFor(artifact);
    this._writeMaterials(resolved);
    var batches = artifact.draw_batches || [];
    for (var i = 0; i < batches.length; i++) {
      var b = batches[i];
      if (!b.index_count) continue;
      var rm = resolved.materials[b.material_index];
      if (rm && rm.visible === false) continue;
      if (b.topology === 'line_list' && rm && rm.line && rm.line.dash && rm.line.dash.length) continue;
      var sel = this._pipeForTopology(b.topology);
      pass.setPipeline(sel.pipe);
      pass.setBindGroup(0, sel.bind);
      pass.setVertexBuffer(0, gpuArt.vertexBuf);
      pass.setIndexBuffer(gpuArt.indexBuf, 'uint32');
      pass.drawIndexed(b.index_count, 1, b.first_index, 0, 0);
    }
    var dashed = this._buildDashedVerts(artifact, resolved);
    if (dashed && dashed.length) {
      var buf = this._ensureDashBuf(dashed.byteLength);
      dev.queue.writeBuffer(buf, 0, dashed);
      pass.setPipeline(this.linePipe);
      pass.setBindGroup(0, this.viewBindLine);
      pass.setVertexBuffer(0, buf);
      pass.draw(dashed.length / VERTEX_STRIDE, 1, 0, 0);
    }
    return true;
  };

  GpuChartArtifactLayer.prototype._draw = function () {
    if (this._destroyed || !this._visible) return;
    var entries = this._compositeEntries.length ? this._compositeEntries : (
      this.artifact ? [{ artifact: this.artifact, blend_weight: 1 }] : []
    );
    var drawEntries = [];
    var outsideReason = '';
    for (var ei = 0; ei < entries.length; ei++) {
      if (artifactIntersectsMap(entries[ei].artifact, this.map)) drawEntries.push(entries[ei]);
      else if (!outsideReason) outsideReason = outsideViewportReason(entries[ei].artifact, this.map);
    }
    if (!drawEntries.length) {
      this._clear();
      this.setEncChartVisible(true);
      this._setMode('maplibre', outsideReason || 'no WebGPU artifact covering current viewport');
      return;
    }
    var dev = this.gpu.device;
    var holdStale = !!(this._compositeOpts && this._compositeOpts.holdStale);
    var enc = dev.createCommandEncoder();
    var pass = enc.beginRenderPass({
      colorAttachments: [{
        view: this.ctx.getCurrentTexture().createView(),
        clearValue: { r: 0, g: 0, b: 0, a: 0 },
        loadOp: holdStale ? 'load' : 'clear',
        storeOp: 'store'
      }]
    });
    var drew = false;
    for (var i = 0; i < drawEntries.length; i++) {
      if (this._drawArtifact(pass, drawEntries[i].artifact, drawEntries[i].blend_weight)) drew = true;
    }
    pass.end();
    if (drew) {
      dev.queue.submit([enc.finish()]);
      this.setEncChartVisible(false);
      this._setMode('gpu');
    } else {
      this._clear();
      this.setEncChartVisible(true);
      this._setMode('maplibre', 'WebGPU artifact projection failed for current viewport');
    }
  };

  GpuChartArtifactLayer.prototype._clear = function () {
    if (this._destroyed || !this.ctx || !this.gpu || !this.gpu.device) return;
    var dev = this.gpu.device;
    var enc = dev.createCommandEncoder();
    var pass = enc.beginRenderPass({
      colorAttachments: [{
        view: this.ctx.getCurrentTexture().createView(),
        clearValue: { r: 0, g: 0, b: 0, a: 0 },
        loadOp: 'clear',
        storeOp: 'store'
      }]
    });
    pass.end();
    dev.queue.submit([enc.finish()]);
  };

  GpuChartArtifactLayer.prototype.setCompositeEntries = function (entries, opts) {
    this._compositeEntries = (entries || []).slice();
    this._compositeOpts = opts || {};
    if (this._visible) this._draw();
  };

  GpuChartArtifactLayer.prototype.setArtifact = function (artifact) {
    this.artifact = artifact;
    this._resolvedCache = Object.create(null);
    // Default the palette from the artifact cache display_state (ARTIFACT-2) unless
    // an explicit display state was already chosen this session.
    var A = atlas();
    if (A && !this._paletteExplicit) {
      this._palette = A.paletteFromDisplayState(artifact);
      global.__helmChartPalette = this._palette;
    }
    this._uploadGeometry();
    if (this._visible) this._draw();
    return true;
  };

  GpuChartArtifactLayer.prototype.setEncChartVisible = function (visible) {
    try {
      if (this.map.getLayer(ENC_LAYER)) {
        this.map.setLayoutProperty(ENC_LAYER, 'visibility', visible ? 'visible' : 'none');
      }
    } catch (e) {}
  };

  GpuChartArtifactLayer.prototype.setVisible = function (v) {
    this._visible = !!v;
    if (this._visible) {
      this.canvas.style.display = 'block';
      this._resize();
      this._draw();
    } else {
      this.canvas.style.display = 'none';
      this.setEncChartVisible(true);
    }
  };

  GpuChartArtifactLayer.prototype.isVisible = function () { return this._visible; };

  GpuChartArtifactLayer.prototype.destroy = function () {
    if (this._destroyed) return;
    this._destroyed = true;
    this._unbindMap();
    this.setEncChartVisible(true);
    if (this.canvas && this.canvas.parentNode) this.canvas.parentNode.removeChild(this.canvas);
    this.canvas = null;
    var kill = ['vertexBuf', 'indexBuf', 'viewBuf', 'materialsBuf', 'blendBuf', '_dashBuf'];
    for (var i = 0; i < kill.length; i++) {
      try { this[kill[i]] && this[kill[i]].destroy(); } catch (e) {}
    }
  };

  function HelmChartArtifactAuto(map, opts) {
    opts = opts || {};
    var inner = null;
    var mode = 'initializing';
    var state = {
      artifact: null, visible: false, destroyed: false,
      packetUrl: opts.packetUrl || 'data/render-artifact-chart-1.json',
      atlasUrl: opts.atlasUrl || 'data/s52-atlas-fixture.json',
      resources: null,
      palette: null
    };

    function publishAtlasStatus() {
      var A = atlas();
      var diags = (inner && inner.getDiagnostics) ? inner.getDiagnostics() : [];
      var pal = (inner && inner.getPalette) ? inner.getPalette()
        : (state.palette || (A && state.artifact ? A.paletteFromDisplayState(state.artifact) : 'day'));
      global.__helmChartPalette = pal;
      global.__helmChartAtlas = {
        available: !!A,
        palette: pal,
        resourcesLoaded: !!state.resources,
        diagnostics: diags,
        materialCount: state.artifact ? (state.artifact.material_table || []).length : 0
      };
    }

    // Load the web atlas resource mirror (optional; resolver has a built-in copy).
    if (typeof fetch !== 'undefined' && atlas()) {
      fetch(state.atlasUrl, { cache: 'no-cache' })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (json) {
          if (!json) return;
          state.resources = atlas().loadResources(json);
          if (inner && inner.setResources) inner.setResources(state.resources);
          publishAtlasStatus();
        })
        .catch(function () { /* built-in mirror stays in effect */ });
    }

    function setMode(m, reason) {
      var same = mode === m && (global.__helmChartModeReason || '') === (reason || '');
      mode = m;
      global.__helmChartMode = m;
      global.__helmChartModeReason = reason || '';
      if (!same) {
        console.info('[chart-artifact] ' + (m === 'gpu'
          ? 'WebGPU artifact layer active'
          : 'MapLibre enc-chart fallback — ' + reason));
      }
      try {
        if (map.getLayer(ENC_LAYER)) {
          map.setLayoutProperty(ENC_LAYER, 'visibility', m === 'gpu' && state.visible ? 'none' : 'visible');
        }
      } catch (e) {}
      if (global.HelmChartRendererStatus && global.HelmChartRendererStatus.publish) {
        global.HelmChartRendererStatus.publish();
      }
    }

    function replay() {
      if (state.destroyed) { if (inner) inner.destroy(); return; }
      if (state.artifact != null && inner && inner.setArtifact) inner.setArtifact(state.artifact);
      if (state.visible && inner && inner.setVisible) inner.setVisible(true);
    }

    function fallbackMapLibre(reason) {
      inner = { setArtifact: function () { return true; }, setVisible: function () {}, isVisible: function () { return false; }, destroy: function () {} };
      setMode('maplibre', reason);
    }

    function webgpuFlagEnabled() {
      if (global.HELM_CHART_WEBGPU === true) return true;
      if (global.HELM_CHART_WEBGPU === false) return false;
      try {
        var qp = new URLSearchParams(global.location && global.location.search || '');
        if (qp.get('chartWebgpu') === '1') return true;
        if (qp.get('chartWebgpu') === '0') return false;
        return global.localStorage && global.localStorage.getItem('helmChartWebgpu') === '1';
      } catch (e) { return false; }
    }

    var unprojectable = false;
    var upReason = '';
    try {
      if (map.getPitch && map.getPitch() !== 0) { unprojectable = true; upReason = 'map pitch != 0'; }
      var proj = map.getProjection && map.getProjection();
      if (proj && /globe/i.test((proj.type || proj.name || '') + '')) { unprojectable = true; upReason = 'globe projection'; }
    } catch (e) {}

    if (!webgpuFlagEnabled()) { fallbackMapLibre('HELM_CHART_WEBGPU not enabled (PNG enc-chart default)'); }
    else if (typeof navigator === 'undefined' || !navigator.gpu) { fallbackMapLibre('WebGPU unavailable (no navigator.gpu)'); }
    else if (unprojectable) { fallbackMapLibre(upReason + ' — mercator-affine draw unsupported'); }
    else {
      navigator.gpu.requestAdapter().then(function (ad) {
        if (!ad) throw new Error('no WebGPU adapter');
        return ad.requestDevice();
      }).then(function (dev) {
        dev.lost.then(function (info) {
          if (mode === 'gpu') {
            try { inner.destroy(); } catch (e) {}
            fallbackMapLibre('WebGPU device lost: ' + ((info && info.reason) || 'unknown'));
          }
        });
        inner = new GpuChartArtifactLayer(map, {
          device: dev,
          canvasFormat: navigator.gpu.getPreferredCanvasFormat(),
          palette: state.palette || undefined,
          resources: state.resources || undefined,
          setMode: setMode
        }, state.artifact);
        setMode('gpu');
        replay();
        publishAtlasStatus();
      }).catch(function (err) {
        fallbackMapLibre('WebGPU init failed: ' + (err && err.message ? err.message : err));
      });
    }

    function call(fn) {
      if (inner) return fn(inner);
      return undefined;
    }

    return {
      load: function (url) {
        var u = url || state.packetUrl;
        return fetch(u, { cache: 'no-cache' })
          .then(function (r) { if (!r.ok) throw new Error('artifact HTTP ' + r.status); return r.json(); })
          .then(function (json) {
            state.artifact = parseArtifactJson(json);
            var r2 = call(function (e) { return e.setArtifact ? e.setArtifact(state.artifact) : true; });
            publishAtlasStatus();
            if (global.HelmChartRendererStatus && global.HelmChartRendererStatus.publish) {
              global.HelmChartRendererStatus.publish();
            }
            return r2 !== false;
          })
          .catch(function (err) {
            console.warn('[chart-artifact] could not load artifact packet:', err && err.message ? err.message : err);
            if (mode === 'gpu') {
              try { inner.destroy(); } catch (e2) {}
              fallbackMapLibre('artifact load failed: ' + (err && err.message ? err.message : err));
            }
            return false;
          });
      },
      setArtifact: function (json) {
        state.artifact = (json && json.vertices && json.indices) ? json : parseArtifactJson(json);
        var r = call(function (e) { return e.setArtifact ? e.setArtifact(state.artifact) : true; });
        publishAtlasStatus();
        return r === undefined ? true : r;
      },
      // WEBGPU-2: switch S-52 display-state palette (day|dusk|night).
      setDisplayState: function (palette) {
        var A = atlas();
        state.palette = A ? A.normalizePalette(palette) : (palette || 'day');
        call(function (e) { if (e.setDisplayState) e.setDisplayState(state.palette); });
        publishAtlasStatus();
        return state.palette;
      },
      getPalette: function () {
        return (inner && inner.getPalette) ? inner.getPalette() : (state.palette || 'day');
      },
      getDiagnostics: function () {
        return (inner && inner.getDiagnostics) ? inner.getDiagnostics() : [];
      },
      setVisible: function (v) {
        state.visible = !!v;
        call(function (e) { if (e.setVisible) e.setVisible(v); });
        if (mode === 'maplibre' && v) setMode('maplibre', global.__helmChartModeReason || 'WebGPU unavailable');
      },
      isVisible: function () {
        if (mode === 'maplibre') return !!state.visible;
        return inner && inner.isVisible ? inner.isVisible() : !!state.visible;
      },
      getArtifact: function () { return state.artifact; },
      getGpuLayer: function () { return inner; },
      pickAtLngLat: function (lngLat) {
        if (!state.artifact || !global.HelmChartArtifactPick) return { pick_id: 0, pixel: null, trace: null };
        var hit = global.HelmChartArtifactPick.pickAtLngLat(state.artifact, lngLat.lng, lngLat.lat);
        return hit;
      },
      destroy: function () { state.destroyed = true; call(function (e) { e.destroy(); }); },
      mode: function () { return mode; }
    };
  }

  HelmChartArtifactAuto._test = {
    SCHEMA: SCHEMA,
    VERTEX_STRIDE: VERTEX_STRIDE,
    mercX: mercX,
    mercY: mercY,
    affineFromProbes: affineFromProbes,
    parseArtifactJson: parseArtifactJson,
    tilePixelToLonLat: tilePixelToLonLat,
    buildViewUniform: buildViewUniform,
    artifactBbox: artifactBbox,
    bboxIntersects: bboxIntersects,
    artifactIntersectsBounds: artifactIntersectsBounds,
    artifactIntersectsMap: artifactIntersectsMap,
    boundsToBbox: boundsToBbox,
    MATERIAL_RGBA: MATERIAL_RGBA
  };
  HelmChartArtifactAuto.GpuLayer = GpuChartArtifactLayer;

  if (typeof module !== 'undefined' && module.exports) module.exports = HelmChartArtifactAuto;
  else global.HelmChartArtifactAuto = HelmChartArtifactAuto;
})(typeof window !== 'undefined' ? window : this);
