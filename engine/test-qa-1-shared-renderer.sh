#!/usr/bin/env bash
# QA-1 native + semantic regression leg (CI-safe; no helm-server or browser required).
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
cd "$ROOT"

EVIDENCE_DIR="${HELM_QA1_EVIDENCE_DIR:-$ROOT/test-results/qa-1-shared-renderer}"
NATIVE_DIR="$EVIDENCE_DIR/native"
mkdir -p "$NATIVE_DIR"

FIXTURE="$ROOT/engine/test/fixtures/vulkan-render/chart-1"
SCHED_FIXTURE="$ROOT/engine/test/fixtures/viewport-scheduler/pan-no-blank"
MANIFEST_JSON="$FIXTURE/manifest.json"

echo "[qa-1] native fixture checks (chart-1 corpus)"
scripts/vulkan-render-fixture "$FIXTURE" --check | tee "$NATIVE_DIR/vulkan-render-fixture.log"
OFFSCREEN="$NATIVE_DIR/offscreen-chart-1-z12.png"
OFFSCREEN_SHA=$(scripts/vulkan-render-fixture "$FIXTURE" --tile-size 256 --format png --output "$OFFSCREEN" --print-hash)
EXPECTED_OFFSCREEN=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["expected_offscreen"][0]["sha256"])' "$MANIFEST_JSON")
[ "$OFFSCREEN_SHA" = "$EXPECTED_OFFSCREEN" ] || { echo "FAIL offscreen PNG sha mismatch: got $OFFSCREEN_SHA expected $EXPECTED_OFFSCREEN"; exit 1; }
echo "ok offscreen PNG sha256=$OFFSCREEN_SHA"

scripts/render-artifact-compile "$FIXTURE" --check --print-hashes | tee "$NATIVE_DIR/render-artifact-compile.log"
scripts/render-artifact-cache-smoke | tee "$NATIVE_DIR/render-artifact-cache-smoke.log"
scripts/inspection-trace-smoke | tee "$NATIVE_DIR/inspection-trace-smoke.log"
scripts/viewport-scheduler-fixture-check "$SCHED_FIXTURE" --print-hashes | tee "$NATIVE_DIR/viewport-scheduler-fixture.log"
scripts/viewport-scheduler-smoke | tee "$NATIVE_DIR/viewport-scheduler-smoke.log"

echo "[qa-1] browser-side unit tests (artifact, atlas, scheduler, inspect)"
node web/tests/chart-viewport-scheduler.test.js | tee "$NATIVE_DIR/chart-viewport-scheduler.test.log"
node web/tests/chart-artifact-cache.test.js | tee "$NATIVE_DIR/chart-artifact-cache.test.log"
node web/tests/chart-artifact-webgpu.test.js | tee "$NATIVE_DIR/chart-artifact-webgpu.test.log"
node web/tests/chart-pick-buffer.test.js | tee "$NATIVE_DIR/chart-pick-buffer.test.log"
node web/test/chart-artifact-webgpu.test.cjs | tee "$NATIVE_DIR/chart-artifact-webgpu.test.cjs.log"
node web/test/chart-artifact-atlas.test.cjs | tee "$NATIVE_DIR/chart-artifact-atlas.test.cjs.log"
python3 -m unittest pipeline.test_viewport_scheduler -v | tee "$NATIVE_DIR/pipeline-viewport-scheduler.test.log"

python3 - "$EVIDENCE_DIR" "$OFFSCREEN_SHA" <<'PY'
import json, os, subprocess, sys
from datetime import datetime, timezone

evidence_dir = sys.argv[1]
offscreen_sha = sys.argv[2]
manifest_path = os.path.join(evidence_dir, "manifest.json")
fixture_manifest = json.load(open("engine/test/fixtures/vulkan-render/chart-1/manifest.json"))
head = subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip()
branch = subprocess.check_output(["git", "rev-parse", "--abbrev-ref", "HEAD"], text=True).strip()
payload = {
    "schema": "helm.qa1.shared_renderer.v1",
    "task_id": "QA-1",
    "generated_at": datetime.now(timezone.utc).isoformat(),
    "git": {"branch": branch, "head_sha": head},
    "fixture_id": "chart-1",
    "correlation": {
        "expected_hashes": fixture_manifest.get("expected_hashes", {}),
        "offscreen_png_sha256": offscreen_sha,
        "browser_artifact_mirror": "web/data/render-artifact-chart-1.json",
        "integrate_1_note": "Cross-backend live correlation completes when helm-server serves live artifact packets; browser status surface lands in INTEGRATE-1."
    },
    "legs": {
        "native": "pass",
        "server_png": "pending_or_skipped",
        "browser": "pending_or_skipped"
    }
}
json.dump(payload, open(manifest_path, "w"), indent=2)
print(f"ok wrote {manifest_path}")
PY

echo "[qa-1] native leg complete → $EVIDENCE_DIR"
