#!/usr/bin/env bash
#
# HELMC++-3: launch the required C++ runtime services on private ports and prove
# the real HTTP/WebSocket contracts work without required Python daemons.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OCPN_DIR="${HELM_OCPN_DIR:-$HOME/.helm/build/helm-opencpn}"
SERVER_BIN="${HELM_SERVER_BIN:-$OCPN_DIR/build/cli/helm-server}"
PACKD_BIN="${HELM_PACKD_BIN:-$OCPN_DIR/build/cli/helm-packd}"
CACHE_BIN="${HELM_BASEMAP_CACHE_BIN:-$OCPN_DIR/build/cli/helm-basemap-cache}"
ENVD_BIN="${HELM_ENVD_BIN:-$OCPN_DIR/build/cli/helm-envd}"
PORT_BASE="${HELM_HELMCXX_PORT_BASE:-9320}"

die() { echo "helmcxx-no-python-runtime: $*" >&2; exit 1; }
note() { printf '  ok   %s\n' "$*"; }

need_exec() {
  local label="$1" path="$2"
  [ -x "$path" ] || die "$label binary missing or not executable: $path"
}

need_tool() {
  command -v "$1" >/dev/null 2>&1 || die "required test tool missing: $1"
}

port_busy() {
  lsof -tiTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1
}

json_get() {
  node -e '
const fs = require("fs");
const doc = JSON.parse(fs.readFileSync(0, "utf8"));
let cur = doc;
for (const part of process.argv[1].split(".")) cur = cur && cur[part];
if (typeof cur === "object") console.log(JSON.stringify(cur));
else console.log(cur === undefined ? "" : String(cur));
' "$1"
}

assert_json_field() {
  local file="$1" field="$2" expected="$3" actual
  actual="$(json_get "$field" <"$file")"
  [ "$actual" = "$expected" ] || die "$file: expected $field=$expected, got ${actual:-<empty>}"
}

assert_http() {
  local expected="$1" url="$2" out="$3"
  local code
  code="$(curl -sS -D "$out.headers" -o "$out" -w '%{http_code}' "$url")"
  [ "$code" = "$expected" ] || die "$url returned HTTP $code, expected $expected"
}

wait_health() {
  local name="$1" url="$2" pid="$3" out="$4"
  local last=""
  for _ in $(seq 1 80); do
    if ! kill -0 "$pid" 2>/dev/null; then
      die "$name exited before health became ready"
    fi
    if curl -sf -o "$out" "$url" 2>/dev/null; then
      return 0
    fi
    sleep 0.1
  done
  die "$name did not become healthy at $url ${last:+($last)}"
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
const body = [
  'GPRMC',
  '120000',
  'A',
  nmeaCoord(lat, 2),
  lat >= 0 ? 'N' : 'S',
  nmeaCoord(lon, 3),
  lon >= 0 ? 'E' : 'W',
  '5.0',
  '015.0',
  '050726',
  '',
  ''
].join(',');
let checksum = 0;
for (const ch of body) checksum ^= ch.charCodeAt(0);
const sentence = `$${body}*${checksum.toString(16).toUpperCase().padStart(2, '0')}\r\n`;
const socket = net.createConnection({ host: '127.0.0.1', port }, () => {
  socket.end(sentence);
});
socket.setTimeout(2000);
socket.on('timeout', () => process.exit(2));
socket.on('error', () => process.exit(1));
socket.on('close', () => process.exit(0));
NODE
}

stop_pid() {
  local pid="${1:-}"
  [ -n "$pid" ] || return 0
  kill "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
}

need_tool node
need_tool curl
need_tool lsof
need_exec helm-server "$SERVER_BIN"
need_exec helm-packd "$PACKD_BIN"
need_exec helm-basemap-cache "$CACHE_BIN"
need_exec helm-envd "$ENVD_BIN"

CORE_PORT=$((PORT_BASE + 0))
PACKD_PORT=$((PORT_BASE + 1))
CACHE_PORT=$((PORT_BASE + 2))
ENVD_PORT=$((PORT_BASE + 3))
BAD_ENVD_PORT=$((PORT_BASE + 4))
RELAY_PORT=$((PORT_BASE + 5))

