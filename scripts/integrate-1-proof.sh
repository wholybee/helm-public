#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "[integrate-1] unit tests"
node web/tests/chart-renderer-status.test.js
node web/tests/chart-artifact-webgpu.test.js

if [ "${HELM_INTEGRATE1_BROWSER:-1}" != "0" ]; then
  echo "[integrate-1] playwright acceptance"
  export HELM_INTEGRATE1=1
  (cd web/test && npx playwright test e2e/integrate-1-chart-renderer.spec.js)
else
  echo "[integrate-1] browser leg skipped (HELM_INTEGRATE1_BROWSER=0)"
fi

echo "[integrate-1] proof complete"
