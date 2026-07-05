#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
EVIDENCE_DIR="${HELM_SCHED2_EVIDENCE_DIR:-$ROOT/test-results/sched-2-zoom-blend}"
export HELM_SCHED2=1
export HELM_SCHED2_EVIDENCE_DIR="$EVIDENCE_DIR"

echo "[sched-2] unit tests"
node web/tests/chart-viewport-scheduler.test.js
node web/tests/chart-artifact-cache.test.js
node web/tests/chart-artifact-webgpu.test.js

echo "[sched-2] playwright acceptance (requires serve.py on :8077 via playwright config)"
mkdir -p "$EVIDENCE_DIR"
(cd web/test && npx playwright test e2e/sched-2-zoom-blend.spec.js)

echo "[sched-2] evidence written to $EVIDENCE_DIR"
