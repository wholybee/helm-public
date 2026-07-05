# HELMC++ acceptance contract

Status: HELMC++-1 contract for the final C++ runtime acceptance gate.

This document defines what "Helm is C++" means for the project. It does not mean
the current repo is already C++-only, and it does not mean every line of Helm
becomes C++. It means every required boat-side chartplotter runtime daemon is
C++/CMake/OpenCPN-native before final acceptance. Non-C++ code may exist around
clients, tooling, fixtures, experiments, transitional reference/oracle paths, and
optional non-safety features, but not as a required boat-side runtime daemon.

## Scope

The HELMC++ gate covers required runtime services that a boat must run to use Helm as a local
chartplotter. A required runtime service is any process needed for normal navigation, chart display,
local packs, environmental packs, cache serving, health reporting, or offline operation.

The gate does not cover client UI language, one-shot data preparation tools, test harnesses, or
optional advisory/community features unless those paths become required for normal runtime.

The practical supported-stack target is:

- C++/CMake/OpenCPN-native for required boat-side backend/runtime;
- browser JavaScript/WebGPU for the cockpit UI;
- Python only for AI/lab/dev tooling, fixture generation, transitional references/oracles,
  and optional non-safety companion services.

## Required C++ runtime shape

The accepted runtime shape is:

```text
web cockpit / native client
        |
        | HTTP + WebSocket contracts
        v
helm-server        C++  required nav/chart/safety core
helm-packd         C++  required local MBTiles/PMTiles/portable package service
helm-basemap-cache C++  runtime tile cache/proxy when online-fill or remote-pack fallback is enabled
helm-envd          C++  environmental bundle replay/materialization daemon
```

The service names are less important than the boundary. Required boat daemons must be:

- C++17-shaped and OpenCPN-adjacent in style;
- built through CMake or the repo's normal native build path;
- independently testable with deterministic fixtures;
- explicit about stale, offline, out-of-coverage, invalid-pack, and missing-data states;
- small enough for a human reviewer to understand in one sitting;
- free of hidden scripting-language daemons, Docker, virtual-environment, or developer-machine assumptions.

## Runtime inventory

The machine-readable source for the runtime language policy is
[`runtime-inventory.json`](runtime-inventory.json). It classifies each current or
target runtime/service/pipeline entry point as `required-runtime`,
`transitional-reference`, `dev-tooling`, `fixture/test`, `offline-bake`,
`optional-non-safety`, or `removed`.

Validate it with:

```bash
python3 scripts/check-runtime-inventory.py
```

That guard is intentionally narrow: it fails if an implemented required-runtime
entry launches Python, `uvicorn`, FastAPI, or another Python daemon. Transitional
Python references must name their C++ exit task, and optional Python services
must be explicitly non-safety. `HELMC++-2`, `HELMC++-3`, and the final dossier
consume this inventory as evidence.

| Surface | Accepted role | HELMC++ requirement |
|---|---|---|
| `engine/` / `helm-server` | Nav, AIS, route, chart tile, health, and one-origin boat server | Required C++ runtime. |
| `helm-packd` | Local MBTiles/PMTiles packs, catalog, layers, prefetch, bundle manifests | Required C++ runtime. |
| `helm-basemap-cache` | Cache/proxy for online fill and remote/local pack fallback | C++ when enabled as a runtime service; not required for chart-only installs. |
| `helm-envd` | Environmental model-run bundle replay/materialization | Required C++ runtime after WX-19 proves the contract. |
| Python `services/wx` | Current/reference environmental gateway while the contract is proven | Transitional only; replaced by C++ runtime before HELMC++ final acceptance. |
| optional advisory/community features | Research, recommendation, publishing, or community integrations | May remain Python/FastAPI only if optional, removable, and non-safety. |
| offline data tooling | Import, bake, conversion, sample generation, fixture tooling | Outside required runtime. |
| `web/` | Browser cockpit, MapLibre, WebGPU, UI tests | Not intended to be C++; client surface remains web-native. |
| native Apple clients | WKWebView, SwiftUI, MapLibre Native, Metal | Not intended to be C++; thin client over the boat server. |
| dev/test harnesses | Playwright, smoke helpers, mock engines, local scripts | Outside required runtime. |

## Non-C++ allowance

Non-C++ code is allowed when it is visibly outside required boat runtime:

- Browser JavaScript/WebGPU owns the cockpit UI and client rendering.
- Swift/SwiftUI/Metal may own native Apple client surfaces.
- Offline import/bake tools and fixture generation are outside required runtime.
- Optional advisory/community/research services may exist only if they cannot affect safety-critical
  runtime and Helm remains usable without them.
- Tests, Playwright harnesses, developer scripts, and references are outside required runtime.

Any non-C++ daemon that becomes required for normal chartplotter runtime fails HELMC++ unless it has
a frozen contract, a C++ port plan, and a visible temporary status.

