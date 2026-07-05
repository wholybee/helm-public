#!/usr/bin/env python3
"""Reference viewport scheduler for helm.render.schedule.v1.

Deterministic tile math only — no chart semantics. Used by fixtures, tests, and
future server/browser integration.
"""
from __future__ import annotations

import hashlib
import math
from typing import Iterable

REQUEST_SCHEMA = "helm.render.schedule.request.v1"
RESPONSE_SCHEMA = "helm.render.schedule.response.v1"
WEB_MERCATOR_LAT_LIMIT = 85.05112878
DEFAULT_TILE_SIZE_PX = 256


class ScheduleError(ValueError):
    pass


def _clamp_lat(lat: float) -> float:
    return max(-WEB_MERCATOR_LAT_LIMIT, min(WEB_MERCATOR_LAT_LIMIT, lat))


def _clamp_lon(lon: float) -> float:
    return max(-180.0, min(180.0, lon))


def deg2num(lon: float, lat: float, z: int) -> tuple[int, int]:
    lat = _clamp_lat(lat)
    n = 2 ** z
    x = int((lon + 180.0) / 360.0 * n)
    y = int((1.0 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2.0 * n)
    return max(0, min(n - 1, x)), max(0, min(n - 1, y))


def num2bbox(z: int, x: int, y: int) -> list[float]:
    n = 2 ** z
    west = x / n * 360.0 - 180.0
    east = (x + 1) / n * 360.0 - 180.0
    north = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * y / n))))
    south = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * (y + 1) / n))))
    return [west, south, east, north]


def _tile_key(tile: dict) -> tuple[int, int, int]:
    return int(tile["z"]), int(tile["x"]), int(tile["y"])


def _normalize_cache_key(parts: dict[str, str]) -> str:
    return ";".join(f"{key}={parts[key]}" for key in sorted(parts))


def build_cache_key(
    *,
    renderer: dict,
    source_epoch: str,
    tile: dict,
    display_fingerprint: str,
    overscan_px: int,
) -> str:
    parts = {
        "display_fp": display_fingerprint,
        "overscan": str(overscan_px),
        "renderer": str(renderer.get("backend") or "vulkan"),
        "scene_schema": str(renderer.get("scene_schema") or "helm.render.model.v1"),
        "source_epoch": source_epoch,
        "x": str(tile["x"]),
        "y": str(tile["y"]),
        "z": str(tile["z"]),
    }
    renderer_sha = renderer.get("renderer_sha")
    if renderer_sha:
        parts["renderer_sha"] = str(renderer_sha)
    return _normalize_cache_key(parts)


def build_cache_epoch(source_epoch: str, request: dict) -> str:
    renderer = request.get("renderer") if isinstance(request.get("renderer"), dict) else {}
    scene_schema = str(renderer.get("scene_schema") or "helm.render.model.v1")
    display_fp = str(request.get("display_fingerprint") or "")
    return f"{source_epoch}:{scene_schema}:{display_fp}"


def _anchor_tile(visible: dict) -> dict:
    anchor = visible.get("anchor_tile")
    if isinstance(anchor, dict) and {"z", "x", "y"} <= set(anchor):
        return {"z": int(anchor["z"]), "x": int(anchor["x"]), "y": int(anchor["y"])}
    center = visible.get("center") if isinstance(visible.get("center"), dict) else {}
    if {"lon", "lat"} <= set(center):
        z = int(visible.get("z", 0))
        x, y = deg2num(float(center["lon"]), float(center["lat"]), z)
        return {"z": z, "x": x, "y": y}
    raise ScheduleError("visible requires anchor_tile or center+z")


