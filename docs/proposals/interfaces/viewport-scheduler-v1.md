# Interface: Viewport Scheduler v1

Schema family: `helm.render.schedule.*.v1`  
Producer: `helm-chartd`, browser cache scheduler (using server hints)  
Consumers: browser WebGPU path, artifact cache, prefetch executors, debug tools  
Current code anchors: `engine/vulkan/viewport_scheduler.h`, `pipeline/viewport_scheduler.py`, `helm.render.model.v1`

## Purpose

Define the client/server scheduling contract for visible viewport coverage, overscan
margin, neighboring tiles, adjacent zoom levels, cache epochs, and stale-safe cache
entries. The browser may own cache admission and eviction, but it must not invent
chart semantics. The server (or shared reference scheduler) emits deterministic
hints so pan/zoom never shows blank edges and zoom transitions can blend safely.

## Owns

- Viewport and overscan geometry for scheduled fetch/render targets.
- Neighbor-tile and adjacent-zoom prefetch rings.
- Priority ordering for visible vs warm vs speculative entries.
- Cache key material and epoch invalidation inputs.
- Stale-safe admission policy per entry role.
- Zoom-blend weights for adjacent-level entries (SCHED-2 consumes these).

## Does Not Own

- S-52/S-101 portrayal, symbol selection, or quilt semantics.
- Neutral primitive generation (`helm.render.model.v1`).
- Artifact packet compilation (`helm.render.artifact.v1`, ARTIFACT lane).
- HTTP route shapes beyond advisory tile coordinates and cache keys.
- Client eviction policy beyond the stale-safe hints defined here.

## Request

Schema: `helm.render.schedule.request.v1`

```json
{
  "schema": "helm.render.schedule.request.v1",
  "request_id": "sched-req-pan-z12-001",
  "intent": "visible",
  "visible": {
    "projection": "web_mercator_tile",
    "z": 12,
    "center": {"lon": -81.8, "lat": 24.5},
    "viewport_px": [1024, 768],
    "device_pixel_ratio": 2,
    "rotation_deg": 0
  },
  "overscan": {
    "margin_px": 16,
    "margin_tiles": 1
  },
  "neighbor_policy": {
    "cardinal": true,
    "diagonal": true,
    "ring_count": 1
  },
  "zoom_policy": {
    "adjacent_offsets": [-1, 1],
    "include_children": true,
    "include_parent": true
  },
  "display_fingerprint": "day:standard:10:5:10:20:text:on:soundings:on",
  "source_epoch_hint": "synthetic-chart-1@2026-06-28",
  "client_epoch": 42,
  "renderer": {
    "backend": "vulkan",
    "scene_schema": "helm.render.model.v1",
    "renderer_sha": "pinned-sha-or-fixture"
  }
}
```

Notes:

- `intent` is `visible`, `prefetch`, or `revalidate`. Only `visible` requires
  strict stale policy on the primary tile set.
- `visible.center` or an explicit anchor tile (`z/x/y`) defines the focal view.
  When both are present, the anchor tile wins for deterministic fixtures.
- `overscan.margin_px` extends the logical viewport in device pixels. The
  scheduler must emit enough same-zoom tiles to cover that margin so panning
  within the margin never hits an empty edge.
- `overscan.margin_tiles` adds whole-tile rings beyond pixel-derived coverage.
- `display_fingerprint` is an opaque stable string derived from display-state
  fields that affect rendered output (palette, category, safety contours, text
  toggles). It is not chart semantics; it is a cache-partition key.
- `client_epoch` is a monotonic client cache generation used for traceability,
  not invalidation authority.

## Response

Schema: `helm.render.schedule.response.v1`

```json
{
  "schema": "helm.render.schedule.response.v1",
  "request_id": "sched-req-pan-z12-001",
  "source_epoch": "synthetic-chart-1@2026-06-28",
  "cache_epoch": "synthetic-chart-1@2026-06-28:helm.render.model.v1:day:standard:10:5:10:20:text:on:soundings:on",
  "entries": [
    {
      "entry_id": "tile.z12.x1120.y1756.visible",
      "kind": "tile",
      "role": "visible",
      "priority": 0,
      "tile": {"z": 12, "x": 1120, "y": 1756},
      "overscan_px": 16,
      "cache_key": "renderer=vulkan;scene_schema=helm.render.model.v1;source_epoch=synthetic-chart-1@2026-06-28;z=12;x=1120;y=1756;display_fp=day:standard:10:5:10:20:text:on:soundings:on;overscan=16",
      "stale_policy": "strict",
      "blend_weight": 1.0
    }
  ],
  "totals": {
    "entries": 17,
    "visible": 4,
    "overscan": 8,
    "neighbor": 0,
    "zoom_adjacent": 5
  },
  "diagnostics": []
}
```

Entry roles:

| Role | Meaning | Typical stale policy |
|------|---------|----------------------|
| `visible` | Tiles intersecting the logical viewport | `strict` |
| `overscan` | Same-zoom tiles covering overscan margin | `stale_while_revalidate` |
| `neighbor` | Extra ring beyond overscan for gesture prefetch | `stale_ok` |
| `zoom_adjacent` | Parent/child tiles for zoom-band warming | `stale_ok` |
| `prefetch` | Speculative corridor/route warming | `stale_ok` |

## Cache Behavior

1. **Epoch authority.** `source_epoch` in the response is authoritative for chart
   database and presentation-input invalidation. `cache_epoch` additionally
   folds in `scene_schema`, `display_fingerprint`, and renderer identity.
2. **Cache key stability.** Keys are normalized `key=value;...` strings sorted by
   field name. Clients and servers must compute the same key for the same tuple.
3. **Stale-safe admission.**
   - `strict`: miss blocks presentation; stale entries must not substitute.
   - `stale_while_revalidate`: show the last good artifact while fetching; mark
     UI as warming/revalidating.
   - `stale_ok`: prefer fresh data but may keep showing stale tiles/artifacts
     during prefetch.
4. **No blank-edge panning.** For `intent=visible`, the union of `visible` and
   `overscan` entries must fully cover the viewport expanded by `margin_px` at
   the requested zoom, including device pixel ratio.
5. **Adjacent zoom warming.** When `zoom_policy.adjacent_offsets` includes `-1`,
   emit the parent tile covering the visible anchor. When it includes `+1` and
   `include_children`, emit up to four child tiles. Assign `blend_weight` in
   `(0,1]` for adjacent-level entries; `1.0` for the active zoom.
6. **Ordering.** Entries sort by ascending `priority`, then by `(z, x, y, role)`.

## Failure Rules

- Malformed requests fail closed with a diagnostic; no speculative entries.
- Missing `source_epoch` on the server fails closed; clients may continue with
  `source_epoch_hint` only for offline replay fixtures.
- Scheduler output must never embed chart object classes, S-52 rules, or feature
  attributes. Tile coordinates and cache keys only.
- Unknown `schema` versions are rejected before cache lookup.

## Related Docs

- [render-backend-v1.md](render-backend-v1.md) — draw-only backend contract.
- [VULKAN-HEADLESS-TILE-ADAPTER.md](../../VULKAN-HEADLESS-TILE-ADAPTER.md) — tile
  cache key and ETag material.
- [VULKAN-HELM-WEBGPU-PROOF.md](../../VULKAN-HELM-WEBGPU-PROOF.md) — browser vs
  server ownership boundary.
