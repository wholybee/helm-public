#!/usr/bin/env bash
#
# LAUNCH-1 smoke: prove the public-alpha quickstart path on a private port.
#
# Full fresh-machine mode:
#   scripts/launch1-quickstart-smoke.sh
#
# Fast local mode with an already-built helm-server:
#   HELM_SERVER_BIN=/path/to/helm-server scripts/launch1-quickstart-smoke.sh --skip-bootstrap
#
# The smoke never binds :8080 and never uses the shared live screen.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SKIP_BOOTSTRAP=0
KEEP_TMP="${HELM_LAUNCH1_KEEP_TMP:-0}"

usage() {
  cat <<'EOF'
Usage: scripts/launch1-quickstart-smoke.sh [--skip-bootstrap] [--keep-tmp]

Proves the public-alpha quickstart:
  clone/checkout -> engine/bootstrap.sh -> scripts/install-sample-enc.sh ->
  scripts/start-helm.sh --port <private> -> /health + /catalog + UI load.

Options:
  --skip-bootstrap  Use HELM_SERVER_BIN or HELM_OCPN_DIR instead of running bootstrap.
  --keep-tmp        Preserve the isolated HOME and logs after the run.

Environment:
  HELM_LAUNCH1_PORT       Private port to use (default: auto-picked)
  HELM_SERVER_BIN         helm-server binary for --skip-bootstrap
  HELM_OCPN_DIR           OpenCPN/Helm build dir for --skip-bootstrap
  HELM_LAUNCH1_JOBS       bootstrap jobs for full mode (default: 2)
  HELM_LAUNCH1_TIMEOUT_S  server readiness timeout (default: 20)
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --skip-bootstrap) SKIP_BOOTSTRAP=1 ;;
    --keep-tmp) KEEP_TMP=1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "launch1-quickstart-smoke: unknown arg '$1'" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

die() {
  echo "launch1-quickstart-smoke: $*" >&2
  exit 1
}

need_tool() {
  command -v "$1" >/dev/null 2>&1 || die "missing required tool: $1"
}

free_port() {
  python3 - <<'PY'
import socket
s = socket.socket()
s.bind(("127.0.0.1", 0))
print(s.getsockname()[1])
s.close()
PY
}

port_busy() {
  lsof -tiTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1
}

wait_http() {
  local url="$1" out="$2" timeout_s="$3"
  local deadline=$((SECONDS + timeout_s))
  while [ "$SECONDS" -lt "$deadline" ]; do
    if curl -sf --max-time 2 "$url" >"$out" 2>/dev/null; then
      return 0
    fi
    sleep 0.25
  done
  return 1
}

cleanup() {
  if [ -n "${SERVER_PID:-}" ]; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  if [ "$KEEP_TMP" = 1 ]; then
    echo "launch1-quickstart-smoke: keeping $TMP"
  else
    rm -rf "$TMP"
  fi
}

need_tool curl
need_tool lsof
need_tool node
need_tool python3
need_tool unzip

TMP="${HELM_LAUNCH1_TMP:-$(mktemp -d "${TMPDIR:-/tmp}/helm-launch1.XXXXXX")}"
trap cleanup EXIT INT TERM

FRESH_HOME="$TMP/home"
LOG_DIR="$TMP/logs"
mkdir -p "$FRESH_HOME" "$LOG_DIR"

export HOME="$FRESH_HOME"
export HELM_RUNTIME_DIR="$HOME/.helm/runtime"
export HELM_ENC_ROOT="$HELM_RUNTIME_DIR/enc"
export HELM_BUILD_TMP="$HOME/.helm/build/tmp"

PORT="${HELM_LAUNCH1_PORT:-$(free_port)}"
[ "$PORT" != "8080" ] || die "refusing to use locked/shared port :8080"
port_busy "$PORT" && die "private quickstart port is busy: $PORT"

echo "LAUNCH-1 quickstart smoke"
echo "  repo: $REPO"
echo "  home: $HOME"
echo "  port: $PORT"
echo "  mode: $([ "$SKIP_BOOTSTRAP" = 1 ] && echo skip-bootstrap || echo full-bootstrap)"

echo "launch1: installing sample ENC into isolated runtime"
ENC_PATH="$("$REPO/scripts/install-sample-enc.sh" | tail -n 1)"
[ -f "$ENC_PATH" ] || die "sample ENC was not installed: $ENC_PATH"
export HELM_ENC="$ENC_PATH"

