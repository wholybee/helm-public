#!/usr/bin/env python3
"""FALLBACK-1 Leg B contract assertions (importable + CLI + selftest).

Given a directory of captured helm-server chart-route responses (headers + tile bytes +
recorded status codes), prove the render fallback contract:

  * renderer selection works (legacy vs Vulkan adapter),
  * the Vulkan response carries a self-consistent output SHA, a cache key, the renderer SHA,
    and an ETag,
  * the Vulkan tile is deterministic and supports 304 revalidation,
  * a Vulkan failure with ``?fallback=legacy`` yields an EXPLICIT legacy fallback (a visible
    ``X-Helm-Renderer-Fallback`` header, image bytes), and
  * a Vulkan failure WITHOUT ``?fallback=legacy`` surfaces as an error (never a silent tile).

This is the safety fallback / regression bridge for the chart render path -- NOT the WebGPU
browser path. ``scripts/fallback-1-proof.sh`` captures the responses and calls
``assert_contract``. ``--selftest`` fabricates synthetic PASS + tampered-FAIL corpora so the
contract logic itself is verified with no GPU, no server, and no network.
"""
from __future__ import annotations

import hashlib
import json
import os
import sys
import tempfile


class ContractError(AssertionError):
    """Raised when a captured response violates the FALLBACK-1 contract."""


def _parse_headers(path: str) -> dict:
    out: dict = {}
    with open(path, encoding="utf-8", errors="replace") as fh:
        for line in fh:
            if ":" in line and not line.startswith("HTTP/"):
                key, val = line.split(":", 1)
                out[key.strip().lower()] = val.strip()
    return out


def _sha256_file(path: str) -> str:
    with open(path, "rb") as fh:
        return hashlib.sha256(fh.read()).hexdigest()


def _read_text(path: str) -> str:
    with open(path, encoding="utf-8", errors="replace") as fh:
        return fh.read().strip()


def _check(cond: bool, msg: str) -> None:
    if not cond:
        raise ContractError(msg)


