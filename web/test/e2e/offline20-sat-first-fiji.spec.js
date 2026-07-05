// OFFLINE-20: satellite-first Fiji overlay proof.
//
// Opt-in because the full proof uses local packs/services and may need a real
// WebGPU adapter. In mock-packd mode it still exercises the cockpit client,
// generated numeric WX pack, screenshots, no-network guard, and fail-loud
// fallback path without touching the live :8080 boat screen.
const { test, expect } = require('@playwright/test');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ENABLED = !!process.env.HELM_OFFLINE20;
const MOCK_PACKD = process.env.HELM_OFFLINE20_MOCK_PACKD === '1';
const PACKD_ORIGIN = process.env.HELM_OFFLINE20_PACKD_URL || 'http://127.0.0.1:9141';
const PACKD_PORT = new URL(PACKD_ORIGIN).port || '9141';
const CHUNK_ENDPOINT = process.env.HELM_OFFLINE20_CHUNK_ENDPOINT || '';
const FIJI_HASH = process.env.HELM_OFFLINE20_HASH || '#9/-17.75/178.12';
const EVIDENCE_DIR = process.env.HELM_OFFLINE20_EVIDENCE_DIR || '';
const WEB = path.resolve(__dirname, '..', '..');
const ROOT = path.resolve(WEB, '..');
const OUT = path.join(WEB, 'test-results', 'offline20-e2e');
const WX_DIR = path.join(OUT, 'wx');
const PRIVATE_PATH_PATTERN = new RegExp(['/Users/', 'CloudStorage', 'Drop' + 'box', 'COS/Charts', 'steve' + 'ridder'].join('|'), 'i');

test.skip(!ENABLED, 'Set HELM_OFFLINE20=1 to run the satellite-first Fiji overlay proof.');

function asJsonText(obj) {
  return JSON.stringify(obj, null, 2);
}

function localOnly(urlText) {
  const u = new URL(urlText);
  if (u.protocol === 'blob:' || u.protocol === 'data:') return true;
  return ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(u.hostname);
}

function evidencePath(name) {
  if (!EVIDENCE_DIR) return '';
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  return path.join(EVIDENCE_DIR, name);
}

async function screenshot(page, name) {
  const out = evidencePath(name);
  if (out) await page.screenshot({ path: out, fullPage: false });
}

function denseManifest() {
  const base = JSON.parse(fs.readFileSync(path.join(ROOT, 'services/wx/fixtures/helm-env-grid-v1.json'), 'utf8'));
  const times = ['2026-07-01T00:00:00Z', '2026-07-01T03:00:00Z'];
  const chunks = {};
  for (const vt of times) {
    const id = vt.replace(/[-:]/g, '');
    for (let lon = -180; lon < 180; lon += 60) {
      for (let lat = -90; lat < 90; lat += 60) {
        chunks[`global-low/wind/${id}/${lon}_${lat}`] = {
          schema: 'helm.env.grid.chunk.v1',
          tier: 'global-low',
          layer: 'wind',
          validTime: vt,
          bbox: [lon, lat, lon + 60, lat + 60]
        };
      }
    }
  }
  base.packId = 'offline20/fiji/sat-first/wind';
  base.generatedAt = '2026-07-01T00:15:00Z';
  base.source = Object.assign({}, base.source || {}, {
    provider: 'fixture',
    model: 'offline20-fiji-proof',
    provenance: 'OFFLINE-20 generated numeric grid fixture',
    advisory: true,
    notForNavigation: true
  });
  base.run.validTimes = times;
  base.chunks = chunks;
  return base;
}

test.beforeAll(() => {
  fs.mkdirSync(WX_DIR, { recursive: true });
  const manifestIn = path.join(WX_DIR, 'manifest-in.json');
  fs.writeFileSync(manifestIn, JSON.stringify(denseManifest(), null, 1));
  execFileSync('python3', [
    path.join(ROOT, 'scripts/env_grid_pack.py'),
    'pack',
    manifestIn,
    path.join(WX_DIR, 'offline20-wx.pmtiles'),
    '--manifest-out',
    path.join(WX_DIR, 'manifest.json')
  ], { cwd: ROOT, stdio: 'pipe' });
});

