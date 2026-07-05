/*
 * Helm — chart-artifact-pick.js (INSPECT-2)
 * CPU pick-buffer resolution and helm.inspect.trace.v1 trace assembly from
 * helm.render.artifact.v1 packets + vulkan.provenance.v0 tables.
 */
(function (global) {
  'use strict';

  var TRACE_SCHEMA = 'helm.inspect.trace.v1';
  var VERTEX_STRIDE = 4;

  function pointInTri(px, py, ax, ay, bx, by, cx, cy) {
    var d = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
    if (Math.abs(d) < 1e-12) return false;
    var a = ((by - cy) * (px - cx) + (cx - bx) * (py - cy)) / d;
    var b = ((cy - ay) * (px - cx) + (ax - cx) * (py - cy)) / d;
    var c = 1 - a - b;
    return a >= 0 && b >= 0 && c >= 0;
  }

  function distToSeg(px, py, ax, ay, bx, by) {
    var dx = bx - ax, dy = by - ay;
    var len2 = dx * dx + dy * dy;
    if (len2 < 1e-12) return Math.hypot(px - ax, py - ay);
    var t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
    return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
  }

  function vertexXY(vertices, vi) {
    var o = vi * VERTEX_STRIDE;
    return { x: vertices[o], y: vertices[o + 1] };
  }

  function batchHitsPixel(artifact, batch, px, py) {
    var verts = artifact.vertices;
    var inds = artifact.indices;
    var topo = batch.topology || 'triangles';
    var threshold = topo === 'line_list' ? 0.75 : (topo === 'points' ? 1.25 : 0);
    for (var i = 0; i < batch.index_count; i++) {
      var idx = inds[batch.first_index + i];
      if (topo === 'triangles' && i + 2 < batch.index_count) {
        var ia = inds[batch.first_index + i];
        var ib = inds[batch.first_index + i + 1];
        var ic = inds[batch.first_index + i + 2];
        var a = vertexXY(verts, ia), b = vertexXY(verts, ib), c = vertexXY(verts, ic);
        if (pointInTri(px, py, a.x, a.y, b.x, b.y, c.x, c.y)) return true;
        i += 2;
      } else if (topo === 'line_list' && i + 1 < batch.index_count) {
        var la = vertexXY(verts, inds[batch.first_index + i]);
        var lb = vertexXY(verts, inds[batch.first_index + i + 1]);
        if (distToSeg(px, py, la.x, la.y, lb.x, lb.y) <= threshold) return true;
        i += 1;
      } else if (topo === 'points') {
        var p = vertexXY(verts, idx);
        if (Math.hypot(px - p.x, py - p.y) <= threshold) return true;
      }
    }
    return false;
  }

  function lngLatToTilePixel(viewport, lng, lat) {
    if (!viewport) return null;
    var pw = viewport.pixel_width || 1;
    var ph = viewport.pixel_height || 1;
    if (lng < viewport.west || lng > viewport.east || lat < viewport.south || lat > viewport.north) return null;
    return {
      x: ((lng - viewport.west) / (viewport.east - viewport.west)) * pw,
      y: ((viewport.north - lat) / (viewport.north - viewport.south)) * ph
    };
  }

  function pickRecordById(artifact, pickId) {
    var recs = artifact.pick_records || [];
    for (var i = 0; i < recs.length; i++) {
      if (+recs[i].pick_id === +pickId) return recs[i];
    }
    return null;
  }

  function pickRecordForBatch(artifact, batch) {
    var pid = (batch.primitive_ids && batch.primitive_ids[0]) || '';
    var recs = artifact.pick_records || [];
    for (var i = 0; i < recs.length; i++) {
      if (recs[i].primitive_id === pid) return recs[i];
    }
    return null;
  }

  function provenanceForHandles(provenanceTable, handles) {
    if (!provenanceTable || !handles) return null;
    for (var i = 0; i < handles.length; i++) {
      var h = handles[i];
      if (h.indexOf('provenance:') !== 0) continue;
      var id = h.slice('provenance:'.length);
      for (var j = 0; j < provenanceTable.length; j++) {
        if (provenanceTable[j].provenance_id === id) return provenanceTable[j];
      }
    }
    return null;
  }

  function materialForCommand(artifact, commandId) {
    var mats = artifact.material_table || [];
    var needle = 'mat.' + commandId;
    for (var i = 0; i < mats.length; i++) {
      if (mats[i].material_id === needle) return mats[i];
    }
    return null;
  }

  function isRasterPrimitive(rec, prov) {
    var cls = (prov && prov.source_object_class) || '';
    return cls === 'RASTER' || (rec && rec.primitive_id && rec.primitive_id.indexOf('raster') >= 0);
  }

  function buildInspectionTrace(opts) {
    opts = opts || {};
    var artifact = opts.artifact;
    var pickId = opts.pick_id;
    var pixel = opts.pixel || [0, 0];
    var backend = opts.backend || 'cpu-pick';
    var provenanceDoc = opts.provenance || {};
    var provTable = provenanceDoc.provenance_table || [];

    if (!artifact) throw new Error('artifact required');

    if (!pickId) {
      return {
        schema_version: TRACE_SCHEMA,
        trace_id: 'inspect.' + (artifact.artifact_id || 'unknown') + '.no-hit',
        pick: {
          pixel: pixel,
          device_pixel_ratio: 1,
          viewport_id: 'fixture.' + (provenanceDoc.fixture_id || 'chart-1'),
          backend: backend,
          scene_id: artifact.source_model_id || artifact.artifact_id || '',
          model_id: artifact.source_model_id || ''
        },
        resolution: { kind: 'no_hit', feature_metadata_available: false },
        raster_fallback: { active: false, sidecar_metadata_available: false },
        inspection_handles: [],
        warnings: []
      };
    }

    var rec = pickRecordById(artifact, pickId);
    if (!rec) throw new Error('unknown pick_id ' + pickId);
    var prov = provenanceForHandles(provTable, rec.inspection_handles);
    var mat = materialForCommand(artifact, rec.primitive_id);
    var raster = isRasterPrimitive(rec, prov);
    var commandId = rec.primitive_id;
    var provenanceRef = prov ? prov.provenance_id : null;

    var trace = {
      schema_version: TRACE_SCHEMA,
      trace_id: 'inspect.' + (artifact.artifact_id || 'artifact') + '.pick-' + pickId,
      pick: {
        pixel: [Math.round(pixel[0]), Math.round(pixel[1])],
        device_pixel_ratio: 1,
        viewport_id: 'fixture.' + (provenanceDoc.fixture_id || 'chart-1'),
        backend: backend,
        scene_id: artifact.source_model_id || '',
        model_id: artifact.source_model_id || ''
      },
      resolution: {
        kind: raster ? 'raster_fallback' : 'vector_feature',
        feature_metadata_available: !raster
      },
      draw_record: {
        draw_record_id: 'draw.' + commandId,
        command_id: commandId,
        command_type: mat ? mat.style_key : '',
        primitive_id: 'prim.' + commandId,
        primitive_kind: mat ? mat.shader_family : '',
        artifact_id: artifact.artifact_id || '',
        layer_id: 'layer.webgpu-artifact',
        provenance_refs: provenanceRef ? [provenanceRef] : []
      },
      presentation: {
        presentation_authority: raster ? 'fixture' : 's52',
        presentation_rule_id: prov ? ('rule.' + (prov.source_object_class || '')) : '',
        material_id: mat ? mat.material_id : '',
        style_key: mat ? mat.style_key : '',
        conversion_stage: prov ? prov.conversion_stage : ''
      },
      source: {
        source_chart_id: prov ? prov.source_chart_id : '',
        source_chart_edition: prov ? prov.source_chart_edition : '',
        source_update: prov ? prov.source_update : '',
        source_feature_id: raster ? null : (prov ? prov.source_object_id : null),
        object_class: prov ? prov.source_object_class : null,
        attributes: [],
        source_geometry_hash: prov ? prov.source_geometry_hash : '',
        transform_chain: prov ? (prov.transform_chain || []) : [],
        quilt_decision_id: prov ? prov.quilt_decision_id : ''
      },
      raster_fallback: {
        active: raster,
        reason: raster ? 'raster_debug_placeholder' : null,
        message: raster
          ? ((prov && prov.warnings && prov.warnings[0]) ||
             'Raster packs contain pixels only; object inspection is unavailable unless a sidecar metadata layer is present.')
          : null,
        sidecar_metadata_available: false,
        sidecar_name: null
      },
      inspection_handles: rec.inspection_handles || [],
      warnings: prov && prov.warnings ? prov.warnings.slice() : []
    };
    return trace;
  }

  function pickAtTilePixel(artifact, px, py) {
    if (!artifact) return 0;
    var batches = (artifact.draw_batches || []).slice().sort(function (a, b) {
      return (+b.order_bucket || 0) - (+a.order_bucket || 0);
    });
    for (var i = 0; i < batches.length; i++) {
      if (!batchHitsPixel(artifact, batches[i], px, py)) continue;
      var rec = pickRecordForBatch(artifact, batches[i]);
      if (rec && rec.pick_id) return +rec.pick_id;
    }
    return 0;
  }

  function pickAtLngLat(artifact, lng, lat) {
    var px = lngLatToTilePixel(artifact.viewport, lng, lat);
    if (!px) return { pick_id: 0, pixel: null };
    var pickId = pickAtTilePixel(artifact, px.x, px.y);
    return { pick_id: pickId, pixel: [px.x, px.y] };
  }

  function queryHits(queryJson) {
    if (!queryJson) return [];
    if (Array.isArray(queryJson)) return queryJson;
    return queryJson.hits || queryJson.features || [];
  }

  function attributesFromQueryHit(hit) {
    var attrs = (hit && (hit.attributes || hit.properties)) || {};
    return Object.keys(attrs).map(function (k) {
      var v = attrs[k];
      var decoded = (v && typeof v === 'object' && v.decoded != null) ? String(v.decoded) : String(v);
      return { code: k.trim(), value: decoded };
    });
  }

  function buildTraceFromServerQuery(queryJson, opts) {
    opts = opts || {};
    var hits = queryHits(queryJson);
    if (!hits.length) return null;
    var hit = hits[0];
    var backend = opts.backend || 'enc-query';
    return {
      schema_version: TRACE_SCHEMA,
      trace_id: 'inspect.enc-query.' + (hit.acronym || hit.objl_code || 'hit'),
      pick: {
        pixel: [0, 0],
        device_pixel_ratio: 1,
        viewport_id: 'server-enc',
        backend: backend,
        scene_id: 'enc-chart',
        model_id: ''
      },
      resolution: { kind: 'vector_feature', feature_metadata_available: true },
      draw_record: {
        command_id: hit.acronym || '—',
        primitive_id: hit.geometry || '—',
        artifact_id: 'enc-chart',
        layer_id: 'layer.enc-chart'
      },
      presentation: {
        presentation_authority: 's52',
        presentation_rule_id: hit.acronym ? ('rule.' + hit.acronym) : ''
      },
      source: {
        source_chart_id: hit.chart_id || null,
        source_chart_edition: hit.edition || hit.source_edition || null,
        object_class: hit.acronym || hit.class_desc || null,
        attributes: attributesFromQueryHit(hit)
      },
      raster_fallback: { active: false, sidecar_metadata_available: false },
      inspection_handles: [],
      warnings: []
    };
  }

  function enrichTraceAttributes(trace, queryJson) {
    if (!queryJson || !trace || trace.resolution.kind !== 'vector_feature') return trace;
    if (trace.source && trace.source.attributes && trace.source.attributes.length) return trace;
    var hits = queryHits(queryJson);
    if (!hits.length) return trace;
    var hit = hits[0];
    trace.source = trace.source || {};
    trace.source.attributes = attributesFromQueryHit(hit);
    if (hit.class_desc && !trace.source.object_class) trace.source.object_class = hit.class_desc;
    if (hit.acronym && !trace.source.object_class) trace.source.object_class = hit.acronym;
    if (hit.edition || hit.source_edition) {
      trace.source.source_chart_edition = String(hit.edition || hit.source_edition);
    }
    trace.warnings = trace.warnings || [];
    if (!Array.isArray(queryJson) && (queryJson.freshness || queryJson.edition)) {
      trace.freshness = queryJson.freshness || { edition: queryJson.edition };
    }
    return trace;
  }

  var api = {
    TRACE_SCHEMA: TRACE_SCHEMA,
    VERTEX_STRIDE: VERTEX_STRIDE,
    lngLatToTilePixel: lngLatToTilePixel,
    pickAtTilePixel: pickAtTilePixel,
    pickAtLngLat: pickAtLngLat,
    pickRecordById: pickRecordById,
    buildInspectionTrace: buildInspectionTrace,
    buildTraceFromServerQuery: buildTraceFromServerQuery,
    queryHits: queryHits,
    enrichTraceAttributes: enrichTraceAttributes,
    provenanceForHandles: provenanceForHandles
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.HelmChartArtifactPick = api;
})(typeof window !== 'undefined' ? window : this);
