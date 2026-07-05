# Icon Forge — POC

Proof of concept for the Vulkan board **`FORGE`** lane
([docs/VULKAN-ICON-FORGE.md](../../docs/VULKAN-ICON-FORGE.md)): an LLM-driven
generator for the S-52 / U.S. Chart No.1 symbol library as owned, multi-style
SVG — the **Presentation Asset Pack** that feeds the `SYM-2` atlas pipeline.

This POC runs the full pipeline over **5 symbols × 2 styles × 3 palettes**, plus
one deliberately-broken hazard case to exercise the verifier.

## Result

```
symbol            style        structural vision  overall  identity
BOYCAR_north      open-bridge  pass       pass    PASS     BOYCAR_north
BCNCAR_south      open-bridge  pass       pass    PASS     BCNCAR_south
BOYSAW            open-bridge  pass       pass    PASS     BOYSAW
RESARE_pattern    open-bridge  pass       pass    PASS     RESARE_pattern
WRECKS_dangerous  open-bridge  pass       pass    PASS     WRECKS_dangerous
... (us-paper: same 5, all PASS) ...
BOYCAR_north__BROKEN  us-paper pass       FAIL    REJECT   BOYCAR_south
accepted 10/11  rejected: BOYCAR_north__BROKEN
```

See [`samples/contact_sheet.png`](samples/contact_sheet.png) for the rendered
grid. The broken case is a north-cardinal with its topmark cones flipped **down**
— structurally valid SVG, correct colours, but the vision + sibling-discrimination
judge identifies it as a **south cardinal** (a wrong-quadrant grounding hazard)
and rejects it. That is the whole point: the verifier, not the generator, is the
safety mechanism.

During the POC the **structural** check also caught a real mistake — the wreck
was first drawn in the `ink` token while its load-bearing invariant colour is
`black`, so `invariant_colours_used` failed until the artwork referenced `black`.
Exactly the class of silent error a human contractor would ship.

## The 5 symbols

| id | kind | invariant highlights |
|---|---|---|
| `BOYCAR_north` | buoy | black/yellow, **two cones point up** |
| `BCNCAR_south` | beacon | yellow/black, **two cones point down**, fixed base |
| `BOYSAW` | buoy | red/white **vertical** stripes, single red sphere |
| `RESARE_pattern` | area pattern | tileable magenta diagonal hatch |
| `WRECKS_dangerous` | danger | hull-and-masts inside a **dotted** danger oval |

Region-independent and unambiguous, with crisp siblings — ideal for stressing the
verifier.

## Run it

```bash
cd pipeline/iconforge
pip install cairosvg pillow
python3 -m forge._seed_fixtures   # write the recorded compose/verdict fixtures
python3 -m forge.run              # run the pipeline -> out/
```

Set `ANTHROPIC_API_KEY` to swap the recorded backend for live `claude-opus-4-8`
calls (`forge/model.py: LiveModel`) — same interface, same downstream stages.

### Live vision judge (FORGE-6, production)

Run the **real** vision judge against the recorded renders — including the
broken hazard — and compare to the recorded verdicts:

```bash
ANTHROPIC_API_KEY=... python3 -m forge.judge_live          # the live call
python3 -m forge.tests.test_live_judge_wiring              # offline plumbing check (no key)
```

`judge_live` isolates the judge from compose (it consumes SVGs we already have),
so the only live variable is the model's verdict — the sharpest test of whether
a real vision pass catches the flipped-cone north cardinal and clears the ten
good symbols. The wiring test stubs the client to prove the request build
(model id, structured-output schema, base64 vision block, per-symbol checklist)
and the verdict parse are correct without an API key; the live run is a
transport swap on that validated plumbing.

If `ANTHROPIC_API_KEY` is absent, `judge_live` writes a blocked
`out/live_judge_report.json` and exits non-zero so the production gate cannot be
mistaken for an observed live agreement.

## What is real vs recorded

