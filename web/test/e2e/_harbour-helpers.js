// Shared helpers for harbour / live helm-server Playwright proofs.
const { expect } = require('@playwright/test');

const BOOT_TIMEOUT = Number(process.env.HELM_E2E_BOOT_TIMEOUT || 60000);
const HASH = process.env.HELM_HARBOUR_HASH || process.env.HELM_QA1_HASH || '#12/24.5/-81.8';

function hashCenter(hash) {
  const m = String(hash || '').match(/^#?(\d+(?:\.\d+)?)\/(-?\d+(?:\.\d+)?)\/(-?\d+(?:\.\d+)?)/);
  if (!m) throw new Error(`Bad harbour hash: ${hash}`);
  return { zoom: Number(m[1]), lat: Number(m[2]), lon: Number(m[3]) };
}

function lon2tile(lon, z) {
  return Math.floor((lon + 180) / 360 * Math.pow(2, z));
}

function lat2tile(lat, z) {
  const r = lat * Math.PI / 180;
  return Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * Math.pow(2, z));
}

function isBenignConsoleMessage(message) {
  return /unsupported_renderer_capability|WebGPU|No available adapters|Failed to load resource|favicon/i.test(message) ||
    /GL Driver Message.*ReadPixels/i.test(message) ||
    /Unable to load glyph range/i.test(message) ||
    /basemap source/i.test(message) ||
    /pmtiles/i.test(message);
}

function isBenignFailedRequest(url) {
  return /favicon\.ico|sprite|glyph|\.(png|pbf|jpg|webp)/i.test(url) ||
    /\/user-data\/(?:depcnt|depare|soundg)\.geojson$/i.test(url) ||
    /:8091\//.test(url) ||
    /:8095\//.test(url) ||
    /\/tides\//.test(url);
}

async function clickRail(page, rail) {
  const button = page.locator(`.ri[data-rail="${rail}"]`);
  await expect(button, `rail ${rail}`).toBeVisible({ timeout: 15000 });
  await button.click();
}

async function bootHarbour(page, opts) {
  opts = opts || {};
  const hash = opts.hash || HASH;
  const query = (opts.query || '').replace(/^\?/, '');
  const hashPart = hash.startsWith('#') ? hash : ('#' + hash);
  const url = '/' + (query ? ('?' + query) : '') + hashPart;

  if (opts.initScript) {
    await page.addInitScript(opts.initScript);
  }

  await page.goto(url);
  await expect(page).toHaveTitle(/Helm/);
  await page.waitForFunction(
    () => !!window.map && typeof window.__helmDegrade === 'function',
    null,
    { timeout: BOOT_TIMEOUT }
  );
  await page.waitForFunction(
    () => window.map.isStyleLoaded && window.map.isStyleLoaded(),
    null,
    { timeout: BOOT_TIMEOUT }
  );
  if (opts.waitRendererStatus !== false) {
    await page.waitForFunction(
      () => window.__helmChartRendererStatus && window.__helmChartRendererStatus.schema,
      null,
      { timeout: BOOT_TIMEOUT }
    );
  }
  if (opts.waitArtifact) {
    await page.waitForFunction(
      () => window.__helmChartRendererStatus &&
        window.__helmChartRendererStatus.artifact &&
        window.__helmChartRendererStatus.artifact.schema_version,
      null,
      { timeout: BOOT_TIMEOUT }
    );
  }
}

async function layerVisibility(page, layerId) {
  return page.evaluate((id) => {
    try {
      if (!window.map.getLayer(id)) return 'missing';
      return window.map.getLayoutProperty(id, 'visibility') || 'visible';
    } catch (e) {
      return 'error:' + (e && e.message);
    }
  }, layerId);
}

async function collectRendererState(page) {
  return page.evaluate(() => ({
    status: window.__helmChartRendererStatus || null,
    mode: window.__helmChartMode || '',
    reason: window.__helmChartModeReason || '',
    artifactLoaded: !!(window.__helmChartArtifact && window.__helmChartArtifact.getArtifact &&
      window.__helmChartArtifact.getArtifact()),
    gpuCanvas: !!document.querySelector('.helm-chart-artifact-canvas'),
    gpuCanvasDisplay: (() => {
      const c = document.querySelector('.helm-chart-artifact-canvas');
      return c ? getComputedStyle(c).display : 'none';
    })(),
    degradeVisible: (() => {
      const el = document.getElementById('degraded');
      return !!(el && el.style.display !== 'none' && el.textContent);
    })()
  }));
}

