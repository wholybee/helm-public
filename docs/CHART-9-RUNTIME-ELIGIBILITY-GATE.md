# CHART-9 Runtime Eligibility Gate

CHART-9 defines the C++ runtime gate that prevents unapproved Forge symbols
from becoming chartplotter defaults.

The gate is independent of icon design repair. Visual work can continue in
Forge, but a generated SVG alone never makes a row default-renderable.

## Default Chart Eligibility

The default chart lookup exposes a row only when all of these are true:

- runtime DB state is eligible;
- candidate status is `runtime_eligible`;
- package status is `accepted`;
- `qa.final_approved` is true;
- `chartplotter_runtime.eligible` is true;
- fail-closed is false;
- proof manifest metadata is present;
- clean-room provenance is present;
- third-party artwork is not the source;
- runtime scope is `chart_portrayal`.

Rows that fail any item remain visible only through diagnostic/proof lookup.
The loader records named block reasons such as:

- `package_status_not_accepted`
- `final_approved_false`
- `chartplotter_runtime_not_eligible`
- `runtime_eligible_db_false`
- `fail_closed_true`
- `proof_manifest_missing`
- `runtime_scope_missing`

## Explicit Scopes

Non-S-101 runtime overlays and extension/profile rows do not enter default
chart rendering. Approved rows in those families must be requested by explicit
runtime scope, for example:

- `renderer_overlay_or_ui`
- `extension_profile_or_manual_mapping`

## Smoke

```sh
engine/test-symbol-runtime-gate.sh
```

The smoke builds a synthetic package with accepted, pending, rejected,
fail-closed, missing-proof, overlay, and extension rows. It proves:

- only the accepted/final-approved `chart_portrayal` row enters default lookup;
- pending/rejected/fail-closed/missing-proof rows stay diagnostic-only even
  when generated SVG paths exist;
- approved overlay and extension rows are routeable only through explicit
  scope lookup;
- block reasons remain visible for denied rows.

This smoke is part of `.github/workflows/symbol-selection-smoke.yml`.
