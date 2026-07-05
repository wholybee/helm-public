#!/usr/bin/env bash
#
# FALLBACK-1: prove the current Vulkan + legacy PNG fallback routes against ONE fixture.
#
# This is the *safety fallback and regression bridge* for the chart render path. It is NOT
# the WebGPU browser path (that is WEBGPU-1/2 + INTEGRATE-1). Here we prove that the engine's
# HTTP chart route can:
#   - select a renderer (legacy S-52 vs Vulkan adapter),
#   - emit renderer/cache/ETag headers,
#   - fall back from Vulkan to legacy EXPLICITLY (never silently), and
#   - render a byte-for-byte deterministic PNG for the committed fixture.
#
# Two legs:
#   Leg A  (always runs; headless, no GPU, no server): the deterministic fixture PNG matches the
#          committed golden, the fixture corpus is intact, and cache-key/epoch invalidation holds.
#          This is the regression bridge that CI can run everywhere.
#   Leg B  (best-effort; needs a bootable helm-server + S-52 runtime + ENC cell): the live chart
#          route proves renderer selection, headers, ETag/304 revalidation, EXPLICIT fallback, and
#          that fallback is NOT silent. When no server is available the leg records an explicit
#          skip reason (set HELM_FALLBACK1_REQUIRE_SERVER=1 to turn that skip into a failure).
#
# Usage:
#   scripts/fallback-1-proof.sh
#   HELM_SERVER_BIN=/path/to/helm-server scripts/fallback-1-proof.sh
#   HELM_FALLBACK1_REQUIRE_SERVER=1 scripts/fallback-1-proof.sh   # CI with a real server
#
# Environment:
#   HELM_SERVER_BIN                 helm-server binary (default: search common build/runtime paths)
#   HELM_S57_DATA                   S-52 presentation library dir (default: ~/.helm/runtime/s57data)
#   HELM_ENC                        ENC .000 cell (default: first cell under ~/.helm/runtime/enc)
#   HELM_FALLBACK1_REQUIRE_SERVER   =1 makes a skipped Leg B a hard failure
#   HELM_FALLBACK1_EVIDENCE_DIR     evidence output dir (default: test-results/fallback-1)
#
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
cd "$ROOT"

FIXTURE="$ROOT/engine/test/fixtures/vulkan-render/chart-1"
MANIFEST_JSON="$FIXTURE/manifest.json"
EVIDENCE_DIR="${HELM_FALLBACK1_EVIDENCE_DIR:-$ROOT/test-results/fallback-1}"
NATIVE_DIR="$EVIDENCE_DIR/native"
SERVER_DIR="$EVIDENCE_DIR/server"
mkdir -p "$NATIVE_DIR" "$SERVER_DIR"

REQUIRE_SERVER="${HELM_FALLBACK1_REQUIRE_SERVER:-0}"

# Evidence state, folded into a single manifest at the end.
SERVER_LEG_STATUS="pending"
LEGACY_SHA=""
VULKAN_SHA=""
OFFSCREEN_SHA=""

log() { echo "[fallback-1] $*"; }
fail() { echo "FAIL fallback-1: $*" >&2; exit 1; }

# ---------------------------------------------------------------------------
# Leg A: deterministic fixture PNG + corpus integrity (headless, always runs)
# ---------------------------------------------------------------------------
leg_a() {
  log "Leg A: deterministic fixture render + corpus integrity (no GPU, no server)"

  # A1: the fixture corpus renders and matches its committed PPM golden.
  scripts/vulkan-render-fixture "$FIXTURE" --check | tee "$NATIVE_DIR/vulkan-render-fixture.log"

  # A2: the tile-sized PNG is byte-for-byte deterministic AND matches the committed golden sha256.
  local out_a="$NATIVE_DIR/offscreen-chart-1-z12-a.png"
  local out_b="$NATIVE_DIR/offscreen-chart-1-z12-b.png"
  local sha_a sha_b expected
  sha_a=$(scripts/vulkan-render-fixture "$FIXTURE" --tile-size 256 --format png --output "$out_a" --print-hash)
  sha_b=$(scripts/vulkan-render-fixture "$FIXTURE" --tile-size 256 --format png --output "$out_b" --print-hash)
  expected=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["expected_offscreen"][0]["sha256"])' "$MANIFEST_JSON")
  [ "$sha_a" = "$sha_b" ] || fail "offscreen PNG not deterministic: $sha_a != $sha_b"
  [ "$sha_a" = "$expected" ] || fail "offscreen PNG sha mismatch: got $sha_a expected golden $expected"
  OFFSCREEN_SHA="$sha_a"
  log "ok deterministic offscreen PNG sha256=$OFFSCREEN_SHA (== committed golden)"

  # A3: render-artifact + cache-key/epoch invalidation (renderer-SHA / cache-key contract material).
  scripts/render-artifact-compile "$FIXTURE" --check --print-hashes | tee "$NATIVE_DIR/render-artifact-compile.log"
  scripts/render-artifact-cache-smoke | tee "$NATIVE_DIR/render-artifact-cache-smoke.log"

  log "Leg A PASS"
}

