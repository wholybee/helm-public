#!/usr/bin/env python3
"""Pack and verify helm.env.grid.v1 chunks in a range-readable PMTiles shell.

WX-32 uses PMTiles/packd as the archive/index/Range transport, but the bytes
inside are Helm environmental grid chunks, not rendered image tiles.
"""

from __future__ import annotations

import argparse
import copy
import gzip
import hashlib
import json
import struct
import sys
from pathlib import Path
from typing import Any


HEADER_LEN = 127
MAGIC = b"HELMGRID"


def fail(message: str) -> None:
    raise SystemExit(f"env-grid-pack: {message}")


def load_json(path: Path) -> dict[str, Any]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        fail(f"cannot read {path}: {exc}")
    if not isinstance(data, dict):
        fail(f"{path} must be a JSON object")
    return data


def stable_json_bytes(value: Any) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":")).encode("utf-8")


def chunk_grid(manifest: dict[str, Any], chunk: dict[str, Any]) -> dict[str, Any]:
    tier = manifest.get("tiers", {}).get(chunk.get("tier"), {})
    grid = tier.get("grid", {})
    bbox = chunk.get("bbox")
    if not isinstance(bbox, list) or len(bbox) != 4:
        fail(f"chunk {chunk.get('layer')} missing bbox")
    dx = float(grid.get("dx", 1.0))
    dy = float(grid.get("dy", 1.0))
    width = int(round((float(bbox[2]) - float(bbox[0])) / dx)) + 1
    height = int(round((float(bbox[3]) - float(bbox[1])) / dy)) + 1
    if width <= 0 or height <= 0:
        fail(f"chunk {chunk.get('layer')} has invalid grid dimensions")
    # WX-35: pin grid registration — row 0 = NORTH edge, col 0 = west (contract §6).
    return {"width": width, "height": height, "dx": dx, "dy": dy, "origin": "northwest"}


def quantize_band(values: list, band: dict[str, Any], cells: int, chunk_key: str, band_id: str) -> bytes:
    """Quantize REAL physical values (row-major, row 0 = north) into a stored band.

    WX-36: this is the real-data path. stored = round((physical - offset) / scale);
    None/NaN -> nodata. Values that quantize outside the representable range (or
    collide with the nodata sentinel) FAIL LOUD — a silently clamped storm is a
    placeholder by another name.
    """
    btype = str(band.get("type"))
    scale = float(band.get("scale", 1.0))
    offset = float(band.get("offset", 0.0))
    nodata = int(band.get("nodata", 0))
    if len(values) != cells:
        fail(f"bad_band_values: {chunk_key}/{band_id} has {len(values)} values, expected {cells}")
    if btype == "int16":
        lo, hi, fmt = -32768, 32767, "<h"
    elif btype == "uint16":
        lo, hi, fmt = 0, 65535, "<H"
    else:
        fail(f"unsupported band type for real values: {btype}")
    out = bytearray()
    for value in values:
        if value is None or (isinstance(value, float) and value != value):
            stored = nodata
        else:
            stored = round((float(value) - offset) / scale)
            if stored < lo or stored > hi or stored == nodata:
                fail(
                    f"quantization_overflow: {chunk_key}/{band_id} value {value} -> stored {stored} "
                    f"outside {btype} range (or nodata collision)"
                )
        out += struct.pack(fmt, stored)
    return bytes(out)


