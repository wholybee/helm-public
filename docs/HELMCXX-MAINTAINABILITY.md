# HELMC++ maintainability gate

Status: HELMC++-7 maintainability audit for required C++ runtime services.

This gate asks a narrower question than parity or cockpit proof: can a human maintainer review,
debug, and extend the required C++ runtime services without inheriting a clever monolith? The answer
for the current gate is yes, with documented warning dispositions below.

Run the repeatable audit with:

```bash
node --check scripts/helmcxx-maintainability-audit.mjs
scripts/helmcxx-maintainability-audit.mjs
```

The audit writes machine-readable evidence to:

```text
test-results/helmcxx7-maintainability/audit.json
```

## Scope

The HELMC++-7 audit covers the required boat/runtime C++ daemons:

| Service | Source | Current disposition |
|---|---|---|
| `helm-server` | `engine/vendor/cli/helm_server.cpp` | Pass with explicit legacy-adapter warning. |
| `helm-packd` | `engine/vendor/cli/helm_packd.cpp` | Pass with size-watch warning. |
| `helm-basemap-cache` | `engine/vendor/cli/helm_basemap_cache.cpp` | Pass. |
| `helm-envd` | `engine/vendor/cli/helm_envd.cpp` | Pass. |

The audit checks that every service has:

- a CMake `add_executable` and link target in the OpenCPN patch series;
- deterministic service tests or HELMC++ harness coverage;
- contract documentation;
- no raw ownership calls outside the `helm-server` legacy-adapter exception;
- no `goto`, `boost::`, or novelty template machinery;
- bounded service size thresholds.

## Warning Dispositions

The audit currently passes with warnings, not failures:

| Warning | Disposition |
|---|---|
| `helm-server` is about 4.5k lines. | Accepted for this gate because it is the one-origin adapter over OpenCPN nav/chart/tides and ixwebsocket, and is covered by HELMC++-3/4/5. Future runtime work should not grow this file by default; split new policy into smaller modules or service files. |
| `helm-server` uses raw `new`/`delete` in OpenCPN and ixwebsocket seams. | Accepted as a named legacy-adapter exception only for `helm-server`. The audit fails if raw ownership spreads to `helm-packd`, `helm-basemap-cache`, or `helm-envd`. |
| `helm-server` lacks an explicit `target_compile_features(... cxx_std_17)` line in `0003-cli-cmakelists-helm-targets.patch`. | Non-blocking because the target is built by the existing C++ toolchain and linked through C++ runtime dependencies. File a small ENGINE/HELMC++ cleanup if this remains before HELMC++-8. |
| `helm-packd` is near the size warning threshold. | Accepted because it owns multiple pack formats plus catalog/layers/prefetch/bundle behavior. Future pack-format expansion should split pure helpers rather than growing the daemon file indefinitely. |

## Pass Decision

HELMC++-7 passes if:

- `scripts/helmcxx-maintainability-audit.mjs` exits zero;
- HELMC++-3 no-Python runtime evidence still passes;
- HELMC++-5 benchmark/soak evidence still reports the required runtime services, not optional Python daemons;
- warning dispositions above are carried into HELMC++-8's final dossier;
- any new failure from the audit is fixed or converted into a blocking task before final acceptance.

This gate does not claim that all future bugs are gone. It says the current C++ runtime services are
bounded enough for human review, the known maintainability debt is named, and the final dossier has a
repeatable check to prevent the debt from spreading silently.
