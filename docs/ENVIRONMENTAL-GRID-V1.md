# Environmental Grid v1

Status: Draft contract for `WX-31` / `WX-19` replacement path  
Supersedes for new weather work: [`ENVIRONMENTAL-BUNDLE-V1.md`](ENVIRONMENTAL-BUNDLE-V1.md) PNG/value-tile bundle payloads  
ADR: [ADR-0014](decisions/0014-environmental-grid-packs.md)

`helm.env.grid.v1` is Helm's compact weather-field contract. It stores numeric model data, not
rendered image pyramids.

The point is deliberately narrow:

- the boat can inspect, probe, route-sample, cache, and render weather offline;
- the client renders colours, alpha, interpolation, and particles from values;
- PMTiles/packd may be used as the pack/index/range transport;
- PNG weather pyramids are not the canonical storage format;
- missing data, stale data, incomplete packs, and unsupported render capability fail loudly.

## 1. Non-negotiables

- **No silent substitution.** A consumer MUST NOT replace a missing grid chunk with gateway output,
  live provider fetches, placeholder values, precoloured PNGs, or another layer.
- **No pan/zoom/provider coupling.** Pan, zoom, layer toggle, timeline scrub, and probe MUST NOT call
  upstream weather providers.
- **No loose global image pyramids as the target.** Global overview data SHOULD be model-space
  lon/lat grids. High-detail passage data SHOULD be smaller route/GPS-centred grids.
- **No monolith.** Runtime responsibilities stay behind small service/module boundaries:
  package/range serving, grid-pack inventory, provider ingestion jobs, rendering, and cache policy are
  separate concerns.
- **C++ target path.** Required boat-side runtime services MUST have a C++ path. Python MAY remain as
  a reference/oracle/tooling implementation until parity is proven.

## 2. Pack identity

A grid pack is a package or HTTP namespace containing one model run, one source family, one or more
valid times, and one or more resolution tiers.

Recommended ids:

```text
<provider>/<model>/<run-id>/<pack-profile>/<anchor-or-global>
open-meteo/gfs-seamless/20260701T000000Z/global-low/global
noaa/gfs/20260701T000000Z/route-high/fiji-tonga-202607
predictwind/import/20260701T000000Z/route-high/steve-passage
```

The pack manifest schema is:

```text
helm.env.grid.pack.v1
```

The chunk payload schema is:

```text
helm.env.grid.chunk.v1
```

The canonical value encoding name is:

```text
helm.env.grid.v1
```

## 3. Manifest shape

```jsonc
{
  "schema": "helm.env.grid.pack.v1",
  "encoding": "helm.env.grid.v1",
  "packId": "open-meteo/gfs-seamless/20260701T000000Z/global-low/global",
  "productFamily": "met-ocean",
  "generatedAt": "2026-07-01T00:20:00Z",
  "source": {},
  "run": {},
  "transport": {},
  "coverage": {},
  "tiers": {},
  "layers": {},
  "chunks": {},
  "failurePolicy": {},
  "renderContract": {},
  "serviceBoundaries": {}
}
```

Required fields:

| Field | Meaning |
|---|---|
| `schema` | MUST be `helm.env.grid.pack.v1`. |
| `encoding` | MUST be `helm.env.grid.v1`. |
| `packId` | Stable id used by packd, cache inventory, and client fetches. |
| `source` | Provider, model, provenance, licensing, and advisory/not-for-navigation flags. |
| `run` | Model run time, valid times, cadence, and retention window. |
| `transport` | Container/index details such as PMTiles-compatible range serving. |
| `coverage` | CRS, global/wrapped bbox, route/GPS anchor, and antimeridian rules. |
| `tiers` | Resolution tiers such as `global-low` and `route-high`. |
| `layers` | Layer-to-band metadata, units, scale/offset, nodata, and vector pairing. |
| `chunks` | Chunk index by layer, tier, valid time, and chunk key. |
| `failurePolicy` | Required fail-loud behavior. |
| `renderContract` | WebGPU/CPU requirements and alpha/interpolation semantics. |
| `serviceBoundaries` | Which service/module owns serving, ingestion, rendering, and C++ parity. |

