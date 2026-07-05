#!/usr/bin/env python3
"""WX-36 tests: the open-meteo pack-factory adapter against a MOCK upstream.

Zero live network — a local HTTP server plays Open-Meteo and returns
deterministic values, so quantization round-trips are asserted against known
physics. Fail-loud paths (no network permission, missing key, failed batch,
rate limit) are asserted by error code, and a failed bake must leave no release.
"""

from __future__ import annotations

import json
import math
import os
import struct
import subprocess
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

ROOT = Path(__file__).resolve().parents[1]
FACTORY = ROOT / "scripts" / "wx_pack_factory.py"
SOURCE_SPEC = ROOT / "services" / "wx" / "fixtures" / "wx-openmeteo-source.json"

VALID_TIMES = ["2026-07-01T00:00:00Z", "2026-07-01T03:00:00Z"]
HOURS = ["2026-07-01T00:00", "2026-07-01T03:00"]


# Deterministic mock physics — the round-trip assertions recompute these.
def mock_value(var: str, lat: float, lon: float, hour_index: int) -> float:
    base = {
        "wind_speed_10m": 10.0, "wind_direction_10m": 90.0, "precipitation": 1.0,
        "wave_height": 2.0, "swell_wave_height": 1.5,
        "ocean_current_velocity": 3.6, "ocean_current_direction": 180.0,
    }[var]
    if var.endswith("_direction") or var == "wind_direction_10m":
        return (base + 10.0 * hour_index) % 360.0
    return base + 0.1 * abs(lat) + 0.01 * abs(lon) + hour_index


class MockOpenMeteo(BaseHTTPRequestHandler):
    fail_batches: int = 0          # respond 500 to this many requests
    status_code: int | None = None  # force a status for every request
    requests_seen: list = []

    def do_GET(self):  # noqa: N802 - http.server API
        cls = type(self)
        cls.requests_seen.append(self.path)
        if cls.status_code is not None:
            self.send_response(cls.status_code)
            self.end_headers()
            return
        if cls.fail_batches > 0:
            cls.fail_batches -= 1
            self.send_response(500)
            self.end_headers()
            return
        query = parse_qs(urlparse(self.path).query)
        lats = [float(v) for v in query["latitude"][0].split(",")]
        lons = [float(v) for v in query["longitude"][0].split(",")]
        hourly_vars = query["hourly"][0].split(",")
        rows = []
        for lat, lon in zip(lats, lons):
            hourly = {"time": HOURS}
            for var in hourly_vars:
                hourly[var] = [mock_value(var, lat, lon, i) for i in range(len(HOURS))]
            rows.append({"latitude": lat, "longitude": lon, "hourly": hourly})
        body = json.dumps(rows if len(rows) > 1 else rows[0]).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_args):  # keep test output clean
        pass


def start_server() -> tuple[ThreadingHTTPServer, str]:
    server = ThreadingHTTPServer(("127.0.0.1", 0), MockOpenMeteo)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, f"http://127.0.0.1:{server.server_address[1]}"


def make_job(host: str, tmp: Path, layers: list[str]) -> Path:
    # 2.0 x 1.0 deg @ 0.5 -> 5x3 = 15 points; crosses the antimeridian on purpose.
    bbox = [179.0, -18.0, 181.0, -17.0]
    job = {
        "schema": "helm.wx.pack_factory.job.v1",
        "generatedAt": "2026-07-01T00:10:00Z",
        "maxSourceAgeHours": 24,
        "modelRun": {
            "provider": "open-meteo", "model": "gfs-seamless",
            "runTime": VALID_TIMES[0], "validTimes": VALID_TIMES, "timeStepSeconds": 10800,
        },
        "sources": [{
            "id": "om", "type": "open-meteo", "path": str(SOURCE_SPEC),
            "generatedAt": "2026-07-01T00:10:00Z",
            "forecastHost": host, "marineHost": host,
            "license": "unit-test", "provenance": "mock upstream",
        }],
        "packs": [{
            "profile": "route-high", "tier": "route-high", "anchor": "test",
            "layers": layers,
            "tierSpec": {"role": "passage", "crs": "OGC:CRS84", "grid": {"dx": 0.5, "dy": 0.5}, "clientZoomRange": [4, 10]},
            "coverage": {"crs": "OGC:CRS84", "global": False, "bbox": bbox, "wrap": "antimeridian", "crossesAntimeridian": True},
            "chunks": [{"bbox": bbox}],
        }],
    }
    path = tmp / "job.json"
    path.write_text(json.dumps(job, indent=2, sort_keys=True), encoding="utf-8")
    return path