| Stage | POC |
|---|---|
| compose (SVG) — FORGE-4 | **recorded** claude-opus-4-8 output (`fixtures/compose/`) |
| vision judge + sibling test — FORGE-6 | **recorded** claude-opus-4-8 verdicts (`fixtures/verdicts/`) |
| structural verify — FORGE-6 | **live, deterministic** (`forge/verify.py`) |
| render + palette substitution — FORGE-5 | **live, deterministic** (cairosvg, `forge/render.py`) |
| atlas pack + manifest — FORGE-9 | **live, deterministic** (`forge/atlas.py`) |

The recorded artwork/verdicts are genuine output of the model the pipeline
specifies; only the transport (file vs HTTP) differs. The `LiveModel` path is
coded to the Claude API (structured outputs, vision image blocks, a cached
per-style prefix) and is the production backend.

## Layout

```
catalog/        5 SymbolSpec JSON (durable, reviewable truth)
stylepacks/     2 StylePack JSON (open-bridge, us-paper)
fixtures/       recorded compose SVGs + vision verdicts
forge/          the program: schema, model, render, verify, atlas, contact, run
pilots/         pilot contracts, including the 20-symbol stress catalog
samples/        committed artifacts (contact sheet, atlas sheets, manifests, report)
out/            regenerated each run (gitignored)
```

The atlas manifest is the `engine/vendor/cli/helm_s52_atlas` shape — entries
keyed `(name, kind, palette)` with `pixel_rect` / `uv` / `anchor` — plus the new
`style` axis. The C++/Vulkan loader consumes it unchanged.

## File ownership and generated-artifact handoff

FORGE workers must declare which paths they intend to write before they modify
the symbol library, proof package, or review tooling. The policy is generated
from Git state so ambiguous untracked files cannot slide into a handoff:

```bash
python3 -m forge.file_ownership_policy claim \
  --task-id FORGE-52 \
  --agent-id codex/FORGE-52-file-ownership \
  --paths pipeline/iconforge/README.md pipeline/iconforge/catalog/file_ownership_policy.json
python3 -m forge.file_ownership_policy --write
python3 -m forge.tests.test_file_ownership_policy
python3 -m forge.file_ownership_policy --check-handoff
```

Outputs:

- `catalog/file_ownership_policy.json`
- `catalog/file_ownership_policy.md`

The classes are intentionally small:

- `source_contract` — Forge code, tests, docs, fixtures, pilots, and stylepacks.
- `generated_tracked` — committed generated artifacts with reproducible builders
  or adjacent provenance, including `assets/svg/`, `catalog/`, `generated/`,
  `proof/`, `registry/`, `samples/`, `symbols.yaml`, and the runtime DB
  contract artifacts.
- `reference_evidence_tracked` — committed source/reference evidence used only
  for comparison, mapping, or provenance. These are not canonical Helm artwork.
- `review_only_output` — `out/` HTML, PNGs, local review state, and scratch proof
  pages. These are regenerated, ignored, or summarized on the board; they are not
  a hidden publish surface.
- `agent_private_scratch` — `.cache/`, `.agent-scratch/`, and `tmp/`.

Before `complete_claim`, stage intentional tracked changes and run
`--check-handoff`. A task should not pass review while Forge-controlled roots
contain untracked files whose disposition is ambiguous. If a generated proof
needs to become durable, promote it through a named generator into `catalog/`,
`proof/`, `registry/`, or `assets/svg/` and record the provenance there.

## 20-symbol stress pilot

`pilots/stress20.json` is the next scaling gate. It deliberately covers
cardinal orientation, beacon-vs-buoy body, lateral red/green and can/conical
confusion, safe-water and special marks, dangerous/non-dangerous wrecks,
rock/obstruction confusion, area patterns, and light flares. Run:

```bash
python3 -m forge.tests.test_stress20_catalog
python3 -m forge.stress20_generate
python3 -m forge.tests.test_stress20_generate
python3 -m forge.stress20_verify
python3 -m forge.tests.test_stress20_verify
python3 -m forge.tests.test_scale_decision
```

`pilots/scale_decision.json` records the go/no-go decision for the next
100-150 asset batch and the thresholds needed before claiming the path to 99%
coverage is credible.

## 125-asset scale batch

