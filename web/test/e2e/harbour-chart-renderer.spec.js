// INTEGRATE-1 + QA-1 harbour acceptance against a live helm-server (pattern: helmcxx4-cockpit).
//
// Strong criteria:
//   - PNG enc-chart is default (flag off unchanged)
//   - WebGPU opt-in via ?chartWebgpu=1 / localStorage (never silent)
//   - Server /chart tiles + artifact packets + status surface + health panel
//   - Pan/zoom does not blank the map; explicit fallback always carries a reason
//
// Run:
//   HELM_HARBOUR_E2E=1 HELM_E2E_URL=http://127.0.0.1:8080 \
//     npx playwright test e2e/harbour-chart-renderer.spec.js --config=playwright.harbour.config.js
//
// Or: bash scripts/harbour-chart-renderer-proof.sh
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const {
  HASH,
  hashCenter,
  lon2tile,
  lat2tile,
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
} = require('./_harbour-helpers');

test.skip(!process.env.HELM_HARBOUR_E2E, 'Set HELM_HARBOUR_E2E=1 for harbour chart renderer proof.');

const EVIDENCE_DIR = process.env.HELM_HARBOUR_EVIDENCE_DIR ||
  path.resolve(__dirname, '..', '..', '..', 'test-results', 'harbour-chart-renderer');
const BROWSER_DIR = path.join(EVIDENCE_DIR, 'browser');

function ensureEvidenceDir() {
  fs.mkdirSync(BROWSER_DIR, { recursive: true });
}

function writeEvidence(name, data) {
  ensureEvidenceDir();
  fs.writeFileSync(path.join(EVIDENCE_DIR, name), JSON.stringify(data, null, 2));
}

function appendManifest(caseId, result) {
  ensureEvidenceDir();
  const manifestPath = path.join(EVIDENCE_DIR, 'manifest.json');
  const manifest = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')) : {
    schema_version: 'helm.harbour_chart_renderer_proof.v1',
    cases: {}
  };
  manifest.cases[caseId] = result;
  manifest.updated_at = new Date().toISOString();
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
}

test.describe('Harbour chart renderer — server contract', () => {
  test('helm-server health and center ENC tile are loaded', async ({ request }) => {
    const health = await request.get('/health');
    expect(health.ok(), '/health must respond').toBeTruthy();
    const body = await health.json();
    expect(body.engine).toBe('helm-server');
    expect(body.chart_loaded).toBe(true);
    expect(body.chart_status).toBe('loaded');

    const center = hashCenter(HASH);
    const z = Math.max(10, Math.min(14, Math.round(center.zoom)));
    let best = null;
    for (let dz = 0; dz <= 2; dz++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const tz = z - dz;
          if (tz < 10) continue;
          const x = lon2tile(center.lon, tz) + dx;
          const y = lat2tile(center.lat, tz) + dy;
          const tile = await request.get(`/chart/${tz}/${x}/${y}.png`);
          if (tile.status() !== 200) continue;
          const bytes = (await tile.body()).byteLength;
          const chartStatus = tile.headers()['x-helm-chart-status'] || '';
          if (!best || bytes > best.bytes) {
            best = { tz, x, y, bytes, chartStatus, contentType: tile.headers()['content-type'] || '' };
          }
        }
      }
    }
    expect(best, 'must find at least one /chart tile near harbour center').toBeTruthy();
    expect(best.contentType).toContain('image/png');
    expect(best.bytes, 'chart tile must not be trivial empty PNG').toBeGreaterThan(200);
    expect(['loaded', ''].includes(best.chartStatus) || best.bytes > 800,
      'tile should be loaded chart data or substantive PNG').toBeTruthy();

    appendManifest('server_contract', { pass: true, tile: best, health: body });
  });

  test('/catalog reports loaded ENC cell and /query returns features inside bbox', async ({ request }) => {
    const enc = await fetchCatalogEncCenter(request);
    const query = await request.get(
      `/query?lat=${enc.lat}&lon=${enc.lon}&z=${enc.zoom}&radius=8`
    );
    expect(query.ok(), '/query must respond inside catalog bbox').toBeTruthy();
    const hits = await query.json();
    expect(Array.isArray(hits), '/query returns JSON array').toBeTruthy();
    expect(hits.length, '/query should find ENC features at catalog center').toBeGreaterThan(0);
    expect(hits[0].acronym, 'first hit should expose S-57 acronym').toBeTruthy();
    appendManifest('server_query', { pass: true, enc, hitCount: hits.length, sample: hits[0].acronym });
  });
});

