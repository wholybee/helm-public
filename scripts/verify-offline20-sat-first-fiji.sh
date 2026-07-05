#!/usr/bin/env bash
# OFFLINE-20 satellite-first Fiji overlay acceptance runner.
#
# Starts private C++ Helm services and runs the opt-in Playwright proof. It
# never binds or stops the live :8080 boat screen.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

CORE_PORT="${HELM_OFFLINE20_CORE_PORT:-9140}"
PACKD_PORT="${HELM_OFFLINE20_PACKD_PORT:-9141}"
ENVD_PORT="${HELM_OFFLINE20_ENVD_PORT:-9144}"
EVIDENCE_DIR="${HELM_OFFLINE20_EVIDENCE_DIR:-$ROOT/test-results/offline20-sat-first-fiji}"

HELM_OCPN_DIR="${HELM_OCPN_DIR:-$HOME/.helm/build/helm-opencpn}"
HELM_SERVER_BIN="${HELM_SERVER_BIN:-$HELM_OCPN_DIR/build/cli/helm-server}"
HELM_PACKD_BIN="${HELM_PACKD_BIN:-$HELM_OCPN_DIR/build/cli/helm-packd}"
HELM_ENVD_BIN="${HELM_ENVD_BIN:-$HELM_OCPN_DIR/build/cli/helm-envd}"
HELM_WEB_ROOT="${HELM_WEB_ROOT:-$ROOT/web}"
HELM_CONFIG="${HELM_CONFIG:-$(mktemp -d /tmp/helm-offline20-config.XXXXXX)}"
HELM_SAMPLE_ENC="${HELM_SAMPLE_ENC:-$HOME/.helm/runtime/enc/US5FL4CR/US5FL4CR.000}"

PIDS=()
TMP=""

die() { echo "verify-offline20-sat-first-fiji: $*" >&2; exit 1; }

cleanup() {
  trap - INT TERM EXIT
  for pid in "${PIDS[@]:-}"; do kill "$pid" 2>/dev/null || true; done
  wait 2>/dev/null || true
  [ -z "$TMP" ] || rm -rf "$TMP"
}
trap cleanup INT TERM EXIT

wait_health() {
  local url="$1" label="$2"
  for _ in $(seq 1 100); do
    if curl -sf --max-time 1 "$url" >/dev/null; then return 0; fi
    sleep 0.2
  done
  die "$label did not become healthy at $url"
}

port_free() {
  local port="$1"
  [ "$port" != "8080" ] || die "refusing to use locked live port :8080"
  ! lsof -tiTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1
}

need_exec() {
  local label="$1" path="$2"
  [ -x "$path" ] || die "$label missing/not executable: $path"
}

need_exec helm-server "$HELM_SERVER_BIN"
need_exec helm-packd "$HELM_PACKD_BIN"
need_exec helm-envd "$HELM_ENVD_BIN"

for port in "$CORE_PORT" "$PACKD_PORT" "$ENVD_PORT"; do
  port_free "$port" || die "private port $port is already in use"
done

TMP="$(mktemp -d /tmp/helm-offline20.XXXXXX)"
mkdir -p "$TMP/packs" "$TMP/wx" "$TMP/logs" "$EVIDENCE_DIR" "$HELM_CONFIG"

if [ -n "${HELM_MBTILES_DIR:-}" ]; then
  PACK_DIR="$HELM_MBTILES_DIR"
else
  cp "$ROOT/web/data/fiji-sat.pmtiles" "$TMP/packs/fiji-sat.pmtiles"
  PACK_DIR="$TMP/packs"
fi
[ -d "$PACK_DIR" ] || die "pack directory is not a directory: $PACK_DIR"

cat >"$TMP/wx/manifest-in.json" <<'JSON'
{
  "schema": "helm.env.grid.pack.v1",
  "encoding": "helm.env.grid.v1",
  "packId": "offline20/fiji/sat-first/wind",
  "productFamily": "met-ocean",
  "generatedAt": "2026-07-01T00:15:00Z",
  "source": {
    "provider": "fixture",
    "model": "offline20-fiji-proof",
    "provenance": "OFFLINE-20 generated numeric grid fixture",
    "advisory": true,
    "notForNavigation": true
  },
  "run": {
    "runTime": "2026-07-01T00:00:00Z",
    "validTimes": ["2026-07-01T00:00:00Z", "2026-07-01T03:00:00Z"]
  },
  "transport": {},
  "coverage": { "crs": "OGC:CRS84", "global": true, "bbox": [-180, -90, 180, 90] },
  "tiers": {
    "global-low": {
      "role": "overview",
      "crs": "OGC:CRS84",
      "grid": { "dx": 0.5, "dy": 0.5, "width": 720, "height": 361 },
      "chunking": { "lonSpan": 60.0, "latSpan": 60.0 },
      "clientZoomRange": [0, 5]
    }
  },
  "layers": {
    "wind": {
      "kind": "vector",
      "bands": {
        "u": { "type": "int16", "scale": 0.01, "offset": 0, "nodata": -32768, "unit": "m/s" },
        "v": { "type": "int16", "scale": 0.01, "offset": 0, "nodata": -32768, "unit": "m/s" }
      }
    }
  },
  "chunks": {}
}
JSON

