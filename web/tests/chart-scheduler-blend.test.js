// SCHED-2 unit test: scheduler blend must not reuse a fixed artifact outside
// its own geographic bbox. Run: node web/tests/chart-scheduler-blend.test.js
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

function loadBrowserModules() {
  const ctx = vm.createContext({ console });
  ['chart-viewport-scheduler.js', 'chart-artifact-cache.js', 'chart-artifact-webgpu.js', 'chart-scheduler-blend.js']
    .forEach((name) => {
      const code = fs.readFileSync(path.join(__dirname, '..', name), 'utf8');
      vm.runInContext(code, ctx, { filename: name });
    });
  return ctx;
}

function fakeMap() {
  return {
    on: () => {},
    off: () => {},
    getCanvas: () => ({ clientWidth: 256, clientHeight: 256 }),
    getCenter: () => ({ lng: -81.8, lat: 24.5 }),
    getZoom: () => 12,
    getBearing: () => 0
  };
}

const fixture = JSON.parse(fs.readFileSync(
  path.join(__dirname, '..', 'data', 'render-artifact-chart-1.json'), 'utf8'));

async function main() {
  let pass = 0;
  async function ok(name, fn) {
    try {
      await fn();
      pass++;
      console.log('  ok - ' + name);
    } catch (e) {
      console.error('  FAIL - ' + name + ': ' + e.message);
      process.exitCode = 1;
    }
  }

  await ok('artifactIntersectsViewport accepts Key West and rejects Fiji', async () => {
    const ctx = loadBrowserModules();
    const S = ctx.HelmChartViewportScheduler;
    const B = ctx.HelmChartSchedulerBlend._test;
    const art = ctx.HelmChartArtifactAuto._test.parseArtifactJson(fixture);
    const keyWest = S.deg2num(-81.8, 24.5, 12);
    const fiji = S.deg2num(177.4, -17.7, 12);
    assert.strictEqual(B.artifactIntersectsViewport(art, S.tileViewport(12, keyWest[0], keyWest[1])), true);
    assert.strictEqual(B.artifactIntersectsViewport(art, S.tileViewport(12, fiji[0], fiji[1])), false);
  });

  await ok('_fetchArtifactForEntry preserves artifact viewport and rejects uncovered tiles', async () => {
    const ctx = loadBrowserModules();
    const S = ctx.HelmChartViewportScheduler;
    ctx.fetch = () => Promise.resolve({
      ok: true,
      json: () => Promise.resolve(fixture)
    });
    const blend = new ctx.HelmChartSchedulerBlend(fakeMap(), { getGpuLayer: () => null }, {});
    const keyWest = S.deg2num(-81.8, 24.5, 12);
    const art = await blend._fetchArtifactForEntry({ tile: { z: 12, x: keyWest[0], y: keyWest[1] } });
    assert.strictEqual(art.viewport.west, -81.805);
    assert.strictEqual(art.viewport.pixel_width, 8);

    const fiji = S.deg2num(177.4, -17.7, 12);
    await assert.rejects(
      () => blend._fetchArtifactForEntry({ tile: { z: 12, x: fiji[0], y: fiji[1] } }),
      /does not cover scheduled tile/
    );
  });

  console.log('\n' + pass + ' passed');
}

main();
