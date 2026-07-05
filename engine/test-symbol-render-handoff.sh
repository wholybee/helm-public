#!/usr/bin/env bash
#
# Dependency-free smoke for ADAPTER-1 shared symbol render handoff.
# It proves OpenCPN-native and Helm/offscreen callers receive the same C++
# resolver result and the handoff preserves source-to-render trace fields.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CXX="${CXX:-c++}"
TMP="${TMPDIR:-/tmp}/helm-symbol-render-handoff.$$"

cleanup() {
  rm -rf "$TMP"
}
trap cleanup EXIT

mkdir -p "$TMP/bin" "$TMP/data"

cat >"$TMP/data/runtime_evidence_snapshot.json" <<'JSON'
{
  "policy": {},
  "rows": [
    {
      "authority_source_evidence": [],
      "authority_trace": {"gate_status": "pass", "reason_codes": [], "runtime_blocker": false},
      "blocker_categories": {},
      "candidate_status": "runtime_eligible",
      "fail_closed": false,
      "helm_catalog_id": "TESTOBJ_ACCEPT_CHART_1",
      "remediation_hints": [],
      "row_id": 1,
      "row_key": "TESTOBJ_ACCEPT_CHART_1_1_1",
      "runtime_effects": {},
      "runtime_eligible_db": true,
      "runtime_gate_reason_codes": [],
      "runtime_record": {},
      "runtime_state": "runtime_eligible",
      "s101": {
        "crosswalk_class": "s101_feature_equivalent",
        "feature_type": "SyntheticFeature",
        "mapping_type": "direct_asset_match",
        "rule_file": "PortrayalCatalog/Rules/SyntheticFeature.lua"
      },
      "s52": {"ast_status": "parsed", "instruction": "SY(ACCEPT_CHART)"},
      "s57": {"geometry": "point", "object_class": "TESTOBJ"},
      "source_layers": [],
      "symbol_id": "ACCEPT_CHART"
    },
    {
      "authority_source_evidence": [],
      "authority_trace": {"gate_status": "blocked", "reason_codes": [], "runtime_blocker": true},
      "blocker_categories": {},
      "candidate_status": "needs_review",
      "fail_closed": false,
      "helm_catalog_id": "TESTOBJ_PENDING_CHART_2",
      "remediation_hints": [],
      "row_id": 2,
      "row_key": "TESTOBJ_PENDING_CHART_2_1_1",
      "runtime_effects": {},
      "runtime_eligible_db": true,
      "runtime_gate_reason_codes": [],
      "runtime_record": {},
      "runtime_state": "runtime_eligible",
      "s101": {
        "crosswalk_class": "s101_feature_equivalent",
        "feature_type": "SyntheticFeature",
        "mapping_type": "direct_asset_match",
        "rule_file": "PortrayalCatalog/Rules/SyntheticFeature.lua"
      },
      "s52": {"ast_status": "parsed", "instruction": "SY(PENDING_CHART)"},
      "s57": {"geometry": "point", "object_class": "TESTOBJ"},
      "source_layers": [],
      "symbol_id": "PENDING_CHART"
    }
  ],
  "schema": "helm.iconforge.runtime_evidence_snapshot.v1",
  "source": {"fixture": "ADAPTER-1 symbol render handoff"},
  "status": "snapshot_ready",
  "summary": {
    "hard_pile_rows": 0,
    "matches_runtime_promotion_gate": true,
    "runtime_rows": 1,
    "snapshot_rows": 2,
    "warning_only_rows": 1
  }
}
JSON

cat >"$TMP/data/proof_manifest.json" <<'JSON'
{
  "approval_workflow": {
    "approved_runtime_rule": "only accepted and final_approved rows are chartplotter-eligible"
  },
  "schema": "helm.symbol.cleanroom-package.v1",
  "source_boundary": {
    "publish_gate": "only accepted/final_approved rows may become runtime defaults"
  },
  "status": "synthetic_adapter_fixture",
  "symbols": [
    {
      "chartplotter_runtime": {"eligible": true, "reason": "synthetic adapter fixture"},
      "clean_room_boundary": {
        "comparison_refs_only": true,
        "generated_owned_candidate": true,
        "third_party_artwork_not_source": true
      },
      "family": "adapter_fixture",
      "generated_assets": {
        "canonical_svg": "assets/svg/adapter/ACCEPT_CHART.svg",
        "origin": "generated-owned-artwork",
        "palette_resolved_svg": {
          "day": "svg-day/ACCEPT_CHART.svg",
          "dusk": "svg-dusk/ACCEPT_CHART.svg",
          "night": "svg-night/ACCEPT_CHART.svg"
        }
      },
      "kind": "symbol",
      "name": "Accepted chart symbol",
      "qa": {
        "candidate_qa": {"final_approved": true, "semantic_pass": true, "visual_parity": "pass"},
        "candidate_status": "accepted",
        "final_approved": true
      },
      "standards_mappings": {
        "object_class": "TESTOBJ",
        "s101_crosswalk_classification": {
          "class": "s101_feature_equivalent",
          "requires_manual_crosswalk": false,
          "runtime_scope": "chart_portrayal"
        },
        "s101_mapping_type": "direct_asset_match",
        "s101_resolver_status": "resolved_direct",
        "s52_symbol_id": "ACCEPT_CHART",
        "unresolved_reasons": []
      },
      "status": "accepted",
      "status_reasons": [],
      "symbol_id": "ACCEPT_CHART"
    },
    {
      "chartplotter_runtime": {"eligible": false, "reason": "pending review"},
      "clean_room_boundary": {
        "comparison_refs_only": true,
        "generated_owned_candidate": true,
        "third_party_artwork_not_source": true
      },
      "family": "adapter_fixture",
      "kind": "symbol",
      "name": "Pending chart symbol",
      "qa": {
        "candidate_qa": {"final_approved": false, "semantic_pass": false, "visual_parity": "needs_review"},
        "candidate_status": "needs_review",
        "final_approved": false
      },
      "standards_mappings": {
        "object_class": "TESTOBJ",
        "s101_crosswalk_classification": {
          "class": "s101_feature_equivalent",
          "requires_manual_crosswalk": false,
          "runtime_scope": "chart_portrayal"
        },
        "s101_mapping_type": "direct_asset_match",
        "s101_resolver_status": "resolved_direct",
        "s52_symbol_id": "PENDING_CHART",
        "unresolved_reasons": []
      },
      "status": "needs_review",
      "status_reasons": ["synthetic pending row"],
      "symbol_id": "PENDING_CHART"
    }
  ]
}
JSON

"$CXX" -std=c++17 -Wall -Wextra -pedantic \
  -I "$HERE/vendor/cli" \
  "$HERE/vendor/cli/helm_symbol_package.cpp" \
  "$HERE/vendor/cli/helm_symbol_render_handoff.cpp" \
  "$HERE/vendor/cli/helm_symbol_render_handoff_smoke.cpp" \
  -o "$TMP/bin/helm-symbol-render-handoff-smoke"

"$TMP/bin/helm-symbol-render-handoff-smoke" \
  "$TMP/data/runtime_evidence_snapshot.json" \
  "$TMP/data/proof_manifest.json"

echo "ok test-symbol-render-handoff: shared C++ adapter handoff and diagnostics verified"
