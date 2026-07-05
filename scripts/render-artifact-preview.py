#!/usr/bin/env python3
"""RENDERMODEL-3 — faithful CPU reference render of a helm.render.artifact.v1 packet.

This rasterizes a compiled WebGPU artifact to a PNG using the EXACT projection math the
browser WGSL shader uses (chart-artifact-webgpu.js `tileToNdc`):

    lon = west  + px * (east-west)/pixel_w
    lat = north - py * (north-south)/pixel_h
    mx  = lon/360 + 0.5
    my  = 0.5 - log((1+s)/(1-s))/(4*pi)     with s = clamp(sin(lat*pi/180))

instead of MapLibre's live `map.project`, we render a north-up web-mercator view that maps
the artifact's mercator bbox linearly to the output image — i.e. exactly what MapLibre shows
for a north-up camera framed on the cell.  This is a CPU reference of the GPU path: it proves
the compiled geometry + coordinate math draw a recognizable chart, without needing a
WebGPU-capable browser in the sandbox.

Colours come from the source command stream (`scene.commands.json` fill.color) when supplied
(so the proof shows the intended palette), else from a per-style_key fallback.

Usage:
    scripts/render-artifact-preview.py ARTIFACT.json OUT.png [--scene scene.commands.json]
        [--width 1400] [--bg "#0b1f2a"]
Pure stdlib (zlib for PNG); no third-party deps.
"""
from __future__ import annotations

import argparse
import json
import math
import struct
import zlib

STRIDE = 4

STYLE_FALLBACK = {
    "fill_area": "#b9d7e8", "stroke_line": "#4a6f8a", "place_symbol": "#f5d76e",
    "draw_text": "#28323c", "draw_sounding": "#28323c", "draw_raster_sheet": "#787882",
}


def hex_rgb(h):
    h = h.lstrip("#")
    if len(h) == 3:
        h = "".join(c * 2 for c in h)
    return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16))


def merc_x(lon):
    return lon / 360.0 + 0.5


def merc_y(lat):
    s = math.sin(math.radians(lat))
    s = max(-0.9999, min(0.9999, s))
    return 0.5 - math.log((1 + s) / (1 - s)) / (4 * math.pi)