def _visible_tiles(visible: dict) -> set[tuple[int, int, int]]:
    z = int(visible.get("z", 0))
    viewport = visible.get("viewport_px") or [DEFAULT_TILE_SIZE_PX, DEFAULT_TILE_SIZE_PX]
    if not isinstance(viewport, (list, tuple)) or len(viewport) != 2:
        raise ScheduleError("visible.viewport_px must be [width, height]")
    width_px = int(viewport[0])
    height_px = int(viewport[1])
    dpr = float(visible.get("device_pixel_ratio") or 1)
    anchor = _anchor_tile(visible)
    anchor_bbox = num2bbox(anchor["z"], anchor["x"], anchor["y"])
    west, south, east, north = anchor_bbox
    tile_w = (east - west) / DEFAULT_TILE_SIZE_PX
    tile_h = (north - south) / DEFAULT_TILE_SIZE_PX
    half_w_deg = (width_px * dpr * tile_w) / 2.0
    half_h_deg = (height_px * dpr * tile_h) / 2.0
    center = visible.get("center") if isinstance(visible.get("center"), dict) else {}
    if {"lon", "lat"} <= set(center):
        lon = float(center["lon"])
        lat = float(center["lat"])
    else:
        lon = (west + east) / 2.0
        lat = (south + north) / 2.0
    view_bbox = [
        _clamp_lon(lon - half_w_deg),
        _clamp_lat(lat - half_h_deg),
        _clamp_lon(lon + half_w_deg),
        _clamp_lat(lat + half_h_deg),
    ]
    tiles: set[tuple[int, int, int]] = set()
    x0, y0 = deg2num(view_bbox[0], view_bbox[3], z)
    x1, y1 = deg2num(view_bbox[2], view_bbox[1], z)
    for x in range(min(x0, x1), max(x0, x1) + 1):
        for y in range(min(y0, y1), max(y0, y1) + 1):
            tiles.add((z, x, y))
    if not tiles:
        tiles.add(_tile_key(anchor))
    return tiles


def _ring_tiles(anchor: dict, ring: int) -> set[tuple[int, int, int]]:
    z, x0, y0 = _tile_key(anchor)
    n = 2 ** z
    out: set[tuple[int, int, int]] = set()
    for dx in range(-ring, ring + 1):
        for dy in range(-ring, ring + 1):
            if dx == 0 and dy == 0:
                continue
            x = (x0 + dx) % n
            y = max(0, min(n - 1, y0 + dy))
            out.add((z, x, y))
    return out


