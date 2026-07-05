# Source-To-Pixel Inspection Trace Contract

Status: architecture contract for `helmrenderer` `INSPECT-1`  
Schema: `helm.inspect.trace.v1`  
Code anchor: `engine/vulkan/inspection_trace.h`  
Fixtures: `engine/test/fixtures/vulkan-render/inspection-trace/traces/`

This contract defines how a clicked rendered pixel maps back to chart source,
presentation, primitive, artifact, and backend draw records. It builds on:

- `helm.render.model.v1` (`engine/vulkan/render_model.h`, `RENDERMODEL-1`)
- `vulkan.provenance.v0` provenance tables in render fixtures
- `vulkan.render_scene.v0` command streams

`INSPECT-2` will implement pick-buffer round trip against this contract. Backends
must not invent chart semantics; they only bind pixels to records already emitted
by the presentation compiler.

## Resolution Kinds

Every trace declares exactly one resolution kind:

| kind | meaning |
| --- | --- |
| `vector_feature` | Pick resolved to a vector primitive with source feature metadata |
| `raster_fallback` | Pick hit raster pixels without per-feature metadata |
| `no_hit` | Pick missed all drawable primitives |

`feature_metadata_available` must be `true` only for `vector_feature`. Raster and
no-hit traces must keep it `false`.

## Trace Envelope

```json
{
  "schema_version": "helm.inspect.trace.v1",
  "trace_id": "inspect.chart-1.boyspp-1.pixel-5-3",
  "pick": {
    "pixel": [5, 3],
    "device_pixel_ratio": 1,
    "viewport_id": "fixture.chart-1.day-standard-z12",
    "backend": "cpu-reference",
    "scene_id": "chart-1-day-standard-z12",
    "model_id": "model.chart-1.day-standard-z12"
  },
  "resolution": {
    "kind": "vector_feature",
    "feature_metadata_available": true
  },
  "draw_record": { "...": "..." },
  "presentation": { "...": "..." },
  "source": { "...": "..." },
  "raster_fallback": { "...": "..." },
  "inspection_handles": ["inspect.BOYSPP-1"],
  "warnings": []
}
```

## Draw Record

Binds the picked pixel to the backend-visible draw path:

```text
draw_record
  draw_record_id
  command_id
  command_type
  primitive_id
  primitive_kind
  artifact_id
  layer_id
  provenance_refs[]
```

Rules:

- `command_id` must match a command in the active scene stream.
- `provenance_refs[]` must resolve against the fixture provenance table.
- `primitive_id` and `primitive_kind` come from `helm.render.model.v1`.
- `artifact_id` names the rendered output tile/frame the pick was sampled from.
- `draw_record_id` is stable within one render pass and may be reused by pick buffers.

## Presentation Binding

```text
presentation
  presentation_authority
  presentation_rule_id
  material_id
  style_key
  conversion_stage
```

These fields explain why the source feature became the visible primitive. They map
directly to `SourceTrace` in `render_model.h`.

## Source Binding

```text
source
  source_chart_id
  source_chart_edition
  source_update
  source_feature_id?
  source_feature_sub_id?
  object_class?
  attributes[{code,value}]
  source_geometry_hash
  transform_chain[]
  quilt_decision_id
```

For `vector_feature`, `source_feature_id` and `object_class` are required.

For `raster_fallback`, chart identity may be present but feature identity must be
absent or null. Do not synthesize fake feature ids for raster pixels.

## Raster Fallback Honesty

Raster picks must surface explicit fallback state:

```text
raster_fallback
  active
  reason
  message
  sidecar_metadata_available
  sidecar_name
```

Required when `resolution.kind = raster_fallback`:

- `active = true`
- non-empty `reason` and `message`
- `feature_metadata_available = false`

Allowed reasons:

- `raster_pixels_no_sidecar`
- `raster_debug_placeholder`
- `raster_sidecar_miss`

Example message:

```text
Raster packs contain pixels only; object inspection is unavailable unless a sidecar metadata layer is present.
```

If a sidecar exists but does not cover the picked pixel, the trace may set
`sidecar_metadata_available = true` while keeping `feature_metadata_available = false`
and recording a warning.

## Mapping From Existing Fixtures

`chart-1` command/provenance fixtures provide the canonical binding examples:

| pixel | command | provenance | resolution |
| --- | --- | --- | --- |
| `[5, 3]` | `cmd.symbol.boyspp-1` | `prov.boyspp-1` | `vector_feature` |
| `[2, 2]` | `cmd.raster.debug-collar` | `prov.raster.debug-collar` | `raster_fallback` |
| `[0, 0]` outside drawable stack | none | none | `no_hit` |

## Validation

```bash
scripts/inspection-trace-smoke
```

The smoke binary parses every fixture trace, checks schema version, enforces
resolution-specific completeness, and verifies raster fallback honesty.

## Relationship To Debug Service Trace

`docs/proposals/interfaces/inspection-trace-v1.md` describes the broader
multi-hop debug envelope (`helm.debug.trace.v1`). That envelope may embed one or
more `helm.inspect.trace.v1` records as the render-stage evidence for a picked
pixel. This contract is the render/pick slice only.
