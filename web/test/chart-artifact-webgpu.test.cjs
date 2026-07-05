// WEBGPU-1/2 unit test (CI-discoverable): artifact parse incl. ARTIFACT-2 cache
// block, visible-fallback discipline, and WEBGPU-2 palette/display-state wiring.
// Loads chart-artifact-atlas.js + chart-artifact-webgpu.js into one sandbox so
// the resolver hook is exercised. Run: node web/test/chart-artifact-webgpu.test.cjs
const fs = require('fs'), path = require('path'), vm = require('vm');
const assert = require('assert');

const WEB = path.join(__dirname, '..');
const atlasCode = fs.readFileSync(path.join(WEB, 'chart-artifact-atlas.js'), 'utf8');
const gpuCode = fs.readFileSync(path.join(WEB, 'chart-artifact-webgpu.js'), 'utf8');

// Build a browser-ish sandbox with both modules loaded (atlas first so the
// WebGPU module can find window.HelmChartArtifactAtlas).
function loadModules(extraGlobals) {
  const win = Object.assign({ console }, extraGlobals || {});
  win.window = win;
  const ctx = vm.createContext(win);
  vm.runInContext(atlasCode, ctx);
  vm.runInContext(gpuCode, ctx);
  return win;
}

function fakeMap() {
  return {
    getPitch: () => 0,
    getProjection: () => ({ type: 'mercator' }),
    getLayer: () => null,
    setLayoutProperty: () => {},
    on: () => {}, off: () => {},
    getCanvas: () => ({ parentNode: { appendChild() {} }, clientWidth: 800, clientHeight: 600 })
  };
}

const fixture = JSON.parse(fs.readFileSync(path.join(WEB, 'data', 'render-artifact-chart-1.json'), 'utf8'));

let pass = 0;
function ok(name, fn) {
  try { fn(); pass++; console.log('  ok - ' + name); }
  catch (e) { console.error('  FAIL - ' + name + ': ' + e.message); process.exitCode = 1; }
}

ok('atlas module is present in the shared sandbox', () => {
  const win = loadModules({ navigator: {} });
  assert.ok(win.HelmChartArtifactAtlas, 'HelmChartArtifactAtlas should be defined');
  assert.strictEqual(typeof win.HelmChartArtifactAuto, 'function');
});

ok('parseArtifactJson preserves the ARTIFACT-2 cache display_state', () => {
  const T = loadModules({ navigator: {} }).HelmChartArtifactAuto._test;
  const art = T.parseArtifactJson(fixture);
  assert.ok(art.cache && art.cache.display_state);
  assert.strictEqual(art.cache.display_state.palette, 'day');
  assert.strictEqual(art.cache.display_state.show_text, true);
});

ok('artifact bbox gate rejects unrelated harbour bounds', () => {
  const T = loadModules({ navigator: {} }).HelmChartArtifactAuto._test;
  const art = T.parseArtifactJson(fixture);
  assert.strictEqual(T.artifactIntersectsBounds(art, {
    west: -81.82,
    south: 24.48,
    east: -81.78,
    north: 24.52
  }), true);
  assert.strictEqual(T.artifactIntersectsBounds(art, {
    west: 177.3,
    south: -17.8,
    east: 177.5,
    north: -17.6
  }), false);
});

ok('MapLibre fallback still holds when WebGPU is unavailable', () => {
  const win = loadModules({ navigator: {} });
  const layer = win.HelmChartArtifactAuto(fakeMap());
  assert.strictEqual(layer.mode(), 'maplibre');
  assert.strictEqual(win.__helmChartMode, 'maplibre');
});

ok('setDisplayState normalizes palette and publishes __helmChartAtlas (fallback mode)', () => {
  const win = loadModules({ navigator: {} });
  const layer = win.HelmChartArtifactAuto(fakeMap());
  assert.strictEqual(layer.setDisplayState('NIGHT'), 'night');
  assert.strictEqual(layer.getPalette(), 'night');
  assert.ok(win.__helmChartAtlas && win.__helmChartAtlas.available === true);
  assert.strictEqual(win.__helmChartAtlas.palette, 'night');
  assert.strictEqual(layer.setDisplayState('bogus'), 'day');   // invalid -> day
});

ok('getDiagnostics is safe (returns array) under the MapLibre fallback', () => {
  const win = loadModules({ navigator: {} });
  const layer = win.HelmChartArtifactAuto(fakeMap());
  assert.ok(Array.isArray(layer.getDiagnostics()));
});

console.log('\n' + pass + ' passed');