## Reference oracle rule

Reference paths should be used as oracles before they are retired. The C++ replacement must
match the frozen behavior with fixtures and contract tests before the reference path is deleted or
demoted to dev-only.

Parity must cover:

- `/health` and service version reporting;
- `/catalog`, `/layers`, `/prefetch`, and `/bundle`;
- tile, PMTiles range, and environmental field responses;
- headers, ETags, cache semantics, and range behavior;
- source, freshness, coverage, inspection, and provenance metadata;
- stale, offline, out-of-coverage, invalid-pack, missing-pack, and no-network responses;
- expected `404`, `204`, and invalid-input errors;
- no hidden provider fetches in offline mode.

Outputs should be byte-identical where practical. Where byte identity is not the right bar, tests
must use normalized JSON, normalized headers, semantic image checks, or documented tolerances.

## HELMC++-2 parity suite

The checked-in HELMC++-2 parity matrix is
[`helmcxx-parity-suite.json`](helmcxx-parity-suite.json). It maps each required
runtime service to the acceptance surfaces above, the concrete service-contract
tests that prove them, and the remaining Python paths that are allowed only as
oracles, tooling, fixtures, dev-only helpers, or optional non-safety services.

Validate the static suite coverage with:

```bash
python3 scripts/helmcxx-parity-suite.py
```

On a machine with private C++ binaries, run the service contracts with:

```bash
HELM_SERVER_BIN=/path/to/helm-server \
HELM_PACKD_BIN=/path/to/helm-packd \
HELM_BASEMAP_CACHE_BIN=/path/to/helm-basemap-cache \
HELM_ENVD_BIN=/path/to/helm-envd \
python3 scripts/helmcxx-parity-suite.py --run-contracts --strict-contract-env
```

The static gate fails if a required runtime service is missing from the parity
matrix, if an acceptance surface has no evidence, if a referenced test path
disappears, or if a Python-bearing inventory entry lacks an explicit HELMC++-2
role. The runtime contract mode then executes the concrete probes on private
ports only.

## End-to-end proof

The final C++ runtime proof must launch Helm on private ports with required C++ daemons only. It must
assert that no required non-C++ daemon is running, contacted, or necessary.

The end-to-end harness must prove:

- cold start from a fresh runtime directory;
- restart after clean shutdown;
- reboot-style restart with only persisted runtime state;
- chart tiles and catalog are served;
- local MBTiles/PMTiles packs are visible;
- environmental bundles are visible after WX-20;
- the nav WebSocket produces usable state;
- bad manifests, missing packs, missing ENC, missing network, and out-of-coverage regions fail
  visibly instead of optimistically;
- health/status endpoints identify the C++ services and their versions.

No HELMC++ test may use the live `:8080` screen. Use private ports only.

`HELMC++-3` provides the concrete no-Python runtime harness:

```bash
HELM_SERVER_BIN=/path/to/helm-server \
HELM_PACKD_BIN=/path/to/helm-packd \
HELM_BASEMAP_CACHE_BIN=/path/to/helm-basemap-cache \
HELM_ENVD_BIN=/path/to/helm-envd \
scripts/helmcxx-no-python-runtime.sh
```

The harness launches `helm-server`, `helm-packd`, `helm-basemap-cache`, and
`helm-envd` directly on private ports from a fresh temporary runtime directory.
It does not call `scripts/start-helm.sh`, `services/wx`, FastAPI, uvicorn, or
the Python pack/cache references. It probes health, catalog, layer inventory,
prefetch, region bundle, PMTiles/local-pack access, env grid chunks, chart tile
fallback, nav WebSocket frames, bad env manifests, missing packs, no-network
cache replay, transparent hard misses, and reboot-style restart. It also
inspects every launched required-runtime process tree and fails if a Python,
FastAPI, or uvicorn daemon appears.

## Cockpit proof

End-to-end runtime success is not enough. The user-visible cockpit must also prove the C++ runtime is
as good as or better than the previous/reference path.

Playwright acceptance must include:

- chart tiles visible;
- basemap/offline packs visible;
- environmental scene visible;
- time and layer controls working;
- AIS, route, ownship/nav, and health/status visible where fixtures provide them;
- no blank-map regressions during pan, zoom, and time scrub;
- no console errors in the tested workflow;
- no provider fetches during offline-mode tests;
- screenshots and artifacts retained for review.

`scripts/helmcxx-cockpit-proof.sh` is the HELMC++-4 runner for this gate. It
starts `helm-server`, `helm-packd`, `helm-basemap-cache`, and `helm-envd` on
private ports, requires a real local ENC for visible chart-tile proof, drives
`web/test/e2e/helmcxx4-cockpit.spec.js`, and writes screenshots plus JSON
snapshots to `test-results/helmcxx4-cockpit/`.

## Better-than-reference evidence

C++ is not accepted because it is C++. It must keep correctness and earn operational advantages.

