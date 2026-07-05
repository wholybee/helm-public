#!/usr/bin/env bash
#
# HELMC++-4: user-visible cockpit proof against the C++-only runtime.
#
# This is intentionally opt-in because the full proof needs local C++ binaries
# and a real ENC cell. It never binds or stops the live :8080 Helm screen.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OCPN_DIR="${HELM_OCPN_DIR:-$HOME/.helm/build/helm-opencpn}"
SERVER_BIN="${HELM_SERVER_BIN:-$OCPN_DIR/build/cli/helm-server}"
PACKD_BIN="${HELM_PACKD_BIN:-$OCPN_DIR/build/cli/helm-packd}"
CACHE_BIN="${HELM_BASEMAP_CACHE_BIN:-$OCPN_DIR/build/cli/helm-basemap-cache}"
ENVD_BIN="${HELM_ENVD_BIN:-$OCPN_DIR/build/cli/helm-envd}"
PORT_BASE="${HELM_HELMCXX_PORT_BASE:-9340}"
EVIDENCE_DIR="${HELM_HELMCXX4_EVIDENCE_DIR:-$ROOT/test-results/helmcxx4-cockpit}"

die() { echo "helmcxx-cockpit-proof: $*" >&2; exit 1; }
note() { printf '  ok   %s\n' "$*"; }

need_tool() { command -v "$1" >/dev/null 2>&1 || die "required test tool missing: $1"; }
need_exec() { local label="$1" path="$2"; [ -x "$path" ] || die "$label binary missing or not executable: $path"; }
port_busy() { lsof -tiTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1; }

wait_health() {
  local name="$1" url="$2" pid="$3"
  for _ in $(seq 1 100); do
    if ! kill -0 "$pid" 2>/dev/null; then die "$name exited before health became ready"; fi
    if curl -sf --max-time 1 "$url" >/dev/null 2>&1; then return 0; fi
    sleep 0.15
  done
  die "$name did not become healthy at $url"
}

stop_pid() {
  local pid="${1:-}"
  [ -n "$pid" ] || return 0
  kill "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
}

find_sample_enc() {
  if [ -n "${HELM_ENC:-}" ]; then printf '%s\n' "$HELM_ENC"; return; fi
  find "$HOME/.helm/runtime/enc" -name '*.000' -type f 2>/dev/null | sort | head -n 1
}

json_get() {
  node -e '
const fs = require("fs");
const doc = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
let cur = doc;
for (const part of process.argv[2].split(".")) cur = cur && cur[part];
if (typeof cur === "object") console.log(JSON.stringify(cur));
else console.log(cur === undefined ? "" : String(cur));
' "$1" "$2"
}

collect_descendants() {
  local parent="$1" child
  for child in $(pgrep -P "$parent" 2>/dev/null || true); do
    echo "$child"
    collect_descendants "$child"
  done
}

assert_no_python_tree() {
  local pid ids cmd
  for pid in "$@"; do
    [ -n "$pid" ] || continue
    ids="$pid $(collect_descendants "$pid" | tr '\n' ' ')"
    for id in $ids; do
      cmd="$(ps -p "$id" -o command= 2>/dev/null || true)"
      if printf '%s\n' "$cmd" | grep -Eiq '(^|/| )python[0-9.]*($| )|uvicorn|FastAPI'; then
        die "required runtime process tree includes a Python/FastAPI daemon: pid=$id command=$cmd"
      fi
    done
  done
}

send_rmc() {
  local lat="$1" lon="$2" port="$3"
  node - "$lat" "$lon" "$port" <<'NODE'
const net = require('node:net');
const lat = Number(process.argv[2]);
const lon = Number(process.argv[3]);
const port = Number(process.argv[4]);
function nmeaCoord(value, width) {
  const abs = Math.abs(value);
  const deg = Math.floor(abs);
  const min = (abs - deg) * 60;
  return String(deg).padStart(width, '0') + min.toFixed(4).padStart(7, '0');
}
const body = ['GPRMC', '120000', 'A', nmeaCoord(lat, 2), lat >= 0 ? 'N' : 'S', nmeaCoord(lon, 3), lon >= 0 ? 'E' : 'W', '5.0', '015.0', '050726', '', ''].join(',');
let checksum = 0;
for (const ch of body) checksum ^= ch.charCodeAt(0);
const sentence = `$${body}*${checksum.toString(16).toUpperCase().padStart(2, '0')}\r\n`;
const socket = net.createConnection({ host: '127.0.0.1', port }, () => socket.end(sentence));
socket.setTimeout(2000);
socket.on('timeout', () => process.exit(2));
socket.on('error', () => process.exit(1));
socket.on('close', () => process.exit(0));
NODE
}