`pilots/scale125.json` is generated from local `chartsymbols.xml` lookup rows,
with quotas for buoy/beacon marks, lights/daymarks/topmarks,
wreck/rock/obstruction cases, area/pattern/line-style assets, and ugly
attribute-driven edges. Run:

```bash
python3 -m forge.scale125_select
python3 -m forge.tests.test_scale125_selection
python3 -m forge.scale125_generate
python3 -m forge.tests.test_scale125_generate
python3 -m forge.scale125_verify
python3 -m forge.tests.test_scale125_verify
python3 -m forge.scale125_atlas
python3 -m forge.tests.test_scale125_atlas
python3 -m forge.scale125_provenance
python3 -m forge.tests.test_scale125_provenance
python3 -m forge.full_catalog_run
python3 -m forge.tests.test_full_catalog_run
python3 -m forge.chart1_parity
python3 -m forge.tests.test_chart1_parity
python3 -m forge.chart1_visual_repair --limit 20
python3 -m forge.tests.test_chart1_visual_repair
```

## Chart No.1 visual parity gate

`forge.chart1_parity` is the FORGE-12 visual-approval gate. It records the
official NOAA U.S. Chart No.1 PDF URL/hash, renders the Buoys/Beacons reference
pages into `out/chart1_parity/reference/pages/`, builds
`pilots/chart1_visual_parity.json` as an asset-to-reference-class crosswalk for
all 824 full-catalog assets, and strictly checks the 362 buoy/beacon/topmark
assets first.

This gate validates **symbol equivalence**, not pixel-identical copying. It
compares Chart No.1 class expectations against the generated SVG/render:
silhouette/body class, color tokens and band order where applicable, topmark
presence/orientation, anchor path, and obvious placeholder failures such as
topmarks rendered as light flares or beacons collapsed to generic rectangles.
Failures go to `out/chart1_parity/hard_pile.json` with reason codes; the command
only exits non-zero with `--enforce`, because the current purpose is to expose
the mismatch set that FORGE-13 must repair.

FORGE-14 hardens the same gate with explicit crop evidence. The crosswalk now
distinguishes:

- `exact_symbol_crop` — one rendered Chart No.1 symbol/glyph crop. This is the
  only evidence type that can ever be final-approved.
- `multi_symbol_reference` — a useful family row or symbol group, such as buoy
  shapes, beacon examples, cardinal examples, or special-purpose examples. These
  inform SymbolSpec work but are not final per-asset proof.
- `class_panel_reference` — a broad map/table/page/panel reference, such as the
  IALA lateral-region map. These are never final per-symbol proof.
- `manual_exception` — an explicit exception when Chart No.1 does not show an
  exact ECDIS crop for that S-57 topmark/daymark shape.
- `out_of_scope` — full-catalog assets outside the current buoy/beacon/topmark
  gate.

No row may be final-approved unless `final_approval` is true, and final approval
requires `exact_symbol_crop` evidence. The current FORGE-14 crosswalk has 139
`exact_symbol_crop`, 175 `multi_symbol_reference`, 20 `class_panel_reference`, 28
`manual_exception`, and 462 `out_of_scope` rows. Broad class/panel references
remain in the hard pile until they are refined into real per-symbol crops. The
gate also writes `out/chart1_parity/crop_review.json` and
`out/chart1_parity/crop_review_sheet.png`, copied into `samples/`, so reviewers
can inspect every crop box, mapped asset count, and generated sample before
geometry remediation starts.

## Master symbol list

`forge.master_symbol_list` is the full 824-row inventory for Icon Forge. This is
the master list, not the 139-row exact-crop subset. It flattens the generated
S-52/S-57 catalog, Chart No.1 evidence, FORGE-14 gate status, S-101 coverage,
Commons public-domain candidates, Chart 1 Mappings INT 1 references, generated-canonical
manifest state, and next action into committed audit artifacts:

```bash
python3 -m forge.master_symbol_list
python3 -m forge.tests.test_master_symbol_list
```

Outputs:

- `catalog/master_symbol_list.csv` — spreadsheet-ready list of every required
  catalog row.
