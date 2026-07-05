/*
 * Helm — chart-inspector.js (INSPECT-2)
 * Object inspection card for helm.inspect.trace.v1 round trips from chart picks.
 */
(function (global) {
  'use strict';

  var esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c];
    });
  };

  function row(label, value) {
    if (value == null || value === '') return '';
    return '<div class="helm-chart-inspect-row"><span>' + esc(label) + '</span><span>' + esc(value) + '</span></div>';
  }

  function attrsHtml(attrs) {
    if (!attrs || !attrs.length) return '';
    return attrs.map(function (a) {
      return row(a.code, a.value);
    }).join('');
  }

  function traceHtml(trace) {
    if (!trace) return '<p>No inspection trace.</p>';
    var res = trace.resolution || {};
    var src = trace.source || {};
    var pres = trace.presentation || {};
    var draw = trace.draw_record || {};
    var raster = trace.raster_fallback || {};
    var kind = res.kind || 'unknown';
    var title = kind === 'vector_feature'
      ? (src.object_class || 'Chart object')
      : (kind === 'raster_fallback' ? 'Raster pixels' : 'No object');

    var html = [
      '<div class="helm-chart-inspect">',
      '<h3>' + esc(title) + '</h3>',
      '<p class="helm-chart-inspect-kind">' + esc(kind.replace(/_/g, ' ')) +
        (res.feature_metadata_available ? ' · feature metadata available' : ' · no per-feature metadata') + '</p>'
    ];

    if (kind === 'no_hit') {
      html.push('<p>No nautical primitive hit at this pixel.</p></div>');
      return html.join('');
    }

    if (raster.active && raster.message) {
      html.push('<p class="helm-chart-inspect-warn">' + esc(raster.message) + '</p>');
    }

    html.push('<div class="helm-chart-inspect-grid">');
    html.push(row('Source chart', src.source_chart_id));
    html.push(row('Edition', src.source_chart_edition));
    html.push(row('Update', src.source_update));
    if (src.source_feature_id) html.push(row('Feature id', src.source_feature_id));
    if (src.object_class) html.push(row('Object class', src.object_class));
    html.push(row('Presentation', pres.presentation_authority + ' / ' + (pres.presentation_rule_id || '—')));
    html.push(row('Primitive', draw.primitive_id || draw.command_id));
    html.push(row('Artifact', draw.artifact_id));
    html.push(row('Backend', (trace.pick && trace.pick.backend) || '—'));
    html.push(row('Resolution', kind));
    html.push(attrsHtml(src.attributes));
    html.push('</div>');

    if (trace.warnings && trace.warnings.length) {
      html.push('<p class="helm-chart-inspect-warn">' + esc(trace.warnings.join(' ')) + '</p>');
    }
    html.push('</div>');
    return html.join('');
  }

  function installStyle() {
    if (document.getElementById('helm-chart-inspect-style')) return;
    var st = document.createElement('style');
    st.id = 'helm-chart-inspect-style';
    st.textContent = [
      '.helm-chart-inspect{max-width:360px;font-size:14px;color:#e6eef5}',
      '.helm-chart-inspect h3{margin:0 0 6px;font-size:16px}',
      '.helm-chart-inspect-kind{margin:0 0 10px;color:#9eb4c8;font-size:12px}',
      '.helm-chart-inspect-grid{display:grid;gap:4px}',
      '.helm-chart-inspect-row{display:flex;justify-content:space-between;gap:12px}',
      '.helm-chart-inspect-row span:first-child{color:#9eb4c8}',
      '.helm-chart-inspect-warn{color:#f5c451;font-size:12.5px;margin:8px 0 0}'
    ].join('');
    document.head.appendChild(st);
  }

  function HelmChartInspector(opts) {
    opts = opts || {};
    var map = opts.map;
    var chartLayer = opts.chartLayer;
    var pickApi = global.HelmChartArtifactPick;
    var provenance = null;
    var provenanceUrl = opts.provenanceUrl || 'data/chart-fixture-provenance.json';
    var queryEnabled = opts.queryEnabled !== false;
    var lastTrace = null;
    var dragging = false;
    var suppressClickUntil = 0;
    var dragSuppressMs = opts.dragSuppressMs == null ? 400 : +opts.dragSuppressMs;

    function loadProvenance() {
      return fetch(provenanceUrl, { cache: 'no-cache' })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (j) { provenance = j; return j; })
        .catch(function () { provenance = null; return null; });
    }

    function chartMode() {
      return chartLayer && chartLayer.mode ? chartLayer.mode() : 'unknown';
    }

    function artifactReady() {
      return chartLayer && chartLayer.getArtifact && chartLayer.getArtifact();
    }

    function resolveArtifactPick(lngLat) {
      var art = artifactReady();
      if (!art || !pickApi) return null;
      var hit = pickApi.pickAtLngLat(art, lngLat.lng, lngLat.lat);
      if (!hit.pick_id) return null;
      return pickApi.buildInspectionTrace({
        artifact: art,
        pick_id: hit.pick_id,
        pixel: hit.pixel || [0, 0],
        backend: chartMode(),
        provenance: provenance || {}
      });
    }

    function fetchServerPick(lngLat) {
      if (!queryEnabled || !map || !pickApi) return Promise.resolve(null);
      var z = map.getZoom ? Math.round(map.getZoom()) : 12;
      var url = '/query?lat=' + encodeURIComponent(lngLat.lat) +
        '&lon=' + encodeURIComponent(lngLat.lng) + '&z=' + z + '&radius=8';
      return fetch(url)
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (j) {
          if (!j) return null;
          return pickApi.buildTraceFromServerQuery(j, {
            backend: chartMode() === 'gpu' ? 'enc-query-fallback' : 'enc-query'
          });
        })
        .catch(function () { return null; });
    }

    function resolvePick(lngLat) {
      if (chartMode() === 'gpu') {
        var artifactTrace = resolveArtifactPick(lngLat);
        if (artifactTrace) return Promise.resolve(artifactTrace);
        return fetchServerPick(lngLat);
      }
      return fetchServerPick(lngLat);
    }

    function maybeQuery(trace, lngLat) {
      if (!queryEnabled || !trace || trace.resolution.kind !== 'vector_feature') {
        return Promise.resolve(trace);
      }
      if (trace.source && trace.source.attributes && trace.source.attributes.length) {
        return Promise.resolve(trace);
      }
      var z = map && map.getZoom ? Math.round(map.getZoom()) : 12;
      var url = '/query?lat=' + encodeURIComponent(lngLat.lat) +
        '&lon=' + encodeURIComponent(lngLat.lng) + '&z=' + z + '&radius=8';
      return fetch(url)
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (j) { return j ? pickApi.enrichTraceAttributes(trace, j) : trace; })
        .catch(function () { return trace; });
    }

    function shouldSuppressClick() {
      if (dragging) return true;
      if (suppressClickUntil && Date.now() < suppressClickUntil) return true;
      if (map && map.isMoving && map.isMoving()) return true;
      return false;
    }

    function showCard(trace, lngLat, point) {
      installStyle();
      lastTrace = trace;
      if (!map || !global.maplibregl) return;
      var anchor = 'left';
      try {
        if (point && point.x > (window.innerWidth || 1280) * 0.55) anchor = 'right';
      } catch (e) {}
      new maplibregl.Popup({ closeButton: true, closeOnClick: true, maxWidth: '380px', anchor: anchor, offset: [12, 0] })
        .setLngLat(lngLat)
        .setHTML(traceHtml(trace))
        .addTo(map);
      try { global.__helmChartInspectTrace = trace; } catch (e) {}
    }

    function onDragStart() { dragging = true; }

    function onDragEnd() {
      dragging = false;
      suppressClickUntil = Date.now() + dragSuppressMs;
    }

    function onMapClick(e) {
      if (global.__helmMeasure && global.__helmMeasure.active && global.__helmMeasure.active()) return;
      if (shouldSuppressClick()) return;
      if (!chartLayer || !chartLayer.isVisible || !chartLayer.isVisible()) return;
      resolvePick(e.lngLat)
        .then(function (trace) {
          if (!trace || trace.resolution.kind === 'no_hit') return null;
          return maybeQuery(trace, e.lngLat);
        })
        .then(function (trace) {
          if (trace) showCard(trace, e.lngLat, e.point);
        });
    }

    return {
      init: function () {
        if (!map) return;
        loadProvenance();
        map.on('click', onMapClick);
        map.on('dragstart', onDragStart);
        map.on('dragend', onDragEnd);
      },
      destroy: function () {
        if (!map) return;
        map.off('click', onMapClick);
        map.off('dragstart', onDragStart);
        map.off('dragend', onDragEnd);
      },
      resolvePick: resolveArtifactPick,
      resolvePickAsync: resolvePick,
      showCard: showCard,
      lastTrace: function () { return lastTrace; },
      traceHtml: traceHtml
    };
  }

  HelmChartInspector._test = { traceHtml: traceHtml, esc: esc };
  if (typeof module !== 'undefined' && module.exports) module.exports = HelmChartInspector;
  else global.HelmChartInspector = HelmChartInspector;
})(typeof window !== 'undefined' ? window : this);