make_wx_job() {
  local job="$1"
  node - "$job" "$ROOT" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const jobPath = process.argv[2];
const root = process.argv[3];
const times = ['2026-07-01T00:00:00Z', '2026-07-01T03:00:00Z'];
const chunks = [];
for (let lon = -180; lon < 180; lon += 90) {
  for (let lat = -90; lat < 90; lat += 90) chunks.push({ bbox: [lon, lat, lon + 90, lat + 90] });
}
const job = {
  schema: 'helm.wx.pack_factory.job.v1',
  generatedAt: '2026-07-01T00:10:00Z',
  maxSourceAgeHours: 24,
  modelRun: { provider: 'synthetic', model: 'fixture', runTime: times[0], validTimes: times, timeStepSeconds: 10800 },
  sources: [{
    id: 'fx',
    type: 'fixture',
    path: path.join(root, 'services/wx/fixtures/helm-env-grid-v1.json'),
    generatedAt: '2026-07-01T00:10:00Z',
    license: 'unit-test',
    provenance: 'HELMC++-4 cockpit proof fixture'
  }],
  packs: [{
    profile: 'global-low',
    tier: 'global-low',
    anchor: 'global',
    layers: ['wind', 'rain'],
    coverage: { crs: 'OGC:CRS84', global: true, bbox: [-180, -90, 180, 90], wrap: 'antimeridian' },
    chunks
  }]
};
fs.writeFileSync(jobPath, JSON.stringify(job, null, 2) + '\n');
NODE
}

chart_hash_from_catalog() {
  local catalog="$1"
  node - "$catalog" <<'NODE'
const fs = require('node:fs');
const catalog = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const cell = catalog.cells && catalog.cells[0];
if (!cell || !Array.isArray(cell.bbox)) process.exit(2);
const [w, s, e, n] = cell.bbox.map(Number);
const lat = (s + n) / 2;
const lon = (w + e) / 2;
process.stdout.write(`#11/${lat.toFixed(5)}/${lon.toFixed(5)}`);
NODE
}

need_tool curl
need_tool find
need_tool lsof
need_tool node
need_tool npm
need_tool python3
need_tool rsync
need_exec helm-server "$SERVER_BIN"
need_exec helm-packd "$PACKD_BIN"
need_exec helm-basemap-cache "$CACHE_BIN"
need_exec helm-envd "$ENVD_BIN"

ENC_PATH="$(find_sample_enc)"
[ -n "$ENC_PATH" ] || die "set HELM_ENC to a real .000 ENC cell; chart visibility cannot be proven with the transparent no-ENC fallback"
[ -f "$ENC_PATH" ] || die "HELM_ENC not found: $ENC_PATH"

CORE_PORT=$((PORT_BASE + 0))
PACKD_PORT=$((PORT_BASE + 1))
CACHE_PORT=$((PORT_BASE + 2))
ENVD_PORT=$((PORT_BASE + 3))
RELAY_PORT=$((PORT_BASE + 4))

for port in "$CORE_PORT" "$PACKD_PORT" "$CACHE_PORT" "$ENVD_PORT" "$RELAY_PORT"; do
  [ "$port" != "8080" ] || die "refusing to use locked live port :8080"
  port_busy "$port" && die "private test port is busy: $port (set HELM_HELMCXX_PORT_BASE)"
done

TMP="${TMPDIR:-/tmp}/helmcxx4.$$"
PIDS=()
PACKD_PID=""; CACHE_PID=""; ENVD_PID=""; CORE_PID=""
cleanup() {
  stop_pid "$CORE_PID"
  stop_pid "$ENVD_PID"
  stop_pid "$CACHE_PID"
  stop_pid "$PACKD_PID"
  rm -rf "$TMP"
}
trap cleanup EXIT INT TERM

mkdir -p "$TMP"/{packs,cache,config,logs,wx,web}
rm -rf "$EVIDENCE_DIR"
mkdir -p "$EVIDENCE_DIR"
rsync -a --exclude test/node_modules --exclude .client23-e2e --exclude .wx26-e2e "$ROOT/web/" "$TMP/web/"

cp "$ROOT/web/data/fiji-sat.pmtiles" "$TMP/packs/fiji-sat.pmtiles"
cp "$ROOT/web/data/key-west-sat.pmtiles" "$TMP/packs/key-west-sat.pmtiles"
make_wx_job "$TMP/wx/job.json"
python3 "$ROOT/scripts/wx_pack_factory.py" publish "$TMP/wx/job.json" --out "$TMP/web/.helmcxx4-e2e/wx" --replay-clock >"$TMP/logs/wx-pack-factory.log"
WX_MANIFEST="$(find "$TMP/web/.helmcxx4-e2e/wx" -name '*.pmtiles.manifest.json' -type f | sort | head -n 1)"
[ -n "$WX_MANIFEST" ] || die "WX pack factory did not produce a grid manifest"

echo "HELMC++-4 cockpit proof"
echo "  ports: core=$CORE_PORT packd=$PACKD_PORT cache=$CACHE_PORT envd=$ENVD_PORT relay=$RELAY_PORT"
echo "  ENC: $ENC_PATH"
echo "  evidence: $EVIDENCE_DIR"