## 4. Tiers

The preferred low-zoom tier is a global lon/lat model-space grid. It is not a WebMercator image
pyramid.

```jsonc
"tiers": {
  "global-low": {
    "role": "overview",
    "crs": "OGC:CRS84",
    "grid": { "dx": 0.5, "dy": 0.5, "width": 720, "height": 361 },
    "chunking": { "lonSpan": 10.0, "latSpan": 10.0 },
    "clientZoomRange": [0, 5]
  },
  "route-high": {
    "role": "passage",
    "crs": "OGC:CRS84",
    "grid": { "dx": 0.1, "dy": 0.1 },
    "anchor": { "type": "gps-route", "driftThresholdNm": 120 },
    "clientZoomRange": [5, 10]
  }
}
```

Rules:

- `global-low` SHOULD be present for core layers so zoomed-out weather is always defined.
- `route-high` SHOULD be selected explicitly by GPS/route/passsage planning and may be absent until
  the user installs that pack.
- A missing tier is `out_of_pack`, not an invitation to call a provider.
- Antimeridian crossing is normal lon wrap. Consumers MUST sample wrapped longitudes instead of
  splitting UI state around `180°`.

## 5. Layers and bands

Core layers:

| Layer | Bands | Units | Notes |
|---|---|---|---|
| `wind` | `u`, `v` | m/s | Particles and colour magnitude sample the same values. |
| `current` | `u`, `v` | m/s | Same vector contract as wind. |
| `rain` | `rate` | mm/h | Scalar. |
| `waves` | `height` | m | Scalar, optional direction/period bands later. |
| `swell` | `height` | m | Scalar, optional direction/period bands later. |

Secondary layers such as gust, temperature, SST, cloud, pressure, and CAPE MAY use the same chunk
format. They are allowed to be absent; absence MUST be visible as unavailable.

Bands are stored band-major in the chunk payload. Each band declares:

```jsonc
{
  "type": "int16",
  "scale": 0.01,
  "offset": 0.0,
  "nodata": -32768,
  "unit": "m/s"
}
```

Consumers compute the physical value as:

```text
physical = stored * scale + offset
```

`float16` and `uint16` MAY be added when a layer has a better quantified range. A consumer MUST fail
with `unsupported_band_type` if it cannot decode the declared type.

## 6. Chunk binary envelope

Each chunk payload is:

```text
magic        8 bytes   "HELMGRID"
version      uint16    1
flags        uint16
header_len   uint32    bytes of UTF-8 JSON header
header       JSON      chunk schema/provenance/band/grid metadata
payload      bytes     compressed or raw band-major values
```

The header MUST include:

```jsonc
{
  "schema": "helm.env.grid.chunk.v1",
  "encoding": "helm.env.grid.v1",
  "endianness": "little",
  "compression": "zstd",
  "tier": "global-low",
  "layer": "wind",
  "validTime": "2026-07-01T03:00:00Z",
  "bbox": [-180, -90, -170, -80],
  "grid": { "width": 21, "height": 21, "dx": 0.5, "dy": 0.5, "origin": "northwest" },
  "bands": {
    "u": { "type": "int16", "scale": 0.01, "offset": 0, "nodata": -32768, "unit": "m/s" },
    "v": { "type": "int16", "scale": 0.01, "offset": 0, "nodata": -32768, "unit": "m/s" }
  }
}
```

Grid registration is pinned (WX-35): `grid.origin` is `"northwest"` — row 0 is the NORTH edge
(rows increase southward), column 0 is the west edge (columns increase eastward), values are
band-major. Producers MUST emit it; consumers MUST treat an absent `origin` as `northwest`
(v1 packs predate the pin) and MUST fail with `unsupported_grid_origin` for any other value.

Compression choices are implementation-defined per pack. A consumer MUST fail with
`unsupported_compression` if the pack declares a codec it cannot read. Do not silently switch to an
online source.

## 7. Transport and packd

PMTiles is useful as an archive/index/range transport. The payload inside the archive MAY be
`helm.env.grid.chunk.v1`, not an image tile.

The pack manifest MUST state:

