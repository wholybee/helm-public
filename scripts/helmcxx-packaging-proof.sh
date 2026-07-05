#!/usr/bin/env bash
#
# HELMC++-6: static and staged proof for no-Docker C++ runtime packaging.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EVIDENCE_DIR="${HELM_HELMCXX6_EVIDENCE_DIR:-$ROOT/test-results/helmcxx6-packaging}"
PORT_BASE="${HELM_HELMCXX6_PORT_BASE:-9440}"
RUN_SMOKE=0
KEEP_TMP="${HELM_HELMCXX6_KEEP_TMP:-0}"
TMP=""

usage() {
  cat <<'USAGE'
Usage: scripts/helmcxx-packaging-proof.sh [--run-smoke] [--keep-tmp]

Default mode is a cheap static/staged packaging proof:
  - service templates exist for launchd and systemd;
  - install destinations are deterministic;
  - service/install artifacts do not require Docker, Python daemons, or /tmp paths;
  - the installer can populate a staging root and write target-path env config.

With --run-smoke, after engine/bootstrap.sh has built real binaries, the script
also installs into a staging root, starts helm-server and helm-packd on private
ports, checks /health and local pack /catalog, then shuts them down cleanly.
USAGE
}

die() {
  printf 'helmcxx-packaging-proof: %s\n' "$*" >&2
  exit 1
}

ok() {
  printf '  ok   %s\n' "$*"
}

need_tool() {
  command -v "$1" >/dev/null 2>&1 || die "missing required tool: $1"
}

port_busy() {
  lsof -tiTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1
}

wait_http() {
  local url="$1" out="$2" deadline=$((SECONDS + 20))
  while [ "$SECONDS" -lt "$deadline" ]; do
    if curl -fsS --max-time 2 "$url" >"$out" 2>/dev/null; then
      return 0
    fi
    sleep 0.25
  done
  return 1
}

stop_pid() {
  local pid="${1:-}"
  [ -n "$pid" ] || return 0
  kill "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
}

cleanup() {
  stop_pid "${SERVER_PID:-}"
  stop_pid "${PACKD_PID:-}"
  if [ -n "$TMP" ]; then
    if [ "$KEEP_TMP" = 1 ]; then
      printf 'helmcxx-packaging-proof: keeping %s\n' "$TMP"
    else
      rm -rf "$TMP"
    fi
  fi
}
trap cleanup EXIT INT TERM

while [ $# -gt 0 ]; do
  case "$1" in
    --run-smoke) RUN_SMOKE=1 ;;
    --keep-tmp) KEEP_TMP=1 ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown option: $1" ;;
  esac
  shift
done

need_tool bash
need_tool grep
need_tool find
need_tool sort
mkdir -p "$EVIDENCE_DIR"

cd "$ROOT"

FILES=(
  "scripts/install-helmcxx-runtime.sh"
  "docs/HELMCXX-PACKAGING.md"
)

for file in "${FILES[@]}"; do
  [ -f "$file" ] || die "missing packaging artifact: $file"
done
ok "packaging artifacts are checked in"

bash -n scripts/install-helmcxx-runtime.sh
bash -n scripts/helmcxx-packaging-proof.sh
ok "install/proof scripts pass shell syntax"

# Forbidden = Docker, Python *runtime daemons* (uvicorn/FastAPI), and temp-path
# runtime dirs. A bare `python3` invocation is allowed: the weather bake is
# offline tooling per docs/HELMCXX-ACCEPTANCE.md, not a runtime daemon.
if grep -RInE 'docker|docker-compose|containerd|podman|uvicorn|fastapi|FastAPI|/tmp/|/private/tmp' scripts/install-helmcxx-runtime.sh >"$EVIDENCE_DIR/forbidden-scan.txt"; then
  sed 's/^/  /' "$EVIDENCE_DIR/forbidden-scan.txt" >&2
  die "installer contains forbidden Docker/Python-daemon/temp-path dependency"
fi
ok "service/install artifacts do not require Docker, Python daemons, or temp-path runtime dirs"

for path in /opt/helm /etc/helm /var/lib/helm /var/cache/helm /var/log/helm /srv/helm/packs /srv/helm/wx-packs; do
  if ! grep -RIl -- "$path" scripts/install-helmcxx-runtime.sh docs/HELMCXX-PACKAGING.md >/dev/null; then
    die "deterministic path is not documented/enforced: $path"
  fi
