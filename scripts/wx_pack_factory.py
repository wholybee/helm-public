#!/usr/bin/env python3
"""Publish compact Helm environmental grid packs from an explicit factory job.

WX-34's pack factory is meant for a cloud/VM/R2 worker, not a laptop daemon.
It reads a declared model-run job, materializes compact helm.env.grid.v1 packs
through the WX-32 PMTiles/packd transport, and atomically advances a release
catalog only after every pack verifies.

This first slice is intentionally dependency-free and fixture/local-source
oriented. Provider adapters may be added later, but surprise network fetches are
forbidden unless the caller opts in and the adapter implements them.
"""

from __future__ import annotations

import argparse
import copy
import concurrent.futures
import math
import urllib.error
import urllib.parse
import urllib.request
import hashlib
import json
import os
import shutil
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import env_grid_pack


JOB_SCHEMA = "helm.wx.pack_factory.job.v1"
RELEASE_SCHEMA = "helm.wx.pack_factory.release.v1"
FAILURE_POLICY = {
    "missingChunk": "fail-loud",
    "staleRun": "show-stale-status",
    "unsupportedCapability": "fail-loud",
    "upstreamFetchDuringGesture": "forbidden",
    "substitution": "forbidden",
}
ADAPTERS = {
    "fixture": {"requiresNetwork": False, "implemented": True},
    "manifest": {"requiresNetwork": False, "implemented": True},
    "open-meteo": {"requiresNetwork": True, "implemented": True},   # WX-36 live adapter below
    "noaa": {"requiresNetwork": True, "implemented": False},
    "predictwind": {"requiresNetwork": True, "implemented": False},
}
ENV_GRID_FAILURE_CODES = {
    "missing_range",
    "checksum_mismatch",
    "bad_chunk_magic",
    "unsupported_chunk_version",
    "truncated_chunk_header",
    "bad_chunk_schema",
    "chunk_key_mismatch",
    "unsupported_band_type",
    "bad_band_values",
    "quantization_overflow",
}


class FactoryError(Exception):
    def __init__(self, code: str, message: str, details: dict[str, Any] | None = None):
        super().__init__(message)
        self.code = code
        self.details = details or {}


def fail(code: str, message: str, details: dict[str, Any] | None = None) -> None:
    raise FactoryError(code, message, details)


def stable_json(value: Any) -> str:
    return json.dumps(value, indent=2, sort_keys=True) + "\n"


def load_json(path: Path) -> dict[str, Any]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        fail("missing_source", f"file not found: {path}", {"path": str(path)})
    except json.JSONDecodeError as exc:
        fail("invalid_json", f"invalid JSON in {path}: {exc}", {"path": str(path)})
    if not isinstance(data, dict):
        fail("invalid_json", f"{path} must contain a JSON object", {"path": str(path)})
    return data


def parse_time(raw: str, field: str) -> datetime:
    try:
        parsed = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except (AttributeError, ValueError):
        fail("invalid_time", f"{field} must be ISO-8601 UTC", {"field": field, "value": raw})
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        fail(
            "invalid_time",
            f"{field} must include a UTC offset or Z",
            {"field": field, "value": raw},
        )
    return parsed.astimezone(timezone.utc)


def now_utc() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def slug(value: str) -> str:
    out = []
    for ch in value.lower():
        out.append(ch if ch.isalnum() else "-")
    compact = "-".join(part for part in "".join(out).split("-") if part)
    return compact or "pack"


