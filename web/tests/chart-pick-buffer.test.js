// INSPECT-2 unit test: pick-buffer resolution and helm.inspect.trace.v1 assembly.
// Run: node web/tests/chart-pick-buffer.test.js
const fs = require('fs'), path = require('path'), vm = require('vm');
const assert = require('assert');

function loadPick() {
  const code = fs.readFileSync(path.join(__dirname, '..', 'chart-artifact-pick.js'), 'utf8');
  const win = { console };
  win.window = win;
  vm.runInContext(code, vm.createContext(win));
  return win.HelmChartArtifactPick;
}

function loadWebgpuTest() {
  const code = fs.readFileSync(path.join(__dirname, '..', 'chart-artifact-webgpu.js'), 'utf8');
  const win = { console, navigator: {} };
  win.window = win;
  vm.runInContext(code, vm.createContext(win));
  return win.HelmChartArtifactAuto._test;
}

let pass = 0;
function ok(name, fn) {
  try { fn(); pass++; console.log('  ok - ' + name); }
  catch (e) { console.error('  FAIL - ' + name + ': ' + e.message); process.exitCode = 1; }
}

const artifactJson = JSON.parse(fs.readFileSync(
  path.join(__dirname, '..', 'data', 'render-artifact-chart-1.json'), 'utf8'));
const provenanceJson = JSON.parse(fs.readFileSync(
  path.join(__dirname, '..', 'data', 'chart-fixture-provenance.json'), 'utf8'));
const parseArtifact = loadWebgpuTest().parseArtifactJson;
const artifact = parseArtifact(artifactJson);
const P = loadPick();

ok('pick buoy label at tile pixel [5,3]', () => {
  const id = P.pickAtTilePixel(artifact, 5, 3);
  assert.strictEqual(id, 5);
});

ok('pick depth area at tile pixel [2,2]', () => {
  const id = P.pickAtTilePixel(artifact, 2, 2);
  assert.strictEqual(id, 2);
});

ok('pick depth contour at tile pixel [6,5]', () => {
  const id = P.pickAtTilePixel(artifact, 6, 5);
  assert.strictEqual(id, 3);
});

ok('pick raster fallback at tile pixel [0,0]', () => {
  const id = P.pickAtTilePixel(artifact, 0, 0);
  assert.strictEqual(id, 1);
});

ok('raster corner may still be raster when outside vector stack', () => {
  const id = P.pickAtTilePixel(artifact, 0, 0);
  assert.strictEqual(id, 1);
});

ok('vector trace exposes source chart, feature id, and object class', () => {
  const trace = P.buildInspectionTrace({
    artifact: artifact,
    pick_id: 5,
    pixel: [5, 3],
    backend: 'cpu-pick',
    provenance: provenanceJson
  });
  assert.strictEqual(trace.schema_version, P.TRACE_SCHEMA);
  assert.strictEqual(trace.resolution.kind, 'vector_feature');
  assert.strictEqual(trace.resolution.feature_metadata_available, true);
  assert.strictEqual(trace.source.source_chart_id, 'SYNTH-CHART-1');
  assert.strictEqual(trace.source.source_feature_id, 'BOYSPP-1');
  assert.strictEqual(trace.source.object_class, 'BOYSPP');
  assert.strictEqual(trace.draw_record.command_id, 'cmd.text.boyspp-label');
  assert.ok(trace.draw_record.provenance_refs.indexOf('prov.boyspp-1') >= 0);
});

ok('raster trace is honest about missing feature metadata', () => {
  const trace = P.buildInspectionTrace({
    artifact: artifact,
    pick_id: 1,
    pixel: [2, 2],
    backend: 'cpu-pick',
    provenance: provenanceJson
  });
  assert.strictEqual(trace.resolution.kind, 'raster_fallback');
  assert.strictEqual(trace.resolution.feature_metadata_available, false);
  assert.strictEqual(trace.raster_fallback.active, true);
  assert.ok(trace.raster_fallback.message);
  assert.strictEqual(trace.source.source_feature_id, null);
});

ok('no-hit trace does not claim feature metadata', () => {
  const trace = P.buildInspectionTrace({
    artifact: artifact,
    pick_id: 0,
    pixel: [0, 0],
    backend: 'cpu-pick',
    provenance: provenanceJson
  });
  assert.strictEqual(trace.resolution.kind, 'no_hit');
  assert.strictEqual(trace.resolution.feature_metadata_available, false);
});

ok('server /query array builds vector trace with decoded attributes', () => {
  const query = [{
    acronym: 'BOYSPP',
    class_desc: 'Buoy, special purpose',
    geometry: 'point',
    attributes: { OBJNAM: { decoded: 'G 1' } }
  }];
  const trace = P.buildTraceFromServerQuery(query, { backend: 'enc-query' });
  assert.strictEqual(trace.resolution.kind, 'vector_feature');
  assert.strictEqual(trace.source.object_class, 'BOYSPP');
  assert.strictEqual(trace.source.attributes[0].code, 'OBJNAM');
  assert.strictEqual(trace.source.attributes[0].value, 'G 1');
});

ok('queryHits accepts bare server array', () => {
  const hits = P.queryHits([{ acronym: 'DEPARE' }]);
  assert.strictEqual(hits.length, 1);
  assert.strictEqual(hits[0].acronym, 'DEPARE');
});

ok('enrichTraceAttributes decodes helm-server attribute objects', () => {
  const trace = P.buildInspectionTrace({
    artifact: artifact,
    pick_id: 5,
    pixel: [5, 3],
    backend: 'cpu-pick',
    provenance: provenanceJson
  });
  const enriched = P.enrichTraceAttributes(trace, [{
    acronym: 'BOYSPP',
    attributes: { OBJNAM: { decoded: 'G 1' } }
  }]);
  assert.strictEqual(enriched.source.attributes[0].value, 'G 1');
});

console.log('\n' + pass + ' passed');
