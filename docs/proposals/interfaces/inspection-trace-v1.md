# Interface: Source-To-Render Inspection Trace v1

Schema family: `helm.inspect.trace.v1`, `helm.debug.trace.v1`  
Producers: pick buffer, presentation compiler, render backends, debug services  
Consumers: debug UI, tests, agents, reviewers  
Current code/docs anchors: `engine/vulkan/inspection_trace.h`, `docs/INSPECTION-TRACE-CONTRACT.md`

## Purpose

Make a rendered pixel or selected object explainable from source to screen.

`helm.inspect.trace.v1` is the render/pick slice: one clicked pixel bound to source
chart, feature id, presentation rule, primitive id, artifact id, and backend draw
record. `helm.debug.trace.v1` is the broader multi-hop envelope that may embed one
or more inspect traces as render-stage evidence.

## Owns

- Pick request envelope.
- Resolution kind (`vector_feature`, `raster_fallback`, `no_hit`).
- Draw record binding to command stream and provenance refs.
- Presentation/compiler decision references.
- Source chart and feature metadata when available.
- Raster fallback honesty when feature metadata is absent.
- Warnings and missing evidence.

## Does Not Own

- Source data truth.
- Chart portrayal decisions.
- Legal equivalence to official standards.

## Pick Trace

Schema: `helm.inspect.trace.v1`

```json
{
  "schema_version": "helm.inspect.trace.v1",
  "trace_id": "inspect.chart-1.boyspp-1.pixel-5-3",
  "pick": {
    "pixel": [5, 3],
    "backend": "cpu-reference",
    "scene_id": "chart-1-day-standard-z12"
  },
  "resolution": {
    "kind": "vector_feature",
    "feature_metadata_available": true
  },
  "draw_record": {
    "draw_record_id": "draw.chart-1.cmd.symbol.boyspp-1",
    "command_id": "cmd.symbol.boyspp-1",
    "primitive_id": "prim.boyspp-1.symbol",
    "artifact_id": "artifact.chart-1.tile-256",
    "provenance_refs": ["prov.boyspp-1"]
  },
  "presentation": {
    "presentation_authority": "s52",
    "presentation_rule_id": "rule.BOYSPP"
  },
  "source": {
    "source_chart_id": "SYNTH-CHART-1",
    "source_feature_id": "BOYSPP-1",
    "object_class": "BOYSPP"
  },
  "raster_fallback": {
    "active": false
  }
}
```

Fixture examples live under
`engine/test/fixtures/vulkan-render/inspection-trace/traces/`.

## Service Debug Trace

Schema: `helm.debug.trace.v1`

```json
{
  "schema": "helm.debug.trace.v1",
  "traceId": "trace-abc",
  "status": "ok",
  "request": {
    "kind": "chart-query",
    "point": {"lat": 24.4587, "lon": -81.8078},
    "viewport": {"z": 13}
  },
  "hops": [
    {
      "service": "helm-chartd",
      "stage": "source-feature",
      "status": "ok",
      "source": {"product": "US5FL96M", "objectClass": "WRECKS"}
    },
    {
      "service": "helm-renderd",
      "stage": "draw",
      "status": "ok",
      "artifactId": "artifact-123",
      "inspectTraceId": "inspect.chart-1.boyspp-1.pixel-5-3"
    }
  ],
  "warnings": []
}
```

## Failure Rules

- Missing provenance is a warning or failure, never silently absent.
- Raster picks must set `resolution.kind = raster_fallback`, `feature_metadata_available = false`, and a non-empty fallback `message`.
- Trace must distinguish chart artifacts, overlays, and UI symbols.
- Do not synthesize feature ids for raster pixels without sidecar metadata.

## Validation

```bash
scripts/inspection-trace-smoke
```

See `docs/INSPECTION-TRACE-CONTRACT.md` for the full field contract.