for port in "$CORE_PORT" "$PACKD_PORT" "$CACHE_PORT" "$ENVD_PORT" "$BAD_ENVD_PORT" "$RELAY_PORT"; do
  [ "$port" != "8080" ] || die "refusing to use locked live port :8080"
  port_busy "$port" && die "private test port is busy: $port (set HELM_HELMCXX_PORT_BASE)"
done

TMP="${TMPDIR:-/tmp}/helmcxx3.$$"
mkdir -p "$TMP"/{runtime,config,packs,cache,env,logs}
PIDS=()
PACKD_PID=""; CACHE_PID=""; ENVD_PID=""; BAD_ENVD_PID=""; CORE_PID=""

cleanup() {
  stop_pid "$CORE_PID"
  stop_pid "$BAD_ENVD_PID"
  stop_pid "$ENVD_PID"
  stop_pid "$CACHE_PID"
  stop_pid "$PACKD_PID"
  rm -rf "$TMP"
}
trap cleanup EXIT INT TERM

cp "$REPO_ROOT/web/data/fiji-sat.pmtiles" "$TMP/packs/fiji-sat.pmtiles"
fixture_json="$(node "$REPO_ROOT/scripts/helmcxx-make-envd-fixture.mjs" "$TMP/env" "$REPO_ROOT/services/wx/fixtures/helm-env-grid-v1.json")"
ENV_MANIFEST="$(printf '%s' "$fixture_json" | node -e 'const fs=require("fs"); console.log(JSON.parse(fs.readFileSync(0,"utf8")).manifest)')"
BAD_ENV_MANIFEST="$(printf '%s' "$fixture_json" | node -e 'const fs=require("fs"); console.log(JSON.parse(fs.readFileSync(0,"utf8")).badManifest)')"
ENV_PACK_ID="$(printf '%s' "$fixture_json" | node -e 'const fs=require("fs"); console.log(JSON.parse(fs.readFileSync(0,"utf8")).packId)')"
ENV_CHUNK_KEY="$(printf '%s' "$fixture_json" | node -e 'const fs=require("fs"); console.log(JSON.parse(fs.readFileSync(0,"utf8")).chunkKey)')"

echo "HELMC++-3 no-Python runtime harness"
echo "  ports: core=$CORE_PORT packd=$PACKD_PORT cache=$CACHE_PORT envd=$ENVD_PORT bad-envd=$BAD_ENVD_PORT relay=$RELAY_PORT"

HELM_BIND=127.0.0.1 \
HELM_MBTILES_DIR="$TMP/packs" \
HELM_ENV_BUNDLE_MANIFESTS="$REPO_ROOT/services/wx/fixtures/fiji-env-bundle-v1.json" \
  "$PACKD_BIN" "$PACKD_PORT" >"$TMP/logs/helm-packd.log" 2>&1 &
PACKD_PID=$!; PIDS+=("$PACKD_PID")
wait_health helm-packd "http://127.0.0.1:$PACKD_PORT/health" "$PACKD_PID" "$TMP/packd-health.json"
assert_json_field "$TMP/packd-health.json" engine helm-packd
note "helm-packd /health is C++ and ready"

HELM_BIND=127.0.0.1 \
HELM_FILL_CACHE="$TMP/cache" \
HELM_FILL_TIMEOUT=2 \
HELM_BASEMAP_UPSTREAM="http://127.0.0.1:$PACKD_PORT" \
  "$CACHE_BIN" "$CACHE_PORT" >"$TMP/logs/helm-basemap-cache.log" 2>&1 &
CACHE_PID=$!; PIDS+=("$CACHE_PID")
wait_health helm-basemap-cache "http://127.0.0.1:$CACHE_PORT/health" "$CACHE_PID" "$TMP/cache-health.json"
assert_json_field "$TMP/cache-health.json" engine helm-basemap-cache
note "helm-basemap-cache /health is C++ and ready"