- `catalog/master_symbol_list.json` — structured list with summary counts and
  row-level source/action data.
- `catalog/master_symbol_list.md` — compact human-readable rollup.

The current master list has 824 required rows, 0 Chart No.1 visually approved
rows, 139 generated-owned rows that still need visual repair, 420 rows that
still need owned SVG generation, 203 license-blocked reference-only rows, 34
Commons public-domain candidate rows needing review, and 28 manual exceptions.

## Official source table

`forge.official_symbol_table` is the source-backed table extracted from the
local Chart 1 Mappings Q-section mapping. It is narrower than the 824-row Helm
inventory: it records the 62 official INT 1 Q rows we have transcribed from the
source table, their official names, S-57 references, page/crop provenance, local
reference-only symbol/row crop paths, Commons candidates, S-101 coverage through
matched Helm rows, and whether Helm rows are attribute-supported matches or only
broad candidates.

```bash
python3 -m forge.official_symbol_table
python3 -m forge.tests.test_official_symbol_table
```

Outputs:

- `catalog/official_symbol_table.yaml`
- `catalog/official_symbol_table.json`
- `catalog/official_symbol_table.csv`
- `catalog/official_symbol_table.md`

This table answers "what does the official Chart 1 Mappings table actually say?"
It does not visually approve our generated SVGs. Chart 1 Mappings crops are
reference-only QA artifacts and remain forbidden as canonical artwork sources
without permission.

## Q20-Q25 buoy body primitive drafts

`forge.buoy_body_primitives` is the first FORGE-13 drawing slice. It takes the
official-table rows for Q20-Q25 buoy body shapes, follows the exact S-57
`BOYSHP*` conditions into the Helm/S-52 catalog, and emits generated-owned draft
SVG primitives plus SymbolSpec metadata:

```bash
python3 -m forge.buoy_body_primitives
python3 -m forge.tests.test_buoy_body_primitives
```

Outputs:

- `catalog/symbol_specs_q20_q25.yaml`
- `catalog/symbol_specs_q20_q25.json`
- `catalog/symbol_specs_q20_q25.md`
- `assets/svg/official_q20_q25/*.svg`

The current slice generates 100 draft buoy body SVGs across conical, can,
spherical, pillar, spar, and barrel shapes. It deliberately skips 6 Q24
attribute matches that are beacon assets, because silently drawing beacon rows
as buoys would corrupt the geometry registry. These drafts are traceable to the
official row/crop evidence and S-57 conditions, but `qa.visual_parity` remains
`pending` and `final_approved` remains false until the visual repair loop and
human spot checks clear them.

## Multi-source SVG draft pack

`forge.multisource_svg_pack` is the broader FORGE-13 pivot: OpenCPN/S-52 tables
become the local reference oracle, and the output remains fresh Helm-owned draft
SVG. It starts from the 824-row master list, enriches each row with local
`chartsymbols.xml` asset/lookup metadata, and carries through Chart 1 Mappings,
S-101, and Commons mapping fields:

```bash
python3 -m forge.multisource_svg_pack
python3 -m forge.tests.test_multisource_svg_pack
```

Outputs:

- `catalog/multisource_svg_draft_pack.yaml`
- `catalog/multisource_svg_draft_pack.json`
- `catalog/multisource_svg_draft_pack.md`
- `assets/svg/multisource_draft/*.svg`

The current pass generates 739 point-symbol SVG drafts and keeps the remaining
85 line-style, pattern, and conditional-procedure rows in the manifest as
renderer-not-yet-implemented. OpenCPN/S-52 metadata is tagged as
`reference_oracle_not_canonical_artwork`: it is used for master-list validation,
dimensions, colour metadata, sibling discovery, and visual reference rendering,
but not copied or traced into the owned pack. All generated rows remain
`qa.visual_parity: pending`, `final_approved: false`, and
`clean_ip_status: pending_review`.

## OpenCPN/S-52 reference renders

`forge.opencpn_reference_render` turns the planned OpenCPN reference links into
local day/dusk/night PNG crops from the installed S-52 presentation library:

