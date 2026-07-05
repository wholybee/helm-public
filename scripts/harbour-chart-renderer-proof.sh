#!/usr/bin/env bash
# Harbour INTEGRATE-1 + QA-1 Playwright proof against a live helm-server.
# Default target: live boat screen :8080 (does not start or stop helm-server).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${HELM_HARBOUR_PORT:-8080}"
EVIDENCE_DIR="${HELM_HARBOUR_EVIDENCE_DIR:-$ROOT/test-results/harbour-chart-renderer}"
HASH="${HELM_HARBOUR_HASH:-#12/24.5/-81.8}"

die() { echo "harbour-chart-renderer-proof: $*" >&2; exit 1; }
note() { printf '  ok   %s\n' "$*"; }

curl -sf --max-time 5 "http://127.0.0.1:$PORT/health" >/dev/null \
  || die "helm-server not healthy on :$PORT — start live server first"

note "server /health OK on :$PORT"
mkdir -p "$EVIDENCE_DIR"

export HELM_HARBOUR_E2E=1
export HELM_E2E_URL="http://127.0.0.1:$PORT"
export HELM_E2E_PORT="$PORT"
export HELM_HARBOUR_HASH="$HASH"
export HELM_HARBOUR_EVIDENCE_DIR="$EVIDENCE_DIR"
export HELM_E2E_BOOT_TIMEOUT="${HELM_E2E_BOOT_TIMEOUT:-60000}"

echo "[harbour] Playwright INTEGRATE-1 + QA-1 acceptance"
if [[ "${HELM_HARBOUR_HEADED:-}" == "1" ]]; then
  note "headed Chrome project enabled (HELM_HARBOUR_HEADED=1) for WebGPU adapter probe"
fi
(cd "$ROOT/web/test" && npx playwright test e2e/harbour-chart-renderer.spec.js \
  --config=playwright.harbour.config.js) | tee "$EVIDENCE_DIR/playwright.log"

note "harbour chart renderer proof complete → $EVIDENCE_DIR"
echo "  screenshots: $EVIDENCE_DIR/browser/"
echo "  manifest:    $EVIDENCE_DIR/manifest.json"
