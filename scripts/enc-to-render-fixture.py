#!/usr/bin/env python3
"""RENDERMODEL-4 — ENC (.000 / S-57) -> vulkan.render_scene.v0 command-stream fixture.

This is "stage 1" of the chart render pipeline: it turns a REAL NOAA ENC cell into
the neutral command stream that the already-working downstream stages consume
unchanged:

    ENC .000  --[THIS TOOL]-->  scene.commands.json (+ source/provenance/manifest)
              --render-model-fixture-export-->  helm.render.model.v1
              --render-artifact-compile------->  helm.render.artifact.v1  (WebGPU packet)

RENDERMODEL-4 (visual parity): area features (DEPARE depth bands, LNDARE land,
DRGARE dredged) are emitted as ACTUAL FILLED polygons — pre-triangulated on the CPU
with earcut (handles concavity + holes) so each triangle is a convex 3-point ring —
not thin outlines.  Depth is banded from DRVAL1 into S-52 day bands, and colours use
the S-52 day palette (mirrored into web/data/s52-atlas-fixture.json).

Design constraints discovered in the pipeline (and how we honour them):

  * render_model_fixture_export.cpp derives material_id = "mat." + command_id, so there
    is ONE material per command, and the browser shader's `materials` uniform is a fixed
    array<vec4,32>.  => We emit ONE `fill_area` command per *visual category* (a handful),
    not one per feature.  Category count stays well under 32.

  * render_artifact_compiler.cpp triangulates each fill ring with a simple FAN, which is
    only correct for CONVEX rings.  => We never hand it a raw ENC polygon.  Areas are
    earcut-triangulated into CONVEX triangles (emitted as 3-point rings); line segments
    become thin quads; points become small squares.  A triangle/quad fans correctly.

  * Draw order: every category is a fill_area command (order_bucket == render_pass_rank
    == 10 for AreaFill), so relative order follows the STABLE compile order, which the
    exporter derives from command_group chart_priority.  CATEGORIES is therefore listed
    bottom-to-top: depth fills < dredged < land < depth contours < coastline < soundings
    < symbols.

  * The browser maps the artifact's target-pixel rect onto viewport.geographic_bbox with a
    linear-in-lon/lat mapping (see chart-artifact-webgpu.js tileToNdc):
        lon = west  + px * (east-west)/pixel_w
        lat = north - py * (north-south)/pixel_h
    => We project every ENC lon/lat into target pixels with the exact inverse so the GPU
    path places the geometry correctly over the basemap.

Geometry is read with GDAL/OGR's S-57 driver via the `ogr2ogr` CLI (no OpenCPN / s52plib
engine required, and no GDAL python bindings required).

Usage:
    scripts/enc-to-render-fixture.py ENC.000 OUT_DIR [--cell-id US5GA2BC]
        [--pixel-size 2048] [--palette day] [--display-category standard]
        [--safety-depth 10] [--half-width-px 1.4] [--bbox W,S,E,N]
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import shutil
import subprocess
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _earcut import triangulate_rings  # noqa: E402  (repo-vendored, dependency-free)

# --- S-57 object class -> visual category ------------------------------------------------
# Each category becomes exactly ONE fill_area command, so the whole cell uses <=32
# materials.  `color` is written into the command `fill.color` (used by the CPU reference
# renderer + render-model) AND `ref`/`ref_kind` set the material's
# symbol_ref/line_style_ref/pattern_ref so the browser S-52 atlas resolves the same colour.
#   ref_kind: pattern -> area fill, line -> opaque stroke, symbol -> opaque marker.
# ORDER MATTERS: listed bottom-to-top (draw/stack order). S-52 day palette values are kept
# byte-parallel with web/data/s52-atlas-fixture.json.  Depth ramp goes deep(lightest) ->
# shallow(most blue), matching ECDIS four-shade day portrayal.
CATEGORIES = [
    # id             layers                          geom     color(day)  ref                      ref_kind  hw
    ("depth_deep",   ["DEPARE:deep"],                "poly",  "#ecf5fb",  "pattern.depare-deep",   "pattern", 1.0),
    ("depth_mid",    ["DEPARE:mid"],                 "poly",  "#cfe6f4",  "pattern.depare-mid",    "pattern", 1.0),
    ("depth_shallow",["DEPARE:shallow"],             "poly",  "#a9d3ea",  "pattern.depare-shallow","pattern", 1.0),
    ("dredged",      ["DRGARE"],                     "poly",  "#cfe3ea",  "pattern.dredged",       "pattern", 1.0),
    ("land",         ["LNDARE", "BUAARE"],           "poly",  "#d9c7a6",  "pattern.land",          "pattern", 1.0),
    ("depth_contour",["DEPCNT"],                     "line",  "#4a6f8a",  "line.depth-contour",    "line",    1.0),
    ("coastline",    ["COALNE", "SLCONS"],           "line",  "#5a4b30",  "line.coastline",        "line",    1.6),
    ("sounding",     ["SOUNDG"],                     "point", "#1b2a36",  "sym.sounding",          "symbol",  1.0),
    ("aid",          ["BOYLAT", "BOYSAW", "BOYSPP", "BOYISD", "BOYCAR",
                      "BCNLAT", "BCNSPP", "BCNCAR", "LIGHTS"], "point", "#f0a020", "sym.boyspp",   "symbol",  1.0),
    ("hazard",       ["UWTROC", "OBSTRN", "WRECKS", "ROCKS"], "point", "#c8322d", "sym.hazard",    "symbol",  1.0),
]

# Layers we read from the ENC.  DEPARE is split into depth bands after reading.
BASE_LAYERS = sorted({l.split(":")[0] for _id, ls, *_ in CATEGORIES for l in ls})

OGR_S57_OPTIONS = "SPLIT_MULTIPOINT=ON,ADD_SOUNDG_DEPTH=ON,RETURN_PRIMITIVES=OFF,RETURN_LINKAGES=OFF,LNAM_REFS=OFF"


def sha256_file(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def run_ogr2ogr(enc: str, layer: str, out_geojson: str) -> bool:
    """Extract one S-57 layer to WGS84 GeoJSON. Returns True if the layer produced output."""
    env = dict(os.environ, OGR_S57_OPTIONS=OGR_S57_OPTIONS)
    try:
        subprocess.run(
            ["ogr2ogr", "-f", "GeoJSON", "-t_srs", "EPSG:4326", out_geojson, enc, layer],
            check=True, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
        )
    except subprocess.CalledProcessError:
        return False
    return os.path.exists(out_geojson) and os.path.getsize(out_geojson) > 0


def load_features(geojson_path: str):
    with open(geojson_path) as f:
        data = json.load(f)
    return data.get("features", []) or []


# --- geometry helpers --------------------------------------------------------------------
def iter_rings(geom):
    """Yield exterior+interior rings (lists of [lon,lat]) for Polygon/MultiPolygon."""
    if not geom:
        return
    t = geom.get("type")
    c = geom.get("coordinates")
    if t == "Polygon":
        for ring in c:
            yield ring
    elif t == "MultiPolygon":
        for poly in c:
            for ring in poly:
                yield ring


def iter_polygons(geom):
    """Yield (exterior_ring, [hole_rings]) per polygon for Polygon/MultiPolygon."""
    if not geom:
        return
    t = geom.get("type")
    c = geom.get("coordinates")
    if t == "Polygon":
        if c:
            yield c[0], list(c[1:])
    elif t == "MultiPolygon":
        for poly in c or []:
            if poly:
                yield poly[0], list(poly[1:])


def iter_lines(geom):
    if not geom:
        return
    t = geom.get("type")
    c = geom.get("coordinates")
    if t == "LineString":
        yield c
    elif t == "MultiLineString":
        for line in c:
            yield line
    elif t == "Polygon":
        for ring in c:
            yield ring
    elif t == "MultiPolygon":
        for poly in c:
            for ring in poly:
                yield ring


def iter_points(geom):
    if not geom:
        return
    t = geom.get("type")
    c = geom.get("coordinates")
    if t == "Point":
        yield c
    elif t == "MultiPoint":
        for p in c:
            yield p


def main() -> int:
    ap = argparse.ArgumentParser(description="ENC (.000) -> vulkan.render_scene.v0 fixture")
    ap.add_argument("enc")
    ap.add_argument("out_dir")
    ap.add_argument("--cell-id", default=None)
    ap.add_argument("--pixel-size", type=int, default=2048)
    ap.add_argument("--palette", default="day")
    ap.add_argument("--display-category", default="standard")
    ap.add_argument("--safety-depth", type=float, default=10.0)
    ap.add_argument("--safety-contour", type=float, default=10.0)
    ap.add_argument("--half-width-px", type=float, default=1.4)
    ap.add_argument("--point-size-px", type=float, default=2.6)
    ap.add_argument("--simplify-px", type=float, default=1.0,
                    help="Douglas-Peucker tolerance in target pixels (0 disables)")
    ap.add_argument("--bbox", default=None, help="W,S,E,N to clip/frame the view")
    args = ap.parse_args()

    enc = os.path.abspath(args.enc)
    if not os.path.exists(enc):
        print(f"ENC not found: {enc}", file=sys.stderr)
        return 2
    if shutil.which("ogr2ogr") is None:
        print("ogr2ogr (GDAL) not found on PATH — install GDAL first", file=sys.stderr)
        return 3

    cell_id = args.cell_id or os.path.splitext(os.path.basename(enc))[0]
    out_dir = os.path.abspath(args.out_dir)
    os.makedirs(out_dir, exist_ok=True)

    # 1) Extract each base layer to GeoJSON.
    tmp = tempfile.mkdtemp(prefix="enc-extract-")
    layer_features = {}
    for layer in BASE_LAYERS:
        gj = os.path.join(tmp, f"{layer}.geojson")
        if run_ogr2ogr(enc, layer, gj):
            feats = load_features(gj)
            if feats:
                layer_features[layer] = feats
                print(f"  {layer}: {len(feats)} features", file=sys.stderr)
    if not layer_features:
        print("No usable layers extracted from ENC", file=sys.stderr)
        return 4

    # 2) Compute the view bbox (union of all feature vertices) unless one was given.
    if args.bbox:
        west, south, east, north = (float(v) for v in args.bbox.split(","))
    else:
        west = south = math.inf
        east = north = -math.inf

        def _acc(lon, lat):
            nonlocal west, south, east, north
            west = min(west, lon); east = max(east, lon)
            south = min(south, lat); north = max(north, lat)

        for feats in layer_features.values():
            for ft in feats:
                g = ft.get("geometry") or {}
                for ring in iter_lines(g):
                    for lon, lat in ((p[0], p[1]) for p in ring):
                        _acc(lon, lat)
                for p in iter_points(g):
                    _acc(p[0], p[1])
        # small margin
        dlon = (east - west) * 0.02 or 0.001
        dlat = (north - south) * 0.02 or 0.001
        west -= dlon; east += dlon; south -= dlat; north += dlat

    if not (east > west and north > south):
        print("Degenerate bbox", file=sys.stderr)
        return 5

    pw = int(args.pixel_size)
    ph = max(1, int(round(pw * (north - south) / (east - west))))
    hw = args.half_width_px * (east - west) / pw  # half-width in *degrees* for quads

    def project(lon, lat):
        x = (lon - west) / (east - west) * pw
        y = (north - lat) / (north - south) * ph
        return x, y

    # 3) Bucket features by category and expand to convex rings in TARGET pixel space.
    # All emitted coords are rounded to INTEGERS: the artifact compiler serialises floats at
    # precision 17, so integer-valued coords keep the packet compact, and ~1px (~4m at 2048)
    # is well below chart resolution.
    def ri(v):
        return int(round(v))

    def seg_quad(x0, y0, x1, y1, half_px):
        dx, dy = x1 - x0, y1 - y0
        n = math.hypot(dx, dy)
        if n < 1e-9:
            return None
        nx, ny = -dy / n * half_px, dx / n * half_px
        return [[ri(x0 + nx), ri(y0 + ny)], [ri(x1 + nx), ri(y1 + ny)],
                [ri(x1 - nx), ri(y1 - ny)], [ri(x0 - nx), ri(y0 - ny)],
                [ri(x0 + nx), ri(y0 + ny)]]

    def dot_square(x, y, half_px):
        x, y = ri(x), ri(y)
        h = max(1, int(round(half_px)))
        return [[x - h, y - h], [x + h, y - h], [x + h, y + h], [x - h, y + h], [x - h, y - h]]

    def tri_ring(tri):
        # Round earcut triangle to integer target pixels; drop rounding-degenerate ones.
        ring = [[ri(x), ri(y)] for x, y in tri]
        (ax, ay), (bx, by), (cx, cy) = ring
        if abs((bx - ax) * (cy - ay) - (cx - ax) * (by - ay)) < 1:
            return None
        return ring

    def simplify(pts, tol):
        # Iterative Douglas-Peucker in target-pixel space.
        if tol <= 0 or len(pts) < 3:
            return pts
        keep = [False] * len(pts)
        keep[0] = keep[-1] = True
        stack = [(0, len(pts) - 1)]
        while stack:
            a, b = stack.pop()
            if b <= a + 1:
                continue
            ax, ay = pts[a]; bx, by = pts[b]
            dx, dy = bx - ax, by - ay
            seglen = math.hypot(dx, dy)
            dmax, idx = -1.0, -1
            for i in range(a + 1, b):
                px, py = pts[i]
                if seglen < 1e-9:
                    d = math.hypot(px - ax, py - ay)
                else:
                    d = abs(dy * px - dx * py + bx * ay - by * ax) / seglen
                if d > dmax:
                    dmax, idx = d, i
            if dmax > tol and idx > 0:
                keep[idx] = True
                stack.append((a, idx)); stack.append((idx, b))
        return [pts[i] for i in range(len(pts)) if keep[i]]

    def depare_band(props):
        # Classify a DEPARE by its shallow value (DRVAL1) relative to safety depth.
        v = props.get("DRVAL1")
        try:
            v = float(v)
        except (TypeError, ValueError):
            v = 0.0
        if v < args.safety_contour * 0.5:
            return "shallow"
        if v < args.safety_contour * 2.0:
            return "mid"
        return "deep"

    hw_px = args.half_width_px
    pt_px = args.point_size_px
    cat_rings = {c[0]: [] for c in CATEGORIES}
    cat_counts = {c[0]: 0 for c in CATEGORIES}

    # Map layer -> list of (category_id, filter_band_or_None, geom_kind)
    layer_targets = {}
    for cid, layers, kind, _color, _ref, _refkind, hws in CATEGORIES:
        for spec in layers:
            base = spec.split(":")[0]
            band = spec.split(":")[1] if ":" in spec else None
            layer_targets.setdefault(base, []).append((cid, band, kind, hws))

    for layer, feats in layer_features.items():
        targets = layer_targets.get(layer, [])
        for ft in feats:
            g = ft.get("geometry") or {}
            props = ft.get("properties") or {}
            band = depare_band(props) if layer == "DEPARE" else None
            for cid, want_band, kind, hws in targets:
                if want_band and want_band != band:
                    continue
                added = False
                if kind == "poly":
                    # Fill areas: project + simplify each ring in target pixels, earcut the
                    # polygon (concave + holes) into triangles, emit each as a 3-point ring.
                    for exterior, holes in iter_polygons(g):
                        ext = simplify([project(p[0], p[1]) for p in exterior], args.simplify_px)
                        if len(ext) < 3:
                            continue
                        hs = []
                        for hole in holes:
                            hp = simplify([project(p[0], p[1]) for p in hole], args.simplify_px)
                            if len(hp) >= 3:
                                hs.append(hp)
                        for tri in triangulate_rings(ext, hs):
                            ring = tri_ring(tri)
                            if ring:
                                cat_rings[cid].append(ring); added = True
                elif kind == "line":
                    # Draw lines / area boundaries as thin quads (robust; convex; no concave fan).
                    for line in iter_lines(g):
                        pts = simplify([project(p[0], p[1]) for p in line], args.simplify_px)
                        for i in range(len(pts) - 1):
                            q = seg_quad(pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1], hw_px * hws)
                            if q:
                                cat_rings[cid].append(q); added = True
                elif kind == "point":
                    for p in iter_points(g):
                        x, y = project(p[0], p[1])
                        cat_rings[cid].append(dot_square(x, y, pt_px)); added = True
                if added:
                    cat_counts[cid] += 1

    # 4) Emit the command stream + sidecar fixture files.
    scene_id = f"{cell_id}-{args.palette}-{args.display_category}"
    center = {"lon": (west + east) / 2.0, "lat": (south + north) / 2.0}
    # slippy tile for the center (nominal; browser uses geographic_bbox not tile).
    z = 13
    n_tiles = 2 ** z
    tx = int((center["lon"] + 180.0) / 360.0 * n_tiles)
    lat_rad = math.radians(center["lat"])
    ty = int((1.0 - math.asinh(math.tan(lat_rad)) / math.pi) / 2.0 * n_tiles)

    resource_table = {
        "symbols": [{"resource_id": c[4], "source": "s52-atlas"} for c in CATEGORIES if c[5] == "symbol"],
        "line_styles": [{"resource_id": c[4], "source": "s52-atlas"} for c in CATEGORIES if c[5] == "line"],
        "area_patterns": [{"resource_id": c[4], "source": "s52-atlas"} for c in CATEGORIES if c[5] == "pattern"],
        "fonts": [{"resource_id": "font.chart-label", "family": "chart-sans", "size_px": 11}],
        "raster_textures": [], "geometry_buffers": [],
        "palettes": [{"resource_id": f"palette.{args.palette}", "name": args.palette}],
    }

    command_groups = []
    provenance_table = []
    source_objects = []
    priority = 0
    for cid, layers, kind, color, ref, ref_kind, _hws in CATEGORIES:
        rings = cat_rings[cid]
        if not rings:
            continue
        prov_id = f"prov.{cid}"
        cmd = {
            "type": "fill_area",
            "command_id": f"cmd.area.{cid}",
            "rings": rings,
            "coordinate_space": "target",
            "fill": {"palette_ref": f"palette.{args.palette}", "color": color},
            "symbol_ref": ref if ref_kind == "symbol" else None,
            "line_style_ref": ref if ref_kind == "line" else None,
            "pattern_ref": ref if ref_kind == "pattern" else None,
            "opacity": 1,
            "clip_ref": None,
            "provenance_refs": [prov_id],
        }
        command_groups.append({
            "group_id": f"s52-{cid}",
            "chart_priority": priority,
            "s52_layer": "area",
            "quilt_rank": priority,
            "commands": [cmd],
        })
        provenance_table.append({
            "provenance_id": prov_id,
            "source_chart_id": cell_id,
        })
        source_objects.append({
            "source_object_id": f"{cid.upper()}-GROUP",
            "source_object_class": layers[0].split(":")[0],
            "geometry_type": "polygon" if kind == "poly" else ("line" if kind == "line" else "point"),
            "feature_count": cat_counts[cid],
            "convex_ring_count": len(rings),
        })
        priority += 1

    if not command_groups:
        print("No drawable geometry produced", file=sys.stderr)
        return 6

    render_view = {
        "projection": "web_mercator_tile",
        "geographic_bbox": {"west": west, "south": south, "east": east, "north": north},
        "center": center,
        "scale_denom": 20000,
        "rotation_deg": 0,
        "pixel_size": [pw, ph],
        "device_pixel_ratio": 1,
        "overzoom": False,
        "overscan_px": 0,
    }
    display_state = {
        "palette": args.palette,
        "display_category": args.display_category,
        "safety_depth_m": args.safety_depth,
        "shallow_contour_m": args.safety_contour * 0.5,
        "safety_contour_m": args.safety_contour,
        "deep_contour_m": args.safety_contour * 2.0,
        "show_text": True,
        "show_soundings": True,
        "show_lights": True,
        "simplified_symbols": False,
        "two_shade_depth": False,
        "language": "en",
        "units": "metric",
    }

    scene = {
        "schema_version": "vulkan.render_scene.v0",
        "scene_id": scene_id,
        "source_epoch": f"{cell_id}@enc",
        "render_view": render_view,
        "display_state": display_state,
        "resource_table": resource_table,
        "command_groups": command_groups,
        "provenance_table": provenance_table,
        "diagnostics": [{
            "severity": "info",
            "code": "capture.real_enc",
            "message": f"Real NOAA ENC cell {cell_id} captured via GDAL/OGR S-57 with earcut area fills (RENDERMODEL-4).",
            "provenance_refs": [],
            "suggested_action": "",
        }],
    }

    source = {
        "fixture_id": cell_id,
        "source_epoch": f"{cell_id}@enc",
        "source_type": "enc_s57",
        "charts": [{
            "source_chart_id": cell_id,
            "source_chart_edition": "1",
            "source_update": "0",
            "native_scale": 20000,
            "bounds": {"west": west, "south": south, "east": east, "north": north},
            "objects": source_objects,
        }],
    }

    provenance_doc = {
        "fixture_id": cell_id,
        "schema_version": "vulkan.provenance.v0",
        "provenance_table": [{
            "provenance_id": p["provenance_id"],
            "source_chart_id": cell_id,
            "source_chart_edition": "1",
            "source_update": "0",
            "source_object_id": p["provenance_id"].replace("prov.", "").upper() + "-GROUP",
            "source_object_class": next(c[1][0].split(":")[0] for c in CATEGORIES
                                        if f"prov.{c[0]}" == p["provenance_id"]),
            "source_geometry_hash": "enc-ogr-" + p["provenance_id"].replace("prov.", ""),
            "conversion_stage": "enc-ogr-capture",
            "transform_chain": ["wgs84", "web-mercator", "target-pixels"],
            "quilt_decision_id": f"quilt.{cell_id}.primary",
            "target_bounds": [0, 0, pw, ph],
            "warnings": [],
        } for p in provenance_table],
    }

    manifest = {
        "fixture_id": cell_id,
        "title": f"Real NOAA ENC {cell_id} filled-polygon command-stream capture (RENDERMODEL-4)",
        "schema_version": "vulkan.render_scene.v0",
        "scene_id": scene_id,
        "source_file": "source.json",
        "scene_file": "scene.commands.json",
        "provenance_file": "provenance.json",
        "render_model_file": "render-model.json",
        "render_model_binary_file": "render-model.bin",
        "render_artifact_file": "render-artifact.json",
        "render_artifact_binary_file": "render-artifact.bin",
        "license": {
            "type": "noaa-enc-public-domain",
            "redistribution": "us-government-work",
            "notes": f"Geometry derived from NOAA ENC {cell_id} (US public domain) via GDAL/OGR S-57.",
        },
        "capture_matrix": [{
            "name": f"{args.palette}-{args.display_category}-z{z}",
            "palette": args.palette,
            "display_category": args.display_category,
            "safety_depth_m": args.safety_depth,
            "projection": "web_mercator_tile",
            "tile": {"z": z, "x": tx, "y": ty},
            "pixel_size": [pw, ph],
        }],
        "required_command_types": ["fill_area"],
    }

    def dump(name, obj):
        path = os.path.join(out_dir, name)
        with open(path, "w") as f:
            json.dump(obj, f, indent=2, sort_keys=False)
            f.write("\n")
        return path

    dump("scene.commands.json", scene)
    dump("source.json", source)
    dump("provenance.json", provenance_doc)
    dump("manifest.json", manifest)

    shutil.rmtree(tmp, ignore_errors=True)

    total_rings = sum(len(v) for v in cat_rings.values())
    print(f"cell={cell_id} bbox=({west:.5f},{south:.5f},{east:.5f},{north:.5f}) "
          f"pixel_size=({pw}x{ph}) categories={len(command_groups)} convex_rings={total_rings}",
          file=sys.stderr)
    for cid in cat_rings:
        if cat_counts[cid]:
            print(f"    {cid:15s} features={cat_counts[cid]:5d} rings={len(cat_rings[cid]):6d}",
                  file=sys.stderr)
    print(out_dir)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