def atomic_write_json(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(stable_json(value), encoding="utf-8")
    os.replace(tmp, path)


def validate_job(job: dict[str, Any]) -> None:
    if job.get("schema") != JOB_SCHEMA:
        fail("invalid_job", f"job schema must be {JOB_SCHEMA}", {"schema": job.get("schema")})
    if not isinstance(job.get("sources"), list) or not job["sources"]:
        fail("invalid_job", "job must declare at least one source")
    if not isinstance(job.get("packs"), list) or not job["packs"]:
        fail("invalid_job", "job must declare at least one pack")
    model_run = job.get("modelRun") or {}
    for key in ("provider", "model", "runTime", "validTimes"):
        if key not in model_run:
            fail("invalid_job", f"modelRun.{key} is required")
    if not isinstance(model_run.get("validTimes"), list) or not model_run["validTimes"]:
        fail("invalid_job", "modelRun.validTimes must be a non-empty list")
    parse_time(str(model_run["runTime"]), "modelRun.runTime")
    for idx, valid_time in enumerate(model_run["validTimes"]):
        parse_time(str(valid_time), f"modelRun.validTimes[{idx}]")
    # Per-pack validTimes are OPTIONAL (split-horizon packs: e.g. a 16d forecast pack
    # and a 10d marine pack in one release). When present they must be well-formed and a
    # subset of the modelRun envelope — a pack cannot carry a frame the run doesn't declare.
    model_valid = {str(t) for t in model_run["validTimes"]}
    for p_idx, pack in enumerate(job["packs"]):
        if not isinstance(pack, dict):
            continue
        pack_times = pack.get("validTimes")
        if pack_times is None:
            continue
        if not isinstance(pack_times, list) or not pack_times:
            fail("invalid_job", f"packs[{p_idx}].validTimes must be a non-empty list when present")
        for t_idx, valid_time in enumerate(pack_times):
            parse_time(str(valid_time), f"packs[{p_idx}].validTimes[{t_idx}]")
            if str(valid_time) not in model_valid:
                fail(
                    "invalid_job",
                    f"packs[{p_idx}].validTimes[{t_idx}] {valid_time} is not in modelRun.validTimes",
                    {"validTime": str(valid_time)},
                )


def release_id_for(job: dict[str, Any]) -> str:
    return str(job.get("releaseId") or slug(f"{job['modelRun']['provider']}-{job['modelRun']['model']}-{job['modelRun']['runTime']}"))


def source_reference_time(job: dict[str, Any], replay_clock: bool) -> datetime:
    if replay_clock:
        return parse_time(job.get("generatedAt") or now_utc(), "generatedAt")
    return datetime.now(timezone.utc)


def adapter_config(adapter: str, source_id: str, allow_network: bool) -> dict[str, Any]:
    config = ADAPTERS.get(adapter)
    if config is None:
        fail("unsupported_source_adapter", f"unsupported source adapter: {adapter}", {"source": source_id, "adapter": adapter})
    if config.get("requiresNetwork") and not allow_network:
        fail(
            "network_forbidden",
            f"source {source_id} would require network; rerun on the cloud worker with explicit network permission",
            {"source": source_id, "adapter": adapter},
        )
    if not config.get("implemented"):
        fail("unsupported_source_adapter", f"source adapter is not implemented yet: {adapter}", {"source": source_id, "adapter": adapter})
    return config


def load_sources(job: dict[str, Any], base: Path, allow_network: bool, replay_clock: bool) -> dict[str, dict[str, Any]]:
    reference_time = source_reference_time(job, replay_clock)
    loaded: dict[str, dict[str, Any]] = {}
    for source in job.get("sources", []):
        if not isinstance(source, dict):
            fail("invalid_source", "source entries must be objects")
        source_id = str(source.get("id") or "")
        if not source_id:
            fail("invalid_source", "source.id is required")
        adapter = str(source.get("type") or "manifest")
        adapter_config(adapter, source_id, allow_network)
        path_raw = source.get("path")
        if not path_raw:
            fail("invalid_source", f"source {source_id} must declare path")
        path = Path(path_raw)
        if not path.is_absolute():
            path = base / path
        manifest = load_json(path)
        source_generated = str(source.get("generatedAt") or manifest.get("generatedAt") or "")
        if not source_generated:
            fail("missing_source_time", f"source {source_id} must declare generatedAt")
        source_time = parse_time(source_generated, f"sources.{source_id}.generatedAt")
        max_age_hours = float(source.get("maxSourceAgeHours", job.get("maxSourceAgeHours", 24)))
        age_hours = (reference_time - source_time).total_seconds() / 3600.0
        if age_hours > max_age_hours:
            fail(
                "stale_source",
                f"source {source_id} is stale: {age_hours:.1f}h old > {max_age_hours:.1f}h",
                {"source": source_id, "ageHours": round(age_hours, 3), "maxSourceAgeHours": max_age_hours},
            )
        loaded[source_id] = {"decl": source, "manifest": manifest, "path": str(path), "ageHours": round(age_hours, 3)}
    return loaded


def selected_source(job: dict[str, Any], sources: dict[str, dict[str, Any]], pack: dict[str, Any]) -> dict[str, Any]:
    source_id = str(pack.get("source") or job.get("defaultSource") or next(iter(sources)))
    if source_id not in sources:
        fail("missing_source", f"pack references unknown source {source_id}", {"source": source_id})
    return sources[source_id]


def source_layers(source_manifest: dict[str, Any], layer_names: list[str]) -> dict[str, Any]:
    available = source_manifest.get("layers") or {}
    layers: dict[str, Any] = {}
    for layer in layer_names:
        if layer not in available:
            fail("missing_layer", f"source does not contain layer {layer}", {"layer": layer})
        layers[layer] = copy.deepcopy(available[layer])
    return layers


def source_tier(source_manifest: dict[str, Any], tier_id: str, override: dict[str, Any] | None = None) -> dict[str, Any]:
    if override:
        return copy.deepcopy(override)
    tiers = source_manifest.get("tiers") or {}
    if tier_id not in tiers:
        fail("missing_tier", f"source does not contain tier {tier_id}", {"tier": tier_id})
    return copy.deepcopy(tiers[tier_id])


def build_chunks(pack: dict[str, Any], layer_names: list[str], valid_times: list[str], tier_id: str) -> dict[str, Any]:
    chunk_specs = pack.get("chunks")
    if not isinstance(chunk_specs, list) or not chunk_specs:
        fail("invalid_pack", f"pack {pack.get('profile')} must declare chunks")
    chunks: dict[str, Any] = {}
    for spec in chunk_specs:
        if not isinstance(spec, dict):
            fail("invalid_chunk", "chunk specs must be objects")
        layers = spec.get("layers") or spec.get("layer") or layer_names
        if isinstance(layers, str):
            layers = [layers]
        times = spec.get("validTimes") or spec.get("validTime") or valid_times
        if isinstance(times, str):
            times = [times]
        bbox = spec.get("bbox")
        if not isinstance(bbox, list) or len(bbox) != 4:
            fail("invalid_chunk", "chunk spec bbox must be [west,south,east,north]")
        anchor = str(spec.get("anchor") or f"{bbox[0]}_{bbox[1]}")
        explicit_chunk_key = spec.get("chunkKey")
        if explicit_chunk_key and (len(layers) > 1 or len(times) > 1):
            fail(
                "invalid_chunk",
                "explicit chunkKey can only be used with exactly one layer and one validTime",
                {"chunkKey": explicit_chunk_key},
            )
        for layer in layers:
            if layer not in layer_names:
                fail("invalid_chunk", f"chunk references layer outside pack: {layer}", {"layer": layer})
            for valid_time in times:
                if valid_time not in valid_times:
                    fail("invalid_chunk", f"chunk references validTime outside modelRun: {valid_time}")
                time_id = valid_time.replace("-", "").replace(":", "")
                chunk_key = str(explicit_chunk_key or f"{tier_id}/{layer}/{time_id}/{anchor}")
                if chunk_key in chunks:
                    fail("duplicate_chunk_key", f"duplicate chunk key: {chunk_key}", {"chunkKey": chunk_key})
                chunks[chunk_key] = {
                    "schema": "helm.env.grid.chunk.v1",
                    "layer": layer,
                    "tier": tier_id,
                    "validTime": valid_time,
                    "bbox": bbox,
                }
    return chunks


def translate_env_grid_failure(exc: SystemExit, context: str) -> None:
    raw = str(exc)
    message = raw
    if raw.startswith("env-grid-pack: "):
        message = raw.split("env-grid-pack: ", 1)[1]
    candidate = message.split(":", 1)[0].strip()
    if "float16 fixture packing is not implemented" in message:
        candidate = "unsupported_band_type"
    code = candidate if candidate in ENV_GRID_FAILURE_CODES else "pack_verification_failed"
    fail(code, f"{context}: {message}", {"context": context})


# ---- WX-36: open-meteo live source adapter -----------------------------------
# Fetches real model values ONCE per factory run and attaches them to the pack's
# chunks as bandValues (quantized by env_grid_pack per the band metadata). The
# COMMERCIAL hosts are the only defaults — the free host burst-limits and
# silently starves grids (the warm_region lesson); a keyless or rate-limited run
# FAILS LOUD instead of publishing holes. Any failed batch aborts the bake.

OPENMETEO_FORECAST_HOST = "https://customer-api.open-meteo.com"
OPENMETEO_MARINE_HOST = "https://customer-marine-api.open-meteo.com"
OPENMETEO_BATCH = 140                      # points per API call
OPENMETEO_LAYERS = {
    # layer -> host kind, hourly vars, band shape. Units are SI per contract §5:
    # forecast wind/gust request wind_speed_unit=ms; marine current arrives km/h -> /3.6.
    "wind":     {"host": "forecast", "vars": ["wind_speed_10m", "wind_direction_10m"], "kind": "vector_from"},
    "gust":     {"host": "forecast", "vars": ["wind_gusts_10m"], "kind": "scalar"},
    "rain":     {"host": "forecast", "vars": ["precipitation"], "kind": "scalar"},
    "temp":     {"host": "forecast", "vars": ["temperature_2m"], "kind": "scalar"},
    "pressure": {"host": "forecast", "vars": ["pressure_msl"], "kind": "scalar"},
    "clouds":   {"host": "forecast", "vars": ["cloud_cover"], "kind": "scalar"},
    "cape":     {"host": "forecast", "vars": ["cape"], "kind": "scalar"},
    "waves":    {"host": "marine", "vars": ["wave_height"], "kind": "scalar"},
    "swell":    {"host": "marine", "vars": ["swell_wave_height"], "kind": "scalar"},
    "sst":      {"host": "marine", "vars": ["sea_surface_temperature"], "kind": "scalar"},
    "current":  {"host": "marine", "vars": ["ocean_current_velocity", "ocean_current_direction"],
                 "kind": "vector_to", "speed_div": 3.6},
}


def openmeteo_api_key(decl: dict[str, Any]) -> str:
    env_name = str(decl.get("apiKeyEnv") or "HELM_WX_OPENMETEO_KEY")
    key = os.environ.get(env_name, "").strip()
    if not key:
        fail(
            "missing_credentials",
            f"open-meteo adapter requires the commercial API key in ${env_name}; "
            "the free host is not a fallback (it burst-limits into silent holes)",
            {"apiKeyEnv": env_name},
        )
    return key


def openmeteo_hosts(decl: dict[str, Any]) -> dict[str, str]:
    # Overrides exist for the mock-upstream tests; production jobs omit them and
    # get the commercial hosts. api.open-meteo.com is deliberately NEVER a default.
    return {
        "forecast": str(decl.get("forecastHost") or OPENMETEO_FORECAST_HOST).rstrip("/"),
        "marine": str(decl.get("marineHost") or OPENMETEO_MARINE_HOST).rstrip("/"),
    }


def chunk_grid_points(manifest: dict[str, Any], chunk: dict[str, Any]) -> tuple[dict[str, Any], list[tuple[float, float]]]:
    grid = env_grid_pack.chunk_grid(manifest, chunk)
    bbox = chunk["bbox"]
    west, north = float(bbox[0]), float(bbox[3])
    points: list[tuple[float, float]] = []
    for row in range(grid["height"]):                    # row 0 = north (grid.origin northwest)
        lat = north - row * grid["dy"]
        for col in range(grid["width"]):
            lon = west + col * grid["dx"]
            lon = ((lon + 180.0) % 360.0) - 180.0        # API wants [-180, 180); unwrapped route bboxes normalize per point
            points.append((round(lat, 6), round(lon, 6)))
    return grid, points


def openmeteo_time_key(valid_time: str) -> str:
    return str(valid_time).replace("Z", "")[:16]         # API hourly time is 'YYYY-MM-DDTHH:MM' in UTC


def openmeteo_fetch_batch(url: str, attempt_limit: int = 3) -> list[dict[str, Any]]:
    last_error: Exception | None = None
    for attempt in range(attempt_limit):
        try:
            with urllib.request.urlopen(url, timeout=90) as resp:
                payload = json.loads(resp.read().decode("utf-8"))
            return payload if isinstance(payload, list) else [payload]
        except urllib.error.HTTPError as exc:
            if exc.code in (401, 402, 403):
                fail("missing_credentials", f"open-meteo rejected the API key (HTTP {exc.code})", {"status": exc.code})
            if exc.code == 429:
                fail("rate_limited", "open-meteo rate-limited the bake (HTTP 429) — aborting, no partial pack", {"status": 429})
            last_error = exc
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, OSError) as exc:
            last_error = exc
        if attempt < attempt_limit - 1:
            time.sleep(1.0 + attempt * 2.0)
    fail(
        "source_fetch_failed",
        f"open-meteo batch failed after {attempt_limit} attempts: {last_error}",
        {"error": str(last_error)},
    )


