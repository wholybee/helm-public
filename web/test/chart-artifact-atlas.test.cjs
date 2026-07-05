// WEBGPU-2 unit test: atlas/material resolver — palette day/dusk/night, symbol/
// line/pattern keys, display-state toggles, diagnostics, and dash expansion.
// Auto-discovered by web/test/run.mjs. Run: node web/test/chart-artifact-atlas.test.cjs
const fs = require('fs'), path = require('path');
const assert = require('assert');

const A = require(path.join(__dirname, '..', 'chart-artifact-atlas.js'));
const fixture = JSON.parse(fs.readFileSync(
  path.join(__dirname, '..', 'data', 'render-artifact-chart-1.json'), 'utf8'));

let pass = 0;
function ok(name, fn) {
  try { fn(); pass++; console.log('  ok - ' + name); }
  catch (e) { console.error('  FAIL - ' + name + ': ' + e.message); process.exitCode = 1; }
}

function findMat(art, styleKey) {
  return (art.material_table || []).filter(function (m) { return m.style_key === styleKey; })[0];
}

ok('hexToRgb parses 6-digit hex (BOYSPP day)', () => {
  assert.deepStrictEqual(A.hexToRgb('#f5d76e'), [245, 215, 110]);
  assert.deepStrictEqual(A.hexToRgb('f5d76e'), [245, 215, 110]);
  assert.strictEqual(A.hexToRgb('nope'), null);
});

ok('rgbToUnit normalizes to 0..1 with alpha', () => {
  const u = A.rgbToUnit([255, 0, 128], 0.5);
  assert.ok(Math.abs(u[0] - 1) < 1e-9 && u[1] === 0 && Math.abs(u[2] - 128 / 255) < 1e-9 && u[3] === 0.5);
});

ok('paletteFromDisplayState reads the ARTIFACT-2 cache display_state', () => {
  assert.strictEqual(A.paletteFromDisplayState(fixture), 'day');           // full artifact
  assert.strictEqual(A.paletteFromDisplayState('NIGHT'), 'night');          // string
  assert.strictEqual(A.paletteFromDisplayState({ display_state: { palette: 'dusk' } }), 'dusk');
  assert.strictEqual(A.paletteFromDisplayState(null), 'day');               // default
  assert.strictEqual(A.paletteFromDisplayState('bogus'), 'day');            // invalid -> day
});

ok('loadResources mirrors the engine fixture (BOYSPP/DEPCNT02/DEPARE01)', () => {
  const json = JSON.parse(fs.readFileSync(
    path.join(__dirname, '..', 'data', 's52-atlas-fixture.json'), 'utf8'));
  const res = A.loadResources(json);
  assert.ok(res.byName.BOYSPP && res.byName.DEPCNT02 && res.byName.DEPARE01);
  assert.deepStrictEqual(res.byName.DEPCNT02.dash, [3, 2]);
});

ok('resolveMaterial(symbol) uses the atlas entry + palette color', () => {
  const m = findMat(fixture, 'place_symbol');
  const r = A.resolveMaterial(m, 'day');
  assert.strictEqual(r.source, 'atlas');
  assert.ok(r.symbol && r.symbol.name === 'BOYSPP' && r.symbol.width === 12);
  assert.deepStrictEqual(r.symbol.anchor, [6, 6]);
  assert.ok(Math.abs(r.rgba[0] - 245 / 255) < 1e-6);   // BOYSPP day #f5d76e
  assert.strictEqual(r.missing, false);
});

ok('resolveMaterial(line) resolves dash + width + palette color', () => {
  const m = findMat(fixture, 'stroke_line');
  const r = A.resolveMaterial(m, 'day');
  assert.strictEqual(r.source, 'atlas');
  assert.deepStrictEqual(r.line.dash, [3, 2]);
  assert.strictEqual(r.line.width, 4);                  // DEPCNT02 height
  assert.ok(Math.abs(r.rgba[0] - 74 / 255) < 1e-6);     // DEPCNT02 day #4a6f8a
});