class Canvas:
    def __init__(self, w, h, bg):
        self.w, self.h = w, h
        r, g, b = bg
        self.buf = bytearray((r, g, b) * (w * h))

    def blend(self, x, y, rgb, a):
        if x < 0 or y < 0 or x >= self.w or y >= self.h:
            return
        i = (y * self.w + x) * 3
        ia = 1.0 - a
        self.buf[i] = int(self.buf[i] * ia + rgb[0] * a)
        self.buf[i + 1] = int(self.buf[i + 1] * ia + rgb[1] * a)
        self.buf[i + 2] = int(self.buf[i + 2] * ia + rgb[2] * a)

    def fill_tri(self, p0, p1, p2, rgb, a):
        minx = max(0, int(math.floor(min(p0[0], p1[0], p2[0]))))
        maxx = min(self.w - 1, int(math.ceil(max(p0[0], p1[0], p2[0]))))
        miny = max(0, int(math.floor(min(p0[1], p1[1], p2[1]))))
        maxy = min(self.h - 1, int(math.ceil(max(p0[1], p1[1], p2[1]))))
        (x0, y0), (x1, y1), (x2, y2) = p0, p1, p2
        d = (y1 - y2) * (x0 - x2) + (x2 - x1) * (y0 - y2)
        if abs(d) < 1e-12:
            return
        for y in range(miny, maxy + 1):
            for x in range(minx, maxx + 1):
                px, py = x + 0.5, y + 0.5
                l0 = ((y1 - y2) * (px - x2) + (x2 - x1) * (py - y2)) / d
                l1 = ((y2 - y0) * (px - x2) + (x0 - x2) * (py - y2)) / d
                l2 = 1 - l0 - l1
                if l0 >= -0.001 and l1 >= -0.001 and l2 >= -0.001:
                    self.blend(x, y, rgb, a)

    def write_png(self, path):
        raw = bytearray()
        for y in range(self.h):
            raw.append(0)
            raw.extend(self.buf[y * self.w * 3:(y + 1) * self.w * 3])
        comp = zlib.compress(bytes(raw), 9)

        def chunk(tag, data):
            return (struct.pack(">I", len(data)) + tag + data +
                    struct.pack(">I", zlib.crc32(tag + data) & 0xffffffff))

        with open(path, "wb") as f:
            f.write(b"\x89PNG\r\n\x1a\n")
            f.write(chunk(b"IHDR", struct.pack(">IIBBBBB", self.w, self.h, 8, 2, 0, 0, 0)))
            f.write(chunk(b"IDAT", comp))
            f.write(chunk(b"IEND", b""))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("artifact")
    ap.add_argument("out")
    ap.add_argument("--scene", default=None)
    ap.add_argument("--width", type=int, default=1400)
    ap.add_argument("--bg", default="#08151d")
    args = ap.parse_args()

    with open(args.artifact) as f:
        art = json.load(f)
    vp = art["viewport"]
    bbox = vp["geographic_bbox"]
    west, east = bbox["west"], bbox["east"]
    south, north = bbox["south"], bbox["north"]
    pw, ph = vp["pixel_size"]

    # command_id -> color from the source scene, when available.
    cmd_color = {}
    cmd_alpha = {}
    if args.scene:
        with open(args.scene) as f:
            scene = json.load(f)
        for grp in scene.get("command_groups", []):
            for cmd in grp.get("commands", []):
                cid = cmd.get("command_id")
                fill = cmd.get("fill") or {}
                if cid and fill.get("color"):
                    cmd_color[cid] = hex_rgb(fill["color"])
                    cmd_alpha[cid] = float(cmd.get("opacity", 1) or 1)

    mats = art.get("material_table", [])

    def batch_color(batch):
        pid = (batch.get("primitive_ids") or [None])[0]
        if pid in cmd_color:
            return cmd_color[pid], cmd_alpha.get(pid, 1.0)
        mi = batch.get("material_index", 0)
        sk = mats[mi].get("style_key", "") if 0 <= mi < len(mats) else ""
        return hex_rgb(STYLE_FALLBACK.get(sk, "#c0c0c8")), 0.9

    # target-pixel (px,py) -> mercator (mx,my)
    def to_merc(px, py):
        lon = west + px * (east - west) / max(1, pw)
        lat = north - py * (north - south) / max(1, ph)
        return merc_x(lon), merc_y(lat)

    mx_w, mx_e = merc_x(west), merc_x(east)
    my_n, my_s = merc_y(north), merc_y(south)
    W = args.width
    H = max(1, int(round(W * (my_s - my_n) / (mx_e - mx_w))))

    def to_screen(px, py):
        mx, my = to_merc(px, py)
        sx = (mx - mx_w) / (mx_e - mx_w) * W
        sy = (my - my_n) / (my_s - my_n) * H
        return sx, sy

    verts = art["geometry"]["vertices_f32"]
    inds = art["geometry"]["indices_u32"]
    batches = sorted(art.get("draw_batches", []), key=lambda b: b.get("order_bucket", 0))

    canvas = Canvas(W, H, hex_rgb(args.bg))

    def vxy(vi):
        return verts[vi * STRIDE], verts[vi * STRIDE + 1]

    n_tri = 0
    for b in batches:
        rgb, a = batch_color(b)
        topo = b.get("topology")
        fi, ic = b["first_index"], b["index_count"]
        if topo == "triangles":
            for k in range(fi, fi + ic - 2, 3):
                p0 = to_screen(*vxy(inds[k]))
                p1 = to_screen(*vxy(inds[k + 1]))
                p2 = to_screen(*vxy(inds[k + 2]))
                canvas.fill_tri(p0, p1, p2, rgb, a)
                n_tri += 1
        elif topo == "line_list":
            for k in range(fi, fi + ic - 1, 2):
                s0 = to_screen(*vxy(inds[k]))
                s1 = to_screen(*vxy(inds[k + 1]))
                steps = max(1, int(math.hypot(s1[0] - s0[0], s1[1] - s0[1])))
                for t in range(steps + 1):
                    x = int(s0[0] + (s1[0] - s0[0]) * t / steps)
                    y = int(s0[1] + (s1[1] - s0[1]) * t / steps)
                    for dx in (-1, 0, 1):
                        for dy in (-1, 0, 1):
                            canvas.blend(x + dx, y + dy, rgb, a)
        elif topo == "points":
            for k in range(fi, fi + ic):
                sx, sy = to_screen(*vxy(inds[k]))
                xi, yi = int(sx), int(sy)
                for dx in range(-2, 3):
                    for dy in range(-2, 3):
                        canvas.blend(xi + dx, yi + dy, rgb, a)

    canvas.write_png(args.out)
    print(f"{args.out}  {W}x{H}  batches={len(batches)} triangles={n_tri}")


if __name__ == "__main__":
    main()
