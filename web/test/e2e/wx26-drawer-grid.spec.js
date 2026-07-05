// WX-26 — the weather drawer runs ENTIRELY on compact grid packs.
// beforeAll publishes a REAL pack-factory release tree (current.json → index.json →
// manifest → pmtiles) with the fixture source; the app then drives it through the actual
// drawer UI: discovery, enable, probe, time-scrub, transparency — with ZERO requests to
// the retired :8093 gateway and zero non-local hosts. Fail-loud: blocking current.json
// must surface missing_release with the no-substitution promise.
const { test, expect } = require('@playwright/test');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const WEB = path.resolve(__dirname, '..', '..');
const ROOT = path.resolve(WEB, '..');
const OUT = path.join(WEB, '.wx26-e2e');                     // served by serve.py (gitignored)
const VALID_TIMES = ['2026-07-01T00:00:00Z', '2026-07-01T03:00:00Z'];

function factoryJob() {
  // Global-low wind+rain, 90-degree chunks, two frames — synthetic fixture values, but the
  // FULL production release layout (the same publish path the boat uses).
  const chunks = [];
  for (let lon = -180; lon < 180; lon += 90) {
    for (let lat = -90; lat < 90; lat += 90) {
      chunks.push({ bbox: [lon, lat, lon + 90, lat + 90] });
    }
  }
  return {
    schema: 'helm.wx.pack_factory.job.v1',
    generatedAt: '2026-07-01T00:10:00Z',
    maxSourceAgeHours: 24,
    modelRun: { provider: 'synthetic', model: 'fixture', runTime: VALID_TIMES[0], validTimes: VALID_TIMES, timeStepSeconds: 10800 },
    sources: [{ id: 'fx', type: 'fixture', path: path.join(ROOT, 'services/wx/fixtures/helm-env-grid-v1.json'),
                generatedAt: '2026-07-01T00:10:00Z', license: 'unit-test', provenance: 'wx26 e2e fixture' }],
    packs: [{ profile: 'global-low', tier: 'global-low', anchor: 'global', layers: ['wind', 'rain'],
              coverage: { crs: 'OGC:CRS84', global: true, bbox: [-180, -90, 180, 90], wrap: 'antimeridian' },
              chunks }],
  };
}

test.beforeAll(() => {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  const job = path.join(OUT, 'job.json');
  fs.writeFileSync(job, JSON.stringify(factoryJob(), null, 1));
  execFileSync('python3', [path.join(ROOT, 'scripts/wx_pack_factory.py'), 'publish', job,
    '--out', path.join(OUT, 'pub'), '--replay-clock'], { cwd: ROOT, stdio: 'pipe' });
});