```jsonc
"transport": {
  "container": "pmtiles",
  "payload": "helm.env.grid.chunk.v1",
  "rangeReadable": true,
  "servedBy": "helm-envd",
  "requiredRuntime": "C++",
  "packUrl": "open-meteo-gfs-20260701T000000Z-global-low.pmtiles",
  "byteRangeSemantics": "offset-length",
  "checksumAlgorithm": "sha256"
}
```

`helm-packd` owns byte-range serving, pack inventory, and cache metadata. It does not own weather
physics or colour ramps.

Each chunk index entry uses `byteRange: [offset, length]`, not inclusive end offsets. The client
requests `Range: bytes=<offset>-<offset + length - 1>`, verifies the exact byte count, checks the
declared `sha256:<hex>` checksum, and only then decodes the `HELMGRID` envelope. Missing ranges,
short reads, checksum mismatches, or bad chunk magic are hard failures with visible diagnostics.

The packer emits a public sidecar (`<pack>.metadata.json`) for `helm-packd` catalog visibility:
`kind=environmental-grid`, `helm_pack_schema=helm.env.grid.pack.v1`,
`encoding=helm.env.grid.v1`, `payload=helm.env.grid.chunk.v1`, layer/tier ids, chunk count, and
failure policy. Filesystem paths and private provider credentials remain excluded from catalog
responses.

## 8. Render contract

The browser renderer samples grid values, then applies ramps, alpha, interpolation, and particles.

Rules:

- WebGPU SHOULD render modern clients.
- MapLibre remains the map/chart compositor.
- Alpha MUST be premultiplied/alpha-correct: moving the transparency slider changes opacity, not
  colour saturation or brightness.
- Time interpolation lerps values before colourization.
- Particles sample the same vector fields as the colour layer.
- If the renderer lacks required features for the selected layer, it MUST report
  `unsupported_renderer_capability`.
- A precoloured raster MAY appear only in explicitly named dev/reference evidence. It MUST NOT be
  used to hide a missing grid in the product path.

## 9. Failure policy

Every production pack MUST include:

```jsonc
"failurePolicy": {
  "missingChunk": "fail-loud",
  "staleRun": "show-stale-status",
  "unsupportedCapability": "fail-loud",
  "upstreamFetchDuringGesture": "forbidden",
  "substitution": "forbidden"
}
```

Required diagnostic fields:

| Field | Example |
|---|---|
| `code` | `missing_chunk`, `stale_run`, `out_of_pack`, `unsupported_compression` |
| `layer` | `wind` |
| `tier` | `global-low` |
| `validTime` | `2026-07-01T03:00:00Z` |
| `chunkKey` | `global-low/wind/20260701T030000Z/-180_-90` |
| `packId` | `open-meteo/gfs-seamless/20260701T000000Z/global-low/global` |
| `action` | `install pack`, `select route pack`, `wait for model run`, `enable WebGPU` |

## 10. Service boundaries

| Boundary | Runtime target | Owns | Does not own |
|---|---|---|---|
| cloud/VM pack factory | service/job, C++ path for productized backend | provider ingest, model-run normalization, pack publication | cockpit rendering |
| `helm-packd` | C++ | range serving, local pack inventory, cache/eviction metadata | weather physics |
| `helm-envd` / `helm-wxd` | C++ | grid-pack validation, selected-pack prefetch, stale/offline/error states | provider calls during gestures |
| browser WX scene | JS/WebGPU | sampling, colourization, alpha, interpolation, particles | data acquisition |
| Python `services/wx` | dev/reference/oracle only after parity | fixtures, comparison, transitional experiments | required boat runtime |

## 11. Acceptance

`WX-31` is accepted when:

- this contract has a golden manifest fixture;
- a validator rejects missing fail-loud policy, image-tile-only payloads, and unsupported encodings;
- at least one synthetic chunk fixture proves the binary envelope can carry scalar and vector bands;
- a range-readable PMTiles/packd shell can carry real `helm.env.grid.chunk.v1` byte ranges with
  checked SHA-256 integrity and no PNG payloads;
- `WX-32`, `WX-33`, `WX-34`, `WX-35`, and `WX-20` can reference this contract without inventing new
  storage semantics.