```bash
python3 -m forge.opencpn_reference_render
python3 -m forge.tests.test_opencpn_reference_render
```

Outputs:

- `out/opencpn_s52_reference/*__day.png`
- `out/opencpn_s52_reference/*__dusk.png`
- `out/opencpn_s52_reference/*__night.png`
- `out/opencpn_s52_reference/report.json`

The current local run renders 712 crop-backed assets across day/dusk/night
palettes, for 2,136 reference PNGs. The remaining rows are explicit: 65 have
OpenCPN/S-52 definitions but no bitmap crop location, and 47 are conditional,
line/pattern, malformed, or local rows without a direct asset definition. These
PNGs are reference-only oracle inputs for repair/QA. They are not canonical
Helm-owned artwork and should not be committed or packaged into the owned SVG
asset pack without a deliberate license decision.

## OpenCPN baseline comparison manifest

`forge.electronic_chart1_opencpn_baseline` is the CHART-8 machine-readable
comparison report. It joins each Electronic Chart 1 fixture row with available
OpenCPN day/dusk/night reference paths, Helm fixture render paths, visual diff
paths, proof-bundle links, tolerance checks, and human approval state:

```bash
python3 -m forge.electronic_chart1_opencpn_baseline
python3 -m forge.tests.test_electronic_chart1_opencpn_baseline
```

Outputs:

- `catalog/electronic_chart1_opencpn_baseline.json`
- `catalog/electronic_chart1_opencpn_baseline.md`

The report separates rows into `pass`, `needs-review`, and `not-comparable`.
The current run records 6 pass rows, 2,353 needs-review rows, and 698
not-comparable rows. The tolerance checks explicitly label palette/colour
delta, symbol-class silhouette, anchor/bbox, and blank-render failure modes.
OpenCPN pixels are labelled `reference_comparison_only`; comparison status
does not approve runtime export, and all rows remain tied back to the proof
bundle and human approval state.

## Symbol readiness release gate

`forge.electronic_chart1_symbol_readiness_gate` is the CHART-10 final
readiness gate for declaring Forge symbols usable in chartplotter render paths.
It aggregates the mapping audit, proof bundle, registry, C++ runtime DB
contract, runtime promotion gate, Vulkan render fixture, OpenCPN baseline
comparison, and adapter handoff evidence:

```bash
python3 -m forge.electronic_chart1_symbol_readiness_gate
python3 -m forge.tests.test_electronic_chart1_symbol_readiness_gate
```

Outputs:

- `catalog/electronic_chart1_symbol_readiness_gate.json`
- `catalog/electronic_chart1_symbol_readiness_gate.md`

The current report is intentionally `release_blocked`. It records 3,057 total
release rows, 2,636 registry symbols, 1,225 semantically accepted rows, zero
final-approved rows, zero runtime-export rows, 3,057 runtime-blocked rows, 698
hard-pile rows, and 494 unsupported extension/profile rows. Seven prerequisite
checks pass, but `proof_gallery_and_human_signoff` remains blocked; this gate
must not be used to mark all symbols ready until the human approval, visual
parity, hard-pile, and runtime export blockers are actually cleared.

## Clean-room public proof bundle

`forge.proof_bundle` is the FORGE-21 public proof/package scaffold. It consumes
the full-catalog standards ledgers and writes a durable static package:

```bash
python3 -m forge.proof_bundle
python3 -m forge.tests.test_proof_bundle
python3 -m forge.s101_mapping_audit
python3 -m forge.tests.test_s101_mapping_audit
```

Outputs land in `proof/`:

- `svg-day/`, `svg-dusk/`, `svg-night/` palette-resolved generated-owned SVGs.
- `manifest.json` using `helm.symbol.cleanroom-package.v1`.
- `coverage.json` with generated, accepted, review, hard-pile, and resolver
  counts.
- `missing-hard-pile.json` with every non-accepted row and review reason.
- `chartplotter-rule-input.json`, a provisional runtime-facing rules input.
- `index.html`, an OpenMoji/Mojipedia-style static catalog.
- `compare-opencpn.html`, a side-by-side OpenCPN comparison proof page.

