// WX-25 — particle engine selection + fallback discipline.
// The facade must RESOLVE to 'gpu' or 'cpu' (never stuck initializing, never silent),
// announce the path on window.__helmWindMode, and actually paint particle trails with
// a synthetic velocity field on whichever path is active. CI Chromium usually has no
// usable WebGPU adapter, so this spec proves the visible-CPU-fallback contract there;
// on a real GPU it proves the WebGPU path end-to-end. Same assertions either way —
// that symmetry IS the acceptance (no silent substitution, WX-30 discipline).
const { test, expect } = require('@playwright/test');

// Uniform 10 kn easterly over the whole world — particles must advect anywhere the map sits.
function syntheticVelocity() {
  const nx = 145, ny = 69, n = nx * ny;
  const header = { nx, ny, lo1: -180, la1: 85, lo2: 180, la2: -85, dx: 2.5, dy: 2.5 };
  return [
    { header: Object.assign({ parameterNumber: 2 }, header), data: new Array(n).fill(10) },
    { header: Object.assign({ parameterNumber: 3 }, header), data: new Array(n).fill(0) }
  ];
}

test('particle engine resolves a visible mode and paints trails', async ({ page }) => {
  const consoleLines = [];
  page.on('console', (m) => consoleLines.push(m.text()));
  await page.goto('/');

  // engine facade exists and RESOLVES — 'initializing' must not persist
  await page.waitForFunction(() => window.__helmWind, null, { timeout: 15000 });
  await page.waitForFunction(
    () => window.__helmWindMode === 'gpu' || window.__helmWindMode === 'cpu',
    null, { timeout: 15000 }
  );
  const mode = await page.evaluate(() => window.__helmWindMode);
  const reason = await page.evaluate(() => window.__helmWindModeReason || '');

  // the path is announced, and a CPU fallback always says WHY
  expect(['gpu', 'cpu']).toContain(mode);
  if (mode === 'cpu') expect(reason.length).toBeGreaterThan(0);
  expect(consoleLines.some(l => l.includes('[wx-particles]'))).toBeTruthy();

  // feed the synthetic field and switch the layer on (same API both engines)
  await page.evaluate((grid) => {
    window.__helmWind.setNeutral(false);          // ramp colors: brighter pixels, easier readback
    window.__helmWind.setOpacity(0.9);
    window.__helmWind.setData(grid);
    window.__helmWind.setVisible(true);
  }, syntheticVelocity());

  // particles must actually PAINT: sample the overlay canvas until non-blank
  await page.waitForFunction(() => {
    const c = document.querySelector('.helm-wind-canvas');
    if (!c || c.style.display === 'none' || !c.width || !c.height) return false;
    const t = document.createElement('canvas');
    t.width = Math.min(c.width, 512); t.height = Math.min(c.height, 512);
    const ctx = t.getContext('2d');
    try { ctx.drawImage(c, 0, 0, t.width, t.height); } catch (e) { return false; }
    const d = ctx.getImageData(0, 0, t.width, t.height).data;
    let lit = 0;
    for (let i = 3; i < d.length; i += 4) { if (d[i] > 8) lit++; }
    return lit > 30;                               // trails present, not stray noise
  }, null, { timeout: 20000 });

  // API parity: the remaining surface works without throwing on the active engine
  await page.evaluate(() => {
    window.__helmWind.setNeutral(true);
    window.__helmWind.setOpacity(0.3);
    if (!window.__helmWind.isVisible()) throw new Error('isVisible lost state');
    window.__helmWind.setVisible(false);
  });
});