async function clickRail(page, rail) {
  const box = await page.locator(`.ri[data-rail="${rail}"]`).boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

async function bootWithPacks(page, base) {
  await page.addInitScript((b) => {
    window.HELM_WX_PACKS_BASE = b;                           // release tree, same-origin
    window.HELM_WX_CHUNK_BASE = '';                          // Range transport (serve.py is range-capable)
  }, base || '/.wx26-e2e/pub');
  await page.goto('/');
  await page.waitForFunction(() => window.map && window.HelmWxControls && window.HelmWxGridPacks, null, { timeout: 20000 });
}

test('drawer live weather runs on the grid pack: discovery, probe, scrub, opacity, no gateway', async ({ page }) => {
  const badHosts = [];
  page.on('request', (r) => {
    const u = new URL(r.url());
    if (u.protocol === 'blob:' || u.protocol === 'data:') return;
    if (/:8093\//.test(r.url())) badHosts.push('gateway:' + r.url());
    if (!['localhost', '127.0.0.1'].includes(u.hostname)) badHosts.push(r.url());
  });
  await bootWithPacks(page);
  const hasGpu = await page.evaluate(async () =>
    !!(navigator.gpu && await navigator.gpu.requestAdapter().catch(() => null)));

  // pick Wind through the REAL drawer UI (open the weather drawer first)
  await clickRail(page, 'weather');
  await page.locator('#wx button[data-wx="wind"]').click();

  if (hasGpu) {
    await page.waitForFunction(() => {
      const st = window.__helmWxGridStatus;
      return st && st.state === 'on' && st.layer === 'wind';
    }, null, { timeout: 20000 });
    const st = await page.evaluate(() => window.__helmWxGridStatus);
    expect(st.packId).toContain('synthetic/fixture');
    expect(st.validTimes).toEqual(VALID_TIMES);
    await expect(page.locator('#wx-notice')).toContainText('grid pack');

    // time scrubber synced from the pack's validTimes; scrubbing re-brackets with NO fetch
    await expect.poll(async () => page.evaluate(() => ({
      shown: getComputedStyle(document.querySelector('#time')).display !== 'none',
      max: document.querySelector('#tslider').max,
    }))).toEqual({ shown: true, max: '1' });
    const before = await page.evaluate(() => performance.getEntriesByType('resource').length);
    await page.locator('#tslider').evaluate((el) => { el.value = '1'; el.dispatchEvent(new Event('input', { bubbles: true })); });
    await expect.poll(async () => page.evaluate(() => window.__helmWxGridStatus.frames.a)).toBe(VALID_TIMES[1]);
    const after = await page.evaluate(() => performance.getEntriesByType('resource').length);
    expect(after - before).toBeLessThanOrEqual(1);           // scrub = cached frames, no data fetch

    // transparency slider drives the grid scene alpha (status exposes the applied opacity)
    await page.locator('#wxopacity').evaluate((el) => { el.value = '80'; el.dispatchEvent(new Event('input', { bubbles: true })); });
    await expect.poll(async () => page.evaluate(() => window.HelmWxGrid.status().opacity)).toBeCloseTo(0.2, 2);

    // rain (scalar) works through the same pack
    await page.locator('#wx button[data-wx="rain"]').click();
    await page.waitForFunction(() => window.__helmWxGridStatus.layer === 'rain' && window.__helmWxGridStatus.state === 'on', null, { timeout: 15000 });
  } else {
    // No adapter (CI headless): the DATA PLANE still ran (discovery -> manifest -> chunks ->
    // frames) and the drawer must say exactly why nothing rendered — never a blank shrug.
    await expect(page.locator('#wx-notice')).toContainText('unsupported_renderer_capability', { timeout: 20000 });
    await expect(page.locator('#wx-notice')).toContainText('no gateway/direct fallback/download');
  }

  // Data-plane truths hold in EVERY environment (CPU-side, GPU-independent):
  const disc = await page.evaluate(() =>
    window.HelmWxGridPacks.discoverPack(window.HELM_WX_PACKS_BASE, 'wind', { lat: 0, lng: 0 })
      .then(d => ({ ok: true, packId: d.pack.packId, releaseId: d.releaseId }))
      .catch(e => ({ ok: false, code: e.code })));
  expect(disc.ok).toBe(true);
  expect(disc.packId).toContain('synthetic/fixture');
  const sample = await page.evaluate(() =>
    window.HelmWxGrid.sample(window.map.getCenter().lat, window.map.getCenter().lng));
  expect(sample).not.toBeNull();
  expect(sample.schema).toBe('helm.layer.sample.v1');
  expect(sample.unit).toBe('kn');
  expect(sample.coverage).toBe('in');
  expect(sample.value).not.toBeNull();

  expect(badHosts).toEqual([]);                              // zero gateway, zero non-local
});

test('missing release tree fails loud with the real code and no substitution', async ({ page }) => {
  // NOTE: page.route can't intercept fetches mediated by the app's service worker —
  // point discovery at a base that genuinely has no release tree instead.
  await bootWithPacks(page, '/.wx26-e2e/definitely-missing');
  await clickRail(page, 'weather');
  await page.locator('#wx button[data-wx="wind"]').click();
  await expect(page.locator('#wx-notice')).toContainText('missing_release', { timeout: 20000 });
  await expect(page.locator('#wx-notice')).toContainText('no gateway/direct fallback/download');
  const st = await page.evaluate(() => window.__helmWxGridStatus);
  expect(!st || st.state !== 'on').toBe(true);               // nothing rendered, nothing faked
});