if [ "$SKIP_BOOTSTRAP" = 1 ]; then
  OCPN_DIR="${HELM_OCPN_DIR:-$HOME/.helm/build/helm-opencpn}"
  SERVER_BIN="${HELM_SERVER_BIN:-$OCPN_DIR/build/cli/helm-server}"
  [ -x "$SERVER_BIN" ] || die "--skip-bootstrap needs HELM_SERVER_BIN or HELM_OCPN_DIR with build/cli/helm-server"

  S57_SRC="${HELM_S57_DATA:-}"
  if [ -z "$S57_SRC" ] && [ -n "${HELM_OCPN_DIR:-}" ] && [ -d "$HELM_OCPN_DIR/data/s57data" ]; then
    S57_SRC="$HELM_OCPN_DIR/data/s57data"
  fi
  if [ -z "$S57_SRC" ]; then
    for candidate in "$HOME/.helm/runtime/s57data" "$REPO/engine/vendor/s57data"; do
      [ -d "$candidate" ] && S57_SRC="$candidate" && break
    done
  fi
  [ -n "$S57_SRC" ] && [ -d "$S57_SRC" ] || die "--skip-bootstrap needs HELM_S57_DATA or a build dir containing data/s57data"
  mkdir -p "$HELM_RUNTIME_DIR"
  rm -rf "$HELM_RUNTIME_DIR/s57data"
  cp -R "$S57_SRC" "$HELM_RUNTIME_DIR/s57data"
else
  OCPN_DIR="$HOME/.helm/build/helm-opencpn"
  export HELM_BOOTSTRAP_SMOKE_PORT="${HELM_BOOTSTRAP_SMOKE_PORT:-$(free_port)}"
  echo "launch1: running engine/bootstrap.sh --smoke (this is the slow fresh-machine step)"
  "$REPO/engine/bootstrap.sh" --dir "$OCPN_DIR" --jobs "${HELM_LAUNCH1_JOBS:-2}" --clean --smoke \
    >"$LOG_DIR/bootstrap.log" 2>&1 || {
      sed 's/^/    /' "$LOG_DIR/bootstrap.log" >&2
      die "bootstrap failed"
    }
  SERVER_BIN="$OCPN_DIR/build/cli/helm-server"
fi

[ -x "$SERVER_BIN" ] || die "helm-server is missing after setup: $SERVER_BIN"
[ -d "$HELM_RUNTIME_DIR/s57data" ] || die "durable S-52 presentation library missing at $HELM_RUNTIME_DIR/s57data"

echo "launch1: starting helm-server like scripts/start-helm.sh does"
DYLD_PATHS=""
if [ "$(uname)" = "Darwin" ]; then
  for libdir in /opt/homebrew/opt/wxwidgets@3.2/lib /opt/homebrew/opt/libarchive/lib; do
    [ -d "$libdir" ] && DYLD_PATHS="${DYLD_PATHS:+$DYLD_PATHS:}$libdir"
  done
  export DYLD_LIBRARY_PATH="$DYLD_PATHS${DYLD_LIBRARY_PATH:+:$DYLD_LIBRARY_PATH}"
fi

HELM_BIND=127.0.0.1 \
HELM_PORT="$PORT" \
HELM_WEB_ROOT="$REPO/web" \
HELM_CONFIG="$HOME/.helm/config" \
HELM_TILES_NO_WARMUP=1 \
  "$SERVER_BIN" >"$LOG_DIR/helm-server.log" 2>&1 &
SERVER_PID=$!

wait_http "http://127.0.0.1:$PORT/health" "$LOG_DIR/health.json" "${HELM_LAUNCH1_TIMEOUT_S:-20}" || {
  sed 's/^/    /' "$LOG_DIR/helm-server.log" >&2
  die "helm-server did not become ready on private port $PORT"
}
curl -sf "http://127.0.0.1:$PORT/catalog" >"$LOG_DIR/catalog.json"
curl -sf "http://127.0.0.1:$PORT/" >"$LOG_DIR/index.html"

node - "$LOG_DIR/health.json" "$LOG_DIR/catalog.json" "$LOG_DIR/index.html" <<'NODE'
const fs = require('node:fs');
const [healthPath, catalogPath, htmlPath] = process.argv.slice(2);
const health = JSON.parse(fs.readFileSync(healthPath, 'utf8'));
const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
const html = fs.readFileSync(htmlPath, 'utf8');
function assert(condition, message) {
  if (!condition) {
    console.error(`launch1-quickstart-smoke: ${message}`);
    process.exit(1);
  }
}
assert(health.engine === 'helm-server', '/health did not report helm-server');
assert(Object.prototype.hasOwnProperty.call(health, 'chart_loaded'), '/health missing chart_loaded');
assert(Array.isArray(catalog.cells) || Array.isArray(catalog.charts) || Object.prototype.hasOwnProperty.call(catalog, 'chart_status'), '/catalog missing chart inventory fields');
assert(/<html/i.test(html) || /<!doctype html/i.test(html), 'root URL did not return HTML UI');
NODE

echo "launch1: /health, /catalog, and UI root loaded from http://127.0.0.1:$PORT/"
echo "LAUNCH-1 quickstart smoke: PASS"
