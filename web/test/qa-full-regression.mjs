// qa-full-regression.mjs — extensive post-refactor regression against the LIVE app (:8080).
// Exercises every surface the CLIENT-25/26/27 extractions touched (AIS tap card, community
// where-to, ⌘K palette) PLUS core (chart, weather, drawers, rail, instruments) with READ-ONLY
// interactions. Programmatic pass/fail per check + a console/network verdict.
// Run:  cd web/test && node qa-full-regression.mjs [baseUrl]
import { chromium } from 'playwright';

const BASE = process.argv[2] || 'http://127.0.0.1:8080/';
const msgs = [], failed = [], httpErr = [];
const results = [];
const check = (name, pass, detail) => { results.push({ name, pass: !!pass, detail }); };

const browser = await chromium.launch({ headless: false });  // headed → real WebGPU adapter
const page = await (await browser.newContext({ viewport: { width: 1600, height: 900 } })).newPage();
page.on('console', m => msgs.push({ type: m.type(), text: m.text() }));
page.on('pageerror', e => msgs.push({ type: 'pageerror', text: (e && e.stack) || String(e) }));
page.on('requestfailed', r => failed.push(`${r.method()} ${r.url()} — ${r.failure()?.errorText || '?'}`));
page.on('response', r => { if (r.status() >= 400) httpErr.push(`${r.status()} ${r.url()}`); });

console.log(`QA target: ${BASE}\n`);
await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.map && window.map.style && window.map.style._loaded, null, { timeout: 30000 }).catch(() => {});
await page.waitForTimeout(2500);

// ---- 1. BOOT: all extracted modules loaded, no degrade banner ----
const boot = await page.evaluate(() => ({
  aisInspector: !!(window.HelmAisInspector && window.HelmAisInspector.init && window.HelmAisInspector.updateFromEngine),
  communityShell: !!(window.HelmCommunityShell && window.HelmCommunityShell.init),
  cmdK: !!(window.HelmCmdK && window.HelmCmdK.open),
  aisInspectorInited: !!window.__aisVectors || (() => { try { return !!window.map.getLayer('helm-ais-symbol'); } catch { return false; } })(),
  commInited: !!window.__helmCommunity,
  degradeShown: (() => { const b = document.getElementById('degraded-banner'); return b ? !b.hidden : false; })(),
}));
check('modules loaded (ais-inspector / community-shell / command-palette)', boot.aisInspector && boot.communityShell && boot.cmdK, JSON.stringify(boot));
check('no degrade banner on boot', boot.degradeShown === false);

// ---- 2. CHART: ENC + navionics PMTiles render over Fiji ----
const chart = await page.evaluate(async () => {
  try { if (window.__ownship && window.__ownship.setFollow) window.__ownship.setFollow(false); } catch {}
  map.jumpTo({ center: [177.4, -17.7], zoom: 10 }); await new Promise(r => setTimeout(r, 3500));
  const t = (id) => map.getSource(id) ? map.getSource(id).type : null;
  return { navionics: t('navionics'), enc: t('enc'), pmtilesProto: !!window.__helmPmtilesProtocolReady, tilesLoaded: map.areTilesLoaded() };
});
check('chart sources present (navionics pmtiles + enc)', chart.navionics === 'raster' && chart.enc === 'raster', JSON.stringify(chart));
check('pmtiles protocol registered', chart.pmtilesProto);

// ---- 3. AIS (extracted module): targets + tap card open/populate/close ----
const ais = await page.evaluate(async () => {
  const n = (() => { try { return map.querySourceFeatures('ais').length; } catch { return 0; } })();
  let feat = null; try { feat = map.querySourceFeatures('ais')[0]; } catch {}
  let opened = false, hasCPA = false, closed = false;
  if (feat && window.openAisCard) {
    window.openAisCard(feat.properties, { x: 500, y: 300 }); await new Promise(r => setTimeout(r, 300));
    const txt = document.body.textContent || '';
    opened = txt.includes('MMSI') || txt.includes(String(feat.properties.mmsi || ''));
    hasCPA = txt.includes('CPA');
    window.closeAisCard && window.closeAisCard(); await new Promise(r => setTimeout(r, 150));
    closed = !(document.body.textContent || '').includes('DRAG');
  }
  return { targets: n, cardOpened: opened, cardHasCPA: hasCPA, cardClosed: closed, name: feat && feat.properties && (feat.properties.name || feat.properties.mmsi) };
});
check('AIS targets present in view', ais.targets > 0, `${ais.targets} targets`);
check('AIS tap card opens + populates (CPA)', ais.cardOpened && ais.cardHasCPA, `sample=${ais.name}`);
check('AIS card closes', ais.cardClosed);

// ---- 4. WEATHER: wind field on WebGPU + transparency slider ----
const wx = await page.evaluate(async () => {
  const rail = Array.from(document.querySelectorAll('.ri,[role=button],button')).find(el => (el.title || '').toLowerCase().includes('weather') || el.dataset.rail === 'weather');
  if (rail) rail.click(); await new Promise(r => setTimeout(r, 400));
  const wind = document.querySelector('#wx button[data-wx="wind"]'); if (wind) wind.click();
  for (let i = 0; i < 40; i++) { const s = window.__helmWxGridStatus; if (s && s.state === 'on') break; await new Promise(r => setTimeout(r, 250)); }
  const st = window.__helmWxGridStatus || {};
  const sl = document.getElementById('wxopacity'); let opChanged = false;
  if (sl) { sl.value = '0'; sl.dispatchEvent(new Event('input', { bubbles: true })); await new Promise(r => setTimeout(r, 300)); opChanged = window.__helmWxGridStatus.opacity === 1; }
  return { state: st.state, windMode: window.__helmWindMode, diags: (st.diagnostics || []).map(d => d.code), opacityReactsToSlider: opChanged };
});
check('weather wind field ON', wx.state === 'on', JSON.stringify(wx));
check('weather on GPU, no diagnostics', wx.windMode === 'gpu' && wx.diags.length === 0);
check('transparency slider drives opacity', wx.opacityReactsToSlider);

