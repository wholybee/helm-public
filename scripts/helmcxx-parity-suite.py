#!/usr/bin/env python3
"""Validate and optionally run the HELMC++-2 parity suite.

Default mode is intentionally cheap for CI: prove the checked-in parity matrix
matches the runtime inventory and covers every HELMC++-2 acceptance surface.
Use --run-contracts on a machine with private C++ binaries to run the concrete
service tests. Missing binary environment variables skip contract commands unless
--strict-contract-env is passed.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Any


DEFAULT_SUITE = Path("docs/helmcxx-parity-suite.json")
DEFAULT_INVENTORY = Path("docs/runtime-inventory.json")
REQUIRED_SCHEMA = "helm.helmcxx_parity_suite.v1"


def as_list(value: Any) -> list[Any]:
    return value if isinstance(value, list) else []


def load_json(path: Path) -> dict[str, Any]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise ValueError(f"{path}: invalid JSON: {exc}") from exc
    if not isinstance(data, dict):
        raise ValueError(f"{path}: expected a JSON object")
    return data


def command_paths(command: list[str]) -> list[str]:
    paths: list[str] = []
    for token in command[1:]:
        if token.startswith("-"):
            continue
        if "/" in token and not token.startswith("$"):
            paths.append(token)
    return paths


def env_available(command: dict[str, Any]) -> tuple[bool, str]:
    required = [str(x) for x in as_list(command.get("requires_env"))]
    any_required = [str(x) for x in as_list(command.get("requires_any_env"))]
    missing = [name for name in required if not os.environ.get(name)]
    if missing:
        return False, "missing env: " + ", ".join(missing)
    if any_required and not any(os.environ.get(name) for name in any_required):
        return False, "missing one of env: " + ", ".join(any_required)
    return True, ""


def validate_suite(repo_root: Path, suite: dict[str, Any], inventory: dict[str, Any]) -> list[str]:
    errors: list[str] = []

    if suite.get("schema") != REQUIRED_SCHEMA:
        errors.append(f"suite: schema must be {REQUIRED_SCHEMA}")

    required_surfaces = {str(x) for x in as_list(suite.get("required_surfaces"))}
    if not required_surfaces:
        errors.append("suite: required_surfaces must be non-empty")

    inventory_entries = {
        str(entry.get("id")): entry
        for entry in as_list(inventory.get("entries"))
        if isinstance(entry, dict) and entry.get("id")
    }

    services = [svc for svc in as_list(suite.get("services")) if isinstance(svc, dict)]
    if not services:
        errors.append("suite: services must be non-empty")

    covered_by_any: set[str] = set()
    service_entry_ids: set[str] = set()

    for service in services:
        service_id = str(service.get("id", "<missing-service-id>"))
        inv_id = str(service.get("runtime_inventory_entry", ""))
        service_entry_ids.add(inv_id)
        inv = inventory_entries.get(inv_id)
        if not inv:
            errors.append(f"{service_id}: runtime_inventory_entry {inv_id!r} not found")
        elif inv.get("classification") != "required-runtime":
            errors.append(f"{service_id}: runtime inventory entry must be required-runtime")
        elif inv.get("status") == "implemented" and inv.get("starts_python_daemon"):
            errors.append(f"{service_id}: implemented required runtime starts Python")

        coverage = service.get("coverage")
        if not isinstance(coverage, dict) or not coverage:
            errors.append(f"{service_id}: coverage must be a non-empty object")
            coverage = {}
        for surface, evidence in coverage.items():
            surface_name = str(surface)
            covered_by_any.add(surface_name)
            if surface_name not in required_surfaces:
                errors.append(f"{service_id}: unknown coverage surface {surface_name!r}")
            if not as_list(evidence):
                errors.append(f"{service_id}: surface {surface_name} must list evidence")
            for path in as_list(evidence):
                if not (repo_root / str(path)).exists():
                    errors.append(f"{service_id}: evidence path missing: {path}")

        commands = [cmd for cmd in as_list(service.get("commands")) if isinstance(cmd, dict)]
        if not commands:
            errors.append(f"{service_id}: commands must be non-empty")
        for command in commands:
            command_id = str(command.get("id", "<missing-command-id>"))
            cmd_tokens = [str(x) for x in as_list(command.get("command"))]
            if len(cmd_tokens) < 2:
                errors.append(f"{service_id}/{command_id}: command must include interpreter and path")
            for path in command_paths(cmd_tokens):
                if not (repo_root / path).exists():
                    errors.append(f"{service_id}/{command_id}: command path missing: {path}")
            for surface in [str(x) for x in as_list(command.get("proves"))]:
                if surface not in required_surfaces:
                    errors.append(f"{service_id}/{command_id}: proves unknown surface {surface!r}")

    missing_surfaces = sorted(required_surfaces - covered_by_any)
    for surface in missing_surfaces:
        errors.append(f"suite: required surface has no service coverage: {surface}")

    final_required = [
        entry for entry in inventory_entries.values()
        if entry.get("classification") == "required-runtime"
        and (entry.get("status") == "implemented" or entry.get("final_acceptance_required"))
    ]
    for entry in final_required:
        if entry.get("id") not in service_entry_ids:
            errors.append(f"suite: required runtime entry missing from services: {entry.get('id')}")

    python_paths = [p for p in as_list(suite.get("python_paths")) if isinstance(p, dict)]
    python_inventory_ids = {
        str(entry.get("id"))
        for entry in inventory_entries.values()
        if entry.get("starts_python_daemon")
        or "python" in str(entry.get("language", "")).lower()
        or "fastapi" in str(entry.get("language", "")).lower()
    }
    classified_python = {str(item.get("inventory_entry")) for item in python_paths}
    for missing in sorted(python_inventory_ids - classified_python):
        errors.append(f"suite: Python surface lacks HELMC++-2 role classification: {missing}")

    allowed_roles = {
        "oracle-only",
        "optional-non-safety",
        "offline-bake",
        "dev-only",
        "fixture/test",
        "dev-operator-hybrid-only",
    }
    for item in python_paths:
        inv_id = str(item.get("inventory_entry", ""))
        role = str(item.get("HELMCXX_2_role", ""))
        if inv_id not in inventory_entries:
            errors.append(f"python_paths: inventory entry missing: {inv_id}")
        if role not in allowed_roles:
            errors.append(f"python_paths/{inv_id}: invalid HELMCXX_2_role {role!r}")
        if not item.get("removal_status"):
            errors.append(f"python_paths/{inv_id}: removal_status is required")
        path = str(item.get("path", ""))
        if path and not (repo_root / path).exists():
            errors.append(f"python_paths/{inv_id}: path missing: {path}")

    return errors


def run_contracts(repo_root: Path, suite: dict[str, Any], strict_env: bool) -> tuple[int, list[dict[str, Any]]]:
    results: list[dict[str, Any]] = []
    failures = 0
    for service in as_list(suite.get("services")):
        if not isinstance(service, dict):
            continue
        service_id = str(service.get("id", "<missing-service-id>"))
        for command in as_list(service.get("commands")):
            if not isinstance(command, dict):
                continue
            command_id = str(command.get("id", "<missing-command-id>"))
            cmd_tokens = [str(x) for x in as_list(command.get("command"))]
            available, reason = env_available(command)
            if not available and not command.get("oracle_only"):
                status = "fail" if strict_env else "skip"
                if strict_env:
                    failures += 1
                results.append({"service": service_id, "command": command_id, "status": status, "reason": reason})
                continue

            proc = subprocess.run(
                cmd_tokens,
                cwd=str(repo_root),
                text=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
            )
            if proc.returncode == 0:
                results.append({"service": service_id, "command": command_id, "status": "pass"})
            else:
                failures += 1
                results.append(
                    {
                        "service": service_id,
                        "command": command_id,
                        "status": "fail",
                        "returncode": proc.returncode,
                        "output_tail": proc.stdout[-4000:],
                    }
                )
    return failures, results


def print_matrix(suite: dict[str, Any]) -> None:
    print("HELMC++ parity suite")
    for service in as_list(suite.get("services")):
        if not isinstance(service, dict):
            continue
        print(f"- {service.get('id')}: {service.get('role')}")
        coverage = service.get("coverage", {})
        if isinstance(coverage, dict):
            for surface in sorted(coverage):
                print(f"    {surface}: {', '.join(str(x) for x in as_list(coverage[surface]))}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--suite", default=str(DEFAULT_SUITE), help="path to HELMC++ parity suite JSON")
    parser.add_argument("--inventory", default=str(DEFAULT_INVENTORY), help="path to runtime inventory JSON")
    parser.add_argument("--json", action="store_true", help="print JSON result")
    parser.add_argument("--list", action="store_true", help="print the service/surface matrix")
    parser.add_argument("--run-contracts", action="store_true", help="run contract commands after static validation")
    parser.add_argument(
        "--strict-contract-env",
        action="store_true",
        help="fail instead of skip when C++ binary env vars are missing in --run-contracts mode",
    )
    args = parser.parse_args()

    repo_root = Path.cwd()
    suite_path = repo_root / args.suite
    inventory_path = repo_root / args.inventory

    try:
        suite = load_json(suite_path)
        inventory = load_json(inventory_path)
    except ValueError as exc:
        print(str(exc), file=sys.stderr)
        return 2

    errors = validate_suite(repo_root, suite, inventory)
    if args.list:
        print_matrix(suite)

    contract_results: list[dict[str, Any]] = []
    contract_failures = 0
    if not errors and args.run_contracts:
        contract_failures, contract_results = run_contracts(repo_root, suite, args.strict_contract_env)

    ok = not errors and contract_failures == 0
    if args.json:
        print(
            json.dumps(
                {
                    "ok": ok,
                    "errors": errors,
                    "contract_results": contract_results,
                    "suite": str(suite_path),
                    "inventory": str(inventory_path),
                },
                indent=2,
                sort_keys=True,
            )
        )
    elif ok:
        print("HELMC++ parity suite: PASS")
        print(f"  services: {len(as_list(suite.get('services')))}")
        print(f"  required surfaces: {len(as_list(suite.get('required_surfaces')))}")
        if args.run_contracts:
            passed = sum(1 for result in contract_results if result.get("status") == "pass")
            skipped = sum(1 for result in contract_results if result.get("status") == "skip")
            print(f"  contract commands passed: {passed}")
            print(f"  contract commands skipped: {skipped}")
    else:
        print("HELMC++ parity suite: FAIL", file=sys.stderr)
        for error in errors:
            print(f"  - {error}", file=sys.stderr)
        for result in contract_results:
            if result.get("status") == "fail":
                print(f"  - {result['service']}/{result['command']}: contract failed", file=sys.stderr)
                if result.get("output_tail"):
                    print(str(result["output_tail"]), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
