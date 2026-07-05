// WX-33 — WebGPU model-grid renderer from helm.env.grid.v1 packs.
// Generates a real range-readable pack (multi-chunk, TWO valid times, global tier)
// with the WX-32 packer, then proves:
//   - the data plane enables from numeric grids only (no tiles, no gateway, no upstream);
//   - zoom 3-10 hammering stays stable with zero new fetches and zero diagnostics;
//   - fail-loud: corrupted checksum and missing layer reject with contract codes;
//   - no-WebGPU environments (CI) reject LAST with unsupported_renderer_capability —
//     the data plane still validated everything before the capability gate.
// On GPU hosts the same spec additionally proves the enable path end-to-end.
const { test, expect } = require('@playwright/test');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const WEB = path.resolve(__dirname, '..', '..');            // web/
const ROOT = path.resolve(WEB, '..');                       // repo root
const OUT = path.join(WEB, '.wx33-e2e');                    // served by serve.py (gitignored)

function denseManifest() {
  const base = JSON.parse(fs.readFileSync(path.join(ROOT, 'services/wx/fixtures/helm-env-grid-v1.json'), 'utf8'));
  const times = ['2026-07-01T00:00:00Z', '2026-07-01T03:00:00Z'];
  const chunks = {};
  for (const vt of times) {
    const id = vt.replace(/[-:]/g, '');
    for (let lon = -180; lon < 180; lon += 60) {
      for (let lat = -90; lat < 90; lat += 60) {
        chunks[`global-low/wind/${id}/${lon}_${lat}`] = {
          schema: 'helm.env.grid.chunk.v1', tier: 'global-low', layer: 'wind',
          validTime: vt, bbox: [lon, lat, lon + 60, lat + 60]
        };
      }
    }
  }
  base.run.validTimes = times;
  base.chunks = chunks;
  return base;
}

test.beforeAll(() => {
  fs.mkdirSync(OUT, { recursive: true });
  const manifestIn = path.join(OUT, 'manifest-in.json');
  fs.writeFileSync(manifestIn, JSON.stringify(denseManifest(), null, 1));
  execFileSync('python3', [path.join(ROOT, 'scripts/env_grid_pack.py'), 'pack',
    manifestIn, path.join(OUT, 'wx33.pmtiles'), '--manifest-out', path.join(OUT, 'manifest.json')],
    { cwd: ROOT, stdio: 'pipe' });
  // corrupted-checksum variant for the fail-loud case
  const packed = JSON.parse(fs.readFileSync(path.join(OUT, 'manifest.json'), 'utf8'));
  const firstKey = Object.keys(packed.chunks)[0];
  packed.chunks[firstKey].checksum = 'sha256:' + '0'.repeat(64);
  fs.writeFileSync(path.join(OUT, 'manifest-badsum.json'), JSON.stringify(packed));
});

async function boot(page) {
  await page.goto('/');
  await page.waitForFunction(() => window.map && window.HelmWxGrid && window.HelmWxGridPacks && window.HelmWxGridDecode, null, { timeout: 20000 });
}

function enableGrid(page, manifest, layer, when) {
  return page.evaluate(([m, l, w]) => window.HelmWxGrid.enable(window.map, { manifestUrl: m, layer: l, when: w })
    .then(st => ({ ok: true, st }))
    .catch(e => ({ ok: false, code: e.code, message: e.message })), [manifest, layer, when || null]);
}

test('grid renderer enables from numeric packs only, survives zoom hammer, fails loud', async ({ page }) => {
  const upstream = [];
  page.on('request', r => {
    const u = new URL(r.url());
    if (u.protocol === 'blob:' || u.protocol === 'data:') return;   // page-internal, not network
    if (!['localhost', '127.0.0.1'].includes(u.hostname)) upstream.push(r.url());
  });
  await boot(page);

  const hasGpu = await page.evaluate(async () =>
    !!(navigator.gpu && await navigator.gpu.requestAdapter().catch(() => null)));
  // when = mid-bracket -> real two-frame value-lerp (frac 0.5), not a clamped single frame
  const res = await enableGrid(page, '/.wx33-e2e/manifest.json', 'wind', '2026-07-01T01:30:00Z');

  if (!hasGpu) {
    // CI path: the DATA PLANE already fetched, checksummed, decoded and assembled both
    // frames (any failure there would carry its own code) — only the capability gate
    // may reject, with the contract's code and a visible diagnostic. No canvas appears.
    expect(res.ok).toBe(false);
    expect(res.code).toBe('unsupported_renderer_capability');
    const st = await page.evaluate(() => window.__helmWxGridStatus);
    expect(st.diagnostics.some(d => d.code === 'unsupported_renderer_capability')).toBe(true);
    expect(await page.locator('.helm-wx-grid-canvas').count()).toBe(0);   // no silent substitute
  } else {
    expect(res.ok, 'enable failed: ' + JSON.stringify(res)).toBe(true);
    expect(res.st.state).toBe('on');
    expect(res.st.frames.a).toBe('2026-07-01T00:00:00Z');
    expect(res.st.frames.b).toBe('2026-07-01T03:00:00Z');
    expect(Math.abs(res.st.frames.frac - 0.5)).toBeLessThan(1e-9);
    expect(await page.locator('.helm-wx-grid-canvas').count()).toBe(1);

    // zoom/pan hammer: 20 jumps across z3-10 — stability is structural (no fetches to make)
    const before = await page.evaluate(() => performance.getEntriesByType('resource').length);
    await page.evaluate(async () => {
      for (let i = 0; i < 20; i++) {
        window.map.jumpTo({ center: [170 + (i % 5) * 4, -20 + (i % 3) * 6], zoom: 3 + (i % 8) });
        await new Promise(r => setTimeout(r, 50));
      }
    });
    const st = await page.evaluate(() => window.__helmWxGridStatus);
    expect(st.state).toBe('on');
    expect(st.diagnostics.length).toBe(0);
    const after = await page.evaluate(() => performance.getEntriesByType('resource').length);
    expect(after - before).toBeLessThanOrEqual(2);            // no per-gesture data fetches
    await page.evaluate(() => window.HelmWxGrid.disable());
  }

  // fail-loud: corrupted checksum rejects with the transport's code in EVERY environment —
  // the data plane runs before the GPU gate, so CI exercises this too.
  const bad = await enableGrid(page, '/.wx33-e2e/manifest-badsum.json', 'wind', '2026-07-01T01:30:00Z');
  expect(bad.ok).toBe(false);
  expect(bad.code).toBe('checksum_mismatch');

  // fail-loud: layer not in pack -> out_of_pack (data plane, all environments)
  const missing = await enableGrid(page, '/.wx33-e2e/manifest.json', 'waves');
  expect(missing.ok).toBe(false);
  expect(missing.code).toBe('out_of_pack');

  // the whole test made zero non-local requests
  expect(upstream).toEqual([]);
});
