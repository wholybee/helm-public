// WX-35 retirement gate — the repo-grep proof, as a test so CI fails LOUDLY if a
// retired weather entrypoint creeps back. Retired by this gate:
//   - wx-live.js (gesture-fetching "Live · fills view" viewport path; zero call sites)
//   - the legacy data/wind.json particle autoload (404'd forever, raced the scene
//     with an empty-but-visible engine)
//   - client-side viewport materialize / hidden gateway substitution (removed by
//     WX-30; this pins them out)
// Prose/comments describing the retirement are allowed; executable references are not.
// Run: node web/tests/wx-retirement-gate.test.js
const fs = require('fs'), path = require('path');
const assert = require('assert');

const WEB = path.join(__dirname, '..');
let pass = 0;
function ok(name, fn) {
  try { fn(); pass++; console.log('  ok - ' + name); }
  catch (e) { console.error('  FAIL - ' + name + ': ' + e.message); process.exitCode = 1; }
}
const read = f => fs.readFileSync(path.join(WEB, f), 'utf8');
const webFiles = fs.readdirSync(WEB).filter(f => f.endsWith('.js') || f === 'index.html' || f === 'sw.js');

ok('wx-live.js is gone: no file, no script tag, no precache entry, no API calls', () => {
  assert.ok(!fs.existsSync(path.join(WEB, 'wx-live.js')), 'web/wx-live.js must not exist');
  assert.ok(!/<script[^>]*wx-live\.js/.test(read('index.html')), 'no script tag');
  assert.ok(!/wx-live\.js/.test(read('sw.js')), 'no service-worker precache entry');
  for (const f of webFiles) {
    const src = read(f);
    assert.ok(!/HelmWxLive\s*[.(]/.test(src), `executable HelmWxLive reference in ${f}`);
    assert.ok(!/window\.HelmWxLive/.test(src), `window.HelmWxLive reference in ${f}`);
  }
});

ok('legacy data/wind.json particle autoload is retired (scene owns particles)', () => {
  const html = read('index.html');
  assert.ok(!/wind\.load\(/.test(html), 'no legacy wind.load() in index.html');
  assert.ok(!/velUrl/.test(html), 'velUrl helper removed');
  assert.ok(!/data\/wind\.json/.test(html), 'no data/wind.json reference');
});

ok('no client-side viewport materialize or silent gateway substitution entrypoints', () => {
  for (const f of webFiles) {
    const src = read(f);
    assert.ok(!/materializeUrl|quantizeViewForMaterialize/.test(src), `viewport-materialize entrypoint in ${f}`);
    const noComments = src.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
    assert.ok(!/['"]force-cache['"]/.test(noComments), `range-unsafe force-cache in ${f}`);
  }
});

// WX-26: the prepared-bundle scene and the :8093 gateway are retired — pinned here forever.
ok('bundle scene is gone: no files, no tags, no executable refs, no gateway port', () => {
  for (const f of ['wx-scene.js', 'wx-scene-webgpu.js']) {
    assert.ok(!fs.existsSync(path.join(WEB, f)), `web/${f} must not exist`);
  }
  assert.ok(!/<script[^>]*wx-scene/.test(read('index.html')), 'no scene script tags');
  assert.ok(!/wx-scene/.test(read('sw.js')), 'no scene precache entries');
  for (const f of webFiles) {
    const noComments = read(f).replace(/\/\/[^\n]*/g, '')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/<!--[\s\S]*?-->/g, '');
    assert.ok(!/HelmWxScene\b|HelmWxSceneGPU\b/.test(noComments), `executable HelmWxScene reference in ${f}`);
    assert.ok(!/:8093|WX_SERVICE|\/bundles\/index\.json|\/velocity\//.test(noComments), `gateway reference in ${f}`);
  }
});

ok('grid path is present, loud, and precached for offline reload', () => {
  for (const f of ['wx-grid-pack-client.js', 'wx-grid-decode.js', 'wx-grid-scene.js']) {
    assert.ok(fs.existsSync(path.join(WEB, f)), f + ' present');
  }
  const scene = read('wx-grid-scene.js');
  assert.ok(/unsupported_renderer_capability/.test(scene), 'capability failures are loud');
  const sceneCode = scene.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(!/8093|WX_SERVICE|gatewayFallback/.test(sceneCode), 'grid scene has no gateway/service fallback code');
  const sw = read('sw.js');
  for (const f of ['wx-grid-pack-client.js', 'wx-grid-decode.js', 'wx-grid-scene.js', 'wx-particles-webgpu.js']) {
    assert.ok(sw.includes(`'./${f}'`), `${f} missing from the service-worker precache (offline reload loses weather)`);
  }
  // the drawer keeps the no-substitution promise in its fail-loud copy
  assert.ok(/no gateway\/direct fallback\/download/.test(read('wx-controls.js')), 'fail-loud promise text intact');
});

ok('wx-scrim never dims the weather itself (prefix exclusion, not a stale id list)', () => {
  const scrim = fs.readFileSync(path.join(WEB, 'wx-scrim.js'), 'utf8');
  assert.ok(/indexOf\('helm-wx-'\) === 0|startsWith\('helm-wx-'\)/.test(scrim),
    'weather rasters excluded by helm-wx- PREFIX (a hardcoded id list crushed helm-wx-grid-0/1 to 0.42 brightness)');
  assert.ok(!/WX_RASTER\s*=/.test(scrim), 'stale hardcoded exclusion list removed');
});

console.log((process.exitCode ? 'FAIL' : 'ok') + ' - wx-retirement-gate: ' + pass + ' groups passed');