def make_payload(manifest: dict[str, Any], chunk_key: str, chunk: dict[str, Any]) -> bytes:
    layer = manifest.get("layers", {}).get(chunk.get("layer"), {})
    bands = layer.get("bands")
    if not isinstance(bands, dict) or not bands:
        fail(f"chunk {chunk_key} references layer without bands")
    grid = chunk_grid(manifest, chunk)
    cells = grid["width"] * grid["height"]
    band_values = chunk.get("bandValues")
    if isinstance(band_values, dict) and band_values:
        # WX-36 real-data path: every declared band must be provided — a missing band is a
        # hole, not a fixture to synthesize over.
        out = bytearray()
        for band_id, band in bands.items():
            if band_id not in band_values:
                fail(f"bad_band_values: {chunk_key} missing values for band {band_id}")
            out += quantize_band(band_values[band_id], band, cells, chunk_key, band_id)
        return bytes(out)
    seed = hashlib.sha256(chunk_key.encode("utf-8")).digest()
    out = bytearray()
    for band_index, (_band_id, band) in enumerate(bands.items()):
        btype = str(band.get("type"))
        nodata = int(band.get("nodata", 0))
        for idx in range(cells):
            raw = (seed[(idx + band_index) % len(seed)] + idx + band_index * 17) % 200
            value = raw - 100
            if btype == "uint16":
                value = raw
                out += struct.pack("<H", value)
            elif btype == "int16":
                if value == nodata:
                    value += 1
                out += struct.pack("<h", value)
            elif btype == "float16":
                # Python stdlib has no portable half-float pack before 3.11 in all targets;
                # keep the fixture deterministic and fail loud for production use.
                fail("float16 fixture packing is not implemented")
            elif btype == "float32":
                out += struct.pack("<f", float(value))
            else:
                fail(f"unsupported band type {btype}")
    return bytes(out)


def make_chunk(manifest: dict[str, Any], chunk_key: str, chunk: dict[str, Any]) -> bytes:
    layer = manifest.get("layers", {}).get(chunk.get("layer"), {})
    header = {
        "schema": "helm.env.grid.chunk.v1",
        "encoding": "helm.env.grid.v1",
        "endianness": "little",
        "compression": "none",
        "tier": chunk.get("tier"),
        "layer": chunk.get("layer"),
        "validTime": chunk.get("validTime"),
        "bbox": chunk.get("bbox"),
        "grid": chunk_grid(manifest, chunk),
        "bands": layer.get("bands", {}),
        "chunkKey": chunk_key,
    }
    header_bytes = stable_json_bytes(header)
    payload = make_payload(manifest, chunk_key, chunk)
    return MAGIC + struct.pack("<HHI", 1, 0, len(header_bytes)) + header_bytes + payload


def bounds_from_manifest(manifest: dict[str, Any]) -> tuple[float, float, float, float]:
    bbox = manifest.get("coverage", {}).get("bbox")
    if isinstance(bbox, list) and len(bbox) == 4:
        return tuple(float(v) for v in bbox)  # type: ignore[return-value]
    return (-180.0, -90.0, 180.0, 90.0)


def zooms_from_manifest(manifest: dict[str, Any]) -> tuple[int, int]:
    ranges = []
    for tier in (manifest.get("tiers") or {}).values():
        zoom_range = tier.get("clientZoomRange") if isinstance(tier, dict) else None
        if isinstance(zoom_range, list) and len(zoom_range) == 2:
            ranges.append((int(zoom_range[0]), int(zoom_range[1])))
    if not ranges:
        return (0, 0)
    return (min(r[0] for r in ranges), max(r[1] for r in ranges))


