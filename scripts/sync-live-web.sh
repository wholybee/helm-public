#!/usr/bin/env bash
# Deploy repo web/ to the live helm-server web root (~/.helm/live/web on :8080).
# Does not restart helm-server or touch the listening port.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LIVE="${HELM_LIVE_WEB:-$HOME/.helm/live/web}"
BACKUP="${HELM_LIVE_WEB_BACKUP:-$HOME/.helm/live/web.backup-$(date +%Y%m%d%H%M%S)}"

die() { echo "sync-live-web: $*" >&2; exit 1; }
[ -d "$ROOT/web" ] || die "repo web/ missing: $ROOT/web"
[ -d "$(dirname "$LIVE")" ] || die "live web parent missing: $(dirname "$LIVE")"

if [ -d "$LIVE" ]; then
  echo "sync-live-web: backing up $LIVE -> $BACKUP"
  cp -a "$LIVE" "$BACKUP"
else
  mkdir -p "$LIVE"
fi

echo "sync-live-web: rsync $ROOT/web/ -> $LIVE/"
rsync -a \
  --exclude '.DS_Store' \
  --exclude 'node_modules/' \
  "$ROOT/web/" "$LIVE/"

echo "sync-live-web: done"
echo "  Live cockpit: hard-refresh http://127.0.0.1:8080/ (Cmd+Shift+R)"
echo "  PNG default:  normal load"
echo "  WebGPU on:    ?chartWebgpu=1  or Settings -> WebGPU nautical renderer"
echo "  Real harbour: ?cell=us5ga2bc&chartWebgpu=1  (US5GA2BC artifact, auto-fits cell bbox)"