HELM_BIND=127.0.0.1 HELM_ENV_GRID_MANIFESTS="$ENV_MANIFEST" \
  "$ENVD_BIN" "$ENVD_PORT" >"$TMP/logs/helm-envd.log" 2>&1 &
ENVD_PID=$!; PIDS+=("$ENVD_PID")
wait_health helm-envd "http://127.0.0.1:$ENVD_PORT/health" "$ENVD_PID" "$TMP/envd-health.json"
assert_json_field "$TMP/envd-health.json" engine helm-envd
assert_json_field "$TMP/envd-health.json" status ok
note "helm-envd /health is C++ and ready"

HELM_BIND=127.0.0.1 HELM_ENV_GRID_MANIFESTS="$BAD_ENV_MANIFEST" \
  "$ENVD_BIN" "$BAD_ENVD_PORT" >"$TMP/logs/helm-envd-bad.log" 2>&1 &
BAD_ENVD_PID=$!; PIDS+=("$BAD_ENVD_PID")
wait_health helm-envd-bad "http://127.0.0.1:$BAD_ENVD_PORT/health" "$BAD_ENVD_PID" "$TMP/bad-envd-health.json"
assert_json_field "$TMP/bad-envd-health.json" status error
note "helm-envd bad-manifest path reports explicit error"

start_core() {
  HELM_BIND=127.0.0.1 \
  HELM_PORT="$CORE_PORT" \
  HELM_RELAY_PORT="$RELAY_PORT" \
  HELM_WEB_ROOT="$REPO_ROOT/web" \
  HELM_CONFIG="$TMP/config" \
  HELM_SENC_DIR="$TMP/runtime/senc" \
  HELM_TIDES_CACHE_DIR="$TMP/runtime/tides" \
  HELM_ENC="$TMP/missing/NO_SUCH_CELL.000" \
  HELM_TILES_NO_WARMUP=1 \
    "$SERVER_BIN" >"$TMP/logs/helm-server.log" 2>&1 &
  CORE_PID=$!; PIDS+=("$CORE_PID")
  wait_health helm-server "http://127.0.0.1:$CORE_PORT/health" "$CORE_PID" "$TMP/server-health.json"
}

start_core
assert_json_field "$TMP/server-health.json" engine helm-server
assert_json_field "$TMP/server-health.json" chart_loaded false
assert_json_field "$TMP/server-health.json" chart_status unavailable
assert_json_field "$TMP/server-health.json" nav.fix_status offline
note "helm-server cold-starts from fresh runtime dir and reports no-fix/offline truth"

assert_no_python_tree "${PIDS[@]}"
note "required runtime process trees contain no Python/FastAPI/uvicorn daemon"

assert_http 200 "http://127.0.0.1:$CORE_PORT/catalog" "$TMP/server-catalog.json"
assert_json_field "$TMP/server-catalog.json" chart_loaded false
assert_http 200 "http://127.0.0.1:$CORE_PORT/chart/2/1/1.png" "$TMP/server-tile.png"
grep -qi '^Content-Type: image/png' "$TMP/server-tile.png.headers" || die "helm-server chart tile did not return image/png"
grep -qi '^X-Helm-Chart-Status: unavailable' "$TMP/server-tile.png.headers" || die "helm-server missing unavailable chart status header"
note "helm-server serves catalog and explicit transparent chart tile in missing-ENC mode"

for _ in $(seq 1 8); do
  send_rmc 24.500 -81.800 "$RELAY_PORT" 2>/dev/null || true
  sleep 0.2
done
node "$REPO_ROOT/engine/nav-capture.js" 127.0.0.1 "$CORE_PORT" 3 /nav >"$TMP/nav.jsonl"
grep -q '"t":"snapshot"' "$TMP/nav.jsonl" || die "nav WebSocket did not produce a snapshot"
note "helm-server /nav WebSocket produces usable snapshot frames"

