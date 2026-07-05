# Interface: Render Backend v1

Schema family: `helm.render.*.v1`
Producer: `helm-chartd` presentation compiler
Consumer: `helm-renderd` or in-process backend module
Current code/docs anchors: renderer seam, draw backend, cache, native VSG backend, WebGPU consumer
Current C++ schema anchor: `engine/vulkan/render_model.h`

## Purpose

Define the draw-only backend contract. The backend draws render primitives; it does not own chart semantics.

## Owns

- GPU buffers.
- Texture and symbol atlas bindings.
- Draw batching.
- Framebuffer/offscreen targets.
- Device-specific artifact use.

## Does Not Own

- S-52/S-101 object semantics.
- Feature-to-symbol decisions.
- Display priority or chart z-order policy.
- Safety contour behavior.
- Text/sounding semantic placement.

## Input

Schema: `helm.render.model.v1`

The production in-memory form is the C++17 schema in
`engine/vulkan/render_model.h`. JSON fixtures remain useful for export,
debugging, and golden tests, but they are not the authority that decides chart
semantics. The presentation/chart layer emits typed nautical primitives; draw
backends consume them.

```json
{
  "schema": "helm.render.model.v1",
  "modelId": "model-001",
  "viewport": {
    "bbox": [-81.85, 24.43, -81.76, 24.57],
    "z": 13,
    "pixelSize": [256, 256]
  },
  "style": {
    "palette": "day",
    "displayCategory": "standard"
  },
  "layers": [
    {
      "id": "chart-points",
      "kind": "point-symbols",
      "authority": "presentation-compiler",
      "primitives": []
    }
  ],
  "trace": {"sourceProduct": "US5FL96M", "presentationId": "present-001"}
}
```

## Primitive Families

`helm.render.model.v1` contains these primitive families:

- `AreaFill`
- `LineStroke`
- `SymbolInstance`
- `TextLabel`
- `Sounding`
- `RasterPatch`
- `ContourLine`
- `CoverageMask`

Every primitive carries the same neutral envelope before backend handoff:

- stable order tuple: chart priority, quilt rank, display priority, render-pass
  rank, source sequence, and extension keys;
- material/style keys: material id, style key, palette ref, and optional
  symbol, line-style, pattern, font, or raster texture refs;
- source trace: source chart id, edition/update, source feature id, object
  class, source attributes, geometry hash, presentation authority/rule,
  transform chain, quilt decision, target bounds, provenance refs, and
  inspection handles;
- scale/display state: native scale, SCAMIN scale range, overzoom state,
  display category, safety class, contour role, danger class, and whether the
  primitive is safety relevant.

The backend may batch, upload, cache, or rasterize these primitives, but it must
not reinterpret S-52/S-101 object classes, SCAMIN, display category, safety
contours, text/sounding rules, or chart ordering.

Smoke check:

```bash
scripts/render-model-smoke
```

## Output

For tile rendering:

```json
{
  "schema": "helm.render.result.v1",
  "status": "ok",
  "mediaType": "image/png",
  "artifactId": "artifact-abc",
  "traceId": "trace-abc",
  "warnings": []
}
```

## Failure Rules

- Backend failure returns `render_failed`; chart service decides fallback.
- Backend must preserve trace handles.
- Backend must not silently substitute unknown symbols for safety-relevant chart primitives.