This bundle is proof/review infrastructure, not a final approval artifact.
OpenCPN/IHO/Chart No.1 references are labelled comparison/standards evidence
only. Chartplotter runtimes must consume only rows whose status is `accepted`
and whose QA has `final_approved: true`.

## Clean-room registry manifest

`forge.cleanroom_symbol_manifest` is the FORGE-16 package manifest gate. It
joins the DB-backed review payload, proof bundle evidence, recipe/interpreter
state, and FORGE-31 runtime hard-pile state into a production registry:

```bash
python3 -m forge.cleanroom_symbol_manifest
python3 -m forge.tests.test_cleanroom_symbol_manifest
```

Outputs land in `registry/`:

- `symbols.json` — generated package registry using
  `helm.symbol.cleanroom-registry.v1`.
- `symbols.yaml` — YAML-compatible compact mirror of the same registry for
  packaging systems that prefer a `.yaml` artifact.
- `symbol.schema.json` — schema for the registry successor to the original
  SPEC 0001 starter schema.

The manifest is intentionally fail-closed. Current output records 3,057 DB
candidates, 2,636 generated symbol records with real Helm SVG/recipe evidence,
and 421 blocked candidates that have no generated visual asset or recipe yet.
Those 421 rows stay out of `symbols` and remain visible in
`blocked_candidates`; the generator must not fabricate placeholder artwork or
silently promote missing rows.

The registry uses the DB `row_key` as the unique package row ID because one
S-52 symbol filename can map to many lookup/attribute rows, and some rows have
no symbol filename at all. `symbol_id` remains the S-52/OpenCPN asset handle
where present. This keeps chartplotter-facing consumers from confusing a file
name with a complete portrayal rule.

`catalog/s101_mapping_audit.json` is the guardrail for the mapping question:
it proves every row is accounted for and classified, checks resolved colour
attributes against semantic tuples, and verifies that the human review UI labels
raw S-101 SVGs as shape witnesses rather than color-resolved portrayal. The
audit separates S-101 ENC feature-equivalent rows from runtime display
constructs and extension/inland profile rows; extension/runtime rows must not
be described as S-101 ENC features.

`catalog/semantic_evidence_db.json` is the FORGE-26 backend row contract for
proof pages, judge prompts, and future runtime export gates. It joins OpenCPN
description/reference data, S-57 object/attribute tuples, S-52 instructions,
S-101 resolver evidence, unresolved reasons, and a fail-closed runtime gate into
one payload:

```bash
python3 -m forge.semantic_evidence_db
python3 -m forge.tests.test_semantic_evidence_db
```

`catalog/s52_s101_rule_contract.json` is the FORGE-27 interpretation contract
layer. It parses every S-52 instruction into a backend-owned AST and records an
S-101 rule-contract status for every row. This is the explicit answer to "what
does Helm think this rule means?" without pretending that Helm already executes
the S-101 Lua portrayal catalogue at runtime:

```bash
python3 -m forge.s52_s101_rule_contract
python3 -m forge.tests.test_s52_s101_rule_contract
```

The contract distinguishes direct S-101 symbol references, rule-derived
equivalence, catalogue-rule evidence, documented deviations, non-S-101 runtime
constructs, extension/profile rows, malformed S-52 instructions, and missing
S-101 rule evidence. Missing S-101 filenames are not treated as missing mapping
when rule-derived or catalogue-rule evidence exists. Runtime export remains
blocked until FORGE-31 sees complete rule, recipe, visual, provenance, and human
approval gates.

The browser-facing rule is deliberately strict: review pages may display this
backend payload, but they must not derive symbol meaning, colour, mapping, or
runtime eligibility from filenames or hidden JavaScript fallbacks. The current
artifact uses S-101 Lua/catalogue evidence to audit mappings; it does not claim
full runtime-grade S-101 Lua execution, and every row remains blocked or pending
for runtime until the later recipe, interpretation, visual proof, and human
approval gates pass.

