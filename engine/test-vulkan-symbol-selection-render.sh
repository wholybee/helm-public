#!/usr/bin/env bash
#
# CHART-7 flagged Forge-package render smoke.
#
# This is the dependency-free proof path for the Forge clean-room symbol package
# renderer fixture. It does not enable the Forge path as a production default.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
CXX="${CXX:-c++}"
TMP="${TMPDIR:-/tmp}/helm-vulkan-symbol-selection-render.$$"
FIXTURE="$HERE/test/fixtures/vulkan-render/symbol-selection"

cleanup() {
  rm -rf "$TMP"
}
trap cleanup EXIT

mkdir -p "$TMP/bin"

"$CXX" -std=c++17 -O2 -Wall -Wextra -pedantic \
  "$HERE/vendor/cli/helm_vulkan_fixture_check.cpp" \
  -o "$TMP/bin/helm-vulkan-fixture-check"

"$TMP/bin/helm-vulkan-fixture-check" "$FIXTURE"
"$HERE/test-symbol-selection-db-conformance.sh"
"$REPO/scripts/vulkan-render-fixture" "$FIXTURE" --check

day="$("$REPO/scripts/vulkan-render-fixture" "$FIXTURE" --palette day --print-hash)"
dusk="$("$REPO/scripts/vulkan-render-fixture" "$FIXTURE" --palette dusk --print-hash)"
night="$("$REPO/scripts/vulkan-render-fixture" "$FIXTURE" --palette night --print-hash)"

[ "$day" = "06d3f9454ddb88d01b77cafc7e8e5c0d648eec7bbddb56483b295df9c4006d04" ]
[ "$dusk" = "f4996c2c08a35bb735a8e095eaa21355ee9f38d646e900e724e3f6d98ea42d67" ]
[ "$night" = "81ad72fe45eb0a89c189d3f742200dbecd00c7987bdddd3b928df1a5cbfbe3fa" ]

echo "ok test-vulkan-symbol-selection-render: flagged Forge package fixture renders day/dusk/night and remains diagnostic-only"
