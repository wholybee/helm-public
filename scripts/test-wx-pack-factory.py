#!/usr/bin/env python3
"""WX-34 smoke tests for the cloud/VM environmental pack factory."""

from __future__ import annotations

import json
import os
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
JOB = ROOT / "services" / "wx" / "fixtures" / "wx-pack-factory-job.json"
FACTORY = ROOT / "scripts" / "wx_pack_factory.py"
PACKER = ROOT / "scripts" / "env_grid_pack.py"
CHECKER = ROOT / "scripts" / "check-env-grid-v1.py"
PACK_SERVER = ROOT / "pipeline" / "mbtiles_server.py"


def run(*args: str, expect_ok: bool = True) -> subprocess.CompletedProcess[str]:
    proc = subprocess.run(args, cwd=ROOT, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    output = proc.stdout + proc.stderr
    if expect_ok and proc.returncode != 0:
        raise AssertionError(f"command failed {args!r}\n{output}")
    if not expect_ok and proc.returncode == 0:
        raise AssertionError(f"command unexpectedly succeeded {args!r}\n{output}")
    return proc


def free_port() -> int:
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    sock.close()
    return port


def wait_json(url: str) -> dict:
    deadline = time.time() + 5
    last = None
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=1) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except Exception as exc:  # noqa: BLE001 - startup polling.
            last = exc
            time.sleep(0.05)
    raise AssertionError(f"server did not become ready at {url}: {last}")


def assert_packd_range(release: dict, release_dir: Path) -> None:
    pack = release["packs"][0]
    manifest = json.loads((release_dir / pack["manifestUrl"]).read_text(encoding="utf-8"))
    chunk = next(iter(manifest["chunks"].values()))
    offset, length = chunk["byteRange"]
    port = free_port()
    env = os.environ.copy()
    env["HELM_MBTILES_DIR"] = str(release_dir / "packs")
    env["HELM_BIND"] = "127.0.0.1"
    proc = subprocess.Popen(
        [sys.executable, str(PACK_SERVER), str(port)],
        cwd=release_dir / "packs",
        env=env,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
    )
    try:
        catalog = wait_json(f"http://127.0.0.1:{port}/catalog")
        pack_stem = Path(pack["packUrl"]).stem
        assert catalog[pack_stem]["kind"] == "environmental-grid"
        req = urllib.request.Request(
            f"http://127.0.0.1:{port}/{pack_stem}.pmtiles",
            headers={"Range": f"bytes={offset}-{offset + length - 1}"},
        )
        with urllib.request.urlopen(req, timeout=2) as resp:
            body = resp.read()
            assert resp.status == 206
            assert body.startswith(b"HELMGRID")
            assert len(body) == length
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
        if proc.stdout:
            proc.stdout.close()


def copy_job(tmp: Path) -> Path:
    job = json.loads(JOB.read_text(encoding="utf-8"))
    job["sources"][0]["path"] = str(ROOT / "services" / "wx" / "fixtures" / "helm-env-grid-v1.json")
    target = tmp / "job.json"
    target.write_text(json.dumps(job, indent=2, sort_keys=True), encoding="utf-8")
    return target


def write_job(tmp: Path, name: str, job: dict) -> Path:
    path = tmp / name
    path.write_text(json.dumps(job, indent=2, sort_keys=True), encoding="utf-8")
    return path


def publish(job: Path, out: Path, *extra: str, expect_ok: bool = True) -> subprocess.CompletedProcess[str]:
    return run(sys.executable, str(FACTORY), "publish", str(job), "--out", str(out), *extra, expect_ok=expect_ok)


