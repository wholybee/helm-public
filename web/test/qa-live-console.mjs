// qa-live-console.mjs — drive the REAL live app and surface every console/network oddity.
// Points at the live C++ helm-server (:8080) by default: exercises packd PMTiles basemaps
// (:8091), envd weather (:8094), basemap-cache (:8095). Fresh Chromium profile (no stale SW).
//
// Captures & categorizes: console (error/warning/info/log), pageerror, requestfailed,
// HTTP>=400, then drives Fiji chart + weather and reports what rendered + everything odd.
// Run:  cd web/test && node qa-live-console.mjs [baseUrl]
import { chromium } from 'playwright';

const BASE = process.argv[2] || 'http://127.0.0.1:8080/';
const console_msgs = [];       // {type, text}
const failed = [];             // requestfailed
const httpErr = [];            // response >= 400

const browser = await chromium.launch({ headless: false });
const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 } });
const page = await ctx.newPage();
page.on('console', m => console_msgs.push({ type: m.type(), text: m.text() }));
page.on('pageerror', e => console_msgs.push({ type: 'pageerror', text: (e && e.stack) || String(e) }));
page.on('requestfailed', r => failed.push(`${r.method()} ${r.url()} — ${r.failure()?.errorText || '?'}`));
page.on('response', r => { if (r.status() >= 400) httpErr.push(`${r.status()} ${r.request().method()} ${r.url()}`); });

console.log(`QA target: ${BASE}\n`);
await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.map && window.map.style && window.map.style._loaded, null, { timeout: 30000 }).catch(() => {});

// 1) the Fiji chart (packd PMTiles basemap)
const chart = await page.evaluate(async () => {
  map.resize(); map.jumpTo({ center: [178.0, -17.8], zoom: 8 });
  await new Promise(r => setTimeout(r, 3500));
  const src = (id) => map.getSource(id) ? map.getSource(id).type : 'missing';
  const banner = document.getElementById('degraded-banner');
  return {
    navionicsSource: src('navionics'), encSource: src('enc'),
    pmtilesProtocolReady: !!window.__helmPmtilesProtocolReady,
    tilesLoaded: map.areTilesLoaded(),
    degradeBannerShown: banner ? !banner.hidden : 'n/a',
    projection: map.getProjection ? map.getProjection().type : '?',
  };
});

// 2) weather (envd :8094 + WebGPU) — enable wind via the drawer like a user
const wx = await page.evaluate(async () => {
  const rail = Array.from(document.querySelectorAll('button,[role=button],.ri'))
    .find(el => (el.title || '').toLowerCase().includes('weather') || el.dataset.rail === 'weather');
  if (rail) rail.click();
  await new Promise(r => setTimeout(r, 400));
  const wind = document.querySelector('#wx button[data-wx="wind"]');
  if (wind) wind.click();
  for (let i = 0; i < 40; i++) { const s = window.__helmWxGridStatus; if (s && s.state === 'on') break; await new Promise(r => setTimeout(r, 250)); }
  const st = window.__helmWxGridStatus || {};
  return { weatherState: st.state || 'off', windMode: window.__helmWindMode || 'none',
           wxDiagnostics: (st.diagnostics || []).map(d => d.code) };
});

// 3) live nav/data snapshot — what state is the app actually carrying?
const nav = await page.evaluate(() => {
  const n = window.__lastNav || window.__nav || null;
  return {
    activeWx: window.__activeWx,
    aisTargets: (() => { try { return map.querySourceFeatures('ais').length; } catch { return 'n/a'; } })(),
    hasNavFrame: !!n,
    simOrLive: document.querySelector('.badge, [class*=sim], [class*=live]')?.textContent?.trim()?.slice(0, 8) || '?',
  };
});

await page.screenshot({ path: '/tmp/qa-live-fiji.png' });

// ---- categorize ----
const BENIGN_CONSOLE = /Failed to load resource|\bDevTools\b|Download the .* DevTools/i;  // URL-less echo of a subresource fail; the URL-bearing httpErr/failed lists are the source of truth
const errors = console_msgs.filter(m => (m.type === 'error' || m.type === 'pageerror') && !BENIGN_CONSOLE.test(m.text));
const warnings = console_msgs.filter(m => m.type === 'warning');
const benignHttp = /\.(pbf|png|jpe?g|webp)$|fonts\/Noto/i;
const realHttpErr = httpErr.filter(h => !benignHttp.test(h));
const realFailed = failed.filter(f => !benignHttp.test(f) && !/ERR_ABORTED/.test(f));  // ABORTED = cancelled, not failed

const uniq = (a) => [...new Set(a)];
console.log('=== RENDER / STATE ===');
console.log(JSON.stringify({ chart, wx, nav }, null, 1));
console.log('\n=== CONSOLE ERRORS / PAGEERRORS (non-benign) ===');
console.log(errors.length ? uniq(errors.map(e => `[${e.type}] ${e.text.slice(0, 240)}`)).join('\n') : '(none)');
console.log('\n=== CONSOLE WARNINGS (deduped) ===');
console.log(warnings.length ? uniq(warnings.map(w => w.text.slice(0, 200))).slice(0, 25).join('\n') : '(none)');
console.log('\n=== HTTP >= 400 (non-tile) ===');
console.log(realHttpErr.length ? uniq(realHttpErr).join('\n') : '(none)');
console.log('\n=== REQUESTS FAILED (non-tile) ===');
console.log(realFailed.length ? uniq(realFailed).join('\n') : '(none)');
console.log('\n=== CONSOLE DATA/NOISE SAMPLE (info/log, first 20 unique) ===');
console.log(uniq(console_msgs.filter(m => m.type === 'log' || m.type === 'info').map(m => m.text.slice(0, 160))).slice(0, 20).join('\n') || '(none)');

const verdict = (errors.length || realHttpErr.length || realFailed.length || chart.degradeBannerShown === true) ? 'ODDITIES FOUND' : 'CLEAN';
console.log(`\nVERDICT: ${verdict}  (console errors ${errors.length}, http>=400 ${realHttpErr.length}, failed ${realFailed.length})  — screenshot /tmp/qa-live-fiji.png`);
await browser.close();
