#!/usr/bin/env bash
#
# BUG-1: validate every manifest under vulkan-render, including inspection-trace.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CXX="${CXX:-c++}"
TMP="${TMPDIR:-/tmp}/helm-vulkan-fixture-check.$$"
FIXTURE_ROOT="$HERE/test/fixtures/vulkan-render"

cleanup() {
  rm -rf "$TMP"
}
trap cleanup EXIT

mkdir -p "$TMP/bin"

"$CXX" -std=c++11 -O2 -Wall -Wextra -pedantic \
  "$HERE/vendor/cli/helm_vulkan_fixture_check.cpp" \
  -o "$TMP/bin/helm-vulkan-fixture-check"

"$TMP/bin/helm-vulkan-fixture-check" "$FIXTURE_ROOT"

echo "ok test-vulkan-fixture-check: all manifests under $FIXTURE_ROOT validated"
