// HELMC++-4: browser cockpit proof against the C++-only runtime.
//
// Run through scripts/helmcxx-cockpit-proof.sh. The spec assumes the script has
// started helm-server, helm-packd, helm-basemap-cache, and helm-envd on private
// ports and has generated same-origin WX release fixtures under the served web root.
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

test.skip(!process.env.HELM_HELMCXX4, 'Run scripts/helmcxx-cockpit-proof.sh for the C++ cockpit proof.');

const HASH = process.env.HELM_HELMCXX4_HASH || '#11/31.90000/-81.10000';
const PACKD_URL = process.env.HELM_HELMCXX4_PACKD_URL;
const CACHE_URL = process.env.HELM_HELMCXX4_CACHE_URL;
const ENVD_URL = process.env.HELM_HELMCXX4_ENVD_URL;
const EVIDENCE_DIR = process.env.HELM_HELMCXX4_EVIDENCE_DIR ||
  path.resolve(__dirname, '..', '..', '..', 'test-results', 'helmcxx4-cockpit');

function ensureEvidenceDir() {
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
}

function hashCenter(hash) {
  const m = String(hash || '').match(/^#?(\d+(?:\.\d+)?)\/(-?\d+(?:\.\d+)?)\/(-?\d+(?:\.\d+)?)/);
  if (!m) throw new Error(`Bad HELMC++-4 hash: ${hash}`);
  return { zoom: Number(m[1]), lat: Number(m[2]), lon: Number(m[3]) };
}

function lon2tile(lon, z) {
  return Math.floor((lon + 180) / 360 * Math.pow(2, z));
}

function lat2tile(lat, z) {
  const r = lat * Math.PI / 180;
  return Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * Math.pow(2, z));
}

function isWeatherProvider(url) {
  return /open-meteo|marine-api|api\.windy\.com|customer-api|:8093\/|\/wind\/\d+\/|\/rain\/\d+\//i.test(url);
}

function isBenignFailedRequest(url) {
  return /favicon\.ico|tile|sprite|glyph|\.(png|pbf|jpg)/i.test(url) ||
    /\/user-data\/(?:depcnt|depare|soundg)\.geojson$/i.test(url);
}

function isBenignConsoleMessage(message) {
  return /unsupported_renderer_capability|WebGPU|No available adapters|Failed to load resource|favicon/i.test(message) ||
    /GL Driver Message.*ReadPixels/i.test(message) ||
    /Unable to load glyph range .*fonts\/Open Sans Regular,Arial Unicode MS Regular/i.test(message);
}

async function boot(page) {
  const packdPort = new URL(PACKD_URL).port;
  await page.addInitScript(({ envdUrl }) => {
    try {
      localStorage.clear();
      sessionStorage.clear();
    } catch (e) {}
    window.HELM_WX_PACKS_BASE = '/.helmcxx4-e2e/wx';
    window.HELM_WX_CHUNK_BASE = envdUrl;
    window.__helmTime = '2026-07-01T00:00:00Z';
  }, { envdUrl: ENVD_URL });
  await page.goto(`/?basemapPort=${packdPort}${HASH}`);
  await expect(page).toHaveTitle(/Helm/);
  await page.waitForFunction(() => window.map && window.map.isStyleLoaded && window.map.isStyleLoaded(), null, { timeout: 30000 });
  await page.waitForFunction(() => window.HelmHealthPanel && window.HelmOfflinePacks && window.HelmWxGridPacks && window.HelmWxGrid, null, { timeout: 30000 });
}

async function clickRail(page, rail) {
  const button = page.locator(`.ri[data-rail="${rail}"]`);
  await expect(button, `rail ${rail}`).toBeVisible({ timeout: 10000 });
  await button.click();
}

