// INTEGRATE-1 unit test: chart renderer status snapshot and feature-flag discipline.
// Run: node web/tests/chart-renderer-status.test.js
const fs = require('fs'), path = require('path'), vm = require('vm');
const assert = require('assert');

function loadStatus(extra) {
  const code = fs.readFileSync(path.join(__dirname, '..', 'chart-renderer-status.js'), 'utf8');
  const win = Object.assign({
    console,
    document: {
      getElementById: () => null
    },
    setInterval: () => 0
  }, extra || {});
  win.window = win;
  vm.runInContext(code, vm.createContext(win));
  return win;
}

let pass = 0;
function ok(name, fn) {
  try { fn(); pass++; console.log('  ok - ' + name); }
  catch (e) { console.error('  FAIL - ' + name + ': ' + e.message); process.exitCode = 1; }
}

ok('feature flag defaults OFF — PNG enc-chart stays default until opt-in', () => {
  const win = loadStatus({ localStorage: { getItem: () => null, setItem() {} } });
  assert.strictEqual(win.HelmChartRendererStatus.featureFlagState().enabled, false);
});

ok('feature flag honors explicit opt-in HELM_CHART_WEBGPU=true', () => {
  const win = loadStatus({ HELM_CHART_WEBGPU: true, localStorage: { getItem: () => null, setItem() {} } });
  assert.strictEqual(win.HelmChartRendererStatus.featureFlagState().enabled, true);
});

ok('feature flag honors explicit localStorage opt-in helmChartWebgpu=1', () => {
  const win = loadStatus({ localStorage: { getItem: () => '1', setItem() {} } });
  assert.strictEqual(win.HelmChartRendererStatus.featureFlagState().enabled, true);
});

ok('feature flag honors explicit opt-out HELM_CHART_WEBGPU=false', () => {
  const win = loadStatus({ HELM_CHART_WEBGPU: false, localStorage: { getItem: () => null, setItem() {} } });
  assert.strictEqual(win.HelmChartRendererStatus.featureFlagState().enabled, false);
});

ok('feature flag honors explicit localStorage opt-out helmChartWebgpu=0', () => {
  const win = loadStatus({ localStorage: { getItem: () => '0', setItem() {} } });
  assert.strictEqual(win.HelmChartRendererStatus.featureFlagState().enabled, false);
});

ok('snapshot reports maplibre fallback reason and artifact epoch', () => {
  const win = loadStatus({
    __helmChartMode: 'maplibre',
    __helmChartModeReason: 'WebGPU unavailable (no navigator.gpu)',
    __helmChartArtifact: {
      getArtifact: () => ({
        schema_version: 'helm.render.artifact.v1',
        artifact_id: 'chart-1-day-standard-z12.webgpu',
        source_epoch: 'synthetic-chart-1@2026-06-28',
        checksums: { packet_sha256: 'abc123' },
        cache: {
          chart_epoch: 'synthetic-chart-1@2026-06-28',
          invalidation_epoch: 'deadbeef'
        }
      })
    },
    localStorage: { getItem: () => null, setItem() {} }
  });
  const snap = win.HelmChartRendererStatus.snapshot();
  assert.strictEqual(snap.schema, 'helm.chart_renderer_status.v1');
  assert.strictEqual(snap.active_renderer, 'maplibre');
  assert.ok(snap.fallback_reason.indexOf('WebGPU unavailable') >= 0);
  assert.strictEqual(snap.artifact.schema_version, 'helm.render.artifact.v1');
  assert.strictEqual(snap.artifact.chart_epoch, 'synthetic-chart-1@2026-06-28');
  assert.strictEqual(snap.artifact.invalidation_epoch, 'deadbeef');
});

console.log('\n' + pass + ' passed');
