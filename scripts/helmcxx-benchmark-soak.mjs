#!/usr/bin/env node
// HELMC++-5: benchmark and soak the required C++ runtime daemons on private ports.
// The harness may use Node as test tooling; launched runtime services must stay C++.

import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { spawn, spawnSync, execFileSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OCPN_DIR = process.env.HELM_OCPN_DIR || path.join(os.homedir(), '.helm/build/helm-opencpn');
const BINS = {
  'helm-server': process.env.HELM_SERVER_BIN || path.join(OCPN_DIR, 'build/cli/helm-server'),
  'helm-packd': process.env.HELM_PACKD_BIN || path.join(OCPN_DIR, 'build/cli/helm-packd'),
  'helm-basemap-cache': process.env.HELM_BASEMAP_CACHE_BIN || path.join(OCPN_DIR, 'build/cli/helm-basemap-cache'),
  'helm-envd': process.env.HELM_ENVD_BIN || path.join(OCPN_DIR, 'build/cli/helm-envd')
};

const PORT_BASE = Number(process.env.HELM_HELMCXX5_PORT_BASE || process.env.HELM_HELMCXX_PORT_BASE || 9360);
const EVIDENCE_DIR = path.resolve(process.env.HELM_HELMCXX5_EVIDENCE_DIR || path.join(ROOT, 'test-results/helmcxx5-benchmark'));
const ITERATIONS = Number(process.env.HELM_HELMCXX5_ITERATIONS || 24);
const CONCURRENT_CLIENTS = Number(process.env.HELM_HELMCXX5_CLIENTS || 4);
const CONCURRENT_REQUESTS = Number(process.env.HELM_HELMCXX5_CONCURRENT_REQUESTS || 80);
const SOAK_SECONDS = Number(process.env.HELM_HELMCXX5_SOAK_SECONDS || 30);
const BASELINE_PATH = process.env.HELM_HELMCXX5_BASELINE || '';
const STRICT_BASELINE = process.env.HELM_HELMCXX5_STRICT_BASELINE === '1';
const LONG_SOAK_SECONDS = Number(process.env.HELM_HELMCXX5_LONG_SOAK_SECONDS || 43200);

const ports = {
  core: PORT_BASE,
  packd: PORT_BASE + 1,
  cache: PORT_BASE + 2,
  envd: PORT_BASE + 3,
  relay: PORT_BASE + 4
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'helmcxx5-'));
const dirs = {
  tmp,
  logs: path.join(tmp, 'logs'),
  packs: path.join(tmp, 'packs'),
  cache: path.join(tmp, 'cache'),
  config: path.join(tmp, 'config'),
  runtime: path.join(tmp, 'runtime'),
  env: path.join(tmp, 'env')
};
for (const dir of Object.values(dirs)) fs.mkdirSync(dir, { recursive: true });

const services = new Map();
const startedPids = [];
const result = {
  schema: 'helm.helmcxx5.benchmark_soak.v1',
  generatedAt: new Date().toISOString(),
  task: 'HELMC++-5',
  runtime: {
    portBase: PORT_BASE,
    ports,
    binaries: BINS,
    requiredServices: ['helm-server', 'helm-packd', 'helm-basemap-cache', 'helm-envd']
  },
  config: {
    iterations: ITERATIONS,
    concurrentClients: CONCURRENT_CLIENTS,
    concurrentRequests: CONCURRENT_REQUESTS,
    soakSeconds: SOAK_SECONDS,
    longSoakSeconds: LONG_SOAK_SECONDS,
    baseline: BASELINE_PATH || null,
    strictBaseline: STRICT_BASELINE
  },
  coldStart: {},
  firstVisible: {},
  endpoints: {},
  cache: {},
  concurrency: {},
  soak: {},
  restart: {},
  resources: {},
  dependencyFootprint: {},
  correctness: [],
  comparison: {},
  pass: false
};

function fail(message) {
  throw new Error(message);
}

function note(message) {
  console.log(`  ok   ${message}`);
}

function requireExecutable(label, file) {
  try {
    fs.accessSync(file, fs.constants.X_OK);
  } catch {
    fail(`${label} binary missing or not executable: ${file}`);
  }
}

