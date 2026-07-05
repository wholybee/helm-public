// CLIENT-24 — layer/overdraw budget invariants for the served style.
// These are cheap, correct-by-construction perf guards, pinned so a future style
// edit can't silently reintroduce them. Run: node web/tests/style-layer-budget.test.js
const fs = require('fs'), path = require('path'), assert = require('assert');

const STYLE_DIR = path.join(__dirname, '..', 'style');
const man = JSON.parse(fs.readFileSync(path.join(STYLE_DIR, 'manifest.json'), 'utf8'));

// Merge base + fragments exactly as HelmShell.buildStyle() does (draw order == manifest order).
const merged = JSON.parse(fs.readFileSync(path.join(STYLE_DIR, man.base), 'utf8'));
merged.layers = merged.layers || [];
for (const f of man.fragments) {
  const frag = JSON.parse(fs.readFileSync(path.join(STYLE_DIR, f), 'utf8'));
  merged.layers.push(...(frag.layers || []));
}
const byId = Object.fromEntries(merged.layers.map(l => [l.id, l]));

let pass = 0;
function ok(name, fn) { try { fn(); pass++; console.log('  ok - ' + name); }
  catch (e) { console.error('  FAIL - ' + name + ': ' + e.message); process.exitCode = 1; } }

ok('every raster layer pins raster-fade-duration (no implicit 300ms cross-fade)', () => {
  const rasters = merged.layers.filter(l => l.type === 'raster');
  assert.ok(rasters.length >= 6, 'expected the basemap rasters');
  for (const r of rasters) {
    const fd = (r.paint || {})['raster-fade-duration'];
    assert.strictEqual(fd, 0, `${r.id} must set raster-fade-duration:0 (got ${fd}) — the default 300ms double-draws every streamed tile`);
  }
});

ok('enc-chart (primary visible chart) is fade-pinned', () => {
  assert.strictEqual((byId['enc-chart'].paint || {})['raster-fade-duration'], 0);
});

ok('soundg-text is zoom-gated (no whole-viewport sounding collision at ocean scale)', () => {
  const s = byId['soundg-text'];
  assert.ok(s, 'soundg-text present');
  assert.strictEqual(s.layout['text-allow-overlap'], false, 'soundings collide (that is why the gate matters)');
  assert.ok(s.minzoom >= 12, `soundg-text needs minzoom>=12 (got ${s.minzoom}) — matches the z12 label gates`);
});

ok('wind-arrows ships hidden (WebGPU particles replaced it; no first-frame placement)', () => {
  assert.strictEqual((byId['wind-arrows'].layout || {}).visibility, 'none');
});

console.log((process.exitCode ? 'FAIL' : 'ok') + ' - style-layer-budget: ' + pass + ' groups passed');