def openmeteo_fetch_grid(host: str, api_path: str, points: list[tuple[float, float]], hourly_vars: list[str],
                         valid_times: list[str], key: str, extra: dict[str, str], concurrency: int) -> list[dict[str, dict[str, float]]]:
    """Fetch hourly vars for every grid point; returns per-point {var: {timeKey: value}}.

    ONE call per <=140-point batch returns ALL hours and ALL vars for that host —
    frames are free; calls scale with points only. Every batch must succeed.
    """
    dates = sorted({str(t)[:10] for t in valid_times})
    time_keys = [openmeteo_time_key(t) for t in valid_times]
    urls = []
    for start in range(0, len(points), OPENMETEO_BATCH):
        batch = points[start:start + OPENMETEO_BATCH]
        params = {
            "latitude": ",".join(str(lat) for lat, _ in batch),
            "longitude": ",".join(str(lon) for _, lon in batch),
            "hourly": ",".join(hourly_vars),
            "start_date": dates[0],
            "end_date": dates[-1],
            "timezone": "UTC",
            "apikey": key,
        }
        params.update(extra)
        urls.append((start, len(batch), f"{host}{api_path}?{urllib.parse.urlencode(params)}"))
    results: list[dict[str, dict[str, float]] | None] = [None] * len(points)
    def run_one(entry):
        start, count, url = entry
        rows = openmeteo_fetch_batch(url)
        if len(rows) != count:
            fail("source_fetch_failed", f"open-meteo returned {len(rows)} points for a {count}-point batch", {"url_points": count})
        for offset, row in enumerate(rows):
            hourly = row.get("hourly") or {}
            times = hourly.get("time") or []
            index_of = {str(t)[:16]: i for i, t in enumerate(times)}
            per_var: dict[str, dict[str, float]] = {}
            for var in hourly_vars:
                series = hourly.get(var)
                if not isinstance(series, list) or len(series) != len(times):
                    fail("source_fetch_failed", f"open-meteo response missing hourly.{var}", {"var": var})
                values: dict[str, float] = {}
                for tk in time_keys:
                    if tk not in index_of:
                        fail("missing_valid_time", f"open-meteo hourly data has no entry for {tk}", {"validTime": tk, "var": var})
                    values[tk] = series[index_of[tk]]
                per_var[var] = values
            results[start + offset] = per_var
    with concurrent.futures.ThreadPoolExecutor(max_workers=max(1, concurrency)) as pool:
        for future in [pool.submit(run_one, entry) for entry in urls]:
            future.result()                              # any batch failure aborts the whole bake
    return results  # type: ignore[return-value]


