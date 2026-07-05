# ADR-0014 - Compact Environmental Grid Packs

- **Status:** Accepted direction for `WX-19` replacement path; implementation split across `WX-30` through `WX-35` and `WX-20`
- **Date:** 2026-07-02
- **Supersedes for new WX work:** [ADR-0012](0012-environmental-model-run-bundles.md) when that work implies PNG/value-tile pyramids as the primary storage format
- **Builds on:** `WX-17`, `WX-18`, `WX-19`, `OFFLINE-15`, `OFFLINE-16`, `OFFLINE-17`, `ENGINE-18`, `ENGINE-19`, `HELMC++-1`, `HELMC++-9`

## Context

The WX-19 renderer work proved a useful scene path, but it also exposed the wrong storage and
runtime shape. A standing PNG pyramid avoids viewport races better than view-sized materialize jobs,
but it is still a huge image product. It burns disk, bandwidth, and Starlink budget; it also tempts
the client and service to hide missing data behind lower-detail or gateway output.

Helm needs a chartplotter weather system, not a Windy clone that only works online:

- offline route/GPS packs;
- global overview without boxes or seams;
- exact probe/sample values;
- Open-Meteo/NOAA/PredictWind/GRIB ingest;
- local pack inspection and cache control;
- C++ required-runtime ownership for boat-side services.

## Decision

Helm's new WX storage target is compact numeric environmental grid packs:

```text
schema:   helm.env.grid.pack.v1
payload:  helm.env.grid.chunk.v1
encoding: helm.env.grid.v1
```

PMTiles/packd remains valuable as the archive, index, and range-serving layer, but the payload inside
the archive is not assumed to be PNG. Low zoom should be global model-space lon/lat grids; high zoom
should be selected route/GPS-centred packs. The browser renders colour, alpha, time interpolation,
and particles from the numeric values, preferably with WebGPU.

The product rule is fail-loud:

- no surprise live/provider downloads during pan, zoom, scrub, toggle, or probe;
- no silent gateway substitution;
- no hidden precoloured PNG replacement when a grid chunk is missing;
- no permanent required Python backend.

## Consequences

- `WX-19` is reopened as a compact-grid/WebGPU architecture gate.
- `WX-30` owns metered/offline fail-loud mode.
- `WX-31` owns the `helm.env.grid.v1` contract.
- `WX-32` owns PMTiles/packd transport for grid packs.
- `WX-33` owns WebGPU rendering from grid packs and must align with Vulkan `HELMWEBGPU-5`.
- `WX-34` owns optional cloud/VM pack factory work so the laptop does not download/bake everything.
- `WX-35` owns cleanup of unused PNG/viewport/fallback paths.
- `WX-20` ports the required boat-side environmental runtime to small C++ services/modules after
  WX-19 proves the contract.

`helm.env.bundle.v1` and `helm-wxv1` value PNGs remain useful compatibility fixtures and reference
oracles. They are no longer the accepted final storage architecture for WX-19.