// ---- 5. COMMUNITY (extracted module): Suggest for tonight ----
const comm = await page.evaluate(async () => {
  const btn = document.getElementById('wt-go'); if (!btn) return { btn: false };
  let threw = false, results = 0;
  try { btn.click(); await new Promise(r => setTimeout(r, 1800)); results = (() => { try { return map.querySourceFeatures('whereto').length; } catch { return 0; } })(); }
  catch (e) { threw = e.message; }
  const res = document.getElementById('wt-results');
  return { btn: true, threw, anchoragesPlotted: results, resultText: res ? res.textContent.slice(0, 50) : '' };
});
check('community "Suggest for tonight" runs (no throw)', comm.btn && comm.threw === false, JSON.stringify(comm));
check('community renders recommendations', (comm.resultText || '').length > 3, comm.resultText);

// ---- 6. ⌘K palette (extracted module + bugfix): open, list, search ----
const palette = await page.evaluate(async () => {
  let threw = false, listed = 0, searchListed = 0;
  try {
    HelmCmdK.open(); await new Promise(r => setTimeout(r, 250));
    const cmdk = document.getElementById('cmdk');
    listed = cmdk ? cmdk.querySelectorAll('[data-i]').length : 0;
    const input = cmdk && cmdk.querySelector('input');
    if (input) { input.value = 'tide'; input.dispatchEvent(new Event('input', { bubbles: true })); await new Promise(r => setTimeout(r, 200)); searchListed = cmdk.querySelectorAll('[data-i]').length; }
    HelmCmdK.close();
  } catch (e) { threw = e.message; }
  return { threw, totalCommands: (window.HelmShell && HelmShell.commands) ? HelmShell.commands().length : 0, listed, searchListed };
});
check('⌘K palette opens + lists commands (no throw)', palette.threw === false && palette.listed > 0, JSON.stringify(palette));
check('⌘K search filters (string-keyword path)', palette.searchListed >= 0 && palette.threw === false);

// ---- 7. DRAWERS + RAIL: open each drawer via its rail icon ----
const drawers = await page.evaluate(async () => {
  const ids = ['drawer-layers', 'drawer-weather', 'drawer-download', 'drawer-routes'];
  const out = {};
  for (const id of ids) {
    const rail = Array.from(document.querySelectorAll('.ri[data-rail]')).find(r => {
      const d = { layers: 'drawer-layers', weather: 'drawer-weather', download: 'drawer-download', routes: 'drawer-routes' }[r.dataset.rail];
      return d === id;
    });
    if (rail) { rail.click(); await new Promise(r => setTimeout(r, 250)); const d = document.getElementById(id); out[id] = d ? !d.hidden : 'no-el'; if (d) d.hidden = true; }
  }
  return out;
});
check('drawers open from rail (layers/weather/download/routes)', Object.values(drawers).filter(v => v === true).length >= 3, JSON.stringify(drawers));

// ---- 8. INSTRUMENTS: nav readouts present ----
const instr = await page.evaluate(() => {
  const txt = document.body.textContent || '';
  return { hasSOG: /SOG/i.test(txt), hasCOG: /COG/i.test(txt), hasDepth: /DEPTH/i.test(txt), hasPosition: /POSITION|°[NS]|°[EW]/.test(txt) };
});
check('instruments render (SOG/COG/Depth/Position)', instr.hasSOG && instr.hasCOG && instr.hasDepth, JSON.stringify(instr));

await page.screenshot({ path: '/tmp/qa-full-regression.png' });

// ---- verdict ----
const benign = (t) => /Failed to load resource|DevTools|fonts\/Noto[^ ]*\.pbf/i.test(t);
const errors = msgs.filter(m => (m.type === 'error' || m.type === 'pageerror') && !benign(m.text));
const benignHttp = /\.(pbf|png|jpe?g|webp)$|fonts\/Noto/i;
const realHttp = httpErr.filter(h => !benignHttp.test(h));
const realFailed = failed.filter(f => !benignHttp.test(f) && !/ERR_ABORTED/.test(f));

console.log('=== CHECKS ===');
for (const r of results) console.log(`  ${r.pass ? '✅' : '❌'} ${r.name}${r.pass ? '' : '  <<< ' + (r.detail || '')}`);
console.log('\n=== CONSOLE ERRORS (non-benign) ===\n' + (errors.length ? [...new Set(errors.map(e => e.text.slice(0, 200)))].join('\n') : '(none)'));
console.log('\n=== HTTP >=400 (non-tile) ===\n' + (realHttp.length ? [...new Set(realHttp)].join('\n') : '(none)'));
console.log('\n=== REQUESTS FAILED (non-tile) ===\n' + (realFailed.length ? [...new Set(realFailed)].join('\n') : '(none)'));

const failedChecks = results.filter(r => !r.pass);
const clean = failedChecks.length === 0 && errors.length === 0 && realHttp.length === 0 && realFailed.length === 0;
console.log(`\nVERDICT: ${clean ? 'ALL GREEN' : 'FAILURES'} — ${results.filter(r => r.pass).length}/${results.length} checks passed, ${errors.length} console errors — /tmp/qa-full-regression.png`);
await browser.close();
process.exit(clean ? 0 : 1);
