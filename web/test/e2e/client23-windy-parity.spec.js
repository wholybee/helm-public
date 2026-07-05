// CLIENT-23 — Windy-parity visual/performance gates for compact-grid environmental layers.
//
// This is deliberately a browser gate, not a backend bake. It creates a deterministic
// helm.env.grid.v1 PMTiles-like pack locally, renders it through HelmWxGrid, then hammers
// pan/zoom/time/layer changes while proving:
//   - core layers are available from compact numeric grids, not gateway/provider fetches;
//   - layer changes and zoom 3↔10 gestures do not trigger hidden upstream downloads;
//   - GPU hosts produce screenshots + frame/memory metrics for visual review;
//   - non-WebGPU hosts fail loud with unsupported_renderer_capability after data validation.
const { test, expect } = require('@playwright/test');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const WEB = path.resolve(__dirname, '..', '..');
const ROOT = path.resolve(WEB, '..');
const OUT = path.join(WEB, '.client23-e2e');
const TIMES = ['2026-07-01T00:00:00Z', '2026-07-01T03:00:00Z', '2026-07-01T06:00:00Z'];
const LAYERS = ['wind', 'rain', 'waves', 'swell', 'current', 'pressure'];

function compactTime(iso) {
  return iso.replace(/[-:]/g, '');
}

function client23Manifest() {
  const base = JSON.parse(fs.readFileSync(path.join(ROOT, 'services/wx/fixtures/helm-env-grid-v1.json'), 'utf8'));
  base.packId = 'synthetic/client23/20260701T000000Z/global-low';
  base.generatedAt = '2026-07-01T00:30:00Z';
  base.run.validTimes = TIMES;
  base.tiers = {
    'global-low': {
      role: 'overview',
      crs: 'OGC:CRS84',
      grid: { dx: 20.0, dy: 20.0, width: 18, height: 10, origin: 'northwest' },
      chunking: { lonSpan: 60.0, latSpan: 60.0 },
      clientZoomRange: [0, 10]
    }
  };
  base.layers = {
    wind: {
      kind: 'vector', tier: 'global-low',
      bands: {
        u: { type: 'int16', scale: 0.01, offset: 0.0, nodata: -32768, unit: 'm/s' },
        v: { type: 'int16', scale: 0.01, offset: 0.0, nodata: -32768, unit: 'm/s' }
      }
    },
    current: {
      kind: 'vector', tier: 'global-low',
      bands: {
        u: { type: 'int16', scale: 0.01, offset: 0.0, nodata: -32768, unit: 'm/s' },
        v: { type: 'int16', scale: 0.01, offset: 0.0, nodata: -32768, unit: 'm/s' }
      }
    },
    rain: {
      kind: 'scalar', tier: 'global-low',
      bands: { rate: { type: 'uint16', scale: 0.1, offset: 0.0, nodata: 65535, unit: 'mm/h' } }
    },
    waves: {
      kind: 'scalar', tier: 'global-low',
      bands: { height: { type: 'uint16', scale: 0.05, offset: 0.0, nodata: 65535, unit: 'm' } }
    },
    swell: {
      kind: 'scalar', tier: 'global-low',
      bands: { height: { type: 'uint16', scale: 0.05, offset: 0.0, nodata: 65535, unit: 'm' } }
    },
    pressure: {
      kind: 'scalar', tier: 'global-low',
      bands: { mslp: { type: 'int16', scale: 0.1, offset: 1013.0, nodata: -32768, unit: 'hPa' } }
    }
  };

  const chunks = {};
  for (const validTime of TIMES) {
    const vt = compactTime(validTime);
    for (const layer of LAYERS) {
      for (let lon = -180; lon < 180; lon += 60) {
        for (let lat = -90; lat < 90; lat += 60) {
          chunks[`global-low/${layer}/${vt}/${lon}_${lat}`] = {
            schema: 'helm.env.grid.chunk.v1',
            tier: 'global-low',
            layer,
            validTime,
            bbox: [lon, lat, lon + 60, lat + 60]
          };
        }
      }
    }
  }
  base.chunks = chunks;
  return base;
}

