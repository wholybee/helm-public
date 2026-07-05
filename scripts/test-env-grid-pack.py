#!/usr/bin/env python3
"""WX-32 smoke tests for range-readable helm.env.grid.v1 packs."""

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
FIXTURE = ROOT / "services" / "wx" / "fixtures" / "helm-env-grid-v1.json"
PACKER = ROOT / "scripts" / "env_grid_pack.py"
CHECKER = ROOT / "scripts" / "check-env-grid-v1.py"
PACK_SERVER = ROOT / "pipeline" / "mbtiles_server.py"


def run(*args: str, expect_ok: bool = True) -> subprocess.CompletedProcess[str]:
    proc = subprocess.run(args, cwd=ROOT, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    if expect_ok and proc.returncode != 0:
        raise AssertionError(f"command failed {args!r}\n{proc.stdout}")
    if not expect_ok and proc.returncode == 0:
        raise AssertionError(f"command unexpectedly succeeded {args!r}\n{proc.stdout}")
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
        except Exception as exc:  # noqa: BLE001 - this is a startup poll in a smoke test.
            last = exc
            time.sleep(0.05)
    raise AssertionError(f"server did not become ready at {url}: {last}")


def assert_reference_server_serves_range(tmp: Path, pack: Path, manifest: Path) -> None:
    doc = json.loads(manifest.read_text(encoding="utf-8"))
    chunk = next(iter(doc["chunks"].values()))
    offset, length = chunk["byteRange"]
    port = free_port()
    env = os.environ.copy()
    env["HELM_MBTILES_DIR"] = str(tmp)
    env["HELM_BIND"] = "127.0.0.1"
    proc = subprocess.Popen(
        [sys.executable, str(PACK_SERVER), str(port)],
        cwd=ROOT,
        env=env,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
    )
    try:
        catalog = wait_json(f"http://127.0.0.1:{port}/catalog")
        rec = catalog.get(pack.stem)
        assert rec, catalog
        assert rec["kind"] == "environmental-grid"
        assert rec["payload"] == "helm.env.grid.chunk.v1"
        assert rec["chunk_count"] == 1
        req = urllib.request.Request(
            f"http://127.0.0.1:{port}/{pack.stem}.pmtiles",
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


def main() -> int:
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        pack = tmp / "fixture.pmtiles"
        manifest = tmp / "fixture.manifest.json"
        run(sys.executable, str(PACKER), "pack", str(FIXTURE), str(pack), "--manifest-out", str(manifest))
        run(sys.executable, str(CHECKER), str(manifest))
        run(sys.executable, str(PACKER), "verify", str(manifest), str(pack))

        doc = json.loads(manifest.read_text(encoding="utf-8"))
        assert doc["transport"]["payload"] == "helm.env.grid.chunk.v1"
        assert doc["transport"]["byteRangeSemantics"] == "offset-length"
        assert pack.with_suffix(".metadata.json").exists()
        assert_reference_server_serves_range(tmp, pack, manifest)

        chunk_key = next(iter(doc["chunks"]))
        doc["chunks"][chunk_key]["byteRange"][1] += 1
        broken = tmp / "broken-range.manifest.json"
        broken.write_text(json.dumps(doc), encoding="utf-8")
        failed = run(sys.executable, str(PACKER), "verify", str(broken), str(pack), expect_ok=False)
        assert "missing_range" in failed.stdout

        doc = json.loads(manifest.read_text(encoding="utf-8"))
        doc["chunks"][chunk_key]["checksum"] = "sha256:" + ("0" * 64)
        broken_checksum = tmp / "broken-checksum.manifest.json"
        broken_checksum.write_text(json.dumps(doc), encoding="utf-8")
        failed = run(sys.executable, str(PACKER), "verify", str(broken_checksum), str(pack), expect_ok=False)
        assert "checksum_mismatch" in failed.stdout

        doc = json.loads(manifest.read_text(encoding="utf-8"))
        doc["chunks"][chunk_key]["checksum"] = "sha256:fixture"
        placeholder = tmp / "placeholder-checksum.manifest.json"
        placeholder.write_text(json.dumps(doc), encoding="utf-8")
        failed = run(sys.executable, str(CHECKER), str(placeholder), expect_ok=False)
        assert "must declare sha256 checksum" in failed.stdout

    print("test-env-grid-pack: ok")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