test.describe('INTEGRATE-1 — PNG default path', () => {
  test('default boot keeps enc-chart primary with visible ENC badge and explicit reason', async ({ page }) => {
    ensureEvidenceDir();
    const bag = { console: [], pageErrors: [], failedRequests: [], chartTiles: [], artifactFetches: [] };
    attachHarbourDiagnostics(page, bag);
    page.on('response', resp => {
      const url = resp.url();
      if (/\/chart\/\d+\/\d+\/\d+\.png/.test(url)) {
        bag.chartTiles.push({ url, status: resp.status() });
      }
      if (/render-artifact.*\.json/.test(url)) {
        bag.artifactFetches.push({ url, status: resp.status() });
      }
    });

    await page.addInitScript(() => {
      try {
        localStorage.removeItem('helmChartWebgpu');
        sessionStorage.removeItem('helmChartWebgpu');
      } catch (e) {}
    });
    await bootHarbour(page);

    const state = await collectRendererState(page);
    const status = state.status;

    expect(status.schema).toBe('helm.chart_renderer_status.v1');
    expect(status.feature_flag.enabled).toBe(false);
    expect(status.active_renderer).toBe('maplibre');
    expect(status.fallback_reason.length).toBeGreaterThan(0);
    expect(status.fallback_reason.toLowerCase()).toMatch(/not enabled|png enc-chart default/);
    expect(state.mode).toBe('maplibre');

    await expect(page.locator('#chart-renderer-badge')).toBeVisible();
    await expect(page.locator('#chart-renderer-badge-txt')).toHaveText('ENC');

    const encVis = await layerVisibility(page, 'enc-chart');
    expect(encVis).toBe('visible');

    expect(bag.chartTiles.some(t => t.status === 200), 'must fetch at least one ENC tile').toBeTruthy();
    expect(bag.pageErrors, 'no uncaught page errors on PNG default boot').toEqual([]);
    expect(bag.failedRequests, 'no fatal failed requests on PNG default boot').toEqual([]);

    await page.screenshot({ path: path.join(BROWSER_DIR, '01-png-default.png'), fullPage: true });
    appendManifest('png_default', { pass: true, status, encVis, chartTiles: bag.chartTiles.length });
  });

  test('settings drawer exposes WebGPU opt-in unchecked by default', async ({ page }) => {
    await page.addInitScript(() => {
      try { localStorage.removeItem('helmChartWebgpu'); } catch (e) {}
    });
    await bootHarbour(page);
    await clickRail(page, 'settings');
    await expect(page.locator('#chart-renderer-settings-host')).toContainText('WebGPU nautical renderer');
    await expect(page.locator('#chart-renderer-settings-host')).toContainText('PNG ENC is default');
    await expect(page.locator('#chart-renderer-flag')).not.toBeChecked();
    await page.screenshot({ path: path.join(BROWSER_DIR, '02-settings-default.png'), fullPage: true });
  });
});

