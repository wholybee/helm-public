# Vulkan Render Fixtures

Status: POC fixture and regression contract for Vulkan board `SEAM-4`

This document defines the first fixture corpus and image-regression harness for
the shared Vulkan renderer seam. It builds on:

- [VULKAN-RENDERER-SEAM.md](VULKAN-RENDERER-SEAM.md)
- [VULKAN-RENDER-COMMAND-STREAM.md](VULKAN-RENDER-COMMAND-STREAM.md)
- [VULKAN-RENDER-ADAPTERS.md](VULKAN-RENDER-ADAPTERS.md)
- [VULKAN-DEPTH-FIXTURES.md](VULKAN-DEPTH-FIXTURES.md)

The goal is to catch semantic drift before pixel drift: command stream hashes
must be stable for a known source/view/display tuple, and image hashes must be
stable for a known backend/target once renderer output exists.

## Corpus Shape

Fixture roots live under:

```text
engine/test/fixtures/vulkan-render/
```

Each fixture directory contains:

```text
chart-1/
  manifest.json          # fixture metadata, capture matrix, expected hashes
  source.json            # redistributable synthetic or source descriptor
  scene.commands.json    # RenderScene command stream fixture
  provenance.json        # source/object/transform/quilt provenance
  render-model.json      # helm.render.model.v1 neutral primitive export
  render-model.bin       # deterministic binary-ready primitive stream
  render-artifact.json   # helm.render.artifact.v1 WebGPU-ready browser packet
  render-artifact.bin    # deterministic binary browser packet
  expected.ppm           # tiny dependency-free golden image placeholder
```

The fixture checker is a C++ CLI:

```bash
c++ -std=c++11 -O2 -Wall -Wextra \
  engine/vendor/cli/helm_vulkan_fixture_check.cpp \
  -o /tmp/helm-vulkan-fixture-check
/tmp/helm-vulkan-fixture-check --print-hashes
```

The same source is exercised by the dedicated fixture scripts and CI smoke.
`engine/bootstrap.sh` deliberately stays focused on the cold OpenCPN/Helm
install, C++ target build, runtime asset install, and ENC tile render path.

It validates fixture shape, canonical JSON hashes, provenance references,
required command types, optional neutral render-model exports, and expected
image hashes.

`RENDERMODEL-2` adds the first C++ neutral primitive export for `chart-1`:

```bash
scripts/render-model-fixture-export engine/test/fixtures/vulkan-render/chart-1 --check --print-hashes
```

The exporter consumes the current `scene.commands.json` plus `source.json` and
`provenance.json`, builds the typed `helm.render.model.v1` C++ model from
`engine/vulkan/render_model.h`, and writes both `render-model.json` for review
and `render-model.bin` as a stable length-prefixed binary-ready stream. Each
primitive preserves deterministic order, material/style keys, SCAMIN/display
state, and a source trace with chart id, source feature id, object class,
provenance refs, and inspection handles. The manifest records canonical JSON
and binary hashes so Helm/WebGPU, Vulkan/VSG, and future native paths consume
the same semantics rather than separate chart logic.

`ARTIFACT-1` adds the first C++ compiler from the neutral render model into
browser-consumable WebGPU artifact packets:

```bash
scripts/render-artifact-compile engine/test/fixtures/vulkan-render/chart-1 --check --print-hashes
```

The compiler builds the typed `helm.render.model.v1` C++ model from the
fixture command stream, then emits `helm.render.artifact.v1` packets with
vertices, indices, material/style tables, symbol/glyph/line atlas references,
tile/viewport metadata, draw batches, pick records, and stable checksums.
`render-artifact.json` is reviewable; `render-artifact.bin` is a compact
binary handoff for browser consumers. The manifest records canonical JSON and
binary hashes so WebGPU clients can load compiled geometry without re-running
chart semantics in the browser.

`ARTIFACT-2` adds machine-local cache identity and invalidation metadata:

```bash
scripts/render-artifact-compile engine/test/fixtures/vulkan-render/chart-1 --check --print-hashes
scripts/render-artifact-cache-smoke
```

