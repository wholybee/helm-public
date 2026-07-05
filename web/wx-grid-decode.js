/*
 * Helm — wx-grid-decode.js (WX-33)
 * --------------------------------------------------------------------------
 * Pure decode layer for helm.env.grid.v1: turns verified chunk envelopes
 * (from HelmWxGridPacks.fetchChunk) into physical-value Float32Arrays and
 * assembles per-chunk grids into one tier-wide field ready for GPU upload.
 *
 * No DOM, no GPU, no fetch — everything here is node-testable. All failures
 * carry the contract's diagnostic codes (ENVIRONMENTAL-GRID-V1.md §9); no
 * value is ever invented for missing data (NODATA -> NaN, missing chunk ->
 * reported hole, never a placeholder).
 * --------------------------------------------------------------------------
 */
(function (global) {
  'use strict';

  function loudError(code, message, details) {
    var err = new Error(message || code);
    err.code = code;
    err.details = details || {};
    return err;
  }

  // ---- band decode ---------------------------------------------------------

  // Decode one band's stored values -> physical Float32Array (NaN = nodata).
  // Contract §5: physical = stored * scale + offset; unsupported types fail loud.
  function decodeBand(bytes, offset, count, band, ctx) {
    var type = band.type, scale = +band.scale, off = +band.offset || 0;
    var nodata = band.nodata;
    var out = new Float32Array(count);
    var view = new DataView(bytes.buffer, bytes.byteOffset + offset, count * 2);
    var i, s;
    if (type === 'int16') {
      for (i = 0; i < count; i++) { s = view.getInt16(i * 2, true); out[i] = (s === nodata) ? NaN : s * scale + off; }
    } else if (type === 'uint16') {
      for (i = 0; i < count; i++) { s = view.getUint16(i * 2, true); out[i] = (s === nodata) ? NaN : s * scale + off; }
    } else {
      throw loudError('unsupported_band_type', 'Cannot decode band type ' + type, assign({ bandType: type }, ctx));
    }
    return out;
  }

  function bytesPerSample(type) {
    if (type === 'int16' || type === 'uint16') return 2;
    return null;   // caller fails loud with unsupported_band_type
  }

  function assign(a, b) { for (var k in b) if (b.hasOwnProperty(k)) a[k] = b[k]; return a; }

  // Decode a chunk envelope ({header, payload} — already magic/schema/checksum
  // verified by the transport client) into physical band arrays.
  function decodeChunk(envelope, ctx) {
    var h = envelope.header, payload = envelope.payload;
    ctx = assign({ chunkKey: (ctx && ctx.chunkKey) || null, packId: (ctx && ctx.packId) || null,
                   layer: h.layer, tier: h.tier, validTime: h.validTime }, ctx || {});
    if (h.encoding !== 'helm.env.grid.v1') throw loudError('unsupported_encoding', 'Chunk encoding mismatch', ctx);
    if (h.endianness && h.endianness !== 'little') throw loudError('unsupported_endianness', 'Only little-endian chunks are supported', ctx);
    var comp = h.compression || 'none';
    if (comp !== 'none') {
      // Contract §6: do NOT silently switch source when the codec is unreadable.
      throw loudError('unsupported_compression', 'Cannot decode compression "' + comp + '"', assign({ compression: comp }, ctx));
    }
    var origin = (h.grid && h.grid.origin) || 'northwest';       // absent = pre-pin v1 pack (§6)
    if (origin !== 'northwest') {
      throw loudError('unsupported_grid_origin', 'Cannot decode grid origin "' + origin + '"', assign({ origin: origin }, ctx));
    }
    var g = h.grid || {};
    var w = g.width | 0, ht = g.height | 0;
    if (w <= 0 || ht <= 0) throw loudError('bad_chunk_grid', 'Chunk grid has invalid dimensions', ctx);
    var names = Object.keys(h.bands || {});
    if (!names.length) throw loudError('bad_chunk_bands', 'Chunk declares no bands', ctx);
    var count = w * ht, offset = 0, bands = {};
    var expected = 0;
    for (var i = 0; i < names.length; i++) {
      var bps = bytesPerSample(h.bands[names[i]].type);
      if (bps == null) throw loudError('unsupported_band_type', 'Cannot decode band type ' + h.bands[names[i]].type, ctx);
      expected += count * bps;
    }
    if (payload.byteLength !== expected) {
      throw loudError('bad_payload_length', 'Chunk payload is ' + payload.byteLength + ' bytes, expected ' + expected, ctx);
    }
    for (var j = 0; j < names.length; j++) {                     // band-major, header declaration order
      var band = h.bands[names[j]];
      bands[names[j]] = decodeBand(payload, offset, count, band, ctx);
      offset += count * bytesPerSample(band.type);
    }
    return { header: h, grid: { width: w, height: ht, dx: +g.dx, dy: +g.dy }, bbox: h.bbox, bands: bands };
  }

  // ---- tier assembly --------------------------------------------------------

  // Expected chunk keys for (layer, validTime) from the pack manifest index.
  function chunkKeysFor(manifest, layer, validTime) {
    var vt = compactTime(validTime);
    var keys = [];
    var all = manifest.chunks || {};
    for (var k in all) {
      if (!all.hasOwnProperty(k)) continue;
      var p = k.split('/');                                     // <tier>/<layer>/<validTimeId>/<lon_lat>
      if (p.length >= 4 && p[1] === layer && p[2] === vt) keys.push(k);
    }
    return keys.sort();
  }

  function compactTime(iso) {
    return String(iso).replace(/[-:]/g, '').replace('.000', '');
  }

  // Tier geometry from the manifest (grid registration: row 0 = north edge,
  // col 0 = west edge of coverage; lon wraps for global tiers).
  function tierMeta(manifest, layer) {
    var L = (manifest.layers || {})[layer];
    if (!L) throw loudError('out_of_pack', 'Layer ' + layer + ' is not in this pack', { packId: manifest.packId, layer: layer });
    var tier = (manifest.tiers || {})[L.tier];
    if (!tier) throw loudError('out_of_pack', 'Tier ' + L.tier + ' is not in this pack', { packId: manifest.packId, layer: layer, tier: L.tier });
    var g = tier.grid || {};
    var bbox = (manifest.coverage || {}).bbox || [-180, -90, 180, 90];
    var width = g.width | 0, height = g.height | 0;
    if (!width || !height) {                                    // derive from bbox + resolution when absent
      width = Math.round((bbox[2] - bbox[0]) / g.dx) + ((manifest.coverage || {}).global ? 0 : 1);
      height = Math.round((bbox[3] - bbox[1]) / g.dy) + 1;
    }
    return { tier: L.tier, kind: L.kind || 'scalar', bands: Object.keys(L.bands || {}),
             width: width, height: height, dx: +g.dx, dy: +g.dy,
             west: +bbox[0], south: +bbox[1], east: +bbox[2], north: +bbox[3],
             global: !!(manifest.coverage || {}).global };
  }

  // Assemble decoded chunks into tier-wide Float32Arrays (one per band).
  // Cells not covered by any provided chunk stay NaN, and every expected-but-
  // missing chunk key is reported — the hole is visible, never papered over.
  function assembleTier(manifest, layer, validTime, decoded) {
    var meta = tierMeta(manifest, layer);
    var out = {}, b;
    for (b = 0; b < meta.bands.length; b++) {
      out[meta.bands[b]] = new Float32Array(meta.width * meta.height).fill(NaN);
    }
    var placed = 0;
    for (var i = 0; i < decoded.length; i++) {
      var c = decoded[i];
      if (!c || !c.bbox) continue;
      // chunk bbox = [w, s, e, n]; rows run north -> south from tier north edge
      var col0 = Math.round((c.bbox[0] - meta.west) / meta.dx);
      var row0 = Math.round((meta.north - c.bbox[3]) / meta.dy);
      for (b = 0; b < meta.bands.length; b++) {
        var name = meta.bands[b], src = c.bands[name], dst = out[name];
        if (!src) continue;
        for (var r = 0; r < c.grid.height; r++) {
          var tr = row0 + r;
          if (tr < 0 || tr >= meta.height) continue;
          for (var q = 0; q < c.grid.width; q++) {
            var tc = col0 + q;
            if (meta.global) { tc = ((tc % meta.width) + meta.width) % meta.width; }   // lon wrap
            else if (tc < 0 || tc >= meta.width) continue;
            dst[tr * meta.width + tc] = src[r * c.grid.width + q];
          }
        }
      }
      placed++;
    }
    return { meta: meta, bands: out, chunksPlaced: placed };
  }

  // ---- particle feed --------------------------------------------------------

  // Convert assembled u/v tier fields into the leaflet-velocity JSON the
  // particle engine (window.__helmWind / HelmWindAuto) ingests. unitFactor
  // converts the pack's SI values into the engine's display unit (m/s -> kn
  // for wind/current) — explicit, not a hidden default.
  function toVelocityGrid(assembled, unitFactor) {
    var m = assembled.meta, u = assembled.bands.u, v = assembled.bands.v;
    if (!u || !v) throw loudError('bad_chunk_bands', 'Vector layer is missing u/v bands', { layer: m && m.tier });
    var f = (unitFactor == null ? 1 : +unitFactor);
    var n = m.width * m.height, us = new Array(n), vs = new Array(n);
    for (var i = 0; i < n; i++) {
      us[i] = (u[i] === u[i]) ? u[i] * f : NaN;                 // NaN survives — honest NODATA
      vs[i] = (v[i] === v[i]) ? v[i] * f : NaN;
    }
    var hdr = {
      nx: m.width, ny: m.height,
      lo1: m.west + (m.global ? 0 : 0), la1: m.north,
      lo2: m.global ? m.west + m.dx * (m.width - 1) : m.east, la2: m.south,
      dx: m.dx, dy: m.dy
    };
    return [
      { header: assign({ parameterNumber: 2 }, hdr), data: us },
      { header: assign({ parameterNumber: 3 }, hdr), data: vs }
    ];
  }

  // ---- time bracket ---------------------------------------------------------

  // Pick the two run validTimes straddling `when` for value-lerp (contract §8:
  // interpolate values before colourization). Exact hit or outside range ->
  // single frame (frac 0). Returns { a, b, frac } of ISO times.
  function bracketValidTimes(validTimes, when) {
    var ts = (validTimes || []).slice().sort();
    if (!ts.length) throw loudError('stale_run', 'Pack declares no valid times', {});
    var t = when ? Date.parse(when) : Date.now();
    var prev = ts[0], next = ts[ts.length - 1];
    if (t <= Date.parse(ts[0])) return { a: ts[0], b: ts[0], frac: 0 };
    if (t >= Date.parse(ts[ts.length - 1])) return { a: next, b: next, frac: 0 };
    for (var i = 1; i < ts.length; i++) {
      if (Date.parse(ts[i]) >= t) { prev = ts[i - 1]; next = ts[i]; break; }
    }
    var t0 = Date.parse(prev), t1 = Date.parse(next);
    var frac = t1 > t0 ? (t - t0) / (t1 - t0) : 0;
    if (frac < 0.0001) return { a: prev, b: prev, frac: 0 };
    if (frac > 0.9999) return { a: next, b: next, frac: 0 };
    return { a: prev, b: next, frac: frac };
  }

  // WX-26: non-throwing availability introspection for the drawer (tierMeta throws).
  function layersFor(manifest) {
    return Object.keys((manifest && manifest.layers) || {});
  }

  var API = {
    layersFor: layersFor,
    decodeChunk: decodeChunk,
    decodeBand: decodeBand,
    chunkKeysFor: chunkKeysFor,
    compactTime: compactTime,
    tierMeta: tierMeta,
    assembleTier: assembleTier,
    toVelocityGrid: toVelocityGrid,
    bracketValidTimes: bracketValidTimes,
    loudError: loudError
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  else global.HelmWxGridDecode = API;
})(typeof window !== 'undefined' ? window : this);