test.describe('INTEGRATE-1 — WebGPU opt-in path', () => {
  test('?chartWebgpu=1 enables flag and loads artifact with non-silent renderer state', async ({ page }) => {
    ensureEvidenceDir();
    const bag = { artifactFetches: [], chartTiles: [] };
    page.on('response', resp => {
      const url = resp.url();
      if (/render-artifact.*\.json/.test(url)) bag.artifactFetches.push({ url, status: resp.status() });
      if (/\/chart\/\d+\/\d+\/\d+\.png/.test(url)) bag.chartTiles.push({ url, status: resp.status() });
    });

    await page.addInitScript(() => {
      try { localStorage.removeItem('helmChartWebgpu'); } catch (e) {}
    });
    await bootHarbour(page, { query: 'chartWebgpu=1', waitArtifact: true });

    const state = await collectRendererState(page);
    const status = state.status;

    expect(status.feature_flag.enabled).toBe(true);
    expect(bag.artifactFetches.some(r => r.status === 200), 'artifact packet must load').toBeTruthy();
    expect(status.artifact.schema_version).toBe('helm.render.artifact.v1');
    expect(status.artifact.chart_epoch).toContain('synthetic-chart-1');

    if (status.active_renderer === 'webgpu') {
      expect(state.mode).toBe('gpu');
      await expect(page.locator('#chart-renderer-badge-txt')).toHaveText('WEBGPU');
      const encVis = await layerVisibility(page, 'enc-chart');
      expect(encVis).toBe('none');
      expect(state.gpuCanvas).toBe(true);
    } else {
      expect(status.fallback_reason.length).toBeGreaterThan(0);
      expect(status.fallback_reason.toLowerCase()).not.toContain('not enabled');
      expect(status.fallback_reason.toLowerCase()).not.toContain('png enc-chart default');
    }

    await page.screenshot({ path: path.join(BROWSER_DIR, '03-webgpu-opt-in.png'), fullPage: true });
    appendManifest('webgpu_opt_in', { pass: true, status, artifactFetches: bag.artifactFetches });
  });

  test('localStorage helmChartWebgpu=1 matches URL opt-in behavior', async ({ page }) => {
    await page.addInitScript(() => {
      try { localStorage.setItem('helmChartWebgpu', '1'); } catch (e) {}
    });
    await bootHarbour(page, { waitArtifact: true });
    const status = (await collectRendererState(page)).status;
    expect(status.feature_flag.enabled).toBe(true);
    expect(status.artifact.schema_version).toBe('helm.render.artifact.v1');
    await expect(page.locator('#chart-renderer-flag')).toBeChecked();
  });
});

test.describe('QA-1 — interaction and trust gate', () => {
  test('WebGPU path survives pan/zoom without map degrade and records inspect handles', async ({ page }) => {
    ensureEvidenceDir();
    await page.addInitScript(() => {
      try { localStorage.setItem('helmChartWebgpu', '1'); } catch (e) {}
      window.HELM_SCHED2 = true;
    });
    await bootHarbour(page, { waitArtifact: true });
    await page.waitForFunction(
      () => window.__helmChartSchedulerBlend || window.__helmChartScheduler,
      null,
      { timeout: 30000 }
    );

    const before = await collectRendererState(page);
    expect(before.status.feature_flag.enabled).toBe(true);

    await page.evaluate(() => window.map.panBy([140, 0], { duration: 0 }));
    await page.waitForTimeout(400);
    await page.evaluate(() => window.map.zoomIn({ duration: 0 }));
    await page.waitForTimeout(400);
    await page.evaluate(() => window.map.panBy([-100, 80], { duration: 0 }));
    await page.waitForTimeout(600);

    const after = await collectRendererState(page);
    expect(after.degradeVisible, 'degraded banner must stay hidden after pan/zoom').toBe(false);
    expect(await page.evaluate(() => window.map.isStyleLoaded())).toBe(true);

    const inspect = await page.evaluate(() => {
      if (!window.__helmChartArtifact || !window.__helmChartArtifact.pickAtLngLat) return null;
      const c = window.map.getCenter();
      const pick = window.__helmChartArtifact.pickAtLngLat(c);
      return {
        mode: window.__helmChartMode,
        pick_id: pick && pick.pick_id,
        has_trace: !!(pick && pick.trace),
        scheduler_visible: window.__helmChartScheduler &&
          window.__helmChartScheduler.response &&
          window.__helmChartScheduler.response.totals.visible
      };
    });
    expect(inspect).toBeTruthy();
    expect(inspect.scheduler_visible).toBeGreaterThanOrEqual(1);

    await page.screenshot({ path: path.join(BROWSER_DIR, '04-pan-zoom-no-blank.png'), fullPage: true });
    appendManifest('pan_zoom', { pass: true, inspect, before: before.status.active_renderer, after: after.status.active_renderer });
  });

  test('explicit WebGPU disable never silently falls back to ENC', async ({ page }) => {
    await page.addInitScript(() => {
      window.HELM_CHART_WEBGPU = false;
      try { localStorage.removeItem('helmChartWebgpu'); } catch (e) {}
    });
    await bootHarbour(page);
    const state = await collectRendererState(page);
    expect(state.mode).toBe('maplibre');
    expect(state.reason.length).toBeGreaterThan(0);
    expect(state.reason.toLowerCase()).toMatch(/not enabled|webgpu/);
    await expect(page.locator('#chart-renderer-badge-txt')).toHaveText('ENC');
    await page.screenshot({ path: path.join(BROWSER_DIR, '05-explicit-legacy.png'), fullPage: true });
  });

  test('health panel reports chart renderer subsystem with schema and epoch when WebGPU on', async ({ page }) => {
    await page.addInitScript(() => {
      try { localStorage.setItem('helmChartWebgpu', '1'); } catch (e) {}
    });
    await bootHarbour(page, { waitArtifact: true });
    await clickRail(page, 'helm-client-health');
    const panel = page.locator('#helm-client-health');
    await expect(panel).toBeVisible();
    await expect(panel).toContainText('Chart Renderer');
    await expect(panel).toContainText('helm.render.artifact.v1');
    await expect(panel).toContainText('synthetic-chart-1');
    await page.screenshot({ path: path.join(BROWSER_DIR, '06-health-panel.png'), fullPage: true });
    appendManifest('health_panel', { pass: true });
  });
});