def run_factory(job: Path, out: Path, *extra: str, env_overrides: dict | None = None,
                expect_ok: bool = True) -> subprocess.CompletedProcess:
    env = os.environ.copy()
    env["HELM_WX_OPENMETEO_KEY"] = "test-key"
    env.update(env_overrides or {})
    env = {k: v for k, v in env.items() if v is not None}
    proc = subprocess.run(
        [sys.executable, str(FACTORY), "publish", str(job), "--out", str(out),
         "--replay-clock", "--allow-network", *extra],
        cwd=ROOT, text=True, capture_output=True, env=env,
    )
    if expect_ok and proc.returncode != 0:
        raise AssertionError(f"factory failed unexpectedly:\n{proc.stdout}\n{proc.stderr}")
    if not expect_ok and proc.returncode == 0:
        raise AssertionError(f"factory unexpectedly succeeded:\n{proc.stdout}\n{proc.stderr}")
    return proc


def error_code(proc: subprocess.CompletedProcess) -> str:
    for line in proc.stderr.splitlines():
        if line.startswith("wx-pack-factory: "):
            return json.loads(line.split(": ", 1)[1])["error"]
    raise AssertionError(f"no factory error line in stderr:\n{proc.stderr}")


def decode_chunk(release_dir: Path, manifest: dict, chunk_key: str) -> dict[str, list[float]]:
    chunk = manifest["chunks"][chunk_key]
    offset, length = chunk["byteRange"]
    pack_path = release_dir / "packs" / manifest["transport"]["packUrl"]
    blob = pack_path.read_bytes()[offset:offset + length]
    assert blob.startswith(b"HELMGRID")
    _version, _flags, header_len = struct.unpack_from("<HHI", blob, 8)
    header = json.loads(blob[16:16 + header_len].decode("utf-8"))
    assert header["grid"]["origin"] == "northwest"
    payload = blob[16 + header_len:]
    cells = header["grid"]["width"] * header["grid"]["height"]
    out: dict[str, list[float]] = {}
    pos = 0
    for band_id, band in header["bands"].items():
        fmt = "<h" if band["type"] == "int16" else "<H"
        vals = []
        for i in range(cells):
            stored = struct.unpack_from(fmt, payload, pos + i * 2)[0]
            vals.append(float("nan") if stored == band["nodata"] else stored * band["scale"] + band["offset"])
        out[band_id] = vals
        pos += cells * 2
    return out


def grid_latlon(header_bbox, dx, width, height):
    west, _s, _e, north = header_bbox
    pts = []
    for row in range(height):
        for col in range(width):
            lon = west + col * dx
            pts.append((north - row * dx, ((lon + 180.0) % 360.0) - 180.0))
    return pts


