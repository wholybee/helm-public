#!/usr/bin/env python3
"""Validate Helm's HELMC++ runtime inventory.

This is intentionally a small stdlib-only guard. It does not prove the C++ port
is complete; it prevents the opposite mistake: silently classifying a Python
daemon as required boat-side runtime.
"""

from __future__ import annotations

import argparse
import ast
import glob
import json
import os
import re
import sys
from pathlib import Path
from typing import Any


DEFAULT_INVENTORY = Path("docs/runtime-inventory.json")
DEFAULT_BACKEND_NEGATIVE_SMOKE_PATH = "backend/new_service.py"
ALLOWED_CLASSIFICATIONS = {
    "required-runtime",
    "transitional-reference",
    "dev-tooling",
    "fixture/test",
    "offline-bake",
    "optional-non-safety",
    "removed",
}
PYTHON_RUNTIME_RE = re.compile(r"\b(python3?|uvicorn|fastapi|FastAPI)\b")


def fail(errors: list[str], entry_id: str, message: str) -> None:
    errors.append(f"{entry_id}: {message}")


def as_bool(value: Any) -> bool:
    return bool(value) if isinstance(value, bool) else False


def as_list(value: Any) -> list[Any]:
    return value if isinstance(value, list) else []


def path_matches(repo_root: Path, pattern: str) -> list[Path]:
    if any(ch in pattern for ch in "*?["):
        return [Path(p) for p in glob.glob(str(repo_root / pattern))]
    p = repo_root / pattern
    return [p] if p.exists() else []


def repo_relative(path: Path, repo_root: Path) -> str:
    return path.relative_to(repo_root).as_posix()


def backend_python_files(repo_root: Path, extra_paths: list[str] | None = None) -> set[str]:
    backend_root = repo_root / "backend"
    paths: set[str] = set()
    if backend_root.exists():
        for path in backend_root.rglob("*.py"):
            rel_parts = path.relative_to(repo_root).parts
            if "__pycache__" in rel_parts or ".venv" in rel_parts:
                continue
            paths.add(repo_relative(path, repo_root))
    for extra_path in extra_paths or []:
        paths.add(extra_path)
    return paths


def validate_backend_path(errors: list[str], context: str, path: Any) -> str | None:
    if not isinstance(path, str) or not path:
        errors.append(f"{context}: path must be a non-empty string")
        return None
    if any(ch in path for ch in "*?["):
        errors.append(f"{context}: backend Python policy paths must be literal, not globs: {path}")
    if not path.startswith("backend/") or not path.endswith(".py"):
        errors.append(f"{context}: backend Python policy path must be backend/**/*.py: {path}")
    if Path(path).is_absolute() or ".." in Path(path).parts:
        errors.append(f"{context}: backend Python policy path must stay inside the repo: {path}")
    return path


def backend_fastapi_routes(repo_root: Path) -> set[str]:
    routes: set[str] = set()
    for rel_path in backend_python_files(repo_root):
        path = repo_root / rel_path
        try:
            tree = ast.parse(path.read_text(encoding="utf-8"), filename=rel_path)
        except SyntaxError:
            continue
        for node in ast.walk(tree):
            if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                continue
            for decorator in node.decorator_list:
                if not isinstance(decorator, ast.Call):
                    continue
                func = decorator.func
                if not isinstance(func, ast.Attribute):
                    continue
                method = func.attr.lower()
                if method not in {"get", "post", "put", "patch", "delete"}:
                    continue
                if not decorator.args:
                    continue
                route_arg = decorator.args[0]
                if isinstance(route_arg, ast.Constant) and isinstance(route_arg.value, str):
                    routes.add(f"{method.upper()} {route_arg.value}")
    return routes


def validate_backend_route(errors: list[str], context: str, route: Any) -> str | None:
    if not isinstance(route, str) or not route:
        errors.append(f"{context}: route must be a non-empty string")
        return None
    parts = route.split(" ", 1)
    if len(parts) != 2 or parts[0] not in {"GET", "POST", "PUT", "PATCH", "DELETE"}:
        errors.append(f"{context}: route must be formatted like 'GET /path': {route}")
        return route
    if not parts[1].startswith("/"):
        errors.append(f"{context}: route path must start with /: {route}")
    return route


