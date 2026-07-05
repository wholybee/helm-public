(function () {
  'use strict';

  function loudError(code, message, details) {
    var err = new Error(message || code);
    err.code = code;
    err.details = details || {};
    return err;
  }

  function manifestBase(url) {
    return new URL(url, window.location.href);
  }

  function packUrl(manifest, manifestUrl) {
    var transport = manifest && manifest.transport || {};
    var raw = transport.packUrl || transport.url || transport.pmtilesUrl;
    if (!raw) throw loudError('missing_pack_url', 'Environmental grid manifest has no packUrl', { packId: manifest && manifest.packId });
    return new URL(raw, manifestBase(manifestUrl)).href;
  }

  function bytesToHex(bytes) {
    return Array.prototype.map.call(bytes, function (b) { return b.toString(16).padStart(2, '0'); }).join('');
  }

  async function sha256Hex(bytes) {
    if (!window.crypto || !window.crypto.subtle) {
      throw loudError('unsupported_checksum', 'SHA-256 verification is unavailable in this client');
    }
    var digest = await window.crypto.subtle.digest('SHA-256', bytes);
    return bytesToHex(new Uint8Array(digest));
  }

  function getChunk(manifest, chunkKey) {
    var chunks = manifest && manifest.chunks || {};
    var chunk = chunks[chunkKey];
    if (!chunk) {
      throw loudError('missing_chunk', 'Environmental grid chunk is missing from the pack index', {
        packId: manifest && manifest.packId,
        chunkKey: chunkKey
      });
    }
    if (!Array.isArray(chunk.byteRange) || chunk.byteRange.length !== 2) {
      throw loudError('missing_range', 'Environmental grid chunk has no byte range', {
        packId: manifest && manifest.packId,
        chunkKey: chunkKey
      });
    }
    return chunk;
  }

  function parseEnvelope(bytes, chunkKey) {
    var view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    var magic = new TextDecoder().decode(bytes.slice(0, 8));
    if (magic !== 'HELMGRID') throw loudError('bad_chunk_magic', 'Environmental grid chunk has invalid magic', { chunkKey: chunkKey });
    var version = view.getUint16(8, true);
    if (version !== 1) throw loudError('unsupported_chunk_version', 'Unsupported environmental grid chunk version', { chunkKey: chunkKey, version: version });
    var headerLen = view.getUint32(12, true);
    var headerStart = 16;
    var headerEnd = headerStart + headerLen;
    if (headerEnd > bytes.byteLength) throw loudError('truncated_chunk_header', 'Environmental grid chunk header is truncated', { chunkKey: chunkKey });
    var header = JSON.parse(new TextDecoder().decode(bytes.slice(headerStart, headerEnd)));
    if (header.schema !== 'helm.env.grid.chunk.v1') throw loudError('bad_chunk_schema', 'Environmental grid chunk schema mismatch', { chunkKey: chunkKey });
    return { header: header, payload: bytes.slice(headerEnd) };
  }

  async function fetchManifest(url) {
    var resp = await fetch(url, { cache: 'no-store' });
    if (!resp.ok) throw loudError('missing_manifest', 'Environmental grid manifest could not be loaded', { url: url, status: resp.status });
    var manifest = await resp.json();
    if (manifest.schema !== 'helm.env.grid.pack.v1' || manifest.encoding !== 'helm.env.grid.v1') {
      throw loudError('unsupported_manifest', 'Unsupported environmental grid manifest', { url: url, schema: manifest.schema, encoding: manifest.encoding });
    }
    return manifest;
  }

  // WX-26: two transports, both checksum-verified CLIENT-SIDE (defense in depth):
  //   Range mode (default)  — raw byte range on transport.packUrl; needs a range-capable
  //                           origin (serve.py, :8091-style pack servers).
  //   Endpoint mode         — opts.chunkEndpoint = helm-envd base (e.g. http://host:8094);
  //                           GET /chunk?pack=&chunk= — envd byte-slices and validates
  //                           server-side; used live because helm-server has no Range.
  async function fetchChunk(manifest, manifestUrl, chunkKey, opts) {
    var chunk = getChunk(manifest, chunkKey);
    var offset = Number(chunk.byteRange[0]);
    var length = Number(chunk.byteRange[1]);
    if (!Number.isFinite(offset) || !Number.isFinite(length) || offset < 0 || length <= 0) {
      throw loudError('missing_range', 'Environmental grid chunk byte range is invalid', { chunkKey: chunkKey, byteRange: chunk.byteRange });
    }
    var endpoint = opts && opts.chunkEndpoint;
    var resp;
    if (endpoint) {
      var chunkHref = String(endpoint).replace(/\/$/, '') + '/chunk?pack=' +
        encodeURIComponent(manifest.packId) + '&chunk=' + encodeURIComponent(chunkKey);
      try {
        resp = await fetch(chunkHref);
      } catch (netErr) {
        throw loudError('envd_unreachable',
          'helm-envd is not running (' + endpoint + ')',
          { chunkKey: chunkKey, action: 'start it: scripts/start-helm.sh --weather (or ~/.helm/wx-packs/refresh.sh)' });
      }
      if (!resp.ok) {
        var detail = null;
        try { detail = await resp.json(); } catch (e) {}
        throw loudError((detail && detail.error) || 'missing_chunk',
          'helm-envd refused the chunk (HTTP ' + resp.status + ')',
          { chunkKey: chunkKey, status: resp.status, envd: detail });
      }
    } else {
      resp = await fetch(packUrl(manifest, manifestUrl), {
        // Default cache mode: HTTP caches do not key on the Range header, so
        // 'force-cache' could replay one chunk's bytes for another range.
        headers: { Range: 'bytes=' + offset + '-' + (offset + length - 1) }
      });
      if (!(resp.status === 206 || resp.status === 200)) {
        throw loudError('missing_range', 'Environmental grid chunk byte range could not be loaded', { chunkKey: chunkKey, status: resp.status });
      }
    }
    var bytes = new Uint8Array(await resp.arrayBuffer());
    if (bytes.byteLength !== length) {
      throw loudError('missing_range', 'Environmental grid chunk byte range returned the wrong length', {
        chunkKey: chunkKey,
        expected: length,
        actual: bytes.byteLength
      });
    }
    var checksum = String(chunk.checksum || '');
    if (!checksum.startsWith('sha256:')) throw loudError('missing_checksum', 'Environmental grid chunk has no SHA-256 checksum', { chunkKey: chunkKey });
    var actual = await sha256Hex(bytes);
    if (actual !== checksum.slice(7)) throw loudError('checksum_mismatch', 'Environmental grid chunk checksum mismatch', { chunkKey: chunkKey });
    return parseEnvelope(bytes, chunkKey);
  }

  // ---- WX-26 release discovery -------------------------------------------------
  // Walk the pack-factory release tree: <base>/current.json -> releases/<id>/index.json
  // -> pick a pack for (layer, view centre). Every miss is LOUD with what was missing.

  function lonIn(west, east, lon) {
    if (east < west) east += 360;                               // wrapped bbox
    var l = lon - 360 * Math.floor((lon - west) / 360);         // into [west, west+360)
    return l >= west && l <= east;
  }

  // Pure + unit-testable: choose the best pack for a layer at a view centre.
  // Preference: has layer -> coverage contains centre -> higher-res tier (route-high
  // before global-low) -> newest run. Returns null when nothing has the layer.
  function pickPack(release, layer, center) {
    var packs = (release && release.packs) || [];
    var withLayer = packs.filter(function (p) { return (p.layers || []).indexOf(layer) >= 0; });
    if (!withLayer.length) return null;
    function covers(p) {
      var b = p.coverage && p.coverage.bbox;
      if (!b || (p.coverage && p.coverage.global)) return true;
      if (!center) return true;
      return center.lat >= b[1] && center.lat <= b[3] && lonIn(b[0], b[2], center.lng);
    }
    function rank(p) {
      var tier = String(p.tier || p.profile || '');
      var tierRank = tier === 'route-high' ? 0 : tier === 'global-low' ? 1 : 2;
      return (covers(p) ? 0 : 10) + tierRank;
    }
    withLayer.sort(function (a, b) { return rank(a) - rank(b); });
    var best = withLayer[0];
    if (!covers(best)) {
      // nothing with this layer covers the view — honest miss, not a silent global stretch
      return { miss: true, pack: best, reason: 'no installed pack covers this view', layer: layer };
    }
    return { miss: false, pack: best };
  }

  async function fetchJson(url, code, what) {
    var resp = await fetch(url, { cache: 'no-store' });
    if (!resp.ok) throw loudError(code, what + ' could not be loaded (HTTP ' + resp.status + ')', { url: url, status: resp.status });
    return resp.json();
  }

  // Resolve {manifestUrl, pack, releaseId} for (layer, centre) from a release base URL.
  async function discoverPack(base, layer, center) {
    // base may be relative ('wx-packs') or absolute — anchor it to the page origin first;
    // a relative URL base throws in the URL constructor.
    var absBase = new URL(String(base).replace(/\/$/, '') + '/', window.location.href).href;
    var current = await fetchJson(absBase + 'current.json', 'missing_release', 'weather release pointer');
    if (!current.indexUrl) throw loudError('missing_release', 'release pointer has no indexUrl', { base: absBase });
    var indexUrl = new URL(current.indexUrl, absBase).href;
    var release = await fetchJson(indexUrl, 'missing_release', 'weather release index');
    var picked = pickPack(release, layer, center);
    if (!picked) {
      throw loudError('out_of_pack', 'no installed weather pack contains layer ' + layer, {
        layer: layer, releaseId: current.releaseId,
        available: (release.packs || []).map(function (p) { return { packId: p.packId, layers: p.layers }; }),
        action: 'bake the layer: scripts/wx_bake_openmeteo.py --layers ' + layer
      });
    }
    if (picked.miss) {
      throw loudError('out_of_pack', picked.reason, {
        layer: layer, releaseId: current.releaseId, packId: picked.pack.packId,
        coverage: picked.pack.coverage, action: 'bake a pack anchored on this area'
      });
    }
    var releaseDir = indexUrl.replace(/\/index\.json$/, '');
    return {
      manifestUrl: new URL(picked.pack.manifestUrl, releaseDir + '/').href,
      pack: picked.pack,
      releaseId: current.releaseId,
      generatedAt: release.generatedAt || current.generatedAt
    };
  }

  window.HelmWxGridPacks = {
    fetchManifest: fetchManifest,
    fetchChunk: fetchChunk,
    discoverPack: discoverPack,
    pickPack: pickPack,
    loudError: loudError
  };
}());
