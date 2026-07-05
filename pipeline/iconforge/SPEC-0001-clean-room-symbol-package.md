# SPEC 0001: Clean-room Maritime Symbol Package

Short name: CMSP
Status: Draft
Version: 0.1
Date: 2026-07-02
Primary implementation lane: Vulkan `FORGE`

## Purpose

This specification defines the package Forge should publish when the generated
maritime symbol library is ready for public review and reuse.

The goal is not to create a new charting authority. The goal is to publish a
clean implementation of maritime symbol semantics as generated SVG assets,
machine-readable manifests, QA evidence, provenance, and a human-review catalog.

The package must be usable by:

- OpenCPN/Vulkan integration paths.
- Helm C++ runtime code.
- iOS/native applications.
- WebGPU/browser clients.
- Plain SVG consumers.
- Atlas/sprite-sheet renderers.

## Design Position

CMSP is a clean-room implementation package.

It implements relevant maritime symbol semantics using generated artwork and
Helm-authored metadata. S-52, S-57/S-52 lookup vocabulary, S-100/S-101 concepts,
OpenCPN output, and Chart No.1 visual material are used as standards vocabulary,
semantic anchors, and comparison targets.

They are not the package being shipped.

The publishable artifact is:

- Generated SVG.
- Palette-resolved SVG exports.
- Optional atlas/raster outputs derived from generated SVG.
- Helm-authored manifests.
- QA reports.
- Comparison evidence.
- Provenance records.
- A static public catalog and visual proof site.

## Non-goals

CMSP does not:

- Replace IHO S-52, S-57, S-100, S-101, S-98, or ECDIS standards.
- Define official ECDIS portrayal.
- Certify navigation safety or regulatory compliance.
- Define chart feature selection.
- Define chart z-order, display priority, SCAMIN, decluttering, safety contours,
  or text/sounding placement.
- Claim that generated symbols are official IHO or OpenCPN artwork.
- Require applications to use one rendering backend.

Chart portrayal remains owned by the chart presentation compiler and applicable
source standards. CMSP owns generated assets, package metadata, QA state,
provenance, and proof presentation.

## Required Repository Output

A completed package must contain this shape, or an explicitly documented
equivalent:

```text
proof/
  index.html
  catalog/
    index.html
  compare-opencpn.html
  manifest.json
  missing-hard-pile.json
  coverage.json
  svg-day/
  svg-dusk/
  svg-night/
  atlas/
    day/
    dusk/
    night/
  evidence/
    visual-parity/
    provenance/
registry/
  symbols.json
  symbols.yaml
  symbol.schema.json
assets/
  svg/
    canonical/
tools/
  validate_registry.py
```

The exact paths may evolve, but the package must provide:

- Palette-resolved SVG for day, dusk, and night.
- Canonical SVG or a generated visual recipe for each published symbol.
- A manifest with standards profile, render targets, QA, provenance, and mapping
  data.
- A missing/hard-pile report.
- Human-readable proof pages.
- Machine-readable coverage summary.

## Standards Profile

Every package manifest must declare a `standards_profile`.

Required fields:

- `implementation_goal`
- `source_standards`
- `conformance_note`

Required source-standard coverage:

- IHO S-52 presentation concepts.
- S-57/S-52 object and lookup vocabulary.
- IHO S-100/S-101 concepts where applicable.
- U.S. Chart No.1 visual review vocabulary.
- OpenCPN comparison output where available.

Example:

```json
{
  "standards_profile": {
    "implementation_goal": "Clean implementation of maritime symbol semantics for OpenCPN/Helm and portable app renderers.",
    "source_standards": [
      "IHO S-52 presentation concepts",
      "S-57/S-52 object and lookup vocabulary",
      "IHO S-100/S-101 concepts where applicable",
      "U.S. Chart No.1 visual review vocabulary"
    ],
    "conformance_note": "Generated Helm assets and metadata are verified against standards vocabulary and OpenCPN/Chart No.1 comparison evidence."
  }
}
```

