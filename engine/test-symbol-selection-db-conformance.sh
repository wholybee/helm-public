#!/usr/bin/env bash
#
# Fail-fast conformance check tying the synthetic symbol-selection render
# fixture back to the Forge runtime DB contract and runtime evidence snapshot.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"

python3 - "$REPO" <<'PY'
import hashlib
import json
import sqlite3
import sys
from pathlib import Path

repo = Path(sys.argv[1])

fixture_path = repo / "engine/test/fixtures/symbol-selection/fixtures.json"
render_dir = repo / "engine/test/fixtures/vulkan-render/symbol-selection"
manifest_path = render_dir / "manifest.json"
source_path = render_dir / "source.json"
scene_path = render_dir / "scene.commands.json"
provenance_path = render_dir / "provenance.json"
db_path = repo / "artifacts/opencpn_s52_portrayal.sqlite"
snapshot_path = repo / "pipeline/iconforge/catalog/runtime_evidence_snapshot.json"


def fail(message):
    raise SystemExit(f"FAIL symbol-selection-db-conformance: {message}")


def load_json(path):
    with path.open() as handle:
        return json.load(handle)


def sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def require_equal(label, got, expected):
    if got != expected:
        fail(f"{label} mismatch: got {got!r}, expected {expected!r}")


def flatten_commands(scene):
    out = []
    for group in scene.get("command_groups", []):
        out.extend(group.get("commands", []))
    return out


fixtures = load_json(fixture_path)
manifest = load_json(manifest_path)
source = load_json(source_path)
scene = load_json(scene_path)
provenance = load_json(provenance_path)
snapshot = load_json(snapshot_path)

contract = manifest.get("forge_contract", {})
require_equal("runtime DB path", contract.get("runtime_db"), "artifacts/opencpn_s52_portrayal.sqlite")
require_equal(
    "runtime evidence snapshot path",
    contract.get("runtime_evidence_snapshot"),
    "pipeline/iconforge/catalog/runtime_evidence_snapshot.json",
)
require_equal("runtime DB sha256", contract.get("runtime_db_sha256"), sha256(db_path))
require_equal(
    "runtime evidence snapshot sha256",
    contract.get("runtime_evidence_snapshot_sha256"),
    sha256(snapshot_path),
)
require_equal(
    "symbol-selection fixture sha256",
    contract.get("symbol_selection_fixtures_sha256"),
    sha256(fixture_path),
)

fixture_rows = {row["id"]: row for row in fixtures.get("fixtures", [])}
source_rows = {
    obj["source_object_id"].removeprefix("fixture."): obj
    for chart in source.get("charts", [])
    for obj in chart.get("objects", [])
}
scene_rows = {
    cmd["symbol_selection"]["fixture_id"]: cmd
    for cmd in flatten_commands(scene)
    if cmd.get("type") == "place_symbol" and "symbol_selection" in cmd
}
provenance_rows = {
    row["source_object_id"].removeprefix("fixture."): row
    for row in provenance.get("provenance_table", [])
}
snapshot_rows = {
    (int(row["row_id"]), row["row_key"]): row
    for row in snapshot.get("rows", [])
}

expected_ids = manifest.get("semantic_assertions", {}).get("expected_fixture_ids", [])
require_equal("fixture id count", len(expected_ids), 7)

con = sqlite3.connect(db_path)
con.row_factory = sqlite3.Row

