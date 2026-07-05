#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
EVIDENCE_DIR="${HELM_QA1_EVIDENCE_DIR:-$ROOT/test-results/qa-1-shared-renderer}"
export HELM_QA1_EVIDENCE_DIR="$EVIDENCE_DIR"
mkdir -p "$EVIDENCE_DIR"

echo "[qa-1] Phase A — native + semantic regression"
bash engine/test-qa-1-shared-renderer.sh

echo "[qa-1] Phase B — server PNG fallback + vulkan adapter (skip if helm-server absent)"
bash engine/test-qa-1-server-png.sh

if [ "${HELM_QA1_BROWSER:-1}" != "0" ]; then
  echo "[qa-1] Phase C — browser interaction proof (Playwright)"
  export HELM_QA1=1
  export HELM_QA1_EVIDENCE_DIR="$EVIDENCE_DIR"
  (cd web/test && npx playwright test e2e/qa-1-shared-renderer.spec.js)
else
  echo "[qa-1] Phase C skipped (HELM_QA1_BROWSER=0)"
fi

echo "[qa-1] evidence bundle → $EVIDENCE_DIR/manifest.json"
