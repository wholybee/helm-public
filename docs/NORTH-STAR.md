# Helm — North Star

**One screen for everything on the water.**

Living product vision + engineering priority stack. Backend work is "done" when UI/AI can call `sample(lat, lon, t)`, `inspect(pick)`, and `subscribe(channel)` and get **source-tagged, stale-aware, citable** answers.

---

## The problem

Today's cruiser carries four apps in their head: one for the chart, one for Windy-style weather, one for PredictWind-style routing, and another for instruments and AIS. Nothing shows it all on one map, offline, with a single source of truth about what the boat actually knows right now.

Helm is built to fix that.

---

## What Helm is

Helm is a **local-first boat server** with **thin cockpit clients** — browser, tablet, or native shell — all talking to one origin on the boat LAN.

The safety core runs headless on the boat: OpenCPN-derived navigation logic and true **S-52 vector ENC** chart rendering, served over HTTP and WebSocket. The cockpit is a modern map UI that composites charts, satellite, weather, AIS, routes, tides, and instruments into **one situational picture**.

Not a cloud dashboard. Not four apps duct-taped together. **One system.**

```text
   Cockpit (browser / tablet / native)
              │
              HTTP + WebSocket — one local origin
              │
   helm-server (C++) — nav core + S-52 charts + boat data
              │
   Your charts · NMEA/SignalK · weather · local packs
```

---

## The value proposition

**See everything. Trust what you see. Ask the boat — and get answers grounded in real data.**

Helm's North Star is not "more AI features." It is **UI + intelligence on top of probeable, citable boat state**: the chart object under your cursor, the alarm that won't silently disappear, the tide window along your route, the AIS target in your guard zone — all addressable, inspectable, and honest about freshness.

---

## Features — what Helm is today

### True ENC charts on a modern map
- **S-52 vector charts** rendered headless from your own OpenCPN-compatible ENC cells — not a generic basemap pretending to be navigation.
- **Multi-cell quilting** with transparent gaps where data isn't loaded — fail-loud, not fail-pretty.
- **Depth on satellite**: soundings and contours composited over imagery when you want context, not just blue polygons.
- **Deterministic rendering** — same chart, same tile, same pixels. What you see is what the engine computed.

### One navigation brain
- **Active route navigation** from OpenCPN's Routeman: bearing, distance-to-go, cross-track error, ETA, VMG — streamed live, not reinvented in JavaScript.
- **AIS awareness**: targets, CPA/TCPA, guard zones — on the same chart as everything else.
- **Tracks and persistence** that survive restarts — your passage history stays on the boat.
- **Honest data sourcing**: if there's no GPS feed, Helm doesn't invent a position.

### A cockpit that stays thin
- **MapLibre-based UI** — fast, pan/zoom-native, layer-composited.
- **One origin**: `/nav`, `/chart`, `/catalog`, `/health` from a single `helm-server` process.
- **Works on the boat LAN**: same machine or another display; no app store required for the reference client.

### Weather and routing — on the chart, not beside it
- **Scalar weather layers** (wind, waves, pressure) composited where you're actually going.
- **Route + weather together** — the beginning of spacetime thinking: what conditions look like *along your line*, not just at a pin.

### Offline-first by design
- **Your charts, your packs, your boat** — no bundled chart data, no silent cloud dependency.
- **Local basemaps and MBTiles/PMTiles-style packs** served from the boat; CDN is optional, not assumed.
- Built for **spotty marina Wi‑Fi and open ocean** — the architecture assumes connectivity is the exception.

---

## Features — what Helm is becoming (North Star)

### Tap the chart. Get the truth.
**Inspect any chart object** — buoy, depth area, restricted zone — and see S-57 attributes in plain language. Not a screenshot. Not a guess. The same object the renderer used.

*Why it matters:* The map stops being decoration. It becomes queryable maritime data — the foundation for AI that can cite "this buoy, this edition, this attribute."

### AI that reads the boat — and shows its work
- **Spacetime probe**: ask about conditions, objects, or state at a place and time; get **engine-backed samples**, not vibes.
- **Natural-language command palette** (⌘K): "What's the next tide at…" tied to real tide stations and route geometry.
- **Explain-this** on alarms, chart features, and routing decisions — with **source tags and freshness**.
- **Advise, don't act**: Helm's AI narrates and cites; it doesn't silently alter nav or ack alarms for you.

*Why it matters:* Marine AI that can't point at a fact is liability dressed as convenience. Helm's bar: **no layer is "done" until the probe can sample it.**

