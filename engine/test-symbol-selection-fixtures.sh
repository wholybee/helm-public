#!/usr/bin/env bash
#
# Dependency-free smoke for CHART-6 symbol selection fixtures. It proves the
# fixture cases match the clean-room runtime evidence package and remain blocked
# from the default render path until approval gates pass.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
CXX="${CXX:-c++}"
TMP="${TMPDIR:-/tmp}/helm-symbol-selection-fixtures.$$"

cleanup() {
  rm -rf "$TMP"
}
trap cleanup EXIT

mkdir -p "$TMP/bin"

"$CXX" -std=c++17 -Wall -Wextra -pedantic \
  -I "$HERE/vendor/cli" \
  "$HERE/vendor/cli/helm_symbol_package.cpp" \
  "$HERE/vendor/cli/helm_symbol_selection_fixtures.cpp" \
  -o "$TMP/bin/helm-symbol-selection-fixtures"

"$TMP/bin/helm-symbol-selection-fixtures" \
  "$REPO/pipeline/iconforge/catalog/runtime_evidence_snapshot.json" \
  "$REPO/pipeline/iconforge/proof/manifest.json"

echo "ok test-symbol-selection-fixtures: attribute fixtures match runtime evidence and stay fail-closed"