def openmeteo_band_values(cfg: dict[str, Any], band_ids: list[str], grid_values: list[dict[str, dict[str, float]]],
                          time_key: str) -> dict[str, list]:
    kind = cfg["kind"]
    speed_div = float(cfg.get("speed_div", 1.0))
    if kind == "scalar":
        var = cfg["vars"][0]
        vals = []
        for per_var in grid_values:
            v = per_var[var].get(time_key)
            vals.append(None if v is None else float(v) / speed_div)
        return {band_ids[0]: vals}
    # vector: derive u/v from speed+direction. Wind direction is FROM (meteorological,
    # sign -1); ocean-current direction is TOWARD (oceanographic, sign +1) — matches
    # services/wx and the WX-19/WX-33 renderers.
    sign = -1.0 if kind == "vector_from" else 1.0
    speed_var, dir_var = cfg["vars"][0], cfg["vars"][1]
    us: list = []
    vs: list = []
    for per_var in grid_values:
        speed = per_var[speed_var].get(time_key)
        direction = per_var[dir_var].get(time_key)
        if speed is None or direction is None:
            us.append(None)
            vs.append(None)
            continue
        spd = float(speed) / speed_div
        rad = math.radians(float(direction))
        us.append(sign * spd * math.sin(rad))
        vs.append(sign * spd * math.cos(rad))
    if "u" not in band_ids or "v" not in band_ids:
        fail("bad_band_values", f"vector layer must declare u/v bands, has {band_ids}")
    return {"u": us, "v": vs}


