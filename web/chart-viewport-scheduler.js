/*
 * Helm — chart-viewport-scheduler.js (SCHED-1 browser port / SCHED-2 client)
 * Deterministic tile math only — parity with pipeline/viewport_scheduler.py.
 */
(function (global) {
  'use strict';

  var REQUEST_SCHEMA = 'helm.render.schedule.request.v1';
  var RESPONSE_SCHEMA = 'helm.render.schedule.response.v1';
  var WEB_MERCATOR_LAT_LIMIT = 85.05112878;
  var DEFAULT_TILE_SIZE_PX = 256;

  function ScheduleError(message) {
    this.name = 'ScheduleError';
    this.message = message;
  }
  ScheduleError.prototype = Object.create(Error.prototype);

  function clampLat(lat) {
    return Math.max(-WEB_MERCATOR_LAT_LIMIT, Math.min(WEB_MERCATOR_LAT_LIMIT, lat));
  }

  function clampLon(lon) {
    return Math.max(-180, Math.min(180, lon));
  }

  function deg2num(lon, lat, z) {
    lat = clampLat(lat);
    var n = Math.pow(2, z);
    var x = Math.floor((lon + 180) / 360 * n);
    var y = Math.floor((1 - Math.asinh(Math.tan(lat * Math.PI / 180)) / Math.PI) / 2 * n);
    return [Math.max(0, Math.min(n - 1, x)), Math.max(0, Math.min(n - 1, y))];
  }

  function num2bbox(z, x, y) {
    var n = Math.pow(2, z);
    var west = x / n * 360 - 180;
    var east = (x + 1) / n * 360 - 180;
    var north = Math.atan(Math.sinh(Math.PI * (1 - 2 * y / n))) * 180 / Math.PI;
    var south = Math.atan(Math.sinh(Math.PI * (1 - 2 * (y + 1) / n))) * 180 / Math.PI;
    return [west, south, east, north];
  }

  function tileKey(tile) {
    return [+tile.z, +tile.x, +tile.y];
  }

  function normalizeCacheKey(parts) {
    return Object.keys(parts).sort().map(function (key) {
      return key + '=' + parts[key];
    }).join(';');
  }

  function buildCacheKey(opts) {
    var renderer = opts.renderer || {};
    var tile = opts.tile || {};
    var parts = {
      display_fp: opts.display_fingerprint || '',
      overscan: String(opts.overscan_px || 16),
      renderer: String(renderer.backend || 'vulkan'),
      scene_schema: String(renderer.scene_schema || 'helm.render.model.v1'),
      source_epoch: opts.source_epoch || '',
      x: String(tile.x),
      y: String(tile.y),
      z: String(tile.z)
    };
    if (renderer.renderer_sha) parts.renderer_sha = String(renderer.renderer_sha);
    return normalizeCacheKey(parts);
  }

  function buildCacheEpoch(sourceEpoch, request) {
    var renderer = (request && request.renderer) || {};
    var sceneSchema = String(renderer.scene_schema || 'helm.render.model.v1');
    var displayFp = String((request && request.display_fingerprint) || '');
    return sourceEpoch + ':' + sceneSchema + ':' + displayFp;
  }

  function anchorTile(visible) {
    var anchor = visible.anchor_tile;
    if (anchor && anchor.z != null && anchor.x != null && anchor.y != null) {
      return { z: +anchor.z, x: +anchor.x, y: +anchor.y };
    }
    var center = visible.center || {};
    if (center.lon != null && center.lat != null) {
      var z = +visible.z || 0;
      var xy = deg2num(+center.lon, +center.lat, z);
      return { z: z, x: xy[0], y: xy[1] };
    }
    throw new ScheduleError('visible requires anchor_tile or center+z');
  }

  function visibleTiles(visible) {
    var z = +visible.z || 0;
    var viewport = visible.viewport_px || [DEFAULT_TILE_SIZE_PX, DEFAULT_TILE_SIZE_PX];
    if (!Array.isArray(viewport) || viewport.length !== 2) {
      throw new ScheduleError('visible.viewport_px must be [width, height]');
    }
    var widthPx = +viewport[0];
    var heightPx = +viewport[1];
    var dpr = +(visible.device_pixel_ratio || 1);
    var anchor = anchorTile(visible);
    var bbox = num2bbox(anchor.z, anchor.x, anchor.y);
    var west = bbox[0], south = bbox[1], east = bbox[2], north = bbox[3];
    var tileW = (east - west) / DEFAULT_TILE_SIZE_PX;
    var tileH = (north - south) / DEFAULT_TILE_SIZE_PX;
    var halfWDeg = (widthPx * dpr * tileW) / 2;
    var halfHDeg = (heightPx * dpr * tileH) / 2;
    var center = visible.center || {};
    var lon = (center.lon != null) ? +center.lon : (west + east) / 2;
    var lat = (center.lat != null) ? +center.lat : (south + north) / 2;
    var viewBbox = [
      clampLon(lon - halfWDeg),
      clampLat(lat - halfHDeg),
      clampLon(lon + halfWDeg),
      clampLat(lat + halfHDeg)
    ];
    var tiles = {};
    var p0 = deg2num(viewBbox[0], viewBbox[3], z);
    var p1 = deg2num(viewBbox[2], viewBbox[1], z);
    for (var x = Math.min(p0[0], p1[0]); x <= Math.max(p0[0], p1[0]); x++) {
      for (var y = Math.min(p0[1], p1[1]); y <= Math.max(p0[1], p1[1]); y++) {
        tiles[z + ',' + x + ',' + y] = [z, x, y];
      }
    }
    var out = Object.keys(tiles).map(function (k) { return tiles[k]; });
    if (!out.length) out.push(tileKey(anchor));
    return out;
  }

  function ringTiles(anchor, ring) {
    var z = +anchor.z, x0 = +anchor.x, y0 = +anchor.y;
    var n = Math.pow(2, z);
    var out = {};
    for (var dx = -ring; dx <= ring; dx++) {
      for (var dy = -ring; dy <= ring; dy++) {
        if (dx === 0 && dy === 0) continue;
        var x = (x0 + dx) % n;
        if (x < 0) x += n;
        var y = Math.max(0, Math.min(n - 1, y0 + dy));
        out[z + ',' + x + ',' + y] = [z, x, y];
      }
    }
    return Object.keys(out).map(function (k) { return out[k]; });
  }

  function adjacentZoomTiles(anchor, zoomPolicy) {
    var offsets = zoomPolicy.adjacent_offsets || [];
    if (!Array.isArray(offsets)) throw new ScheduleError('zoom_policy.adjacent_offsets must be a list');
    var z = +anchor.z, x = +anchor.x, y = +anchor.y;
    var out = [];
    for (var i = 0; i < offsets.length; i++) {
      var delta = +offsets[i];
      if (!Number.isFinite(delta)) throw new ScheduleError('zoom_policy.adjacent_offsets must contain integers');
      var targetZ = z + delta;
      if (targetZ < 0) continue;
      if (delta < 0 && zoomPolicy.include_parent !== false) {
        out.push([{ z: targetZ, x: Math.floor(x / 2), y: Math.floor(y / 2) }, 0.5]);
      }
      if (delta > 0 && zoomPolicy.include_children !== false) {
        var baseX = x * 2, baseY = y * 2;
        out.push([{ z: targetZ, x: baseX, y: baseY }, 0.25]);
        out.push([{ z: targetZ, x: baseX + 1, y: baseY }, 0.25]);
        out.push([{ z: targetZ, x: baseX, y: baseY + 1 }, 0.25]);
        out.push([{ z: targetZ, x: baseX + 1, y: baseY + 1 }, 0.25]);
      }
    }
    return out;
  }

  function roleStalePolicy(role, intent) {
    if (role === 'visible') return 'strict';
    if (role === 'overscan') return intent === 'revalidate' ? 'strict' : 'stale_while_revalidate';
    return 'stale_ok';
  }

  function priorityForRole(role) {
    var table = { visible: 0, overscan: 10, neighbor: 20, zoom_adjacent: 30, prefetch: 40 };
    return Object.prototype.hasOwnProperty.call(table, role) ? table[role] : 50;
  }

  function entryId(tile, role) {
    return 'tile.z' + tile.z + '.x' + tile.x + '.y' + tile.y + '.' + role;
  }

  function tileSetKey(tuple) {
    return tuple[0] + ',' + tuple[1] + ',' + tuple[2];
  }

  function buildScheduleResponse(request, opts) {
    opts = opts || {};
    if (request.schema !== REQUEST_SCHEMA) throw new ScheduleError('schema must be ' + REQUEST_SCHEMA);
    if (!request.visible || typeof request.visible !== 'object') throw new ScheduleError('visible is required');
    var overscan = request.overscan || {};
    var neighborPolicy = request.neighbor_policy || {};
    var zoomPolicy = request.zoom_policy || {};
    var renderer = request.renderer || {};
    var intent = String(request.intent || 'visible');
    var displayFp = String(request.display_fingerprint || '');
    var marginPx = +(overscan.margin_px || 16);
    var marginTiles = +(overscan.margin_tiles || 1);
    var ringCount = +(neighborPolicy.ring_count || 1);
    var epoch = opts.source_epoch || String(request.source_epoch_hint || '');
    if (!epoch) throw new ScheduleError('source_epoch is required');

    var anchor = anchorTile(request.visible);
    var visibleSet = {};
    visibleTiles(request.visible).forEach(function (t) { visibleSet[tileSetKey(t)] = t; });
    var overscanSet = {};
    for (var ring = 1; ring <= marginTiles; ring++) {
      ringTiles(anchor, ring).forEach(function (t) {
        var k = tileSetKey(t);
        if (!visibleSet[k]) overscanSet[k] = t;
      });
    }
    var neighborSet = {};
    if (ringCount > marginTiles) {
      for (var r = marginTiles + 1; r <= ringCount; r++) {
        ringTiles(anchor, r).forEach(function (t) {
          var k = tileSetKey(t);
          if (!visibleSet[k] && !overscanSet[k]) neighborSet[k] = t;
        });
      }
    }

    var entries = [];
    function addEntry(tuple, role, blendWeight) {
      var tile = { z: tuple[0], x: tuple[1], y: tuple[2] };
      entries.push({
        entry_id: entryId(tile, role),
        kind: 'tile',
        role: role,
        priority: priorityForRole(role),
        tile: tile,
        overscan_px: marginPx,
        cache_key: buildCacheKey({
          renderer: renderer,
          source_epoch: epoch,
          tile: tile,
          display_fingerprint: displayFp,
          overscan_px: marginPx
        }),
        stale_policy: roleStalePolicy(role, intent),
        blend_weight: blendWeight == null ? 1 : blendWeight
      });
    }

    Object.keys(visibleSet).sort().forEach(function (k) { addEntry(visibleSet[k], 'visible', 1); });
    Object.keys(overscanSet).sort().forEach(function (k) { addEntry(overscanSet[k], 'overscan', 1); });
    Object.keys(neighborSet).sort().forEach(function (k) { addEntry(neighborSet[k], 'neighbor', 1); });
    adjacentZoomTiles(anchor, zoomPolicy).forEach(function (pair) {
      addEntry(tileKey(pair[0]), 'zoom_adjacent', pair[1]);
    });

    entries.sort(function (a, b) {
      if (a.priority !== b.priority) return a.priority - b.priority;
      var ta = tileKey(a.tile), tb = tileKey(b.tile);
      if (ta[0] !== tb[0]) return ta[0] - tb[0];
      if (ta[1] !== tb[1]) return ta[1] - tb[1];
      if (ta[2] !== tb[2]) return ta[2] - tb[2];
      if (a.role !== b.role) return a.role < b.role ? -1 : 1;
      return a.entry_id < b.entry_id ? -1 : (a.entry_id > b.entry_id ? 1 : 0);
    });

    return {
      schema: RESPONSE_SCHEMA,
      request_id: String(request.request_id || ''),
      source_epoch: epoch,
      cache_epoch: buildCacheEpoch(epoch, request),
      entries: entries,
      totals: {
        entries: entries.length,
        visible: entries.filter(function (e) { return e.role === 'visible'; }).length,
        overscan: entries.filter(function (e) { return e.role === 'overscan'; }).length,
        neighbor: entries.filter(function (e) { return e.role === 'neighbor'; }).length,
        zoom_adjacent: entries.filter(function (e) { return e.role === 'zoom_adjacent'; }).length
      },
      diagnostics: []
    };
  }

  function buildScheduleRequestFromMap(map, opts) {
    opts = opts || {};
    var canvas = map.getCanvas();
    var center = map.getCenter();
    var z = Math.max(0, Math.min(22, Math.round(map.getZoom())));
    var dpr = Math.min(global.devicePixelRatio || 1, 2);
    return {
      schema: REQUEST_SCHEMA,
      request_id: opts.request_id || ('sched-' + Date.now()),
      intent: opts.intent || 'visible',
      visible: {
        projection: 'web_mercator_tile',
        z: z,
        center: { lon: center.lng, lat: center.lat },
        viewport_px: [canvas.clientWidth || 256, canvas.clientHeight || 256],
        device_pixel_ratio: dpr,
        rotation_deg: map.getBearing ? map.getBearing() : 0
      },
      overscan: opts.overscan || { margin_px: 16, margin_tiles: 1 },
      neighbor_policy: opts.neighbor_policy || { cardinal: true, diagonal: true, ring_count: 1 },
      zoom_policy: opts.zoom_policy || { adjacent_offsets: [-1, 1], include_children: true, include_parent: true },
      display_fingerprint: opts.display_fingerprint || 'day:standard:10:5:10:20:text:on:soundings:on',
      source_epoch_hint: opts.source_epoch || 'synthetic-chart-1@2026-06-28',
      client_epoch: opts.client_epoch || 0,
      renderer: opts.renderer || {
        backend: 'vulkan',
        scene_schema: 'helm.render.model.v1',
        renderer_sha: opts.renderer_sha || 'fixture-renderer-sha'
      }
    };
  }

  function tileViewport(z, x, y) {
    var bbox = num2bbox(z, x, y);
    return {
      west: bbox[0],
      south: bbox[1],
      east: bbox[2],
      north: bbox[3],
      pixel_width: DEFAULT_TILE_SIZE_PX,
      pixel_height: DEFAULT_TILE_SIZE_PX,
      tile: { z: z, x: x, y: y }
    };
  }

  function sha256Json(payload) {
    if (global.crypto && global.crypto.subtle) {
      throw new Error('sha256Json sync helper requires Node test shim');
    }
    return '';
  }

  var api = {
    REQUEST_SCHEMA: REQUEST_SCHEMA,
    RESPONSE_SCHEMA: RESPONSE_SCHEMA,
    ScheduleError: ScheduleError,
    deg2num: deg2num,
    num2bbox: num2bbox,
    buildCacheKey: buildCacheKey,
    buildCacheEpoch: buildCacheEpoch,
    buildScheduleResponse: buildScheduleResponse,
    buildScheduleRequestFromMap: buildScheduleRequestFromMap,
    tileViewport: tileViewport,
    sha256Json: sha256Json
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.HelmChartViewportScheduler = api;
})(typeof window !== 'undefined' ? window : this);
