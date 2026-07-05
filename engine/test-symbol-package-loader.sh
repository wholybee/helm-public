#!/usr/bin/env bash
#
# Dependency-free smoke for the CHART-5 C++ symbol package loader. It validates
# the generated FORGE runtime evidence snapshot without requiring OpenCPN,
# Vulkan, wxWidgets, or RapidJSON headers.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
CXX="${CXX:-c++}"
TMP="${TMPDIR:-/tmp}/helm-symbol-package-loader.$$"

cleanup() {
  rm -rf "$TMP"
}
trap cleanup EXIT

mkdir -p "$TMP/bin"

"$CXX" -std=c++17 -Wall -Wextra -pedantic \
  -I "$HERE/vendor/cli" \
  "$HERE/vendor/cli/helm_symbol_package.cpp" \
  "$HERE/vendor/cli/helm_symbol_package_smoke.cpp" \
  -o "$TMP/bin/helm-symbol-package-smoke"

"$TMP/bin/helm-symbol-package-smoke" \
  "$REPO/pipeline/iconforge/catalog/runtime_evidence_snapshot.json" \
  "$REPO/pipeline/iconforge/proof/manifest.json"

echo "ok test-symbol-package-loader: C++ loader preserves runtime evidence and fail-closed filtering"
