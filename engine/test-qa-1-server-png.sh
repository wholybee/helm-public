#!/usr/bin/env bash
# QA-1 server PNG leg: legacy S-52 tile + vulkan adapter route (optional; needs helm-server).
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
cd "$ROOT"

EVIDENCE_DIR="${HELM_QA1_EVIDENCE_DIR:-$ROOT/test-results/qa-1-shared-renderer}"
SERVER_DIR="$EVIDENCE_DIR/server"
mkdir -p "$SERVER_DIR"

mark_skip() {
  local reason="$1"
  echo "SKIP server PNG leg: $reason"
  python3 - "$EVIDENCE_DIR" "$reason" <<'PY'
import json, os, sys
p = os.path.join(sys.argv[1], "manifest.json")
reason = sys.argv[2]
if os.path.isfile(p):
    m = json.load(open(p))
else:
    m = {"legs": {}}
m.setdefault("legs", {})
m["legs"]["server_png"] = f"skipped_{reason}"
json.dump(m, open(p, "w"), indent=2)
PY
  exit 0
}

find_sample_enc() {
  if [ -n "${HELM_ENC:-}" ]; then printf '%s\n' "$HELM_ENC"; return; fi
  find "$HOME/.helm/runtime/enc" -name '*.000' -type f 2>/dev/null | sort | head -n 1
}

wait_health_or_skip() {
  local name="$1" url="$2" pid="$3"
  for _ in $(seq 1 60); do
    if ! kill -0 "$pid" 2>/dev/null; then
      if [ -f "$SERVER_DIR/helm-server.log" ]; then
        tail -5 "$SERVER_DIR/helm-server.log" >&2 || true
      fi
      mark_skip "helm_server_exited"
    fi
    if curl -sf --max-time 1 "$url" >/dev/null 2>&1; then return 0; fi
    sleep 0.2
  done
  mark_skip "helm_server_not_healthy"
}

pick_free_port() {
  python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1]); s.close()'
}
SPORT="${HELM_QA1_PORT:-$(pick_free_port)}"
RPORT="${HELM_QA1_RELAY_PORT:-$(pick_free_port)}"

BIN="${HELM_OCPN_DIR:-/tmp/helm-opencpn}/build/cli"
if [ ! -x "$BIN/helm-server" ]; then
  mark_skip "no_helm_server"
fi

ENC_PATH="$(find_sample_enc || true)"
if [ -z "$ENC_PATH" ] || [ ! -f "$ENC_PATH" ]; then
  mark_skip "no_enc_cell"
fi

ST="$(mktemp -d)"
cleanup() { kill "$SPID" 2>/dev/null || true; wait "$SPID" 2>/dev/null || true; rm -rf "$ST"; }
trap cleanup EXIT

HELM_BIND=127.0.0.1 HELM_PORT=$SPORT HELM_RELAY_PORT=$RPORT HELM_TILES_NO_WARMUP=1 \
  HELM_WEB_ROOT="$ROOT/web" HELM_CONFIG="$ST" HELM_ENC="$ENC_PATH" \
  HELM_CHART_RENDERER_QUERY_OVERRIDE=1 \
  HELM_VULKAN_RENDERER_BIN="$ROOT/scripts/vulkan-render-fixture" \
  HELM_VULKAN_FIXTURE_DIR="$ROOT/engine/test/fixtures/vulkan-render/chart-1" \
  HELM_VULKAN_RENDERER_SHA="${HELM_VULKAN_RENDERER_SHA:-local-fixture}" \
  "$BIN/helm-server" >"$SERVER_DIR/helm-server.log" 2>&1 &
SPID=$!
wait_health_or_skip helm-server "http://127.0.0.1:$SPORT/health" "$SPID"

legacy_url="http://127.0.0.1:$SPORT/chart/12/1117/1760.png"
curl -s -D "$SERVER_DIR/legacy-headers.txt" -o "$SERVER_DIR/legacy-tile.png" "$legacy_url"
vurl="${legacy_url}?renderer=vulkan"
curl -s -D "$SERVER_DIR/vulkan-headers.txt" -o "$SERVER_DIR/vulkan-tile.png" "$vurl"

python3 - "$SERVER_DIR" <<'PY'
import hashlib, json, os, re, sys

def parse_headers(path):
    out = {}
    for line in open(path, encoding="utf-8", errors="replace"):
        if ":" not in line or line.startswith("HTTP/"):
            continue
        k, v = line.split(":", 1)
        out[k.strip().lower()] = v.strip()
    return out

server_dir = sys.argv[1]
legacy_h = parse_headers(os.path.join(server_dir, "legacy-headers.txt"))
vulkan_h = parse_headers(os.path.join(server_dir, "vulkan-headers.txt"))
legacy_sha = hashlib.sha256(open(os.path.join(server_dir, "legacy-tile.png"), "rb").read()).hexdigest()
vulkan_sha = hashlib.sha256(open(os.path.join(server_dir, "vulkan-tile.png"), "rb").read()).hexdigest()
assert int(legacy_h.get("content-length") or os.path.getsize(os.path.join(server_dir, "legacy-tile.png"))) > 50
assert vulkan_h.get("x-helm-renderer") == "vulkan"
assert vulkan_h.get("x-helm-renderer-output-sha") == vulkan_sha
json.dump({
    "legacy": {"sha256": legacy_sha, "content_type": legacy_h.get("content-type"), "etag": legacy_h.get("etag")},
    "vulkan": {
        "sha256": vulkan_sha,
        "renderer": vulkan_h.get("x-helm-renderer"),
        "cache_key": vulkan_h.get("x-helm-renderer-cache-key"),
        "output_sha": vulkan_h.get("x-helm-renderer-output-sha"),
        "etag": vulkan_h.get("etag")
    }
}, open(os.path.join(server_dir, "headers.json"), "w"), indent=2)
print("ok server PNG leg: legacy + vulkan adapter headers captured")
PY

python3 - "$EVIDENCE_DIR" "$SERVER_DIR/headers.json" <<'PY'
import json, os, sys
manifest_path = os.path.join(sys.argv[1], "manifest.json")
server_summary = json.load(open(sys.argv[2]))
manifest = json.load(open(manifest_path))
manifest["legs"]["server_png"] = "pass"
manifest["server"] = server_summary
json.dump(manifest, open(manifest_path, "w"), indent=2)
PY

echo "[qa-1] server PNG leg complete → $SERVER_DIR"