done
ok "deterministic install/state/cache/log/pack directories are documented and enforced"

TMP="${HELM_HELMCXX6_TMP:-$(mktemp -d "${TMPDIR:-/tmp}/helmcxx6.XXXXXX")}"
mkdir -p "$TMP/build/cli" "$TMP/web" "$TMP/runtime/s57data" "$TMP/runtime/tcdata"
printf '<!doctype html><title>Helm</title>\n' >"$TMP/web/index.html"
printf 's57data fixture\n' >"$TMP/runtime/s57data/README"
printf 'tcdata fixture\n' >"$TMP/runtime/tcdata/README"
for bin in helm-server helm-packd helm-envd helm-basemap-cache; do
  printf '#!/usr/bin/env sh\nexit 0\n' >"$TMP/build/cli/$bin"
  chmod +x "$TMP/build/cli/$bin"
done

scripts/install-helmcxx-runtime.sh \
  --staging-root "$TMP/stage" \
  --build-cli "$TMP/build/cli" \
  --web-root "$TMP/web" \
  --runtime-source "$TMP/runtime" \
  >"$EVIDENCE_DIR/staged-install.log"

[ -x "$TMP/stage/opt/helm/bin/helm-server" ] || die "staged helm-server missing"
[ -x "$TMP/stage/opt/helm/bin/helm-packd" ] || die "staged helm-packd missing"
[ -d "$TMP/stage/opt/helm/web" ] || die "staged web root missing"
[ -d "$TMP/stage/var/lib/helm/runtime/s57data" ] || die "staged s57data missing"
[ -d "$TMP/stage/srv/helm/packs" ] || die "staged pack dir missing"
[ -f "$TMP/stage/etc/helm/helm-runtime.env" ] || die "staged runtime env missing"
if grep -E '/tmp|/private/tmp|docker|uvicorn|fastapi|FastAPI|python[0-9.]*' "$TMP/stage/etc/helm/helm-runtime.env" >"$EVIDENCE_DIR/staged-env-forbidden.txt"; then
  sed 's/^/  /' "$EVIDENCE_DIR/staged-env-forbidden.txt" >&2
  die "staged runtime env leaked temp or forbidden runtime dependency"
fi
find "$TMP/stage" -maxdepth 4 -type d -o -type f | sort >"$EVIDENCE_DIR/staged-tree.txt"
ok "installer populates staging root without leaking build paths into runtime env"

# --- reboot-persistent supervision units are generated for every layout ------
verify_units() {  # verify_units <stage> <os> <mode>
  local stage="$1" os="$2" mode="$3" dir unit svc
  if [ "$os" = Darwin ]; then
    [ "$mode" = system ] && dir="$stage/Library/LaunchDaemons" || dir="$stage$HOME/Library/LaunchAgents"
  else
    [ "$mode" = system ] && dir="$stage/etc/systemd/system" || dir="$stage${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
  fi
  for svc in helm-server helm-packd helm-envd helm-basemap-cache; do
    [ "$os" = Darwin ] && unit="$dir/com.6thelement.$svc.plist" || unit="$dir/$svc.service"
    [ -f "$unit" ] || die "$os/$mode: missing supervision unit for $svc"
    grep -q "bin/$svc" "$unit" || die "$os/$mode: $svc unit does not launch its installed binary"
    if [ "$os" = Darwin ]; then
      grep -Eq 'RunAtLoad</key>[[:space:]]*<true/>' "$unit" || die "$os/$mode: $svc launchd unit is not RunAtLoad (not reboot-persistent)"
    else
      grep -q '^WantedBy=' "$unit" || die "$os/$mode: $svc systemd unit has no [Install] WantedBy (not reboot-persistent)"
    fi
  done
  if grep -RInE 'docker|uvicorn|fastapi|FastAPI|python[0-9.]*|/private/tmp' "$dir" >/dev/null 2>&1; then
    die "$os/$mode: generated units leak a forbidden dependency"
  fi
}

for gos in Darwin Linux; do
  for gmode in system user; do
    gst="$TMP/units-$gos-$gmode"
    HELM_INSTALL_OS_OVERRIDE="$gos" scripts/install-helmcxx-runtime.sh \
      --mode "$gmode" --staging-root "$gst" \
      --build-cli "$TMP/build/cli" --web-root "$TMP/web" --runtime-source "$TMP/runtime" \
      >"$EVIDENCE_DIR/units-$gos-$gmode.log"
    verify_units "$gst" "$gos" "$gmode"
  done