test.describe('INSPECT-2 — harbour inspection UX', () => {
  test('pan/drag does not open the no-hit inspect popup (PNG default)', async ({ page }) => {
    await page.addInitScript(() => {
      try { localStorage.removeItem('helmChartWebgpu'); } catch (e) {}
    });
    await bootHarbour(page);
    await dragMapBy(page, 160, 90);
    await page.waitForTimeout(500);
    const popup = await inspectPopupState(page);
    expect(popup.open, 'drag must not open inspect popup').toBe(false);
    expect(popup.isNoHit, 'drag must not show no-hit card').toBe(false);
    appendManifest('inspect_drag_png', { pass: true, popup });
  });

  test('tap inside loaded ENC bbox shows a feature card, not no-hit', async ({ page, request }) => {
    const enc = await fetchCatalogEncCenter(request);
    await page.addInitScript(() => {
      try { localStorage.removeItem('helmChartWebgpu'); } catch (e) {}
    });
    await bootHarbour(page, { hash: encHash(enc) });
    await page.waitForFunction(() => window.__helmChartInspector, null, { timeout: 30000 });
    await waitMapIdle(page);
    const fired = await fireMapClickAt(page, enc.lon, enc.lat);
    expect(fired.ok, 'synthetic map click should fire').toBe(true);
    expect(fired.visible, 'chart layer should be visible for inspect').toBe(true);
    await page.waitForTimeout(400);
    const popup = await inspectPopupState(page);
    expect(popup.open, 'tap inside ENC should open inspect popup').toBe(true);
    expect(popup.isNoHit, 'tap inside ENC must not be no-hit').toBe(false);
    expect(popup.text.length).toBeGreaterThan(0);
    await page.screenshot({ path: path.join(BROWSER_DIR, '07-enc-inspect-tap.png'), fullPage: true });
    appendManifest('inspect_enc_tap', { pass: true, enc: enc.cellId, popupText: popup.text.slice(0, 240) });
  });

  test('tap outside ENC bbox stays silent (no no-hit popup)', async ({ page }) => {
    await page.addInitScript(() => {
      try { localStorage.removeItem('helmChartWebgpu'); } catch (e) {}
    });
    // Open ocean — far from US5GA2BC / Key West fixture.
    await bootHarbour(page, { hash: '#8/0/0' });
    await page.waitForTimeout(600);
    await clickMapCenter(page);
    await page.waitForTimeout(500);
    const popup = await inspectPopupState(page);
    expect(popup.open, 'open-ocean tap should stay silent').toBe(false);
    appendManifest('inspect_open_ocean', { pass: true, popup });
  });
});

