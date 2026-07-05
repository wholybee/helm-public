#!/usr/bin/env python3
"""Normalize public symbol-review feedback into repair-queue input.

This script is intentionally dependency-free and public-safe. It accepts either
the JSON exported by the static GitHub Pages catalog or a GitHub issue body that
contains that JSON in a fenced code block. It validates symbol ids against the
public proof index and writes normalized JSON + JSONL artifacts.

It does not mutate Helm's canonical/private DB.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import pathlib
import re
import sys
from typing import Any


VALID_DECISIONS = {"approve", "needs_work", "reject"}
EXPORT_SCHEMA = "helm.forge.public_review_decisions.v1"
OUTPUT_SCHEMA = "helm.forge.public_feedback_batch.v1"


class FeedbackError(Exception):
    """Validation error for public feedback input."""


def load_json(path: pathlib.Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise FeedbackError(f"{path}: invalid JSON: {exc}") from exc


def extract_json_payload(text: str) -> Any:
    stripped = text.strip()
    if stripped.startswith("{") or stripped.startswith("["):
        try:
            return json.loads(stripped)
        except json.JSONDecodeError as exc:
            raise FeedbackError(f"invalid JSON payload: {exc}") from exc

    blocks = re.findall(r"```(?:json)?\s*(.*?)```", text, flags=re.DOTALL | re.IGNORECASE)
    parsed_blocks: list[Any] = []
    for block in blocks:
        candidate = block.strip()
        if not candidate:
            continue
        try:
            parsed = json.loads(candidate)
        except json.JSONDecodeError:
            continue
        if is_feedback_payload(parsed):
            parsed_blocks.append(parsed)

    for parsed in parsed_blocks:
        try:
            if raw_decisions(parsed):
                return parsed
        except FeedbackError:
            continue

    raise FeedbackError("no helm.forge public review JSON block found")


def is_feedback_payload(value: Any) -> bool:
    if isinstance(value, list):
        return True
    if not isinstance(value, dict):
        return False
    return value.get("schema") == EXPORT_SCHEMA or "decisions" in value or "symbol_id" in value


def load_payload(path: pathlib.Path) -> Any:
    text = path.read_text(encoding="utf-8")
    return extract_json_payload(text)


def load_symbol_index(path: pathlib.Path) -> dict[str, dict[str, Any]]:
    data = load_json(path)
    symbols = data.get("symbols")
    if not isinstance(symbols, list):
        raise FeedbackError(f"{path}: expected symbols[] in site index")
    index: dict[str, dict[str, Any]] = {}
    for symbol in symbols:
        if isinstance(symbol, dict) and symbol.get("id"):
            index[str(symbol["id"])] = symbol
    if not index:
        raise FeedbackError(f"{path}: no symbols indexed")
    return index


def raw_decisions(payload: Any) -> list[dict[str, Any]]:
    if isinstance(payload, list):
        items = payload
    elif isinstance(payload, dict) and isinstance(payload.get("decisions"), list):
        items = payload["decisions"]
    elif isinstance(payload, dict):
        items = [payload]
    else:
        raise FeedbackError("feedback payload must be an object, object.decisions[], or array")

    decisions: list[dict[str, Any]] = []
    for i, item in enumerate(items):
        if not isinstance(item, dict):
            raise FeedbackError(f"decision {i}: expected object")
        decisions.append(item)
    return decisions


def clean_text(value: Any, limit: int = 4000) -> str:
    if value is None:
        return ""
    text = str(value).replace("\r\n", "\n").replace("\r", "\n").strip()
    return text[:limit]


def normalize_decisions(
    payload: Any,
    symbol_index: dict[str, dict[str, Any]],
    args: argparse.Namespace,
) -> list[dict[str, Any]]:
    normalized: list[dict[str, Any]] = []
    seen: set[tuple[str, str, str]] = set()

    for i, item in enumerate(raw_decisions(payload)):
        symbol_id = clean_text(item.get("symbol_id") or item.get("id"), 200)
        if not symbol_id:
            raise FeedbackError(f"decision {i}: missing symbol_id")
        if symbol_id not in symbol_index:
            raise FeedbackError(f"decision {i}: unknown symbol_id {symbol_id!r}")

        decision = clean_text(item.get("decision"), 100)
        if decision not in VALID_DECISIONS:
            raise FeedbackError(
                f"decision {i}: invalid decision {decision!r}; expected one of {sorted(VALID_DECISIONS)}"
            )

        notes = clean_text(item.get("notes") or item.get("comment") or item.get("feedback"))
        symbol = symbol_index[symbol_id]
        gate = symbol.get("gate") or {}
        s101 = symbol.get("s101") or {}
        runtime = symbol.get("runtime") or {}
        art = symbol.get("art") or {}
        review = symbol.get("human_review") or {}

        key = (symbol_id, decision, notes)
        if key in seen:
            continue
        seen.add(key)

        normalized.append(
            {
                "schema": "helm.forge.public_symbol_feedback.v1",
                "symbol_id": symbol_id,
                "decision": decision,
                "comment": notes,
                "status": "received",
                "repair_state": "needs_private_triage",
                "source": {
                    "type": args.source_type,
                    "issue_number": args.issue_number,
                    "issue_url": args.issue_url,
                    "reviewer": args.reviewer,
                    "submitted_at": item.get("ts") or args.submitted_at,
                },
                "symbol_snapshot": {
                    "name": symbol.get("name"),
                    "family": item.get("family") or symbol.get("family"),
                    "object_class": symbol.get("object_class"),
                    "geometry": symbol.get("geometry"),
                    "category": symbol.get("category"),
                    "uses": symbol.get("uses"),
                    "art": {
                        "canonical": art.get("canonical"),
                        "day": art.get("day"),
                        "dusk": art.get("dusk"),
                        "night": art.get("night"),
                    },
                    "proof_gate": gate.get("proof"),
                    "visual_gate": gate.get("visual"),
                    "semantic_gate": gate.get("semantic"),
                    "owner_final_approved": bool(review.get("final_approved")),
                    "runtime_exportable": bool(runtime.get("exportable")),
                    "runtime_reason_codes": runtime.get("reason_codes") or [],
                    "s101": {
                        "classification": s101.get("classification"),
                        "mapping_type": s101.get("mapping_type"),
                        "rule_file": s101.get("rule_file"),
                    },
                },
            }
        )

    return normalized


def write_outputs(records: list[dict[str, Any]], args: argparse.Namespace) -> dict[str, Any]:
    out_dir = pathlib.Path(args.output_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    generated_at = dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat()
    batch = {
        "schema": OUTPUT_SCHEMA,
        "generated_at": generated_at,
        "count": len(records),
        "source": {
            "type": args.source_type,
            "issue_number": args.issue_number,
            "issue_url": args.issue_url,
            "reviewer": args.reviewer,
        },
        "records": records,
        "private_import_note": (
            "Public feedback is input to private Helm repair triage only; "
            "it does not mutate canonical SVG/DB rows or runtime eligibility."
        ),
    }

    json_path = out_dir / "symbol-feedback-normalized.json"
    jsonl_path = out_dir / "symbol-feedback-normalized.jsonl"
    json_path.write_text(json.dumps(batch, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    jsonl_path.write_text(
        "".join(json.dumps(record, sort_keys=True) + "\n" for record in records),
        encoding="utf-8",
    )
    return batch


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--site-index", required=True, help="Path to public proof/site-index.json")
    parser.add_argument("--input", required=True, help="Review JSON export or GitHub issue body")
    parser.add_argument("--output-dir", default="symbol-feedback-artifact")
    parser.add_argument("--source-type", default="github_issue")
    parser.add_argument("--issue-number")
    parser.add_argument("--issue-url")
    parser.add_argument("--reviewer")
    parser.add_argument(
        "--submitted-at",
        default=dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat(),
    )
    return parser.parse_args(argv)


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    try:
        symbol_index = load_symbol_index(pathlib.Path(args.site_index))
        payload = load_payload(pathlib.Path(args.input))
        records = normalize_decisions(payload, symbol_index, args)
        if not records:
            raise FeedbackError("no feedback records found")
        batch = write_outputs(records, args)
    except FeedbackError as exc:
        print(f"normalize-symbol-feedback: {exc}", file=sys.stderr)
        return 2

    print(f"normalized {batch['count']} symbol feedback record(s)")
    print(f"output_dir={args.output_dir}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