test.beforeAll(() => {
  fs.mkdirSync(OUT, { recursive: true });
  const manifestIn = path.join(OUT, 'manifest-in.json');
  fs.writeFileSync(manifestIn, JSON.stringify(client23Manifest(), null, 1));
  execFileSync('python3', [
    path.join(ROOT, 'scripts/env_grid_pack.py'), 'pack',
    manifestIn,
    path.join(OUT, 'client23.pmtiles'),
    '--manifest-out',
    path.join(OUT, 'manifest.json')
  ], { cwd: ROOT, stdio: 'pipe' });
});

async function boot(page) {
  await page.goto('/');
  await page.waitForFunction(() => window.map && window.HelmWxGrid && window.HelmWxGridPacks && window.HelmWxGridDecode, null, { timeout: 20000 });
  await page.waitForFunction(() => {
    const map = window.map;
    if (!map || typeof map.getStyle !== 'function') return false;
    if (typeof map.isStyleLoaded === 'function') return map.isStyleLoaded();
    const style = map.getStyle();
    return !!(style && style.sources && style.layers && style.layers.length);
  }, null, { timeout: 20000 });
}

async function routeSyntheticPack(page) {
  await page.route('**/.client23-e2e/manifest.json', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    path: path.join(OUT, 'manifest.json')
  }));
  await page.route('**/.client23-e2e/client23.pmtiles', route => {
    const bytes = fs.readFileSync(path.join(OUT, 'client23.pmtiles'));
    const range = route.request().headers().range || '';
    const match = /^bytes=(\d+)-(\d+)$/.exec(range);
    if (!match) {
      return route.fulfill({
        status: 200,
        contentType: 'application/octet-stream',
        body: bytes
      });
    }
    const start = Number(match[1]);
    const end = Math.min(Number(match[2]), bytes.length - 1);
    return route.fulfill({
      status: 206,
      contentType: 'application/octet-stream',
      headers: {
        'Accept-Ranges': 'bytes',
        'Content-Range': `bytes ${start}-${end}/${bytes.length}`
      },
      body: bytes.subarray(start, end + 1)
    });
  });
}

function enableGrid(page, layer, when, opacity) {
  return page.evaluate(([l, w, o]) => window.HelmWxGrid.enable(window.map, {
    manifestUrl: '/.client23-e2e/manifest.json',
    layer: l,
    when: w,
    opacity: o
  }).then(st => ({ ok: true, st })).catch(e => ({ ok: false, code: e.code, message: e.message, details: e.details || null })),
  [layer, when, opacity == null ? 0.82 : opacity]);
}

async function hasWebGpu(page) {
  return page.evaluate(async () => !!(navigator.gpu && await navigator.gpu.requestAdapter().catch(() => null)));
}

async function frameMetrics(page) {
  return page.evaluate(async () => {
    const mem0 = performance.memory ? performance.memory.usedJSHeapSize : null;
    const deltas = [];
    let last = await new Promise(resolve => requestAnimationFrame(resolve));
    for (let i = 0; i < 45; i++) {
      const now = await new Promise(resolve => requestAnimationFrame(resolve));
      deltas.push(now - last);
      last = now;
    }
    const sorted = deltas.slice().sort((a, b) => a - b);
    const avg = deltas.reduce((a, b) => a + b, 0) / deltas.length;
    return {
      frames: deltas.length,
      avgFrameMs: +avg.toFixed(2),
      p95FrameMs: +sorted[Math.floor(sorted.length * 0.95)].toFixed(2),
      maxFrameMs: +sorted[sorted.length - 1].toFixed(2),
      usedJSHeapSize: mem0
    };
  });
}

function isHiddenProviderFetch(url) {
  return /open-meteo|marine-api|customer-api|api\.windy\.com|:8093|\/wind\/\d+\/|\/rain\/\d+\//i.test(url);
}