node - "$TMP/wx/manifest-in.json" <<'NODE'
const fs = require('node:fs');
const file = process.argv[2];
const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
const chunks = {};
for (const vt of doc.run.validTimes) {
  const id = vt.replace(/[-:]/g, '');
  for (let lon = -180; lon < 180; lon += 60) {
    for (let lat = -90; lat < 90; lat += 60) {
      chunks[`global-low/wind/${id}/${lon}_${lat}`] = {
        schema: 'helm.env.grid.chunk.v1',
        tier: 'global-low',
        layer: 'wind',
        validTime: vt,
        bbox: [lon, lat, lon + 60, lat + 60]
      };
    }
  }
}
doc.chunks = chunks;
fs.writeFileSync(file, JSON.stringify(doc, null, 2) + '\n');
NODE

mkdir -p "$HELM_WEB_ROOT/test-results/offline20-e2e/wx"
python3 "$ROOT/scripts/env_grid_pack.py" pack "$TMP/wx/manifest-in.json" \
  "$HELM_WEB_ROOT/test-results/offline20-e2e/wx/offline20-wx.pmtiles" \
  --manifest-out "$HELM_WEB_ROOT/test-results/offline20-e2e/wx/manifest.json" \
  >"$TMP/logs/env-grid-pack.log"

WX_MANIFEST="$HELM_WEB_ROOT/test-results/offline20-e2e/wx/manifest.json"
[ -f "$WX_MANIFEST" ] || die "WX manifest was not generated"

echo "verify-offline20-sat-first-fiji: ports core=$CORE_PORT packd=$PACKD_PORT envd=$ENVD_PORT"
echo "verify-offline20-sat-first-fiji: evidence in $EVIDENCE_DIR"

env HELM_BIND=127.0.0.1 HELM_MBTILES_DIR="$PACK_DIR" \
  "$HELM_PACKD_BIN" "$PACKD_PORT" >"$EVIDENCE_DIR/helm-packd.log" 2>&1 &
PIDS+=("$!")
wait_health "http://127.0.0.1:$PACKD_PORT/health" "helm-packd"

env HELM_BIND=127.0.0.1 HELM_ENV_GRID_MANIFESTS="$WX_MANIFEST" \
  "$HELM_ENVD_BIN" "$ENVD_PORT" >"$EVIDENCE_DIR/helm-envd.log" 2>&1 &
PIDS+=("$!")
wait_health "http://127.0.0.1:$ENVD_PORT/health" "helm-envd"

if [ -z "${HELM_ENC:-}" ] && [ -f "$HELM_SAMPLE_ENC" ]; then
  HELM_ENC="$HELM_SAMPLE_ENC"
fi

env HELM_PORT="$CORE_PORT" HELM_WEB_ROOT="$HELM_WEB_ROOT" HELM_CONFIG="$HELM_CONFIG" \
  HELM_ENC="${HELM_ENC:-}" HELM_TILES_NO_WARMUP="${HELM_TILES_NO_WARMUP:-1}" \
  "$HELM_SERVER_BIN" >"$EVIDENCE_DIR/helm-server.log" 2>&1 &
PIDS+=("$!")
wait_health "http://127.0.0.1:$CORE_PORT/health" "helm-server"

curl -sf "http://127.0.0.1:$CORE_PORT/health" >"$EVIDENCE_DIR/helm-server-health.json"
curl -sf "http://127.0.0.1:$PACKD_PORT/health" >"$EVIDENCE_DIR/helm-packd-health.json"
curl -sf "http://127.0.0.1:$ENVD_PORT/health" >"$EVIDENCE_DIR/helm-envd-health.json"
curl -sf "http://127.0.0.1:$PACKD_PORT/catalog" >"$EVIDENCE_DIR/packd-catalog.json"
curl -sf "http://127.0.0.1:$ENVD_PORT/packs" >"$EVIDENCE_DIR/envd-packs.json"

if [ ! -d "$ROOT/web/test/node_modules" ]; then
  echo "verify-offline20-sat-first-fiji: installing web/test dependencies"
  npm --prefix "$ROOT/web/test" ci
fi

(
  cd "$ROOT/web/test"
  HELM_OFFLINE20=1 \
  HELM_E2E_URL="http://127.0.0.1:$CORE_PORT" \
  HELM_E2E_PORT="$CORE_PORT" \
  HELM_OFFLINE20_PACKD_URL="http://127.0.0.1:$PACKD_PORT" \
  HELM_OFFLINE20_CHUNK_ENDPOINT="http://127.0.0.1:$ENVD_PORT" \
  HELM_OFFLINE20_EVIDENCE_DIR="$EVIDENCE_DIR" \
    npx playwright test e2e/offline20-sat-first-fiji.spec.js \
      --config=playwright.harbour.config.js
) | tee "$EVIDENCE_DIR/playwright.log"

echo "verify-offline20-sat-first-fiji: evidence in $EVIDENCE_DIR"