### Charts that respect the watch
- **Day / Dusk / Night S-52 palettes** — engine-side, not a CSS filter on PNGs.
- **Display category control** (Base / Standard / All / Mariner) with **overzoom and SCAMIN warnings** when you're asking the chart to lie.
- **Honest catalog**: what cells are loaded, which edition, how stale, what bbox — `/catalog` that doesn't oversell coverage.

### Alarms you can't miss — and can't accidentally dismiss
- **Persist until acknowledged** — critical alarms resend; they don't get coalesced away by a reconnect.
- **Structured alarm schema** wired through the same streaming contract as nav — one reliability tier for safety events.
- **Anchor drag, guard zones, watchkeeping advisories** — local first, with optional push when you're off the boat.

### Connection that fits a boat, not a datacenter
- **Reconnect with resume** — pick up deltas after a drop, not a full cold start.
- **Channel subscriptions** — choose what you need at 1–4 Hz; AIS culled to your viewport when you don't need the whole ocean.
- **One TLS origin** — nav, charts, catalog, pairing on one cert.
- **Bonjour discovery + TOFU pairing** (QR/PIN) — join the boat LAN without a CA hierarchy.
- **View-only vs owner roles** — show the guest the view; keep route edits and acks with the skipper.

### Watchmate — voyage memory, not chat history
- **Structured voyage journal**: routes, weather windows, tide decisions, AIS events, human notes — timestamped and sourced.
- **Watch handoff**: "What changed since I was on deck" — for couples, crews, and tired passages.
- **Forecast-diff narration**: how the next 48 hours shifted relative to when you planned — advisory, with confidence, never raw "you're safe."

### Routing and tides with receipts
- **Harmonic tide prediction** with station distance and datum confidence — government-sourced, tagged.
- **Pass models and slack windows** along your actual route geometry.
- **Weather routing primitives** that sample **along the worldline**, not at arbitrary pins.

### Offline bundles — leave the dock prepared
- **Region packs**: charts + weather + tides + basemap in one reproducible bundle.
- **Replay without network** — environmental and reference data as first-class offline assets, not "hope you cached it."

---

## Who Helm is for

- **Coastal and offshore sailors** tired of app-switching and cloud-dependent chart UIs.
- **Couples and small crews** who need shared situational awareness and sane watch handoff.
- **OpenCPN users** who want a modern cockpit without abandoning ENC correctness.
- **Builders and integrators** who want a **probeable nav/chart API** on the boat — not a walled garden.

---

## What Helm is not (yet)

Helm is **pre-alpha, supplemental navigation software**. It is not type-approved ECDIS, not certified for primary navigation, and not a replacement for paper charts, official publications, or your own judgment.

We say that plainly because **honesty is part of the product**: stale data labeled stale, missing coverage shown as missing, AI answers tied to sources — or refused when they can't be.

---

## The one-line pitch

**Helm puts charts, weather, AIS, routing, and instruments on one offline-capable map — with an AI copilot that can only speak when the boat can prove what it's saying.**

---

## Taglines

- *One screen. One boat. One truth.*
- *The chartplotter that knows what it knows — and tells you when it doesn't.*
- *OpenCPN's brain. A modern cockpit. An AI that cites the ENC.*
- *Stop juggling four apps. Start reading one map.*

---

## How to think about backend vs UI/AI

```text
UI/AI North Star
       ↑ needs
┌──────────────────────────────────────┐
│  Probe + inspect + alarm + journal   │  ← YOU ARE HERE (thin)
│  (machine-readable “what’s true?”)   │
├──────────────────────────────────────┤
│  Streaming contract (nav/AIS/alarms) │
├──────────────────────────────────────┤
│  Chart semantics (palette, pick, cat)  │
├──────────────────────────────────────┤
│  helm-server safety core (mostly done) │
└──────────────────────────────────────┘
       ↑ don’t deepen until above works
  Forge / S-101 / Vulkan / CHART-13
```

**Rule:** Backend work is "done" when the UI/AI can call **`sample(lat, lon, t)`**, **`inspect(pick)`**, and **`subscribe(channel)`** and get **source-tagged, stale-aware, citable** answers — not when you have more SQLite tables or SVG folders.

---

## Finish and ship (forum + DB rules)

- OpenCPN forum symbol commitment — closes the social/technical loop there.
- DB rules + crosswalk / portrayal SQLite — **option value only**: licensing path, S-101 semantics reference, test oracle, future clean-room pack if CHART-13 ever clears.
- **Not** on the critical path for live charts today (`default_render_records` stays empty; production stays `s52plib` + GPL rasters).

