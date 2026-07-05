# HELMC++ final acceptance dossier (HELMC++-8)

Status: HELMC++-8 final evidence dossier and go/no-go signoff.
Verifier: independent HELMC++-8 agent (claude-code), 2026-07-05.
Verified against: `origin/main` @ `beaad35a` (all merged SHAs below confirmed ancestors of main).

## Verdict

**GO** — inclusive of the BUG-1 fix carried in this branch, with named
non-blocking residuals tracked as board tasks (ENGINE-20, NATIVE-16) and one
explicit evidence disposition (`baseline_missing`, section 6). Every required
boat-side runtime daemon is C++; no required Python daemon remains; the full
gate suite was independently re-run by this dossier's verifier on 2026-07-05
against binaries built fresh from `origin/main`. The verifier's benchmark
re-run exposed one real defect (all four daemons closed HTTP/1.1 connections
without advertising `Connection: close` — board record **BUG-1**); it is fixed
in this branch and every gate was re-run green against the fixed binaries
(section 4).

## 1. Provenance — exact branches, PRs, merged SHAs

All tasks below are Done on the board with `github_pr_merged` provenance, and
every merged SHA was re-verified as an ancestor of `origin/main` on 2026-07-05.

| Task | Deliverable | Branch | PR | Merged SHA | Merged |
|---|---|---|---|---|---|
| HELMC++-1 | Acceptance contract ([HELMCXX-ACCEPTANCE.md](HELMCXX-ACCEPTANCE.md)) | `codex/HELMC++-1-runtime-contract` | [#245](https://github.com/StevenRidder/Helm/pull/245) | `cb51b81727d815e35b45e83feb549d309083b299` | 2026-06-29 |
| HELMC++-2 | Parity suite ([helmcxx-parity-suite.json](helmcxx-parity-suite.json), `scripts/helmcxx-parity-suite.py`) | `codex/HELMC++-2-parity-suite` | [#325](https://github.com/StevenRidder/Helm/pull/325) | `752b06bf95611e55863b1381c5a139d42fe8864e` | 2026-07-04 |
| HELMC++-3 | No-Python E2E harness (`scripts/helmcxx-no-python-runtime.sh`) | `codex/HELMC++-3-no-python-runtime` | [#328](https://github.com/StevenRidder/Helm/pull/328) | `456531b9c982a5e1856704d209eb871b1032ba11` | 2026-07-05 |
| HELMC++-4 | Playwright cockpit proof (`scripts/helmcxx-cockpit-proof.sh`, `web/test/e2e/helmcxx4-cockpit.spec.js`) | `codex/HELMC++-4-playwright-cockpit` | [#329](https://github.com/StevenRidder/Helm/pull/329) | `0e1eee3b56b06df31fb8544c3bd3374159b7b999` | 2026-07-04 |
| HELMC++-5 | Benchmark/soak gate (`scripts/helmcxx-benchmark-soak.mjs`) | `codex/HELMC++-5-benchmark-soak` | [#330](https://github.com/StevenRidder/Helm/pull/330) | `89958a6f6ddbccf8dd028ca2d7bb563b7e6c3ffc` | 2026-07-05 |
| HELMC++-6 | Packaging proof ([HELMCXX-PACKAGING.md](HELMCXX-PACKAGING.md), installer, launchd/systemd units) | `codex/HELMC++-6-packaging-proof` | [#336](https://github.com/StevenRidder/Helm/pull/336) | `b6c9c407eb6db1e2eb680b90440b9e39f202f23c` | 2026-07-04 |
| HELMC++-7 | Maintainability gate ([HELMCXX-MAINTAINABILITY.md](HELMCXX-MAINTAINABILITY.md), audit script) | `codex/HELMC++-7-maintainability` | [#331](https://github.com/StevenRidder/Helm/pull/331) | `0893bba098f1fba3d8dcc8b84c7dba814cc83ad2` | 2026-07-05 |
| HELMC++-9 | Runtime inventory + language-policy guard ([runtime-inventory.json](runtime-inventory.json), CI guard) | `codex/HELMC++-9-runtime-guard` | [#253](https://github.com/StevenRidder/Helm/pull/253) | `1154efef47af579d1d4fef9750125198c8adfa45` | 2026-06-30 |
| AI-18 | Python backend explicitly optional/non-safety | `codex/AI-18-optional-backend` | [#252](https://github.com/StevenRidder/Helm/pull/252) | `797b9e45a047ddd90b995a58eb7d795569bbb2fe` | 2026-06-30 |
| WX-26 | Legacy Python WX stack retired; C++ `helm-envd` is the live path | `claude/WX-26-cutover` | [#267](https://github.com/StevenRidder/Helm/pull/267) | `73f953c86b86625a99bcd322dcd252ba5cf4e383` | 2026-07-02 |

## 2. Final runtime inventory

Source of truth: [runtime-inventory.json](runtime-inventory.json), validated by
`scripts/check-runtime-inventory.py` (CI: `.github/workflows/helmcxx-runtime-guard.yml`).

Verifier re-run 2026-07-05: **PASS** — 16 entries; 3 implemented
required-C++-runtime entries; 3 transitional references/oracles; 1 optional
non-safety service. No implemented required-runtime entry launches Python,
uvicorn, or FastAPI.

Required boat-side daemons (all C++, built via `engine/bootstrap.sh` /
`engine/patches/0003-cli-cmakelists-helm-targets.patch`):

| Daemon | Source | Role |
|---|---|---|
| `helm-server` | `engine/vendor/cli/helm_server.cpp` | nav/AIS/route/chart-tile/health core |
| `helm-packd` | `engine/vendor/cli/helm_packd.cpp` | local MBTiles/PMTiles packs, catalog/layers/prefetch/bundle |
| `helm-basemap-cache` | `engine/vendor/cli/helm_basemap_cache.cpp` | tile cache/proxy (required when online-fill/remote-pack fallback enabled) |
| `helm-envd` | `engine/vendor/cli/helm_envd.cpp` | environmental bundle replay/materialization |

Python surfaces remaining, all outside required runtime: `services/wx`
(dev/reference oracle only, `--wx-oracle`, per WX-26), `backend/` `:8090`
AI/community companion (optional/non-safety per AI-18, `/health` exposes the
boundary), offline bake/import/fixture tooling.

## 3. Gate-by-gate evidence

### 3.1 HELMC++-2 — Python-oracle parity suite

- Recorded evidence (PR [#325](https://github.com/StevenRidder/Helm/pull/325)): static suite PASS; pure-Python oracle contract checks PASS; binary probes were skipped in that run (`HELM_*_BIN` unset) and closed downstream by HELMC++-3's binary-backed run on ports 9320–9325.
- Matrix: 4 services × 11 required surfaces (health, catalog, layers, prefetch, bundle, tile/range, metadata allow-lists, stale/offline/out-of-coverage, 404/204/invalid, env manifest/chunk, headers/cache) plus the allow-listed `python_paths` register.
- Verifier re-run 2026-07-05 (static): **PASS** — services: 4, required surfaces: 11.
- Verifier re-run 2026-07-05 (contract mode, fresh binaries): **PASS** — 8/8 contract commands passed, 0 skipped, `--strict-contract-env` (`helmcxx8-evidence/parity-contracts.log`).

### 3.2 HELMC++-3 — No-Python C++ runtime E2E

- Recorded evidence (PR [#328](https://github.com/StevenRidder/Helm/pull/328)): harness PASS on private ports 9320–9325 — cold start, missing-ENC chart fallback, `/nav` WebSocket after real RMC feed, pack catalog/layers/prefetch/bundle, PMTiles range, env chunks, missing-pack 404, bad-manifest 409, no-network cache replay + transparent hard-miss 204, reboot-style restart; no Python/FastAPI/uvicorn in any required-runtime process tree; live `:8080` untouched. Re-confirmed under HELMC++-5 (ports 9370–9375) and HELMC++-7 (ports 9380–9385).
- Verifier re-run 2026-07-05 (fresh binaries, private ports 9400–9405): **PASS** — all 12 checks ok, including the no-Python process-tree assertion and reboot-style restart (`helmcxx8-evidence/no-python-runtime.log`).

### 3.3 HELMC++-4 — Playwright cockpit proof

- Recorded evidence (PR [#329](https://github.com/StevenRidder/Helm/pull/329)): `scripts/helmcxx-cockpit-proof.sh` PASS on private ports 9340–9344 with a real ENC; chart tiles, local packs, environmental scene, time/layer controls, nav/health assertions, no blank-map regressions, no console errors, no provider fetches offline. Evidence directory is gitignored, so the run's screenshots were retained only with the PR record.
- Verifier re-run 2026-07-05 (fresh binaries, ports 9430–9434, real ENC `US5GA2BC`): **PASS** — Playwright spec green (chart, packs, weather, nav, health, offline guards; 7.0 s), no console errors.
- Committed verifier evidence: `helmcxx8-evidence/cockpit/` — five screenshots (boot, health panel, offline pack active, weather proof, pan/zoom no-blank) plus health/catalog JSON snapshots.

### 3.4 HELMC++-5 — Benchmark / soak

- Recorded evidence (PR [#330](https://github.com/StevenRidder/Helm/pull/330)): `scripts/helmcxx-benchmark-soak.mjs` PASS on ports 9360+ — cold start, first-chart/first-weather-layer timing, p50/p95/p99 endpoint latencies (24 samples), 80 concurrent requests with zero errors, RSS/CPU sampling, cache/no-network behavior, crash/restart recovery, disk/dependency footprint, 30 s short soak. Baseline compare recorded `baseline_missing` (see section 6.1).
- Verifier re-run 2026-07-05 (fixed binaries, ports 9410–9414, 900 s soak): **PASS** end-to-end.
  - Cold start: helm-packd 31.6 ms, helm-basemap-cache 103.7 ms, helm-envd 103.7 ms, helm-server 309 ms. First visible chart layer 36.9 ms; first environmental layer 1.1 ms.
  - Endpoint latencies (p50/p95/p99 ms): server health 0.68/3.83/30.4, catalog 0.64/1.72/2.95, chart tile 2.74/3.41/3.48; packd catalog 0.48/0.7/0.7, range 0.36/0.47/0.79; envd chunk 0.43/0.88/0.91; basemap-cache catalog 0.39/0.73/1.44.
  - Concurrent stage: 80 requests / 4 clients, **0 errors**, p50 1.32 ms, p99 8.54 ms.
  - Soak: 900 s, 4,395 requests + 879 nav WebSocket frames, **0 errors**, p50 0.85 ms, p99 5.18 ms, max 17.05 ms.
  - Resources: helm-server RSS p95 69 MB (cpu max 7.6%); the three small daemons 5.7–6.9 MB RSS each, ~0% CPU. helm-server restart recovery 665.6 ms.
- Committed verifier evidence: `helmcxx8-evidence/benchmark.json`, `helmcxx8-evidence/benchmark.md`, `helmcxx8-evidence/benchmark-soak.log`.
- Note: the two prior verifier benchmark runs failed the concurrent stage and led to the BUG-1 fix (section 4); this passing run is on the fixed binaries.
- The contract's 12–24 h soak window is tracked as **NATIVE-16** on reference hardware (section 6.2).

### 3.5 HELMC++-6 — Packaging / install proof

- Recorded evidence (PR [#336](https://github.com/StevenRidder/Helm/pull/336)): static guard + `--run-smoke` staged real-binary install PASS (ports 9440+); no Docker, no Python daemon, no `/tmp` build-path leakage; deterministic `/opt/helm`, `/etc/helm`, `/var/lib/helm/*`, `/srv/helm/*` directories; launchd + systemd supervision units; installer supports rootless `--staging-root` proof.
- Verifier re-run 2026-07-05 (static): **PASS** — all six checks (artifacts checked in, shell syntax, no Docker/Python/temp-path requirements, deterministic dirs, units launch installed binaries, staging install clean).
- Verifier re-run 2026-07-05 (`--run-smoke`, fresh binaries, ports 9450+): **PASS** — staged real-binary install, health/catalog/local-pack smoke, clean shutdown (`helmcxx8-evidence/packaging-smoke.log`).
- Known scope limits: codesign/notarization is handled on the NATIVE track (NATIVE-13 notarized DMG); fresh-machine install logs live with the PR record rather than in-repo.

### 3.6 HELMC++-7 — Maintainability audit

- Recorded evidence (PR [#331](https://github.com/StevenRidder/Helm/pull/331)): audit PASS, zero failures, with explicit warning dispositions in [HELMCXX-MAINTAINABILITY.md](HELMCXX-MAINTAINABILITY.md).
- Verifier re-run 2026-07-05: **PASS**, 0 failures, 3 warnings — identical to the recorded set:
  - `helm-server` missing explicit `target_compile_features(... cxx_std_17)` → filed as **ENGINE-20** per the doc's own disposition rule ("file a small ENGINE/HELMC++ cleanup if this remains before HELMC++-8").
  - `helm-server` at 4481 lines (named OpenCPN/ixwebsocket legacy-adapter raw-ownership exception; size watch).
  - `helm-packd` at 2228 lines (size watch).
- Smaller daemons (`helm-basemap-cache` 767 lines, `helm-envd` 834 lines) carry zero warnings and fail the audit if the legacy ownership style spreads.

### 3.7 AI-18 — Optional/non-safety Python backend

- Backend `:8090` is codified as an optional companion, not chart/nav runtime; `/health` exposes the optional/non-safety boundary; web regression proves the cockpit behaves honestly (offline/cached) when the backend is absent. Test record: backend smoke 26/26, guardrails 5 OK, probe contract 4 OK, web units 14/14, runtime guard green.

### 3.8 WX-26 — Legacy weather stack retired

- `wx-scene.js`/WebGPU scene, the `:8093` gateway, and coverage-chasing machinery removed (net −1130 lines) with a retirement-gate test pinning the removal in CI. Live path is release discovery → `HelmWxGrid` → chunks from C++ `helm-envd` `:8094`, client re-checksums endpoint bytes. E2E 49 passed including zero-`:8093`/non-local assertions. `services/wx` demoted to `--wx-oracle` (dev/reference only). Live-boat deploy verified on the Fiji route pack.

## 4. Verifier re-run log (2026-07-05)

Independent verification for this dossier — not a re-statement of the feeder
tasks' own evidence:

- Binaries rebuilt from `origin/main` @ `beaad35a` via
  `engine/bootstrap.sh --dir /private/tmp/helm-helmcxx8-opencpn` (private
  clone; the July-3 shared-clone binaries were rejected as stale because
  OFFLINE-18 and CHART-5/6/7/9 touched `engine/vendor/cli` + `engine/patches`
  after they were built). Bootstrap's ENGINE-11 GPL containment check passed.
- Round 1 (as-merged binaries): inventory guard PASS; parity static PASS;
  parity contract mode PASS 8/8; no-Python E2E PASS (ports 9400–9405);
  packaging static + `--run-smoke` PASS (ports 9450+); cockpit proof PASS
  (ports 9430–9434); maintainability audit PASS with the 3 known warnings.
  **Benchmark gate FAILED twice** in the concurrent stage (2 then 3 of 80
  requests `fetch failed`, rotating endpoints/daemons) → diagnosed as
  **BUG-1**: all four daemons answer HTTP/1.1 with no `Connection` header
  (implicit keep-alive) and then close the socket; keep-alive clients race the
  close (curl: "Connection 0 seems to be dead"; undici: `fetch failed`).
- Fix (this branch): every daemon HTTP response now carries
  `Connection: close`, matching ixwebsocket's one-request-per-connection
  behavior (`engine/vendor/cli/helm_{server,packd,basemap_cache,envd}.cpp`).
- Round 2 (fixed binaries): benchmark gate **PASS** end-to-end — endpoint
  percentiles, 80-request concurrent stage with zero errors, 900 s soak,
  restart recovery, no-network replay (section 3.4); no-Python E2E PASS;
  parity contracts PASS 8/8; packaging `--run-smoke` PASS; cockpit proof
  PASS; maintainability/inventory/parity static PASS. Protocol proof:
  `helmcxx8-evidence/connection-close-proof.txt` (responses advertise
  `Connection: close`; the dead-socket race is gone).
- Live `:8080` untouched; all runs on private ports.

Committed evidence snapshots: [`helmcxx8-evidence/`](helmcxx8-evidence/)
(the per-run `test-results/` trees are gitignored by design; this directory
preserves the verifier's summary artifacts).

## 5. Open regressions and bugs

Board sweep 2026-07-05: no pre-existing open regression or bug tasks against
the C++ runtime. One defect was found *by this verification* and is fixed in
this branch:

| Bug | Disposition |
|---|---|
| **BUG-1** — all four C++ daemons close HTTP/1.1 connections without advertising `Connection: close`; keep-alive clients race the close (benchmark gate failed; browsers mask it by retrying idempotent GETs) | **Fixed in this PR** (`Connection: close` on every response); benchmark + all gates re-run green; full signal recorded on the board as BUG-1 (fail_fix_signal.v1, failed_gate) |

Adjacent non-Done tasks are future work, not defects in the accepted runtime:

| Task | Status | Why it does not block acceptance |
|---|---|---|
| CHART-19/CHART-20/CHART-27 | Blocked / Not Started | Phase-2 chart-render evolution (WebGPU render-core, S-101 portrayal) on top of the accepted tile path. |
| CONTRACT-11 | Blocked | HTTP/2-3 tile multiplexing enhancement. |
| CONTRACT-16, CHART-15, LAUNCH-3 | Blocked / Not Started | Alarm/partnership/community intake features. |
| WX-16, WX-29 | Blocked (superseded) | Explicitly superseded by the WX-26 compact-grid path; keep-closed markers. |

## 6. Residual risks and dispositions

1. **`baseline_missing` on the benchmark comparison.** No numeric
   Python-baseline comparison exists because the reference Python stack was
   never a full equivalent of the four-daemon runtime and WX-26 retired the
   last live Python service before HELMC++-5 ran; resurrecting it would mean
   benchmarking a dev-only oracle. The harness records `baseline_missing`
   explicitly instead of claiming a win. Accepted tradeoff per the contract's
   "documented wins or justified tradeoffs": the dependency-story wins are
   structural (no Python/uvicorn/venv/Docker in runtime, four supervised C++
   binaries, deterministic directories) and the absolute latency/footprint
   numbers in section 3.4 stand on their own.
2. **12–24 h soak not yet run on reference hardware.** Recorded runs used the
   short/medium soak windows the harness is built for. Filed as **NATIVE-16**
   (depends on NATIVE-15 reference hardware), to run
   `HELM_HELMCXX5_SOAK_SECONDS=43200` with a real nav feed before sea-trial
   reliance.
3. **`cxx_std_17` compile-feature warning on `helm-server`.** Filed as
   **ENGINE-20** per the HELMC++-7 disposition rule. Non-blocking: the target
   builds through the existing C++17 toolchain.
4. **Size watch on `helm-server` / `helm-packd`.** Named legacy-adapter
   exception stands; the audit fails smaller daemons if the pattern spreads.

## 7. Go/no-go rule, point by point

Per the [acceptance contract](HELMCXX-ACCEPTANCE.md) go/no-go rule:

| Requirement | Status |
|---|---|
| Required boat/runtime daemons are C++ | ✅ helm-server, helm-packd, helm-basemap-cache, helm-envd (section 2) |
| No required non-C++ daemon remains | ✅ inventory guard PASS; no-Python E2E process-tree assertion PASS (3.2, 4) |
| Optional non-runtime surfaces explicitly non-safety / dev-only / reference-only / offline-only | ✅ AI-18 backend boundary, WX-26 oracle demotion, inventory classifications (2, 3.7, 3.8) |
| Reference-oracle parity recorded | ✅ HELMC++-2 matrix + contract runs (3.1) |
| No-required-non-C++ runtime E2E passes | ✅ recorded + verifier re-run (3.2) |
| Playwright cockpit proof passes | ✅ recorded + verifier re-run (3.3) |
| Performance/reliability/soak comparison recorded | ✅ recorded + verifier re-run; `baseline_missing` and long-soak dispositions named (3.4, 6.1, 6.2) |
| Packaging/install proof passes without Docker | ✅ recorded + verifier re-run (3.5) |
| Maintainability audit has no blocking findings | ✅ 0 failures; warnings dispositioned (3.6, 6.3, 6.4) |
| Final evidence links exact PRs, branches, merged SHAs, logs, screenshots, benchmark artifacts | ✅ this dossier (1, 4, `helmcxx8-evidence/`) |

**Decision: GO.** The HELMC++ epic's acceptance condition is met. Residuals
ENGINE-20 and NATIVE-16 are tracked on the board and are not required-runtime
correctness gaps.