ok('resolveMaterial(area fill, no ref) uses named palette fallback, not flagged missing', () => {
  const m = findMat(fixture, 'fill_area');
  const r = A.resolveMaterial(m, 'day');
  assert.strictEqual(r.source, 'palette-fallback');
  assert.strictEqual(r.missing, false);
  assert.ok(r.rgba[3] > 0 && r.rgba[3] < 1);            // fill alpha
});

ok('resolveMaterial(raster with unresolved ref) is flagged missing with a diagnostic note', () => {
  const m = findMat(fixture, 'draw_raster_sheet');
  const r = A.resolveMaterial(m, 'day');
  assert.strictEqual(r.source, 'palette-fallback');
  assert.strictEqual(r.missing, true);
  assert.ok(/unresolved atlas ref/.test(r.note));
});

ok('palette variants differ (day vs dusk vs night) for the same symbol', () => {
  const m = findMat(fixture, 'place_symbol');
  const day = A.resolveMaterial(m, 'day').rgba;
  const dusk = A.resolveMaterial(m, 'dusk').rgba;
  const night = A.resolveMaterial(m, 'night').rgba;
  assert.notDeepStrictEqual(day, dusk);
  assert.notDeepStrictEqual(dusk, night);
});

ok('resolveArtifact resolves all materials and collects the unresolved-raster diagnostic', () => {
  const out = A.resolveArtifact(fixture, null);   // palette inferred from cache -> day
  assert.strictEqual(out.palette, 'day');
  assert.strictEqual(out.materials.length, fixture.material_table.length);
  assert.ok(out.diagnostics.length >= 1);
  assert.ok(out.diagnostics.some(d => d.material_index === 0 && d.code === 'atlas.unresolved_ref'));
  assert.ok(out.materials.every(m => m.visible === true));   // show_text/show_soundings true in fixture
});

ok('batchVisibleForDisplayState honors show_text / show_soundings', () => {
  const text = { style_key: 'draw_text' };
  const snd = { style_key: 'draw_sounding' };
  assert.strictEqual(A.batchVisibleForDisplayState(text, { show_text: false }), false);
  assert.strictEqual(A.batchVisibleForDisplayState(text, { show_text: true }), true);
  assert.strictEqual(A.batchVisibleForDisplayState(snd, { show_soundings: false }), false);
  assert.strictEqual(A.batchVisibleForDisplayState({ style_key: 'fill_area' }, { show_text: false }), true);
});

ok('packMaterialColors packs 32 vec4 with material[0] first', () => {
  const out = A.resolveArtifact(fixture, 'day');
  const packed = A.packMaterialColors(out.materials, 32);
  assert.strictEqual(packed.length, 128);
  assert.ok(Math.abs(packed[0] - out.materials[0].rgba[0]) < 1e-6);   // Float32 rounding
});

ok('dashSegments splits a segment into on/off runs', () => {
  const segs = A.dashSegments(0, 0, 10, 0, [3, 2], 1);   // on 3, off 2 -> on runs at 0-3, 5-8, 10..
  assert.ok(segs.length >= 2);
  assert.ok(Math.abs(segs[0][0] - 0) < 1e-9 && Math.abs(segs[0][2] - 3) < 1e-9);
  assert.ok(Math.abs(segs[1][0] - 5) < 1e-9 && Math.abs(segs[1][2] - 8) < 1e-9);
});

ok('dashSegments with no dash returns the whole segment; zero-length returns none', () => {
  assert.deepStrictEqual(A.dashSegments(0, 0, 4, 0, [], 1), [[0, 0, 4, 0]]);
  assert.deepStrictEqual(A.dashSegments(2, 2, 2, 2, [3, 2], 1), []);
});

console.log('\n' + pass + ' passed');