# ---------------------------------------------------------------------------
# Leg B helpers
# ---------------------------------------------------------------------------
find_server_bin() {
  if [ -n "${HELM_SERVER_BIN:-}" ]; then printf '%s\n' "$HELM_SERVER_BIN"; return; fi
  local c
  for c in \
    "${HELM_OCPN_DIR:-}/build/cli/helm-server" \
    "$HOME/.helm/build/helm-opencpn/build/cli/helm-server" \
    "/tmp/helm-opencpn/build/cli/helm-server"; do
    [ -n "$c" ] && [ -x "$c" ] && { printf '%s\n' "$c"; return; }
  done
  return 0
}

find_s57_data() {
  if [ -n "${HELM_S57_DATA:-}" ] && [ -d "${HELM_S57_DATA}" ]; then printf '%s\n' "$HELM_S57_DATA"; return; fi
  [ -d "$HOME/.helm/runtime/s57data" ] && printf '%s\n' "$HOME/.helm/runtime/s57data"
}

find_enc() {
  if [ -n "${HELM_ENC:-}" ] && [ -f "${HELM_ENC}" ]; then printf '%s\n' "$HELM_ENC"; return; fi
  find "$HOME/.helm/runtime/enc" -name '*.000' -type f 2>/dev/null | sort | head -n 1
}

pick_free_port() {
  python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()'
}

# Start a helm-server with a chosen Vulkan renderer bin. Echoes "PORT PID". Caller must kill PID.
start_server() {
  local vulkan_bin="$1" logfile="$2"
  local port cfg
  port="$(pick_free_port)"
  cfg="$(mktemp -d)"
  local dyld=""
  if [ "$(uname)" = "Darwin" ]; then
    local d
    for d in /opt/homebrew/opt/wxwidgets@3.2/lib /opt/homebrew/opt/libarchive/lib; do
      [ -d "$d" ] && dyld="${dyld:+$dyld:}$d"
    done
  fi
  DYLD_LIBRARY_PATH="${dyld}${DYLD_LIBRARY_PATH:+:$DYLD_LIBRARY_PATH}" \
  HELM_BIND=127.0.0.1 HELM_PORT="$port" HELM_TILES_NO_WARMUP=1 \
    HELM_CONFIG="$cfg" HELM_WEB_ROOT="$ROOT/web" \
    HELM_S57_DATA="$S57_DATA" HELM_ENC="$ENC_PATH" \
    HELM_CHART_RENDERER_QUERY_OVERRIDE=1 \
    HELM_VULKAN_RENDERER_BIN="$vulkan_bin" \
    HELM_VULKAN_FIXTURE_DIR="$FIXTURE" \
    HELM_VULKAN_RENDERER_SHA="$RENDERER_SHA" \
    "$SERVER_BIN" >"$logfile" 2>&1 &
  local pid=$!
  local i
  for i in $(seq 1 60); do
    if ! kill -0 "$pid" 2>/dev/null; then echo "0 0"; return; fi
    if curl -sf --max-time 1 "http://127.0.0.1:$port/health" >/dev/null 2>&1; then
      printf '%s %s\n' "$port" "$pid"; return
    fi
    sleep 0.25
  done
  kill "$pid" 2>/dev/null || true
  echo "0 0"
}