def main() -> int:
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        job = copy_job(tmp)
        out = tmp / "published"
        publish(job, out)
        current = json.loads((out / "current.json").read_text(encoding="utf-8"))
        release_dir = out / current["indexUrl"].rsplit("/", 1)[0]
        release = json.loads((out / current["indexUrl"]).read_text(encoding="utf-8"))

        assert current["releaseId"] == "synthetic-gfs-20260701T000000Z"
        assert release["schema"] == "helm.wx.pack_factory.release.v1"
        assert release["refresh"]["atomic"] is True
        assert release["noSurpriseDownloads"] is True
        assert release["totals"]["packs"] == 2
        assert release["totals"]["chunks"] == 6
        assert release["totals"]["totalDownloadBytes"] > 0
        assert not list(release_dir.rglob("*.png"))
        assert len({pack["packUrl"] for pack in release["packs"]}) == len(release["packs"])

        for pack in release["packs"]:
            manifest = release_dir / pack["manifestUrl"]
            archive = release_dir / pack["packUrl"]
            assert pack["sizeBytes"] == archive.stat().st_size
            assert pack["totalDownloadBytes"] == pack["sizeBytes"] + pack["manifestBytes"]
            run(sys.executable, str(CHECKER), str(manifest))
            run(sys.executable, str(PACKER), "verify", str(manifest), str(archive))
            sidecar = json.loads((release_dir / pack["sidecarUrl"]).read_text(encoding="utf-8"))
            assert sidecar["license"] == "unit-test-fixture"
            assert sidecar["source_provenance"] == "Synthetic WX-34 fixture; not for navigation"
            assert sidecar["generated_by"] == "scripts/wx_pack_factory.py"

        assert_packd_range(release, release_dir)

        summary = run(sys.executable, str(FACTORY), "inspect", str(out / current["indexUrl"]))
        assert '"packs": 2' in summary.stdout

        stale_job = json.loads(job.read_text(encoding="utf-8"))
        stale_job["sources"][0]["generatedAt"] = "2000-01-01T00:00:00Z"
        stale_job["sources"][0]["maxSourceAgeHours"] = 1
        stale_path = write_job(tmp, "stale-job.json", stale_job)
        failed = publish(stale_path, tmp / "stale", expect_ok=False)
        assert "stale_source" in failed.stderr

        missing_job = json.loads(job.read_text(encoding="utf-8"))
        missing_job["sources"][0]["path"] = "missing-env-grid-v1.json"
        missing_path = write_job(tmp, "missing-job.json", missing_job)
        failed = publish(missing_path, tmp / "missing", expect_ok=False)
        assert "missing_source" in failed.stderr

        network_job = json.loads(job.read_text(encoding="utf-8"))
        network_job["sources"][0]["type"] = "open-meteo"
        network_path = write_job(tmp, "network-job.json", network_job)
        failed = publish(network_path, tmp / "network", expect_ok=False)
        assert "network_forbidden" in failed.stderr

        duplicate_chunk_job = json.loads(job.read_text(encoding="utf-8"))
        duplicate_chunk_job["packs"][1]["chunks"].append(dict(duplicate_chunk_job["packs"][1]["chunks"][0]))
        duplicate_chunk_path = write_job(tmp, "duplicate-chunk-job.json", duplicate_chunk_job)
        failed = publish(duplicate_chunk_path, tmp / "duplicate-chunk", expect_ok=False)
        assert "duplicate_chunk_key" in failed.stderr

        explicit_multi_job = json.loads(job.read_text(encoding="utf-8"))
        explicit_multi_job["packs"][0]["chunks"][0]["chunkKey"] = "explicit-key-for-many-cells"
        explicit_multi_path = write_job(tmp, "explicit-multi-job.json", explicit_multi_job)
        failed = publish(explicit_multi_path, tmp / "explicit-multi", expect_ok=False)
        assert "invalid_chunk" in failed.stderr

        naive_time_job = json.loads(job.read_text(encoding="utf-8"))
        naive_time_job["modelRun"]["validTimes"][0] = "2026-07-01T00:00:00"
        naive_time_path = write_job(tmp, "naive-time-job.json", naive_time_job)
        failed = publish(naive_time_path, tmp / "naive-time", expect_ok=False)
        assert "invalid_time" in failed.stderr

        same_profile_job = json.loads(job.read_text(encoding="utf-8"))
        second_route = json.loads(json.dumps(same_profile_job["packs"][1]))
        second_route["anchor"] = "second-fiji-route"
        second_route["coverage"]["anchor"]["routeId"] = "fixture-fiji-2"
        second_route["chunks"][0]["anchor"] = "second-fiji-route"
        same_profile_job["packs"].append(second_route)
        same_profile_path = write_job(tmp, "same-profile-job.json", same_profile_job)
        same_profile_out = tmp / "same-profile"
        publish(same_profile_path, same_profile_out)
        same_profile_current = json.loads((same_profile_out / "current.json").read_text(encoding="utf-8"))
        same_profile_release = json.loads((same_profile_out / same_profile_current["indexUrl"]).read_text(encoding="utf-8"))
        assert same_profile_release["totals"]["packs"] == 3
        assert len({pack["packUrl"] for pack in same_profile_release["packs"]}) == 3

        # WX-38 split horizon: a pack may declare its own validTimes (a subset of the
        # modelRun envelope) so one release can carry two horizons. Here the route-high
        # pack takes only the first frame while global-low keeps the full run.
        subset_job = json.loads(job.read_text(encoding="utf-8"))
        first_time = subset_job["modelRun"]["validTimes"][0]
        subset_job["packs"][1]["validTimes"] = [first_time]
        for chunk in subset_job["packs"][1]["chunks"]:
            chunk.pop("validTimes", None)              # chunks inherit the pack's narrowed horizon (as the bake script builds them)
        subset_path = write_job(tmp, "subset-vt-job.json", subset_job)
        subset_out = tmp / "subset-vt"
        publish(subset_path, subset_out)
        subset_current = json.loads((subset_out / "current.json").read_text(encoding="utf-8"))
        subset_dir = subset_out / subset_current["indexUrl"].rsplit("/", 1)[0]
        subset_release = json.loads((subset_out / subset_current["indexUrl"]).read_text(encoding="utf-8"))
        by_profile = {pack["profile"]: pack for pack in subset_release["packs"]}
        assert by_profile["route-high"]["validTimes"] == [first_time]
        assert by_profile["global-low"]["validTimes"] == subset_job["modelRun"]["validTimes"]
        # release envelope stays the full modelRun; the per-pack horizon narrows independently
        assert subset_release["modelRun"]["validTimes"] == subset_job["modelRun"]["validTimes"]
        # the narrowed pack packs+verifies clean, and its chunk keys only carry its own frame
        subset_manifest = json.loads(
            (subset_dir / by_profile["route-high"]["manifestUrl"]).read_text(encoding="utf-8"))
        assert {chunk["validTime"] for chunk in subset_manifest["chunks"].values()} == {first_time}
        run(sys.executable, str(PACKER), "verify", str(subset_dir / by_profile["route-high"]["manifestUrl"]),
            str(subset_dir / by_profile["route-high"]["packUrl"]))

        # A pack validTime outside the modelRun envelope fails loud before any packing.
        outside_vt_job = json.loads(job.read_text(encoding="utf-8"))
        outside_vt_job["packs"][1]["validTimes"] = ["2026-07-01T06:00:00Z"]  # not one of the run's two frames
        outside_vt_path = write_job(tmp, "outside-vt-job.json", outside_vt_job)
        failed = publish(outside_vt_path, tmp / "outside-vt", expect_ok=False)
        assert "not in modelRun.validTimes" in failed.stderr

        # An empty per-pack validTimes list is rejected (would otherwise silently mean "all").
        empty_vt_job = json.loads(job.read_text(encoding="utf-8"))
        empty_vt_job["packs"][1]["validTimes"] = []
        empty_vt_path = write_job(tmp, "empty-vt-job.json", empty_vt_job)
        failed = publish(empty_vt_path, tmp / "empty-vt", expect_ok=False)
        assert "must be a non-empty list" in failed.stderr

        bad_source_manifest = json.loads((ROOT / "services" / "wx" / "fixtures" / "helm-env-grid-v1.json").read_text(encoding="utf-8"))
        bad_source_manifest["layers"]["wind"]["bands"]["u"]["type"] = "float16"
        bad_source_path = tmp / "bad-source.json"
        bad_source_path.write_text(json.dumps(bad_source_manifest), encoding="utf-8")
        bad_pack_job = json.loads(job.read_text(encoding="utf-8"))
        bad_pack_job["sources"][0]["path"] = str(bad_source_path)
        bad_pack_path = write_job(tmp, "bad-pack-job.json", bad_pack_job)
        bad_out = tmp / "bad-pack"
        failed = publish(bad_pack_path, bad_out, expect_ok=False)
        assert "unsupported_band_type" in failed.stderr
        assert "wx-pack-factory" in failed.stderr
        assert not list((bad_out / ".staging").glob("*")) if (bad_out / ".staging").exists() else True

        current_before = json.loads((out / "current.json").read_text(encoding="utf-8"))
        index_before = json.loads((out / current_before["indexUrl"]).read_text(encoding="utf-8"))
        bad_replace_job = json.loads(job.read_text(encoding="utf-8"))
        bad_replace_job["packs"][0]["layers"] = ["missing-layer"]
        bad_replace_path = write_job(tmp, "bad-replace-job.json", bad_replace_job)
        failed = publish(bad_replace_path, out, "--replace", expect_ok=False)
        assert "missing_layer" in failed.stderr
        current_after = json.loads((out / "current.json").read_text(encoding="utf-8"))
        index_after = json.loads((out / current_after["indexUrl"]).read_text(encoding="utf-8"))
        assert current_after == current_before
        assert index_after == index_before

    print("test-wx-pack-factory: ok")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
