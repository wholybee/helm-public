#!/usr/bin/env python3
"""Resolve the WX bake anchor from the boat's live GPS (WX-26 pack refresh).

Reads the Vesper/NMEA gateway address from ~/.helm/connections.json (the same
source of truth the engine uses), listens briefly for a valid RMC/GGA fix, and
prints "lon,lat" for wx_bake_openmeteo.py --anchor.

Anchor policy (mirrors the source spec's route-high anchor contract:
{"type": "gps-route", "driftThresholdNm": 120}):
  - live fix within --drift-nm of the previous release anchor -> keep the
    previous anchor (stable coverage; no churn while swinging at anchor)
  - drifted beyond the threshold (e.g. a passage to NZ) -> re-anchor on the fix
  - no live fix -> exit 3 (caller decides: reuse previous anchor LOUDLY or skip)

Fail-loud: no fabricated positions, no silent defaults. stdout is ONLY the
anchor; everything else goes to stderr.
"""

import argparse
import json
import math
import socket
import sys
import time
from pathlib import Path


def log(msg):
    sys.stderr.write("boat-anchor: %s\n" % msg)


def nmea_checksum_ok(line):
    if not line.startswith("$") or "*" not in line:
        return False
    body, _, want = line[1:].partition("*")
    got = 0
    for ch in body:
        got ^= ord(ch)
    try:
        return got == int(want[:2], 16)
    except ValueError:
        return False


def parse_coord(value, hemi, is_lon):
    # NMEA: lat DDMM.mmmm, lon DDDMM.mmmm
    if not value or not hemi:
        return None
    try:
        deg_digits = 3 if is_lon else 2
        deg = float(value[:deg_digits])
        minutes = float(value[deg_digits:])
    except ValueError:
        return None
    coord = deg + minutes / 60.0
    if hemi in ("S", "W"):
        coord = -coord
    return coord


def fix_from_sentence(line):
    """Return (lat, lon) from a valid RMC (status A) or GGA (quality>0), else None."""
    if not nmea_checksum_ok(line):
        return None
    parts = line.split("*")[0].split(",")
    talker = parts[0][3:6] if len(parts[0]) >= 6 else ""
    if talker == "RMC" and len(parts) > 6:
        if parts[2] != "A":
            return None
        lat = parse_coord(parts[3], parts[4], False)
        lon = parse_coord(parts[5], parts[6], True)
    elif talker == "GGA" and len(parts) > 6:
        try:
            if int(parts[6] or "0") <= 0:
                return None
        except ValueError:
            return None
        lat = parse_coord(parts[2], parts[3], False)
        lon = parse_coord(parts[4], parts[5], True)
    else:
        return None
    if lat is None or lon is None or abs(lat) > 90.0 or abs(lon) > 180.0:
        return None
    if lat == 0.0 and lon == 0.0:                      # null-island guard
        return None
    return (lat, lon)


def gateway_address(connections_path):
    conns = json.loads(Path(connections_path).read_text())
    for c in conns:
        if c.get("enabled") and c.get("type") == "tcp-client" and c.get("dataProtocol") == "nmea0183":
            return (c["address"], int(c["port"]), c.get("name", "?"))
    return None


def live_fix(addr, port, listen_seconds):
    deadline = time.time() + listen_seconds
    try:
        sock = socket.create_connection((addr, port), timeout=5)
    except OSError as e:
        log("cannot reach NMEA gateway %s:%s (%s)" % (addr, port, e))
        return None
    sock.settimeout(3)
    buf = b""
    try:
        while time.time() < deadline:
            try:
                data = sock.recv(4096)
            except socket.timeout:
                continue
            if not data:
                break
            buf += data
            while b"\n" in buf:
                raw, _, buf = buf.partition(b"\n")
                line = raw.decode("ascii", "replace").strip()
                fix = fix_from_sentence(line)
                if fix:
                    return fix
    finally:
        sock.close()
    return None


def haversine_nm(lat1, lon1, lat2, lon2):
    rad = math.radians
    dlat = rad(lat2 - lat1)
    dlon = rad(lon2 - lon1)                            # periodic terms wrap the antimeridian correctly
    a = math.sin(dlat / 2) ** 2 + math.cos(rad(lat1)) * math.cos(rad(lat2)) * math.sin(dlon / 2) ** 2
    return 2 * 3440.065 * math.asin(math.sqrt(a))


def previous_anchor(packs_dir):
    """Centre of the previous release's route-high coverage, as (lat, lon)."""
    try:
        base = Path(packs_dir)
        cur = json.loads((base / "current.json").read_text())
        release = json.loads((base / cur["indexUrl"]).read_text())
        for p in release.get("packs", []):
            bbox = (p.get("coverage") or {}).get("bbox")
            if bbox and len(bbox) == 4:
                lon = (bbox[0] + bbox[2]) / 2.0
                lat = (bbox[1] + bbox[3]) / 2.0
                return (lat, ((lon + 180.0) % 360.0) - 180.0)
    except (OSError, ValueError, KeyError):
        pass
    return None


def anchor_lon_convention(lon):
    # Match the existing pack convention: keep the +/-20 deg window inside a single
    # continuous interval. West of the antimeridian (lon < -160) use 0..360 so
    # west/east stay ordered (e.g. -178.5 -> 181.5 -> window 161.5..201.5).
    if lon < -160.0:
        return lon + 360.0
    return lon


def main(argv):
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--connections", default=str(Path.home() / ".helm" / "connections.json"))
    ap.add_argument("--packs-dir", default=str(Path.home() / ".helm" / "live" / "web" / "wx-packs"))
    ap.add_argument("--drift-nm", type=float, default=120.0)
    ap.add_argument("--listen-seconds", type=float, default=12.0)
    args = ap.parse_args(argv[1:])

    gw = gateway_address(args.connections)
    if not gw:
        log("no enabled nmea0183 tcp-client in %s" % args.connections)
        return 3
    addr, port, name = gw
    log("listening for a fix on %s (%s:%s)" % (name, addr, port))
    fix = live_fix(addr, port, args.listen_seconds)
    prev = previous_anchor(args.packs_dir)

    if not fix:
        log("NO live GPS fix within %.0fs" % args.listen_seconds)
        return 3

    lat, lon = fix
    if prev:
        drift = haversine_nm(lat, lon, prev[0], prev[1])
        log("fix %.4f,%.4f; previous anchor centre %.4f,%.4f; drift %.1f nm (threshold %.0f)"
            % (lat, lon, prev[0], prev[1], drift, args.drift_nm))
        if drift <= args.drift_nm:
            out_lon = anchor_lon_convention(prev[1])
            print("%.1f,%.1f" % (out_lon, prev[0]))
            return 0
        log("drifted beyond threshold -> re-anchoring on the live fix")
    out_lon = anchor_lon_convention(lon)
    print("%.1f,%.1f" % (out_lon, lat))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
