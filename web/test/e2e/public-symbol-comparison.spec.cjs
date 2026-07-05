const { test, expect } = require('@playwright/test');

const BASE_URL = process.env.HELM_PUBLIC_CATALOG_URL;

test.skip(!BASE_URL, 'Set HELM_PUBLIC_CATALOG_URL to run the public catalog comparison proof.');

async function loadedImage(locator) {
  await expect(locator).toBeVisible();
  await expect.poll(async () => locator.evaluate((img) => img.naturalWidth), {
    message: 'image should decode to a nonzero width',
  }).toBeGreaterThan(0);
  return locator.evaluate((img) => ({
    complete: img.complete,
    naturalWidth: img.naturalWidth,
    naturalHeight: img.naturalHeight,
    src: img.currentSrc,
  }));
}

test('public symbol detail renders bundled S-101 and OpenCPN comparison images', async ({ page }) => {
  await page.goto(`${BASE_URL}/?symbol=ACHARE02`);
  await expect(page.locator('#detailTitle')).toHaveText(/ACHARE02/);

  const helm = page.locator('.cmp-panel').filter({ hasText: 'Helm resolved' }).locator('img');
  const s101 = page.locator('.cmp-panel').filter({ hasText: 'S-101 evidence' }).locator('img');
  const opencpn = page.locator('.cmp-panel').filter({ hasText: 'OpenCPN / S-52 evidence' }).locator('img');

  const helmImage = await loadedImage(helm);
  const s101Image = await loadedImage(s101);
  const opencpnImage = await loadedImage(opencpn);

  expect(helmImage.naturalWidth).toBeGreaterThan(0);
  expect(s101Image.naturalWidth).toBeGreaterThan(0);
  expect(opencpnImage.naturalWidth).toBeGreaterThan(0);
  expect(s101Image.src).toContain('/assets/comparison/s101/ACHARE02.svg');
  expect(opencpnImage.src).toContain('/assets/comparison/opencpn/ACHARE02__day.png');
});

test('public symbol detail renders OpenCPN comparison even when S-101 direct witness is absent', async ({ page }) => {
  await page.goto(`${BASE_URL}/?symbol=BOYCAN60`);
  await expect(page.locator('#detailTitle')).toHaveText(/BOYCAN60/);
  await expect(page.locator('.cmp-panel').filter({ hasText: 'S-101 evidence' }).locator('img')).toHaveCount(0);

  const opencpn = page.locator('.cmp-panel').filter({ hasText: 'OpenCPN / S-52 evidence' }).locator('img');
  const opencpnImage = await loadedImage(opencpn);
  expect(opencpnImage.src).toContain('/assets/comparison/opencpn/BOYCAN60__day.png');
});

test('public symbol detail reports truly missing OpenCPN renders without broken images', async ({ page }) => {
  await page.goto(`${BASE_URL}/?symbol=BOYLAT52`);
  await expect(page.locator('#detailTitle')).toHaveText(/BOYLAT52/);
  await expect(page.locator('.cmp-panel').filter({ hasText: 'OpenCPN / S-52 evidence' }).locator('img')).toHaveCount(0);
  await expect(page.locator('.cmp-panel').filter({ hasText: 'OpenCPN / S-52 evidence' })).toContainText('PNG is not present in this public export');
});
