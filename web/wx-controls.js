// wx-controls.js — the unified Weather panel.  WX epic · weather-ux.
// ----------------------------------------------------------------------------------------------
// WX-26: live weather runs ENTIRELY on compact helm.env.grid.v1 packs — discovery via the
// pack-factory release tree (current.json → index.json → manifest), rendering via HelmWxGrid
// (WebGPU model-grid scene), chunk bytes via helm-envd (:8094) or a range-capable origin.
// The prepared-bundle scene (HelmWxScene) and the :8093 gateway are RETIRED — there is no
// gateway fallback, no viewport materialize, no provider call from any gesture. Missing packs,
// layers, chunks or capability FAIL LOUD with the real code and a next action.
// Also orchestrates: GFS-vs-ECMWF ensemble spread (integrations/cog.js, local demo packs) and
// PredictWind GPX/GRIB import (wx-import.js) — both explicit, user-invoked, local.
(function () {
  'use strict';
  var cogP = null;
  function cog() { return cogP || (cogP = import('./integrations/cog.js')); }
  var S = { map: null, model: 'single', els: {}, probeT: null };
  // Release tree base (same-origin static JSON: current.json / releases/…) and the helm-envd
  // chunk endpoint. Chunk bytes CANNOT come from helm-server (no Range support) — envd serves
  // verified whole chunks with CORS. Overrides: window.HELM_WX_PACKS_BASE / HELM_WX_CHUNK_BASE
  // ('' disables the endpoint → raw Range transport, used by e2e against range-capable serve.py).
  var PACKS_BASE = (typeof window !== 'undefined' && window.HELM_WX_PACKS_BASE != null)
    ? window.HELM_WX_PACKS_BASE : 'wx-packs';
  var CHUNK_BASE = (typeof window !== 'undefined' && window.HELM_WX_CHUNK_BASE != null)
    ? window.HELM_WX_CHUNK_BASE : (location.protocol + '//' + location.hostname + ':8094');
  function wxOpacity() { var s = document.getElementById('wxopacity'); return s ? Math.max(0, Math.min(1, (100 - (+s.value)) / 100)) : 0.82; }
  var APPLY_SEQ = 0;

  function activeLayer() { return window.__activeWx || 'off'; }   // weather defaults OFF until the user picks a layer
  function notify(msg, level) {
    var n = document.getElementById('wx-notice'); if (!n) return;
    n.textContent = msg; n.style.display = 'block';
    n.style.color = level === 'warn' ? 'var(--warn,#e8a13a)' : (level === 'ok' ? 'var(--ok,#5fd08a)' : 'var(--cdim,#8aa)');
    n.style.borderColor = level === 'warn' ? 'var(--warn,#e8a13a)' : 'var(--line,#345)';
  }
  function coverageBadge(msg, level) {
    var id = 'helm-wx-coverage-status', el = document.getElementById(id);
    if (!msg) { if (el) { el.textContent = ''; el.style.display = 'none'; } return; }
    if (!el) {
      el = document.createElement('div'); el.id = id;
      el.style.cssText = 'position:fixed;top:122px;left:50%;transform:translateX(-50%);z-index:31;padding:5px 12px;border-radius:13px;background:rgba(20,24,30,.92);border:1px solid var(--warn,#e0a23a);color:var(--warn,#e0a23a);font:600 11px/1.4 system-ui,-apple-system,sans-serif;letter-spacing:.2px;pointer-events:none;box-shadow:0 2px 10px rgba(0,0,0,.4)';
      document.body.appendChild(el);
    }
    el.textContent = msg; el.style.display = 'block';
    el.style.borderColor = level === 'ok' ? 'var(--ok,#5fd08a)' : 'var(--warn,#e0a23a)';
    el.style.color = level === 'ok' ? 'var(--ok,#5fd08a)' : 'var(--warn,#e0a23a)';
  }

  // Fail-loud message discipline (pinned by unit + e2e tests): the REAL code, the reason,
  // and the standing promise that nothing was silently substituted.
  function failLoudText(layer, code, detail) {
    var bits = ['Live ' + layer + ' unavailable', code || 'weather_pack_unavailable'];
    if (detail) bits.push(detail);
    bits.push('no gateway/direct fallback/download');
    return bits.join(' · ');
  }
  function failLiveUnavailable(layer, err) {
    var code = (err && err.code) || 'weather_pack_unavailable';
    var reason = (err && err.message) || 'no installed weather pack';
    var action = err && err.details && err.details.action;
    var msg = failLoudText(layer, code, reason + (action ? ' — ' + action : ''));
    // Capability failures keep the loaded DATA (nothing rendered; the probe can still read
    // the pack). Data failures tear down so a previous layer can't linger under a warning.
    if (code !== 'unsupported_renderer_capability') {
      try { if (window.HelmWxGrid) HelmWxGrid.disable(); } catch (e) {}
    }
    coverageBadge('⚠ ' + layer + ' unavailable — ' + reason, 'warn');
    notify(msg, 'warn');
    setProbe('<span style="color:var(--warn,#e8a13a)">' + msg + '</span>');
  }

  // Post-enable honesty: stale packs and partial frames surface on the badge; a healthy
  // scene clears it. Pure function of HelmWxGrid.status() — no fetches, no rechecks.
  function healthBadge(layer) {
    if (!window.HelmWxGrid) return;
    var st = HelmWxGrid.status();
    if (!st || st.state !== 'on') return;
    var partial = (st.diagnostics || []).some(function (d) { return d.code === 'partial_frame' || d.code === 'no_vector_data'; });
    if (partial) return coverageBadge('⚠ ' + layer + ' — pack has data holes (see console diagnostics)', 'warn');
    if (st.ageSeconds != null && st.ageSeconds > 24 * 3600) {
      return coverageBadge('⚠ ' + layer + ' forecast ' + Math.round(st.ageSeconds / 3600) + ' h old — bake a fresh pack', 'warn');
    }
    var times = st.validTimes || [];
    if (times.length && Date.parse(times[times.length - 1]) < Date.now()) {
      return coverageBadge('⚠ ' + layer + ' — forecast horizon passed (showing last frame) — bake a fresh pack', 'warn');
    }
    var c = st.coverage, m = S.map;
    if (c && !c.global && m) {
      var ctr = m.getCenter();
      var lon = ctr.lng - 360 * Math.floor((ctr.lng - c.west) / 360);
      var e = c.east < c.west ? c.east + 360 : c.east;
      if (ctr.lat < c.south || ctr.lat > c.north || lon < c.west || lon > e) {
        return coverageBadge('⚠ ' + layer + ' — view outside installed pack (' + (c.tier || 'pack') + ')', 'warn');
      }
    }
    coverageBadge('');
  }

  async function apply() {
    var seq = ++APPLY_SEQ;
    var map = S.map; if (!map) return;                  // guard: setWeather()'s hook can fire before build() sets S.map
    var layer = activeLayer(), m;
    try { m = await cog(); }
    catch (e) {                                          // a dead dynamic import must not be a silent dead click
      notify('weather module failed to load (integrations/cog.js): ' + (e.message || e), 'warn');
      throw e;
    }
    if (seq !== APPLY_SEQ) return;
    m.disableEnsemble(map); m.disableWxTiles(map);
    if (layer === 'off') {
      try { if (window.HelmWxGrid) HelmWxGrid.disable(); } catch (e) {}
      coverageBadge(''); setProbe(''); return;
    }

    if (S.model === 'ensemble') {
      try { if (window.HelmWxGrid) HelmWxGrid.disable(); } catch (e) {}
      // GFS-vs-ECMWF spread. Live two-model needs a connection; offline we show the committed demo
      // pack (Key West), clearly labelled — bake your area for a local ensemble.
      try {
        var idx = await fetch('data/wxtiles/ensemble.json').then(function (r) { return r.ok ? r.json() : null; });
        var pair = idx && idx.pairs && (idx.pairs[layer] || idx.pairs.wind);
        if (pair) {
          var mem = Object.keys(pair.members);
          await m.enableEnsemble(map, { maplibregl: window.maplibregl,
            manifestA: 'data/wxtiles/' + pair.members[mem[0]].manifest, manifestB: 'data/wxtiles/' + pair.members[mem[1]].manifest,
            labelA: mem[0].toUpperCase(), labelB: mem[1].toUpperCase(), layer: layer, beforeId: 'route-line', opacity: 0.85, notify: notify, frame: 6 });
          notify('Ensemble spread · GFS vs ECMWF (demo pack — bake your area for local)', 'ok');
        } else notify('No ensemble pack — run pipeline/make_value_tiles.py --demo-ensemble', 'warn');
      } catch (e) { notify('ensemble unavailable: ' + (e.message || e), 'warn'); }
      probeSoon();
      return;
    }

    // WX-26 live path: compact grid packs ONLY. Discovery walks the release tree; enable
    // renders straight from numeric chunks. Re-applying with the same pack+layer reuses the
    // scene's cached frames (identity-keyed) — no teardown thrash on layer re-selection.
    if (!window.HelmWxGrid || !window.HelmWxGridPacks) {
      failLiveUnavailable(layer, { code: 'unsupported_renderer_capability', message: 'grid renderer modules missing' });
      return;
    }
    try {
      var ctr = map.getCenter();
      var disc = await HelmWxGridPacks.discoverPack(PACKS_BASE, layer, { lat: ctr.lat, lng: ctr.lng });
      if (seq !== APPLY_SEQ) return;
      var st = await HelmWxGrid.enable(map, {
        manifestUrl: disc.manifestUrl, layer: layer, opacity: wxOpacity(),
        when: window.__helmTime || undefined,
        transport: CHUNK_BASE ? { chunkEndpoint: CHUNK_BASE } : null
      });
      if (seq !== APPLY_SEQ) { setTimeout(function () { if (activeLayer() === layer) apply().catch(function () {}); }, 0); return; }
      notify('Live ' + layer + ' · ' + (disc.pack.tier || 'grid') + ' pack · ' + disc.releaseId, 'ok');
      healthBadge(layer);
      if (window.HelmWxTime && HelmWxTime.sync) HelmWxTime.sync(st.validTimes || []);   // time scrubber (index.html)
      probeSoon();
    } catch (e) {
      if (seq !== APPLY_SEQ) return;
      failLiveUnavailable(layer, e);
    }
  }

  function setProbe(html) { if (S.els.probe) S.els.probe.innerHTML = html || '<span style="color:var(--cdim,#8aa)">move the map to read a value</span>'; }
  function probeSoon() { clearTimeout(S.probeT); S.probeT = setTimeout(function () { probe().catch(function () {}); }, 250); }
  async function probe() {
    var map = S.map; if (!map) return;
    var c = map.getCenter(), m = await cog(), layer = activeLayer();
    if (layer === 'off') return setProbe('');
    var s = null;
    if (S.model === 'ensemble') { var e = await m.sampleEnsemble(c.lat, c.lng); if (e && e.value != null) return setProbe('<b>' + e.mean + ' ' + e.unit + '</b> · spread ' + e.spread + ' · ' + e.agreement); }
    else if (window.HelmWxGrid && HelmWxGrid.status().state === 'on') {
      s = await HelmWxGrid.sample(c.lat, c.lng);        // WX-26: grid-pack sampler (same values the GPU draws)
    }
    if (s && s.value != null) return setProbe('<b>' + s.value + ' ' + s.unit + '</b> @ centre · ' + (s.sourceRef ? s.sourceRef.title : s.source));
    setProbe('');
  }

  function build(drawer, map) {
    S.map = map;
    var box = document.createElement('div');
    box.id = 'wx-plus';
    box.style.cssText = 'margin-top:12px;border-top:.5px solid var(--line,#2a3540);padding-top:11px';
    function segctl(opts) {
      var w = document.createElement('div'); w.style.cssText = 'display:flex;border:.5px solid var(--line,#345);border-radius:8px;overflow:hidden;margin-bottom:10px';
      opts.forEach(function (o) {
        var b = document.createElement('button'); b.dataset.val = o.val; b.textContent = o.txt; b.title = o.title || o.txt;
        b.style.cssText = 'flex:1;font-size:12px;padding:7px;border:0;background:transparent;color:var(--cdim,#8aa);cursor:pointer';
        b.addEventListener('mouseenter', function () { if (b.dataset.sel !== '1') b.style.background = 'rgba(255,255,255,.04)'; });
        b.addEventListener('mouseleave', function () { b.style.background = b.dataset.sel === '1' ? 'var(--accent,#39c2c9)' : 'transparent'; });
        w.appendChild(b);
      });
      return w;
    }
    function paintSeg(w, on) { Array.prototype.forEach.call(w.children, function (b) { var sel = b.dataset.val === on; b.dataset.sel = sel ? '1' : ''; b.style.background = sel ? 'var(--accent,#39c2c9)' : 'transparent'; b.style.color = sel ? '#05121d' : 'var(--cdim,#8aa)'; b.style.fontWeight = sel ? '600' : '400'; }); }

    // Model control is hidden for now — hardcoded Single via the S default. Built (not appended)
    // so the paint/handler lines stay valid; to expose the toggle again, re-append modSeg here.
    var modSeg = segctl([{ val: 'single', txt: 'Single' }, { val: 'ensemble', txt: 'Ensemble spread' }]);

    var probe = document.createElement('div');
    probe.style.cssText = 'font-size:12px;background:rgba(255,255,255,.03);border:.5px solid var(--line,#345);border-radius:8px;padding:8px 10px;margin-bottom:10px;min-height:16px';
    box.appendChild(probe); S.els.probe = probe;

    var imp = document.createElement('div');
    imp.style.cssText = 'border:.5px dashed var(--line,#456);border-radius:8px;padding:8px 10px';
    imp.innerHTML = '<div style="font-size:12px;margin-bottom:4px"><span style="vertical-align:1px">⤓</span> Import PredictWind GPX / GRIB</div>' +
      '<div style="font-size:11px;color:var(--cdim,#8aa);margin-bottom:6px">device-local · never synced</div>';
    var file = document.createElement('input'); file.type = 'file'; file.accept = '.gpx,.grb,.grb2,.grib,.grib2'; file.style.cssText = 'font-size:11px;color:#cdd9e3;width:100%';
    file.addEventListener('change', function () { if (file.files && file.files[0] && window.HelmImport) { window.HelmImport.importFile(file.files[0], map, notify); } file.value = ''; });
    imp.appendChild(file); box.appendChild(imp);

    // insert after the transparency row (#wxopacity), before the legend
    var anchor = drawer.querySelector('#wxopacity');
    anchor = anchor ? (anchor.closest('.row') || anchor) : null;
    if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(box, anchor.nextSibling);
    else drawer.appendChild(box);

    paintSeg(modSeg, S.model);
    modSeg.addEventListener('click', function (e) { var b = e.target.closest('button'); if (!b) return; S.model = b.dataset.val; paintSeg(modSeg, S.model); apply().catch(function () {}); });
    setProbe('');

    // Transparency slider drives the grid scene + ensemble tiles (index.html wires the particles).
    var op = document.getElementById('wxopacity');
    if (op) {
      var applyTileOpacity = function () {
        if (window.HelmWxGrid && HelmWxGrid.setOpacity) HelmWxGrid.setOpacity(wxOpacity());   // alpha only — colour untouched
        cog().then(function (m) { if (m.setWxOpacity) m.setWxOpacity(S.map, wxOpacity()); }).catch(function () {});
      };
      op.addEventListener('input', applyTileOpacity);
    }
    // Particle checkbox re-applies so the grid scene re-feeds/hides the engine honestly.
    var pc = document.getElementById('particles');
    if (pc) pc.addEventListener('change', function () { if (activeLayer() !== 'off') apply().catch(function () {}); });

    // View changes: probe refresh + HONESTY badge only (stale/holes/outside-pack). No coverage
    // chasing, no re-pick, no fetch of any kind from pan/zoom — the pack covers what it covers.
    var viewT = null;
    function viewChanged() {
      probeSoon();
      var layer = activeLayer();
      if (!layer || layer === 'off' || layer === 'radar') return;
      clearTimeout(viewT);
      viewT = setTimeout(function () { healthBadge(layer); }, 140);
    }
    map.on('moveend', viewChanged);
    map.on('zoomend', viewChanged);
    // Engage live weather ON LOAD if a layer is already active.
    setTimeout(function () { if (activeLayer() !== 'off') apply().catch(function () {}); }, 150);
  }

  // Exposed so the shell's setWeather() can re-engage the current mode when the active layer changes
  // programmatically (not via a drawer click) — keeps Live tracking the active layer.
  window.HelmWxControls = { apply: function () { apply().catch(function () {}); },
    _test: { failLoudText: failLoudText, healthBadge: healthBadge } };

  function boot() {
    var drawer = document.getElementById('drawer-weather');
    if (!window.map || !drawer) return setTimeout(boot, 300);
    if (document.getElementById('wx-plus')) return;        // already built
    build(drawer, window.map);
  }
  if (document.readyState === 'complete' || document.readyState === 'interactive') setTimeout(boot, 400);
  else window.addEventListener('DOMContentLoaded', function () { setTimeout(boot, 400); });
})();