def validate_backend_python_policy(
    repo_root: Path,
    data: dict[str, Any],
    errors: list[str],
    extra_backend_python: list[str] | None = None,
) -> None:
    policy = data.get("backend_python_policy")
    if not isinstance(policy, dict):
        errors.append("backend_python_policy: missing policy object")
        return

    if policy.get("mode") != "fail-closed-net-new":
        errors.append("backend_python_policy: mode must be fail-closed-net-new")
    if not policy.get("owner"):
        errors.append("backend_python_policy: owner is required")
    if not policy.get("rationale"):
        errors.append("backend_python_policy: rationale is required")

    baseline_raw = as_list(policy.get("baseline"))
    exceptions_raw = as_list(policy.get("exceptions"))
    route_baseline_raw = as_list(policy.get("route_baseline"))
    route_exceptions_raw = as_list(policy.get("route_exceptions"))
    baseline: set[str] = set()
    exceptions: set[str] = set()
    route_baseline: set[str] = set()
    route_exceptions: set[str] = set()

    for item in baseline_raw:
        path = validate_backend_path(errors, "backend_python_policy.baseline", item)
        if path:
            baseline.add(path)

    for idx, item in enumerate(exceptions_raw):
        context = f"backend_python_policy.exceptions[{idx}]"
        if not isinstance(item, dict):
            errors.append(f"{context}: exception must be an object")
            continue
        path = validate_backend_path(errors, context, item.get("path"))
        if path:
            exceptions.add(path)
        if not item.get("owner"):
            errors.append(f"{context}: owner is required")
        if not item.get("rationale"):
            errors.append(f"{context}: rationale is required")
        if as_bool(item.get("trending_toward_required")) and not item.get("cxx_exit_task"):
            errors.append(f"{context}: trending_toward_required exceptions must name cxx_exit_task")

    for item in route_baseline_raw:
        route = validate_backend_route(errors, "backend_python_policy.route_baseline", item)
        if route:
            route_baseline.add(route)

    for idx, item in enumerate(route_exceptions_raw):
        context = f"backend_python_policy.route_exceptions[{idx}]"
        if not isinstance(item, dict):
            errors.append(f"{context}: exception must be an object")
            continue
        route = validate_backend_route(errors, context, item.get("route"))
        if route:
            route_exceptions.add(route)
        if not item.get("owner"):
            errors.append(f"{context}: owner is required")
        if not item.get("rationale"):
            errors.append(f"{context}: rationale is required")
        if as_bool(item.get("trending_toward_required")) and not item.get("cxx_exit_task"):
            errors.append(f"{context}: trending_toward_required exceptions must name cxx_exit_task")

    overlap = sorted(baseline & exceptions)
    if overlap:
        errors.append(
            "backend_python_policy: paths cannot appear in both baseline and exceptions: "
            + ", ".join(overlap)
        )
    route_overlap = sorted(route_baseline & route_exceptions)
    if route_overlap:
        errors.append(
            "backend_python_policy: routes cannot appear in both route_baseline "
            "and route_exceptions: "
            + ", ".join(route_overlap)
        )

    current = backend_python_files(repo_root, extra_backend_python)
    current_routes = backend_fastapi_routes(repo_root)
    unlisted = sorted(current - baseline - exceptions)
    stale_baseline = sorted(baseline - current)
    stale_exceptions = sorted(exceptions - current)
    unlisted_routes = sorted(current_routes - route_baseline - route_exceptions)
    stale_route_baseline = sorted(route_baseline - current_routes)
    stale_route_exceptions = sorted(route_exceptions - current_routes)

    if unlisted:
        errors.append(
            "backend_python_policy: net-new backend Python needs an explicit inventory "
            "exception with owner+rationale: "
            + ", ".join(unlisted)
        )
    if stale_baseline:
        errors.append(
            "backend_python_policy: baseline lists missing backend Python files: "
            + ", ".join(stale_baseline)
        )
    if stale_exceptions:
        errors.append(
            "backend_python_policy: exceptions list missing backend Python files: "
            + ", ".join(stale_exceptions)
        )
    if unlisted_routes:
        errors.append(
            "backend_python_policy: net-new backend FastAPI routes need an explicit "
            "inventory exception with owner+rationale: "
            + ", ".join(unlisted_routes)
        )
    if stale_route_baseline:
        errors.append(
            "backend_python_policy: route_baseline lists missing backend FastAPI routes: "
            + ", ".join(stale_route_baseline)
        )
    if stale_route_exceptions:
        errors.append(
            "backend_python_policy: route_exceptions list missing backend FastAPI routes: "
            + ", ".join(stale_route_exceptions)
        )