function commandOk(cmd) {
  return spawnSync(cmd, ['--version'], { stdio: 'ignore' }).status === 0
    || spawnSync('which', [cmd], { stdio: 'ignore' }).status === 0;
}

function portBusy(port) {
  if (port === 8080) fail('refusing to use locked live port :8080');
  const found = spawnSync('lsof', ['-tiTCP:' + port, '-sTCP:LISTEN'], { encoding: 'utf8' });
  return found.status === 0 && found.stdout.trim().length > 0;
}

function findSampleEnc() {
  if (process.env.HELM_ENC) return process.env.HELM_ENC;
  const root = path.join(os.homedir(), '.helm/runtime/enc');
  const matches = [];
  function walk(dir) {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith('.000')) matches.push(full);
    }
  }
  walk(root);
  matches.sort();
  return matches[0] || '';
}

function copyFile(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

function jsonFromStdout(command, args) {
  const out = execFileSync(command, args, { cwd: ROOT, encoding: 'utf8' });
  return JSON.parse(out);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitHealth(name, url, proc) {
  const start = performance.now();
  let lastError = '';
  for (let i = 0; i < 120; i += 1) {
    if (proc.exitCode !== null) fail(`${name} exited before health became ready`);
    try {
      const response = await fetch(url, { cache: 'no-store' });
      if (response.ok) {
        const ms = performance.now() - start;
        result.coldStart[name] = Number(ms.toFixed(1));
        return await response.json().catch(() => ({}));
      }
      lastError = `HTTP ${response.status}`;
    } catch (err) {
      lastError = err.message;
    }
    await delay(100);
  }
  fail(`${name} did not become healthy at ${url}${lastError ? ` (${lastError})` : ''}`);
}

function startService(name, command, args, env) {
  const logPath = path.join(dirs.logs, `${name}.log`);
  const out = fs.openSync(logPath, 'a');
  const err = fs.openSync(logPath, 'a');
  const proc = spawn(command, args, {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: ['ignore', out, err],
    detached: false
  });
  services.set(name, proc);
  startedPids.push(proc.pid);
  return proc;
}

function stopService(name) {
  const proc = services.get(name);
  if (!proc) return;
  services.delete(name);
  if (proc.exitCode !== null) return;
  try {
    proc.kill('SIGTERM');
  } catch {
    return;
  }
}

async function stopAll() {
  for (const name of Array.from(services.keys()).reverse()) stopService(name);
  await delay(250);
  for (const proc of services.values()) {
    if (proc.exitCode === null) {
      try {
        proc.kill('SIGKILL');
      } catch {}
    }
  }
}

function descendants(pid) {
  const children = spawnSync('pgrep', ['-P', String(pid)], { encoding: 'utf8' });
  if (children.status !== 0) return [];
  const ids = children.stdout.trim().split(/\s+/).filter(Boolean).map(Number);
  return ids.flatMap((id) => [id, ...descendants(id)]);
}

function processCommand(pid) {
  const out = spawnSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' });
  return out.status === 0 ? out.stdout.trim() : '';
}

function assertNoPythonTree() {
  const offenders = [];
  for (const pid of startedPids) {
    for (const id of [pid, ...descendants(pid)]) {
      const command = processCommand(id);
      if (/(^|\/| )python[0-9.]*($| )|uvicorn|FastAPI/i.test(command)) offenders.push({ pid: id, command });
    }
  }
  if (offenders.length) fail(`required runtime process tree includes Python/FastAPI/uvicorn: ${JSON.stringify(offenders)}`);
  result.correctness.push('required runtime process trees contain no Python/FastAPI/uvicorn daemon');
}

async function httpProbe(name, url, options = {}) {
  const expected = options.expected || [200];
  const started = performance.now();
  const response = await fetch(url, { headers: options.headers || {}, cache: 'no-store' });
  const bytes = Buffer.from(await response.arrayBuffer());
  const ms = performance.now() - started;
  const headers = Object.fromEntries(response.headers.entries());
  if (!expected.includes(response.status)) {
    const err = new Error(`${name} returned HTTP ${response.status}, expected ${expected.join('/')} for ${url}`);
    err.probe = { name, status: response.status, url: scrubUrl(url), expected };
    throw err;
  }
  return {
    name,
    url,
    status: response.status,
    ms,
    bytes: bytes.length,
    headers,
    body: bytes
  };
}

function stats(values) {
  const sorted = values.slice().sort((a, b) => a - b);
  const pick = (p) => {
    if (!sorted.length) return null;
    const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
    return Number(sorted[idx].toFixed(2));
  };
  return {
    count: sorted.length,
    min_ms: pick(0),
    p50_ms: pick(50),
    p95_ms: pick(95),
    p99_ms: pick(99),
    max_ms: pick(100)
  };
}

async function benchmarkEndpoint(name, url, options = {}) {
  const samples = [];
  let bytes = 0;
  for (let i = 0; i < (options.iterations || ITERATIONS); i += 1) {
    const sample = await httpProbe(name, url, options);
    samples.push(sample.ms);
    bytes += sample.bytes;
  }
  result.endpoints[name] = {
    ...stats(samples),
    bytes,
    status: options.expected || [200],
    url: scrubUrl(url)
  };
}

function scrubUrl(url) {
  return url.replace(/127\.0\.0\.1:\d+/g, '127.0.0.1:<private>');
}

function chartUrlFromCatalog(catalog) {
  const cell = catalog.cells && catalog.cells[0];
  if (!cell || !Array.isArray(cell.bbox)) fail('helm-server catalog has no chart cell bbox');
  const [w, s, e, n] = cell.bbox.map(Number);
  const z = 11;
  const lat = (s + n) / 2;
  const lon = (w + e) / 2;
  const scale = 2 ** z;
  const x = Math.floor(((lon + 180) / 360) * scale);
  const latRad = lat * Math.PI / 180;
  const y = Math.floor(((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * scale);
  return `http://127.0.0.1:${ports.core}/chart/${z}/${x}/${y}.png`;
}

function sendRmc(lat, lon) {
  return new Promise((resolve) => {
    function nmeaCoord(value, width) {
      const abs = Math.abs(value);
      const deg = Math.floor(abs);
      const min = (abs - deg) * 60;
      return String(deg).padStart(width, '0') + min.toFixed(4).padStart(7, '0');
    }
    const body = [
      'GPRMC', '120000', 'A',
      nmeaCoord(lat, 2), lat >= 0 ? 'N' : 'S',
      nmeaCoord(lon, 3), lon >= 0 ? 'E' : 'W',
      '5.0', '015.0', '050726', '', ''
    ].join(',');
    let checksum = 0;
    for (const ch of body) checksum ^= ch.charCodeAt(0);
    const sentence = `$${body}*${checksum.toString(16).toUpperCase().padStart(2, '0')}\r\n`;
    const socket = net.createConnection({ host: '127.0.0.1', port: ports.relay }, () => socket.end(sentence));
    socket.setTimeout(1500);
    socket.on('timeout', () => {
      socket.destroy();
      resolve(false);
    });
    socket.on('error', () => resolve(false));
    socket.on('close', () => resolve(true));
  });
}

function processStats() {
  const rows = [];
  for (const [name, proc] of services.entries()) {
    if (!proc.pid || proc.exitCode !== null) continue;
    const out = spawnSync('ps', ['-o', 'rss=,%cpu=', '-p', String(proc.pid)], { encoding: 'utf8' });
    if (out.status !== 0) continue;
    const [rssKb, cpuPct] = out.stdout.trim().split(/\s+/).map(Number);
    rows.push({ name, pid: proc.pid, rss_kb: rssKb || 0, cpu_pct: cpuPct || 0 });
  }
  return rows;
}

function summarizeProcessSamples(samples) {
  const byName = {};
  for (const sample of samples) {
    for (const row of sample.processes) {
      const item = byName[row.name] || { rss: [], cpu: [] };
      item.rss.push(row.rss_kb);
      item.cpu.push(row.cpu_pct);
      byName[row.name] = item;
    }
  }
  const out = {};
  for (const [name, item] of Object.entries(byName)) {
    out[name] = {
      rss_kb: stats(item.rss).max_ms,
      rss_p95_kb: stats(item.rss).p95_ms,
      cpu_p95_pct: stats(item.cpu).p95_ms,
      cpu_max_pct: stats(item.cpu).max_ms
    };
  }
  return out;
}

function dirBytes(dir) {
  let total = 0;
  function walk(current) {
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) total += fs.statSync(full).size;
    }
  }
  walk(dir);
  return total;
}

async function concurrentLoad(endpoints) {
  const latencies = [];
  const failures = [];
  let next = 0;
  async function worker() {
    for (;;) {
      const idx = next;
      next += 1;
      if (idx >= CONCURRENT_REQUESTS) break;
      const endpoint = endpoints[idx % endpoints.length];
      try {
        const sample = await httpProbe(endpoint.name, endpoint.url, endpoint);
        latencies.push(sample.ms);
      } catch (err) {
        failures.push(err.probe || { name: endpoint.name, url: scrubUrl(endpoint.url), message: err.message });
      }
      await delay(25);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENT_CLIENTS }, () => worker()));
  result.concurrency = {
    clients: CONCURRENT_CLIENTS,
    requests: CONCURRENT_REQUESTS,
    errors: failures.length,
    failures: failures.slice(0, 12),
    ...stats(latencies)
  };
  if (failures.length) fail(`concurrent client load had ${failures.length} failed requests: ${JSON.stringify(failures.slice(0, 3))}`);
}

async function soak(endpoints) {
  const samples = [];
  const processSamples = [];
  const endAt = performance.now() + (SOAK_SECONDS * 1000);
  let requests = 0;
  const failures = [];
  let navFrames = 0;
  while (performance.now() < endAt) {
    processSamples.push({ at: new Date().toISOString(), processes: processStats() });
    await sendRmc(31.9 + (navFrames * 0.001), -81.1);
    navFrames += 1;
    for (const endpoint of endpoints) {
      try {
        const sample = await httpProbe(endpoint.name, endpoint.url, endpoint);
        samples.push(sample.ms);
        requests += 1;
      } catch (err) {
        failures.push(err.probe || { name: endpoint.name, url: scrubUrl(endpoint.url), message: err.message });
      }
    }
    await delay(1000);
  }
  result.soak = {
    mode: SOAK_SECONDS >= LONG_SOAK_SECONDS ? 'long' : 'short',
    seconds: SOAK_SECONDS,
    recommendedLongSoakSeconds: LONG_SOAK_SECONDS,
    requests,
    navFrames,
    errors: failures.length,
    failures: failures.slice(0, 12),
    ...stats(samples)
  };
  result.resources.processes = summarizeProcessSamples(processSamples);
  if (failures.length) fail(`soak had ${failures.length} failed requests: ${JSON.stringify(failures.slice(0, 3))}`);
}

async function startRequiredRuntime(envManifest) {
  const packd = startService('helm-packd', BINS['helm-packd'], [String(ports.packd)], {
    HELM_BIND: '127.0.0.1',
    HELM_MBTILES_DIR: dirs.packs,
    HELM_ENV_BUNDLE_MANIFESTS: path.join(ROOT, 'services/wx/fixtures/fiji-env-bundle-v1.json')
  });
  const packdHealth = await waitHealth('helm-packd', `http://127.0.0.1:${ports.packd}/health`, packd);
  if (packdHealth.engine !== 'helm-packd') fail('helm-packd health did not identify C++ service');

  const cache = startService('helm-basemap-cache', BINS['helm-basemap-cache'], [String(ports.cache)], {
    HELM_BIND: '127.0.0.1',
    HELM_FILL_CACHE: dirs.cache,
    HELM_FILL_TIMEOUT: '2',
    HELM_BASEMAP_UPSTREAM: `http://127.0.0.1:${ports.packd}`
  });
  const cacheHealth = await waitHealth('helm-basemap-cache', `http://127.0.0.1:${ports.cache}/health`, cache);
  if (cacheHealth.engine !== 'helm-basemap-cache') fail('helm-basemap-cache health did not identify C++ service');

  const envd = startService('helm-envd', BINS['helm-envd'], [String(ports.envd)], {
    HELM_BIND: '127.0.0.1',
    HELM_ENV_GRID_MANIFESTS: envManifest
  });
  const envdHealth = await waitHealth('helm-envd', `http://127.0.0.1:${ports.envd}/health`, envd);
  if (envdHealth.engine !== 'helm-envd' || envdHealth.status !== 'ok') fail('helm-envd health did not identify ready C++ service');

  await startCore();
  note('required C++ runtime services are ready');
}

async function startCore() {
  const core = startService('helm-server', BINS['helm-server'], [], {
    HELM_BIND: '127.0.0.1',
    HELM_PORT: String(ports.core),
    HELM_RELAY_PORT: String(ports.relay),
    HELM_WEB_ROOT: path.join(ROOT, 'web'),
    HELM_CONFIG: dirs.config,
    HELM_ENC: result.runtime.enc,
    HELM_SENC_DIR: path.join(dirs.runtime, 'senc'),
    HELM_TIDES_CACHE_DIR: path.join(dirs.runtime, 'tides'),
    HELM_TILES_NO_WARMUP: '1'
  });
  const health = await waitHealth('helm-server', `http://127.0.0.1:${ports.core}/health`, core);
  if (health.engine !== 'helm-server') fail('helm-server health did not identify C++ service');
  if (health.chart_loaded !== true) fail('helm-server did not load the ENC chart; set HELM_ENC to a usable .000 cell');
}

function writeArtifacts() {
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  fs.writeFileSync(path.join(EVIDENCE_DIR, 'benchmark.json'), JSON.stringify(result, null, 2) + '\n');
  const lines = [
    '# HELMC++-5 Benchmark And Soak',
    '',
    `Generated: ${result.generatedAt}`,
    `Ports: core=${ports.core} packd=${ports.packd} cache=${ports.cache} envd=${ports.envd} relay=${ports.relay}`,
    `Pass: ${result.pass}`,
    '',
    '## Cold Start',
    ...Object.entries(result.coldStart).map(([name, ms]) => `- ${name}: ${ms} ms`),
    '',
    '## First Visible Runtime Data',
    `- chart layer proxy: ${result.firstVisible.chartLayerMs} ms`,
    `- environmental layer proxy: ${result.firstVisible.environmentalLayerMs} ms`,
    '',
    '## Soak',
    `- mode: ${result.soak.mode}`,
    `- seconds: ${result.soak.seconds}`,
    `- requests: ${result.soak.requests}`,
    `- errors: ${result.soak.errors}`,
    '',
    '## Baseline',
    `- status: ${result.comparison.status}`
  ];
  fs.writeFileSync(path.join(EVIDENCE_DIR, 'benchmark.md'), lines.join('\n') + '\n');
}

function compareBaseline() {
  if (!BASELINE_PATH) {
    result.comparison = {
      status: 'baseline_missing',
      note: 'Set HELM_HELMCXX5_BASELINE=/path/to/benchmark.json to compare against Python/reference or last accepted runtime evidence.'
    };
    return;
  }
  const baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'));
  const checks = [];
  for (const [name, current] of Object.entries(result.endpoints)) {
    const previous = baseline.endpoints && baseline.endpoints[name];
    if (!previous || typeof previous.p95_ms !== 'number') continue;
    const ratio = current.p95_ms / previous.p95_ms;
    checks.push({
      metric: `${name}.p95_ms`,
      current: current.p95_ms,
      baseline: previous.p95_ms,
      ratio: Number(ratio.toFixed(3)),
      regression: ratio > 1.1
    });
  }
  const regressions = checks.filter((check) => check.regression);
  result.comparison = {
    status: regressions.length ? 'regression_detected' : 'compared',
    checks,
    regressions
  };
  if (STRICT_BASELINE && regressions.length) {
    fail(`strict baseline comparison found ${regressions.length} p95 regression(s)`);
  }
}

async function main() {
  console.log('HELMC++-5 benchmark and soak proof');
  console.log(`  ports: core=${ports.core} packd=${ports.packd} cache=${ports.cache} envd=${ports.envd} relay=${ports.relay}`);
  console.log(`  evidence: ${EVIDENCE_DIR}`);

  if (!commandOk('lsof')) fail('required test tool missing: lsof');
  for (const [label, file] of Object.entries(BINS)) requireExecutable(label, file);
  for (const port of Object.values(ports)) {
    if (portBusy(port)) fail(`private test port is busy: ${port} (set HELM_HELMCXX5_PORT_BASE)`);
  }

  const enc = findSampleEnc();
  if (!enc || !fs.existsSync(enc)) fail('set HELM_ENC to a real .000 ENC cell; chart visibility cannot be benchmarked otherwise');
  result.runtime.enc = enc;

  copyFile(path.join(ROOT, 'web/data/fiji-sat.pmtiles'), path.join(dirs.packs, 'fiji-sat.pmtiles'));
  copyFile(path.join(ROOT, 'web/data/key-west-sat.pmtiles'), path.join(dirs.packs, 'key-west-sat.pmtiles'));
  const fixture = jsonFromStdout(process.execPath, [
    path.join(ROOT, 'scripts/helmcxx-make-envd-fixture.mjs'),
    dirs.env,
    path.join(ROOT, 'services/wx/fixtures/helm-env-grid-v1.json')
  ]);
  result.runtime.envPackId = fixture.packId;
  result.runtime.envChunkKey = fixture.chunkKey;

  await startRequiredRuntime(fixture.manifest);
  assertNoPythonTree();
  note('required runtime process trees contain no Python/FastAPI/uvicorn daemon');

  const catalogSample = await httpProbe('helm-server.catalog', `http://127.0.0.1:${ports.core}/catalog`);
  const catalog = JSON.parse(catalogSample.body.toString('utf8'));
  const chartUrl = chartUrlFromCatalog(catalog);
  const chartStarted = performance.now();
  const chartSample = await httpProbe('helm-server.chart.visible', chartUrl);
  result.firstVisible.chartLayerMs = Number((performance.now() - chartStarted).toFixed(1));
  if (!/^image\/png\b/i.test(chartSample.headers['content-type'] || '')) fail('helm-server visible chart request did not return image/png');

  const envUrl = `http://127.0.0.1:${ports.envd}/chunk?pack=${encodeURIComponent(fixture.packId)}&chunk=${encodeURIComponent(fixture.chunkKey)}`;
  const envStarted = performance.now();
  const envSample = await httpProbe('helm-envd.chunk.visible', envUrl);
  result.firstVisible.environmentalLayerMs = Number((performance.now() - envStarted).toFixed(1));
  if (!envSample.body.subarray(0, 8).equals(Buffer.from('HELMGRID'))) fail('helm-envd visible chunk missing HELMGRID magic');
  note('chart and environmental runtime data are visible');

  const cacheFirst = await httpProbe('helm-basemap-cache.catalog.first', `http://127.0.0.1:${ports.cache}/catalog`);
  const cacheSecond = await httpProbe('helm-basemap-cache.catalog.second', `http://127.0.0.1:${ports.cache}/catalog`);
  result.cache.online = {
    first: cacheFirst.headers['x-helm-cache'],
    second: cacheSecond.headers['x-helm-cache']
  };
  if (result.cache.online.first !== 'miss-store' || result.cache.online.second !== 'hit') {
    fail(`unexpected cache headers: ${JSON.stringify(result.cache.online)}`);
  }

  const endpointPlan = [
    { name: 'helm-server.health', url: `http://127.0.0.1:${ports.core}/health` },
    { name: 'helm-server.catalog', url: `http://127.0.0.1:${ports.core}/catalog` },
    { name: 'helm-server.chart_tile', url: chartUrl },
    { name: 'helm-packd.catalog', url: `http://127.0.0.1:${ports.packd}/catalog` },
    { name: 'helm-packd.layers', url: `http://127.0.0.1:${ports.packd}/layers?bbox=178.0,-18.0,178.5,-17.5&minzoom=0&maxzoom=1&include_tiles=0` },
    { name: 'helm-packd.prefetch', url: `http://127.0.0.1:${ports.packd}/prefetch?bbox=178.0,-18.0,178.5,-17.5&minzoom=0&maxzoom=1&packs=fiji-sat&env_layers=wind` },
    { name: 'helm-packd.bundle', url: `http://127.0.0.1:${ports.packd}/bundle?bundle_id=helmcxx5&bbox=178.0,-18.0,178.5,-17.5&minzoom=0&maxzoom=1&include_tiles=0` },
    { name: 'helm-packd.range', url: `http://127.0.0.1:${ports.packd}/fiji-sat.pmtiles`, headers: { Range: 'bytes=0-1023' }, expected: [200, 206] },
    { name: 'helm-envd.packs', url: `http://127.0.0.1:${ports.envd}/packs` },
    { name: 'helm-envd.chunk', url: envUrl },
    { name: 'helm-basemap-cache.catalog', url: `http://127.0.0.1:${ports.cache}/catalog` }
  ];
  for (const endpoint of endpointPlan) await benchmarkEndpoint(endpoint.name, endpoint.url, endpoint);
  note('endpoint latency percentiles recorded');

  await concurrentLoad(endpointPlan);
  note('concurrent client load completed');

  await soak(endpointPlan.slice(1, 6));
  note(`soak completed for ${SOAK_SECONDS}s`);

  const beforeRestart = performance.now();
  stopService('helm-server');
  await delay(350);
  await startCore();
  result.restart.helmServerMs = Number((performance.now() - beforeRestart).toFixed(1));
  await httpProbe('helm-server.chart.after_restart', chartUrl);
  assertNoPythonTree();
  note('helm-server restart recovery completed');

  stopService('helm-packd');
  await delay(350);
  const offlineHit = await httpProbe('helm-basemap-cache.catalog.offline_hit', `http://127.0.0.1:${ports.cache}/catalog`);
  const hardMiss = await httpProbe(
    'helm-basemap-cache.hard_miss',
    `http://127.0.0.1:${ports.cache}/not-cached-after-upstream-stop.bin`,
    { expected: [204] }
  );
  result.cache.noNetwork = {
    cachedCatalogStatus: offlineHit.status,
    cachedCatalogHeader: offlineHit.headers['x-helm-cache'],
    hardMissStatus: hardMiss.status,
    hardMissHeader: hardMiss.headers['x-helm-cache']
  };
  if (result.cache.noNetwork.cachedCatalogHeader !== 'hit' || result.cache.noNetwork.hardMissHeader !== 'miss-transparent') {
    fail(`unexpected no-network cache headers: ${JSON.stringify(result.cache.noNetwork)}`);
  }
  note('no-network cache replay and hard-miss behavior verified');

  result.resources.diskBytes = {
    tempRuntime: dirBytes(dirs.runtime),
    config: dirBytes(dirs.config),
    cache: dirBytes(dirs.cache),
    packs: dirBytes(dirs.packs),
    envFixture: dirBytes(dirs.env)
  };
  result.dependencyFootprint = {
    runtimeDaemons: Object.keys(BINS),
    dockerRequired: false,
    pythonRuntimeDaemonRequired: false,
    testHarnessLanguages: ['JavaScript/Node'],
    fixtureGeneration: ['scripts/helmcxx-make-envd-fixture.mjs']
  };

  compareBaseline();
  result.pass = true;
  writeArtifacts();
  console.log(`HELMC++-5 benchmark and soak proof: PASS (${path.join(EVIDENCE_DIR, 'benchmark.json')})`);
}

process.on('SIGINT', async () => {
  await stopAll();
  process.exit(130);
});

main().catch(async (err) => {
  result.error = err.message;
  result.pass = false;
  try {
    writeArtifacts();
  } catch {}
  console.error(`helmcxx-benchmark-soak: ${err.message}`);
  await stopAll();
  process.exit(1);
}).finally(async () => {
  await stopAll();
  if (process.env.HELM_HELMCXX5_KEEP_TMP !== '1') fs.rmSync(tmp, { recursive: true, force: true });
});
