#!/usr/bin/env python3
"""Contract tests for the WX-20 C++ helm-envd daemon.

The Python weather service remains a reference/oracle while the required boat
runtime moves to small C++ services. This test pins the first helm-envd parity
slice: local-only grid-pack inventory, validated byte-range chunk serving,
privacy, and fail-loud diagnostics for broken chunks/capabilities.

Set HELM_ENVD_BIN to the built binary, for example:

    HELM_ENVD_BIN=/private/tmp/helm-wx20-opencpn/build/cli/helm-envd \
      python3 pipeline/test_helm_envd_contract.py
"""

from __future__ import annotations

import hashlib
import json
import os
import socket
import struct
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Callable


ROOT = Path(__file__).resolve().parents[1]
FIXTURE = ROOT / "services" / "wx" / "fixtures" / "helm-env-grid-v1.json"
PACKER = ROOT / "scripts" / "env_grid_pack.py"
MAGIC = b"HELMGRID"


def free_port() -> int:
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    sock.close()
    return port


def run(*args: str) -> subprocess.CompletedProcess[str]:
    proc = subprocess.run(args, cwd=ROOT, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    if proc.returncode != 0:
        raise AssertionError(f"command failed {args!r}\n{proc.stdout}")
    return proc


def request_json(url: str) -> tuple[int, dict[str, Any]]:
    with urllib.request.urlopen(url, timeout=2) as resp:
        return resp.status, json.loads(resp.read().decode("utf-8"))


def request_bytes(url: str, method: str = "GET") -> tuple[int, bytes, dict[str, str]]:
    req = urllib.request.Request(url, method=method)
    with urllib.request.urlopen(req, timeout=2) as resp:
        return resp.status, resp.read(), dict(resp.headers.items())


def http_error_json(url: str) -> tuple[int, dict[str, Any]]:
    try:
        request_json(url)
    except urllib.error.HTTPError as exc:
        return exc.code, json.loads(exc.read().decode("utf-8"))
    raise AssertionError(f"expected HTTPError for {url}")


def quote(value: str) -> str:
    return urllib.parse.quote(value, safe="")


def make_pack(tmp: Path, stem: str = "fixture") -> tuple[Path, Path]:
    pack = tmp / f"{stem}.pmtiles"
    manifest = tmp / f"{stem}.manifest.json"
    run(sys.executable, str(PACKER), "pack", str(FIXTURE), str(pack), "--manifest-out", str(manifest))
    return pack, manifest


def read_manifest(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def write_manifest(path: Path, doc: dict[str, Any]) -> None:
    path.write_text(json.dumps(doc, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def chunk_key_and_range(manifest: Path) -> tuple[str, int, int]:
    doc = read_manifest(manifest)
    chunk_key = next(iter(doc["chunks"]))
    offset, length = doc["chunks"][chunk_key]["byteRange"]
    return chunk_key, int(offset), int(length)


def set_chunk_bytes(pack: Path, manifest: Path, blob: bytes) -> None:
    doc = read_manifest(manifest)
    chunk_key, offset, length = chunk_key_and_range(manifest)
    body = pack.read_bytes()
    pack.write_bytes(body[:offset] + blob + body[offset + length :])
    doc["chunks"][chunk_key]["byteRange"] = [offset, len(blob)]
    doc["chunks"][chunk_key]["checksum"] = "sha256:" + hashlib.sha256(blob).hexdigest()
    write_manifest(manifest, doc)


def mutate_chunk_bytes(pack: Path, manifest: Path, old: bytes, new: bytes) -> None:
    if len(old) != len(new):
        raise AssertionError("test fixture mutation must preserve chunk length")
    _chunk_key, offset, length = chunk_key_and_range(manifest)
    body = pack.read_bytes()
    chunk_body = body[offset : offset + length]
    if old not in chunk_body:
        raise AssertionError(f"{old!r} not found in HELMGRID chunk")
    set_chunk_bytes(pack, manifest, chunk_body.replace(old, new, 1))


def rewrite_chunk_header(pack: Path, manifest: Path, mutate: Callable[[dict[str, Any]], None]) -> None:
    _chunk_key, offset, length = chunk_key_and_range(manifest)
    body = pack.read_bytes()
    chunk_body = body[offset : offset + length]
    if not chunk_body.startswith(MAGIC):
        raise AssertionError("fixture chunk missing HELMGRID magic")
    version, flags, header_len = struct.unpack_from("<HHI", chunk_body, len(MAGIC))
    header_start = len(MAGIC) + 8
    header_end = header_start + header_len
    header = json.loads(chunk_body[header_start:header_end].decode("utf-8"))
    mutate(header)
    header_bytes = json.dumps(header, sort_keys=True, separators=(",", ":")).encode("utf-8")
    rewritten = MAGIC + struct.pack("<HHI", version, flags, len(header_bytes)) + header_bytes + chunk_body[header_end:]
    set_chunk_bytes(pack, manifest, rewritten)


def corrupt_chunk_bytes_without_manifest_update(pack: Path, manifest: Path) -> None:
    _chunk_key, offset, length = chunk_key_and_range(manifest)
    body = bytearray(pack.read_bytes())
    if length < 32:
        raise AssertionError("fixture chunk unexpectedly small")
    body[offset + length - 1] ^= 0x01
    pack.write_bytes(bytes(body))


class EnvdProcess:
    def __init__(self, binary: Path, manifest: Path):
        self.port = free_port()
        env = os.environ.copy()
        env["HELM_ENV_GRID_MANIFESTS"] = str(manifest)
        env["HELM_BIND"] = "127.0.0.1"
        self.proc = subprocess.Popen(
            [str(binary), str(self.port)],
            cwd=str(ROOT),
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
        )
        deadline = time.time() + 5
        last: Exception | None = None
        while time.time() < deadline:
            if self.proc.poll() is not None:
                out = self.proc.stdout.read() if self.proc.stdout else ""
                raise AssertionError(f"helm-envd exited early with {self.proc.returncode}: {out}")
            try:
                status, data = request_json(self.url("/health"))
                if status == 200 and data.get("engine") == "helm-envd":
                    return
            except (OSError, urllib.error.URLError, json.JSONDecodeError) as exc:
                last = exc
                time.sleep(0.05)
        raise AssertionError(f"helm-envd did not become ready: {last}")

    def url(self, path: str) -> str:
        return f"http://127.0.0.1:{self.port}{path}"

    def close(self) -> None:
        self.proc.terminate()
        try:
            self.proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self.proc.kill()
        if self.proc.stdout:
            self.proc.stdout.close()


class HelmEnvdContractTest(unittest.TestCase):
    def setUp(self) -> None:
        if not os.environ.get("HELM_ENVD_BIN"):
            raise AssertionError("set HELM_ENVD_BIN to the built helm-envd binary")
        self.bin = Path(os.environ["HELM_ENVD_BIN"])
        if not self.bin.exists() or not os.access(self.bin, os.X_OK):
            raise AssertionError(f"HELM_ENVD_BIN is not executable: {self.bin}")
        self.tmp = tempfile.TemporaryDirectory()
        self.tmp_path = Path(self.tmp.name)
        self.pack, self.manifest = make_pack(self.tmp_path)
        self.doc = read_manifest(self.manifest)
        self.chunk_key = next(iter(self.doc["chunks"]))
        self.chunk = self.doc["chunks"][self.chunk_key]
        self.server = EnvdProcess(self.bin, self.manifest)

    def tearDown(self) -> None:
        self.server.close()
        self.tmp.cleanup()

    def chunk_url(self, pack_id: str | None = None, chunk_key: str | None = None) -> str:
        return self.server.url(
            f"/chunk?pack={quote(pack_id or self.doc['packId'])}&chunk={quote(chunk_key or self.chunk_key)}"
        )

    def inventory_codes(self) -> list[str]:
        _, inventory = request_json(self.server.url("/packs"))
        return [diag["code"] for diag in inventory["packs"][0]["diagnostics"]]

    def restart(self) -> None:
        self.server.close()
        self.server = EnvdProcess(self.bin, self.manifest)

    def test_health_inventory_and_chunk_serving_are_local_only(self) -> None:
        status, health = request_json(self.server.url("/health"))
        self.assertEqual(status, 200)
        self.assertEqual(health["status"], "ok")
        self.assertEqual(health["engine"], "helm-envd")
        self.assertEqual(health["packs"], 1)
        self.assertEqual(health["errors"], 0)
        self.assertTrue(health["cacheOnlyReplay"])
        self.assertFalse(health["providerFetchDuringGestureAllowed"])

        status, inventory = request_json(self.server.url("/packs"))
        self.assertEqual(status, 200)
        self.assertEqual(inventory["schema"], "helm.envd.inventory.v1")
        self.assertEqual(inventory["status"], "ok")
        self.assertEqual(inventory["packCount"], 1)
        self.assertFalse(inventory["providerFetchDuringGestureAllowed"])
        self.assertFalse(inventory["pngFallbackAllowed"])
        self.assertNotIn(self.tmp.name, json.dumps(inventory))

        rec = inventory["packs"][0]
        self.assertEqual(rec["packId"], self.doc["packId"])
        self.assertEqual(rec["status"], "ready")
        self.assertEqual(rec["schema"], "helm.env.grid.pack.v1")
        self.assertEqual(rec["encoding"], "helm.env.grid.v1")
        self.assertIn("wind", rec["layers"])
        self.assertIn("global-low", rec["tiers"])
        self.assertEqual(rec["chunkCount"], 1)
        self.assertEqual(rec["diagnostics"], [])

        status, body, headers = request_bytes(self.chunk_url())
        self.assertEqual(status, 200)
        self.assertTrue(body.startswith(MAGIC))
        self.assertEqual(len(body), self.chunk["byteRange"][1])
        self.assertEqual(headers["X-Helm-Env-Pack-Id"], self.doc["packId"])
        self.assertEqual(headers["X-Helm-Env-Chunk-Key"], self.chunk_key)

        status, head_body, head_headers = request_bytes(self.chunk_url(), method="HEAD")
        self.assertEqual(status, 200)
        self.assertEqual(head_body, b"")
        self.assertEqual(int(head_headers["Content-Length"]), self.chunk["byteRange"][1])
        self.assertEqual(head_headers["X-Helm-Env-Chunk-Key"], self.chunk_key)

    def test_missing_chunk_fails_loud(self) -> None:
        status, err = http_error_json(self.chunk_url(chunk_key="missing"))
        self.assertEqual(status, 404)
        self.assertEqual(err["error"], "missing_chunk")

    def test_pack_level_errors_block_all_chunks(self) -> None:
        doc = read_manifest(self.manifest)
        doc["transport"]["container"] = "directory"
        write_manifest(self.manifest, doc)
        self.restart()

        self.assertIn("unsupported_container", self.inventory_codes())
        status, err = http_error_json(self.chunk_url())
        self.assertEqual(status, 409)
        self.assertEqual(err["error"], "invalid_pack")

    def test_huge_byte_range_fails_loud_without_serving_or_crashing(self) -> None:
        doc = read_manifest(self.manifest)
        doc["chunks"][self.chunk_key]["byteRange"] = [self.chunk["byteRange"][0], 2**40]
        write_manifest(self.manifest, doc)
        self.restart()

        self.assertIn("chunk_too_large", self.inventory_codes())
        status, err = http_error_json(self.chunk_url())
        self.assertEqual(status, 409)
        self.assertEqual(err["error"], "invalid_chunk")

        status, health = request_json(self.server.url("/health"))
        self.assertEqual(status, 200)
        self.assertEqual(health["engine"], "helm-envd")

    def test_missing_pack_id_inventory_does_not_leak_absolute_paths(self) -> None:
        doc = read_manifest(self.manifest)
        del doc["packId"]
        write_manifest(self.manifest, doc)
        self.restart()

        _, inventory = request_json(self.server.url("/packs"))
        text = json.dumps(inventory)
        self.assertNotIn(str(self.tmp_path), text)
        self.assertNotIn("/private/", text)
        self.assertTrue(inventory["packs"][0]["packId"].startswith("manifest:"))

    def test_bad_checksum_marks_pack_error_and_blocks_chunk(self) -> None:
        doc = read_manifest(self.manifest)
        doc["chunks"][self.chunk_key]["checksum"] = "sha256:" + ("0" * 64)
        write_manifest(self.manifest, doc)
        self.restart()

        status, health = request_json(self.server.url("/health"))
        self.assertEqual(status, 200)
        self.assertEqual(health["status"], "error")
        self.assertEqual(health["errors"], 1)

        self.assertIn("checksum_mismatch", self.inventory_codes())
        status, err = http_error_json(self.chunk_url())
        self.assertEqual(status, 409)
        self.assertEqual(err["error"], "invalid_chunk")

    def test_pack_rewrite_after_startup_fails_request_time_checksum(self) -> None:
        corrupt_chunk_bytes_without_manifest_update(self.pack, self.manifest)
        status, err = http_error_json(self.chunk_url())
        self.assertEqual(status, 409)
        self.assertEqual(err["error"], "checksum_mismatch")

    def test_unsupported_compression_fails_loud_without_checksum_noise(self) -> None:
        mutate_chunk_bytes(self.pack, self.manifest, b'"compression":"none"', b'"compression":"zstd"')
        self.restart()

        codes = self.inventory_codes()
        self.assertIn("unsupported_compression", codes)
        self.assertNotIn("checksum_mismatch", codes)

    def test_non_string_compression_fails_loud_without_checksum_noise(self) -> None:
        rewrite_chunk_header(self.pack, self.manifest, lambda header: header.__setitem__("compression", False))
        self.restart()

        codes = self.inventory_codes()
        self.assertIn("bad_chunk_compression", codes)
        self.assertNotIn("checksum_mismatch", codes)

    def test_bad_endianness_fails_loud_without_checksum_noise(self) -> None:
        rewrite_chunk_header(self.pack, self.manifest, lambda header: header.__setitem__("endianness", "big"))
        self.restart()

        codes = self.inventory_codes()
        self.assertIn("unsupported_endianness", codes)
        self.assertNotIn("checksum_mismatch", codes)

    def test_unsupported_grid_origin_fails_loud_without_checksum_noise(self) -> None:
        mutate_chunk_bytes(self.pack, self.manifest, b'"origin":"northwest"', b'"origin":"southwest"')
        self.restart()

        codes = self.inventory_codes()
        self.assertIn("unsupported_grid_origin", codes)
        self.assertNotIn("checksum_mismatch", codes)

    def test_non_string_grid_origin_fails_loud_without_checksum_noise(self) -> None:
        rewrite_chunk_header(self.pack, self.manifest, lambda header: header["grid"].__setitem__("origin", False))
        self.restart()

        codes = self.inventory_codes()
        self.assertIn("bad_grid_origin", codes)
        self.assertNotIn("checksum_mismatch", codes)


if __name__ == "__main__":
    unittest.main(verbosity=2)