def assert_contract(server_dir: str, renderer_sha: str) -> dict:
    """Validate the captured responses in ``server_dir``. Returns a summary dict.

    Raises :class:`ContractError` on the first violation.
    """
    legacy_h = _parse_headers(os.path.join(server_dir, "legacy-headers.txt"))
    vulkan_h = _parse_headers(os.path.join(server_dir, "vulkan-headers.txt"))
    vulkan2_h = _parse_headers(os.path.join(server_dir, "vulkan2-headers.txt"))
    fb_h = _parse_headers(os.path.join(server_dir, "fallback-headers.txt"))
    nosilent_h = _parse_headers(os.path.join(server_dir, "nosilent-headers.txt"))

    legacy_sha = _sha256_file(os.path.join(server_dir, "legacy-tile.png"))
    vulkan_sha = _sha256_file(os.path.join(server_dir, "vulkan-tile.png"))
    vulkan2_sha = _sha256_file(os.path.join(server_dir, "vulkan2-tile.png"))
    fb_sha = _sha256_file(os.path.join(server_dir, "fallback-tile.png"))
    not_modified = _read_text(os.path.join(server_dir, "vulkan-304.txt"))
    nosilent_status = _read_text(os.path.join(server_dir, "nosilent-status.txt"))

    # B1: legacy renderer selection + PNG content type + ETag; legacy must NOT expose a renderer SHA.
    _check(legacy_h.get("x-helm-renderer") == "legacy",
           f"legacy X-Helm-Renderer={legacy_h.get('x-helm-renderer')!r}")
    _check((legacy_h.get("content-type") or "").startswith("image/png"),
           f"legacy content-type={legacy_h.get('content-type')!r}")
    _check(bool(legacy_h.get("etag")), "legacy missing ETag")
    _check("x-helm-renderer-sha" not in legacy_h,
           "legacy unexpectedly exposed X-Helm-Renderer-Sha")

    # B2: Vulkan renderer selection + output SHA integrity + cache key + renderer SHA + ETag.
    _check(vulkan_h.get("x-helm-renderer") == "vulkan",
           f"vulkan X-Helm-Renderer={vulkan_h.get('x-helm-renderer')!r}")
    _check(vulkan_h.get("x-helm-renderer-output-sha") == vulkan_sha,
           f"vulkan output-sha header {vulkan_h.get('x-helm-renderer-output-sha')} != body sha {vulkan_sha}")
    _check(bool(vulkan_h.get("x-helm-renderer-cache-key")), "vulkan missing X-Helm-Renderer-Cache-Key")
    _check(vulkan_h.get("x-helm-renderer-sha") == renderer_sha,
           f"vulkan X-Helm-Renderer-Sha={vulkan_h.get('x-helm-renderer-sha')!r} != {renderer_sha!r}")
    _check(bool(vulkan_h.get("etag")), "vulkan missing ETag")

    # B3: determinism (same fixture -> same bytes + same ETag) and 304 revalidation.
    _check(vulkan_sha == vulkan2_sha, f"vulkan not deterministic: {vulkan_sha} != {vulkan2_sha}")
    _check(vulkan_h.get("etag") == vulkan2_h.get("etag"), "vulkan ETag not stable across requests")
    _check(not_modified == "304", f"conditional GET expected 304, got {not_modified}")

    # B4: EXPLICIT fallback -> legacy tile + visible fallback markers (never silent).
    _check(fb_h.get("x-helm-renderer") == "legacy",
           f"fallback X-Helm-Renderer={fb_h.get('x-helm-renderer')!r}")
    _check(fb_h.get("x-helm-renderer-fallback") == "vulkan-render-failed",
           f"fallback marker={fb_h.get('x-helm-renderer-fallback')!r}")
    _check((fb_h.get("content-type") or "").startswith("image/png"),
           f"fallback content-type={fb_h.get('content-type')!r}")

    # B5: WITHOUT explicit fallback, a Vulkan failure MUST surface as an error, not a silent tile.
    _check(nosilent_status != "200",
           f"silent fallback detected: Vulkan failure returned 200 ({nosilent_status})")
    _check((nosilent_h.get("content-type") or "").startswith("text/plain") or nosilent_status.startswith("5"),
           f"non-fallback Vulkan failure did not surface as an error "
           f"(status={nosilent_status}, ct={nosilent_h.get('content-type')!r})")

    return {
        "legacy": {"renderer": legacy_h.get("x-helm-renderer"),
                   "etag": legacy_h.get("etag"), "sha256": legacy_sha},
        "vulkan": {"renderer": vulkan_h.get("x-helm-renderer"),
                   "renderer_sha": vulkan_h.get("x-helm-renderer-sha"),
                   "cache_key": vulkan_h.get("x-helm-renderer-cache-key"),
                   "output_sha": vulkan_h.get("x-helm-renderer-output-sha"),
                   "etag": vulkan_h.get("etag"),
                   "deterministic": vulkan_sha == vulkan2_sha,
                   "revalidation_304": not_modified == "304",
                   "sha256": vulkan_sha},
        "explicit_fallback": {"renderer": fb_h.get("x-helm-renderer"),
                              "fallback": fb_h.get("x-helm-renderer-fallback"),
                              "sha256": fb_sha},
        "no_silent_fallback": {"status": nosilent_status,
                               "content_type": nosilent_h.get("content-type"),
                               "renderer_error": nosilent_h.get("x-helm-renderer-error")},
    }


# --------------------------------------------------------------------------- selftest
def _write_headers(path: str, pairs: dict) -> None:
    with open(path, "w", encoding="utf-8") as fh:
        fh.write("HTTP/1.1 200 OK\n")
        for key, val in pairs.items():
            fh.write(f"{key}: {val}\n")


def _make_pass_corpus(server_dir: str, renderer_sha: str) -> None:
    """Fabricate a set of responses that satisfy the full contract."""
    legacy_png = b"\x89PNG\r\n\x1a\nLEGACY-TILE-BYTES"
    vulkan_png = b"\x89PNG\r\n\x1a\nVULKAN-TILE-BYTES"
    fb_png = b"\x89PNG\r\n\x1a\nFALLBACK-LEGACY-TILE"
    for name, blob in (("legacy-tile.png", legacy_png),
                       ("vulkan-tile.png", vulkan_png),
                       ("vulkan2-tile.png", vulkan_png),
                       ("fallback-tile.png", fb_png)):
        with open(os.path.join(server_dir, name), "wb") as fh:
            fh.write(blob)
    vulkan_sha = hashlib.sha256(vulkan_png).hexdigest()
    vulkan_etag = 'vulkan:' + hashlib.sha256(b"cache-key").hexdigest()

    _write_headers(os.path.join(server_dir, "legacy-headers.txt"), {
        "Content-Type": "image/png",
        "X-Helm-Renderer": "legacy",
        "ETag": '"US5GA2BC.day.std.s12000"',
        "Cache-Control": "public, max-age=31536000, immutable",
    })
    _write_headers(os.path.join(server_dir, "vulkan-headers.txt"), {
        "Content-Type": "image/png",
        "X-Helm-Renderer": "vulkan",
        "X-Helm-Renderer-Sha": renderer_sha,
        "X-Helm-Renderer-Cache-Key": hashlib.sha256(b"cache-key").hexdigest(),
        "X-Helm-Renderer-Output-Sha": vulkan_sha,
        "ETag": vulkan_etag,
    })
    _write_headers(os.path.join(server_dir, "vulkan2-headers.txt"), {
        "Content-Type": "image/png",
        "X-Helm-Renderer": "vulkan",
        "X-Helm-Renderer-Output-Sha": vulkan_sha,
        "ETag": vulkan_etag,
    })
    _write_headers(os.path.join(server_dir, "fallback-headers.txt"), {
        "Content-Type": "image/png",
        "X-Helm-Renderer": "legacy",
        "X-Helm-Renderer-Fallback": "vulkan-render-failed",
        "X-Helm-Renderer-Error": "fallback-1: forced Vulkan renderer failure",
    })
    _write_headers(os.path.join(server_dir, "nosilent-headers.txt"), {
        "Content-Type": "text/plain",
        "Cache-Control": "no-store",
        "X-Helm-Renderer-Error": "fallback-1: forced Vulkan renderer failure",
    })
    with open(os.path.join(server_dir, "vulkan-304.txt"), "w") as fh:
        fh.write("304\n")
    with open(os.path.join(server_dir, "nosilent-status.txt"), "w") as fh:
        fh.write("500\n")


