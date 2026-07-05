// SCHED-2 unit test: browser scheduler parity with pan-no-blank fixture.
// Run: node web/tests/chart-viewport-scheduler.test.js
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

function loadScheduler() {
  const code = fs.readFileSync(path.join(__dirname, '..', 'chart-viewport-scheduler.js'), 'utf8');
  const ctx = vm.createContext({ console });
  vm.runInContext(code, ctx);
  return ctx.HelmChartViewportScheduler;
}

let pass = 0;
function ok(name, fn) {
  try { fn(); pass++; console.log('  ok - ' + name); }
  catch (e) { console.error('  FAIL - ' + name + ': ' + e.message); process.exitCode = 1; }
}

const S = loadScheduler();
const fixtureDir = path.join(__dirname, '..', '..', 'engine', 'test', 'fixtures', 'viewport-scheduler', 'pan-no-blank');
const request = JSON.parse(fs.readFileSync(path.join(fixtureDir, 'request.json'), 'utf8'));
const expected = JSON.parse(fs.readFileSync(path.join(fixtureDir, 'response.json'), 'utf8'));
const manifest = JSON.parse(fs.readFileSync(path.join(fixtureDir, 'manifest.json'), 'utf8'));

ok('buildScheduleResponse matches pan-no-blank fixture', () => {
  const response = S.buildScheduleResponse(request, { source_epoch: manifest.source_epoch });
  assert.strictEqual(JSON.stringify(response), JSON.stringify(expected));
});

ok('deg2num is deterministic for chart-1 center', () => {
  const first = S.deg2num(-81.8, 24.5, 12);
  assert.strictEqual(first[0], 1117);
  assert.strictEqual(first[1], 1760);
});

ok('buildScheduleResponse rejects missing epoch', () => {
  assert.throws(() => S.buildScheduleResponse({ schema: S.REQUEST_SCHEMA, visible: { z: 12, anchor_tile: { z: 12, x: 1, y: 2 }, viewport_px: [256, 256] } }), /source_epoch/);
});

ok('cache keys are stable', () => {
  const a = S.buildCacheKey({
    renderer: { backend: 'vulkan', scene_schema: 'helm.render.model.v1' },
    source_epoch: 'epoch@1',
    tile: { z: 12, x: 1120, y: 1756 },
    display_fingerprint: 'day:standard',
    overscan_px: 16
  });
  const b = S.buildCacheKey({
    renderer: { backend: 'vulkan', scene_schema: 'helm.render.model.v1' },
    source_epoch: 'epoch@1',
    tile: { z: 12, x: 1120, y: 1756 },
    display_fingerprint: 'day:standard',
    overscan_px: 16
  });
  assert.strictEqual(a, b);
  assert.ok(a.includes('display_fp=day:standard'));
});

console.log('\n' + pass + ' passed');