Each `helm.render.artifact.v1` packet now carries a `cache` block
(`helm.render.artifact_cache.v1`) with chart epoch, source edition/update chain,
display-state snapshot, renderer schema versions, artifact packet checksum,
backend-specific cache keys for WebGPU and Vulkan/native consumers, and an
invalidation epoch. Artifacts remain rebuildable machine-local GPU/tile cache
entries; portable nautical truth stays in the neutral render model.

`VSG-1` adds a dependency-free C++17 fixture replay renderer:

```bash
scripts/vulkan-render-fixture engine/test/fixtures/vulkan-render/chart-1 --check
scripts/vulkan-render-fixture engine/test/fixtures/vulkan-render/chart-1 --tile-size 256 --format png --output /tmp/chart-1.png --print-hash
```

This renderer is a C++ CPU reference path for command-stream replay. It is
useful on machines without VulkanSceneGraph/Vulkan installed, and it gives the
real VSG backend deterministic pixels to compare against. It is not the VSG
backend itself.

`VSG-2` keeps that CPU reference path and adds a VSG/MoltenVK offscreen probe:

```bash
scripts/vulkan-vsg-offscreen-probe engine/test/fixtures/vulkan-render/chart-1 --tile-size 256 --output /tmp/chart-1-vsg.png
```

The dependency-free `--tile-size`
scales the logical fixture target to a Helm-style square tile, `--format png`
encodes deterministic RGB PNG bytes without opening a window, and
`expected_offscreen[]` records cache-friendly output hashes for regression
evidence. The VSG probe uploads the same fixture image as a texture, renders it
through a windowless VSG framebuffer, copies the color attachment back to
host-visible memory, writes deterministic PNG bytes, and records comparable
hashes in `expected_vsg_offscreen[]`.

`VSG-3` adds the matching interactive/swapchain probe:

```bash
scripts/vulkan-vsg-interactive-probe engine/test/fixtures/vulkan-render/chart-1 --report /tmp/chart-1-vsg-interactive.txt
```

The probe opens a small VSG window/swapchain, presents the fixture texture
through a scripted OpenCPN-style viewport sequence, and records the swapchain
extent plus four deterministic frames: full viewport, inset viewport resize,
pan, and zoom-with-pan. The checked artifact is a text report hash stored in
`expected_vsg_interactive[]`; pixel readback remains covered by the VSG-2
offscreen target. On macOS VSG builds with native window creation disabled, the
probe adapts an `NSWindow`/MoltenVK surface through `vsg::WindowAdapter`, which
matches the integration shape OpenCPN's chart canvas will need.

`CHART-7` adds the flagged Forge package symbol-selection smoke:

```bash
engine/test-vulkan-symbol-selection-render.sh
```

This smoke replays `engine/test/fixtures/vulkan-render/symbol-selection` in a
diagnostic-only renderer path. It validates day/dusk/night PPM baselines,
nonblank image stats, no raw witness-red leakage, and DB conformance against
`runtime_symbol_candidate_v1`, `runtime_symbol_portrayal_v1`, and the Forge
runtime evidence snapshot while keeping the Forge package path opt-in. See
[CHART-7-FLAGGED-FORGE-RENDER-SMOKE.md](CHART-7-FLAGGED-FORGE-RENDER-SMOKE.md).

`CHART-9` adds the runtime eligibility gate:

```bash
engine/test-symbol-runtime-gate.sh
```

This smoke proves default chart lookup admits only accepted/final-approved
`chart_portrayal` rows, keeps pending/rejected/fail-closed rows diagnostic-only,
and routes approved overlay or extension/profile rows only through explicit
scope lookup. See
[CHART-9-RUNTIME-ELIGIBILITY-GATE.md](CHART-9-RUNTIME-ELIGIBILITY-GATE.md).

## Redistributable Fixture Policy

Committed fixtures must be redistributable:

- repo-owned synthetic fixtures are allowed and should be small;
- public NOAA ENC cells may be referenced by id and downloaded during an
  explicit capture job, but the chart cell itself should not be committed;
- user/private chart packs, S-63 material, oeSENC output, private imagery, and
  generated SENC caches must not be committed.

The first committed fixture is `chart-1`, a synthetic scene that exercises the
schema without carrying any third-party chart data.

`s52-semantics` is the first rule fixture. It is still synthetic, but it is
executable: the checker re-evaluates display category, SCAMIN, draw ordering,
and safety-depth classifications from `source.json` and compares those
decisions with the emitted command stream plus `semantic.culled` diagnostics.
It deliberately proves that:

- display-base features stay visible in Standard display;
- Standard features render, while Other-category features are culled in
  Standard display;
- a SCAMIN-limited feature is hidden at scale denominator 24000 but visible at
  scale denominator 10000;
- S-52 order keys are sorted before backend submission;
- depth areas, safety contours, and soundings carry resolved safety classes.

The first real ENC capture targets should be downloaded at runtime:

```text
US5FL4CR  Key West sample cell used by scripts/install-sample-enc.sh
US5FL96M  historical headless-render proof cell, if still publicly available
```

For depth, shoreline, and safety-contour coverage, the selected DEPTH-1 cells
and capture order are in [VULKAN-DEPTH-FIXTURES.md](VULKAN-DEPTH-FIXTURES.md).

Record NOAA source URL, edition/update metadata, and downloaded cell hash in the
fixture manifest, but keep the raw cell outside Git.

## Capture Matrix

Every real capture should name the exact tuple that produced it:

```text
source epoch
render view: projection, bbox/tile, scale denominator, rotation, pixel size
display state: palette, display category, safety depths, text/soundings toggles
backend: command-stream fixture, VSG offscreen, OpenCPN onscreen test target
output format: command JSON, PNG, or debug PPM
```

Minimum matrix for the first real ENC fixture:

| Name | Palette | Display Category | Safety Depth | View |
|---|---|---|---|---|
| day-standard-z12 | day | standard | 10 m | one Key West tile |
| dusk-standard-z12 | dusk | standard | 10 m | same tile |
| night-standard-z12 | night | standard | 10 m | same tile |
| day-all-z13 | day | all | 10 m | detail tile |
| day-standard-safety20 | day | standard | 20 m | same as day-standard-z12 |

The first image baseline may be a small synthetic PPM so the harness is
dependency-free. Renderer-produced PNGs should be added when the VSG/offscreen
backend can replay the fixture.

## Regression Flow

1. Validate manifest and JSON schema shape.
2. Canonicalize `source.json`, `scene.commands.json`, and `provenance.json`.
3. Compare canonical SHA-256 values against `manifest.json`.
4. Validate every command `provenance_refs[]` id exists in `provenance.json`.
5. Validate required command types are present.
6. Re-evaluate semantic fixtures, when `semantic_assertions` are present, before
   any pixel check.
7. Compare committed expected image hashes.
8. Optionally replay dependency-free fixture output with
   `scripts/vulkan-render-fixture`.
9. When VSG/MoltenVK is available, compare VSG framebuffer readback hashes with
   `scripts/vulkan-vsg-offscreen-probe`.
10. When a display-backed swapchain is available, present the same fixture with
    `scripts/vulkan-vsg-interactive-probe` and compare the scripted viewport
    report hash.

This lets failures point to the right layer:

- source hash change: fixture input changed;
- command hash change: semantic/conversion/order drift;
- semantic assertion change: category, SCAMIN, safety, or order drift before
  renderer pixels are involved;
- provenance hash change: debug lineage changed;
- image hash change with stable command hash: backend/pixel drift.

## Acceptance For SEAM-4

SEAM-4 is complete when:

- the fixture corpus has a redistributable starter fixture;
- the harness passes in a clean checkout without network access;
- the fixture manifest records command/provenance/image hashes;
- docs identify the first real NOAA ENC capture targets and matrix;
- future renderer work has a concrete command/image regression path.