HELMC++ benchmarking must record:

- cold start time;
- time to first visible chart layer;
- time to first visible environmental layer;
- p50, p95, and p99 latency for tiles, pack manifests, range requests, and bundle requests;
- CPU and RSS during pan/zoom/time-scrub traffic;
- disk footprint and runtime dependency footprint;
- cache hit/miss behavior;
- behavior with multiple clients on constrained boat WiFi profiles;
- crash/restart behavior;
- no-network behavior;
- 12-24 hour soak with nav feed plus chart, basemap, weather, and offline-pack traffic.

The comparison baseline is the previous reference path or the last accepted runtime path. If C++ does
not win a metric, the dossier must explain why the tradeoff is acceptable.

`scripts/helmcxx-benchmark-soak.mjs` is the HELMC++-5 runner for this gate. It launches
`helm-server`, `helm-packd`, `helm-basemap-cache`, and `helm-envd` on private ports, requires a
real local ENC for visible chart-layer timing, probes environmental grid chunks for visible weather
layer timing, records p50/p95/p99 endpoint latencies, concurrent-client behavior, RSS/CPU samples,
cache/no-network behavior, crash/restart recovery, disk footprint, dependency footprint, and a
configurable soak. By default it runs a short local soak so agents can produce PR evidence quickly;
set `HELM_HELMCXX5_SOAK_SECONDS=43200` or higher for the 12-24 hour verification pass. Set
`HELM_HELMCXX5_BASELINE=/path/to/benchmark.json` to compare against Python/reference or the last
accepted runtime evidence; when no baseline is supplied the artifact records `baseline_missing`
instead of pretending a win was proven.

## Packaging proof

HELMC++ requires an installable runtime, not a developer-only build.

Packaging proof must show:

- no Docker requirement;
- no required scripting-language daemon or virtual-environment requirement;
- fresh-machine macOS install path;
- fresh-machine Linux/Raspberry-Pi-style install path where supported;
- no dependency on `/tmp` build artifacts;
- deterministic runtime directories;
- service supervision story such as launchd, systemd, or an explicitly documented equivalent;
- codesign/notarization path where applicable;
- smoke proof that a user can install, start, inspect health, load local packs, and shut down cleanly.

`HELMC++-6` records the concrete install path in
[`HELMCXX-PACKAGING.md`](HELMCXX-PACKAGING.md). The repeatable guard is:

```bash
scripts/helmcxx-packaging-proof.sh
```

By default the guard is CI-cheap: it validates the installer, launchd/systemd
templates, deterministic directories, and a staged install tree without building
OpenCPN. After a real `engine/bootstrap.sh`, run
`scripts/helmcxx-packaging-proof.sh --run-smoke` to install real C++ binaries
into a staging root, start `helm-server` and `helm-packd` on private ports, check
health/catalog/local-pack catalog, and shut down cleanly.

## Maintainability bar

Every C++ runtime service must be boring, bounded, and reviewable:

- C++17-shaped, standard library first, minimal dependencies;
- CMake integration through the normal build;
- small modules with one responsibility;
- RAII ownership and explicit lifetime boundaries;
- explicit error types or error responses;
- deterministic unit, fixture, and HTTP smoke tests;
- useful service logs and health surfaces;
- sanitizer/debug builds where practical;
- no clever template machinery unless it removes real complexity;
- no line-for-line translation from a prototype when a native C++ shape is clearer;
- reviewer-readable diffs and documentation.

`HELMC++-7` records the maintainability gate in
[`HELMCXX-MAINTAINABILITY.md`](HELMCXX-MAINTAINABILITY.md) and makes it repeatable with:

```bash
scripts/helmcxx-maintainability-audit.mjs
```

The audit checks the required C++ runtime services for CMake/test/docs coverage, bounded file size,
raw ownership spread, novelty template machinery, and dependency discipline. Current warning
dispositions are intentionally explicit: `helm-server` keeps a named OpenCPN/ixwebsocket
legacy-adapter exception, while smaller daemons fail if that ownership style spreads.

## Go/no-go rule

The final HELMC++-8 evidence dossier and signoff is recorded in
[`HELMCXX-DOSSIER.md`](HELMCXX-DOSSIER.md).

HELMC++ passes only when all of the following are true:

- required boat/runtime daemons are C++;
- no required non-C++ daemon remains;
- optional non-runtime surfaces are explicitly non-safety, dev-only, reference-only, or
  offline-only;
- reference-oracle parity is recorded;
- no-required-non-C++ runtime E2E passes;
- Playwright cockpit proof passes;
- performance/reliability/soak comparison is recorded;
- packaging/install proof passes without Docker;
- maintainability audit has no blocking findings;
- final evidence links exact PRs, branches, merged SHAs, logs, screenshots, and benchmark artifacts.

If any required runtime path still depends on a non-C++ daemon, HELMC++ is not done.