## Render Targets

Every manifest must declare `render_targets`.

Required values for the Forge package:

```json
[
  "opencpn-vulkan",
  "helm-cpp",
  "ios-native",
  "webgpu",
  "svg",
  "atlas-png"
]
```

The package must not assume one runtime. SVG is the source asset format; atlas
PNG or GPU textures are derived outputs.

## Symbol Record

Each symbol record must include:

- `id`
- `name`
- `tier`
- `type`
- `category`
- `source_refs`
- `assets`
- `rendering`
- `accessibility`
- `qa`
- `provenance`

Example:

```json
{
  "id": "N0001",
  "name": "Port lateral buoy",
  "tier": "chart-artifact",
  "type": "navigation-aid",
  "category": "aids-to-navigation",
  "source_refs": [
    {"system": "s52", "ref": "BOYLAT", "authority": "informative"}
  ],
  "assets": {
    "canonical_svg": "assets/svg/canonical/N0001.svg",
    "variants": {
      "day_svg": "proof/svg-day/N0001.svg",
      "dusk_svg": "proof/svg-dusk/N0001.svg",
      "night_svg": "proof/svg-night/N0001.svg"
    }
  },
  "rendering": {
    "viewbox": "0 0 24 24",
    "anchor": "center",
    "orientation": "upright-screen",
    "nominal_px": 24
  },
  "qa": {
    "status": "needs_review",
    "semantic_review": "needs_review",
    "visual_parity": "needs_review"
  },
  "provenance": {
    "status": "generated_owned",
    "origin": "Forge generated SVG",
    "implementation": "clean-room generated Helm interpretation",
    "generated_from": ["Forge primitives", "Helm-authored SVG geometry"],
    "comparison_evidence": [
      "OpenCPN runtime comparison target",
      "Chart No.1 visual review target",
      "S-52/S-101 semantic mapping"
    ]
  }
}
```

## Visual Tiers

`chart-artifact`:
Generated assets that represent chart-symbol concepts. They may map to S-52,
S-57/S-52, S-100, or S-101 concepts, but the manifest does not own official
chart portrayal.

`overlay`:
Application overlays such as routes, weather, sensors, planning state, or
inspection aids.

`ui`:
Interface controls, toolbar icons, status glyphs, and product UI symbols.

## QA States

Allowed symbol QA states:

- `accepted`
- `needs_review`
- `failed`
- `blocked`

Allowed visual-parity states:

- `accepted`
- `needs_review`
- `failed`
- `blocked`
- `not_applicable`

Rows must never disappear silently. If a symbol is missing, ambiguous, failed,
not comparable, or manually excepted, it belongs in `missing-hard-pile.json`.

## Missing And Hard-pile Report

`proof/missing-hard-pile.json` must include every row that is not accepted.

Required fields per row:

- symbol id or source id
- name
- source mapping if known
- family
- status
- reason code
- expected evidence
- current evidence
- next action

Recommended reason codes:

- `missing_generated_svg`
- `failed_semantic_review`
- `failed_visual_parity`
- `sibling_confusion`
- `missing_comparison_reference`
- `not_comparable`
- `manual_exception`
- `blocked_source_mapping`
- `needs_human_review`

## Visual Parity Proof

The public proof page must show every generated chart-like symbol next to a
comparison reference where available.

Required page:

```text
proof/compare-opencpn.html
```

Equivalent static pages are acceptable if linked from `proof/index.html`.

Each row should show:

- Symbol id.
- Symbol name.
- S-52/S-57/S-101 mapping when known.
- Generated day SVG.
- OpenCPN day comparison render where available.
- Generated dusk SVG.
- OpenCPN dusk comparison render where available.
- Generated night SVG.
- OpenCPN dark/night comparison render where available.
- QA status.
- Provenance status.
- Hard-pile reason if not accepted.

OpenCPN comparison output is a proof target. It must be labelled that way.