done
ok "reboot-persistent launchd + systemd units generated for system and user modes"

# --- weather refresh: a scheduled (not shell-loop) bake job when a key is given -
printf 'HELM_WX_OPENMETEO_KEY=proofkey\n' >"$TMP/wx.env"
for gos in Darwin Linux; do
  wst="$TMP/wx-$gos"
  HELM_INSTALL_OS_OVERRIDE="$gos" scripts/install-helmcxx-runtime.sh \
    --user --staging-root "$wst" --wx-env-file "$TMP/wx.env" \
    --build-cli "$TMP/build/cli" --web-root "$TMP/web" --runtime-source "$TMP/runtime" \
    >"$EVIDENCE_DIR/wx-$gos.log"
  # the WHOLE bake chain must be bundled (self-contained in the prefix)
  for tool in wx_refresh_once.py boat_anchor.py wx_bake_openmeteo.py wx_pack_factory.py env_grid_pack.py; do
    [ -f "$wst$HOME/.helm/opt/scripts/$tool" ] || die "$gos: weather tool not bundled: $tool"
  done
  [ -f "$wst$HOME/.helm/opt/services/wx/fixtures/wx-openmeteo-source.json" ] || die "$gos: source-spec fixture not bundled"
  [ -f "$wst$HOME/.helm/opt/etc/helm-wx.env" ] || die "$gos: helm-wx.env not installed"
  perms=$(ls -l "$wst$HOME/.helm/opt/etc/helm-wx.env" | cut -c1-10)
  [ "$perms" = "-rw-------" ] || die "$gos: helm-wx.env is not 0600 (got $perms)"
  d="$wst$HOME/Library/LaunchAgents"; [ "$gos" = Linux ] && d="$wst${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
  if [ "$gos" = Darwin ]; then
    unit="$d/com.6thelement.helm-wx-refresh.plist"
    [ -f "$unit" ] || die "$gos: weather refresh plist missing"
    grep -q 'StartInterval' "$unit" || die "$gos: weather refresh has no StartInterval schedule"
    grep -q 'wx_refresh_once.py' "$unit" || die "$gos: weather refresh does not run wx_refresh_once.py"
  else
    [ -f "$d/helm-wx-refresh.service" ] || die "$gos: weather refresh service missing"
    [ -f "$d/helm-wx-refresh.timer" ] || die "$gos: weather refresh timer missing"
    grep -q 'OnUnitActiveSec' "$d/helm-wx-refresh.timer" || die "$gos: weather refresh timer has no cadence"
    grep -q 'wx_refresh_once.py' "$d/helm-wx-refresh.service" || die "$gos: weather refresh does not run wx_refresh_once.py"
  fi
  # the secret must live ONLY in the 0600 env file, never in a generated unit
  grep -rq 'proofkey' "$d" && die "$gos: OpenMeteo key leaked into a generated unit"
  # unified control: helmctl + its layout descriptor
  [ -x "$wst$HOME/.helm/opt/bin/helmctl" ] || die "$gos: helmctl not installed/executable"
  [ -f "$wst$HOME/.helm/opt/etc/helmctl.env" ] || die "$gos: helmctl.env not written"
  grep -q "HELM_OS=$gos" "$wst$HOME/.helm/opt/etc/helmctl.env" || die "$gos: helmctl.env has wrong HELM_OS"
  grep -q 'HELM_HAS_WX=1' "$wst$HOME/.helm/opt/etc/helmctl.env" || die "$gos: helmctl.env missing HELM_HAS_WX"
done
ok "weather refresh installs its tools + a scheduled (OS-timer) bake job, key kept 0600"
ok "full bake pipeline bundled in prefix; helmctl control + layout descriptor installed"

python3 -m py_compile scripts/wx_refresh_once.py scripts/boat_anchor.py scripts/wx_pack_factory.py scripts/env_grid_pack.py
sh -n scripts/helmctl
ok "weather + helmctl scripts pass syntax"

if [ "$RUN_SMOKE" != 1 ]; then
  printf 'HELMC++-6 packaging proof: PASS (static/staged)\n'
  printf '  evidence: %s\n' "$EVIDENCE_DIR"
  exit 0
fi

need_tool curl
need_tool lsof
need_tool node

