# FALLBACK-1: render fallback proof (safety fallback + regression bridge)

FALLBACK-1 proves the **current** chart render fallback path against one committed fixture.
It is deliberately **not** the WebGPU browser path (WEBGPU-1/2, INTEGRATE-1): it is the safety
fallback and the regression bridge that lets us change the new path while keeping a trusted,
deterministic reference for the old one.

It proves five properties of the engine chart route (`GET /chart/{z}/{x}/{y}.png`):

1. **Renderer selection** — `HELM_CHART_RENDERER` / `?renderer=legacy|vulkan` pick a backend.
2. **Headers** — the Vulkan path emits `X-Helm-Renderer`, `X-Helm-Renderer-Sha`,
   `X-Helm-Renderer-Cache-Key`, and `X-Helm-Renderer-Output-Sha`; legacy emits
   `X-Helm-Renderer: legacy` and **no** renderer SHA.
3. **ETag / cache keys** — a stable ETag per tile with `304` conditional revalidation.
4. **Explicit fallback** — when Vulkan fails and `?fallback=legacy` (or
   `HELM_VULKAN_FALLBACK=legacy`) is set, the route serves the legacy tile and marks it with
   `X-Helm-Renderer-Fallback: vulkan-render-failed`. Fallback is **visible, never silent**.
5. **No silent fallback** — when Vulkan fails **without** an explicit fallback opt-in, the route
   surfaces an error (not a silently substituted tile).

See also `docs/VULKAN-HEADLESS-TILE-ADAPTER.md` and `docs/VULKAN-HELM-WEBGPU-PROOF.md` for the
underlying adapter and header contract.

## Run it

```bash
# Native leg only (CI-safe, no GPU, no server) + the fallback-contract selftest:
python3 scripts/fallback1-assert.py --selftest
scripts/fallback-1-proof.sh

# Full proof including the live chart route (needs a bootable helm-server + S-52 runtime + ENC):
HELM_SERVER_BIN=/path/to/helm-server \
HELM_S57_DATA="$HOME/.helm/runtime/s57data" \
HELM_ENC="$HOME/.helm/runtime/enc/<CELL>/<CELL>.000" \
HELM_FALLBACK1_REQUIRE_SERVER=1 \
  scripts/fallback-1-proof.sh
```

## Two legs

| Leg | Runs where | Proves |
|-----|------------|--------|
| **A — native** | everywhere (needs only `c++` + `python3`) | fixture renders to a byte-identical PNG matching the committed golden (`expected_offscreen[0].sha256`), corpus integrity, and cache-key/epoch invalidation |
| **B — server** | where a helm-server boots (S-52 runtime + ENC) | live renderer selection, headers, ETag/`304`, explicit `vulkan → legacy` fallback, and that a non-opted-in Vulkan failure is not silently masked |

Leg B starts the server twice against the same fixture: once with the CPU fixture renderer
(`scripts/vulkan-render-fixture`) as the Vulkan adapter to prove the happy path, and once with a
deliberately failing adapter to prove both the explicit fallback and the no-silent-fallback rules.
When no bootable server is available (e.g. plain CI without the OpenCPN S-52 runtime), Leg B
records an explicit `skipped_<reason>` in `test-results/fallback-1/manifest.json` rather than
passing silently. Set `HELM_FALLBACK1_REQUIRE_SERVER=1` to turn that skip into a hard failure.

The `fallback1-assert.py --selftest` path validates the Leg B contract logic itself with synthetic
responses — including tampered corpora (silent fallback, missing fallback header, output-SHA lie,
mislabeled renderer, missing `304`) — so the contract has teeth even on machines that cannot boot
the S-52 server.