async function fetchCatalogEncCenter(request) {
  const catalog = await request.get('/catalog');
  expect(catalog.ok(), '/catalog must respond').toBeTruthy();
  const body = await catalog.json();
  expect(body.chart_loaded !== false, 'catalog should report chart_loaded').toBeTruthy();
  expect(body.cells && body.cells.length, 'catalog must list at least one ENC cell').toBeGreaterThan(0);
  const cell = body.cells[0];
  const bbox = cell.bbox || [];
  expect(bbox.length, 'catalog cell needs bbox [wlon,slat,elon,nlat]').toBe(4);
  return {
    cellId: cell.id,
    edition: cell.edition,
    lon: (bbox[0] + bbox[2]) / 2,
    lat: (bbox[1] + bbox[3]) / 2,
    zoom: 14,
    bbox
  };
}

function encHash(center) {
  return `#${center.zoom}/${center.lat}/${center.lon}`;
}

async function dragMapBy(page, dx, dy) {
  const map = page.locator('#map');
  await expect(map).toBeVisible();
  const box = await map.boundingBox();
  if (!box) throw new Error('map bounding box unavailable');
  const sx = box.x + box.width * 0.5;
  const sy = box.y + box.height * 0.5;
  await page.mouse.move(sx, sy);
  await page.mouse.down();
  await page.mouse.move(sx + dx, sy + dy, { steps: 12 });
  await page.mouse.up();
}

async function clickMapCenter(page) {
  const map = page.locator('#map');
  const box = await map.boundingBox();
  if (!box) throw new Error('map bounding box unavailable');
  await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.5);
}

async function fireMapClickAt(page, lng, lat) {
  return page.evaluate(({ lng, lat }) => {
    if (!window.map) return { ok: false, reason: 'no map' };
    const pt = window.map.project([lng, lat]);
    window.map.fire('click', {
      lngLat: { lng: lng, lat: lat },
      point: { x: pt.x, y: pt.y },
      originalEvent: { detail: 1 }
    });
    return {
      ok: true,
      trace: window.__helmChartInspectTrace || null,
      visible: !!(window.__helmChartArtifact && window.__helmChartArtifact.isVisible &&
        window.__helmChartArtifact.isVisible())
    };
  }, { lng, lat });
}

async function waitMapIdle(page) {
  await page.waitForFunction(
    () => window.map && window.map.isStyleLoaded() && !window.map.isMoving(),
    null,
    { timeout: 30000 }
  );
}

async function inspectPopupState(page) {
  const popup = page.locator('.maplibregl-popup');
  const count = await popup.count();
  if (!count) return { open: false, text: '', isNoHit: false };
  const text = await popup.first().innerText();
  return {
    open: true,
    text,
    isNoHit: /No object|no hit|No nautical primitive hit/i.test(text)
  };
}

function webgpuPrimaryExpectations(state) {
  return state.status.active_renderer === 'webgpu' && state.mode === 'gpu';
}

function attachHarbourDiagnostics(page, bag) {
  page.on('console', msg => {
    if (['error', 'warning'].includes(msg.type()) && !isBenignConsoleMessage(msg.text())) {
      bag.console.push(`${msg.type()}: ${msg.text()}`);
    }
  });
  page.on('pageerror', err => bag.pageErrors.push(String(err && err.message || err)));
  page.on('requestfailed', req => {
    const url = req.url();
    if (!isBenignFailedRequest(url)) {
      bag.failedRequests.push({ url, error: req.failure() && req.failure().errorText });
    }
  });
}

module.exports = {
  BOOT_TIMEOUT,
  HASH,
  hashCenter,
  lon2tile,
  lat2tile,
  isBenignConsoleMessage,
  isBenignFailedRequest,
  clickRail,
  bootHarbour,
  layerVisibility,
  collectRendererState,
  attachHarbourDiagnostics,
  fetchCatalogEncCenter,
  encHash,
  dragMapBy,
  clickMapCenter,
  fireMapClickAt,
  waitMapIdle,
  inspectPopupState,
  webgpuPrimaryExpectations
};