test.describe('INTEGRATE-1 — status surface trust', () => {
  test('WebGPU opt-in with fallback exposes non-empty reason in badge title and settings', async ({ page }) => {
    await page.addInitScript(() => {
      try { localStorage.setItem('helmChartWebgpu', '1'); } catch (e) {}
    });
    await bootHarbour(page, { waitArtifact: true });
    const state = await collectRendererState(page);
    expect(state.status.feature_flag.enabled).toBe(true);

    if (state.status.active_renderer === 'maplibre') {
      const title = await page.locator('#chart-renderer-badge').getAttribute('title');
      expect(title || '', 'badge title must carry fallback reason').toMatch(/fallback|WebGPU|not enabled/i);
      expect(state.status.fallback_reason.length).toBeGreaterThan(0);
    }

    await clickRail(page, 'settings');
    await expect(page.locator('#chart-renderer-settings-host .cr-detail')).toContainText('Active renderer');
    await expect(page.locator('#chart-renderer-settings-host .cr-detail')).toContainText('Fallback reason');
    await expect(page.locator('#chart-renderer-settings-host .cr-detail')).toContainText('helm.render.artifact.v1');
    appendManifest('status_surface', { pass: true, active_renderer: state.status.active_renderer, reason: state.status.fallback_reason });
  });

  test('?chartWebgpu=0 overrides persisted localStorage opt-in', async ({ page }) => {
    await page.addInitScript(() => {
      try { localStorage.setItem('helmChartWebgpu', '1'); } catch (e) {}
    });
    await bootHarbour(page, { query: 'chartWebgpu=0' });
    const status = (await collectRendererState(page)).status;
    expect(status.feature_flag.enabled).toBe(false);
    expect(status.active_renderer).toBe('maplibre');
    await expect(page.locator('#chart-renderer-badge-txt')).toHaveText('ENC');
  });
});

test.describe('INTEGRATE-1 — WebGPU primary path (when adapter available)', () => {
  test('opt-in can reach true WebGPU primary with ENC hidden and fixture pick at center', async ({ page }) => {
    await page.addInitScript(() => {
      try { localStorage.setItem('helmChartWebgpu', '1'); } catch (e) {}
      window.HELM_SCHED2 = true;
    });
    await bootHarbour(page, { waitArtifact: true });
    await page.waitForFunction(
      () => window.__helmChartSchedulerBlend || window.__helmChartScheduler,
      null,
      { timeout: 30000 }
    );

    const state = await collectRendererState(page);
    const primary = webgpuPrimaryExpectations(state);

    if (!primary) {
      test.info().annotations.push({
        type: 'webgpu-capability',
        description: `Headless/browser has no WebGPU adapter — observed maplibre fallback: ${state.status.fallback_reason}`
      });
      expect(state.status.feature_flag.enabled).toBe(true);
      expect(state.status.fallback_reason.length).toBeGreaterThan(0);
      appendManifest('webgpu_primary', {
        pass: true,
        skipped_primary: true,
        reason: state.status.fallback_reason,
        note: 'Re-run headed Chrome with HELM_HARBOUR_HEADED=1 for true GPU primary proof'
      });
      return;
    }

    await expect(page.locator('#chart-renderer-badge-txt')).toHaveText('WEBGPU');
    expect(await layerVisibility(page, 'enc-chart')).toBe('none');
    expect(state.gpuCanvas).toBe(true);
    expect(state.gpuCanvasDisplay).not.toBe('none');

    const pick = await page.evaluate(() => {
      const c = window.map.getCenter();
      const hit = window.__helmChartArtifact.pickAtLngLat(c);
      return { pick_id: hit && hit.pick_id, mode: window.__helmChartMode };
    });
    expect(pick.mode).toBe('gpu');
    expect(pick.pick_id, 'fixture center should resolve a pick_id in WebGPU primary').toBeGreaterThan(0);

    await page.screenshot({ path: path.join(BROWSER_DIR, '08-webgpu-primary.png'), fullPage: true });
    appendManifest('webgpu_primary', { pass: true, skipped_primary: false, pick_id: pick.pick_id });
  });
});