def _selftest() -> int:
    renderer_sha = "selftest-renderer-sha"

    # 1) PASS corpus must validate cleanly.
    with tempfile.TemporaryDirectory() as d:
        _make_pass_corpus(d, renderer_sha)
        summary = assert_contract(d, renderer_sha)
        assert summary["vulkan"]["revalidation_304"] is True
        assert summary["explicit_fallback"]["fallback"] == "vulkan-render-failed"
    print("ok selftest: PASS corpus validates")

    # 2) Each tampered corpus must be caught (the contract has teeth).
    def tamper(mutate) -> bool:
        with tempfile.TemporaryDirectory() as d:
            _make_pass_corpus(d, renderer_sha)
            mutate(d)
            try:
                assert_contract(d, renderer_sha)
            except ContractError:
                return True
            return False

    def silent_fallback(d):  # Vulkan failure without ?fallback silently returned a 200 tile
        _write_headers(os.path.join(d, "nosilent-headers.txt"), {"Content-Type": "image/png"})
        with open(os.path.join(d, "nosilent-status.txt"), "w") as fh:
            fh.write("200\n")

    def missing_fallback_header(d):  # legacy served but no visible fallback marker
        _write_headers(os.path.join(d, "fallback-headers.txt"), {
            "Content-Type": "image/png", "X-Helm-Renderer": "legacy"})

    def output_sha_mismatch(d):  # Vulkan output SHA header lies about the bytes
        _write_headers(os.path.join(d, "vulkan-headers.txt"), {
            "Content-Type": "image/png", "X-Helm-Renderer": "vulkan",
            "X-Helm-Renderer-Sha": renderer_sha,
            "X-Helm-Renderer-Cache-Key": "abc",
            "X-Helm-Renderer-Output-Sha": "deadbeef", "ETag": "vulkan:x"})

    def legacy_mislabeled(d):  # legacy tile mislabeled as vulkan
        _write_headers(os.path.join(d, "legacy-headers.txt"), {
            "Content-Type": "image/png", "X-Helm-Renderer": "vulkan",
            "ETag": '"c.day.std.s1"'})

    def no_304(d):  # revalidation did not return 304
        with open(os.path.join(d, "vulkan-304.txt"), "w") as fh:
            fh.write("200\n")

    cases = {
        "silent_fallback": silent_fallback,
        "missing_fallback_header": missing_fallback_header,
        "output_sha_mismatch": output_sha_mismatch,
        "legacy_mislabeled": legacy_mislabeled,
        "no_304": no_304,
    }
    for name, mutate in cases.items():
        if not tamper(mutate):
            print(f"FAIL selftest: contract did NOT catch tampered case {name!r}", file=sys.stderr)
            return 1
        print(f"ok selftest: caught tampered case {name!r}")

    print("ok fallback1-assert selftest: all cases pass")
    return 0


def main(argv: list) -> int:
    if len(argv) >= 2 and argv[1] == "--selftest":
        return _selftest()
    if len(argv) < 3:
        print("usage: fallback1-assert.py <server_dir> <renderer_sha>", file=sys.stderr)
        print("       fallback1-assert.py --selftest", file=sys.stderr)
        return 2
    server_dir, renderer_sha = argv[1], argv[2]
    summary = assert_contract(server_dir, renderer_sha)
    out = os.path.join(server_dir, "summary.json")
    with open(out, "w") as fh:
        json.dump(summary, fh, indent=2)
    print("ok fallback-1 Leg B: selection + headers + ETag/304 + explicit & non-silent fallback proven")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
