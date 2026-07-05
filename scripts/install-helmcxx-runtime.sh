#!/usr/bin/env bash
#
# HELMC++: install the boat-side C++ runtime into deterministic directories and,
# unless told otherwise, stand it up as a reboot-persistent supervised stack.
#
# Two deployment models:
#   --system   (default) system service install: /opt/helm etc, launchd
#              LaunchDaemons (macOS) or systemd system units (Linux). Needs root.
#              Starts at boot without anyone logging in. Boat-appliance / server.
#   --user     per-user install under a single relocatable prefix, launchd
#              LaunchAgents (macOS) or `systemctl --user` (Linux). No root.
#              Reboot-persists on login. This is the foundation a double-click
#              app bundle wraps.
#
# Supervision units are GENERATED for the resolved paths (relocatable). It does
# not build, fetch, run Docker, or create a virtualenv. Build with
# engine/bootstrap.sh first.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# HELM_INSTALL_OS_OVERRIDE lets the packaging proof render the other platform's
# units from one host; real installs resolve it from uname.
OS="${HELM_INSTALL_OS_OVERRIDE:-$(uname -s)}"

BUILD_CLI="${HELM_BUILD_CLI_DIR:-${HELM_OCPN_DIR:-$HOME/.helm/build/helm-opencpn}/build/cli}"
WEB_SOURCE="${HELM_WEB_SOURCE:-$ROOT/web}"
RUNTIME_SOURCE="${HELM_RUNTIME_SOURCE:-$HOME/.helm/runtime}"

MODE="system"
# Path vars start empty; per-mode defaults are applied after arg parsing so an
# explicit --flag or HELM_INSTALL_* env always wins.
PREFIX="${HELM_INSTALL_PREFIX:-}"
CONFIG_DIR="${HELM_INSTALL_CONFIG_DIR:-}"
STATE_DIR="${HELM_INSTALL_STATE_DIR:-}"
CACHE_DIR="${HELM_INSTALL_CACHE_DIR:-}"
LOG_DIR="${HELM_INSTALL_LOG_DIR:-}"
PACKS_DIR="${HELM_INSTALL_PACKS_DIR:-}"
WX_PACKS_DIR="${HELM_INSTALL_WX_PACKS_DIR:-}"
STAGING_ROOT="${HELM_INSTALL_STAGING_ROOT:-}"
ENABLE_SUPERVISION=1
DRY_RUN=0

# Weather refresh (optional): a KEY=VAL env file with at least HELM_WX_OPENMETEO_KEY.
# When given, the installer schedules a periodic bake+publish cycle (launchd
# StartInterval / systemd timer) that runs wx_refresh_once.py. Without it, envd is
# still supervised but nothing bakes new weather.
WX_ENV_FILE="${HELM_INSTALL_WX_ENV_FILE:-}"
WX_REFRESH_INTERVAL="${HELM_INSTALL_WX_INTERVAL:-21600}"

# Data-pointing overrides (used to dogfood an install against existing charts/packs
# instead of copying them). Empty => use the installed defaults.
ENC_OVERRIDE="${HELM_INSTALL_ENC:-}"
MBTILES_OVERRIDE="${HELM_INSTALL_MBTILES_DIR:-}"
WEBROOT_OVERRIDE="${HELM_INSTALL_WEB_ROOT:-}"