def write_pmtiles_shell(out_path: Path, manifest: dict[str, Any], chunks: list[bytes]) -> tuple[int, int]:
    metadata = gzip.compress(stable_json_bytes({
        "name": manifest.get("packId"),
        "type": "environmental-grid",
        "kind": "environmental-grid",
        "helm_pack_schema": "helm.env.grid.pack.v1",
        "encoding": "helm.env.grid.v1",
        "payload": "helm.env.grid.chunk.v1",
        "chunk_count": len(chunks),
    }), mtime=0)
    data = b"".join(chunks)
    meta_off = HEADER_LEN
    data_off = meta_off + len(metadata)
    minz, maxz = zooms_from_manifest(manifest)
    west, south, east, north = bounds_from_manifest(manifest)
    clon = (west + east) / 2.0
    clat = (south + north) / 2.0

    header = bytearray(HEADER_LEN)
    header[0:7] = b"PMTiles"
    header[7] = 3
    struct.pack_into("<Q", header, 8, HEADER_LEN)
    struct.pack_into("<Q", header, 16, 0)
    struct.pack_into("<Q", header, 24, meta_off)
    struct.pack_into("<Q", header, 32, len(metadata))
    struct.pack_into("<Q", header, 40, data_off)
    struct.pack_into("<Q", header, 48, 0)
    struct.pack_into("<Q", header, 56, data_off)
    struct.pack_into("<Q", header, 64, len(data))
    # Tile counts stay 0 ("unknown" per PMTiles v3): the root directory is empty
    # because the chunk index lives in the manifest, not in PMTiles entries.
    struct.pack_into("<Q", header, 72, 0)
    struct.pack_into("<Q", header, 80, 0)
    struct.pack_into("<Q", header, 88, 0)
    header[96] = 1
    header[97] = 2
    header[98] = 1
    header[99] = 0
    header[100] = minz
    header[101] = maxz
    struct.pack_into("<i", header, 102, int(west * 1e7))
    struct.pack_into("<i", header, 106, int(south * 1e7))
    struct.pack_into("<i", header, 110, int(east * 1e7))
    struct.pack_into("<i", header, 114, int(north * 1e7))
    header[118] = minz
    struct.pack_into("<i", header, 119, int(clon * 1e7))
    struct.pack_into("<i", header, 123, int(clat * 1e7))

    out_path.write_bytes(bytes(header) + metadata + data)
    return data_off, len(data)


def public_sidecar(manifest: dict[str, Any], pack_name: str, generated_by: str = "scripts/env_grid_pack.py") -> dict[str, Any]:
    layers = sorted((manifest.get("layers") or {}).keys())
    tiers = sorted((manifest.get("tiers") or {}).keys())
    source = manifest.get("source") or {}
    return {
        "title": manifest.get("packId"),
        "kind": "environmental-grid",
        "source": source.get("provider", "local"),
        "license": source.get("license", "local-user-owned"),
        "source_provenance": source.get("provenance"),
        "helm_pack_schema": "helm.env.grid.pack.v1",
        "pack_role": "environmental-grid",
        "encoding": "helm.env.grid.v1",
        "payload": "helm.env.grid.chunk.v1",
        "grid_pack_id": manifest.get("packId"),
        "grid_pack_url": pack_name,
        "grid_pack_manifest": f"{pack_name}.manifest.json",
        "grid_layers": layers,
        "grid_tiers": tiers,
        "chunk_count": len(manifest.get("chunks") or {}),
        "failure_policy": manifest.get("failurePolicy", {}),
        "generated_by": generated_by,
    }


