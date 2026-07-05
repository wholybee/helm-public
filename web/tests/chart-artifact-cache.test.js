// SCHED-2 unit test: artifact cache admission and covering draw entries.
// Run: node web/tests/chart-artifact-cache.test.js
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

function loadModule(relPath, exportName) {
  const code = fs.readFileSync(path.join(__dirname, '..', relPath), 'utf8');
  const ctx = vm.createContext({ console });
  vm.runInContext(code, ctx);
  return ctx[exportName];
}

const Scheduler = loadModule('chart-viewport-scheduler.js', 'HelmChartViewportScheduler');
const Cache = loadModule('chart-artifact-cache.js', 'HelmChartArtifactCache');

const fixtureDir = path.join(__dirname, '..', '..', 'engine', 'test', 'fixtures', 'viewport-scheduler', 'pan-no-blank');
const request = JSON.parse(fs.readFileSync(path.join(fixtureDir, 'request.json'), 'utf8'));
const response = Scheduler.buildScheduleResponse(request, { source_epoch: 'synthetic-chart-1@2026-06-28' });

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

  await ok('prefetch admits artifacts for schedule entries', async () => {
    const cache = new Cache();
    let fetches = 0;
    await cache.prefetch(response, function () {
      fetches++;
      return Promise.resolve({ artifact_id: 'a' + fetches });
    });
    assert.strictEqual(fetches, response.entries.length);
    assert.strictEqual(cache.snapshot().size, response.entries.length);
  });

  await ok('coveringDrawEntries reports strict misses until visible set is cached', async () => {
    const cache = new Cache();
    cache.admit(response.entries[0], { artifact_id: response.entries[0].entry_id });
    const partial = cache.coveringDrawEntries(response);
    assert.strictEqual(partial.strictMissing, true);

    response.entries.forEach(function (entry) {
      cache.admit(entry, { artifact_id: entry.entry_id });
    });
    const full = cache.coveringDrawEntries(response);
    assert.strictEqual(full.strictMissing, false);
    assert.strictEqual(full.entries.length, response.entries.length);
  });

  console.log('\n' + pass + ' passed');
}

main();
