/*
 * Helm — chart-renderer-status.js (INTEGRATE-1)
 * Visible debug/status surface for the WebGPU nautical artifact renderer path.
 * Publishes window.__helmChartRendererStatus with active renderer, fallback reason,
 * artifact schema/epoch/cache freshness, and feature-flag state. No silent fallback.
 */
(function (global) {
  'use strict';

  var STATUS_SCHEMA = 'helm.chart_renderer_status.v1';
  var listeners = [];

  function featureFlagState() {
    var env = global.HELM_CHART_WEBGPU;
    var ls = null;
    try { ls = global.localStorage.getItem('helmChartWebgpu'); } catch (e) {}
    // INTEGRATE-1: PNG enc-chart stays default. Opt in via HELM_CHART_WEBGPU=true,
    // localStorage helmChartWebgpu=1, or ?chartWebgpu=1 on the cockpit URL.
    var enabled = (env === true || ls === '1');
    try {
      var qp = new URLSearchParams(global.location && global.location.search || '');
      if (qp.get('chartWebgpu') === '1') enabled = true;
      if (qp.get('chartWebgpu') === '0') enabled = false;
    } catch (e) {}
    return { env: env, localStorage: ls, enabled: enabled };
  }

  function artifactBlock(art) {
    if (!art) return null;
    var cache = art.cache || {};
    var checksums = art.checksums || {};
    return {
      schema_version: art.schema_version || '',
      artifact_id: art.artifact_id || '',
      source_model_id: art.source_model_id || '',
      source_epoch: art.source_epoch || cache.chart_epoch || '',
      chart_epoch: cache.chart_epoch || '',
      invalidation_epoch: cache.invalidation_epoch || '',
      rebuild_policy: cache.rebuild_policy || '',
      backend_target: cache.backend_target || '',
      packet_sha256: checksums.packet_sha256 || ''
    };
  }

  function schedulerBlock() {
    var s = global.__helmChartScheduler;
    if (!s) return null;
    return {
      cache_epoch: (s.response && s.response.cache_epoch) || '',
      visible_tiles: (s.response && s.response.totals && s.response.totals.visible) || 0,
      cache_size: (s.cache && s.cache.size) || 0,
      strict_missing: !!s.strictMissing
    };
  }

  function snapshot() {
    var mode = global.__helmChartMode || 'off';
    var reason = global.__helmChartModeReason || '';
    var art = global.__helmChartArtifact && global.__helmChartArtifact.getArtifact
      ? global.__helmChartArtifact.getArtifact() : null;
    return {
      schema: STATUS_SCHEMA,
      updated_at: new Date().toISOString(),
      feature_flag: featureFlagState(),
      active_renderer: mode === 'gpu' ? 'webgpu' : (mode === 'maplibre' ? 'maplibre' : mode),
      fallback_reason: mode === 'maplibre' ? reason : '',
      fallback_paths: {
        maplibre_enc: 'enc-chart MapLibre raster layer',
        server_png: 'GET /chart/{z}/{x}/{y}.png'
      },
      artifact: artifactBlock(art),
      atlas: global.__helmChartAtlas || null,
      scheduler: schedulerBlock(),
      sched2_enabled: !!global.__helmChartSchedulerBlend
    };
  }

  function publish() {
    global.__helmChartRendererStatus = snapshot();
    listeners.forEach(function (fn) {
      try { fn(global.__helmChartRendererStatus); } catch (e) {}
    });
    updateBadge();
    updateSettings();
  }

  function shortSha(v) {
    if (!v) return '';
    return v.length > 16 ? v.slice(0, 16) + '…' : v;
  }

  function updateBadge() {
    var el = global.document && global.document.getElementById('chart-renderer-badge');
    var txt = global.document && global.document.getElementById('chart-renderer-badge-txt');
    if (!el || !txt) return;
    var st = global.__helmChartRendererStatus || snapshot();
    var active = st.active_renderer;
    el.hidden = false;
    el.classList.remove('live', 'sim', 'simpos', 'lost');
    if (active === 'webgpu') {
      el.classList.add('live');
      txt.textContent = 'WEBGPU';
      el.title = 'WebGPU artifact renderer active · schema ' +
        ((st.artifact && st.artifact.schema_version) || 'unknown');
    } else {
      el.classList.add('sim');
      txt.textContent = 'ENC';
      el.title = 'MapLibre ENC fallback' +
        (st.fallback_reason ? ' — ' + st.fallback_reason : '') +
        (st.artifact && st.artifact.chart_epoch ? ' · epoch ' + st.artifact.chart_epoch : '');
    }
  }

  function updateSettings() {
    var host = global.document && global.document.getElementById('chart-renderer-settings-host');
    if (!host || !host.dataset.mounted) return;
    var st = global.__helmChartRendererStatus || snapshot();
    var art = st.artifact || {};
    var rows = [
      ['Active renderer', st.active_renderer],
      ['Fallback reason', st.fallback_reason || '(none — primary path active)'],
      ['Artifact schema', art.schema_version || 'not loaded'],
      ['Chart epoch', art.chart_epoch || 'not reported'],
      ['Invalidation epoch', art.invalidation_epoch || 'not reported'],
      ['Packet SHA-256', shortSha(art.packet_sha256) || 'not loaded'],
      ['Scheduler cache', st.scheduler ? String(st.scheduler.cache_size) + ' entries' : 'not active']
    ];
    var detail = host.querySelector('.cr-detail');
    if (detail) {
      detail.innerHTML = rows.map(function (r) {
        return '<div class="cr-row"><span>' + r[0] + '</span><span>' + r[1] + '</span></div>';
      }).join('');
    }
  }

  function mountSettings(host) {
    if (!host || host.dataset.mounted) return;
    host.dataset.mounted = '1';
    var flag = featureFlagState();
    host.innerHTML =
      '<label class="conn-chk"><input type="checkbox" id="chart-renderer-flag"' +
      (flag.enabled ? ' checked' : '') + '> WebGPU nautical renderer (opt-in \u00b7 PNG ENC is default)</label>' +
      '<div class="cr-detail" style="margin-top:8px;font-size:11px;color:var(--cdim)"></div>';
    var cb = host.querySelector('#chart-renderer-flag');
    if (cb) {
      cb.addEventListener('change', function () {
        try {
          global.localStorage.setItem('helmChartWebgpu', cb.checked ? '1' : '0');
        } catch (e) {}
        global.location.reload();
      });
    }
    updateSettings();
  }

  function mountBadge() {
    updateBadge();
  }

  function on(event, fn) {
    if (event === 'update' && typeof fn === 'function') listeners.push(fn);
  }

  global.HelmChartRendererStatus = {
    STATUS_SCHEMA: STATUS_SCHEMA,
    snapshot: snapshot,
    publish: publish,
    featureFlagState: featureFlagState,
    mountSettings: mountSettings,
    mountBadge: mountBadge,
    on: on
  };

  publish();
  if (typeof setInterval !== 'undefined') setInterval(publish, 2500);
})(typeof window !== 'undefined' ? window : this);