def pack_command(args: argparse.Namespace) -> int:
    source = load_json(Path(args.manifest))
    chunks_obj = source.get("chunks")
    if not isinstance(chunks_obj, dict) or not chunks_obj:
        fail("manifest must contain chunks")

    packed = copy.deepcopy(source)
    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    chunk_bytes: list[bytes] = []
    chunk_items = sorted(chunks_obj.items())
    for chunk_key, chunk in chunk_items:
        if not isinstance(chunk, dict):
            fail(f"chunk {chunk_key} must be an object")
        chunk_bytes.append(make_chunk(source, chunk_key, chunk))
    data_offset, _data_length = write_pmtiles_shell(out_path, packed, chunk_bytes)

    offset = data_offset
    for (chunk_key, _chunk), blob in zip(chunk_items, chunk_bytes):
        packed["chunks"][chunk_key]["byteRange"] = [offset, len(blob)]
        packed["chunks"][chunk_key]["checksum"] = "sha256:" + hashlib.sha256(blob).hexdigest()
        offset += len(blob)

    transport = packed.setdefault("transport", {})
    transport["container"] = "pmtiles"
    transport["payload"] = "helm.env.grid.chunk.v1"
    transport["rangeReadable"] = True
    transport["servedBy"] = "helm-envd"
    transport["requiredRuntime"] = "C++"
    transport["packUrl"] = out_path.name
    transport["byteRangeSemantics"] = "offset-length"
    transport["checksumAlgorithm"] = "sha256"

    manifest_out = Path(args.manifest_out) if args.manifest_out else out_path.with_suffix(out_path.suffix + ".manifest.json")
    manifest_out.write_text(json.dumps(packed, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    sidecar_out = out_path.with_suffix(".metadata.json")
    sidecar_out.write_text(json.dumps(public_sidecar(packed, out_path.name), indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps({"pack": str(out_path), "manifest": str(manifest_out), "sidecar": str(sidecar_out), "chunks": len(chunk_items)}, sort_keys=True))
    return 0


def read_range(path: Path, byte_range: list[Any]) -> bytes:
    if not isinstance(byte_range, list) or len(byte_range) != 2:
        fail("byteRange must be [offset, length]")
    offset, length = int(byte_range[0]), int(byte_range[1])
    if offset < 0 or length <= 0:
        fail("byteRange must have non-negative offset and positive length")
    with path.open("rb") as handle:
        handle.seek(offset)
        data = handle.read(length)
    if len(data) != length:
        fail(f"missing_range: wanted {length} bytes at {offset}, read {len(data)}")
    return data


def verify_chunk(chunk_key: str, chunk: dict[str, Any], pack_path: Path) -> None:
    data = read_range(pack_path, chunk.get("byteRange"))
    checksum = str(chunk.get("checksum", ""))
    if not checksum.startswith("sha256:"):
        fail(f"chunk {chunk_key} missing sha256 checksum")
    actual = hashlib.sha256(data).hexdigest()
    if actual != checksum.split(":", 1)[1]:
        fail(f"checksum_mismatch: {chunk_key}")
    if not data.startswith(MAGIC):
        fail(f"bad_chunk_magic: {chunk_key}")
    version, _flags, header_len = struct.unpack_from("<HHI", data, len(MAGIC))
    if version != 1:
        fail(f"unsupported_chunk_version: {version}")
    header_start = len(MAGIC) + 8
    header_end = header_start + header_len
    if header_end > len(data):
        fail(f"truncated_chunk_header: {chunk_key}")
    header = json.loads(data[header_start:header_end].decode("utf-8"))
    if header.get("schema") != "helm.env.grid.chunk.v1":
        fail(f"bad_chunk_schema: {chunk_key}")
    if header.get("chunkKey") != chunk_key:
        fail(f"chunk_key_mismatch: {chunk_key}")
    origin = (header.get("grid") or {}).get("origin", "northwest")
    if origin != "northwest":
        fail(f"unsupported_grid_origin: {chunk_key} ({origin})")


def verify_command(args: argparse.Namespace) -> int:
    manifest = load_json(Path(args.manifest))
    pack_path = Path(args.pack)
    if not pack_path.exists():
        fail(f"pack not found: {pack_path}")
    chunks = manifest.get("chunks")
    if not isinstance(chunks, dict) or not chunks:
        fail("manifest has no chunks")
    for chunk_key, chunk in sorted(chunks.items()):
        if not isinstance(chunk, dict):
            fail(f"chunk {chunk_key} must be object")
        verify_chunk(chunk_key, chunk, pack_path)
    print(f"env-grid-pack: ok ({len(chunks)} chunks)")
    return 0


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="cmd", required=True)
    pack = sub.add_parser("pack", help="write a range-readable PMTiles shell and packed manifest")
    pack.add_argument("manifest")
    pack.add_argument("out")
    pack.add_argument("--manifest-out")
    pack.set_defaults(func=pack_command)
    verify = sub.add_parser("verify", help="verify byte ranges, checksums, and HELMGRID envelopes")
    verify.add_argument("manifest")
    verify.add_argument("pack")
    verify.set_defaults(func=verify_command)
    args = parser.parse_args(argv[1:])
    return int(args.func(args))


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