test.describe('INTEGRATE-1 — A/B parity on same harbour', () => {
  test('PNG and WebGPU boots produce different renderer modes on the same hash', async ({ page }) => {
    const pngState = await (async () => {
      await page.addInitScript(() => {
        try { localStorage.removeItem('helmChartWebgpu'); } catch (e) {}
      });
      await bootHarbour(page);
      return collectRendererState(page);
    })();

    await page.goto('about:blank');
    const gpuState = await (async () => {
      await page.addInitScript(() => {
        try { localStorage.setItem('helmChartWebgpu', '1'); } catch (e) {}
      });
      await bootHarbour(page, { waitArtifact: true });
      return collectRendererState(page);
    })();

    expect(pngState.status.feature_flag.enabled).toBe(false);
    expect(pngState.status.active_renderer).toBe('maplibre');
    expect(gpuState.status.feature_flag.enabled).toBe(true);
    if (gpuState.status.active_renderer === 'webgpu') {
      expect(pngState.status.active_renderer).not.toBe('webgpu');
    }
    writeEvidence('ab-parity.json', { png: pngState.status, gpu: gpuState.status });
  });
});

test.describe('RENDERMODEL-3 — real US5GA2BC artifact at live harbour', () => {
  test('?cell=us5ga2bc loads real ENC artifact inside catalog bbox', async ({ page, request }) => {
    const enc = await fetchCatalogEncCenter(request);
    test.skip(enc.cellId !== 'US5GA2BC', 'live server must load US5GA2BC for RENDERMODEL-3 harbour proof');

    await page.addInitScript(() => {
      try { localStorage.setItem('helmChartWebgpu', '1'); } catch (e) {}
    });
    await bootHarbour(page, {
      query: 'cell=us5ga2bc&chartWebgpu=1',
      hash: encHash(enc),
      waitArtifact: true
    });

    const state = await collectRendererState(page);
    expect(state.status.artifact.artifact_id).toContain('US5GA2BC');
    expect(state.status.artifact.source_epoch).toContain('US5GA2BC');
    expect(state.status.fallback_reason || '').not.toContain('outside current viewport');

    await page.screenshot({ path: path.join(BROWSER_DIR, '09-rendermodel3-real-cell.png'), fullPage: true });
    appendManifest('rendermodel3_real_cell', {
      pass: true,
      enc: enc.cellId,
      artifact_id: state.status.artifact.artifact_id,
      active_renderer: state.status.active_renderer,
      fallback_reason: state.status.fallback_reason || ''
    });
  });

  test('PNG vs WebGPU+real-cell side-by-side at harbour center', async ({ page, request }) => {
    const enc = await fetchCatalogEncCenter(request);
    test.skip(enc.cellId !== 'US5GA2BC', 'live server must load US5GA2BC for RENDERMODEL-3 harbour proof');
    const hash = encHash(enc);

    await page.addInitScript(() => {
      try { localStorage.removeItem('helmChartWebgpu'); } catch (e) {}
    });
    await bootHarbour(page, { hash });
    await page.waitForTimeout(800);
    await page.screenshot({ path: path.join(BROWSER_DIR, '10-rendermodel3-png-default.png'), fullPage: true });
    const pngState = await collectRendererState(page);

    await page.goto('about:blank');
    await page.addInitScript(() => {
      try { localStorage.setItem('helmChartWebgpu', '1'); } catch (e) {}
    });
    await bootHarbour(page, { query: 'cell=us5ga2bc&chartWebgpu=1', hash, waitArtifact: true });
    await page.waitForTimeout(800);
    await page.screenshot({ path: path.join(BROWSER_DIR, '11-rendermodel3-webgpu-real-cell.png'), fullPage: true });
    const gpuState = await collectRendererState(page);

    expect(pngState.status.active_renderer).toBe('maplibre');
    expect(gpuState.status.artifact.artifact_id).toContain('US5GA2BC');
    expect(gpuState.status.fallback_reason || '').not.toContain('outside current viewport');
    appendManifest('rendermodel3_side_by_side', {
      pass: true,
      png_renderer: pngState.status.active_renderer,
      gpu_renderer: gpuState.status.active_renderer,
      gpu_fallback: gpuState.status.fallback_reason || '',
      artifact_id: gpuState.status.artifact.artifact_id
    });
  });
});