test('C++ runtime drives the cockpit: chart, packs, weather, nav, health, and offline guards', async ({ page, request }) => {
  ensureEvidenceDir();
  const consoleMessages = [];
  const pageErrors = [];
  const failedRequests = [];
  const providerFetches = [];
  const chartResponses = [];
  const localRuntimeResponses = [];

  page.on('console', msg => {
    if (['error', 'warning'].includes(msg.type())) consoleMessages.push(`${msg.type()}: ${msg.text()}`);
  });
  page.on('pageerror', err => pageErrors.push(String(err && err.message || err)));
  page.on('requestfailed', req => failedRequests.push({ url: req.url(), error: req.failure() && req.failure().errorText }));
  page.on('request', req => {
    const url = req.url();
    if (isWeatherProvider(url)) providerFetches.push(url);
  });
  page.on('response', resp => {
    const url = resp.url();
    if (url.includes('/chart/')) chartResponses.push({ url, status: resp.status(), headers: resp.headers() });
    if (PACKD_URL && url.startsWith(PACKD_URL)) localRuntimeResponses.push({ service: 'packd', url, status: resp.status() });
    if (ENVD_URL && url.startsWith(ENVD_URL)) localRuntimeResponses.push({ service: 'envd', url, status: resp.status() });
  });

  const health = await request.get('/health');
  expect(health.ok(), '/health responds from helm-server').toBeTruthy();
  const healthJson = await health.json();
  expect(healthJson.engine).toBe('helm-server');
  expect(healthJson.chart_loaded).toBe(true);
  expect(healthJson.chart_status).toBe('loaded');

  expect((await (await request.get(`${PACKD_URL}/health`)).json()).engine).toBe('helm-packd');
  expect((await (await request.get(`${CACHE_URL}/health`)).json()).engine).toBe('helm-basemap-cache');
  expect((await (await request.get(`${ENVD_URL}/health`)).json()).engine).toBe('helm-envd');

  const center = hashCenter(HASH);
  const z = Math.max(10, Math.min(12, Math.round(center.zoom)));
  const tile = await request.get(`/chart/${z}/${lon2tile(center.lon, z)}/${lat2tile(center.lat, z)}.png`);
  expect(tile.status(), 'center chart tile HTTP status').toBe(200);
  expect(tile.headers()['content-type']).toContain('image/png');
  expect(tile.headers()['x-helm-chart-status']).toBe('loaded');
  expect((await tile.body()).byteLength, 'center chart tile should not be the tiny no-chart fallback').toBeGreaterThan(1000);

  await boot(page);
  await page.screenshot({ path: path.join(EVIDENCE_DIR, '01-boot-cockpit.png'), fullPage: true });

  await expect(page.locator('#degraded-banner')).toBeHidden();
  await expect(page.locator('#data-src')).toContainText(/LIVE|ENGINE|SIM POS/, { timeout: 15000 });
  await expect(page.locator('#nv-pos')).not.toHaveText('', { timeout: 15000 });
  await expect(page.locator('#nv-sog')).not.toHaveText('', { timeout: 15000 });

  await clickRail(page, 'helm-client-health');
  await page.locator('#helm-client-health [data-act="refresh"]').click();
  await expect(page.locator('#helm-client-health')).toContainText('helm-server', { timeout: 10000 });
  await expect(page.locator('#helm-client-health')).toContainText('Subsystems');
  await expect(page.locator('#helm-client-health')).toContainText('Navigation');
  await expect(page.locator('#helm-client-health')).toContainText('AIS');
  const healthSnapshot = await page.evaluate(() => window.HelmHealthPanel.snapshot());
  expect(healthSnapshot.health.payload.engine).toBe('helm-server');
  expect(healthSnapshot.subsystems.chart.label).toBe('loaded');
  fs.writeFileSync(path.join(EVIDENCE_DIR, 'health-panel-snapshot.json'), JSON.stringify(healthSnapshot, null, 2));
  await page.screenshot({ path: path.join(EVIDENCE_DIR, '02-health-panel.png'), fullPage: true });

  await clickRail(page, 'helm-offline-packs');
  await page.waitForFunction(() => window.HelmOfflinePacks && window.HelmOfflinePacks.state.packs.length > 0, null, { timeout: 15000 });
  const packState = await page.evaluate(() => ({
    count: window.HelmOfflinePacks.state.packs.length,
    ids: window.HelmOfflinePacks.state.packs.map(p => p.id),
  }));
  expect(packState.count).toBeGreaterThan(0);
  await page.evaluate(() => window.HelmOfflinePacks.activate(window.HelmOfflinePacks.state.packs[0].id, { fit: false }));
  await page.waitForFunction(() => window.map && window.map.getLayer && window.map.getLayer('helm-offline-active-pack'), null, { timeout: 15000 });
  await expect(page.locator('#helm-offline-packs')).toContainText(/local pack/);
  await page.screenshot({ path: path.join(EVIDENCE_DIR, '03-offline-pack-active.png'), fullPage: true });

  await clickRail(page, 'weather');
  await page.locator('#wx button[data-wx="wind"]').click();
  const hasWebGpu = await page.evaluate(async () => !!(navigator.gpu && await navigator.gpu.requestAdapter().catch(() => null)));
  if (hasWebGpu) {
    await page.waitForFunction(() => window.__helmWxGridStatus && window.__helmWxGridStatus.state === 'on' && window.__helmWxGridStatus.layer === 'wind', null, { timeout: 25000 });
    await expect(page.locator('#wx-notice')).toContainText('grid pack');
    await expect.poll(async () => page.evaluate(() => window.HelmWxGrid.sample(window.map.getCenter().lat, window.map.getCenter().lng))).toMatchObject({
      schema: 'helm.layer.sample.v1',
      coverage: 'in',
    });
    await expect.poll(async () => page.evaluate(() => ({
      shown: getComputedStyle(document.querySelector('#time')).display !== 'none',
      max: document.querySelector('#tslider').max,
    }))).toEqual({ shown: true, max: '1' });
    await page.locator('#tslider').evaluate(el => { el.value = '1'; el.dispatchEvent(new Event('input', { bubbles: true })); });
    await expect.poll(async () => page.evaluate(() => window.__helmWxGridStatus.frames.a)).toBe('2026-07-01T03:00:00Z');
    await page.locator('#wx button[data-wx="rain"]').click();
    await page.waitForFunction(() => window.__helmWxGridStatus && window.__helmWxGridStatus.state === 'on' && window.__helmWxGridStatus.layer === 'rain', null, { timeout: 20000 });
  } else {
    await expect(page.locator('#wx-notice')).toContainText('unsupported_renderer_capability', { timeout: 25000 });
    await expect(page.locator('#wx-notice')).toContainText('no gateway/direct fallback/download');
  }
  fs.writeFileSync(path.join(EVIDENCE_DIR, 'wx-grid-status.json'), JSON.stringify(await page.evaluate(() => window.__helmWxGridStatus || null), null, 2));
  await page.screenshot({ path: path.join(EVIDENCE_DIR, '04-weather-proof.png'), fullPage: true });

  await page.evaluate(({ lon, lat }) => window.map.jumpTo({ center: [lon, lat], zoom: 10 }), { lon: center.lon, lat: center.lat });
  await page.waitForTimeout(350);
  await page.evaluate(() => window.map.zoomIn({ duration: 0 }));
  await page.waitForTimeout(350);
  await page.evaluate(() => window.map.zoomOut({ duration: 0 }));
  await page.waitForTimeout(350);
  await expect(page.locator('#map canvas.maplibregl-canvas')).toBeVisible();
  await expect(page.locator('#degraded-banner')).toBeHidden();
  await page.screenshot({ path: path.join(EVIDENCE_DIR, '05-pan-zoom-no-blank.png'), fullPage: true });

  const chartOk = chartResponses.some(r => r.status === 200 && r.headers['x-helm-chart-status'] === 'loaded');
  expect(chartOk, `chart responses: ${JSON.stringify(chartResponses.slice(0, 8))}`).toBe(true);
  expect(localRuntimeResponses.some(r => r.service === 'packd' && r.status === 200), 'browser contacted helm-packd for local packs').toBe(true);
  if (hasWebGpu) expect(localRuntimeResponses.some(r => r.service === 'envd' && r.status === 200), 'browser contacted helm-envd for grid chunks').toBe(true);
  expect(providerFetches, 'offline proof must not call weather/provider fallbacks').toEqual([]);
  expect(pageErrors, 'no uncaught page errors').toEqual([]);
  expect(failedRequests.filter(r => !isBenignFailedRequest(r.url)), 'no non-benign failed requests').toEqual([]);
  expect(consoleMessages.filter(m => !isBenignConsoleMessage(m)), 'no unexpected console errors/warnings').toEqual([]);
});