def openmeteo_populate(source: dict[str, Any], manifest: dict[str, Any]) -> dict[str, int]:
    """Attach real bandValues to every chunk in the pack manifest. Returns call stats."""
    decl = source["decl"]
    key = openmeteo_api_key(decl)
    hosts = openmeteo_hosts(decl)
    concurrency = int(decl.get("concurrency", 6))
    valid_times = list(manifest["run"]["validTimes"])
    layers = manifest["layers"]
    chunks = manifest["chunks"]

    # Group needed hourly vars per host, then fetch each host ONCE per unique point
    # set — hourly responses carry every frame, so frames add zero calls.
    host_vars: dict[str, list[str]] = {"forecast": [], "marine": []}
    for chunk in chunks.values():
        layer = chunk["layer"]
        cfg = OPENMETEO_LAYERS.get(layer)
        if cfg is None:
            fail("unsupported_layer", f"open-meteo adapter has no mapping for layer {layer}", {"layer": layer})
        for var in cfg["vars"]:
            if var not in host_vars[cfg["host"]]:
                host_vars[cfg["host"]].append(var)

    fetched: dict[tuple, list[dict[str, dict[str, float]]]] = {}
    calls = {"forecast": 0, "marine": 0}
    for chunk_key in sorted(chunks):
        chunk = chunks[chunk_key]
        cfg = OPENMETEO_LAYERS[chunk["layer"]]
        host_kind = cfg["host"]
        _grid, points = chunk_grid_points(manifest, chunk)
        cache_key = (host_kind, tuple(points))
        if cache_key not in fetched:
            api_path = "/v1/forecast" if host_kind == "forecast" else "/v1/marine"
            extra = {"wind_speed_unit": "ms"} if host_kind == "forecast" else {}
            fetched[cache_key] = openmeteo_fetch_grid(
                hosts[host_kind], api_path, points, host_vars[host_kind], valid_times, key, extra, concurrency)
            calls[host_kind] += (len(points) + OPENMETEO_BATCH - 1) // OPENMETEO_BATCH
        band_ids = list((layers.get(chunk["layer"]) or {}).get("bands", {}).keys())
        chunk["bandValues"] = openmeteo_band_values(
            cfg, band_ids, fetched[cache_key], openmeteo_time_key(chunk["validTime"]))
    return calls


