#!/usr/bin/env bash
#
# Dependency-free smoke for CHART-9 runtime eligibility semantics.
# It proves the C++ symbol package loader only exposes accepted/final-approved
# chart rows through default lookup, while approved non-chart scopes require an
# explicit scope lookup and all pending/rejected/fail-closed rows stay diagnostic.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CXX="${CXX:-c++}"
TMP="${TMPDIR:-/tmp}/helm-symbol-runtime-gate.$$"

cleanup() {
  rm -rf "$TMP"
}
trap cleanup EXIT

mkdir -p "$TMP/bin" "$TMP/data"

python3 - "$TMP/data" <<'PY'
import json
import sys
from pathlib import Path

out = Path(sys.argv[1])


def row(symbol_id, row_id, runtime_state="runtime_eligible",
        candidate_status="runtime_eligible", runtime_eligible_db=True,
        fail_closed=False, object_class="TESTOBJ",
        mapping_type="direct_asset_match",
        crosswalk_class="s101_feature_equivalent",
        feature_type="SyntheticFeature",
        rule_file="PortrayalCatalog/Rules/SyntheticFeature.lua"):
    return {
        "authority_source_evidence": [],
        "authority_trace": {
            "gate_status": "pass" if runtime_eligible_db and not fail_closed else "blocked",
            "reason_codes": [],
            "runtime_blocker": not runtime_eligible_db or fail_closed,
        },
        "blocker_categories": {},
        "candidate_status": candidate_status,
        "fail_closed": fail_closed,
        "helm_catalog_id": f"{object_class}_{symbol_id}_{row_id}",
        "remediation_hints": [],
        "row_id": row_id,
        "row_key": f"{object_class}_{symbol_id}_{row_id}_1_1",
        "runtime_effects": {},
        "runtime_eligible_db": runtime_eligible_db,
        "runtime_gate_reason_codes": [],
        "runtime_record": {},
        "runtime_state": runtime_state,
        "s101": {
            "crosswalk_class": crosswalk_class,
            "feature_type": feature_type,
            "mapping_type": mapping_type,
            "rule_file": rule_file,
        },
        "s52": {
            "ast_status": "parsed",
            "instruction": f"SY({symbol_id})",
        },
        "s57": {
            "geometry": "point",
            "object_class": object_class,
        },
        "source_layers": [],
        "symbol_id": symbol_id,
    }


def proof(symbol_id, status="accepted", final_approved=True,
          chartplotter_eligible=True, runtime_scope="chart_portrayal",
          crosswalk_class="s101_feature_equivalent"):
    return {
        "chartplotter_runtime": {
            "eligible": chartplotter_eligible,
            "reason": "synthetic runtime gate fixture",
        },
        "clean_room_boundary": {
            "comparison_refs_only": True,
            "generated_owned_candidate": True,
            "third_party_artwork_not_source": True,
        },
        "family": "runtime_gate_fixture",
        "generated_assets": {
            "canonical_svg": f"assets/svg/runtime_gate/{symbol_id}.svg",
            "origin": "generated-owned-artwork",
            "palette_resolved_svg": {
                "day": f"svg-day/{symbol_id}.svg",
                "dusk": f"svg-dusk/{symbol_id}.svg",
                "night": f"svg-night/{symbol_id}.svg",
            },
        },
        "kind": "symbol",
        "name": symbol_id,
        "qa": {
            "candidate_qa": {
                "final_approved": final_approved,
                "semantic_pass": final_approved,
                "visual_parity": "pass" if final_approved else "needs_review",
            },
            "candidate_status": "accepted" if final_approved else "needs_review",
            "final_approved": final_approved,
        },
        "standards_mappings": {
            "object_class": "TESTOBJ",
            "s101_crosswalk_classification": {
                "class": crosswalk_class,
                "requires_manual_crosswalk": runtime_scope != "chart_portrayal",
                "runtime_scope": runtime_scope,
            },
            "s101_mapping_type": "direct_asset_match",
            "s101_resolver_status": "resolved_direct",
            "s52_symbol_id": symbol_id,
            "unresolved_reasons": [],
        },
        "status": status,
        "status_reasons": [],
        "symbol_id": symbol_id,
    }


rows = [
    row("ACCEPT_CHART", 1),
    row("PENDING_CHART", 2),
    row("REJECTED_CHART", 3),
    row("FAIL_CLOSED", 4, fail_closed=True),
    row("MISSING_PROOF", 5),
    row(
        "ACCEPT_OVERLAY",
        6,
        object_class="$CSYMB",
        mapping_type="unresolved",
        crosswalk_class="non_s101_runtime_construct",
        feature_type="",
        rule_file="",
    ),
    row(
        "ACCEPT_EXTENSION",
        7,
        object_class="CHKPNT",
        mapping_type="unresolved",
        crosswalk_class="non_s101_or_inland_extension",
        feature_type="",
        rule_file="",
    ),
]

snapshot = {
    "policy": {},
    "rows": rows,
    "schema": "helm.iconforge.runtime_evidence_snapshot.v1",
    "source": {"fixture": "CHART-9 synthetic runtime gate"},
    "status": "snapshot_ready",
    "summary": {
        "hard_pile_rows": 4,
        "matches_runtime_promotion_gate": True,
        "runtime_rows": 3,
        "snapshot_rows": len(rows),
        "warning_only_rows": 0,
    },
}

manifest = {
    "approval_workflow": {
        "approved_runtime_rule": "only accepted and final_approved rows are chartplotter-eligible",
    },
    "schema": "helm.symbol.cleanroom-package.v1",
    "source_boundary": {
        "publish_gate": "only accepted/final_approved rows may become runtime defaults",
    },
    "status": "synthetic_runtime_gate_fixture",
    "symbols": [
        proof("ACCEPT_CHART"),
        proof("PENDING_CHART", status="needs_review", final_approved=False, chartplotter_eligible=False),
        proof("REJECTED_CHART", status="rejected", final_approved=False, chartplotter_eligible=False),
        proof("FAIL_CLOSED"),
        proof(
            "ACCEPT_OVERLAY",
            runtime_scope="renderer_overlay_or_ui",
            crosswalk_class="non_s101_runtime_construct",
        ),
        proof(
            "ACCEPT_EXTENSION",
            runtime_scope="extension_profile_or_manual_mapping",
            crosswalk_class="non_s101_or_inland_extension",
        ),
    ],
}

(out / "runtime_evidence_snapshot.json").write_text(json.dumps(snapshot, indent=2, sort_keys=True) + "\n")
(out / "proof_manifest.json").write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n")
PY

"$CXX" -std=c++17 -Wall -Wextra -pedantic \
  -I "$HERE/vendor/cli" \
  "$HERE/vendor/cli/helm_symbol_package.cpp" \
  "$HERE/vendor/cli/helm_symbol_runtime_gate_smoke.cpp" \
  -o "$TMP/bin/helm-symbol-runtime-gate-smoke"

"$TMP/bin/helm-symbol-runtime-gate-smoke" \
  "$TMP/data/runtime_evidence_snapshot.json" \
  "$TMP/data/proof_manifest.json"

echo "ok test-symbol-runtime-gate: accepted/final-approved default gate and explicit scopes verified"
