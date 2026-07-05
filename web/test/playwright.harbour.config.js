// Playwright config for proofs against a live helm-server (no serve.py bootstrap).
const { devices } = require('@playwright/test');
const base = require('./playwright.config.js');

const projects = [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }];
if (process.env.HELM_HARBOUR_HEADED === '1') {
  projects.push({
    name: 'chrome-headed',
    testMatch: /harbour-chart-renderer\.spec\.js/,
    use: {
      ...devices['Desktop Chrome'],
      headless: false,
      channel: 'chrome'
    }
  });
}

module.exports = {
  ...base,
  timeout: Number(process.env.HELM_HARBOUR_TIMEOUT || 90000),
  webServer: undefined,
  projects
};