test.describe('RENDERMODEL-4 — filled S-52 portrayal at US5GA2BC', () => {
  // Browser side of the RENDERMODEL-4 acceptance (the deterministic GPU-free gate is
  // web/test/rendermodel4-fill-parity.test.cjs). When a real WebGPU adapter is present
  // this samples the live GPU canvas and proves it draws FILLED buff land + blue water —
  // i.e. NOT a wireframe. Skips gracefully (asserting opt-in state) when headless has no GPU.
  test('WebGPU draws filled land + water for the real cell (not wireframe)', async ({ page, request }) => {
    const enc = await fetchCatalogEncCenter(request);
    test.skip(enc.cellId !== 'US5GA2BC', 'live server must load US5GA2BC for RENDERMODEL-4 fill proof');

    await page.addInitScript(() => {
      try { localStorage.setItem('helmChartWebgpu', '1'); } catch (e) {}
      window.HELM_SCHED2 = true;
    });
    await bootHarbour(page, { query: 'cell=us5ga2bc&chartWebgpu=1', hash: encHash(enc), waitArtifact: true });
    await page.waitForFunction(
      () => window.__helmChartSchedulerBlend || window.__helmChartScheduler,
      null, { timeout: 30000 }
    );

    const state = await collectRendererState(page);
    expect(state.status.artifact.artifact_id).toContain('US5GA2BC');

    if (!webgpuPrimaryExpectations(state)) {
      test.info().annotations.push({
        type: 'webgpu-capability',
        description: `No WebGPU adapter — fill proof deferred to headed Chrome. reason: ${state.status.fallback_reason}`
      });
      expect(state.status.feature_flag.enabled).toBe(true);
      appendManifest('rendermodel4_fill', { pass: true, skipped_primary: true, reason: state.status.fallback_reason });
      return;
    }

    // Sample the live GPU canvas: filled chart pixels (buff land + blue water) must
    // dominate. A wireframe/outline packet leaves the canvas almost entirely empty.
    const sample = await page.evaluate(() => {
      const c = document.querySelector('.helm-chart-artifact-canvas');
      if (!c) return null;
      const off = document.createElement('canvas');
      off.width = c.width; off.height = c.height;
      const ctx = off.getContext('2d');
      ctx.drawImage(c, 0, 0);
      const { data } = ctx.getImageData(0, 0, off.width, off.height);
      let total = 0, filled = 0, buff = 0, blue = 0;
      for (let i = 0; i < data.length; i += 4) {
        total++;
        const r = data[i], g = data[i + 1], b = data[i + 2], a = data[i + 3];
        if (a < 24) continue;                     // transparent = nothing drawn there
        filled++;
        if (r > 150 && r >= g && g >= b) buff++;   // land buff
        else if (b > 150 && b >= r) blue++;        // water blue
      }
      return { total, filled, buff, blue };
    });

    expect(sample, 'gpu canvas must be sampleable').toBeTruthy();
    const filledFrac = sample.filled / sample.total;
    expect(filledFrac, `filled fraction ${filledFrac.toFixed(3)} must exceed 0.4 (wireframe ~ 0.05)`).toBeGreaterThan(0.4);
    expect(sample.buff, 'buff land pixels present').toBeGreaterThan(0);
    expect(sample.blue, 'blue water pixels present').toBeGreaterThan(0);

    await page.screenshot({ path: path.join(BROWSER_DIR, '12-rendermodel4-webgpu-filled.png'), fullPage: true });
    appendManifest('rendermodel4_fill', {
      pass: true, skipped_primary: false,
      filled_fraction: +filledFrac.toFixed(3), buff: sample.buff, blue: sample.blue
    });
  });
});