def validate_entry(repo_root: Path, entry: dict[str, Any], errors: list[str]) -> None:
    entry_id = str(entry.get("id", "<missing-id>"))
    classification = entry.get("classification")
    status = entry.get("status")
    language = str(entry.get("language", ""))
    required_runtime = as_bool(entry.get("required_runtime"))
    final_required = as_bool(entry.get("final_acceptance_required"))
    starts_python = as_bool(entry.get("starts_python_daemon"))
    python_allowed = as_bool(entry.get("python_allowed"))
    launch = [str(x) for x in as_list(entry.get("launch"))]
    paths = [str(x) for x in as_list(entry.get("paths"))]

    if not entry.get("id"):
        fail(errors, entry_id, "missing id")
    if classification not in ALLOWED_CLASSIFICATIONS:
        fail(errors, entry_id, f"invalid classification {classification!r}")
    if status not in {"implemented", "planned", "removed"}:
        fail(errors, entry_id, f"invalid status {status!r}")
    if not paths:
        fail(errors, entry_id, "must list at least one path")
    for pattern in paths:
        if not path_matches(repo_root, pattern):
            fail(errors, entry_id, f"path pattern does not match anything: {pattern}")

    launch_text = "\n".join(launch)
    launch_mentions_python = bool(PYTHON_RUNTIME_RE.search(launch_text))
    language_mentions_python = "python" in language.lower() or "fastapi" in language.lower()

    if required_runtime and classification != "required-runtime":
        fail(errors, entry_id, "required_runtime entries must use classification=required-runtime")
    if classification == "required-runtime" and status == "implemented":
        if not required_runtime:
            fail(errors, entry_id, "implemented required-runtime entries must set required_runtime=true")
        if "c++" not in language.lower() and "cpp" not in language.lower():
            fail(errors, entry_id, "implemented required runtime must be C++")
        if starts_python or python_allowed or launch_mentions_python or language_mentions_python:
            fail(errors, entry_id, "required runtime must not launch or allow Python/FastAPI/uvicorn")
    if classification == "required-runtime" and status == "planned":
        if not final_required:
            fail(errors, entry_id, "planned required runtime must set final_acceptance_required=true")
        if not entry.get("cxx_exit_task"):
            fail(errors, entry_id, "planned required runtime must name the C++ exit task")

    python_surface = starts_python or language_mentions_python or launch_mentions_python
    if python_surface:
        if classification == "required-runtime":
            fail(errors, entry_id, "Python/FastAPI/uvicorn surface cannot be required-runtime")
        if not python_allowed:
            fail(errors, entry_id, "Python surface must set python_allowed=true with a reason")
        if not entry.get("allowed_python_reason"):
            fail(errors, entry_id, "Python surface must explain allowed_python_reason")
        if classification == "transitional-reference" and not entry.get("cxx_exit_task"):
            fail(errors, entry_id, "transitional Python reference must name cxx_exit_task")
        if classification == "optional-non-safety" and not as_bool(entry.get("optional_non_safety")):
            fail(errors, entry_id, "optional Python service must set optional_non_safety=true")

    if final_required and classification != "required-runtime":
        fail(errors, entry_id, "final_acceptance_required is only valid for required-runtime entries")
    if classification == "removed" and status != "removed":
        fail(errors, entry_id, "removed classification must use status=removed")
    if not as_list(entry.get("feeds_helmcxx")):
        fail(errors, entry_id, "must list which HELMC++ task(s) consume this entry")


