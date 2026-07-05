#!/usr/bin/env bash
# RENDERMODEL-3 harbour acceptance: real US5GA2BC artifact at the live ENC centre.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${HELM_HARBOUR_PORT:-8080}"
EVIDENCE_DIR="${HELM_RENDERMODEL3_EVIDENCE_DIR:-$ROOT/test-results/rendermodel-3-harbour}"

die() { echo "rendermodel-3-harbour-proof: $*" >&2; exit 1; }
note() { printf '  ok   %s\n' "$*"; }

curl -sf --max-time 5 "http://127.0.0.1:$PORT/health" >/dev/null \
  || die "helm-server not healthy on :$PORT"

CELL_ID="$(curl -sf "http://127.0.0.1:$PORT/catalog" | python3 -c "import sys,json; d=json.load(sys.stdin); print((d.get('cells') or [{}])[0].get('id',''))")"
[ "$CELL_ID" = "US5GA2BC" ] || die "catalog cell is '$CELL_ID', need US5GA2BC loaded on :$PORT"

note "catalog reports US5GA2BC on :$PORT"
mkdir -p "$EVIDENCE_DIR"

export HELM_HARBOUR_E2E=1
export HELM_E2E_URL="http://127.0.0.1:$PORT"
export HELM_E2E_PORT="$PORT"
export HELM_HARBOUR_EVIDENCE_DIR="$EVIDENCE_DIR"
export HELM_E2E_BOOT_TIMEOUT="${HELM_E2E_BOOT_TIMEOUT:-60000}"

echo "[rendermodel-3] harbour real-cell Playwright acceptance"
(cd "$ROOT/web/test" && npx playwright test e2e/harbour-chart-renderer.spec.js \
  --config=playwright.harbour.config.js \
  -g "RENDERMODEL-3") | tee "$EVIDENCE_DIR/playwright.log"

note "rendermodel-3 harbour proof complete → $EVIDENCE_DIR"
echo "  screenshots: $EVIDENCE_DIR/browser/"
echo "  manifest:    $EVIDENCE_DIR/manifest.json"