async function packdJson(request, pathname) {
  const resp = await request.get(PACKD_ORIGIN + pathname);
  expect(resp.ok(), `${pathname} responds from local helm-packd`).toBeTruthy();
  return resp.json();
}

function mockCatalog(baseURL) {
  return {
    'fiji-sat': {
      id: 'fiji-sat',
      title: 'Fiji offline satellite PMTiles',
      kind: 'raster',
      container: 'pmtiles',
      format: 'png',
      minzoom: 0,
      maxzoom: 9,
      bounds_array: [176.8, -19.2, 180.0, -16.0],
      pmtiles_url: new URL('/data/fiji-sat.pmtiles', baseURL).href,
      source_info: {
        label: 'repo Fiji satellite fixture',
        license: 'test fixture'
      },
      freshness: {
        status: 'fixture'
      },
      inspection: {
        mode: 'raster_metadata',
        semantic_objects: 'unavailable',
        tap_action: 'show_pack_source_metadata',
        message: 'Satellite raster pixels only; nautical objects require a sidecar layer.'
      }
    }
  };
}

function mockLayers() {
  return {
    schema: 'helm.layer_inventory.v1',
    layers: [{
      component_id: 'pack:fiji-sat',
      dataset_name: 'Fiji offline satellite PMTiles',
      kind: 'raster',
      source: { label: 'repo Fiji satellite fixture' },
      freshness: { status: 'fixture' },
      coverage: { bbox: [176.8, -19.2, 180.0, -16.0] },
      inspection: {
        mode: 'raster_metadata',
        semantic_objects: 'unavailable',
        tap_action: 'show_pack_source_metadata'
      }
    }]
  };
}

function packdRoutePattern(pathname, suffix = '') {
  return new RegExp(`^https?://(?:127\\.0\\.0\\.1|localhost|\\[::1\\]):${PACKD_PORT}${pathname}${suffix}$`);
}

