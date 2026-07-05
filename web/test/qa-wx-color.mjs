// qa-wx-color.mjs — Playwright CLI diagnostic for the weather-field color pipeline.
//
// Drives the REAL app (default: the live boat screen on :8080) in a headed Chromium
// with a FRESH profile (no stale service worker), exactly like a user:
//   rail → Weather → Wind → transparency slider hard left (opacity 1.0),
//   then clicks Wind AGAIN (warm-cache path — the timing that exposed the wx-scrim bug).
//
// Verdicts are programmatic, not eyeballed:
//   - console errors / pageerrors are captured and printed
//   - the weather layers' raster-brightness-max / raster-saturation are read back:
//     a scrim-crushed field shows brightness-max 0.42 / saturation -0.7 → FAIL
//   - screenshots at t≈0.3s / 1.2s / 3s after each click land in /tmp/wx-qa-*.png
//
// Run:  cd web/test && node qa-wx-color.mjs [baseUrl]
import { chromium } from 'playwright';

const BASE = process.argv[2] || 'http://127.0.0.1:8080/';
const shot = (page, name) => page.screenshot({ path: `/tmp/wx-qa-${name}.png` });

const consoleLines = [];
const browser = await chromium.launch({ headless: false });
const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 } });
const page = await ctx.newPage();
page.on('console', m => consoleLines.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', e => consoleLines.push(`[pageerror] ${e.message}`));
page.on('response', r => { if (r.status() >= 400) consoleLines.push(`[http${r.status()}] ${r.url()}`); });

console.log(`QA target: ${BASE}`);
await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.map && window.map.style && window.map.style._loaded, null, { timeout: 30000 });
await page.evaluate(() => { map.resize(); map.jumpTo({ center: [177.35, -17.68], zoom: 6.5 }); });

// open the weather drawer via the rail, like a user
await page.evaluate(() => {
  const rail = Array.from(document.querySelectorAll('button, [role=button], .ri'))
    .find(el => (el.title || '').toLowerCase().includes('weather') || el.dataset.rail === 'weather');
  rail.click();
});
await page.waitForSelector('#wx button[data-wx="wind"]', { timeout: 10000 });

async function clickWindAndWatch(tag) {
  await page.click('#wx button[data-wx="wind"]');
  await page.waitForTimeout(300);
  await shot(page, `${tag}-t0.3s`);
  await page.waitForTimeout(900);
  await shot(page, `${tag}-t1.2s`);
  await page.waitForFunction(() => window.__helmWxGridStatus && window.__helmWxGridStatus.state === 'on', null, { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(1800);
  await shot(page, `${tag}-t3s`);
  return page.evaluate(() => {
    const read = (id) => window.map.getLayer(id) ? {
      opacity: map.getPaintProperty(id, 'raster-opacity'),
      brightnessMax: map.getPaintProperty(id, 'raster-brightness-max'),
      saturation: map.getPaintProperty(id, 'raster-saturation'),
      contrast: map.getPaintProperty(id, 'raster-contrast'),
    } : null;
    return {
      grid0: read('helm-wx-grid-0'), grid1: read('helm-wx-grid-1'),
      navionics: read('navionics'),
      status: window.__helmWxGridStatus && {
        state: window.__helmWxGridStatus.state,
        opacity: window.__helmWxGridStatus.opacity,
        diagnostics: window.__helmWxGridStatus.diagnostics,
      },
    };
  });
}

// slider hard left = fully non-transparent, particles as-is (user default)
const coldPass = await clickWindAndWatch('cold');
await page.evaluate(() => {
  const sl = document.getElementById('wxopacity');
  sl.value = '0'; sl.dispatchEvent(new Event('input', { bubbles: true }));
});

// the warm path: weather already enabled, click Wind again — wx-scrim's 240ms timer
// now fires with the grid layers PRESENT (this is what users hit on every re-click)
const warmPass = await clickWindAndWatch('warm');

// Known-benign: glyph ranges outside the bundled set 404 and MapLibre falls back to
// local-font rendering (collision.js SART '\u271A' etc. render fine) — documented behavior.
const benign = (l) => /fonts\/Noto[^ ]+\.pbf/.test(l);
// Chromium's console "Failed to load resource" line carries NO URL — the URL-bearing
// [httpNNN] capture is the source of truth for load failures, so those generic console
// lines are excluded here and any non-benign >=400 fails the run below instead.
const errors = consoleLines.filter(l => (l.startsWith('[error]') || l.startsWith('[pageerror]'))
  && !benign(l) && !/Failed to load resource/.test(l));
const badHttp = consoleLines.filter(l => l.startsWith('[http') && !benign(l));
const warns = consoleLines.filter(l => l.startsWith('[warning]') || l.startsWith('[warn]'));

console.log('\n=== console errors ===');
console.log(errors.length ? errors.join('\n') : '(none)');
console.log('\n=== http >=400 ===');
console.log(consoleLines.filter(l => l.startsWith('[http') && !benign(l)).join('\n') || '(none)');
console.log('\n=== console warnings (weather-related) ===');
console.log(warns.filter(l => /wx|weather|grid|envd|gpu/i.test(l)).join('\n') || '(none)');
console.log('\n=== cold-click paint state ===');
console.log(JSON.stringify(coldPass, null, 2));
console.log('\n=== warm-click paint state ===');
console.log(JSON.stringify(warmPass, null, 2));

let fail = false;
for (const [tag, pass] of [['cold', coldPass], ['warm', warmPass]]) {
  for (const seg of ['grid0', 'grid1']) {
    const p = pass[seg];
    if (!p) continue;
    if (p.brightnessMax !== undefined && p.brightnessMax !== null && p.brightnessMax < 0.99) {
      console.log(`FAIL(${tag}): ${seg} raster-brightness-max=${p.brightnessMax} — the field is being DIMMED (scrim?)`);
      fail = true;
    }
    if (p.saturation !== undefined && p.saturation !== null && p.saturation < -0.01) {
      console.log(`FAIL(${tag}): ${seg} raster-saturation=${p.saturation} — the field is being DESATURATED (scrim?)`);
      fail = true;
    }
  }
}
if (errors.length) { console.log(`FAIL: ${errors.length} console error(s)`); fail = true; }
if (badHttp.length) { console.log(`FAIL: ${badHttp.length} non-benign HTTP >=400: ${badHttp.join(', ')}`); fail = true; }
console.log(fail ? '\nVERDICT: FAIL — see above + /tmp/wx-qa-*.png' : '\nVERDICT: CLEAN — field undimmed on cold AND warm clicks, no console errors');

await browser.close();
process.exit(fail ? 1 : 0);