test('compact-grid environmental layers survive Windy-style zoom, scrub, and layer gates', async ({ page }, testInfo) => {
  const requests = [];
  page.on('request', r => {
    const u = r.url();
    if (u.startsWith('data:') || u.startsWith('blob:')) return;
    requests.push(u);
  });

  await routeSyntheticPack(page);
  await boot(page);
  const gpu = await hasWebGpu(page);

  await page.evaluate(() => {
    window.__client23Errors = [];
    window.addEventListener('error', e => window.__client23Errors.push(String(e.message || e.error || e)));
    window.addEventListener('unhandledrejection', e => window.__client23Errors.push(String(e.reason && (e.reason.message || e.reason.code) || e.reason || e)));
  });

  const scenarios = [
    { layer: 'wind', center: [177.8, -17.8], zoom: 3.2, when: '2026-07-01T01:30:00Z', label: 'world-wind' },
    { layer: 'rain', center: [177.4, -17.6], zoom: 8.0, when: '2026-07-01T03:00:00Z', label: 'fiji-local-rain' },
    { layer: 'waves', center: [179.2, -18.2], zoom: 5.5, when: '2026-07-01T01:30:00Z', label: 'regional-waves' },
    { layer: 'swell', center: [-179.4, -17.2], zoom: 4.4, when: '2026-07-01T04:30:00Z', label: 'antimeridian-swell' },
    { layer: 'current', center: [178.0, -18.0], zoom: 6.5, when: '2026-07-01T01:30:00Z', label: 'regional-current' },
    { layer: 'pressure', center: [177.8, -17.8], zoom: 4.0, when: '2026-07-01T04:30:00Z', label: 'pressure-overview' }
  ];

  const metrics = { webgpu: gpu, scenarios: [] };
  for (const s of scenarios) {
    await page.evaluate(() => window.HelmWxGrid.disable());
    await page.evaluate(({ center, zoom }) => window.map.jumpTo({ center, zoom }), s);
    requests.length = 0;
    const res = await enableGrid(page, s.layer, s.when, 0.74);

    if (!gpu) {
      expect(res.ok, `${s.layer} should fail loud only at WebGPU capability gate`).toBe(false);
      expect(res.code).toBe('unsupported_renderer_capability');
      expect(requests.filter(isHiddenProviderFetch)).toEqual([]);
      continue;
    }

    expect(res.ok, `${s.layer} enable failed: ${JSON.stringify(res)}`).toBe(true);
    expect(res.st.state).toBe('on');
    expect(res.st.layer).toBe(s.layer);
    expect(await page.locator('.helm-wx-grid-canvas').count()).toBe(1);
    expect((await page.evaluate(() => window.__helmWxGridStatus)).diagnostics).toEqual([]);
    expect(requests.filter(isHiddenProviderFetch)).toEqual([]);

    const m = await frameMetrics(page);
    metrics.scenarios.push({ label: s.label, layer: s.layer, zoom: s.zoom, ...m });
    expect(m.p95FrameMs).toBeLessThan(80);

    await testInfo.attach(`client23-${s.label}.png`, {
      body: await page.screenshot({ fullPage: true }),
      contentType: 'image/png'
    });
  }

  if (gpu) {
    requests.length = 0;
    await page.evaluate(async () => {
      const centers = [[177.8, -17.8], [179.6, -18.2], [-179.4, -17.2], [170, -28], [-170, -12]];
      for (let i = 0; i < 20; i++) {
        window.map.jumpTo({ center: centers[i % centers.length], zoom: 3 + (i % 8) });
        await new Promise(r => setTimeout(r, 40));
      }
    });
    let st = await page.evaluate(() => window.__helmWxGridStatus);
    expect(st.state).toBe('on');
    expect(st.diagnostics).toEqual([]);
    expect(requests.filter(u => u.includes('/.client23-e2e/') || isHiddenProviderFetch(u))).toEqual([]);

    requests.length = 0;
    for (const when of TIMES.concat(['2026-07-01T01:30:00Z', '2026-07-01T04:30:00Z'])) {
      st = await page.evaluate(t => window.HelmWxGrid.setTime(t), when);
      expect(st.state).toBe('on');
      expect(st.diagnostics).toEqual([]);
      expect(await page.locator('.helm-wx-grid-canvas').count()).toBe(1);
    }
    expect(requests.filter(isHiddenProviderFetch)).toEqual([]);

    metrics.zoomHammer = await frameMetrics(page);
    expect(metrics.zoomHammer.p95FrameMs).toBeLessThan(80);
  } else {
    const status = await page.evaluate(() => window.__helmWxGridStatus);
    expect(status.diagnostics.some(d => d.code === 'unsupported_renderer_capability')).toBe(true);
    expect(await page.locator('.helm-wx-grid-canvas').count()).toBe(0);
  }

  const hiddenProviderFetches = requests.filter(isHiddenProviderFetch);
  expect(hiddenProviderFetches).toEqual([]);
  expect(await page.evaluate(() => window.__client23Errors)).toEqual([]);

  await testInfo.attach('client23-metrics.json', {
    body: Buffer.from(JSON.stringify(metrics, null, 2)),
    contentType: 'application/json'
  });
});
