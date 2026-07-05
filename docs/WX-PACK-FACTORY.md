# WX pack factory

Status: `WX-34` implementation slice
Depends on: `WX-30`, `WX-31`, `WX-32`

The WX pack factory is the cloud/VM/R2-side job boundary for Helm weather. It moves heavy model
ingestion and pack materialization off the boat laptop while keeping the boat offline-first:

- the factory downloads/normalizes upstream model data once per model run;
- it publishes compact `helm.env.grid.v1` packs through the WX-32 PMTiles/packd transport;
- the boat sees a size-aware release catalog and pulls only selected packs/chunks;
- pan, zoom, layer toggle, timeline scrub, and probe never call upstream weather providers;
- missing, stale, unsupported, or incomplete data fails loud.

It is not a Mac daemon and it is not a PNG pyramid generator.

## Job contract

The job schema is:

```text
helm.wx.pack_factory.job.v1
```

The dependency-free reference CLI is:

```bash
python3 scripts/wx_pack_factory.py publish services/wx/fixtures/wx-pack-factory-job.json \
  --out /tmp/helm-wx-packs
```

The first slice supports declared fixture/local manifest sources. Provider adapters such as
Open-Meteo, NOAA, or imported GRIB must be explicit cloud-worker adapters; they must not run as
surprise live downloads during boat interaction.

If a job declares a network-backed adapter without explicit cloud permission, the CLI exits with:

```text
network_forbidden
```

Source freshness is measured against the worker wall clock by default, not against the job's own
`generatedAt`. Deterministic fixture replay must opt in with `--replay-clock`.

## Release layout

Publishing writes a complete release under:

```text
<out>/releases/<release-id>/
  index.json
  packs/
    <release-id>-global-low-<anchor>.pmtiles
    <release-id>-global-low-<anchor>.pmtiles.manifest.json
    <release-id>-global-low-<anchor>.metadata.json
    <release-id>-route-high-<anchor>.pmtiles
    <release-id>-route-high-<anchor>.pmtiles.manifest.json
    <release-id>-route-high-<anchor>.metadata.json
```

After all packs verify, the factory atomically updates:

```text
<out>/current.json
```

That pointer is the model-run refresh gate. A failed bake leaves the previous `current.json` in
place.

## Release catalog

The release index schema is:

```text
helm.wx.pack_factory.release.v1
```

Each pack entry exposes:

- `packId`;
- `packUrl`;
- `manifestUrl`;
- `sizeBytes`;
- `manifestBytes`;
- `totalDownloadBytes`;
- `chunkCount`;
- `layers`;
- `validTimes`;
- `coverage`;
- source/provenance/license metadata;
- SHA-256 checksums for the archive and manifest.

This is the Starlink-safe contract: the client can show the bytes before download and refuse
unexpected fallback fetches.

## Failure policy

Factory failures are named and auditable:

| Code | Meaning |
|---|---|
| `missing_source` | Required source manifest/input is absent. |
| `stale_source` | Source is older than the job's allowed `maxSourceAgeHours`. |
| `network_forbidden` | A network adapter was requested without explicit cloud-worker permission. |
| `unsupported_source_adapter` | A source adapter is unknown or not implemented yet. |
| `missing_layer` / `missing_tier` | Source cannot satisfy the requested pack profile. |
| `duplicate_chunk_key` / `duplicate_pack_name` | A job would overwrite pack data or chunk metadata. |
| `invalid_time` | A job timestamp was invalid or lacked an explicit UTC offset / `Z`. |
| `png_payload_forbidden` | A job tried to emit PNG weather payloads. |
| `checksum_mismatch` / `missing_range` / `bad_chunk_magic` | WX-32 pack verification failed. |
| `pack_verification_failed` | WX-32 pack tooling failed without a more specific known code. |

No failure may be hidden by gateway substitution, placeholder data, or loose PNG weather tiles.

## Runtime boundaries

| Component | Owns |
|---|---|
| Cloud/VM pack factory | Provider ingest, source validation, model-run normalization, release publication. |
| `helm-packd` | Local/range serving and catalog visibility for selected packs. |
| `helm-envd` / future C++ WX runtime | Boat-side pack validation, inventory, stale/offline/error state, selected-pack prefetch. |
| Browser WebGPU scene | Sampling, colorization, alpha, time interpolation, particles. |

The Python CLI is reference/tooling for the cloud-job shape, not a required boat daemon. Productized
boat-side runtime remains the C++ `helm-packd`/`helm-envd` path.


## Open-Meteo live adapter (WX-36)

`sources[].type: "open-meteo"` fetches real model values at publish time:

- **Commercial hosts only** (`customer-api.open-meteo.com` + `customer-marine-api.open-meteo.com`),
  key from `$HELM_WX_OPENMETEO_KEY` (override via `apiKeyEnv`). The free host is never a fallback —
  it burst-limits into silent grid holes, the exact failure the grid contract forbids. Keyless runs
  fail `missing_credentials` before any fetch; upstream 429 fails `rate_limited`.
- **Calls scale with grid points only** (`ceil(points/140)` per host): one batched call returns all
  hourly vars and ALL valid times, so frames are free. A route-high passage window (40x30 deg @
  0.25) is ~280 calls total for the core five layers.
- **Any failed batch aborts the bake** — the factory never publishes a pack with silent holes.
  NaN/missing upstream values become band `nodata` honestly; quantization overflow fails loud.
- Values are SI per the grid contract (§5): forecast vars request `wind_speed_unit=ms`; marine
  current speeds arrive km/h and are converted. Wind direction is FROM (u = -v*sin, v = -v*cos);
  ocean-current direction is TOWARD (positive signs) — matching `services/wx` and the renderers.
- Tests: `python3 scripts/test-wx-openmeteo-adapter.py` (mock upstream, zero live network).
- One-command bake: `python3 scripts/wx_bake_openmeteo.py --anchor 177.4,-17.6 --out ~/.helm/wx-packs`
  (prints the exact call count before fetching; `--dry-run` to inspect the job).