def validate_inventory(
    repo_root: Path,
    inventory_path: Path,
    extra_backend_python: list[str] | None = None,
) -> tuple[list[str], dict[str, Any]]:
    data = json.loads(inventory_path.read_text(encoding="utf-8"))
    errors: list[str] = []

    if data.get("schema") != "helm.runtime_inventory.v1":
        errors.append("inventory: schema must be helm.runtime_inventory.v1")
    declared = set(as_list(data.get("classifications")))
    if declared != ALLOWED_CLASSIFICATIONS:
        errors.append(
            "inventory: classifications must match "
            + ", ".join(sorted(ALLOWED_CLASSIFICATIONS))
        )
    entries = as_list(data.get("entries"))
    if not entries:
        errors.append("inventory: entries must be a non-empty list")

    seen: set[str] = set()
    required_implemented = 0
    python_non_required = 0
    for raw_entry in entries:
        if not isinstance(raw_entry, dict):
            errors.append("inventory: every entry must be an object")
            continue
        entry_id = str(raw_entry.get("id", "<missing-id>"))
        if entry_id in seen:
            errors.append(f"{entry_id}: duplicate id")
        seen.add(entry_id)
        validate_entry(repo_root, raw_entry, errors)
        if raw_entry.get("classification") == "required-runtime" and raw_entry.get("status") == "implemented":
            required_implemented += 1
        if as_bool(raw_entry.get("starts_python_daemon")) and raw_entry.get("classification") != "required-runtime":
            python_non_required += 1

    if required_implemented == 0:
        errors.append("inventory: must include at least one implemented required-runtime entry")
    if python_non_required == 0:
        errors.append("inventory: expected explicit non-required Python classifications")

    validate_backend_python_policy(repo_root, data, errors, extra_backend_python)

    return errors, data


def run_negative_smoke(repo_root: Path, inventory_path: Path) -> int:
    errors, _ = validate_inventory(
        repo_root,
        inventory_path,
        extra_backend_python=[DEFAULT_BACKEND_NEGATIVE_SMOKE_PATH],
    )
    expected = [
        error for error in errors
        if DEFAULT_BACKEND_NEGATIVE_SMOKE_PATH in error
        and "net-new backend Python needs an explicit inventory exception" in error
    ]
    if expected:
        print(
            "HELMC++ runtime inventory negative smoke: PASS "
            f"({DEFAULT_BACKEND_NEGATIVE_SMOKE_PATH} fails closed)"
        )
        return 0
    print("HELMC++ runtime inventory negative smoke: FAIL", file=sys.stderr)
    print(
        f"  expected {DEFAULT_BACKEND_NEGATIVE_SMOKE_PATH} to require an inventory exception",
        file=sys.stderr,
    )
    for error in errors:
        print(f"  - {error}", file=sys.stderr)
    return 1


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--inventory",
        default=str(DEFAULT_INVENTORY),
        help="inventory path relative to the repo root (default: docs/runtime-inventory.json)",
    )
    parser.add_argument(
        "--negative-smoke-backend-python",
        action="store_true",
        help="prove a simulated backend/new_service.py fails without an inventory exception",
    )
    args = parser.parse_args()

    repo_root = Path.cwd()
    inventory_path = repo_root / args.inventory
    if not inventory_path.exists():
        print(f"runtime inventory missing: {inventory_path}", file=sys.stderr)
        return 2

    try:
        if args.negative_smoke_backend_python:
            return run_negative_smoke(repo_root, inventory_path)
        errors, data = validate_inventory(repo_root, inventory_path)
    except json.JSONDecodeError as exc:
        print(f"invalid JSON in {inventory_path}: {exc}", file=sys.stderr)
        return 2

    if errors:
        print("HELMC++ runtime inventory guard: FAIL", file=sys.stderr)
        for error in errors:
            print(f"  - {error}", file=sys.stderr)
        return 1

    entries = data.get("entries", [])
    required = [
        e for e in entries
        if e.get("classification") == "required-runtime" and e.get("status") == "implemented"
    ]
    transitional = [e for e in entries if e.get("classification") == "transitional-reference"]
    optional = [e for e in entries if e.get("classification") == "optional-non-safety"]
    print("HELMC++ runtime inventory guard: PASS")
    print(f"  entries: {len(entries)}")
    print(f"  implemented required C++ runtime: {len(required)}")
    print(f"  transitional references/oracles: {len(transitional)}")
    print(f"  optional non-safety services: {len(optional)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
