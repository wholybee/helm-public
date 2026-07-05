// TOOLS-2: cursor coordinate readout with persisted DMS / DM.m / decimal formats.
(function () {
  'use strict';

  var EPIC = 'TOOLS';
  var PANEL_ID = 'helm-tools-coordinates';
  var STORE_KEY = 'tools.coordFormat';
  var DEFAULT_FORMAT = 'dmm';
  var FORMATS = {
    dmm: { label: 'DM.m', title: 'Degrees + decimal minutes' },
    dms: { label: 'DMS', title: 'Degrees, minutes, seconds' },
    dec: { label: 'Decimal', title: 'Decimal degrees' }
  };

  var state = {
    map: null,
    hud: null,
    body: null,
    format: loadFormat(),
    lngLat: null,
    source: 'center'
  };

  function loadFormat() {
    try {
      var saved = window.HelmStore && HelmStore.get(STORE_KEY, DEFAULT_FORMAT);
      return FORMATS[saved] ? saved : DEFAULT_FORMAT;
    } catch (e) {
      return DEFAULT_FORMAT;
    }
  }

  function persistFormat(format) {
    state.format = FORMATS[format] ? format : DEFAULT_FORMAT;
    try { if (window.HelmStore) HelmStore.set(STORE_KEY, state.format); } catch (e) {}
    render();
  }

  function normLng(lng) {
    lng = Number(lng);
    if (!Number.isFinite(lng)) return lng;
    while (lng > 180) lng -= 360;
    while (lng < -180) lng += 360;
    return lng;
  }

  function pad(n, width) {
    var s = String(Math.trunc(Math.abs(n)));
    while (s.length < width) s = '0' + s;
    return s;
  }

  function splitDms(value) {
    var abs = Math.abs(Number(value));
    var deg = Math.floor(abs);
    var minutesFloat = (abs - deg) * 60;
    var min = Math.floor(minutesFloat);
    var sec = Math.round((minutesFloat - min) * 600) / 10;
    if (sec >= 60) { sec -= 60; min += 1; }
    if (min >= 60) { min -= 60; deg += 1; }
    return { deg: deg, min: min, sec: sec };
  }

  function splitDmm(value) {
    var abs = Math.abs(Number(value));
    var deg = Math.floor(abs);
    var min = Math.round((abs - deg) * 60000) / 1000;
    if (min >= 60) { min -= 60; deg += 1; }
    return { deg: deg, min: min };
  }

  function hemi(value, isLat) {
    return Number(value) < 0 ? (isLat ? 'S' : 'W') : (isLat ? 'N' : 'E');
  }

  function formatOne(value, isLat, format) {
    value = isLat ? Number(value) : normLng(value);
    if (!Number.isFinite(value)) return '--';
    var width = isLat ? 2 : 3;
    var h = hemi(value, isLat);
    if (format === 'dec') return Math.abs(value).toFixed(5) + '°' + h;
    if (format === 'dms') {
      var dms = splitDms(value);
      return pad(dms.deg, width) + '°' + pad(dms.min, 2) + "'" + dms.sec.toFixed(1).padStart(4, '0') + '"' + h;
    }
    var dmm = splitDmm(value);
    return pad(dmm.deg, width) + '°' + dmm.min.toFixed(3).padStart(6, '0') + "'" + h;
  }

  function formatCoord(lngLat, format) {
    if (!lngLat) return '--';
    var lng = lngLat.lng != null ? lngLat.lng : lngLat.lon;
    var lat = lngLat.lat;
    return formatOne(lat, true, format || state.format) + '  ' + formatOne(lng, false, format || state.format);
  }

  function installHud() {
    if (state.hud) return;
    installStyle();
    var hud = document.createElement('button');
    hud.type = 'button';
    hud.className = 'coord-hud glass';
    hud.title = 'Cursor coordinates';
    hud.innerHTML = '<span class="coord-src">Center</span><span class="coord-val">--</span><span class="coord-mode"></span>';
    hud.addEventListener('click', function () {
      var handle = window.HelmShell && HelmShell.panel && HelmShell.panel(PANEL_ID);
      if (handle) handle.open();
    });
    document.body.appendChild(hud);
    state.hud = hud;
  }

  function installStyle() {
    if (document.getElementById('helm-tools-coordinates-style')) return;
    var style = document.createElement('style');
    style.id = 'helm-tools-coordinates-style';
    style.textContent = [
      '.coord-hud{position:absolute;left:68px;bottom:96px;z-index:6;display:flex;align-items:center;gap:8px;min-width:246px;max-width:min(440px,calc(100vw - 24px));height:34px;padding:0 10px;border:0;color:var(--ctext);font:12px/1.1 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;text-align:left;cursor:pointer}',
      '.coord-hud .coord-src{font:600 9.5px/1 system-ui;color:var(--cdim2);text-transform:uppercase;letter-spacing:0}',
      '.coord-hud .coord-val{flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.coord-hud .coord-mode{font:600 10px/1 system-ui;color:var(--accent)}',
      '.coord-panel .coord-live{margin:8px 0 12px;padding:8px 9px;border:.5px solid var(--line);border-radius:8px;background:rgba(255,255,255,.04);font:12px/1.25 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:var(--ctext)}',
      '.coord-panel .coord-seg{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));border:.5px solid var(--line);border-radius:8px;overflow:hidden}',
      '.coord-panel .coord-seg button{height:32px;border:0;border-right:.5px solid var(--line);background:transparent;color:var(--cdim);font:600 11px/1 system-ui;cursor:pointer}',
      '.coord-panel .coord-seg button:last-child{border-right:0}',
      '.coord-panel .coord-seg button.is-on{background:var(--accent);color:#05121d}'
    ].join('\n');
    document.head.appendChild(style);
  }

  function render() {
    installHud();
    var label = FORMATS[state.format].label;
    var value = formatCoord(state.lngLat, state.format);
    var source = state.source === 'cursor' ? 'Cursor' : 'Center';
    if (state.hud) {
      state.hud.querySelector('.coord-src').textContent = source;
      state.hud.querySelector('.coord-val').textContent = value;
      state.hud.querySelector('.coord-mode').textContent = label;
    }
    if (state.body) {
      var live = state.body.querySelector('[data-coord-live]');
      if (live) live.textContent = source + ': ' + value;
      state.body.querySelectorAll('[data-coord-format]').forEach(function (button) {
        button.classList.toggle('is-on', button.dataset.coordFormat === state.format);
        button.setAttribute('aria-pressed', button.dataset.coordFormat === state.format ? 'true' : 'false');
      });
    }
  }

  function setLngLat(lngLat, source) {
    state.lngLat = lngLat ? { lng: Number(lngLat.lng != null ? lngLat.lng : lngLat.lon), lat: Number(lngLat.lat) } : null;
    state.source = source || state.source || 'cursor';
    render();
  }

  function setCenter() {
    var map = state.map || window.map;
    if (!map || !map.getCenter) return;
    try { setLngLat(map.getCenter(), 'center'); } catch (e) {}
  }

  function bindMap(map) {
    if (!map || map.__helmCoordReadout) return;
    state.map = map;
    map.__helmCoordReadout = true;
    map.on('mousemove', function (e) { if (e && e.lngLat) setLngLat(e.lngLat, 'cursor'); });
    map.on('touchmove', function (e) { if (e && e.lngLat) setLngLat(e.lngLat, 'cursor'); });
    map.on('mouseout', setCenter);
    map.on('moveend', function () { if (state.source !== 'cursor') setCenter(); });
    if (state.lngLat) render();
    else setCenter();
  }

  function renderPanel(body, ctx) {
    state.body = body;
    state.map = (ctx && ctx.map) || state.map || window.map;
    body.classList.add('coord-panel');
    installStyle();
    body.insertAdjacentHTML('beforeend', [
      '<p class="sub">Cursor coordinate format</p>',
      '<div class="coord-live" data-coord-live>--</div>',
      '<div class="coord-seg" role="group" aria-label="Coordinate format">',
      '<button type="button" data-coord-format="dmm">DM.m</button>',
      '<button type="button" data-coord-format="dms">DMS</button>',
      '<button type="button" data-coord-format="dec">Decimal</button>',
      '</div>'
    ].join(''));
    body.addEventListener('click', function (e) {
      var button = e.target && e.target.closest && e.target.closest('[data-coord-format]');
      if (button) persistFormat(button.dataset.coordFormat);
    });
    if (state.map) bindMap(state.map);
    render();
  }

  function register() {
    installHud();
    if (!(window.HelmShell && HelmShell.registerPanel)) return;
    HelmShell.registerPanel({
      id: PANEL_ID,
      epic: EPIC,
      title: 'Coordinates',
      rail: false,                 // entry is the always-on HUD (click) + the command palette — no rail slot (the rail is full)
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v4"/><path d="M12 17v4"/><path d="M3 12h4"/><path d="M17 12h4"/><circle cx="12" cy="12" r="5"/></svg>',
      render: renderPanel,
      onOpen: function () { render(); }
    });
    if (HelmShell.registerCommand) {
      HelmShell.registerCommand({
        id: 'helm-tools-open-coordinates',
        epic: EPIC,
        title: 'Open coordinate format',
        subtitle: 'Cursor readout',
        keywords: ['coordinates', 'lat', 'lon', 'dms', 'decimal'],
        group: 'Tools',
        run: function () { var h = HelmShell.panel(PANEL_ID); if (h) h.open(); }
      });
    }
  }

  window.HelmCoordinates = {
    formatCoord: formatCoord,
    setFormat: persistFormat,
    getFormat: function () { return state.format; },
    preview: function (lngLat, source) { setLngLat(lngLat, source || 'cursor'); },
    bindMap: bindMap,
    state: state
  };

  register();
})();