usage() {
  cat <<'USAGE'
Usage: scripts/install-helmcxx-runtime.sh [options]

Install Helm's C++ boat runtime and supervise it as a reboot-persistent stack.

Deployment model:
  --system              System service install (default): /opt/helm, launchd
                        LaunchDaemons / systemd system units. Needs root.
  --user                Per-user install under ~ , launchd LaunchAgents /
                        systemctl --user. No root.

Layout (each defaults per mode; override to relocate):
  --prefix DIR          Runtime prefix (binaries + web).
  --config-dir DIR      Config directory (holds helm-runtime.env).
  --state-dir DIR       Durable state directory (runtime assets, ENC, data).
  --cache-dir DIR       Regenerable cache directory.
  --log-dir DIR         Log directory.
  --packs-dir DIR       Local MBTiles/PMTiles directory.
  --wx-packs-dir DIR    Environmental pack release directory.

Sources:
  --build-cli DIR       Directory with helm-server/helm-packd/helm-envd/helm-basemap-cache.
  --web-root DIR        Source web directory to install as the static cockpit.
  --runtime-source DIR  Source runtime asset directory containing s57data.

Point at existing data instead of copying (for dogfooding a live box):
  --enc PATH            HELM_ENC chart to run (default: <state>/runtime/enc sample).
  --mbtiles-dir DIR     HELM_MBTILES_DIR local pack dir (default: --packs-dir).
  --serve-web DIR       HELM_WEB_ROOT to serve (default: <prefix>/web).

Weather refresh (optional):
  --wx-env-file FILE    Env file with HELM_WX_OPENMETEO_KEY (+ tuning). Enables a
                        scheduled bake+publish cycle (launchd StartInterval /
                        systemd timer). Omit to supervise envd without baking.
  --wx-interval SECS    Refresh cadence (default 21600 = 6h).

Supervision:
  --no-supervision      Install files only; do not generate/enable services.
  --staging-root DIR    Prepend DIR to every install path; render units but do
                        NOT bootstrap/enable them (for proof/testing).
  --dry-run             Print the plan without writing anything.
  -h, --help            Show this help.
USAGE
}

die() { printf 'install-helmcxx-runtime: %s\n' "$*" >&2; exit 1; }
log() { printf '==> %s\n' "$*"; }

