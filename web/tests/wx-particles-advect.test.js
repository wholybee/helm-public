// WX-25 unit test: GPU particle engine — advection-math parity with the CPU engine,
// affine recovery, NODATA packing, and the facade's visible-fallback discipline.
// Run: node web/tests/wx-particles-advect.test.js
const fs = require('fs'), path = require('path'), vm = require('vm');
const assert = require('assert');

function loadModule(extraGlobals) {
  const code = fs.readFileSync(path.join(__dirname, '..', 'wx-particles-webgpu.js'), 'utf8');
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

// ---- pure math ------------------------------------------------------------
const T = loadModule().HelmWindAuto._test;

ok('softClampPx passes through below 8 and soft-clamps above (CPU formula)', () => {
  assert.strictEqual(T.softClampPx(3), 3);
  assert.strictEqual(T.softClampPx(8), 8);
  assert.strictEqual(T.softClampPx(18), 8 + 10 * 0.3);
});

ok('stepGeo matches the CPU engine formula exactly', () => {
  // independent reimplementation of wind-layer.js _frame math
  function cpuStep(u, v, degPerPx, cosLat, speedFactor) {
    const spd = Math.sqrt(u * u + v * v);
    let pxStep = spd * speedFactor;
    if (pxStep > 8) pxStep = 8 + (pxStep - 8) * 0.3;
    const stepDeg = pxStep * degPerPx;
    const inv = spd > 1e-6 ? 1 / spd : 0;
    return [(u * inv) * stepDeg / cosLat, (v * inv) * stepDeg];
  }
  const cases = [[12, -5], [0.5, 0.5], [200, 0], [0, 0], [-30, 44]];
  for (const [u, v] of cases) {
    const g = T.stepGeo(u, v, 0.0005, 0.94, 0.073);
    const c = cpuStep(u, v, 0.0005, 0.94, 0.073);
    assert.ok(Math.abs(g.dlon - c[0]) < 1e-12, `dlon u=${u} v=${v}`);
    assert.ok(Math.abs(g.dlat - c[1]) < 1e-12, `dlat u=${u} v=${v}`);
  }
});

ok('normLonNearCenter wraps to the world copy nearest centre (Fiji-safe)', () => {
  assert.strictEqual(T.normLonNearCenter(181, -179), -179);
  assert.strictEqual(T.normLonNearCenter(-185, 170), 175);
  assert.strictEqual(T.normLonNearCenter(177, 177), 177);
  assert.strictEqual(T.normLonNearCenter(-179, 177), 181);
});

ok('affineFromProbes recovers an exact affine from three projections', () => {
  // synthesize a view: known affine mercator->px (rotation + scale + offset)
  const A = [70000, -12000, 400, 9000, 65000, 300];
  const proj = (lng, lat) => {
    const mx = T.mercX(lng), my = T.mercY(lat);
    return { x: A[0] * mx + A[1] * my + A[2], y: A[3] * mx + A[4] * my + A[5] };
  };
  const c = { lng: 177.4, lat: -17.6 };
  const aff = T.affineFromProbes(c.lng, c.lat, 0.01, 0.01,
    proj(c.lng, c.lat), proj(c.lng + 0.01, c.lat), proj(c.lng, c.lat + 0.01));
  // project a fourth, far point through the recovered affine — must match
  const p = proj(178.9, -18.4);
  const mx = T.mercX(178.9), my = T.mercY(-18.4);
  assert.ok(Math.abs(aff[0] * mx + aff[1] * my + aff[2] - p.x) < 1e-6, 'x');
  assert.ok(Math.abs(aff[3] * mx + aff[4] * my + aff[5] - p.y) < 1e-6, 'y');
});

ok('packField encodes NaN as the NODATA sentinel and keeps finite values', () => {
  const f = { nx: 2, ny: 1, u: [5.5, NaN], v: [NaN, -3.25] };
  const out = T.packField(f);
  assert.strictEqual(out[0], 5.5);
  assert.strictEqual(out[1], Math.fround(T.NODATA_SENTINEL));   // Float32Array rounds the sentinel
  assert.strictEqual(out[2], Math.fround(T.NODATA_SENTINEL));
  assert.strictEqual(out[3], -3.25);
  assert.ok(Math.abs(out[1]) > 1e29, 'sentinel still trips the shader NODATA test');
});

// ---- facade fallback discipline --------------------------------------------

function stubCpuEngine(calls) {
  function HelmWind() {
    const eng = {
      setData: (j) => { calls.push(['setData', j]); return true; },
      setVisible: (v) => calls.push(['setVisible', v]),
      isVisible: () => true,
      setNeutral: (v) => calls.push(['setNeutral', v]),
      setOpacity: (a) => calls.push(['setOpacity', a]),
      destroy: () => calls.push(['destroy'])
    };
    calls.push(['construct']);
    return eng;
  }
  HelmWind.Field = function () {};
  return HelmWind;
}

ok('no WebGPU -> immediate visible CPU fallback, calls delegated in order', () => {
  const calls = [];
  const w = loadModule({ HelmWind: stubCpuEngine(calls) });
  const auto = w.HelmWindAuto({ /* map unused by cpu stub */ });
  assert.strictEqual(auto.mode(), 'cpu');
  assert.strictEqual(w.__helmWindMode, 'cpu');
  assert.ok(/navigator\.gpu/.test(w.__helmWindModeReason), 'reason names the cause');
  auto.setNeutral(true);
  auto.setData([1, 2]);
  auto.setVisible(true);
  assert.deepStrictEqual(calls.map(c => c[0]),
    ['construct', 'setNeutral', 'setData', 'setVisible']);
});

ok('HELM_WX_WEBGPU=false forces CPU even when navigator.gpu exists', () => {
  const calls = [];
  const w = loadModule({
    HelmWind: stubCpuEngine(calls),
    HELM_WX_WEBGPU: false,
    navigator: { gpu: { requestAdapter: () => { throw new Error('must not be called'); } } }
  });
  const auto = w.HelmWindAuto({});
  assert.strictEqual(auto.mode(), 'cpu');
  assert.ok(/HELM_WX_WEBGPU/.test(w.__helmWindModeReason));
});

ok('async GPU-init failure replays buffered calls into the CPU engine', async () => {
  const calls = [];
  const w = loadModule({
    HelmWind: stubCpuEngine(calls),
    navigator: { gpu: { requestAdapter: () => Promise.resolve(null) } }   // adapter denied
  });
  const auto = w.HelmWindAuto({ getPitch: () => 0 });
  assert.strictEqual(auto.mode(), 'initializing');
  auto.setData([9]);            // buffered while initializing
  auto.setVisible(true);
  await new Promise(r => setTimeout(r, 10));
  assert.strictEqual(auto.mode(), 'cpu');
  assert.ok(/init failed|no WebGPU adapter/.test(w.__helmWindModeReason), w.__helmWindModeReason);
  assert.deepStrictEqual(calls.map(c => c[0]),
    ['construct', 'setData', 'setVisible']);
});

ok('pitched map refuses GPU path with a named reason (no silent wrong projection)', () => {
  const calls = [];
  const w = loadModule({
    HelmWind: stubCpuEngine(calls),
    navigator: { gpu: { requestAdapter: () => { throw new Error('must not be called'); } } }
  });
  const auto = w.HelmWindAuto({ getPitch: () => 30 });
  assert.strictEqual(auto.mode(), 'cpu');
  assert.ok(/pitch/.test(w.__helmWindModeReason));
});

setTimeout(() => {
  console.log((process.exitCode ? 'FAIL' : 'ok') + ' - wx-particles-advect: ' + pass + ' assertions groups passed');
}, 50);
