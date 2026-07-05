#!/usr/bin/env python3
"""Smoke tests for scripts/normalize-symbol-feedback.py."""

from __future__ import annotations

import json
import pathlib
import subprocess
import sys
import tempfile


ROOT = pathlib.Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "normalize-symbol-feedback.py"


def write(path: pathlib.Path, value: object) -> None:
    path.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")


def run(*args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(SCRIPT), *args],
        cwd=str(ROOT),
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )


def main() -> int:
    with tempfile.TemporaryDirectory() as tmp:
        d = pathlib.Path(tmp)
        site = d / "site-index.json"
        review = d / "review.json"
        issue = d / "issue.md"
        out = d / "out"

        write(
            site,
            {
                "schema": "helm.forge.public_symbol_catalog.v1",
                "symbols": [
                    {
                        "id": "BOYCAN60",
                        "name": "red can buoy",
                        "family": "BOYCAN",
                        "object_class": "BOYSPP",
                        "geometry": "point",
                        "uses": 1,
                        "art": {"canonical": "assets/svg/canonical/BOYCAN60.svg"},
                        "gate": {"proof": "yellow"},
                        "s101": {"classification": "rule_derived", "mapping_type": "s101_feature_equivalent"},
                        "runtime": {"exportable": False, "reason_codes": ["runtime_export_rows_zero"]},
                        "human_review": {"final_approved": True},
                    }
                ],
            },
        )
        write(
            review,
            {
                "schema": "helm.forge.public_review_decisions.v1",
                "decisions": [
                    {
                        "symbol_id": "BOYCAN60",
                        "family": "BOYCAN",
                        "decision": "needs_work",
                        "notes": "Dot is too low; waterline missing.",
                        "ts": "2026-07-06T00:00:00Z",
                    }
                ],
            },
        )

        ok = run("--site-index", str(site), "--input", str(review), "--output-dir", str(out))
        assert ok.returncode == 0, ok.stderr
        normalized = json.loads((out / "symbol-feedback-normalized.json").read_text(encoding="utf-8"))
        assert normalized["schema"] == "helm.forge.public_feedback_batch.v1"
        assert normalized["count"] == 1
        record = normalized["records"][0]
        assert record["symbol_id"] == "BOYCAN60"
        assert record["repair_state"] == "needs_private_triage"
        assert record["symbol_snapshot"]["family"] == "BOYCAN"

        issue.write_text(
            "Template example:\n\n```json\n"
            + json.dumps({"schema": "helm.forge.public_review_decisions.v1", "decisions": []})
            + "\n```\n\nPlease review:\n\n```json\n"
            + review.read_text(encoding="utf-8")
            + "```\n",
            encoding="utf-8",
        )
        ok_issue = run("--site-index", str(site), "--input", str(issue), "--output-dir", str(d / "issue-out"))
        assert ok_issue.returncode == 0, ok_issue.stderr

        bad = d / "bad.json"
        write(
            bad,
            {
                "schema": "helm.forge.public_review_decisions.v1",
                "decisions": [{"symbol_id": "MISSING01", "decision": "reject"}],
            },
        )
        failed = run("--site-index", str(site), "--input", str(bad), "--output-dir", str(d / "bad-out"))
        assert failed.returncode == 2
        assert "unknown symbol_id" in failed.stderr

    print("normalize-symbol-feedback smoke tests passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
