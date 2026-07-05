// TOOLS-2: cursor coordinate readout supports DMS, degrees-decimal-minutes,
// and decimal formats, with the chosen format persisted through HelmStore.
const { test, expect } = require('@playwright/test');
const { boot } = require('./_helpers');

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    try {
      localStorage.clear();
      sessionStorage.clear();
    } catch (e) {}
  });
  await page.route(/https?:\/\/[^/]+:8093\/.*/, route => route.fulfill({ status: 503, body: 'weather gateway intentionally offline in test' }));
});

test('cursor coordinate HUD switches formats and persists the choice', async ({ page }) => {
  await boot(page);
  await page.evaluate(() => window.HelmCoordinates.preview({ lng: 178.12, lat: -17.75 }, 'cursor'));

  const hud = page.locator('.coord-hud');
  await expect(hud).toContainText("17°45.000'S");
  await expect(hud).toContainText("178°07.200'E");

  await page.evaluate(() => window.HelmShell.panel('helm-tools-coordinates').open());
  await page.locator('#helm-tools-coordinates button[data-coord-format="dms"]').click();
  await expect(hud).toContainText('17°45\'00.0"S');
  await expect(hud).toContainText('178°07\'12.0"E');
  await expect.poll(async () => page.evaluate(() => localStorage.getItem('helm.tools.coordFormat'))).toBe(JSON.stringify('dms'));

  await page.locator('#helm-tools-coordinates button[data-coord-format="dec"]').click();
  await expect(hud).toContainText('17.75000°S');
  await expect(hud).toContainText('178.12000°E');
  await expect.poll(async () => page.evaluate(() => window.HelmCoordinates.getFormat())).toBe('dec');
});