REAL_BUILD_CLI="${HELM_BUILD_CLI_DIR:-${HELM_OCPN_DIR:-$HOME/.helm/build/helm-opencpn}/build/cli}"
REAL_RUNTIME="${HELM_RUNTIME_SOURCE:-$HOME/.helm/runtime}"
[ -x "$REAL_BUILD_CLI/helm-server" ] || die "--run-smoke needs real helm-server in $REAL_BUILD_CLI"
[ -x "$REAL_BUILD_CLI/helm-packd" ] || die "--run-smoke needs real helm-packd in $REAL_BUILD_CLI"
[ -d "$REAL_RUNTIME/s57data" ] || die "--run-smoke needs runtime s57data in $REAL_RUNTIME"

SMOKE_STAGE="$TMP/smoke-stage"
scripts/install-helmcxx-runtime.sh \
  --staging-root "$SMOKE_STAGE" \
  --build-cli "$REAL_BUILD_CLI" \
  --web-root "$ROOT/web" \
  --runtime-source "$REAL_RUNTIME" \
  >"$EVIDENCE_DIR/smoke-install.log"

if [ -f "$ROOT/web/data/fiji-sat.pmtiles" ]; then
  cp "$ROOT/web/data/fiji-sat.pmtiles" "$SMOKE_STAGE/srv/helm/packs/fiji-sat.pmtiles"
fi

CORE_PORT=$((PORT_BASE + 0))
PACKD_PORT=$((PORT_BASE + 1))
for port in "$CORE_PORT" "$PACKD_PORT"; do
  [ "$port" != "8080" ] || die "refusing to use locked live port :8080"
  port_busy "$port" && die "private smoke port is busy: $port"
done

HELM_BIND=127.0.0.1 \
HELM_MBTILES_DIR="$SMOKE_STAGE/srv/helm/packs" \
  "$SMOKE_STAGE/opt/helm/bin/helm-packd" "$PACKD_PORT" >"$EVIDENCE_DIR/helm-packd.log" 2>&1 &
PACKD_PID=$!

HELM_BIND=127.0.0.1 \
HELM_PORT="$CORE_PORT" \
HELM_WEB_ROOT="$SMOKE_STAGE/opt/helm/web" \
HELM_CONFIG="$SMOKE_STAGE/etc/helm" \
HELM_S57_DATA="$SMOKE_STAGE/var/lib/helm/runtime/s57data" \
HELM_SENC_DIR="$SMOKE_STAGE/var/cache/helm/senc" \
HELM_USER_DATA_ROOT="$SMOKE_STAGE/var/lib/helm/data" \
HELM_ENC="$SMOKE_STAGE/var/lib/helm/runtime/enc/US5FL4CR/US5FL4CR.000" \
HELM_TILES_NO_WARMUP=1 \
  "$SMOKE_STAGE/opt/helm/bin/helm-server" >"$EVIDENCE_DIR/helm-server.log" 2>&1 &
SERVER_PID=$!

wait_http "http://127.0.0.1:$CORE_PORT/health" "$EVIDENCE_DIR/health.json" || die "helm-server did not serve /health"
wait_http "http://127.0.0.1:$CORE_PORT/catalog" "$EVIDENCE_DIR/catalog.json" || die "helm-server did not serve /catalog"
wait_http "http://127.0.0.1:$PACKD_PORT/catalog" "$EVIDENCE_DIR/packd-catalog.json" || die "helm-packd did not serve /catalog"

node - "$EVIDENCE_DIR/health.json" "$EVIDENCE_DIR/packd-catalog.json" <<'NODE'
const fs = require('node:fs');
const health = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const catalog = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
function fail(message) {
  console.error(message);
  process.exit(1);
}
if (health.engine !== 'helm-server') fail('/health did not report helm-server');
if (!Object.prototype.hasOwnProperty.call(health, 'chart_loaded')) fail('/health missing chart_loaded');
const text = JSON.stringify(catalog);
if (!/fiji-sat|packs|charts|cells/.test(text)) fail('packd catalog did not expose local-pack shape');
NODE

stop_pid "$SERVER_PID"
SERVER_PID=""
stop_pid "$PACKD_PID"
PACKD_PID=""

printf 'HELMC++-6 packaging proof: PASS (static/staged + runtime smoke)\n'
printf '  evidence: %s\n' "$EVIDENCE_DIR"
