# CHART-5 Symbol Package Loader

`helm_symbol_package` is the C++17 loader for the clean-room symbol package
handoff from Forge to chart/runtime code.

Inputs:

- `pipeline/iconforge/catalog/runtime_evidence_snapshot.json`
- `pipeline/iconforge/proof/manifest.json`

The runtime evidence snapshot is generated from the DB/proof/runtime gates. The
proof manifest preserves generated-asset metadata and clean-room provenance.

The loader joins both surfaces by `symbol_id` and exposes:

- `default_render_records`: rows that are runtime eligible, not fail-closed, and
  have clean-room proof metadata.
- `diagnostic_records`: blocked/review rows with reason codes, blocker
  categories, remediation hints, and authority source evidence.

Malformed package contracts fail at load time. Valid rows that explicitly carry
semantic/runtime blockers are preserved as diagnostics and cannot enter the
default render path.

Current state:

- `default_render_records` is intentionally empty.
- `diagnostic_records` contains all 3057 runtime evidence rows.
- Runtime export remains fail-closed until the authority, visual, and human gates
  pass.

Local smoke:

```sh
engine/test-symbol-package-loader.sh
```

The smoke compiles without OpenCPN, Vulkan, wxWidgets, or RapidJSON. The same
loader is also wired into the OpenCPN CMake overlay as
`helm-symbol-package-smoke`.