---

## Phase A — agreed backend path ("The brain can see the boat")

Once symbols are done, North Star work is **brain can see the boat**, not more SVG depth:

| Order | Epic | Why first |
|-------|------|-----------|
| 1 | **CHART-10** | Live ENC object query + `helm.inspect.trace.v1` — AI needs citable facts from real charts |
| 2 | **AI-5 / AI-17** | `sample()` contract + registry so probes return engine-backed truth |
| 3 | **CONTRACT-10** | Alarm schema (persist, resend-until-ACK) — safety surface |
| 4 | **CHART-8/9** | Server-side S-52 palette + display category — honest portrayal control |
| 5 | **CONTRACT-5b** | `/catalog` with edition, staleness, coverage — no lying about what's loaded |

**Park until gates clear:** bulk Forge expansion, deep S-101 mapping, CHART-13 clean-room, microservice split, Vulkan-as-default.

**Parallel (non-blocking):** Vulkan render-core upstream push — good for OpenCPN long-term, not a Helm product blocker.

**Integration spine (NS-PHASE-A):** wire **live ENC → inspect/probe → AI** so Phase A isn't five loose tickets. Switchboard: `NS-1` (parent), `NS-2`…`NS-6` (children). See [../projectplanner/docs/HELM-PHASE-A-EPIC.md](../projectplanner/docs/HELM-PHASE-A-EPIC.md) in the planning repo.

### Phase A exit criteria

Tap buoy → structured `helm.inspect.trace.v1` → AI explains with citations. Alarm fires → journal event → no silent drop.

---

## Phase B — "The brain survives the boat network"

| Priority | Task | Why |
|---|---|---|
| **A** | **CONTRACT-6** — `lastSeq` resume | Reconnect without full snapshot |
| **B** | **CONTRACT-7/8** — channels + bbox AIS | Battery + bounded AI context |
| **C** | **CONTRACT-12–15** — TLS + pairing + tokens | Marina WiFi safety |
| **D** | **ENGINE-10** — finish UpdateProgress in model | Clean safety core |
| **E** | **ENGINE-12** — helm-server default in bootstrap | Onboarding friction |

---

## Phase C — "The brain remembers the passage"

- **WATCHMATE-2** voyage journal event store
- **TIDES-2** engine tides (feeds probe)
- **OFFLINE-6/7** bundles with staleness

---

## Phase D — optional speed lane

Single milestone: `GET /chart/...` or `GET /artifact/...` hits **cached render model**, not wxDC every miss. One tile from model → artifact. Do not block UI on upstream Vulkan merge.

---

## Park (drain Switchboard by closing, not expanding)

| Work | Verdict |
|---|---|
| Apache symbol library / FORGE bulk SVG | **Park** until one symbol renders end-to-end in smoke |
| S-57→S-101 crosswalk depth | **Park** — no S-101 chart consumer |
| CHART-13 clean-room renderer | **Park** — IP counsel + post-MVP |
| `helm-chartd` / `helm-renderd` split | **Park** — contracts first |
| Native Mac Metal | **Client tier** — after WKWebView gate |

---

## One-page priority list (post-Switchboard)

```text
NOW (backend for North Star):
  1. CHART-10  — chart object query / inspect trace
  2. AI-5/17   — probe sample() contract + tests
  3. CONTRACT-10 — alarm reliability schema
  4. CHART-8/9 — real S-52 palette/category on server
  5. CONTRACT-5b — honest /catalog
  6. NS-PHASE-A — integration spine (live ENC → inspect → probe → AI)

NEXT (product hardening):
  7. CONTRACT-6/7/8 — resume, channels, AIS bbox
  8. WATCHMATE-2 — voyage journal store
  9. OFFLINE-6/7 — offline packs + staleness
  10. ENGINE-10/12 — safety core cleanup

PARALLEL (don't block UI):
  11. Vulkan one-tile integration OR push render core to OpenCPN

PARK:
  Forge SVG expansion, S-101 depth, CHART-13, microservice split
```

---

## The sentence to put on your wall

**UI and AI are the product; the backend's job is to expose truthful, probeable, citable state — not to draw prettier tiles in more formats.**

Drain Switchboard into **inspect + probe + alarms + catalog + streaming** first. Everything else (symbols, S-101, Vulkan, Metal) is either **insurance** or **performance**, not the missing brain.

---

*Status: pre-alpha · source-available · macOS build path documented · you bring your own charts and boat data*
