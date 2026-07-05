#!/usr/bin/env python3
"""Tests for helm.render.schedule.v1 viewport scheduler."""

import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
FIXTURE_ROOT = ROOT / "engine" / "test" / "fixtures" / "viewport-scheduler"
sys.path.insert(0, str(ROOT / "pipeline"))

from viewport_scheduler import (  # noqa: E402
    REQUEST_SCHEMA,
    RESPONSE_SCHEMA,
    ScheduleError,
    build_schedule_response,
    deg2num,
    sha256_json,
)


class ViewportSchedulerTest(unittest.TestCase):
    def test_anchor_tile_from_center(self):
        request = {
            "schema": REQUEST_SCHEMA,
            "request_id": "unit-center",
            "visible": {
                "z": 12,
                "center": {"lon": -81.8, "lat": 24.5},
                "anchor_tile": {"z": 12, "x": 1120, "y": 1756},
                "viewport_px": [256, 256],
                "device_pixel_ratio": 1,
            },
            "zoom_policy": {"adjacent_offsets": [-1, 1], "include_children": True, "include_parent": True},
            "display_fingerprint": "day:standard",
            "source_epoch_hint": "epoch@1",
        }
        response = build_schedule_response(request)
        self.assertEqual(response["schema"], RESPONSE_SCHEMA)
        self.assertGreaterEqual(response["totals"]["visible"], 1)
        self.assertGreaterEqual(response["totals"]["overscan"], 1)
        self.assertGreaterEqual(response["totals"]["zoom_adjacent"], 1)
        visible = [item for item in response["entries"] if item["role"] == "visible"][0]
        self.assertEqual(visible["stale_policy"], "strict")

    def test_rejects_missing_epoch(self):
        request = {
            "schema": REQUEST_SCHEMA,
            "visible": {
                "z": 12,
                "anchor_tile": {"z": 12, "x": 1120, "y": 1756},
                "viewport_px": [256, 256],
            },
        }
        with self.assertRaises(ScheduleError):
            build_schedule_response(request)

    def test_cache_keys_are_stable(self):
        request = {
            "schema": REQUEST_SCHEMA,
            "request_id": "cache-key",
            "visible": {
                "z": 12,
                "anchor_tile": {"z": 12, "x": 1120, "y": 1756},
                "viewport_px": [256, 256],
            },
            "display_fingerprint": "day:standard",
            "source_epoch_hint": "epoch@1",
            "renderer": {"backend": "vulkan", "scene_schema": "helm.render.model.v1"},
        }
        first = build_schedule_response(request)
        second = build_schedule_response(request)
        self.assertEqual(first["entries"][0]["cache_key"], second["entries"][0]["cache_key"])
        self.assertIn("display_fp=day:standard", first["entries"][0]["cache_key"])

    def test_pan_no_blank_fixture(self):
        fixture_dir = FIXTURE_ROOT / "pan-no-blank"
        request = json.loads((fixture_dir / "request.json").read_text(encoding="utf-8"))
        expected = json.loads((fixture_dir / "response.json").read_text(encoding="utf-8"))
        manifest = json.loads((fixture_dir / "manifest.json").read_text(encoding="utf-8"))
        response = build_schedule_response(request, source_epoch=manifest["source_epoch"])
        self.assertEqual(response, expected)
        self.assertEqual(sha256_json(response), manifest["expected_hashes"]["response_json_sha256"])

    def test_deg2num_is_deterministic(self):
        first = deg2num(-81.8, 24.5, 12)
        second = deg2num(-81.8, 24.5, 12)
        self.assertEqual(first, second)
        self.assertEqual(first[0], 1117)
        self.assertEqual(first[1], 1760)


if __name__ == "__main__":
    unittest.main()
