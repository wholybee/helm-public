// RENDERMODEL-4 regression: real ENC US5GA2BC WebGPU artifact must render as a
// FILLED S-52 day chart, not a wireframe/outline debug packet.
//
// This is the deterministic, GPU-free CI gate for the RENDERMODEL-4 acceptance
// (the live browser side-by-side lives in web/test/e2e/harbour-chart-renderer.spec.js).
// It reads the SAME committed packet the browser WebGPU layer loads
// (web/data/render-artifact-us5ga2bc.json) and the SAME atlas resolver
// (chart-artifact-atlas.js) the browser uses, then asserts:
//   1. DEPARE/LNDARE/DRGARE render as FILLED polygons (triangle coverage of the
//      viewport is high) — FAILS if the packet is boundary wireframe.
//   2. Colors match the S-52 DAY palette family (buff land, blue water, near-opaque).
//   3. Draw order is preserved: area fills below depth-contour/coastline lines,
//      lines below soundings/symbols.
//
// Auto-discovered by web/test/run.mjs. Run: node web/test/rendermodel4-fill-parity.test.cjs
const fs = require('fs'), path = require('path');
const assert = require('assert');

const A = require(path.join(__dirname, '..', 'chart-artifact-atlas.js'));
const WEB = path.join(__dirname, '..');
const artifact = JSON.parse(fs.readFileSync(path.join(WEB, 'data', 'render-artifact-us5ga2bc.json'), 'utf8'));
const atlasJson = JSON.parse(fs.readFileSync(path.join(WEB, 'data', 's52-atlas-fixture.json'), 'utf8'));
const resolved = A.resolveArtifact(artifact, 'day', A.loadResources(atlasJson));

let pass = 0;
function ok(name, fn) {
  try { fn(); pass++; console.log('  ok - ' + name); }
  catch (e) { console.error('  FAIL - ' + name + ': ' + e.message); process.exitCode = 1; }
}

const FILL = ['depth_deep', 'depth_mid', 'depth_shallow', 'dredged', 'land'];
const LINE = ['depth_contour', 'coastline'];
const POINT = ['sounding', 'aid', 'hazard'];
const STRIDE = 4;

function categoryOf(batch) {
  return String((batch.primitive_ids || [])[0] || '').replace('cmd.area.', '');
}

// Sum of triangle areas (target-pixel space) for the area-fill (pattern) batches.
function fillCoverage() {
  const V = artifact.geometry.vertices_f32;
  const I = artifact.geometry.indices_u32;
  const [pw, ph] = artifact.viewport.pixel_size;
  let area = 0;
  for (const b of artifact.draw_batches) {
    const m = resolved.materials[b.material_index];
    if (!m || !m.pattern || b.topology !== 'triangles') continue;   // area fills only
    for (let k = b.first_index; k < b.first_index + b.index_count - 2; k += 3) {
      const a = I[k], bb = I[k + 1], c = I[k + 2];
      const x0 = V[a * STRIDE], y0 = V[a * STRIDE + 1];
      const x1 = V[bb * STRIDE], y1 = V[bb * STRIDE + 1];
      const x2 = V[c * STRIDE], y2 = V[c * STRIDE + 1];
      area += Math.abs((x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0)) / 2;
    }
  }
  return area / (pw * ph);
}

ok('artifact is the real US5GA2BC cell packet', () => {
  assert.strictEqual(artifact.schema_version, 'helm.render.artifact.v1');
  assert.ok(/US5GA2BC/.test(artifact.artifact_id), 'artifact_id names the real cell');
  assert.ok(artifact.draw_batches.length >= 5, 'multiple category batches');
});

ok('area features are FILLED polygons, not wireframe (coverage >> outline)', () => {
  const cov = fillCoverage();
  // A boundary-outline (wireframe) packet covers only a few percent of the view;
  // real filled land+water tiles most of the cell.
  assert.ok(cov > 0.5, 'area-fill coverage ' + cov.toFixed(3) + ' must exceed 0.5 (wireframe would be ~0.05)');
});

ok('every area-fill batch triangulates cleanly (triangles, index_count % 3 == 0)', () => {
  let fillBatches = 0;
  for (const b of artifact.draw_batches) {
    const m = resolved.materials[b.material_index];
    if (!m || !m.pattern) continue;
    fillBatches++;
    assert.strictEqual(b.topology, 'triangles', categoryOf(b) + ' fill must be triangles');
    assert.strictEqual(b.index_count % 3, 0, categoryOf(b) + ' index_count must be a triangle multiple');
    assert.ok(b.index_count >= 3, categoryOf(b) + ' must have geometry');
  }
  assert.ok(fillBatches >= 3, 'at least depth + land + one more filled category');
});

ok('S-52 day palette: buff land, blue water, near-opaque fills', () => {
  const byCat = {};
  for (const b of artifact.draw_batches) byCat[categoryOf(b)] = resolved.materials[b.material_index];

  const land = byCat.land;
  assert.ok(land && land.rgba, 'land material resolves');
  const [lr, lg, lb, la] = land.rgba;
  assert.ok(lr > 0.7 && lr > lg && lg > lb, 'land is buff (r>g>b, bright): ' + land.rgba.join(','));
  assert.ok(la >= 0.9, 'land fill is near-opaque, got alpha ' + la);

  const depth = byCat.depth_shallow || byCat.depth_mid || byCat.depth_deep;
  assert.ok(depth && depth.rgba, 'a depth band resolves');
  const [dr, , db, da] = depth.rgba;
  assert.ok(db > 0.7 && db > dr, 'depth water is blue (b dominant): ' + depth.rgba.join(','));
  assert.ok(da >= 0.9, 'depth fill is near-opaque, got alpha ' + da);
});

ok('draw order preserved: fills below lines below soundings/symbols', () => {
  const idx = {};
  artifact.draw_batches.forEach((b, i) => { idx[categoryOf(b)] = i; });
  const present = (list) => list.filter(c => idx[c] != null).map(c => idx[c]);
  const fills = present(FILL), lines = present(LINE), points = present(POINT);
  assert.ok(fills.length >= 1, 'has fill batches');
  if (lines.length) {
    assert.ok(Math.max(...fills) < Math.min(...lines), 'all area fills draw before contour/coastline lines');
  }
  if (points.length && lines.length) {
    assert.ok(Math.max(...lines) < Math.min(...points), 'lines draw before soundings/symbols');
  } else if (points.length) {
    assert.ok(Math.max(...fills) < Math.min(...points), 'fills draw before soundings/symbols');
  }
});

ok('no unresolved atlas materials in the real-cell packet', () => {
  const missing = resolved.materials.filter(m => m.missing).map(m => m.material_id);
  assert.deepStrictEqual(missing, [], 'all material refs resolve against the S-52 atlas');
});

console.log('  ' + pass + ' checks passed');