def build_pack_manifest(job: dict[str, Any], pack: dict[str, Any], source: dict[str, Any]) -> dict[str, Any]:
    source_manifest = source["manifest"]
    model_run = job["modelRun"]
    # Split-horizon: a pack may declare its own validTimes (a subset of the modelRun
    # envelope, validated in validate_job). This flows into both build_chunks and the
    # manifest run.validTimes, so openmeteo_populate asks this pack's single host for
    # exactly this pack's horizon — the forecast pack gets 16d, the marine pack 10d.
    valid_times = list(pack.get("validTimes") or model_run["validTimes"])
    layer_names = list(pack.get("layers") or source_manifest.get("layers", {}).keys())
    tier_id = str(pack.get("tier") or pack.get("profile") or "global-low")
    profile = str(pack.get("profile") or tier_id)
    anchor = str(pack.get("anchor") or ("global" if profile == "global-low" else "route"))
    pack_id = str(pack.get("packId") or f"{model_run['provider']}/{model_run['model']}/{model_run['runTime']}/{profile}/{anchor}")

    source_decl = source["decl"]
    coverage = copy.deepcopy(pack.get("coverage") or source_manifest.get("coverage") or {})
    if not coverage:
        fail("invalid_pack", f"pack {profile} must declare coverage")
    tier = source_tier(source_manifest, tier_id, pack.get("tierSpec"))
    layers = source_layers(source_manifest, layer_names)
    chunks = build_chunks(pack, layer_names, valid_times, tier_id)
    generated_at = job.get("generatedAt") or now_utc()

    return {
        "schema": "helm.env.grid.pack.v1",
        "encoding": "helm.env.grid.v1",
        "packId": pack_id,
        "productFamily": "met-ocean",
        "generatedAt": generated_at,
        "source": {
            "provider": source_decl.get("provider") or source_manifest.get("source", {}).get("provider") or model_run["provider"],
            "model": model_run["model"],
            "advisoryOnly": bool(source_decl.get("advisoryOnly", True)),
            "notForNavigation": bool(source_decl.get("notForNavigation", True)),
            "license": source_decl.get("license", "source-controlled"),
            "provenance": source_decl.get("provenance", source_manifest.get("source", {}).get("provenance", "pack-factory source")),
        },
        "run": {
            "runTime": model_run["runTime"],
            "validTimes": valid_times,
            "timeStepSeconds": int(model_run.get("timeStepSeconds", 10800)),
        },
        "transport": {
            "container": "pmtiles",
            "payload": "helm.env.grid.chunk.v1",
            "rangeReadable": True,
            "servedBy": "helm-envd",   # WX-26: envd serves manifest chunks to the cockpit (packd stays basemap-only)
            "requiredRuntime": "C++",
            "byteRangeSemantics": "offset-length",
            "checksumAlgorithm": "sha256",
        },
        "coverage": coverage,
        "tiers": {tier_id: tier},
        "layers": layers,
        "chunks": chunks,
        "failurePolicy": copy.deepcopy(job.get("failurePolicy") or FAILURE_POLICY),
        "renderContract": copy.deepcopy(source_manifest.get("renderContract") or {}),
        "serviceBoundaries": {
            "packServing": "helm-packd",
            "runtimeEnvService": "helm-envd",
            "cloudPackFactory": "optional-cloud-vm-r2",
            "requiredRuntime": "C++",
            "pythonRole": "cloud-job-reference-tooling-not-boat-daemon",
        },
    }