test('satellite-first Fiji base + MapLibre depth + WebGPU grid proof/fallback', async ({ page, request, baseURL }) => {
  const externalRequests = [];
  const failedRequests = [];
  const packResponses = [];
  const consoleLines = [];

  await page.route('**/*', route => {
    const url = route.request().url();
    if (!localOnly(url)) {
      externalRequests.push(url);
      return route.abort('blockedbyclient');
    }
    if (/\/\/(?:127\.0\.0\.1|localhost):8091\//.test(url)) {
      failedRequests.push({ url, error: 'blocked legacy :8091 static style request' });
      return route.abort('blockedbyclient');
    }
    return route.continue();
  });

  if (MOCK_PACKD) {
    await page.route(packdRoutePattern('/catalog'), route => route.fulfill({
      contentType: 'application/json',
      body: asJsonText(mockCatalog(baseURL))
    }));
    await page.route(packdRoutePattern('/layers'), route => route.fulfill({
      contentType: 'application/json',
      body: asJsonText(mockLayers())
    }));
    await page.route(packdRoutePattern('/bundle', '(?:[?#].*)?'), route => route.fulfill({
      contentType: 'application/json',
      body: asJsonText({ schema: 'helm.region_bundle.manifest.v1', summary: { packs: 1, mode: 'mock' } })
    }));
    await page.route(packdRoutePattern('/prefetch', '(?:[?#].*)?'), route => route.fulfill({
      contentType: 'application/json',
      body: asJsonText({ schema: 'helm.prefetch.manifest.v1', totals: { bytes: 0, mode: 'mock' } })
    }));
  }

  page.on('requestfailed', req => failedRequests.push({ url: req.url(), error: req.failure() && req.failure().errorText }));
  page.on('response', resp => {
    if (resp.url().startsWith(PACKD_ORIGIN + '/') || /\/data\/fiji-sat\.pmtiles\b/.test(resp.url())) {
      packResponses.push({
        url: resp.url(),
        status: resp.status(),
        bytes: Number(resp.headers()['content-length'] || 0),
        type: resp.headers()['content-type'] || ''
      });
    }
  });
  page.on('console', msg => {
    if (['error', 'warning'].includes(msg.type())) consoleLines.push({ type: msg.type(), text: msg.text() });
  });

  const catalog = MOCK_PACKD ? mockCatalog(baseURL) : await packdJson(request, '/catalog');
  const catalogText = asJsonText(catalog);
  expect(catalogText, 'catalog must not leak private filesystem paths').not.toMatch(PRIVATE_PATH_PATTERN);
  const packs = Object.values(catalog || {});
  const satPack = packs.find(p => /(fiji|bing|google|arcgis).*sat|sat.*(fiji|bing|google|arcgis)|BingSat|GoogleSat/i.test(`${p.id || ''} ${p.title || ''}`));
  expect(satPack, 'Fiji satellite pack is visible in /catalog').toBeTruthy();

  const layers = MOCK_PACKD ? mockLayers() : await packdJson(request, '/layers');
  const layersText = asJsonText(layers);
  expect(layersText, '/layers must not leak private filesystem paths').not.toMatch(PRIVATE_PATH_PATTERN);

  await page.goto('/?offline20=1&basemapPort=' + new URL(PACKD_ORIGIN).port + FIJI_HASH);
  await expect(page).toHaveTitle(/Helm/);
  await page.waitForFunction(
    () => !!window.map && window.map.isStyleLoaded && window.map.isStyleLoaded() && !!window.HelmOfflinePacks && !!window.HelmWxGrid,
    null,
    { timeout: 30000 }
  );

  await page.evaluate(() => window.HelmShell.panel('helm-offline-packs').open());
  await page.waitForFunction(
    () => window.HelmOfflinePacks.state.packs.some(p => /(fiji|bing|google|arcgis).*sat|sat.*(fiji|bing|google|arcgis)|BingSat|GoogleSat/i.test(`${p.id || ''} ${p.title || ''}`)),
    null,
    { timeout: 10000 }
  );
  await page.evaluate(() => {
    const pack = window.HelmOfflinePacks.state.packs.find(p => /(fiji|bing|google|arcgis).*sat|sat.*(fiji|bing|google|arcgis)|BingSat|GoogleSat/i.test(`${p.id || ''} ${p.title || ''}`));
    window.HelmOfflinePacks.activate(pack.id, { fit: false });
  });
  await page.waitForFunction(() => !!window.map.getLayer('helm-offline-active-pack') && !!document.getElementById('helm-offline20-strip'));
  await page.waitForTimeout(1400);
  await screenshot(page, 'offline20-01-default-fiji-satellite.png');

  const baseState = await page.evaluate(() => {
    const map = window.map;
    return {
      activeId: window.HelmOfflinePacks.state.activeId,
      source: map.getStyle().sources['helm-offline-active-pack'],
      strip: document.getElementById('helm-offline20-strip') && document.getElementById('helm-offline20-strip').innerText,
      center: map.getCenter().toArray(),
      zoom: map.getZoom()
    };
  });
  expect(baseState.source, 'offline satellite source is installed').toBeTruthy();
  expect(baseState.source.tiles[0], 'offline source is PMTiles-backed').toMatch(/^pmtiles:\/\//);
  expect(baseState.strip, 'source/freshness/debug strip visible').toMatch(/SAT-FIRST FIJI/);
  expect(baseState.strip).toMatch(/BASE/i);

  await page.evaluate(() => {
    for (const id of ['depare-fill', 'depcnt-line', 'soundg-text']) {
      if (window.map.getLayer(id)) window.map.setLayoutProperty(id, 'visibility', 'visible');
    }
    window.HelmOfflinePacks.refreshOffline20Strip();
  });
  await page.waitForTimeout(800);
  await screenshot(page, 'offline20-02-satellite-depth-layers-ready.png');
  const depthState = await page.evaluate(() => ({
    depare: !!window.map.getLayer('depare-fill'),
    depcnt: !!window.map.getLayer('depcnt-line'),
    soundg: !!window.map.getLayer('soundg-text'),
    fijiRenderedDepthHits: window.map.queryRenderedFeatures(undefined, { layers: ['depare-fill', 'depcnt-line', 'soundg-text'].filter(id => window.map.getLayer(id)) }).length,
    strip: document.getElementById('helm-offline20-strip').innerText
  }));
  expect(depthState.depare || depthState.depcnt || depthState.soundg, 'MapLibre depth/feature layers exist').toBeTruthy();
  expect(depthState.strip).toMatch(/DEPTH/i);

  const hasGpu = await page.evaluate(async () =>
    !!(navigator.gpu && await navigator.gpu.requestAdapter().catch(() => null)));
  const manifestUrl = process.env.HELM_OFFLINE20_WX_MANIFEST_URL || '/test-results/offline20-e2e/wx/manifest.json';
  const wxResult = await page.evaluate(([m, endpoint]) =>
    window.HelmWxGrid.enable(window.map, {
      manifestUrl: m,
      layer: 'wind',
      when: '2026-07-01T01:30:00Z',
      opacity: 0.72,
      transport: endpoint ? { chunkEndpoint: endpoint } : null
    }).then(st => ({ ok: true, st })).catch(e => ({ ok: false, code: e.code, message: e.message })),
  [manifestUrl, CHUNK_ENDPOINT]);
  await page.evaluate(() => window.HelmOfflinePacks.refreshOffline20Strip());
  await page.waitForTimeout(1000);
  await screenshot(page, hasGpu ? 'offline20-03-webgpu-grid-overlay.png' : 'offline20-03-webgpu-fallback.png');

  if (hasGpu) {
    expect(wxResult.ok, 'WebGPU host should enable the grid overlay').toBe(true);
    await expect(page.locator('.helm-wx-grid-canvas')).toHaveCount(1);
  } else {
    expect(wxResult.ok, 'no-WebGPU host must fail loud rather than substitute').toBe(false);
    expect(wxResult.code).toBe('unsupported_renderer_capability');
  }

  const wxState = await page.evaluate(() => ({
    status: window.HelmWxGrid.status(),
    strip: document.getElementById('helm-offline20-strip').innerText
  }));
  expect(wxState.status.packId || wxState.status.diagnostics.length, 'WX status carries pack or capability diagnostic').toBeTruthy();
  expect(wxState.strip).toMatch(/WX/i);
  expect(wxState.strip).toMatch(/offline20\/fiji\/sat-first\/wind|unsupported_renderer_capability|not enabled/);

  const missing = await page.evaluate(([m, endpoint]) =>
    window.HelmWxGrid.enable(window.map, {
      manifestUrl: m,
      layer: 'waves',
      transport: endpoint ? { chunkEndpoint: endpoint } : null
    }).then(st => ({ ok: true, st })).catch(e => ({ ok: false, code: e.code, message: e.message })),
  [manifestUrl, CHUNK_ENDPOINT]);
  expect(missing.ok).toBe(false);
  expect(missing.code).toBe('out_of_pack');
  await page.evaluate(() => {
    window.map.jumpTo({ center: [178.2, -24.5], zoom: 8 });
    window.HelmOfflinePacks.refreshOffline20Strip();
  });
  await page.waitForTimeout(900);
  await expect(page.locator('#helm-coverage-badge')).toContainText('Outside offline chart coverage');
  await screenshot(page, 'offline20-04-fallback-out-of-coverage.png');

  await page.mouse.click(640, 380);
  await expect(page.locator('.helm-raster-inspect')).toContainText(/outside the selected offline pack coverage|Raster packs contain pixels only|Satellite raster pixels only/i);
  await screenshot(page, 'offline20-05-raster-source-inspect.png');

  const evidence = {
    packd: PACKD_ORIGIN,
    mock_packd: MOCK_PACKD,
    selected_sat_pack: baseState.activeId,
    base_state: baseState,
    depth_state: depthState,
    has_webgpu_adapter: hasGpu,
    wx_enable: wxResult,
    wx_missing_layer: missing,
    wx_status: wxState.status,
    strip_text: wxState.strip,
    pack_responses: packResponses.slice(0, 40),
    failed_requests: failedRequests.slice(0, 40),
    external_requests: externalRequests,
    console: consoleLines.slice(0, 40)
  };
  const jsonOut = evidencePath('offline20-evidence.json');
  if (jsonOut) fs.writeFileSync(jsonOut, asJsonText(evidence));

  expect(externalRequests, 'offline proof blocks internet requests; app should not need them').toEqual([]);
  expect(packResponses.some(r => r.status === 200 || r.status === 206), 'offline satellite pack bytes were requested locally').toBe(true);
  expect(consoleLines.filter(c => /TypeError|ReferenceError|Unhandled|failed to load style/i.test(c.text)), 'no fatal console errors').toEqual([]);
});
