# WX-20 — `helm-envd` C++ environmental grid-pack service

WX-20 ports the first required boat-side environmental runtime slice to C++.
It is intentionally small: a local grid-pack replay and validation service, not
a weather provider, renderer, scheduler, or monolithic Python port.

## Contract

`helm-envd` consumes one or more packed `helm.env.grid.v1` manifests from:

```bash
HELM_ENV_GRID_MANIFESTS=/path/to/pack.manifest.json[,/path/to/other.manifest.json]
```

Each manifest must describe compact numeric environmental chunks carried inside
a range-readable PMTiles/archive container:

- manifest schema: `helm.env.grid.pack.v1`
- chunk payload: `helm.env.grid.chunk.v1`
- transport: `pmtiles`
- byte ranges: `[offset, length]`
- checksum: `sha256:<digest>`

The first C++ slice supports uncompressed `HELMGRID` chunks with
`grid.origin == "northwest"`. Other chunk capabilities must fail loud until the
runtime explicitly supports them.

## HTTP surface

`helm-envd` binds to `HELM_BIND` (default `127.0.0.1`) and a port passed as
argv, defaulting to registered service port `8094`. Agent and CI tests should
use ephemeral or 9001+ private ports instead of the default.

| Endpoint | Purpose |
| --- | --- |
| `GET /health` | service health, pack count, validation error count, local-only flags |
| `GET /packs` | sanitized `helm.envd.inventory.v1` inventory with pack/layer/tier/time summaries and diagnostics |
| `GET /chunk?pack=<packId>&chunk=<chunkKey>` | validated `HELMGRID` chunk bytes |

The inventory does not expose local filesystem paths. Chunk reads return local
bytes only; they do not invoke Open-Meteo, gateway fetches, PNG substitutes, or
renderer fallbacks.

## Fail-loud behavior

Startup validates every configured manifest/chunk and records diagnostics:

- missing manifest/pack archive
- unsupported transport/container/payload/byte-range semantics
- missing chunks or invalid byte ranges
- short byte ranges
- checksum mismatch
- bad `HELMGRID` magic/version/header/schema
- unsupported compression
- unsupported grid origin
- unsupported or malformed endianness/compression/grid-origin header fields
- chunk byte ranges over the daemon safety cap
- request-time checksum drift after startup validation

If a pack has a pack-level validation error, `/chunk` returns
`409 invalid_pack` for that pack. If a chunk has a validation error, `/chunk`
returns `409 invalid_chunk`. Missing chunks return `404 missing_chunk`. This is
deliberate: WX pan/zoom/scrub/toggle workflows must not hide bad data behind
provider calls or PNG/gateway fallback.

## Runtime boundary

This is the first boat-side C++ replay/validation slice for prepared
environmental packs. It is not final HELMC++ acceptance for the whole
environmental runtime yet: provider/job parity, selected-pack refresh/import,
and client cutover remain incremental work.

Python under `services/wx` remains a reference/oracle and development bridge
until parity is complete; it is not accepted as final required runtime.

`helm-envd` also does not replace:

- `helm-packd`, which owns general chart/user-data pack transport.
- the WebGPU/MapLibre client renderer, which samples and colorizes grid values.
- the optional cloud/VM pack factory, which may build packs away from Starlink.
- future provider/job adapters, which should be separate bounded services.

## Verification

Build `helm-envd` in a private OpenCPN/Helm engine build, then run:

```bash
HELM_ENVD_BIN=/private/tmp/helm-wx20-opencpn/build/cli/helm-envd \
  python3 pipeline/test_helm_envd_contract.py
```

or:

```bash
HELM_ENVD_BIN=/private/tmp/helm-wx20-opencpn/build/cli/helm-envd \
  engine/test-envd.sh
```

The contract test creates a synthetic packed grid fixture, serves it from a
private port, verifies local-only inventory/chunk replay, and then mutates the
fixture to prove checksum, compression, and grid-origin failures surface early.