skip_server_leg() {
  local reason="$1"
  SERVER_LEG_STATUS="skipped_${reason}"
  if [ "$REQUIRE_SERVER" = "1" ]; then
    fail "Leg B required (HELM_FALLBACK1_REQUIRE_SERVER=1) but skipped: $reason"
  fi
  log "Leg B SKIP (explicit, not silent): $reason"
}

# ---------------------------------------------------------------------------
# Leg B: live chart route — selection, headers, ETag/304, explicit + non-silent fallback
# ---------------------------------------------------------------------------
leg_b() {
  log "Leg B: live chart route contract (renderer selection + explicit fallback)"

  SERVER_BIN="$(find_server_bin || true)"
  [ -n "$SERVER_BIN" ] && [ -x "$SERVER_BIN" ] || { skip_server_leg "no_helm_server"; return; }
  S57_DATA="$(find_s57_data || true)"
  [ -n "$S57_DATA" ] || { skip_server_leg "no_s57_data"; return; }
  ENC_PATH="$(find_enc || true)"
  [ -n "$ENC_PATH" ] && [ -f "$ENC_PATH" ] || { skip_server_leg "no_enc_cell"; return; }
  RENDERER_SHA="${HELM_VULKAN_RENDERER_SHA:-fallback1-fixture}"

  log "Leg B server: $SERVER_BIN"
  log "Leg B s57data: $S57_DATA"
  log "Leg B enc: $ENC_PATH"

  local ok_bin="$ROOT/scripts/vulkan-render-fixture"
  local fail_bin="$SERVER_DIR/vulkan-fail.sh"
  cat >"$fail_bin" <<'FAILEOF'
#!/bin/sh
echo "fallback-1: forced Vulkan renderer failure" >&2
exit 7
FAILEOF
  chmod +x "$fail_bin"

  # --- Sub-legs B1..B3: healthy Vulkan adapter -------------------------------
  read -r HPORT HPID < <(start_server "$ok_bin" "$SERVER_DIR/helm-server-healthy.log")
  if [ "$HPORT" = "0" ]; then
    tail -8 "$SERVER_DIR/helm-server-healthy.log" >&2 || true
    skip_server_leg "helm_server_did_not_boot"
    return
  fi
  # shellcheck disable=SC2064
  trap "kill $HPID 2>/dev/null || true" RETURN

  local base="http://127.0.0.1:$HPORT/chart/12/1117/1760.png"
  curl -s -D "$SERVER_DIR/legacy-headers.txt"   -o "$SERVER_DIR/legacy-tile.png"   "$base"
  curl -s -D "$SERVER_DIR/vulkan-headers.txt"   -o "$SERVER_DIR/vulkan-tile.png"   "${base}?renderer=vulkan"
  curl -s -D "$SERVER_DIR/vulkan2-headers.txt"  -o "$SERVER_DIR/vulkan2-tile.png"  "${base}?renderer=vulkan"

  # Conditional revalidation (expect 304) using the Vulkan ETag.
  local vetag
  vetag="$(python3 - "$SERVER_DIR/vulkan-headers.txt" <<'PY'
import sys
for line in open(sys.argv[1], encoding="utf-8", errors="replace"):
    if ":" in line and not line.startswith("HTTP/"):
        k, v = line.split(":", 1)
        if k.strip().lower() == "etag":
            print(v.strip()); break
PY
)"
  local not_modified="000"
  if [ -n "$vetag" ]; then
    not_modified="$(curl -s -o /dev/null -w '%{http_code}' -H "If-None-Match: $vetag" "${base}?renderer=vulkan")"
  fi
  echo "$not_modified" > "$SERVER_DIR/vulkan-304.txt"

  kill "$HPID" 2>/dev/null || true; wait "$HPID" 2>/dev/null || true
  trap - RETURN

  # --- Sub-legs B4..B5: forced Vulkan failure (explicit + non-silent fallback)
  read -r FPORT FPID < <(start_server "$fail_bin" "$SERVER_DIR/helm-server-fail.log")
  if [ "$FPORT" = "0" ]; then
    tail -8 "$SERVER_DIR/helm-server-fail.log" >&2 || true
    skip_server_leg "helm_server_fail_variant_did_not_boot"
    return
  fi
  # shellcheck disable=SC2064
  trap "kill $FPID 2>/dev/null || true" RETURN

  local fbase="http://127.0.0.1:$FPORT/chart/12/1117/1760.png"
  # B4: explicit fallback requested -> legacy tile + visible fallback headers.
  curl -s -D "$SERVER_DIR/fallback-headers.txt" -o "$SERVER_DIR/fallback-tile.png" \
    "${fbase}?renderer=vulkan&fallback=legacy"
  # B5: NO fallback requested -> must NOT silently serve a tile; expect an error status.
  local nosilent
  nosilent="$(curl -s -o "$SERVER_DIR/nosilent-body.txt" -D "$SERVER_DIR/nosilent-headers.txt" \
    -w '%{http_code}' "${fbase}?renderer=vulkan")"
  echo "$nosilent" > "$SERVER_DIR/nosilent-status.txt"

  kill "$FPID" 2>/dev/null || true; wait "$FPID" 2>/dev/null || true
  trap - RETURN

  # --- Assertions (shared, selftested contract module) ------------------------
  python3 "$ROOT/scripts/fallback1-assert.py" "$SERVER_DIR" "$RENDERER_SHA"

  SERVER_LEG_STATUS="pass"
  LEGACY_SHA="$(python3 -c 'import hashlib,sys;print(hashlib.sha256(open(sys.argv[1],"rb").read()).hexdigest())' "$SERVER_DIR/legacy-tile.png")"
  VULKAN_SHA="$(python3 -c 'import hashlib,sys;print(hashlib.sha256(open(sys.argv[1],"rb").read()).hexdigest())' "$SERVER_DIR/vulkan-tile.png")"
  log "Leg B PASS"
}