def pack_manifest(manifest: dict[str, Any], out_pack: Path, out_manifest: Path) -> None:
    chunks_obj = manifest.get("chunks")
    if not isinstance(chunks_obj, dict) or not chunks_obj:
        fail("invalid_pack", "manifest must contain chunks")
    out_pack.parent.mkdir(parents=True, exist_ok=True)
    chunk_items = sorted(chunks_obj.items())
    chunk_bytes = []
    try:
        for chunk_key, chunk in chunk_items:
            chunk_bytes.append(env_grid_pack.make_chunk(manifest, chunk_key, chunk))
        data_offset, _data_length = env_grid_pack.write_pmtiles_shell(out_pack, manifest, chunk_bytes)
    except SystemExit as exc:
        translate_env_grid_failure(exc, f"packing {out_pack.name}")
    for _chunk_key, chunk in chunk_items:
        chunk.pop("bandValues", None)                  # values are IN the pack; never in the manifest JSON
    packed = copy.deepcopy(manifest)
    offset = data_offset
    for (chunk_key, _chunk), blob in zip(chunk_items, chunk_bytes):
        packed["chunks"][chunk_key]["byteRange"] = [offset, len(blob)]
        packed["chunks"][chunk_key]["checksum"] = "sha256:" + hashlib.sha256(blob).hexdigest()
        offset += len(blob)
    packed["transport"]["packUrl"] = out_pack.name
    packed["transport"]["byteRangeSemantics"] = "offset-length"
    packed["transport"]["checksumAlgorithm"] = "sha256"
    out_manifest.write_text(stable_json(packed), encoding="utf-8")
    sidecar_out = out_pack.with_suffix(".metadata.json")
    sidecar_out.write_text(
        stable_json(env_grid_pack.public_sidecar(packed, out_pack.name, generated_by="scripts/wx_pack_factory.py")),
        encoding="utf-8",
    )
    for chunk_key, chunk in sorted(packed["chunks"].items()):
        try:
            env_grid_pack.verify_chunk(chunk_key, chunk, out_pack)
        except SystemExit as exc:
            translate_env_grid_failure(exc, f"verifying {out_pack.name}")


def relative(path: Path, base: Path) -> str:
    return str(path.relative_to(base)).replace(os.sep, "/")


def build_release(job: dict[str, Any], sources: dict[str, dict[str, Any]], staging: Path, release_id: str) -> dict[str, Any]:
    packs_dir = staging / "packs"
    release_packs: list[dict[str, Any]] = []
    seen_pack_names: set[str] = set()
    for pack in job["packs"]:
        if not isinstance(pack, dict):
            fail("invalid_pack", "pack entries must be objects")
        source = selected_source(job, sources, pack)
        manifest = build_pack_manifest(job, pack, source)
        if str(source["decl"].get("type") or "manifest") == "open-meteo":
            calls = openmeteo_populate(source, manifest)
            print(json.dumps({"openMeteoCalls": calls, "packId": manifest["packId"]}), file=sys.stderr)
        profile_slug = slug(str(pack.get("profile") or pack.get("tier") or "pack"))
        anchor_slug = slug(str(pack.get("anchor") or manifest["packId"]))
        pack_name = f"{release_id}-{profile_slug}-{anchor_slug}.pmtiles"
        if pack_name in seen_pack_names:
            fail("duplicate_pack_name", f"duplicate pack output name: {pack_name}", {"packName": pack_name})
        seen_pack_names.add(pack_name)
        pack_path = packs_dir / pack_name
        manifest_path = packs_dir / f"{pack_name}.manifest.json"
        pack_manifest(manifest, pack_path, manifest_path)
        packed_manifest = load_json(manifest_path)
        pack_size = pack_path.stat().st_size
        manifest_size = manifest_path.stat().st_size
        sidecar_size = pack_path.with_suffix(".metadata.json").stat().st_size
        release_packs.append({
            "packId": packed_manifest["packId"],
            "profile": pack.get("profile") or pack.get("tier"),
            "tier": next(iter(packed_manifest["tiers"])),
            "packUrl": relative(pack_path, staging),
            "manifestUrl": relative(manifest_path, staging),
            "sidecarUrl": relative(pack_path.with_suffix(".metadata.json"), staging),
            "sizeBytes": pack_size,
            "manifestBytes": manifest_size,
            "sidecarBytes": sidecar_size,
            "totalDownloadBytes": pack_size + manifest_size,
            "chunkCount": len(packed_manifest.get("chunks") or {}),
            "layers": sorted((packed_manifest.get("layers") or {}).keys()),
            "validTimes": packed_manifest.get("run", {}).get("validTimes", []),
            "coverage": packed_manifest.get("coverage", {}),
            "source": packed_manifest.get("source", {}),
            "checksums": {
                "packSha256": hashlib.sha256(pack_path.read_bytes()).hexdigest(),
                "manifestSha256": hashlib.sha256(manifest_path.read_bytes()).hexdigest(),
            },
        })
    total_bytes = sum(pack["totalDownloadBytes"] for pack in release_packs)
    return {
        "schema": RELEASE_SCHEMA,
        "releaseId": release_id,
        "generatedAt": job.get("generatedAt") or now_utc(),
        "modelRun": copy.deepcopy(job["modelRun"]),
        "noSurpriseDownloads": True,
        "networkPolicy": "forbidden-unless-explicit-cloud-worker",
        "refresh": {
            "atomic": True,
            "strategy": "write-complete-release-then-atomically-repoint-current",
        },
        "failurePolicy": copy.deepcopy(job.get("failurePolicy") or FAILURE_POLICY),
        "sources": [
            {
                "id": source_id,
                "type": data["decl"].get("type"),
                "provider": data["decl"].get("provider"),
                "generatedAt": data["decl"].get("generatedAt") or data["manifest"].get("generatedAt"),
                "ageHours": data["ageHours"],
                "provenance": data["decl"].get("provenance", data["manifest"].get("source", {}).get("provenance")),
            }
            for source_id, data in sorted(sources.items())
        ],
        "packs": release_packs,
        "totals": {
            "packs": len(release_packs),
            "chunks": sum(pack["chunkCount"] for pack in release_packs),
            "totalDownloadBytes": total_bytes,
        },
    }