require_abs() {
  local name="$1" path="$2"
  case "$path" in
    /*) ;;
    *) die "$name must be an absolute path: $path" ;;
  esac
}

dest_path() {
  local path="$1"
  if [ -n "$STAGING_ROOT" ]; then
    printf '%s/%s\n' "${STAGING_ROOT%/}" "${path#/}"
  else
    printf '%s\n' "$path"
  fi
}

install_file() {
  local src="$1" dst="$2" mode="$3"
  [ -f "$src" ] || die "missing file: $src"
  if [ "$DRY_RUN" = 1 ]; then
    printf 'copy %s -> %s\n' "$src" "$dst"
    return
  fi
  mkdir -p "$(dirname "$dst")"
  # Atomic replace: copy to a temp beside the destination, then rename into place.
  # A plain in-place `cp` over a running/mmap'd binary poisons the kernel's cached
  # code signature for that vnode, and macOS then kills every new exec with
  # OS_REASON_CODESIGNING. `mv` gives the destination path a fresh inode, so an
  # upgrade over a live install starts cleanly.
  local tmp="$dst.install.$$"
  cp "$src" "$tmp"
  chmod "$mode" "$tmp"
  mv -f "$tmp" "$dst"
}

copy_dir() {
  local src="$1" dst="$2"
  [ -d "$src" ] || die "missing directory: $src"
  if [ "$DRY_RUN" = 1 ]; then
    printf 'copy-dir %s -> %s\n' "$src" "$dst"
    return
  fi
  rm -rf "$dst"
  mkdir -p "$dst"
  cp -R "$src/." "$dst/"
}

write_file() {  # write_file <dst> <mode> ; body on stdin
  local dst="$1" mode="$2"
  if [ "$DRY_RUN" = 1 ]; then printf 'write %s\n' "$dst"; cat >/dev/null; return; fi
  mkdir -p "$(dirname "$dst")"
  local tmp="$dst.install.$$"
  cat >"$tmp"
  chmod "$mode" "$tmp"
  mv -f "$tmp" "$dst"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --system) MODE="system" ;;
    --user) MODE="user" ;;
    --mode) shift; MODE="${1:-}" ;;
    --build-cli) shift; BUILD_CLI="${1:-}" ;;
    --web-root) shift; WEB_SOURCE="${1:-}" ;;
    --runtime-source) shift; RUNTIME_SOURCE="${1:-}" ;;
    --prefix) shift; PREFIX="${1:-}" ;;
    --config-dir) shift; CONFIG_DIR="${1:-}" ;;
    --state-dir) shift; STATE_DIR="${1:-}" ;;
    --cache-dir) shift; CACHE_DIR="${1:-}" ;;
    --log-dir) shift; LOG_DIR="${1:-}" ;;
    --packs-dir) shift; PACKS_DIR="${1:-}" ;;
    --wx-packs-dir) shift; WX_PACKS_DIR="${1:-}" ;;
    --enc) shift; ENC_OVERRIDE="${1:-}" ;;
    --mbtiles-dir) shift; MBTILES_OVERRIDE="${1:-}" ;;
    --serve-web) shift; WEBROOT_OVERRIDE="${1:-}" ;;
    --wx-env-file) shift; WX_ENV_FILE="${1:-}" ;;
    --wx-interval) shift; WX_REFRESH_INTERVAL="${1:-}" ;;
    --no-supervision) ENABLE_SUPERVISION=0 ;;
    --staging-root) shift; STAGING_ROOT="${1:-}" ;;
    --dry-run) DRY_RUN=1 ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown option: $1" ;;
  esac
  shift
done

case "$MODE" in system|user) ;; *) die "--mode must be 'system' or 'user', got: $MODE" ;; esac

# ---- per-mode default layout (only fills vars left empty) ------------------
if [ "$MODE" = "user" ]; then
  USER_PREFIX="$HOME/.helm/opt"
  : "${PREFIX:=$USER_PREFIX}"
  : "${CONFIG_DIR:=$USER_PREFIX/etc}"
  : "${STATE_DIR:=$USER_PREFIX/var/lib}"
  : "${CACHE_DIR:=$USER_PREFIX/var/cache}"
  : "${LOG_DIR:=$USER_PREFIX/var/log}"
  : "${PACKS_DIR:=$USER_PREFIX/srv/packs}"
  : "${WX_PACKS_DIR:=$USER_PREFIX/srv/wx-packs}"
else
  : "${PREFIX:=/opt/helm}"
  : "${CONFIG_DIR:=/etc/helm}"
  : "${STATE_DIR:=/var/lib/helm}"
  : "${CACHE_DIR:=/var/cache/helm}"
  : "${LOG_DIR:=/var/log/helm}"
  : "${PACKS_DIR:=/srv/helm/packs}"
  : "${WX_PACKS_DIR:=/srv/helm/wx-packs}"
fi

for pair in \
  "prefix:$PREFIX" "config-dir:$CONFIG_DIR" "state-dir:$STATE_DIR" \
  "cache-dir:$CACHE_DIR" "log-dir:$LOG_DIR" "packs-dir:$PACKS_DIR" \
  "wx-packs-dir:$WX_PACKS_DIR"
do
  require_abs "${pair%%:*}" "${pair#*:}"
done
[ -z "$STAGING_ROOT" ] || require_abs "staging-root" "$STAGING_ROOT"

# Staging/dry-run render files but never touch the live service manager.
BOOTSTRAP=1
{ [ -n "$STAGING_ROOT" ] || [ "$DRY_RUN" = 1 ] || [ "$ENABLE_SUPERVISION" = 0 ]; } && BOOTSTRAP=0

for bin in helm-server helm-packd helm-envd helm-basemap-cache; do
  [ -x "$BUILD_CLI/$bin" ] || die "$bin missing or not executable in $BUILD_CLI"
done
[ -d "$WEB_SOURCE" ] || die "web root missing: $WEB_SOURCE"
[ -d "$RUNTIME_SOURCE/s57data" ] || die "runtime s57data missing: $RUNTIME_SOURCE/s57data; run engine/bootstrap.sh first"

# Resolved runtime data pointers (env in helm-runtime.env / units).
HELM_ENC_VALUE="${ENC_OVERRIDE:-$STATE_DIR/runtime/enc/US5FL4CR/US5FL4CR.000}"
HELM_MBTILES_VALUE="${MBTILES_OVERRIDE:-$PACKS_DIR}"
HELM_WEBROOT_VALUE="${WEBROOT_OVERRIDE:-$PREFIX/web}"
# Stable weather manifest path. envd resolves a manifest's chunk paths relative to
# the manifest file's OWN directory, so the stable pointer is a "current" symlink
# to the live release's packs dir plus a stable-named manifest inside it — the
# weather publish/bake step maintains both. A fresh install has neither yet; envd
# starts anyway and serves nothing until weather packs are baked.
HELM_ENVD_MANIFEST="$WX_PACKS_DIR/current/current.manifest.json"

PREFIX_DST="$(dest_path "$PREFIX")"
CONFIG_DST="$(dest_path "$CONFIG_DIR")"
STATE_DST="$(dest_path "$STATE_DIR")"
CACHE_DST="$(dest_path "$CACHE_DIR")"
LOG_DST="$(dest_path "$LOG_DIR")"
PACKS_DST="$(dest_path "$PACKS_DIR")"
WX_PACKS_DST="$(dest_path "$WX_PACKS_DIR")"

log "installing C++ runtime binaries ($MODE mode)"
for bin in helm-server helm-packd helm-envd helm-basemap-cache; do
  install_file "$BUILD_CLI/$bin" "$PREFIX_DST/bin/$bin" 0755
done
# helm-envd launch shim — expands the release's EVERY pack manifest (atmospheric +
# marine) into HELM_ENV_GRID_MANIFESTS so all weather layers load, not just packs[0].
# Installed next to helm-envd so its sibling-relative exec resolves for any prefix.
[ -f "$ROOT/scripts/helm-envd-launch" ] || die "weather tool missing from checkout: scripts/helm-envd-launch"
install_file "$ROOT/scripts/helm-envd-launch" "$PREFIX_DST/bin/helm-envd-launch" 0755

log "installing cockpit web assets"
copy_dir "$WEB_SOURCE" "$PREFIX_DST/web"

log "installing weather bake/refresh pipeline"
# The whole bake chain, self-contained in the prefix. The tools resolve their
# fixtures + each other by __file__-relative paths, so mirroring the repo layout
# (scripts/ + services/wx/fixtures/) makes a keyed install bake out of the box.
for tool in wx_refresh_once.py boat_anchor.py wx_bake_openmeteo.py wx_pack_factory.py env_grid_pack.py; do
  [ -f "$ROOT/scripts/$tool" ] || die "weather tool missing from checkout: scripts/$tool"
  install_file "$ROOT/scripts/$tool" "$PREFIX_DST/scripts/$tool" 0755
done
install_file "$ROOT/services/wx/fixtures/wx-openmeteo-source.json" \
  "$PREFIX_DST/services/wx/fixtures/wx-openmeteo-source.json" 0644

log "installing helmctl control script"
install_file "$ROOT/scripts/helmctl" "$PREFIX_DST/bin/helmctl" 0755

log "installing durable runtime assets"
copy_dir "$RUNTIME_SOURCE/s57data" "$STATE_DST/runtime/s57data"
if [ -d "$RUNTIME_SOURCE/tcdata" ]; then
  copy_dir "$RUNTIME_SOURCE/tcdata" "$STATE_DST/runtime/tcdata"
fi

if [ "$DRY_RUN" != 1 ]; then
  mkdir -p \
    "$CONFIG_DST" "$STATE_DST/runtime/enc" "$STATE_DST/data" \
    "$CACHE_DST/senc" "$CACHE_DST/tile-cache" "$CACHE_DST/tides" \
    "$CACHE_DST/basemap-fill" "$CACHE_DST/work" \
    "$LOG_DST" "$PACKS_DST" "$WX_PACKS_DST"
fi

log "writing runtime environment"
write_file "$CONFIG_DST/helm-runtime.env" 0644 <<EOF
# Generated by scripts/install-helmcxx-runtime.sh ($MODE mode).
# Target paths are deterministic and do not depend on a build checkout.
HELM_BIND=0.0.0.0
HELM_PORT=8080
HELM_WEB_ROOT=$HELM_WEBROOT_VALUE
HELM_CONFIG=$CONFIG_DIR
HELM_RUNTIME_DIR=$STATE_DIR/runtime
HELM_S57_DATA=$STATE_DIR/runtime/s57data
HELM_TCDATA_DIR=$STATE_DIR/runtime/tcdata
HELM_SENC_DIR=$CACHE_DIR/senc
HELM_TIDES_CACHE_DIR=$CACHE_DIR/tides
HELM_FILL_CACHE=$CACHE_DIR/basemap-fill
HELM_USER_DATA_ROOT=$STATE_DIR/data
HELM_ENC=$HELM_ENC_VALUE
HELM_MBTILES_DIR=$HELM_MBTILES_VALUE
HELM_WX_PACKS_DIR=$WX_PACKS_DIR
HELM_ENV_GRID_MANIFESTS=$HELM_ENVD_MANIFEST
HELM_PACKD_PORT=8091
HELM_ENVD_PORT=8094
HELM_BASEMAP_CACHE_PORT=8095
HELM_TILES_NO_WARMUP=1
EOF

# Optional weather-source env (OpenMeteo key + tuning). Kept in a 0600 file the
# scheduled refresh sources; never baked into world-readable places.
if [ -n "$WX_ENV_FILE" ]; then
  [ -f "$WX_ENV_FILE" ] || die "--wx-env-file not found: $WX_ENV_FILE"
  install_file "$WX_ENV_FILE" "$CONFIG_DST/helm-wx.env" 0600
fi

# helmctl layout descriptor (prefix-local; helmctl self-locates it at ../etc).
write_file "$PREFIX_DST/etc/helmctl.env" 0644 <<EOF
# Written by scripts/install-helmcxx-runtime.sh — how helmctl drives this install.
HELM_MODE=$MODE
HELM_OS=$OS
HELM_LABEL_PREFIX=com.6thelement
HELM_HAS_WX=$([ -n "$WX_ENV_FILE" ] && echo 1 || echo "")
EOF

# ===========================================================================
# Supervision: generate reboot-persistent units for the RESOLVED layout.
# ===========================================================================
LABEL_PREFIX="com.6thelement"
# daemon spec: "name|port|extra-env(space-separated KEY=VAL)". server has no positional port.
DAEMONS=(
  "helm-server||"
  "helm-packd|8091|HELM_MBTILES_DIR=$HELM_MBTILES_VALUE"
  "helm-basemap-cache|8095|"
  "helm-envd|8094|HELM_ENV_GRID_MANIFESTS=$HELM_ENVD_MANIFEST"
)

render_launchd() {  # render_launchd <name> <port> <extra-env>
  local name="$1" port="$2" extra="$3"
  # helm-envd runs via the launch shim so every pack manifest (atmospheric + marine)
  # loads; the pinned HELM_ENV_GRID_MANIFESTS below is only its graceful fallback.
  local prog="$name"; [ "$name" = "helm-envd" ] && prog="helm-envd-launch"
  printf '<?xml version="1.0" encoding="UTF-8"?>\n'
  printf '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n'
  printf '<plist version="1.0">\n<dict>\n'
  printf '  <key>Label</key><string>%s.%s</string>\n' "$LABEL_PREFIX" "$name"
  printf '  <key>ProgramArguments</key>\n  <array>\n    <string>%s/bin/%s</string>\n' "$PREFIX" "$prog"
  [ -n "$port" ] && printf '    <string>%s</string>\n' "$port"
  printf '  </array>\n'
  printf '  <key>WorkingDirectory</key><string>%s</string>\n' "$PREFIX"
  printf '  <key>EnvironmentVariables</key>\n  <dict>\n'
  printf '    <key>HELM_BIND</key><string>0.0.0.0</string>\n'
  if [ "$name" = "helm-server" ]; then
    printf '    <key>HELM_PORT</key><string>8080</string>\n'
    printf '    <key>HELM_WEB_ROOT</key><string>%s</string>\n' "$HELM_WEBROOT_VALUE"
    printf '    <key>HELM_CONFIG</key><string>%s</string>\n' "$CONFIG_DIR"
    printf '    <key>HELM_RUNTIME_DIR</key><string>%s/runtime</string>\n' "$STATE_DIR"
    printf '    <key>HELM_S57_DATA</key><string>%s/runtime/s57data</string>\n' "$STATE_DIR"
    printf '    <key>HELM_TCDATA_DIR</key><string>%s/runtime/tcdata</string>\n' "$STATE_DIR"
    printf '    <key>HELM_SENC_DIR</key><string>%s/senc</string>\n' "$CACHE_DIR"
    printf '    <key>HELM_TIDES_CACHE_DIR</key><string>%s/tides</string>\n' "$CACHE_DIR"
    printf '    <key>HELM_FILL_CACHE</key><string>%s/basemap-fill</string>\n' "$CACHE_DIR"
    printf '    <key>HELM_USER_DATA_ROOT</key><string>%s/data</string>\n' "$STATE_DIR"
    printf '    <key>HELM_ENC</key><string>%s</string>\n' "$HELM_ENC_VALUE"
    printf '    <key>HELM_TILES_NO_WARMUP</key><string>1</string>\n'
  fi
  local kv
  for kv in $extra; do
    printf '    <key>%s</key><string>%s</string>\n' "${kv%%=*}" "${kv#*=}"
  done
  printf '  </dict>\n'
  printf '  <key>RunAtLoad</key><true/>\n  <key>KeepAlive</key><true/>\n'
  printf '  <key>ProcessType</key><string>Interactive</string>\n'
  printf '  <key>StandardOutPath</key><string>%s/%s.log</string>\n' "$LOG_DIR" "$name"
  printf '  <key>StandardErrorPath</key><string>%s/%s.err.log</string>\n' "$LOG_DIR" "$name"
  printf '</dict>\n</plist>\n'
}

render_systemd() {  # render_systemd <name> <port> <extra-env>
  local name="$1" port="$2" extra="$3"
  # helm-envd runs via the launch shim (loads every pack manifest; the pinned
  # HELM_ENV_GRID_MANIFESTS Environment= below is its graceful fallback).
  local prog="$name"; [ "$name" = "helm-envd" ] && prog="helm-envd-launch"
  local execargs="$PREFIX/bin/$prog"; [ -n "$port" ] && execargs="$execargs $port"
  printf '[Unit]\n'
  printf 'Description=Helm C++ runtime service (%s)\n' "$name"
  printf 'After=network-online.target\nWants=network-online.target\n\n'
  printf '[Service]\nType=simple\n'
  if [ "$MODE" = "system" ]; then printf 'User=helm\nGroup=helm\n'; fi
  printf 'EnvironmentFile=%s/helm-runtime.env\n' "$CONFIG_DIR"
  local kv
  for kv in $extra; do printf 'Environment=%s\n' "$kv"; done
  printf 'WorkingDirectory=%s\n' "$PREFIX"
  printf 'ExecStart=%s\n' "$execargs"
  printf 'Restart=on-failure\nRestartSec=3\n'
  if [ "$MODE" = "system" ]; then
    printf 'NoNewPrivileges=true\nPrivateTmp=true\nProtectSystem=full\n'
    printf 'ReadWritePaths=%s %s %s %s %s\n' "$CONFIG_DIR" "$STATE_DIR" "$CACHE_DIR" "$LOG_DIR" "$PACKS_DIR"
  fi
  printf 'StandardOutput=append:%s/%s.log\n' "$LOG_DIR" "$name"
  printf 'StandardError=append:%s/%s.err.log\n' "$LOG_DIR" "$name"
  printf '\n[Install]\n'
  if [ "$MODE" = "system" ]; then printf 'WantedBy=multi-user.target\n'; else printf 'WantedBy=default.target\n'; fi
}

WX_LABEL="$LABEL_PREFIX.helm-wx-refresh"
PY="${HELM_PYTHON:-/usr/bin/python3}"

render_wx_launchd() {  # a periodic bake+publish job (StartInterval), not a daemon
  printf '<?xml version="1.0" encoding="UTF-8"?>\n'
  printf '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n'
  printf '<plist version="1.0">\n<dict>\n'
  printf '  <key>Label</key><string>%s</string>\n' "$WX_LABEL"
  printf '  <key>ProgramArguments</key>\n  <array>\n'
  printf '    <string>%s</string>\n    <string>%s/scripts/wx_refresh_once.py</string>\n  </array>\n' "$PY" "$PREFIX"
  printf '  <key>WorkingDirectory</key><string>%s</string>\n' "$PREFIX"
  printf '  <key>EnvironmentVariables</key>\n  <dict>\n'
  printf '    <key>HELM_WX_PACKS_DIR</key><string>%s</string>\n' "$WX_PACKS_DIR"
  printf '    <key>HELM_ENVD_LABEL</key><string>%s.helm-envd</string>\n' "$LABEL_PREFIX"
  printf '    <key>HELM_WX_CONNECTIONS</key><string>%s/connections.json</string>\n' "$CONFIG_DIR"
  printf '    <key>HELM_WX_ENV_FILE</key><string>%s/helm-wx.env</string>\n' "$CONFIG_DIR"
  printf '  </dict>\n'
  printf '  <key>RunAtLoad</key><true/>\n  <key>StartInterval</key><integer>%s</integer>\n' "$WX_REFRESH_INTERVAL"
  printf '  <key>StandardOutPath</key><string>%s/helm-wx-refresh.log</string>\n' "$LOG_DIR"
  printf '  <key>StandardErrorPath</key><string>%s/helm-wx-refresh.log</string>\n' "$LOG_DIR"
  printf '</dict>\n</plist>\n'
}

render_wx_systemd_service() {
  printf '[Unit]\nDescription=Helm weather bake+publish cycle\nAfter=network-online.target\nWants=network-online.target\n\n'
  printf '[Service]\nType=oneshot\n'
  if [ "$MODE" = "system" ]; then printf 'User=helm\nGroup=helm\n'; fi
  printf 'EnvironmentFile=%s/helm-runtime.env\n' "$CONFIG_DIR"
  printf 'EnvironmentFile=%s/helm-wx.env\n' "$CONFIG_DIR"
  printf 'Environment=HELM_ENVD_UNIT=helm-envd.service\n'
  printf 'ExecStart=%s %s/scripts/wx_refresh_once.py\n' "$PY" "$PREFIX"
}

render_wx_systemd_timer() {
  printf '[Unit]\nDescription=Helm weather refresh cadence\n\n'
  printf '[Timer]\nOnBootSec=2min\nOnUnitActiveSec=%s\nPersistent=true\n\n' "$WX_REFRESH_INTERVAL"
  printf '[Install]\n'
  if [ "$MODE" = "system" ]; then printf 'WantedBy=timers.target\n'; else printf 'WantedBy=default.target\n'; fi
}

# Resolve where units go and how they are (un)loaded.
if [ "$OS" = "Darwin" ]; then
  if [ "$MODE" = "system" ]; then SUPERVISION_DIR="/Library/LaunchDaemons"; else SUPERVISION_DIR="$HOME/Library/LaunchAgents"; fi
else
  if [ "$MODE" = "system" ]; then SUPERVISION_DIR="/etc/systemd/system"; else SUPERVISION_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"; fi
fi
SUPERVISION_DST="$(dest_path "$SUPERVISION_DIR")"

if [ "$ENABLE_SUPERVISION" = 1 ]; then
  log "generating supervision units ($OS, $MODE) -> $SUPERVISION_DIR"
  for spec in "${DAEMONS[@]}"; do
    IFS='|' read -r name port extra <<EOF
$spec
EOF
    if [ "$OS" = "Darwin" ]; then
      render_launchd "$name" "$port" "$extra" | write_file "$SUPERVISION_DST/$LABEL_PREFIX.$name.plist" 0644
    else
      render_systemd "$name" "$port" "$extra" | write_file "$SUPERVISION_DST/$name.service" 0644
    fi
  done
  if [ -n "$WX_ENV_FILE" ]; then
    if [ "$OS" = "Darwin" ]; then
      render_wx_launchd | write_file "$SUPERVISION_DST/$WX_LABEL.plist" 0644
    else
      render_wx_systemd_service | write_file "$SUPERVISION_DST/helm-wx-refresh.service" 0644
      render_wx_systemd_timer   | write_file "$SUPERVISION_DST/helm-wx-refresh.timer" 0644
    fi
  fi
fi

# ---- bootstrap/enable into the live service manager -----------------------
launchd_domain() { [ "$MODE" = "system" ] && printf 'system' || printf 'gui/%s' "$(id -u)"; }

# Replace a launchd service without racing bootout: bootout is async, and a
# bootstrap that lands before the old label is gone fails with EIO(5). Wait for
# the label to disappear, then bootstrap with a few retries.
launchd_reload() {  # $1=domain $2=label $3=plist
  launchctl bootout "$1/$2" 2>/dev/null || true
  local i=0
  while launchctl print "$1/$2" >/dev/null 2>&1; do i=$((i + 1)); [ "$i" -ge 40 ] && break; sleep 0.25; done
  i=0
  while ! launchctl bootstrap "$1" "$3" 2>/dev/null; do
    i=$((i + 1)); [ "$i" -ge 6 ] && return 1; sleep 0.5
  done
  return 0
}

if [ "$BOOTSTRAP" = 1 ]; then
  if [ "$MODE" = "system" ] && [ "$(id -u)" != 0 ]; then
    die "system mode needs root to enable services; re-run with sudo (or use --user / --no-supervision / --staging-root)"
  fi
  log "enabling reboot-persistent supervision"
  if [ "$OS" = "Darwin" ]; then
    dom="$(launchd_domain)"
    for spec in "${DAEMONS[@]}"; do
      name="${spec%%|*}"
      launchd_reload "$dom" "$LABEL_PREFIX.$name" "$SUPERVISION_DIR/$LABEL_PREFIX.$name.plist" \
        || die "launchctl bootstrap failed for $name"
      launchctl kickstart -k "$dom/$LABEL_PREFIX.$name" 2>/dev/null || true
    done
    if [ -n "$WX_ENV_FILE" ]; then
      launchd_reload "$dom" "$WX_LABEL" "$SUPERVISION_DIR/$WX_LABEL.plist" \
        || die "launchctl bootstrap failed for weather refresh"
    fi
  else
    if [ "$MODE" = "system" ]; then
      systemctl daemon-reload
      for spec in "${DAEMONS[@]}"; do systemctl enable --now "${spec%%|*}.service" || die "systemctl enable failed for ${spec%%|*}"; done
      [ -n "$WX_ENV_FILE" ] && { systemctl enable --now helm-wx-refresh.timer || die "systemctl enable failed for weather refresh timer"; }
    else
      systemctl --user daemon-reload
      for spec in "${DAEMONS[@]}"; do systemctl --user enable --now "${spec%%|*}.service" || die "systemctl --user enable failed for ${spec%%|*}"; done
      [ -n "$WX_ENV_FILE" ] && { systemctl --user enable --now helm-wx-refresh.timer || die "systemctl --user enable failed for weather refresh timer"; }
    fi
  fi
fi

log "installed Helm runtime plan ($MODE mode)"
printf '  prefix:      %s%s\n' "$PREFIX" "${STAGING_ROOT:+ (staged at $PREFIX_DST)}"
printf '  config:      %s%s\n' "$CONFIG_DIR" "${STAGING_ROOT:+ (staged at $CONFIG_DST)}"
printf '  state:       %s%s\n' "$STATE_DIR" "${STAGING_ROOT:+ (staged at $STATE_DST)}"
printf '  cache:       %s%s\n' "$CACHE_DIR" "${STAGING_ROOT:+ (staged at $CACHE_DST)}"
printf '  logs:        %s%s\n' "$LOG_DIR" "${STAGING_ROOT:+ (staged at $LOG_DST)}"
printf '  local packs: %s%s\n' "$PACKS_DIR" "${STAGING_ROOT:+ (staged at $PACKS_DST)}"
printf '  wx packs:    %s%s\n' "$WX_PACKS_DIR" "${STAGING_ROOT:+ (staged at $WX_PACKS_DST)}"
printf '  supervision: %s%s\n' "$SUPERVISION_DIR" "${STAGING_ROOT:+ (staged at $SUPERVISION_DST)}"
printf '  control:     %s/bin/helmctl {start|stop|restart|status}\n' "$PREFIX"
if [ -n "$WX_ENV_FILE" ]; then
  printf '  weather:     scheduled bake+publish every %ss (wx_refresh_once.py)\n' "$WX_REFRESH_INTERVAL"
else
  printf '  weather:     envd supervised; no bake scheduled (no --wx-env-file)\n'
fi
if [ "$BOOTSTRAP" = 1 ]; then
  printf '  services:    enabled + reboot-persistent (%s)\n' "$([ "$OS" = Darwin ] && echo launchd || echo systemd)"
elif [ "$ENABLE_SUPERVISION" = 1 ]; then
  printf '  services:    units written but NOT enabled (staging/dry-run)\n'
else
  printf '  services:    skipped (--no-supervision)\n'
fi