# ---------------------------------------------------------------------------
emit_evidence() {
  python3 - "$EVIDENCE_DIR" "$MANIFEST_JSON" "$OFFSCREEN_SHA" "$SERVER_LEG_STATUS" "$LEGACY_SHA" "$VULKAN_SHA" <<'PY'
import json, os, subprocess, sys
from datetime import datetime, timezone

evidence_dir, fixture_manifest_path, offscreen_sha, server_status, legacy_sha, vulkan_sha = sys.argv[1:7]
fixture_manifest = json.load(open(fixture_manifest_path))

def git(*args):
    try:
        return subprocess.check_output(["git", *args], text=True).strip()
    except Exception:
        return "unknown"

payload = {
    "schema": "helm.fallback1.render_fallback.v1",
    "task_id": "FALLBACK-1",
    "generated_at": datetime.now(timezone.utc).isoformat(),
    "git": {"branch": git("rev-parse", "--abbrev-ref", "HEAD"), "head_sha": git("rev-parse", "HEAD")},
    "fixture_id": "chart-1",
    "legs": {
        "native_deterministic_png": "pass",
        "server_route_fallback": server_status,
    },
    "native": {
        "offscreen_png_sha256": offscreen_sha,
        "expected_offscreen_sha256": fixture_manifest["expected_offscreen"][0]["sha256"],
        "expected_hashes": fixture_manifest.get("expected_hashes", {}),
    },
    "server": {
        "legacy_tile_sha256": legacy_sha or None,
        "vulkan_tile_sha256": vulkan_sha or None,
        "detail": "test-results/fallback-1/server/summary.json" if server_status == "pass" else None,
    },
    "notes": (
        "Regression bridge for the chart render fallback. Native leg is CI-safe (no GPU/server). "
        "Server leg proves live renderer selection, headers, ETag/304, and EXPLICIT (non-silent) "
        "Vulkan->legacy fallback; it records an explicit skip reason where no bootable helm-server "
        "+ S-52 runtime + ENC cell is present."
    ),
}
out = os.path.join(evidence_dir, "manifest.json")
json.dump(payload, open(out, "w"), indent=2)
print(f"[fallback-1] evidence -> {out}")
PY
}

leg_a
leg_b
emit_evidence

log "COMPLETE (native=pass, server=$SERVER_LEG_STATUS) -> $EVIDENCE_DIR"
