// WX-26 unit test: the drawer's fail-loud message discipline + the release pack picker.
// (Replaces the WX-19 coverage-machinery tests — viewBox/coverageReport/candidateRank died
// with the bundle scene; discovery now picks packs from the release index.)
// Run: node web/tests/wx-controls-coverage.test.js
const fs = require('fs'), path = require('path'), vm = require('vm');
const assert = require('assert');

let pass = 0;
function ok(name, fn) {
  try { fn(); pass++; console.log('  ok - ' + name); }
  catch (e) { console.error('  FAIL - ' + name + ': ' + e.message); process.exitCode = 1; }
}

// ---- failLoudText (pinned: verified-local-ui.spec asserts these strings in the DOM) ----
const controls = fs.readFileSync(path.join(__dirname, '..', 'wx-controls.js'), 'utf8');
const winC = {
  console, setTimeout, clearTimeout,
  location: { protocol: 'http:', hostname: 'localhost' },
  document: {
    getElementById: () => null, createElement: () => ({ style: {}, addEventListener: () => {} }),
    querySelector: () => null, querySelectorAll: () => [], readyState: 'loading',
    body: { appendChild: () => {} }
  },
  addEventListener: () => {}
};
winC.window = winC;
vm.runInContext(controls, vm.createContext(winC));

ok('failLoudText carries the code, the reason, and the no-fallback promise', () => {
  const t = winC.HelmWxControls._test.failLoudText('wind', 'missing_release', 'weather release pointer could not be loaded');
  assert.ok(t.includes('Live wind unavailable'));
  assert.ok(t.includes('missing_release'));
  assert.ok(t.includes('no gateway/direct fallback/download'), 'the no-substitution promise is part of the message');
  const d = winC.HelmWxControls._test.failLoudText('rain', null, null);
  assert.ok(d.includes('weather_pack_unavailable'), 'default code is honest, not green');
});

// ---- pickPack (pure discovery choice logic from wx-grid-pack-client.js) ----
const client = fs.readFileSync(path.join(__dirname, '..', 'wx-grid-pack-client.js'), 'utf8');
const winP = { console, location: { href: 'http://localhost/' } };
winP.window = winP;
vm.runInContext(client, vm.createContext(winP));
const pickPack = winP.HelmWxGridPacks.pickPack;

const release = { packs: [
  { packId: 'global', tier: 'global-low', layers: ['wind', 'rain'],
    coverage: { global: true, bbox: [-180, -90, 180, 90] } },
  { packId: 'fiji', tier: 'route-high', layers: ['wind', 'waves'],
    coverage: { global: false, bbox: [157.4, -32.6, 197.4, -2.6] } }   // crosses 180 (east unwrapped)
] };

ok('prefers the covering route-high pack over global-low', () => {
  const r = pickPack(release, 'wind', { lat: -17.6, lng: 177.4 });
  assert.strictEqual(r.miss, false);
  assert.strictEqual(r.pack.packId, 'fiji');
});

ok('antimeridian coverage: a point at -175 lon is inside the wrapped Fiji bbox', () => {
  const r = pickPack(release, 'waves', { lat: -17, lng: -175 });   // = 185E, inside 157.4..197.4
  assert.strictEqual(r.miss, false);
  assert.strictEqual(r.pack.packId, 'fiji');
});

ok('falls back to the global pack when the view leaves route coverage', () => {
  const r = pickPack(release, 'wind', { lat: 40, lng: -70 });      // North Atlantic
  assert.strictEqual(r.miss, false);
  assert.strictEqual(r.pack.packId, 'global');
});

ok('layer only in a non-covering pack -> honest miss, never a silent stretch', () => {
  const r = pickPack(release, 'waves', { lat: 40, lng: -70 });     // waves only in fiji pack
  assert.strictEqual(r.miss, true);
  assert.ok(/no installed pack covers/.test(r.reason));
});

ok('layer in no pack -> null (caller raises out_of_pack with available list)', () => {
  assert.strictEqual(pickPack(release, 'cape', { lat: 0, lng: 0 }), null);
});

console.log((process.exitCode ? 'FAIL' : 'ok') + ' - wx-controls (WX-26): ' + pass + ' groups passed');
