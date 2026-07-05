// web/ais-inspector.js — AIS tap-inspector, extracted from index.html (CLIENT-25) to keep the
// shell a thin wire-up layer. The rich per-target detail card: engine-driven `ais` source updates,
// tap-to-open card with CPA/TCPA safety stats, pin/buddy/kind controls, and the weather-station
// readout. The card's inline onclick handlers call window.openAisCard/closeAisCard/aisPinFromCard/
// aisToggleBuddy/aisSetKind/aisSetBuddyName, so those stay on window (unchanged).
//
// Interface:
//   HelmAisInspector.init(map)              — wire vessel-layer hover/click (call once, after map)
//   HelmAisInspector.updateFromEngine(list) — drive the `ais` source from the nav frame's ais array
(function () {
  'use strict';
  var map = null;
  // Own copy of the shell's CLIENT-18 escaper — AIS names are open-radio / attacker-broadcastable.
  const escHtml = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const AIS_CLASS = { 0: 'Class A', 1: 'Class B', 2: 'AtoN', 3: 'Base station',
                    5: 'DSC', 6: 'SART', 7: 'ARPA', 9: 'Meteo' };
const aisEsc = escHtml;   // back-compat alias used by the AIS detail card
const aisNum = (v, d) => (v == null || isNaN(v)) ? '—' : (+v).toFixed(d);
// AIS text fields are fixed-width, right-padded with '@' (6-bit value 0) and/or spaces.
// Strip the padding so "MOIN@@@@@@@@@@@@@@@@" shows as "MOIN" (and an all-pad field -> empty).
const aisName = s => { const n = String(s == null ? '' : s).replace(/@+/g, '').trim(); return /^unknown$/i.test(n) ? '' : n; };
const aisAge = sec => sec == null ? null : (sec < 90 ? Math.round(sec) + ' s' : Math.round(sec / 60) + ' min') + ' ago';
// Themed chip — quiet glass to match the card (rgba surface + hairline border), not a candy pill.
// Freshness state reads from a small coloured dot (green fresh / amber aging / red stale); the chip
// itself stays in the card's muted palette. Shared base used by the source chip too.
const AIS_CHIP = 'display:inline-flex;align-items:center;gap:6px;font-size:12.5px;color:var(--cdim);'
  + 'background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.13);padding:4px 10px;border-radius:9px';
const aisFreshChip = sec => {
  if (sec == null) return '';
  const a = +sec, dot = a <= 15 ? '#43d17d' : a <= 120 ? '#f5c451' : '#ff8a82';
  const txt = a < 90 ? Math.round(a) + 's ago' : Math.round(a / 60) + 'm ago';
  return '<span style="' + AIS_CHIP + (a > 120 ? ';color:#ffb4ae' : '') + '">'
    + '<span style="width:7px;height:7px;border-radius:50%;background:' + dot + ';flex:0 0 auto"></span>'
    + (a > 120 ? 'stale · ' : 'updated ') + txt + '</span>';
};
// Source chip — resolve the engine's source connection id to its friendly name (the conns list rides
// the nav frame). Lets you tell "via Vesper AIS" from "via DataHub" from a 3rd-party feed at a glance.
const aisSourceLabel = id => {
  if (!id) return '';
  const c = (window.__helmConns || []).find(x => x && x.id === id);
  return c ? (c.name || id) : id;
};
window.HelmAisFmt = { freshChip: aisFreshChip, sourceLabel: aisSourceLabel, age: aisAge };   // shared with the pinned-target cards (ais-pins.js)
// Redesigned AIS target card (OpenCPN-class). Every static/voyage field is read
// DEFENSIVELY (?? hide-row) so the card works today on the engine's 13-field payload
// and lights up the rest — type, nav status, call sign, destination/ETA, size, ROT —
// the moment the engine forwards what OpenCPN's decoder already has. Flag + risk tiers
// + LOST state are frontend-derived and live now.
// Redesigned for the helm: larger type (iPad + low-vision), a big two-up CPA/TCPA safety stat
// color-coded to the risk tier, plus freshness + source chips and a pin button. Static/voyage
// fields are still read DEFENSIVELY (?? hide-row) so it degrades gracefully on a thin payload.
function aisPopupHTML(p) {
  const meta = window.HelmAisMeta || {};
  const cls = AIS_CLASS[p.class] != null ? AIS_CLASS[p.class] : (p.class != null ? 'Class ' + p.class : '');
  const name = aisName(p.name) || ('MMSI ' + (p.mmsi ?? '?'));
  const fl = meta.flag ? meta.flag(p.mmsi) : '';
  const type = meta.shipType ? meta.shipType(p.shipType ?? p.type) : null;
  const ns = meta.navStatus ? meta.navStatus(p.navStatus) : null;
  const callsign = aisName(p.callsign ?? p.callSign);
  const dest = aisName(p.destination ?? p.dest);

  const valid = p.cpaValid !== false && p.cpa != null;
  let tone = 'ok', riskLabel = 'Safe · clear';
  const _rt = HelmAisRisk.tier(p);
  if (_rt === 'danger') { tone = 'bad'; riskLabel = '⚠ DANGER · collision risk'; }
  else if (_rt === 'caution') { tone = 'warn'; riskLabel = '⚠ Caution'; }
  const toneCol = { bad: '#ff5a52', warn: '#f5c451', ok: '#43d17d' }[tone];
  const cpa = valid ? aisNum(p.cpa, 2) : '—';
  const tcpa = (valid && p.tcpa != null) ? (+p.tcpa).toFixed(0) : '—';
  const tcpaOpening = valid && p.tcpa != null && (+p.tcpa) < 0;
  const stale = p.ageSec != null && p.ageSec > 120;

  // big stat box. CPA/TCPA are the THREAT pair → tinted to the risk tier. SOG/Range are CONTEXT →
  // pass neutral=true so they read big but never alarm-coloured (range/speed aren't a tier signal).
  const stat = (l, v, u, extra, neutral) => '<div style="flex:1;background:rgba(255,255,255,.04);border:1px solid ' + (neutral ? 'rgba(255,255,255,.10)' : toneCol + '55') + ';border-radius:11px;padding:8px 11px">'
    + '<div style="font-size:11.5px;letter-spacing:.05em;color:var(--cdim)">' + l + '</div>'
    + '<div style="font-size:23px;font-weight:600;color:' + ((neutral || tone === 'ok') ? '#e6eef5' : toneCol) + ';line-height:1.1">' + v
    + '<span style="font-size:12.5px;color:var(--cdim)"> ' + u + '</span></div>' + (extra || '') + '</div>';

  const row = (l, v) => '<div style="display:flex;justify-content:space-between;gap:14px;font-size:14px;padding:2px 0">'
    + '<span style="color:var(--cdim)">' + l + '</span><span style="font-variant-numeric:tabular-nums">' + v + '</span></div>';
  const sec = t => '<div style="font-size:10.5px;letter-spacing:.07em;color:var(--cdim);text-transform:uppercase;margin:10px 0 3px">' + t + '</div>';

  // SOG + Range are promoted to the big-stat grid above; Motion keeps the directional detail.
  const motion = [
    row('COG', aisNum(p.cog, 0) + '°'),
    (p.hdg != null && p.hdg < 360) ? row('HDG', aisNum(p.hdg, 0) + '°') : '',
    (meta.rot && meta.rot(p.rot) != null) ? row('ROT', meta.rot(p.rot)) : '',
    (p.altitude != null && +p.altitude > 0) ? row('Altitude', Math.round(p.altitude) + ' m') : '',   // SAR aircraft (AIS msg 9)
    (p.brg != null) ? row('Bearing', aisNum(p.brg, 0) + '°') : ''
  ].join('');

  let voyage = '';
  if (dest || p.eta) voyage = sec('Voyage')
    + (dest ? row('→ Dest', aisEsc(dest)) : '') + (p.eta ? row('ETA', aisEsc(String(p.eta))) : '');
  let size = '';
  if (p.length || p.beam || p.draught) size = row('Size',
    (p.length ? Math.round(p.length) + ' × ' + (p.beam ? Math.round(p.beam) : '?') + ' m' : '')
    + (p.draught ? '  ·  ' + (+p.draught).toFixed(1) + ' m draught' : ''));

  let weather = '';   // AIS-11: weather/met station readout (only the fields the station actually broadcasts)
  if (p.met) {
    const mt = (typeof p.met === 'string' ? (function () { try { return JSON.parse(p.met); } catch (e) { return null; } })() : p.met) || {};   // MapLibre stringifies nested feature props — parse back to an object
    const w = [];
    const wrow = (l, v) => { if (v != null && v !== '') w.push(row(l, v)); };
    wrow('Wind', mt.windKn != null ? (mt.windKn + ' kn' + (mt.windDir != null ? ' @ ' + mt.windDir + '°' : '')) : null);
    wrow('Gust', mt.gustKn != null ? mt.gustKn + ' kn' : null);
    wrow('Pressure', mt.press != null ? mt.press + ' hPa' : null);
    wrow('Air temp', mt.airTemp != null ? mt.airTemp + ' °C' : null);
    wrow('Humidity', mt.humid != null ? mt.humid + ' %' : null);
    wrow('Water temp', mt.waterTemp != null ? mt.waterTemp + ' °C' : null);
    wrow('Waves', mt.waveM != null ? (mt.waveM + ' m' + (mt.wavePer != null ? ' / ' + mt.wavePer + ' s' : '') + (mt.waveDir != null ? ' @ ' + mt.waveDir + '°' : '')) : null);
    wrow('Current', mt.curKn != null ? (mt.curKn + ' kn' + (mt.curDir != null ? ' @ ' + mt.curDir + '°' : '')) : null);
    wrow('Sea state', mt.seaState != null ? 'Bft ' + mt.seaState : null);
    if (w.length) weather = sec('Weather station') + w.join('');
  }

  let badge = '';
  if (ns && meta.navStyle) { const st = meta.navStyle(ns.tone);
    badge = '<span style="display:inline-block;font-size:11.5px;font-weight:600;padding:3px 9px;border-radius:10px;margin:2px 0 6px;'
      + 'background:' + st.bg + ';color:' + st.fg + '">' + st.icon + ' ' + ns.label + '</span>'; }

  const subline = p.met
    ? ['Weather station', p.mmsi ? 'MMSI ' + p.mmsi : ''].filter(Boolean).join(' · ')
    : [p.sar ? '✈ SAR aircraft' : '', cls, type, callsign ? 'Call ' + aisEsc(callsign) : '', p.mmsi ? 'MMSI ' + p.mmsi : ''].filter(Boolean).join(' · ');

  const fresh = aisFreshChip(p.ageSec);
  const srcLabel = aisSourceLabel(p.source);
  const srcChip = srcLabel ? '<span style="' + AIS_CHIP + '">' + aisEsc(srcLabel) + '</span>' : '';
  const pinned = !!(window.HelmAisPins && HelmAisPins.has && HelmAisPins.has(p.mmsi));
  const pinBtn = '<button onclick="window.aisPinFromCard&&window.aisPinFromCard(' + (p.mmsi || 0) + ')" title="' + (pinned ? 'Unpin' : 'Pin this target') + '" '
    + 'style="border:1px solid rgba(255,255,255,.2);background:' + (pinned ? 'rgba(95,208,176,.2)' : 'transparent') + ';color:' + (pinned ? '#5dd0b0' : '#cdd9e3') + ';font-size:15px;border-radius:9px;width:36px;height:36px;cursor:pointer;flex:0 0 auto">📌</button>';
  // AIS-9: buddy / named-MMSI tag — ★ toggles a client-side known-vessel tag (cyan ring + name on chart).
  const isBud = !!(window.HelmAisBuddy && HelmAisBuddy.isBuddy && HelmAisBuddy.isBuddy(p.mmsi));
  const buddyBtn = '<button onclick="window.aisToggleBuddy&&window.aisToggleBuddy(' + (p.mmsi || 0) + ')" title="' + (isBud ? 'Remove buddy tag' : 'Tag as buddy') + '" '
    + 'style="border:1px solid ' + (isBud ? 'rgba(55,199,255,.5)' : 'rgba(255,255,255,.2)') + ';background:' + (isBud ? 'rgba(55,199,255,.18)' : 'transparent') + ';color:' + (isBud ? '#37c7ff' : '#cdd9e3') + ';font-size:15px;border-radius:9px;width:36px;height:36px;cursor:pointer;flex:0 0 auto">' + (isBud ? '★' : '☆') + '</button>';
  const buddyRow = isBud ? '<div style="display:flex;align-items:center;gap:6px;margin:0 0 6px">'
    + '<span style="color:#37c7ff;font-size:12px;white-space:nowrap">★ Buddy</span>'
    + '<input value="' + aisEsc(HelmAisBuddy.name(p.mmsi) || '') + '" placeholder="name (optional)" maxlength="40" '
    + 'oninput="window.aisSetBuddyName&&aisSetBuddyName(' + (p.mmsi || 0) + ',this.value)" '
    + 'style="flex:1;min-width:0;font-size:12px;padding:3px 8px;border:1px solid rgba(55,199,255,.3);border-radius:6px;background:transparent;color:var(--ctext)"></div>' : '';

  // AIS-12: evasion advisor — quantitative "what to do" on a danger target (toggleable; reuses HelmColregs + a relative-motion solve).
  let avoid = '';
  if (_rt === 'danger' && window.HelmAisAdvisor && HelmAisAdvisor.isEnabled && HelmAisAdvisor.isEnabled()) {
    const ad = HelmAisAdvisor.adviceFor(p);
    if (ad) {
      let line;
      if (ad.needWind) line = 'Set the wind (in the AIS panel) for the give-way call.';
      else if (ad.side === 'hold') line = 'Hold course &amp; speed — be ready to act.';
      else if (ad.turnDeg != null && ad.achievable) line = '↻ ≥' + ad.turnDeg + '° to ' + ad.side + ' to clear ' + ad.limit + ' NM'
        + (ad.newCourse != null ? ' — make good ' + Math.round(ad.newCourse) + '° over ground' : '')
        + (ad.slowToKn != null ? ', or slow to ' + ad.slowToKn + ' kn' : '');
      else if (ad.turnDeg != null) line = 'Best out: ↻ ' + ad.turnDeg + '° to ' + ad.side + ' → ' + ad.clearBy + ' NM (can\'t reach ' + ad.limit + ' NM — she\'s too close)'
        + (ad.slowToKn != null ? '; or slow to ' + ad.slowToKn + ' kn' : '');
      else if (ad.slowToKn != null) line = 'Slow to ' + ad.slowToKn + ' kn to clear.';
      else line = 'No course or speed change clears — reduce speed and verify visually.';
      // AIS-14: the advised course is a ground track. If set & drift are entered, give the heading to steer.
      let steerLine = '';
      if (ad.newCourse != null && ad.setDrift) {
        const sDeg = Math.round(ad.setDrift.setDeg), dKn = ad.setDrift.driftKn;
        if (ad.steerHeading != null) steerLine = 'Steer ~' + Math.round(ad.steerHeading) + '° to make that track good through the ' + dKn + ' kn set (' + sDeg + '°)';
        else if (ad.makeGoodUnreachable) steerLine = 'The ' + dKn + ' kn set (' + sDeg + '°) is too strong to hold that ground track at your speed — open the range another way.';
      }
      // Visual propulsion override — your eyes beat the AIS registry (a "sailing" vessel can be motoring).
      const kind = window.HelmColregsKind ? HelmColregsKind(p) : null;
      let kindRow = '';
      if (kind && (kind.ais === 'sail' || ad.sail || kind.override)) {
        const eff = kind.override || (kind.ais === 'unknown' ? null : kind.ais), src = kind.override ? 'you set' : 'from AIS';
        const kbtn = (k, lbl) => { const sel = (k === 'auto') ? !kind.override : (eff === k);
          return '<button type="button" onclick="window.aisSetKind&&aisSetKind(' + (p.mmsi || 0) + ',\'' + k + '\')" '
            + 'style="cursor:pointer;font-size:11px;padding:3px 9px;border-radius:7px;border:1px solid ' + (sel ? '#5dd0b0' : 'rgba(255,255,255,.18)') + ';background:' + (sel ? 'rgba(95,208,176,.18)' : 'transparent') + ';color:var(--ctext)">' + lbl + '</button>'; };
        kindRow = '<div style="font-size:10.5px;color:var(--cdim);margin-top:7px">Her propulsion: <span style="color:#cdd9e3">' + (eff || 'unknown') + '</span> <span style="opacity:.7">(' + src + ')</span> — what do you actually see?</div>'
          + '<div style="display:flex;gap:5px;margin-top:4px">' + kbtn('sail', 'Sailing') + kbtn('power', 'Motoring') + kbtn('auto', 'AIS') + '</div>';
      }
      const caveat = ad.sail ? ('Based on her AIS type unless you set it above — a registered sailing vessel can be motoring (then power rules apply).'
        + (ad.rule === 'Rule 12' ? ' Her tack is inferred from her course and the wind.' : '')) : '';
      avoid = sec('Avoid')
        + '<div style="background:rgba(255,90,82,.10);border:1px solid #ff5a5240;border-radius:9px;padding:8px 10px">'
        + (ad.action ? '<div style="font-size:12.5px;color:#ffd0cc;margin-bottom:4px">' + aisEsc(ad.action) + (ad.rule ? ' <span style="color:var(--cdim)">· ' + aisEsc(ad.rule) + '</span>' : '') + '</div>' : '')
        + '<div style="font-size:13.5px;font-weight:600;color:#ff9a93">' + line + '</div>'
        + (steerLine ? '<div style="font-size:11.5px;color:#cdd9e3;margin-top:3px">⊕ ' + steerLine + '</div>' : '')
        + kindRow
        + (caveat ? '<div style="font-size:10px;color:#f0c98a;margin-top:6px">⚠ ' + caveat + '</div>' : '')
        + '<div style="font-size:10px;color:var(--cdim);margin-top:5px">Advisory — keep a lookout; you remain responsible under the Rules.</div>'
        + '</div>';
    }
  }

  return '<div class="ais-card" style="min-width:240px' + (stale ? ';opacity:.6' : '') + '">'
    + '<div style="display:flex;align-items:center;gap:9px;margin-bottom:2px">'
    +   '<span style="font-weight:600;font-size:18px;flex:1;line-height:1.15">' + aisEsc(name) + (fl ? ' <span style="font-size:1.15em;line-height:1;vertical-align:-1px">' + fl + '</span>' : '') + '</span>'
    +   buddyBtn + pinBtn
    + '</div>'
    + (subline ? '<div style="font-size:12px;color:var(--cdim);margin-bottom:6px">' + subline + '</div>' : '')
    + buddyRow
    + badge
    + '<div style="display:flex;gap:8px;margin:8px 0 4px">'
    +   stat('CPA', cpa, 'NM') + stat('TCPA', tcpa, 'min', tcpaOpening ? '<div style="font-size:10.5px;color:#5dd0b0">opening</div>' : '')
    + '</div>'
    + '<div style="display:flex;gap:8px;margin:0 0 4px">'
    +   stat('SOG', aisNum(p.sog, 1), 'kn', '', true) + stat('Range', aisNum(p.range, 2), 'NM', '', true)
    + '</div>'
    + '<div style="font-size:12.5px;font-weight:600;color:' + toneCol + ';margin:0 0 2px">' + riskLabel + '</div>'
    + avoid
    + weather
    + sec('Motion') + motion
    + voyage + size
    + '<div style="display:flex;gap:7px;flex-wrap:wrap;margin-top:10px">' + fresh + srcChip
    +   (p.posDoubtful ? '<span style="display:inline-flex;align-items:center;gap:5px;font-size:12.5px;color:#412402;background:#ef9f27;padding:5px 10px;border-radius:16px">⚠ position doubtful</span>' : '')
    + '</div>'
    + '</div>';
}
// AIS detail card — a FREE, draggable inspector (not map-anchored). It opens beside the tapped
// vessel but is always clamped fully on-screen (never under the top bar / left rail / bottom HUD),
// and you can drag it anywhere by its header. Static snapshot — pin it (HelmAisPins) to watch it
// live. One card at a time. Replaces the old maplibregl.Popup, which could spawn half off-screen
// and couldn't be moved.
var _aisCard = null, _aisCardBody = null, _aisCardProps = null, _aisCardDragging = false;
var AIS_CARD_SAFE = { top: 54, left: 58, bottom: 70, pad: 8 };   // keep clear of the chrome
function closeAisCard() { if (_aisCard) { _aisCard.remove(); _aisCard = null; } }
function clampAisCard(el, x, y) {
  var s = AIS_CARD_SAFE, w = el.offsetWidth, h = el.offsetHeight;
  var maxX = window.innerWidth - w - s.pad, maxY = window.innerHeight - s.bottom - h;
  x = Math.max(s.left, Math.min(x, Math.max(s.left, maxX)));
  y = Math.max(s.top, Math.min(y, Math.max(s.top, maxY)));
  el.style.left = Math.round(x) + 'px'; el.style.top = Math.round(y) + 'px';
}
function makeAisCardDraggable(card, handle) {
  var sx, sy, ox, oy, dragging = false;
  function move(e) {
    if (!dragging) return;
    var pt = e.touches ? e.touches[0] : e;
    clampAisCard(card, ox + (pt.clientX - sx), oy + (pt.clientY - sy));
    if (e.cancelable) e.preventDefault();
  }
  function up() {
    dragging = false; _aisCardDragging = false;
    document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up);
    document.removeEventListener('touchmove', move); document.removeEventListener('touchend', up);
  }
  function down(e) {
    if (e.target.closest('button')) return;                 // never start a drag from a button
    dragging = true; _aisCardDragging = true;
    var pt = e.touches ? e.touches[0] : e;
    sx = pt.clientX; sy = pt.clientY;
    ox = parseFloat(card.style.left) || 0; oy = parseFloat(card.style.top) || 0;
    document.addEventListener('mousemove', move); document.addEventListener('mouseup', up);
    document.addEventListener('touchmove', move, { passive: false }); document.addEventListener('touchend', up);
    e.preventDefault();
  }
  handle.addEventListener('mousedown', down);
  handle.addEventListener('touchstart', down, { passive: false });
}
function openAisCard(props, point) {
  closeAisCard();
  var card = document.createElement('div');
  card.className = 'helm-ais-card';
  card.style.cssText = 'position:fixed;z-index:20;width:min(92vw,340px);max-height:78vh;overflow-y:auto;'
    + 'background:rgba(13,23,34,.97);border:1px solid rgba(255,255,255,.14);border-radius:14px;'
    + 'box-shadow:0 18px 50px -16px rgba(0,0,0,.9);color:#e6eef5;-webkit-overflow-scrolling:touch';
  var head = document.createElement('div');
  head.style.cssText = 'display:flex;align-items:center;justify-content:space-between;cursor:move;'
    + 'padding:7px 11px 1px;touch-action:none;user-select:none;-webkit-user-select:none';
  head.innerHTML = '<span style="font-size:10.5px;letter-spacing:.12em;color:var(--cdim)">⠿ DRAG</span>'
    + '<button data-close aria-label="Close" title="Close" style="border:none;background:transparent;'
    + 'color:#9bb0c0;font-size:21px;line-height:1;cursor:pointer;padding:0 2px 2px">×</button>';
  var body = document.createElement('div');
  body.style.cssText = 'padding:2px 13px 13px';
  body.innerHTML = aisPopupHTML(props);
  card.appendChild(head); card.appendChild(body);
  document.body.appendChild(card);
  var x = (point && point.x != null) ? point.x + 16 : (window.innerWidth - card.offsetWidth) / 2;
  var y = (point && point.y != null) ? point.y + 16 : 96;
  clampAisCard(card, x, y);
  head.querySelector('[data-close]').addEventListener('click', closeAisCard);
  makeAisCardDraggable(card, head);
  _aisCard = card; _aisCardBody = body; _aisCardProps = props;
  return card;
}
// Visual propulsion override (Rule 12/18 honesty): your eyes correct the AIS registry — re-render live.
window.aisSetKind = function (mmsi, kind) {
  if (window.HelmAisAdvisor && HelmAisAdvisor.setTargetKind) HelmAisAdvisor.setTargetKind(mmsi, kind);
  if (_aisCardBody && _aisCardProps && +_aisCardProps.mmsi === +mmsi) _aisCardBody.innerHTML = aisPopupHTML(_aisCardProps);
};
// AIS-9: buddy tag — toggle re-renders the card (flips the ★ + shows the name row); name edit does NOT
// re-render (would lose input focus mid-type — the chart ring/label update via the helm:ais-buddy event).
window.aisToggleBuddy = function (mmsi) {
  if (window.HelmAisBuddy) HelmAisBuddy.toggle(mmsi);
  if (_aisCardBody && _aisCardProps && +_aisCardProps.mmsi === +mmsi) _aisCardBody.innerHTML = aisPopupHTML(_aisCardProps);
};
window.aisSetBuddyName = function (mmsi, name) { if (window.HelmAisBuddy) HelmAisBuddy.set(mmsi, name); };
// Live-refresh the open detail card every nav frame (mirrors the pinned cards) so SOG/CPA/TCPA/range
// AND the red→amber→green tier colour track the engine instead of freezing at tap time. Fed the SAME
// normalised feature props the map source gets (so sentinels stay desentineled). Skips mid-drag and
// preserves the card's scroll position across the innerHTML swap; if the target dropped from the feed
// this frame, keeps the last render rather than blanking.
function refreshAisCard(feats) {
  if (!_aisCard || !_aisCardBody || !_aisCardProps || _aisCardDragging) return;
  // Don't yank the card out from under an active edit (e.g. the buddy-name field) — the innerHTML swap
  // would drop focus + the half-typed value. Resume next frame once focus leaves the input.
  var ae = document.activeElement;
  if (ae && _aisCard.contains(ae) && /^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName || '')) return;
  var mmsi = +_aisCardProps.mmsi;
  if (!mmsi || !Array.isArray(feats)) return;          // non-MMSI cards (some weather/base stations) → leave static
  var fresh = null;
  for (var i = 0; i < feats.length; i++) { var p = feats[i].properties; if (p && +p.mmsi === mmsi) { fresh = p; break; } }
  if (!fresh) return;
  _aisCardProps = fresh;
  var sc = _aisCard.scrollTop;                          // the card div is the scroll container (overflow-y:auto)
  _aisCardBody.innerHTML = aisPopupHTML(fresh);
  _aisCard.scrollTop = sc;
}
// A rotate/resize must never strand the card off-screen; Esc dismisses it.
window.addEventListener('resize', function () { if (_aisCard) clampAisCard(_aisCard, parseFloat(_aisCard.style.left) || 0, parseFloat(_aisCard.style.top) || 0); });
window.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeAisCard(); });
window.openAisCard = openAisCard; window.closeAisCard = closeAisCard;   // debug/automation hook (like window.map)
// Pin from the card: pinning docks a live card on the right, so close the floating one (mirrors the
// map-tap card). Unpinning from an already-pinned target's card leaves it open so you can re-pin.
function aisPinFromCard(mmsi) {
  if (!window.HelmAisPins) return;
  var wasPinned = HelmAisPins.has && HelmAisPins.has(mmsi);
  HelmAisPins.toggle(mmsi);
  if (!wasPinned) closeAisCard();
}
window.aisPinFromCard = aisPinFromCard;
// AIS targets → the `ais` source. The source carries promoteId:'mmsi' (CLIENT-5) so each target's
// feature.id == its MMSI — a stable id for tap hit-testing and future incremental updates.
function updateAisFromEngine(list) {
  if (!Array.isArray(list)) return;
  try {
    const src = map.getSource('ais'); if (!src) return;
    const feats = list
      .filter(t => t && isFinite(t.lon) && isFinite(t.lat))
      .map(t => ({ type: 'Feature', id: t.mmsi, geometry: { type: 'Point', coordinates: [t.lon, t.lat] },
                   // Normalise the AIS "not available" sentinels to null so we never render them as
                   // real data: SOG 1023 → 102.3 kn (a moored Class-B with no GPS speed would show as
                   // a 100-kn ghost + a huge AIS-4 predictor), COG 3600 → 360°. A target not reporting
                   // speed/course must read "—", not a fake value.
                   properties: { ...t, name: aisName(t.name),
                     sog: (t.sog != null && +t.sog <= 102.2) ? t.sog : null,
                     cog: (t.cog != null && +t.cog < 360) ? t.cog : null } }));   // strip '@' padding for the map label too
    src.setData({ type: 'FeatureCollection', features: feats });
    refreshAisCard(feats);   // keep the open detail card live (SOG/CPA/TCPA/range + tier colour) — same normalised props
  } catch (e) { /* style not ready this tick */ }
}

  function init(m) {
    map = m;
    const measuring = () => window.__helmMeasure && window.__helmMeasure.active();
    // AIS tap -> rich detail card. Bound to the live vessel layers (collision.js renders vessels on
    // helm-ais-vessel-tri; SART/AtoN/base on helm-ais-symbol); 'ais-vessels' is the hidden legacy layer.
    ['helm-ais-vessel-tri', 'helm-ais-symbol', 'ais-vessels'].forEach(layer => {
      map.on('mouseenter', layer, () => { map.getCanvas().style.cursor = 'pointer'; });
      map.on('mouseleave', layer, () => { map.getCanvas().style.cursor = ''; });
      map.on('click', layer, e => { if (measuring()) return; openAisCard(e.features[0].properties, e.point); });
    });
  }

  window.HelmAisInspector = { init: init, updateFromEngine: updateAisFromEngine };
}());