## OpenMoji/Mojipedia-style Catalog

The package must include a browsable static catalog.

Required entry point:

```text
proof/index.html
```

Required catalog behavior:

- Grid of symbols.
- Search by id, name, source mapping, category, and keywords.
- Filters for tier, QA state, family, palette, and render target.
- Per-symbol panel or page.
- Day/dusk/night previews.
- Mapping badges for S-52/S-57/S-101/OpenCPN where known.
- QA badge.
- Provenance badge.
- Links to comparison rows and hard-pile evidence.

This catalog is a proof and developer-consumption surface, not a marketing page.

## Coverage Report

`proof/coverage.json` must include:

- total source rows considered
- total generated SVG rows
- total accepted rows
- total needs-review rows
- total failed rows
- total blocked rows
- total missing rows
- total manually excepted rows
- coverage by family
- coverage by source system
- coverage by render target

The catalog page should display the same numbers.

## Proof Manifest

`proof/manifest.json` is the public package manifest. It may be generated from
`registry/symbols.json`, but it must be self-contained enough for a renderer or
static catalog to consume.

Required top-level fields:

- `schema`
- `manifest_version`
- `generated_at`
- `standards_profile`
- `render_targets`
- `coverage`
- `symbols`

Example:

```json
{
  "schema": "helm.symbol.cleanroom-package.v1",
  "manifest_version": "0.1.0",
  "generated_at": "2026-07-02T00:00:00Z",
  "standards_profile": {
    "implementation_goal": "Clean implementation of maritime symbol semantics for OpenCPN/Helm and portable app renderers.",
    "source_standards": [
      "IHO S-52 presentation concepts",
      "S-57/S-52 object and lookup vocabulary",
      "IHO S-100/S-101 concepts where applicable",
      "U.S. Chart No.1 visual review vocabulary"
    ],
    "conformance_note": "Generated Helm assets and metadata are verified against standards vocabulary and comparison evidence."
  },
  "render_targets": ["opencpn-vulkan", "helm-cpp", "ios-native", "webgpu", "svg", "atlas-png"],
  "coverage": {
    "source_rows_considered": 0,
    "generated_svg_rows": 0,
    "accepted_rows": 0,
    "needs_review_rows": 0,
    "failed_rows": 0,
    "blocked_rows": 0
  },
  "symbols": []
}
```

## Renderer Requirements

Conforming consumers must be able to:

- Load `manifest.json`.
- Resolve symbol id to canonical SVG.
- Resolve day/dusk/night palette variants.
- Read anchor and orientation metadata.
- Distinguish chart artifacts from overlays and UI icons.
- Preserve accessibility labels.
- Preserve QA/provenance fields for inspection.

OpenCPN/Vulkan and Helm C++ consumers may prefer atlas output. iOS/native and
WebGPU consumers may prefer direct SVG or generated texture atlases. The package
must support both paths from the same manifest.

## Forge Task Mapping

The package is produced across the Forge lane:

- `FORGE-10`: provenance/cache/evidence model.
- `FORGE-14`: exact visual comparison/crop crosswalk.
- `FORGE-15`: repair loop and hard-pile handling.
- `FORGE-16`: verified symbol manifest/package.
- `FORGE-21`: public catalog and OpenCPN parity proof bundle.

`FORGE-21` is the final public-facing proof task for this specification.

## Done Definition

CMSP v0.1 is done when:

- The manifest validates against `registry/symbol.schema.json`.
- Generated SVGs exist for accepted rows.
- Day/dusk/night SVG variants or equivalent palette-resolved exports exist.
- OpenCPN comparison proof exists where available.
- The OpenMoji/Mojipedia-style static catalog opens locally.
- The missing/hard-pile report accounts for every non-accepted row.
- Render targets include OpenCPN/Vulkan, Helm C++, iOS/native, WebGPU, SVG, and
  atlas PNG consumers.
- The package clearly states that it is a clean implementation and not official
  chart portrayal.