def ensure_no_png_payloads(release_dir: Path) -> None:
    pngs = [path for path in release_dir.rglob("*") if path.suffix.lower() == ".png"]
    if pngs:
        fail("png_payload_forbidden", "pack factory emitted PNG payloads", {"paths": [str(p) for p in pngs]})


def publish_command(args: argparse.Namespace) -> int:
    job_path = Path(args.job)
    job = load_json(job_path)
    validate_job(job)
    base = job_path.parent
    out = Path(args.out)
    sources = load_sources(job, base, allow_network=bool(args.allow_network), replay_clock=bool(args.replay_clock))
    release_id = release_id_for(job)
    staging = out / ".staging" / f"{release_id}.{int(time.time() * 1000)}"
    final = out / "releases" / release_id
    if final.exists() and not args.replace:
        fail("release_exists", f"release already exists: {release_id}", {"releaseId": release_id})
    if staging.exists():
        shutil.rmtree(staging)
    staging.mkdir(parents=True)
    backup: Path | None = None
    try:
        release = build_release(job, sources, staging, release_id)
        atomic_write_json(staging / "index.json", release)
        ensure_no_png_payloads(staging)
        if final.exists():
            backup = out / "releases" / f".{release_id}.previous.{int(time.time() * 1000)}"
            if backup.exists():
                shutil.rmtree(backup)
            os.replace(final, backup)
        final.parent.mkdir(parents=True, exist_ok=True)
        try:
            os.replace(staging, final)
        except BaseException:
            if backup is not None and backup.exists() and not final.exists():
                os.replace(backup, final)
            raise
        current = {
            "schema": "helm.wx.pack_factory.current.v1",
            "releaseId": release_id,
            "indexUrl": f"releases/{release_id}/index.json",
            "generatedAt": release["generatedAt"],
            "modelRun": release["modelRun"],
            "totals": release["totals"],
        }
        try:
            atomic_write_json(out / "current.json", current)
        except BaseException:
            failed = out / "releases" / f".{release_id}.failed.{int(time.time() * 1000)}"
            if final.exists():
                os.replace(final, failed)
            if backup is not None and backup.exists():
                os.replace(backup, final)
            raise
        if backup is not None and backup.exists():
            shutil.rmtree(backup)
    except BaseException:
        if staging.exists():
            shutil.rmtree(staging)
        if backup is not None and backup.exists() and not final.exists():
            os.replace(backup, final)
        raise
    print(stable_json({"releaseId": release_id, "index": str(final / "index.json"), "current": str(out / "current.json")}), end="")
    return 0


def inspect_command(args: argparse.Namespace) -> int:
    index = load_json(Path(args.index))
    if index.get("schema") != RELEASE_SCHEMA:
        fail("invalid_release", f"release schema must be {RELEASE_SCHEMA}", {"schema": index.get("schema")})
    print(stable_json({
        "releaseId": index.get("releaseId"),
        "packs": len(index.get("packs") or []),
        "chunks": index.get("totals", {}).get("chunks"),
        "totalDownloadBytes": index.get("totals", {}).get("totalDownloadBytes"),
        "noSurpriseDownloads": index.get("noSurpriseDownloads"),
    }), end="")
    return 0


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="cmd", required=True)
    publish = sub.add_parser("publish", help="materialize and atomically publish a release catalog")
    publish.add_argument("job")
    publish.add_argument("--out", required=True)
    publish.add_argument("--allow-network", action="store_true", help="permit adapters that require network")
    publish.add_argument("--replace", action="store_true", help="replace an existing release id")
    publish.add_argument(
        "--replay-clock",
        action="store_true",
        help="measure source freshness against job.generatedAt for deterministic fixture replay",
    )
    publish.set_defaults(func=publish_command)
    inspect = sub.add_parser("inspect", help="summarize a release index")
    inspect.add_argument("index")
    inspect.set_defaults(func=inspect_command)
    args = parser.parse_args(argv[1:])
    try:
        return int(args.func(args))
    except FactoryError as exc:
        payload = {"error": exc.code, "message": str(exc), "details": exc.details}
        print("wx-pack-factory: " + json.dumps(payload, sort_keys=True), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
