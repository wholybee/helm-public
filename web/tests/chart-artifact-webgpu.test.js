// WEBGPU-1 unit test: artifact packet parse, tile projection, and visible-fallback discipline.
// Run: node web/tests/chart-artifact-webgpu.test.js
const fs = require('fs'), path = require('path'), vm = require('vm');
const assert = require('assert');

function loadModule(extraGlobals) {
  const code = fs.readFileSync(path.join(__dirname, '..', 'chart-artifact-webgpu.js'), 'utf8');
  const win = Object.assign({ console }, extraGlobals || {});
  win.window = win;
  const ctx = vm.createContext(win);
  vm.runInContext(code, ctx);
  return win;
}

let pass = 0;
function ok(name, fn) {
  try { fn(); pass++; console.log('  ok - ' + name); }
  catch (e) { console.error('  FAIL - ' + name + ': ' + e.message); process.exitCode = 1; }
}

const fixture = JSON.parse(fs.readFileSync(
  path.join(__dirname, '..', 'data', 'render-artifact-chart-1.json'), 'utf8'));
const T = loadModule().HelmChartArtifactAuto._test;

ok('parseArtifactJson accepts helm.render.artifact.v1 fixture', () => {
  const art = T.parseArtifactJson(fixture);
  assert.strictEqual(art.schema_version, T.SCHEMA);
  assert.strictEqual(art.vertices.length / T.VERTEX_STRIDE, 18);
  assert.strictEqual(art.indices.length, 27);
  assert.strictEqual(art.draw_batches.length, 6);
  assert.strictEqual(art.draw_batches[0].order_bucket, 0);
  assert.strictEqual(art.draw_batches[1].order_bucket, 10);
});

ok('parseArtifactJson rejects wrong schema', () => {
  assert.throws(() => T.parseArtifactJson({ schema_version: 'bad' }), /expected schema/);
});

ok('tilePixelToLonLat maps tile corners to geographic bbox', () => {
  const vp = T.parseArtifactJson(fixture).viewport;
  const nw = T.tilePixelToLonLat(0, 0, vp);
  const se = T.tilePixelToLonLat(vp.pixel_width, vp.pixel_height, vp);
  assert.ok(Math.abs(nw.lon - vp.west) < 1e-9);
  assert.ok(Math.abs(nw.lat - vp.north) < 1e-9);
  assert.ok(Math.abs(se.lon - vp.east) < 1e-9);
  assert.ok(Math.abs(se.lat - vp.south) < 1e-9);
});

ok('artifact bbox gate accepts Key West fixture bounds and rejects Fiji', () => {
  const art = T.parseArtifactJson(fixture);
  const bbox = T.artifactBbox(art);
  assert.strictEqual(bbox.west, -81.805);
  assert.strictEqual(bbox.south, 24.495);
  assert.strictEqual(bbox.east, -81.795);
  assert.strictEqual(bbox.north, 24.505);
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

ok('HelmChartArtifactAuto reports MapLibre fallback when WebGPU flag is off', () => {
  const win = loadModule({ HELM_CHART_WEBGPU: false, navigator: {} });
  const map = {
    getPitch: () => 0,
    getProjection: () => ({ type: 'mercator' }),
    getLayer: () => null,
    setLayoutProperty: () => {},
    on: () => {},
    off: () => {},
    getCanvas: () => ({ parentNode: { appendChild() {} }, clientWidth: 800, clientHeight: 600 })
  };
  const layer = win.HelmChartArtifactAuto(map);
  assert.strictEqual(layer.mode(), 'maplibre');
  assert.strictEqual(win.__helmChartMode, 'maplibre');
  assert.ok(String(win.__helmChartModeReason).indexOf('not enabled') >= 0);
});

ok('HelmChartArtifactAuto stays on MapLibre when WebGPU flag is not enabled', () => {
  const win = loadModule({ navigator: {}, localStorage: { getItem: () => null } });
  const map = {
    getPitch: () => 0,
    getProjection: () => ({ type: 'mercator' }),
    getLayer: () => null,
    setLayoutProperty: () => {},
    on: () => {},
    off: () => {},
    getCanvas: () => ({ parentNode: { appendChild() {} }, clientWidth: 800, clientHeight: 600 })
  };
  const layer = win.HelmChartArtifactAuto(map);
  assert.strictEqual(layer.mode(), 'maplibre');
  assert.ok(String(win.__helmChartModeReason).indexOf('not enabled') >= 0);
});

ok('HelmChartArtifactAuto reports MapLibre fallback when navigator.gpu is missing', () => {
  const win = loadModule({ HELM_CHART_WEBGPU: true, navigator: {} });
  const map = {
    getPitch: () => 0,
    getProjection: () => ({ type: 'mercator' }),
    getLayer: () => null,
    setLayoutProperty: () => {},
    on: () => {},
    off: () => {},
    getCanvas: () => ({ parentNode: { appendChild() {} }, clientWidth: 800, clientHeight: 600 })
  };
  const layer = win.HelmChartArtifactAuto(map);
  assert.strictEqual(layer.mode(), 'maplibre');
  assert.ok(String(win.__helmChartModeReason).indexOf('WebGPU unavailable') >= 0);
});

console.log('\n' + pass + ' passed');
