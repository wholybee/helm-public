#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OCPN_DIR="${HELM_OCPN_DIR:-/tmp/helm-opencpn}"
BIN="${HELM_ENVD_BIN:-$OCPN_DIR/build/cli/helm-envd}"

if [[ ! -x "$BIN" ]]; then
  echo "helm-envd binary is missing or not executable: $BIN" >&2
  echo "Set HELM_ENVD_BIN=/path/to/private/build/cli/helm-envd or run engine/bootstrap.sh in a private build." >&2
  exit 1
fi

HELM_ENVD_BIN="$BIN" python3 "$ROOT/pipeline/test_helm_envd_contract.py"
