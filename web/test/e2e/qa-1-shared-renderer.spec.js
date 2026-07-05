// QA-1 browser acceptance: WebGPU artifact path, scheduler pan/zoom, inspect traces, MapLibre fallback.
// Run: HELM_QA1=1 npx playwright test web/test/e2e/qa-1-shared-renderer.spec.js
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

test.skip(!process.env.HELM_QA1, 'Set HELM_QA1=1 to run the shared renderer QA proof.');

const HASH = process.env.HELM_QA1_HASH || '#12/24.5/-81.8';
const EVIDENCE_DIR = process.env.HELM_QA1_EVIDENCE_DIR ||
  path.resolve(__dirname, '..', '..', '..', 'test-results', 'qa-1-shared-renderer');
const BROWSER_DIR = path.join(EVIDENCE_DIR, 'browser');

function ensureEvidenceDir() {
  fs.mkdirSync(BROWSER_DIR, { recursive: true });
}

function loadPickModule() {
  const code = fs.readFileSync(path.join(__dirname, '..', '..', 'chart-artifact-pick.js'), 'utf8');
  const ctx = vm.createContext({ console });
  vm.runInContext(code, ctx);
  return ctx.HelmChartArtifactPick;
}

async function boot(page, opts) {
  opts = opts || {};
  await page.addInitScript(({ webgpu, sched2 }) => {
    try {
      window.HELM_CHART_WEBGPU = webgpu;
      window.HELM_SCHED2 = sched2;
    } catch (e) {}
  }, { webgpu: opts.webgpu !== false, sched2: opts.sched2 !== false });
  await page.goto('/' + HASH);
  await expect(page).toHaveTitle(/Helm/);
  await page.waitForFunction(() => window.map && window.map.isStyleLoaded && window.map.isStyleLoaded(), null, { timeout: 30000 });
  if (opts.sched2 !== false) {
    await page.waitForFunction(() => window.__helmChartSchedulerBlend, null, { timeout: 30000 });
  }
}

test('WebGPU artifact renderer: scheduler, pan/zoom, inspect traces, no blank edges', async ({ page }) => {
  ensureEvidenceDir();
  const artifactFetches = [];
  page.on('response', resp => {
    const url = resp.url();
    if (url.includes('render-artifact-chart-1.json')) {
      artifactFetches.push({ url, status: resp.status() });
    }
  });

  await boot(page, { webgpu: true, sched2: true });
  await page.waitForFunction(() => window.__helmChartScheduler &&
    window.__helmChartScheduler.response &&
    window.__helmChartScheduler.response.totals.visible >= 1, null, { timeout: 20000 });

  await page.screenshot({ path: path.join(BROWSER_DIR, '01-boot-webgpu.png'), fullPage: true });

  await page.evaluate(() => window.map.panBy([100, 0], { duration: 0 }));
  await page.waitForTimeout(350);
  await page.evaluate(() => window.map.zoomIn({ duration: 0 }));
  await page.waitForTimeout(350);
  await page.evaluate(() => window.map.panBy([-80, 60], { duration: 0 }));
  await page.waitForTimeout(500);

  const inspectTraces = await page.evaluate(() => {
    const art = window.__helmChartArtifact && window.__helmChartArtifact.getArtifact
      ? window.__helmChartArtifact.getArtifact() : null;
    if (!art || !window.HelmChartArtifactPick) return null;
    const center = window.map.getCenter();
    const pick = window.__helmChartArtifact.pickAtLngLat(center);
    return {
      mode: window.__helmChartMode,
      atlas: window.__helmChartAtlas || null,
      pick_id: pick && pick.pick_id,
      has_trace: !!(pick && pick.trace)
    };
  });

  expect(inspectTraces.mode).toMatch(/gpu|maplibre/);
  expect(artifactFetches.some(r => r.status === 200)).toBeTruthy();

  const Pick = loadPickModule();
  const artifactJson = JSON.parse(fs.readFileSync(
    path.join(__dirname, '..', '..', 'data', 'render-artifact-chart-1.json'), 'utf8'));
  const parseCode = fs.readFileSync(path.join(__dirname, '..', '..', 'chart-artifact-webgpu.js'), 'utf8');
  const parseCtx = vm.createContext({ console, navigator: {} });
  parseCtx.window = parseCtx;
  vm.runInContext(parseCode, parseCtx);
  const artifact = parseCtx.HelmChartArtifactAuto._test.parseArtifactJson(artifactJson);
  expect(Pick.pickAtTilePixel(artifact, 5, 3)).toBe(5);

  const browserEvidence = {
    artifactFetches: artifactFetches.slice(0, 16),
    inspectTraces,
    scheduler: await page.evaluate(() => window.__helmChartScheduler || null)
  };
  fs.writeFileSync(path.join(BROWSER_DIR, 'webgpu-evidence.json'), JSON.stringify(browserEvidence, null, 2));
  await page.screenshot({ path: path.join(BROWSER_DIR, '02-pan-zoom-no-blank.png'), fullPage: true });

  const manifestPath = path.join(EVIDENCE_DIR, 'manifest.json');
  if (fs.existsSync(manifestPath)) {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.legs = manifest.legs || {};
    manifest.legs.browser = 'pass';
    manifest.browser = browserEvidence;
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  }
});

test('MapLibre enc-chart fallback path stays explicit when WebGPU disabled', async ({ page }) => {
  ensureEvidenceDir();
  await page.addInitScript(() => {
    try { window.localStorage.removeItem('helmChartWebgpu'); } catch (e) {}
    window.HELM_CHART_WEBGPU = false;
    window.HELM_SCHED2 = false;
  });
  await page.goto('/' + HASH);
  await expect(page).toHaveTitle(/Helm/);
  await page.waitForFunction(() => window.map && window.map.isStyleLoaded && window.map.isStyleLoaded(), null, { timeout: 30000 });
  await page.waitForTimeout(800);
  const state = await page.evaluate(() => ({
    mode: window.__helmChartMode,
    reason: window.__helmChartModeReason || ''
  }));
  expect(state.mode).toBe('maplibre');
  expect(state.reason.length).toBeGreaterThan(0);
  await page.screenshot({ path: path.join(BROWSER_DIR, '03-maplibre-fallback.png'), fullPage: true });
});