assert_http 200 "http://127.0.0.1:$PACKD_PORT/catalog" "$TMP/packd-catalog.json"
grep -q 'fiji-sat' "$TMP/packd-catalog.json" || die "packd catalog did not expose local PMTiles pack"
assert_http 200 "http://127.0.0.1:$PACKD_PORT/layers?bbox=178.0,-18.0,178.5,-17.5&minzoom=0&maxzoom=1&include_tiles=0" "$TMP/packd-layers.json"
assert_json_field "$TMP/packd-layers.json" schema helm.maritime_layer_inventory.v1
assert_http 200 "http://127.0.0.1:$PACKD_PORT/prefetch?bbox=178.0,-18.0,178.5,-17.5&minzoom=0&maxzoom=1&packs=fiji-sat&env_layers=wind" "$TMP/packd-prefetch.json"
assert_json_field "$TMP/packd-prefetch.json" schema helm.prefetch.manifest.v1
assert_http 200 "http://127.0.0.1:$PACKD_PORT/bundle?bundle_id=helmcxx&bbox=178.0,-18.0,178.5,-17.5&minzoom=0&maxzoom=1&include_tiles=0" "$TMP/packd-bundle.json"
assert_json_field "$TMP/packd-bundle.json" schema helm.region_bundle.manifest.v1
assert_http 404 "http://127.0.0.1:$PACKD_PORT/missing-pack.pmtiles" "$TMP/packd-missing.out"
note "helm-packd serves catalog/layers/prefetch/bundle and fails missing packs loudly"

assert_http 200 "http://127.0.0.1:$ENVD_PORT/packs" "$TMP/envd-packs.json"
assert_json_field "$TMP/envd-packs.json" schema helm.envd.inventory.v1
assert_json_field "$TMP/envd-packs.json" status ok
assert_http 200 "http://127.0.0.1:$ENVD_PORT/chunk?pack=$ENV_PACK_ID&chunk=$ENV_CHUNK_KEY" "$TMP/envd-chunk.bin"
grep -aq '^HELMGRID' "$TMP/envd-chunk.bin" || die "envd chunk body missing HELMGRID magic"
assert_http 404 "http://127.0.0.1:$ENVD_PORT/chunk?pack=$ENV_PACK_ID&chunk=missing" "$TMP/envd-missing.json"
assert_json_field "$TMP/envd-missing.json" error missing_chunk
assert_http 409 "http://127.0.0.1:$BAD_ENVD_PORT/chunk?pack=$ENV_PACK_ID&chunk=$ENV_CHUNK_KEY" "$TMP/envd-bad.json"
assert_json_field "$TMP/envd-bad.json" error invalid_pack
note "helm-envd serves local chunks and exposes missing/bad-manifest failures"

assert_http 200 "http://127.0.0.1:$CACHE_PORT/catalog" "$TMP/cache-catalog-1.json"
grep -qi '^X-Helm-Cache: miss-store' "$TMP/cache-catalog-1.json.headers" || die "basemap cache did not store first proxy response"
assert_http 200 "http://127.0.0.1:$CACHE_PORT/catalog" "$TMP/cache-catalog-2.json"
grep -qi '^X-Helm-Cache: hit' "$TMP/cache-catalog-2.json.headers" || die "basemap cache did not hit cached proxy response"
stop_pid "$PACKD_PID"; PACKD_PID=""
assert_http 200 "http://127.0.0.1:$CACHE_PORT/catalog" "$TMP/cache-catalog-offline.json"
grep -qi '^X-Helm-Cache: hit' "$TMP/cache-catalog-offline.json.headers" || die "basemap cache did not serve cached response after upstream stopped"
assert_http 204 "http://127.0.0.1:$CACHE_PORT/not-cached-after-upstream-stop.bin" "$TMP/cache-hard-miss.out"
grep -qi '^X-Helm-Cache: miss-transparent' "$TMP/cache-hard-miss.out.headers" || die "basemap cache hard miss did not remain transparent"
note "helm-basemap-cache serves cached data after no-network and returns transparent hard misses"

stop_pid "$CORE_PID"; CORE_PID=""
start_core
assert_json_field "$TMP/server-health.json" engine helm-server
assert_json_field "$TMP/server-health.json" nav.fix_status offline
assert_no_python_tree "${PIDS[@]}"
note "reboot-style restart reuses fresh runtime dir and remains no-Python"

echo "HELMC++-3 no-Python runtime harness: PASS"