def _adjacent_zoom_tiles(anchor: dict, zoom_policy: dict) -> list[tuple[dict, float]]:
    offsets = zoom_policy.get("adjacent_offsets") or []
    if not isinstance(offsets, list):
        raise ScheduleError("zoom_policy.adjacent_offsets must be a list")
    z, x, y = _tile_key(anchor)
    out: list[tuple[dict, float]] = []
    for offset in offsets:
        try:
            delta = int(offset)
        except (TypeError, ValueError):
            raise ScheduleError("zoom_policy.adjacent_offsets must contain integers")
        target_z = z + delta
        if target_z < 0:
            continue
        if delta < 0 and zoom_policy.get("include_parent", True):
            parent = {"z": target_z, "x": x // 2, "y": y // 2}
            out.append((parent, 0.5))
        if delta > 0 and zoom_policy.get("include_children", True):
            base_x = x * 2
            base_y = y * 2
            for dx in (0, 1):
                for dy in (0, 1):
                    out.append(({"z": target_z, "x": base_x + dx, "y": base_y + dy}, 0.25))
    return out


def _role_stale_policy(role: str, intent: str) -> str:
    if role == "visible":
        return "strict"
    if role == "overscan":
        return "strict" if intent == "revalidate" else "stale_while_revalidate"
    return "stale_ok"


def _priority_for_role(role: str) -> int:
    return {
        "visible": 0,
        "overscan": 10,
        "neighbor": 20,
        "zoom_adjacent": 30,
        "prefetch": 40,
    }.get(role, 50)


def _entry_id(tile: dict, role: str) -> str:
    return f"tile.z{tile['z']}.x{tile['x']}.y{tile['y']}.{role}"


def build_schedule_response(request: dict, *, source_epoch: str | None = None) -> dict:
    if request.get("schema") != REQUEST_SCHEMA:
        raise ScheduleError(f"schema must be {REQUEST_SCHEMA}")
    visible = request.get("visible")
    if not isinstance(visible, dict):
        raise ScheduleError("visible is required")
    overscan = request.get("overscan") if isinstance(request.get("overscan"), dict) else {}
    neighbor_policy = request.get("neighbor_policy") if isinstance(request.get("neighbor_policy"), dict) else {}
    zoom_policy = request.get("zoom_policy") if isinstance(request.get("zoom_policy"), dict) else {}
    renderer = request.get("renderer") if isinstance(request.get("renderer"), dict) else {}
    intent = str(request.get("intent") or "visible")
    display_fp = str(request.get("display_fingerprint") or "")
    margin_px = int(overscan.get("margin_px") or 16)
    margin_tiles = int(overscan.get("margin_tiles") or 1)
    ring_count = int(neighbor_policy.get("ring_count") or 1)
    epoch = source_epoch or str(request.get("source_epoch_hint") or "")
    if not epoch:
        raise ScheduleError("source_epoch is required")

    anchor = _anchor_tile(visible)
    visible_set = _visible_tiles(visible)
    overscan_set: set[tuple[int, int, int]] = set()
    for ring in range(1, margin_tiles + 1):
        overscan_set |= _ring_tiles(anchor, ring)
    overscan_set -= visible_set

    neighbor_set: set[tuple[int, int, int]] = set()
    if ring_count > margin_tiles:
        for ring in range(margin_tiles + 1, ring_count + 1):
            neighbor_set |= _ring_tiles(anchor, ring)
    neighbor_set -= visible_set
    neighbor_set -= overscan_set

    entries: list[dict] = []

    def add_entry(tile_tuple: tuple[int, int, int], role: str, blend_weight: float = 1.0) -> None:
        tile = {"z": tile_tuple[0], "x": tile_tuple[1], "y": tile_tuple[2]}
        entries.append(
            {
                "entry_id": _entry_id(tile, role),
                "kind": "tile",
                "role": role,
                "priority": _priority_for_role(role),
                "tile": tile,
                "overscan_px": margin_px,
                "cache_key": build_cache_key(
                    renderer=renderer,
                    source_epoch=epoch,
                    tile=tile,
                    display_fingerprint=display_fp,
                    overscan_px=margin_px,
                ),
                "stale_policy": _role_stale_policy(role, intent),
                "blend_weight": blend_weight,
            }
        )

    for tile_tuple in sorted(visible_set):
        add_entry(tile_tuple, "visible", 1.0)
    for tile_tuple in sorted(overscan_set):
        add_entry(tile_tuple, "overscan", 1.0)
    for tile_tuple in sorted(neighbor_set):
        add_entry(tile_tuple, "neighbor", 1.0)
    for tile, blend in _adjacent_zoom_tiles(anchor, zoom_policy):
        add_entry(_tile_key(tile), "zoom_adjacent", blend)

    entries.sort(key=lambda item: (item["priority"], _tile_key(item["tile"]), item["role"], item["entry_id"]))
    totals = {
        "entries": len(entries),
        "visible": sum(1 for item in entries if item["role"] == "visible"),
        "overscan": sum(1 for item in entries if item["role"] == "overscan"),
        "neighbor": sum(1 for item in entries if item["role"] == "neighbor"),
        "zoom_adjacent": sum(1 for item in entries if item["role"] == "zoom_adjacent"),
    }
    return {
        "schema": RESPONSE_SCHEMA,
        "request_id": str(request.get("request_id") or ""),
        "source_epoch": epoch,
        "cache_epoch": build_cache_epoch(epoch, request),
        "entries": entries,
        "totals": totals,
        "diagnostics": [],
    }


def sha256_json(payload: dict) -> str:
    import json

    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()