`all_required_api_fields_returned: true` means every row has the contract keys;
it does not mean every evidence field is populated. Consumers must also read
`required_api_fields_populated` and `gap_counts_by_reason`. Empty S-101
feature/rule fields, derived-only S-57 prose, component-context rows, and
non-S-101 runtime/extension rows are explicit yellow/red evidence states.

`catalog/source_expansion_manifest.json` is the FORGE-20 planning artifact for
rows that still need stronger source/inspiration evidence before later repair
work. It is generated by:

```bash
python3 -m forge.source_expansion_manifest
python3 -m forge.tests.test_source_expansion_manifest
```

The original FORGE-20 task text referred to 77 `no_helm_candidate` rows, but
current inputs contain zero rows with that exact status. The manifest records
that correction and instead selects the current evidence-gap queue: 55 rows,
including 41 with no triad reference coverage, 47 lacking OpenCPN comparison
coverage, and 8 rows where standard-source and triad tables do not align. It is
planning only: every row remains `not_ready`, with license tags and generation
plans for a later source/repair lane.

The human approval server remains:

```bash
python3 -m forge.human_review_server --port 9017
```

It serves `out/human_review/icon_review.html` for remediation review and
`out/human_review/pass_review.html` for final sign-off. Browser decisions are
persisted through `/api/save-review` and `/api/save-signoff`.

## Exact-crop canonical asset pack

`forge.exact_symbol_assets` is the conservative FORGE-15 production lane for
the 139 rows that already have exact Chart No.1 crops. It does not use the broad
full-catalog schematic generator and it does not infer artwork from
`lights_daymarks_topmarks`; each exact crop row gets one owned canonical SVG and
one manifest entry:

```bash
python3 -m forge.exact_symbol_assets
python3 -m forge.tests.test_exact_symbol_assets
```

Outputs:

- `assets/svg/canonical/N####.svg` — one SVG per exact-crop row.
- `symbols.yaml` — manifest entries shaped as `id`, `name`, `kind`, `tier`,
  `source_refs`, `asset.canonical`, `qa`, and clean-IP `provenance`.

`symbols.yaml` is also the source registry for widening the pack. Each row
records symbol-specific Chart No.1 crop provenance and local S-52 lookup
metadata, plus reference-candidate tags for the IHO S-101 Portrayal Catalogue,
Esri's Apache-2.0 nautical symbol repository, and Wikimedia Commons' per-file
SVG nautical chart icons. It also records the local Chart 1 Mappings PDF as a
reference-only source for name mapping, S-57 object crosswalk, INT1 section
checks, and semantic QA. Chart 1 Mappings is explicitly forbidden as a crop/extract
SVG artwork source unless permission is obtained. These external sources are
marked as reference-only or license-review-required until a per-symbol crosswalk
and license check is complete; the canonical SVG remains generated-owned
artwork.

The manifest keeps `qa.semantic_pass: true` and `qa.visual_parity: pending` so
the artwork is usable as owned generated geometry while still requiring visual
model/human parity review before publish.

## Chart No.1 visual repair loop

`forge.chart1_visual_repair` is the FORGE-15 feedback loop that restores the
pilot's useful model-in-the-loop behavior. It selects only rows whose
FORGE-14 evidence is `exact_symbol_crop`, sends the generated render and the
Chart No.1 crop as the two visual inputs, and asks the judge for structured
repair feedback:

- `source_crop_valid`
- `overall_pass`
- `observed`
- `expected`
- `repair_instruction`
- `safety_reason_codes`
- `confidence`

The report is written to `out/chart1_visual_repair/repair_feedback.json`. Each
row also includes a generator-ready repair prompt that points at the candidate
SVG, candidate render, exact source crop, and judge feedback.

Run with a live vision model when available:

```bash
ANTHROPIC_API_KEY=... python3 -m forge.chart1_visual_repair --live --limit 20
```

Without `ANTHROPIC_API_KEY`, the command emits an offline heuristic scaffold
with the same schema so the pipeline and tests are reproducible, but that output
is explicitly not a visual-model verdict. Broad `class_panel_reference` and
`multi_symbol_reference` rows are excluded from this loop until they have real
per-symbol crops.
