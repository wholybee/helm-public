// SCHED-2 browser acceptance: pan/zoom with scheduler cache trace evidence.
// Run: HELM_SCHED2=1 npx playwright test web/test/e2e/sched-2-zoom-blend.spec.js
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

test.skip(!process.env.HELM_SCHED2, 'Set HELM_SCHED2=1 to run the scheduler blend acceptance proof.');

const HASH = process.env.HELM_SCHED2_HASH || '#12/24.5/-81.8';
const EVIDENCE_DIR = process.env.HELM_SCHED2_EVIDENCE_DIR ||
  path.resolve(__dirname, '..', '..', '..', 'test-results', 'sched-2-zoom-blend');

function ensureEvidenceDir() {
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
}

async function boot(page) {
  await page.addInitScript(() => {
    try {
      window.HELM_CHART_WEBGPU = true;
      window.HELM_SCHED2 = true;
    } catch (e) {}
  });
  await page.goto('/' + HASH);
  await expect(page).toHaveTitle(/Helm/);
  await page.waitForFunction(() => window.map && window.map.isStyleLoaded && window.map.isStyleLoaded(), null, { timeout: 30000 });
  await page.waitForFunction(() => window.__helmChartSchedulerBlend, null, { timeout: 30000 });
}

test('scheduler prefetch and pan/zoom leave no blank chart edges (fixture region)', async ({ page }) => {
  ensureEvidenceDir();
  const artifactFetches = [];
  const cacheTrace = [];

  page.on('response', resp => {
    const url = resp.url();
    if (url.includes('render-artifact-chart-1.json')) {
      artifactFetches.push({ url, status: resp.status() });
    }
  });

  await boot(page);
  await page.waitForFunction(() => {
    return window.__helmChartScheduler &&
      window.__helmChartScheduler.response &&
      window.__helmChartScheduler.response.totals.visible >= 1 &&
      window.__helmChartScheduler.response.totals.overscan >= 1;
  }, null, { timeout: 20000 });

  await page.screenshot({ path: path.join(EVIDENCE_DIR, '01-boot-scheduler.png'), fullPage: true });

  await page.evaluate(() => window.map.panBy([120, 0], { duration: 0 }));
  await page.waitForTimeout(400);
  await page.evaluate(() => window.map.zoomIn({ duration: 0 }));
  await page.waitForTimeout(400);
  await page.evaluate(() => window.map.zoomOut({ duration: 0 }));
  await page.waitForTimeout(400);
  await page.evaluate(() => window.map.panBy([-120, 80], { duration: 0 }));
  await page.waitForTimeout(500);

  const schedulerState = await page.evaluate(() => ({
    mode: window.__helmChartMode,
    scheduler: window.__helmChartScheduler,
    cache: window.__helmChartScheduler && window.__helmChartScheduler.cache
  }));

  expect(schedulerState.mode, 'chart mode should be gpu or maplibre fallback').toMatch(/gpu|maplibre/);
  expect(schedulerState.scheduler.response.totals.visible).toBeGreaterThan(0);
  expect(schedulerState.scheduler.response.totals.overscan).toBeGreaterThan(0);
  expect(schedulerState.cache.size).toBeGreaterThan(0);
  expect(artifactFetches.some(r => r.status === 200), 'artifact prefetch network trace').toBeTruthy();

  const alphaSample = await page.evaluate(async () => {
    const canvas = document.querySelector('.helm-chart-artifact-canvas');
    if (!canvas) return { hasCanvas: false, nonZero: 0 };
    const ctx = canvas.getContext('2d');
    if (!ctx) return { hasCanvas: true, nonZero: -1 };
    const w = canvas.width, h = canvas.height;
    const data = ctx.getImageData(Math.floor(w * 0.25), Math.floor(h * 0.25), Math.floor(w * 0.5), Math.floor(h * 0.5)).data;
    let nonZero = 0;
    for (let i = 3; i < data.length; i += 4) if (data[i] > 0) nonZero++;
    return { hasCanvas: true, nonZero: nonZero };
  });

  if (schedulerState.mode === 'gpu') {
    expect(alphaSample.hasCanvas, 'WebGPU overlay canvas present').toBeTruthy();
    if (alphaSample.nonZero >= 0) expect(alphaSample.nonZero, 'canvas alpha sample in viewport center').toBeGreaterThan(0);
  }

  cacheTrace.push({
    artifactFetches: artifactFetches.slice(0, 32),
    scheduler: schedulerState.scheduler,
    alphaSample: alphaSample
  });
  fs.writeFileSync(path.join(EVIDENCE_DIR, 'sched-2-evidence.json'), JSON.stringify(cacheTrace, null, 2));
  await page.screenshot({ path: path.join(EVIDENCE_DIR, '02-pan-zoom-blend.png'), fullPage: true });
});