for fixture_id in expected_ids:
    fixture = fixture_rows.get(fixture_id)
    if fixture is None:
        fail(f"{fixture_id} missing from fixture manifest")
    source_obj = source_rows.get(fixture_id)
    if source_obj is None:
        fail(f"{fixture_id} missing from render source")
    command = scene_rows.get(fixture_id)
    if command is None:
        fail(f"{fixture_id} missing from render scene")
    provenance_row = provenance_rows.get(fixture_id)
    if provenance_row is None:
        fail(f"{fixture_id} missing from render provenance")

    expected = fixture.get("expected", {})
    db_contract = fixture.get("db_contract", {})
    if not db_contract:
        fail(f"{fixture_id} missing db_contract")
    lookup_id = int(db_contract["s52_lookup_id"])
    row_key = db_contract["row_key"]
    helm_catalog_id = db_contract["helm_catalog_id"]
    symbol_id = expected["symbol_id"]
    object_class = fixture["source"].get("normalized_object_class") or fixture["source"]["s57_object_class"]

    for label, holder in (
        ("source", source_obj.get("db_contract", {})),
        ("scene", command.get("symbol_selection", {})),
        ("provenance", provenance_row),
    ):
        require_equal(f"{fixture_id} {label} s52_lookup_id", holder.get("s52_lookup_id"), lookup_id)
        require_equal(f"{fixture_id} {label} row_key", holder.get("row_key"), row_key)
        require_equal(f"{fixture_id} {label} helm_catalog_id", holder.get("helm_catalog_id"), helm_catalog_id)

    scene_sel = command["symbol_selection"]
    require_equal(f"{fixture_id} scene symbol_id", scene_sel["symbol_id"], symbol_id)
    require_equal(f"{fixture_id} scene object_class", scene_sel["object_class"], object_class)
    require_equal(f"{fixture_id} scene runtime_eligible", scene_sel["runtime_eligible"], False)

    db_row = con.execute(
        """
        SELECT s52_lookup_id, row_key, object_class, s52_symbol_id,
               candidate_status, runtime_eligible, blocking_gate_count,
               pending_gate_count, warning_gate_count
        FROM runtime_symbol_candidate_v1
        WHERE s52_lookup_id = ?
        """,
        (lookup_id,),
    ).fetchone()
    if db_row is None:
        fail(f"{fixture_id} missing runtime_symbol_candidate_v1 row {lookup_id}")
    require_equal(f"{fixture_id} DB row_key", db_row["row_key"], row_key)
    require_equal(f"{fixture_id} DB symbol_id", db_row["s52_symbol_id"], symbol_id)
    require_equal(f"{fixture_id} DB object_class", db_row["object_class"], object_class)
    require_equal(f"{fixture_id} DB runtime_eligible", db_row["runtime_eligible"], 0)
    if db_row["candidate_status"] == "runtime_eligible":
        fail(f"{fixture_id} DB row is runtime_eligible before visual/runtime gates")
    if db_row["pending_gate_count"] + db_row["blocking_gate_count"] <= 0:
        fail(f"{fixture_id} DB row has no blocking or pending gate")

    portrayal_count = con.execute(
        "SELECT COUNT(*) FROM runtime_symbol_portrayal_v1 WHERE s52_lookup_id = ?",
        (lookup_id,),
    ).fetchone()[0]
    require_equal(f"{fixture_id} default portrayal row count", portrayal_count, 0)

    snapshot_row = snapshot_rows.get((lookup_id, row_key))
    if snapshot_row is None:
        fail(f"{fixture_id} missing runtime evidence snapshot row {lookup_id}/{row_key}")
    require_equal(f"{fixture_id} snapshot helm_catalog_id", snapshot_row["helm_catalog_id"], helm_catalog_id)
    require_equal(f"{fixture_id} snapshot symbol_id", snapshot_row["symbol_id"], symbol_id)
    require_equal(f"{fixture_id} snapshot object_class", snapshot_row["s57"]["object_class"], object_class)
    require_equal(f"{fixture_id} snapshot runtime_state", snapshot_row["runtime_state"], "runtime_blocked")
    require_equal(f"{fixture_id} snapshot runtime_eligible_db", snapshot_row["runtime_eligible_db"], False)
    require_equal(f"{fixture_id} snapshot fail_closed", snapshot_row["fail_closed"], True)
    require_equal(f"{fixture_id} snapshot mapping_type", snapshot_row["s101"]["mapping_type"], expected["s101_mapping_type"])
    require_equal(f"{fixture_id} snapshot crosswalk", snapshot_row["s101"]["crosswalk_class"], expected["s101_crosswalk_class"])
    require_equal(f"{fixture_id} snapshot feature_type", snapshot_row["s101"].get("feature_type") or "", expected["s101_feature_type"])
    require_equal(f"{fixture_id} snapshot rule_file", snapshot_row["s101"].get("rule_file") or "", expected["s101_rule_file"])

con.close()

print(
    f"ok symbol-selection-db-conformance: {len(expected_ids)} fixtures pinned to "
    "runtime DB rows, runtime snapshot rows, and fail-closed default portrayal"
)
PY
