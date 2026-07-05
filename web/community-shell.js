// web/community-shell.js — the "where-to-go / suggest for tonight / give-back" community feature
// + the spacetime "narrate a point" probe, extracted from index.html (CLIENT-26) to keep the shell
// thin. Optional, non-safety (talks to the optional :8090 backend; degrades to local sample offline).
// Interface:  HelmCommunityShell.init(map)  — call once, after the map + DOM exist.
(function () {
  'use strict';
  // Own copies of the shell's CLIENT-18 sinks (untrusted place names / notes reach innerHTML).
  const escHtml = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const safeUrl = u => { try { const x = new URL(u, location.href); return (x.protocol === 'http:' || x.protocol === 'https:') ? x.href : ''; } catch (e) { return ''; } };
  function init(map) {
    if (!window.HelmCommunity) return;
    const comm = HelmCommunity(map);
    window.__helmCommunity = comm;
    const statusEl = document.getElementById('comm-status');
    function setStatus(online) {
      if (!statusEl) return;
      statusEl.textContent = online ? 'Helm backend connected · open + owned + RAG'
        : 'Backend offline — local sample (run backend/: uvicorn main:app --port 8090)';
      statusEl.style.color = online ? 'var(--ok)' : 'var(--warn)';
    }
    comm.onStatus(setStatus);
    comm.health().then(h => { if (h && h.ok) { comm.loadPlaces(); comm.loadSaved(); } });

    const resultsEl = document.getElementById('wt-results');
    function renderResults(j) {
      if (!resultsEl) return;
      if (j.offline) { resultsEl.innerHTML = '<div style="color:var(--warn)">Start the backend for live suggestions.</div>'; return; }
      const recs = j.recommendations || [];
      if (!recs.length) { resultsEl.innerHTML = '<div style="color:var(--cdim)">No suggestions.</div>'; return; }
      resultsEl.innerHTML = recs.map((r, i) => {
        const c = r.confidence, col = c === 'good' ? 'var(--ok)' : c === 'fair' ? 'var(--warn)' : 'var(--cdim)';
        const srcs = (r.sources || []).map(s => s.label).join(' · ');
        return '<div class="wt-card" data-lat="' + r.place.lat + '" data-lon="' + r.place.lon + '" ' +
          'style="border:.5px solid var(--line);border-radius:9px;padding:8px 9px;margin-bottom:7px;cursor:pointer">' +
          '<div style="display:flex;align-items:center;gap:6px"><b style="color:#f5c451">#' + (i + 1) + '</b>' +
          '<span style="font-weight:600;color:var(--ctext);flex:1">' + r.place.name + '</span>' +
          '<span style="font-size:9px;color:' + col + ';border:.5px solid ' + col + ';border-radius:4px;padding:0 4px">' + c + '</span></div>' +
          '<div style="color:#cdd9e3;margin-top:3px;line-height:1.4">' + ((r.reasons || [])[0] || '') + '</div>' +
          '<div style="color:var(--cdim2);font-size:9.5px;margin-top:4px">' + srcs + (r.nfl ? ' · NFL' : '') + ' · ' + r.llm + '</div></div>';
      }).join('');
      resultsEl.querySelectorAll('.wt-card').forEach(el => el.addEventListener('click', () =>
        map.flyTo({ center: [+el.dataset.lon, +el.dataset.lat], zoom: 13 })));
    }
    document.getElementById('wt-go').addEventListener('click', async () => {
      const c = map.getCenter();
      const wd = parseFloat((document.getElementById('nv-winddir') || {}).textContent) || 45;
      const ws = parseFloat((document.getElementById('nv-wind') || {}).textContent) || 15;
      resultsEl.innerHTML = '<div style="color:var(--cdim)">Researching…</div>';
      renderResults(await comm.whereTo({ query: 'Safe spot for tonight near here',
        position: { lat: c.lat, lon: c.lng }, boat: { draft: 1.8 },
        forecast: { windFromDeg: wd, windKt: ws }, top: 3 }));
    });
    document.getElementById('wt-clear').addEventListener('click', () => { comm.clearWhereTo(); resultsEl.innerHTML = ''; });

    const gbStatus = document.getElementById('gb-status'), say = t => { if (gbStatus) gbStatus.textContent = t; };
    document.getElementById('gb-nfl').addEventListener('change', async e => {
      if (!e.target.checked) return say('Position sharing off.');
      const p = window.__helmPos || { lat: map.getCenter().lat, lon: map.getCenter().lng };
      const r = await comm.nflPush({ lat: p.lat, lon: p.lon });
      say(r.offline ? 'Backend offline — would push when connected.' : 'NFL push: ' + r.status + ' (' + r.mode + ').');
    });
    document.getElementById('gb-osm').addEventListener('change', async e => {
      if (!e.target.checked) return say('OSM contribution off.');
      const c = map.getCenter();
      const r = await comm.osmNote({ lat: c.lat, lon: c.lng, text: 'Helm: anchorage/POI note (review).' });
      say(r.offline ? 'Backend offline.' : 'OSM note: ' + r.status + ' (' + r.mode + ').');
    });

    // ---- spacetime probe: arm → tap a point → narrate the fused slice at (lat,lon,t) ----
    let armed = false;
    const armBtn = document.getElementById('narrate-arm'), card = document.getElementById('narrate-card');
    const hint = document.getElementById('narrate-hint');
    function setArmed(on) {
      armed = on; armBtn.classList.toggle('on', on);
      map.getCanvas().classList.toggle('narrate-arm', on);
      map.getCanvas().style.cursor = on ? 'crosshair' : '';
      hint.textContent = on ? 'Tap the chart now…' : 'Tap the chart to fuse every layer at that point & the current time.';
    }
    armBtn.addEventListener('click', () => setArmed(!armed));
    document.getElementById('nc-x').addEventListener('click', () => { card.hidden = true; });

    // selectable layers drive the slice (ADR-0007): only checked layers join the probe
    function enabledLayers() {
      const on = id => { const cb = document.querySelector('.row input[data-layer="' + id + '"]'); return cb ? cb.checked : false; };
      const layers = [];
      if (window.__activeWx && window.__activeWx !== 'off') layers.push('weather');
      if (on('places')) layers.push('places');
      if (on('saved')) layers.push('saved');
      if (on('soundg-text') || on('depare-fill')) layers.push('depth');
      if (on('ais')) layers.push('ais');
      if (on('charts') || on('enc-chart') || on('depare-fill')) layers.push('chart');
      layers.push('climate');                              // contextual, always available
      return layers;
    }

    // probe along the route P(t): sample times by distance/speed, narrate the passage
    function hav(a, b) { const R = 3440.065, r = x => x * Math.PI / 180;
      const dLat = r(b[1] - a[1]), dLon = r(a[0] - b[0]);
      const s = Math.sin(dLat / 2) ** 2 + Math.cos(r(a[1])) * Math.cos(r(b[1])) * Math.sin(dLon / 2) ** 2;
      return R * 2 * Math.asin(Math.sqrt(s)); }
    async function buildPath() {
      let coords = [];
      // Probe the REAL active route from the live `route` source (engine geometry) — not a hardcoded
      // file. No active route → fall back to the boat's current view (honest: there's no passage yet).
      try { const src = map.getSource('route'); const data = src && src.serialize && src.serialize().data;
        const f = data && Array.isArray(data.features) && data.features.find(x => x && x.geometry && x.geometry.type === 'LineString');
        coords = (f && f.geometry && f.geometry.coordinates) || []; } catch (e) {}
      if (coords.length < 2) { const c = map.getCenter(); return [{ lat: c.lat, lon: c.lng, t: window.__helmTime || null }]; }
      const N = coords.length, step = Math.max(1, Math.floor(N / 6)), idx = [];
      for (let i = 0; i < N; i += step) idx.push(i); if (idx[idx.length - 1] !== N - 1) idx.push(N - 1);
      const startT = window.__helmTime ? new Date(window.__helmTime + 'Z') : new Date();
      const spd = 5; let cum = 0; const pts = [];
      idx.forEach((i, k) => { if (k > 0) cum += hav(coords[idx[k - 1]], coords[i]);
        const t = new Date(startT.getTime() + (cum / spd) * 3600 * 1000);
        pts.push({ lat: coords[i][1], lon: coords[i][0], t: t.toISOString().slice(0, 16) }); });
      return pts;
    }
    // wind colour ramp (knots → rgb) — Windy-style, for the ribbon bars
    const windCol = kt => { const S = [[0,[98,113,183]],[10,[52,171,151]],[16,[123,183,80]],[22,[225,200,60]],[30,[232,130,50]],[40,[214,70,74]],[55,[150,60,150]]];
      kt = kt || 0; let a = S[0], b = S[S.length-1];
      for (let i=0;i<S.length-1;i++){ if (kt>=S[i][0] && kt<=S[i+1][0]){ a=S[i]; b=S[i+1]; break; } }
      const f = b[0]===a[0]?0:(kt-a[0])/(b[0]-a[0]); const c=k=>Math.round(a[1][k]+(b[1][k]-a[1][k])*f);
      return 'rgb(' + c(0) + ',' + c(1) + ',' + c(2) + ')'; };
    const ribbon = document.getElementById('ribbon');
    document.getElementById('rb-x').addEventListener('click', () => { ribbon.hidden = true; });
    document.getElementById('narrate-path').addEventListener('click', async () => {
      ribbon.hidden = false;
      document.getElementById('rb-text').textContent = 'Narrating the passage…';
      document.getElementById('rb-legs').innerHTML = '';
      const j = await comm.briefing({ points: await buildPath(), boat: { draft: 1.8 }, layers: enabledLayers() });
      if (j.offline) { document.getElementById('rb-text').textContent = 'Backend offline — run backend/ to narrate the passage.'; return; }
      document.getElementById('rb-prov').textContent = (j.provider || 'ai').toUpperCase();
      document.getElementById('rb-text').textContent = j.narration || '—';
      document.getElementById('rb-legs').innerHTML = (j.legs || []).map(lg => {
        const t = lg.t ? new Date(lg.t + 'Z').toLocaleString([], { weekday: 'short', hour: '2-digit' }) : 'leg ' + lg.leg;
        const kt = lg.windKt, dir = (lg.windFromDeg || 0) + 180;
        const wind = kt == null ? '—' : '<span class="ar" style="transform:rotate(' + dir + 'deg)">↑</span> ' + Math.round(kt);
        const sea = lg.waveM != null ? '〜' + lg.waveM + 'm' : (lg.rainMm ? '🌧' + lg.rainMm : '');
        const h = kt == null ? 0 : Math.min(100, kt * 2.2);
        return '<div class="rb-leg"><div class="t">' + t + '</div><div class="wv">' + wind + '</div>' +
          '<div class="se">' + sea + '</div><div class="bar" style="background:' + windCol(kt) + ';width:' + Math.max(30, h) + '%;margin:6px auto 0"></div></div>';
      }).join('');
    });
    const tierClass = s => ({ open: 't-open', owned: 't-owned', rag: 't-rag', nfl: 't-locked', engine: 't-open', sample: 't-sim', sim: 't-sim' }[s] || 't-open');
    function renderNarrate(j, ll) {
      const txt = document.getElementById('nc-text'), lay = document.getElementById('nc-layers'), foot = document.getElementById('nc-foot');
      if (j.offline) { card.hidden = false; txt.textContent = 'Backend offline — run backend/ (uvicorn main:app --port 8090) to narrate the slice.'; lay.innerHTML = ''; foot.textContent = ''; return; }
      const L = j.layers || {}, pt = j.point || {};
      txt.textContent = j.narration || '—';
      document.getElementById('nc-prov').textContent = (j.provider || 'ai').toUpperCase();
      document.getElementById('nc-pos').textContent = ll.lat.toFixed(3) + ', ' + ll.lng.toFixed(3);
      const when = pt.weatherValidAt || pt.t;
      document.getElementById('nc-ttl').textContent = when
        ? 'Here · ' + new Date(when + 'Z').toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' }) : 'Here · now';
      const w = (L.weather && (L.weather.atTime || L.weather.now)) || null, chips = [];
      if (L.weather && L.weather.error) chips.push(['🌬 wx n/a', 'open']);
      else if (w) chips.push(['🌬 ' + (w.windKt ?? '?') + 'kt @' + (w.windFromDeg ?? '?') + '°', 'open']);
      if (L.weather && L.weather.sea && L.weather.sea.waveM != null) chips.push(['〜 ' + L.weather.sea.waveM + 'm', 'open']);
      if (w && w.rainMm) chips.push(['🌧 ' + w.rainMm + 'mm', 'open']);
      if (w && w.pressureHpa != null) chips.push(['◔ ' + Math.round(w.pressureHpa) + 'hPa', 'open']);
      if (L.weather && L.weather.current && L.weather.current.velKn != null) chips.push(['↝ ' + L.weather.current.velKn + 'kn cur', 'open']);
      if (L.depth && L.depth.nearestChartedM != null) chips.push(['▾ ' + L.depth.nearestChartedM + 'm', 'open']);
      if (L.ais && L.ais.count) chips.push(['⛴ ' + L.ais.count + ' AIS', L.ais.source || 'sample']);
      if (L.places && L.places.length) chips.push(['⚓ ' + L.places[0].name + ' ' + L.places[0].distanceNm + 'NM', L.places[0].source]);
      if (L.climate) chips.push(['☀ climate', 'open']);
      if (L.nfl) chips.push([L.nfl.locked ? '🔒 NFL locked' : 'NFL on', 'nfl']);
      if (L.chart) chips.push(['▦ chart', 'open']);
      lay.innerHTML = chips.map(c => '<span class="nc-chip">' + c[0] + '<span class="t ' + tierClass(c[1]) + '">' + c[1] + '</span></span>').join('');
      const srcs = (j.sources || []).map(s => s.title).filter((v, i, a) => a.indexOf(v) === i).slice(0, 6).join(' · ');
      foot.textContent = (L ? 'Fused ' + Object.keys(L).length + ' layers · ' : '') + srcs + ' · verify on official charts';
      card.hidden = false;
    }
    map.on('click', async (e) => {
      if (!armed) return;
      setArmed(false);
      card.hidden = false;
      document.getElementById('nc-text').textContent = 'Narrating the slice…';
      document.getElementById('nc-layers').innerHTML = '';
      document.getElementById('nc-foot').textContent = '';
      renderNarrate(await comm.narrate({ lat: e.lngLat.lat, lon: e.lngLat.lng,
        t: window.__helmTime || null, boat: { draft: 1.8 }, nflEnabled: false,
        layers: enabledLayers() }), e.lngLat);
    });

    map.on('click', 'saved-icon', e => { const p = e.features[0].properties;
      const _u = safeUrl(p.sourceUrl);
      new window.maplibregl.Popup().setLngLat(e.lngLat).setHTML('<b>★ ' + escHtml(p.name || 'Saved') + '</b><br>' + escHtml(p.note || p.kind) +
        (_u ? '<br><a href="' + escHtml(_u) + '" target="_blank" rel="noopener noreferrer" style="color:#5bc0ff">source ↗</a>' : '')).addTo(map); });
    map.on('click', 'whereto-rank', e => { const p = e.features[0].properties;
      new window.maplibregl.Popup().setLngLat(e.lngLat).setHTML('<b>#' + escHtml(p.rank) + ' ' + escHtml(p.name || '') + '</b><br>confidence: ' + escHtml(p.confidence)).addTo(map); });
    ['saved-icon', 'whereto-rank'].forEach(l => {
      map.on('mouseenter', l, () => map.getCanvas().style.cursor = 'pointer');
      map.on('mouseleave', l, () => map.getCanvas().style.cursor = '');
    });
  }
  window.HelmCommunityShell = { init: init };
}());
