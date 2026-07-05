# Helm backend (optional prototype)

The small FastAPI service the static web app + C++ engine don't provide: the **place store**,
**owned pins/reviews**, the **"where to go" recommender**, **ReAct research agents** that fill
the dossier cards, and the **give-back publishers** (NFL push + OSM Notes). Source-agnostic,
offline-first, NFL-slot-open, and source-labelled.

This service is explicitly **optional and non-safety**. Helm's chart, nav, AIS,
route, alarm, catalog, and health runtime must remain usable without it. Web
callers must treat it as an advisory/community companion: if `:8090` is absent,
show cached/local/sample data or an honest offline state, not a broken cockpit.

If any backend feature becomes required for normal boat operation, do not wire
that requirement through Python/FastAPI directly. First split out the durable
protocol/store contract, create a board task, and make the C++ runtime ownership
decision.

## Run

Requires **Python 3.9+** (verified on 3.9.6 — the macOS system `python3` — and 3.13).

```bash
cd backend
pip install -r requirements.txt
cp .env.example .env          # optional — works with no keys (stub/mock mode)
uvicorn main:app --reload --port 8090
```

The web prototype (`web/community.js`) auto-detects `http://127.0.0.1:8090` and **falls back to
local sample data when it's not running** — so the chart never breaks.

## Modes (graceful by design)

| Without keys (now) | With keys (you add later) |
|---|---|
| `where to go` + dossier run a **deterministic stub** (honest reasons from real weather + seed sources) | set `OPENAI_API_KEY` → real **ReAct agent** + LLM ranking/explanation |
| NFL push runs **mock** (`sent-mock`, proves queue/flush) | set `NFL_BOAT_KEY` + `NFL_PUSH_ENABLED=true` → live push |
| OSM Notes **scaffold** (`would-create`) | set `OSM_NOTES_ENABLED=true` → live Notes |
| `search_web` returns **curated real cruiser sources** | set `SEARCH_PROVIDER` (Tavily/Bing/SerpAPI) → full live search |

**Secrets:** all via `.env` / env vars, **never committed** (see `.gitignore`); the NFL key
stays device-local.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | mode report (llm provider, nfl/osm mode) |
| GET | `/places?sources=osm,owned` | source-tagged places (GeoJSON) |
| GET | `/saved` · POST `/saved` | owned saved pins (the cross-device bookmarks) |
| POST | `/reviews` | add an owned review |
| POST | `/whereto` | recommender: deterministic pre-filter + LLM rank/explain + map highlight |
| POST | `/dossier` | **ReAct agent** fills the destination dossier (cited) |
| GET | `/weather?lat=&lon=` | real forecast at a point (Open-Meteo) — the agent's weather tool |
| POST | `/giveback/nfl/push` | push own position to NFL (mock-first) |
| POST | `/giveback/osm-note` | OSM Note give-back (scaffold-first) |

## Probe contract

`probe_contract.py` defines the backend `sample(lat, lon, t)` bar for probeable
layers. A layer is not considered complete for the spacetime probe unless it
registers a `ProbeLayer` and returns a validated `LayerSample` with:

- `productId`, `datasetName`, `producer`, and trace/source metadata
- freshness, confidence, coverage, horizon, and valid time where applicable
- an explicit status: `ok`, `not_available`, `not_implemented`,
  `out_of_coverage`, or `error`

`probe_layers.py` registers the current backend faces for weather, climate,
depth, AIS, and tides. Tides samples call optional `helm-server`
`/tides/summary` via `engine_client.py` (`HELM_ENGINE_URL`, default
`http://127.0.0.1:8080`) and degrade to `not_available` when the engine is
absent. Climate remains explicitly `not_implemented` until AI-15 wires live
climatology. `context.resolve_context` keeps its existing layer payload shape
and adds a nested `sample` provenance envelope to each probeable layer.

## Advisory guardrails

`guardrails.py` enforces the AI-13 response contract for `/context`, `/narrate`,
`/briefing`, `/dossier`, and `/whereto`. Every AI-facing response carries a
`guardrails` envelope with:

- `actionClass: advisory`, `mayAct: false`, and `notForNavigation: true`
- cited-source, freshness, and horizon evidence counts
- visible violations such as `missing_sources`, `missing_freshness`,
  `missing_horizon`, or `unsafe_action_language`

Guardrail failures do not masquerade as green output: the response is marked
`needs_verification` or `blocked_from_action` while preserving the original
reason. This keeps the Python backend useful for optional narration and research
without making it part of the safety/control runtime.

## The ReAct agents ([agents.py](agents.py))

A reason→act→observe tool-calling loop that **researches instead of hallucinating**. Tools:
`get_weather` (real Open-Meteo), `search_web` (pluggable; curated sources until a provider is
set), `fetch_page` (real fetch + extract). The agent may only summarize what tools return,
**cites every claim with a source + date**, and marks gaps "verify locally". Fills the dossier
sections (formalities · anchorage · services · community · climate) + arrival weather.
