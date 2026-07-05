# CHART-7 Flagged Forge Render Smoke

CHART-7 proves the Forge clean-room symbol package can be rendered through the
chart-render fixture path without becoming the production/default symbol path.

## Safety Posture

The Forge package path is experimental and diagnostic-only here.

- Existing Helm/OpenCPN symbol rendering remains the default.
- The Forge clean-room package path must be enabled explicitly by a test,
  debug, or later runtime flag.
- Runtime-ineligible rows remain diagnostic-only and must not enter default
  render lookup.
- Diagnostic output must preserve symbol id, DB/runtime evidence, blocker
  categories, palette, source rule refs, and expected/observed render signals.
- The existing renderer remains the fallback/kill switch.
- S-101/OpenCPN artwork is not copied or vendored. The renderer matches
  portrayal intent from clean-room evidence and generated Helm assets.

## Fixture

Primary fixture:

```text
engine/test/fixtures/vulkan-render/symbol-selection/
```

The fixture contains seven synthetic `place_symbol` commands sourced from the
CHART-6 symbol-selection contract. The commands cover direct S-101 equivalents,
rule-derived equivalents, catalogue-rule-backed rows, documented deviations,
non-S-101 runtime constructs, and extension/profile rows.

Every fixture row remains runtime-blocked today. The smoke deliberately renders
them only in the flagged diagnostic path.

## Smoke Command

```sh
engine/test-vulkan-symbol-selection-render.sh
```

The smoke:

- validates fixture shape and expected image hashes through the native C++
  `helm_vulkan_fixture_check.cpp` checker;
- validates fixture rows against `artifacts/opencpn_s52_portrayal.sqlite`,
  `runtime_symbol_candidate_v1`, `runtime_symbol_portrayal_v1`, and
  `pipeline/iconforge/catalog/runtime_evidence_snapshot.json`;
- verifies every row carries `s52_lookup_id`, `row_key`, and
  `helm_catalog_id` join keys across source, scene, provenance, and fixture
  metadata;
- replays the fixture through `scripts/vulkan-render-fixture`;
- verifies day, dusk, and night deterministic PPM outputs;
- checks nonblank image stats;
- rejects raw pure witness-red leakage (`#ff0000`);
- keeps the result diagnostic-only.

Expected hashes:

```text
day   06d3f9454ddb88d01b77cafc7e8e5c0d648eec7bbddb56483b295df9c4006d04
dusk  f4996c2c08a35bb735a8e095eaa21355ee9f38d646e900e724e3f6d98ea42d67
night 81ad72fe45eb0a89c189d3f742200dbecd00c7987bdddd3b928df1a5cbfbe3fa
```

## What This Proves

- The renderer can replay Forge package symbol-selection fixtures.
- The synthetic fixture is pinned to concrete Forge runtime DB rows and runtime
  evidence snapshot rows, so DB/package drift fails the smoke.
- Day/dusk/night palette families produce distinct deterministic output.
- Symbol-selection commands are nonblank and anchored in the expected positions.
- The diagnostic path avoids raw S-101 witness color leakage.
- The current package remains fail-closed: blocked rows are not default
  renderable.

## What This Does Not Prove

- It does not make Forge symbols the default production renderer.
- It does not prove regulatory chart portrayal correctness.
- It does not replace OpenCPN's existing S-52 Presentation Library path.
- It does not promote any `runtime_symbol_candidate_v1` row into
  `runtime_symbol_portrayal_v1`; the checked fixtures remain fail-closed.
- It does not complete VSG framebuffer proof on machines without VSG/MoltenVK.

When VSG is available, the same fixture should be replayed by the real VSG
offscreen path and compared against these deterministic reference artifacts.