HELM_BIND=127.0.0.1 HELM_MBTILES_DIR="$TMP/packs" HELM_ENV_BUNDLE_MANIFESTS="$ROOT/services/wx/fixtures/fiji-env-bundle-v1.json" \
  "$PACKD_BIN" "$PACKD_PORT" >"$TMP/logs/helm-packd.log" 2>&1 &
PACKD_PID=$!; PIDS+=("$PACKD_PID")
wait_health helm-packd "http://127.0.0.1:$PACKD_PORT/health" "$PACKD_PID"
note "helm-packd is ready"

HELM_BIND=127.0.0.1 HELM_FILL_CACHE="$TMP/cache" HELM_FILL_TIMEOUT=2 HELM_BASEMAP_UPSTREAM="http://127.0.0.1:$PACKD_PORT" \
  "$CACHE_BIN" "$CACHE_PORT" >"$TMP/logs/helm-basemap-cache.log" 2>&1 &
CACHE_PID=$!; PIDS+=("$CACHE_PID")
wait_health helm-basemap-cache "http://127.0.0.1:$CACHE_PORT/health" "$CACHE_PID"
note "helm-basemap-cache is ready"

HELM_BIND=127.0.0.1 HELM_ENV_GRID_MANIFESTS="$WX_MANIFEST" \
  "$ENVD_BIN" "$ENVD_PORT" >"$TMP/logs/helm-envd.log" 2>&1 &
ENVD_PID=$!; PIDS+=("$ENVD_PID")
wait_health helm-envd "http://127.0.0.1:$ENVD_PORT/health" "$ENVD_PID"
note "helm-envd is ready"

HELM_BIND=127.0.0.1 HELM_PORT="$CORE_PORT" HELM_RELAY_PORT="$RELAY_PORT" HELM_WEB_ROOT="$TMP/web" HELM_CONFIG="$TMP/config" \
HELM_ENC="$ENC_PATH" HELM_SENC_DIR="$TMP/senc" HELM_TIDES_CACHE_DIR="$TMP/tides" HELM_TILES_NO_WARMUP=1 \
  "$SERVER_BIN" >"$TMP/logs/helm-server.log" 2>&1 &
CORE_PID=$!; PIDS+=("$CORE_PID")
wait_health helm-server "http://127.0.0.1:$CORE_PORT/health" "$CORE_PID"
note "helm-server is ready"

curl -sf "http://127.0.0.1:$CORE_PORT/health" >"$EVIDENCE_DIR/helm-server-health.json"
curl -sf "http://127.0.0.1:$PACKD_PORT/health" >"$EVIDENCE_DIR/helm-packd-health.json"
curl -sf "http://127.0.0.1:$CACHE_PORT/health" >"$EVIDENCE_DIR/helm-basemap-cache-health.json"
curl -sf "http://127.0.0.1:$ENVD_PORT/health" >"$EVIDENCE_DIR/helm-envd-health.json"
curl -sf "http://127.0.0.1:$CORE_PORT/catalog" >"$EVIDENCE_DIR/catalog.json"

[ "$(json_get "$EVIDENCE_DIR/helm-server-health.json" engine)" = "helm-server" ] || die "helm-server health did not identify C++ engine"
[ "$(json_get "$EVIDENCE_DIR/helm-server-health.json" chart_loaded)" = "true" ] || die "helm-server did not load the ENC chart; cannot prove visible chart tiles"
CHART_HASH="${HELM_HELMCXX4_HASH:-$(chart_hash_from_catalog "$EVIDENCE_DIR/catalog.json")}"
note "chart catalog loaded; cockpit hash $CHART_HASH"

for _ in $(seq 1 12); do
  send_rmc 31.90 -81.10 "$RELAY_PORT" 2>/dev/null || true
  sleep 0.15
done

assert_no_python_tree "${PIDS[@]}"
note "required runtime process trees contain no Python/FastAPI/uvicorn daemon"

if [ ! -d "$ROOT/web/test/node_modules" ]; then npm --prefix "$ROOT/web/test" ci; fi

(
  cd "$ROOT/web/test"
  unset CI
  HELM_HELMCXX4=1 \
  HELM_E2E_URL="http://127.0.0.1:$CORE_PORT" \
  HELM_E2E_PORT="$CORE_PORT" \
  HELM_HELMCXX4_HASH="$CHART_HASH" \
  HELM_HELMCXX4_PACKD_URL="http://127.0.0.1:$PACKD_PORT" \
  HELM_HELMCXX4_CACHE_URL="http://127.0.0.1:$CACHE_PORT" \
  HELM_HELMCXX4_ENVD_URL="http://127.0.0.1:$ENVD_PORT" \
  HELM_HELMCXX4_EVIDENCE_DIR="$EVIDENCE_DIR" \
    npx playwright test e2e/helmcxx4-cockpit.spec.js
)

cp "$TMP/logs/"*.log "$EVIDENCE_DIR/"
echo "HELMC++-4 cockpit proof: PASS"
echo "evidence: $EVIDENCE_DIR"
