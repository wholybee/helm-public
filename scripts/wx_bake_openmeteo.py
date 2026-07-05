#!/usr/bin/env python3
"""One-command real-weather bake: generate a pack-factory job for an Open-Meteo
run anchored on a GPS position (or explicit bbox) and publish it (WX-36 / WX-38).

    python3 scripts/wx_bake_openmeteo.py --anchor 177.4,-17.6 --out ~/.helm/wx-packs

Reads HELM_WX_OPENMETEO_KEY (commercial hosts only — there is NO free-host
fallback; a keyless run fails loud before any fetch). Prints the exact API call
count before fetching so a bake is never a surprise on a metered link.

WX-38 split horizon: forecast-host layers (wind/rain/gust/temp/pressure/…) and
marine-host layers (waves/swell/current/sst) go into SEPARATE packs in one
release, each with its own validTimes. The forecast host serves ~16 days; the
marine host serves ~10 days (240 h; measured 2026-07-02 — beyond that the
forecast host hard-400s and the marine host returns null-valued tails). Frames
are free (Open-Meteo calls scale with grid points, not times), so the deeper
forecast horizon costs no extra calls. The web client selects a pack per layer
(web/wx-grid-pack-client.js pickPack), so two horizons in one release Just Work.

This is reference/cloud-job tooling per docs/RUNTIME-SERVICES.md — not a boat
daemon. The factory (scripts/wx_pack_factory.py) does the fetching, quantizing,
packing, verification, and atomic release publish; this script only writes the
job JSON and invokes it.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import subprocess
import sys
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
FACTORY = ROOT / "scripts" / "wx_pack_factory.py"
DEFAULT_SOURCE_SPEC = ROOT / "services" / "wx" / "fixtures" / "wx-openmeteo-source.json"
BATCH = 140

PROFILES = {
    # dx/dy + half-spans (lon, lat) around the anchor. route-high ~= a passage
    # window; global-low is the budget-honest overview tier.
    "route-high": {"res": 0.25, "half_lon": 20.0, "half_lat": 15.0, "zoom": [4, 10]},
    "global-low": {"res": 1.0, "half_lon": 180.0, "half_lat": 90.0, "zoom": [0, 4]},
}

# Which Open-Meteo host serves each layer (mirrors wx_pack_factory.OPENMETEO_LAYERS).
# The split is BY HOST because each host has its own forecast horizon and each pack
# hits exactly one host.
MARINE_LAYERS = {"waves", "swell", "current", "sst"}

# Measured safe horizons, hours from the model run (2026-07-02, commercial hosts):
#   forecast: end_date today+15 (=384 h window) succeeds; today+16 hard-400s.
#   marine:   240 h fully non-null through +9d 23:00; nulls creep in during day 10.
# Last step-aligned frame stays a margin inside each: forecast +15d21:00, marine +9d21:00.
FORECAST_HORIZON_HOURS = 381
MARINE_HORIZON_HOURS = 237


def utc_now() -> datetime:
    return datetime.now(timezone.utc).replace(minute=0, second=0, microsecond=0)


def iso(dt: datetime) -> str:
    return dt.isoformat().replace("+00:00", "Z")


def host_of(layer: str) -> str:
    return "marine" if layer in MARINE_LAYERS else "forecast"


def frames_for(horizon_hours: int, snap_hours: int, step_hours: int) -> int:
    """Step-aligned frame count whose last frame stays within horizon_hours of the
    run's midnight (run_time = today + snap_hours, so start_date is always today)."""
    return max(2, (horizon_hours - snap_hours) // step_hours + 1)


def valid_times(run_time: datetime, count: int, step_hours: int) -> list[str]:
    return [iso(run_time + timedelta(hours=i * step_hours)) for i in range(count)]


def pack_entry(profile_name: str, profile: dict, res: float, anchor_id: str,
               layers: list[str], times: list[str], bbox: tuple[float, float, float, float]) -> dict:
    west, south, east, north = bbox
    return {
        "profile": profile_name,
        "tier": profile_name,
        "anchor": anchor_id,
        "layers": layers,
        "validTimes": times,
        "tierSpec": {
            "role": "passage" if profile_name == "route-high" else "overview",
            "crs": "OGC:CRS84",
            "grid": {"dx": res, "dy": res},
            "clientZoomRange": profile["zoom"],
        },
        "coverage": {
            "crs": "OGC:CRS84",
            "global": False,
            "bbox": [west, south, east, north],
            "wrap": "antimeridian",
            "crossesAntimeridian": east > 180.0,
        },
        "chunks": [{"bbox": [west, south, east, north]}],
    }


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--anchor", help="lon,lat GPS anchor (route-high default window around it)")
    ap.add_argument("--bbox", help="explicit w,s,e,n (east may exceed 180 for antimeridian passages)")
    ap.add_argument("--profile", choices=sorted(PROFILES), default="route-high")
    ap.add_argument("--layers", default="wind,rain,waves,swell,current",
                    help="comma-separated layers (default: the core five)")
    ap.add_argument("--frames", type=int,
                    help="hard override: exactly this many frames for EVERY pack (metered links); "
                         "omit to use the per-host horizons below")
    ap.add_argument("--step-hours", type=int, default=3, help="hours between valid times (default 3)")
    ap.add_argument("--forecast-hours", type=int, default=FORECAST_HORIZON_HOURS,
                    help="max hours-from-run for forecast-host layers (default ~16 d)")
    ap.add_argument("--marine-hours", type=int, default=MARINE_HORIZON_HOURS,
                    help="max hours-from-run for marine-host layers (default ~10 d)")
    ap.add_argument("--res", type=float, help="override grid resolution in degrees")
    ap.add_argument("--out", required=True, help="release output directory")
    ap.add_argument("--source-spec", default=str(DEFAULT_SOURCE_SPEC))
    ap.add_argument("--dry-run", action="store_true", help="print the job + call estimate, fetch nothing")
    args = ap.parse_args(argv[1:])

    profile = PROFILES[args.profile]
    res = float(args.res or profile["res"])
    step = max(1, int(args.step_hours))
    if args.bbox:
        west, south, east, north = (float(v) for v in args.bbox.split(","))
    elif args.anchor:
        lon, lat = (float(v) for v in args.anchor.split(","))
        west, east = lon - profile["half_lon"], lon + profile["half_lon"]
        south = max(-85.0, lat - profile["half_lat"])
        north = min(85.0, lat + profile["half_lat"])
    else:
        ap.error("--anchor or --bbox is required")
    if east <= west or north <= south:
        ap.error("bbox must have east > west (use east > 180 for antimeridian passages) and north > south")
    bbox = (west, south, east, north)

    layers = [l.strip() for l in args.layers.split(",") if l.strip()]
    spec = json.loads(Path(args.source_spec).read_text(encoding="utf-8"))
    for layer in layers:
        if layer not in (spec.get("layers") or {}):
            print(f"error: layer {layer} is not in the source spec", file=sys.stderr)
            return 2

    forecast_layers = [l for l in layers if host_of(l) == "forecast"]
    marine_layers = [l for l in layers if host_of(l) == "marine"]

    now = utc_now()
    run_time = now - timedelta(hours=now.hour % step)
    snap = run_time.hour                                    # run_time.date() == today, so start_date is today

    if args.frames:                                         # hard override: one horizon for all packs
        ff = fm = max(2, int(args.frames))
    else:
        ff = frames_for(int(args.forecast_hours), snap, step)
        fm = frames_for(int(args.marine_hours), snap, step)
    forecast_times = valid_times(run_time, ff, step)
    marine_times = valid_times(run_time, fm, step)

    # Build one pack per non-empty host group. The modelRun envelope is the longest
    # set actually used (forecast ⊇ marine when both are present); each pack declares
    # its own validTimes (a subset — enforced by the factory).
    base_anchor = (args.anchor or f"{west}_{south}").replace(",", "_")
    groups = []
    if forecast_layers:
        groups.append(("forecast", forecast_layers, forecast_times))
    if marine_layers:
        groups.append(("marine", marine_layers, marine_times))
    if not groups:
        ap.error("no bakeable layers")

    packs = []
    for host, hlayers, htimes in groups:
        # Keep the primary/forecast pack on the bare anchor (stable filename); suffix the
        # other only when both packs coexist, so a single-host bake keeps the plain name.
        anchor_id = base_anchor if (len(groups) == 1 or host == "forecast") else f"{base_anchor}-{host}"
        packs.append(pack_entry(args.profile, profile, res, anchor_id, hlayers, htimes, bbox))

    model_times = forecast_times if forecast_layers else marine_times   # envelope = longest used

    width = round((east - west) / res) + 1
    height = round((north - south) / res) + 1
    points = width * height
    hosts_needed = {host for host, _, _ in groups}
    calls = len(hosts_needed) * math.ceil(points / BATCH)
    horizons = ", ".join(
        f"{host} {len(t)}f/{(len(t) - 1) * step / 24:.1f}d" for host, _, t in groups)
    print(f"bake plan: {args.profile} {west},{south} -> {east},{north} @ {res} deg "
          f"= {width}x{height} = {points} points; {horizons}; layers {','.join(layers)}; "
          f"frames are free; ~{calls} Open-Meteo calls", file=sys.stderr)

    job = {
        "schema": "helm.wx.pack_factory.job.v1",
        "generatedAt": iso(datetime.now(timezone.utc).replace(microsecond=0)),
        "maxSourceAgeHours": 24,
        "modelRun": {
            "provider": "open-meteo",
            "model": "gfs-seamless",
            "runTime": model_times[0],
            "validTimes": model_times,
            "timeStepSeconds": step * 3600,
        },
        "sources": [{
            "id": "open-meteo-live",
            "type": "open-meteo",
            "path": str(Path(args.source_spec).resolve()),
            "generatedAt": iso(datetime.now(timezone.utc).replace(microsecond=0)),
            "provider": "open-meteo",
            "license": "Open-Meteo commercial subscription",
            "provenance": f"Open-Meteo customer API bake; ~{calls} calls; {points} grid points",
        }],
        "packs": packs,
    }

    if args.dry_run:
        print(json.dumps(job, indent=2, sort_keys=True))
        return 0

    with tempfile.TemporaryDirectory() as td:
        job_path = Path(td) / "openmeteo-job.json"
        job_path.write_text(json.dumps(job, indent=2, sort_keys=True), encoding="utf-8")
        proc = subprocess.run([sys.executable, str(FACTORY), "publish", str(job_path),
                               "--out", args.out, "--allow-network", "--replace"])
        return proc.returncode


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