def main() -> int:
    checks = 0
    server, host = start_server()
    try:
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)

            # 1) happy path: real values fetched, quantized, packed, verified — antimeridian bbox
            MockOpenMeteo.requests_seen = []
            job = make_job(host, tmp, ["wind", "rain", "waves", "swell", "current"])
            out = tmp / "pub"
            run_factory(job, out)
            current = json.loads((out / "current.json").read_text(encoding="utf-8"))
            release_dir = out / "releases" / current["releaseId"]
            release = json.loads((release_dir / "index.json").read_text(encoding="utf-8"))
            pack = release["packs"][0]
            manifest = json.loads((release_dir / pack["manifestUrl"]).read_text(encoding="utf-8"))
            assert pack["sizeBytes"] > 0 and pack["chunkCount"] == 10, pack["chunkCount"]  # 5 layers x 2 times
            assert "bandValues" not in json.dumps(manifest), "values must never leak into the manifest"
            checks += 1

            # 2) quantization round-trip against the mock physics (wind u/v at frame 1)
            key = "route-high/wind/20260701T030000Z/179.0_-18.0"
            bands = decode_chunk(release_dir, manifest, key)
            hdr_bbox = manifest["chunks"][key]["bbox"]
            pts = grid_latlon(hdr_bbox, 0.5, 5, 3)
            for i, (lat, lon) in enumerate(pts):
                speed = mock_value("wind_speed_10m", lat, lon, 1)
                direction = mock_value("wind_direction_10m", lat, lon, 1)
                exp_u = -speed * math.sin(math.radians(direction))
                exp_v = -speed * math.cos(math.radians(direction))
                assert abs(bands["u"][i] - exp_u) <= 0.005 + 1e-9, (i, bands["u"][i], exp_u)
                assert abs(bands["v"][i] - exp_v) <= 0.005 + 1e-9
            checks += 1

            # 3) current: TOWARD direction sign + km/h -> m/s conversion
            keyc = "route-high/current/20260701T000000Z/179.0_-18.0"
            cur = decode_chunk(release_dir, manifest, keyc)
            lat0, lon0 = pts[0]
            spd = mock_value("ocean_current_velocity", lat0, lon0, 0) / 3.6
            dir0 = mock_value("ocean_current_direction", lat0, lon0, 0)
            assert abs(cur["u"][0] - spd * math.sin(math.radians(dir0))) <= 0.0005 + 1e-9
            assert abs(cur["v"][0] - spd * math.cos(math.radians(dir0))) <= 0.0005 + 1e-9
            checks += 1

            # 4) frames are free: one fetch per host per point set (15 pts -> 1 batch x 2 hosts)
            assert len(MockOpenMeteo.requests_seen) == 2, MockOpenMeteo.requests_seen
            assert not any("api.open-meteo.com" in r for r in MockOpenMeteo.requests_seen)
            checks += 1

            # 5) network permission gate: no --allow-network -> network_forbidden... factory
            #    publish always passes it from wx_bake; here call WITHOUT the flag
            proc = subprocess.run(
                [sys.executable, str(FACTORY), "publish", str(job), "--out", str(tmp / "no-net"), "--replay-clock"],
                cwd=ROOT, text=True, capture_output=True,
                env={**os.environ, "HELM_WX_OPENMETEO_KEY": "test-key"})
            assert proc.returncode != 0
            assert error_code(proc) == "network_forbidden"
            checks += 1

            # 6) missing key fails loud BEFORE any fetch — free host is not a fallback
            MockOpenMeteo.requests_seen = []
            proc = run_factory(job, tmp / "no-key",
                               env_overrides={"HELM_WX_OPENMETEO_KEY": ""}, expect_ok=False)
            assert error_code(proc) == "missing_credentials"
            assert MockOpenMeteo.requests_seen == []
            checks += 1

            # 7) a failed batch aborts the bake — no release directory appears
            MockOpenMeteo.fail_batches = 99
            proc = run_factory(job, tmp / "batch-fail", expect_ok=False)
            MockOpenMeteo.fail_batches = 0
            assert error_code(proc) == "source_fetch_failed"
            assert not (tmp / "batch-fail" / "releases").exists()
            checks += 1

            # 8) 429 -> rate_limited, loud
            MockOpenMeteo.status_code = 429
            proc = run_factory(job, tmp / "rl", expect_ok=False)
            MockOpenMeteo.status_code = None
            assert error_code(proc) == "rate_limited"
            checks += 1

            # 9) bad key -> missing_credentials (401 from upstream)
            MockOpenMeteo.status_code = 401
            proc = run_factory(job, tmp / "badkey", expect_ok=False)
            MockOpenMeteo.status_code = None
            assert error_code(proc) == "missing_credentials"
            checks += 1
    finally:
        server.shutdown()
    print(f"wx-openmeteo-adapter: OK ({checks} checks)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
