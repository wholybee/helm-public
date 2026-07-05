# Watchmate Contract

Watchmate is Helm's voyage memory layer. It turns the active voyage into a
structured, source-tagged timeline that can be reviewed by the skipper, handed
between watches, and used to surface route-aware advisories.

Watchmate is not an autonomous navigator. It is a supplemental watchkeeping aid
that journals what Helm observed, explains what matters now, and projects what
may matter next. The engine, sensors, route math, alarms, forecast models, tide
sources, and human-entered notes remain the sources of truth. LLM text may
summarize or comment on those records, but it must never become the fact store.

Use the safety warning from [SAFETY.md](../SAFETY.md) anywhere Watchmate presents
navigation, weather, tide/current, AI, routing, or advisory output:

> Supplemental aid only. Not for primary navigation. Cross-check official
> charts, notices, instruments, and conditions.

## Product Shape

Watchmate has three time bands:

1. Past: a replayable voyage journal of observed events, generated comments,
   human notes, acknowledged decisions, route progress, alarms, and data-state
   changes.
2. Present: a current-watch view that answers "what matters right now?" using
   active leg, ownship, route, weather, tide/current, AIS, alarms, and freshness
   state.
3. Future: route-aware windows that answer "what is likely to matter next?"
   without hiding model spread, stale data, or low confidence.

The first usable experience should feel like a calm watchmate:

- "What changed since 0200?"
- "What is the next decision point?"
- "Why did Helm raise this advisory?"
- "Which facts came from live instruments, forecasts, cached models, or human
  notes?"
- "What should the next watch verify by eye or with independent instruments?"

## Safety Boundary

Watchmate may advise, summarize, and prompt. It must not command, steer, or
imply clearance.

Hard rules:

- No actuation. Watchmate must not issue autopilot, route activation, engine,
  sail, anchor, alarm-clear, or connection-control commands.
- No "safe" claims for passes, reefs, approaches, anchorages, or traffic.
  Allowed wording is conditional and advisory, such as "favorable current
  window" or "low-confidence pass timing; verify locally."
- No hidden provenance. Every entry and advisory must expose source, freshness,
  confidence, and the reason it exists.
- No LLM-created facts. LLM output can only reference structured event ids,
  source records, and cited external material already attached to the journal.
- No silent staleness. If a source is stale, cached, offline, simulated, or
  sample-derived, Watchmate must say so in both card metadata and summaries.
- No single-source authority. Weather, tide/current, AIS, chart, and AI-derived
  claims remain supplemental and should direct the skipper to cross-check.

## Source Model

Every Watchmate record must carry a source block. A future implementation may
rename fields, but it must preserve these concepts:

```json
{
  "source": {
    "kind": "live_sensor | engine_calc | forecast | tide_model | observed_report | alarm | human | ai_comment | external_research | system",
    "system": "helm-server | backend | web | user | provider-name",
    "record_id": "upstream stable id when available",
    "observed_at": "2026-06-29T02:15:00Z",
    "issued_at": "forecast or model issue time when different",
    "valid_at": "time the value describes",
    "received_at": "time Helm received or generated this record",
    "freshness": "live | recent | stale | cached | offline | simulated | sample",
    "confidence": "high | medium | low | unknown",
    "provenance": "short human-readable source explanation",
    "citation_url": "optional URL or local artifact reference"
  }
}
```

The dual time axis matters:

- `observed_at` records when a thing happened.
- `issued_at` records when a forecast/model was published.
- `valid_at` records the time the forecast/model describes.
- `received_at` records when Helm learned about it.

Summaries must not flatten these into one timestamp.

## Event Taxonomy

Watchmate stores structured events before it stores prose. The event store is
the substrate for the timeline, handoff summaries, exports, and tests.

### Route Events

- Route created, imported, activated, deactivated, or switched.
- Waypoint arrival, skipped waypoint, active-leg change, route auto-advance.
- Leg metrics changed materially: BRG, DTW, DTG, XTE, ETA, TTG, VMG, turn angle.
- ETA drift crossed a threshold.
- Arrival after dark, tide gate, pass window, or approach timing crossed a
  threshold.

Primary sources: engine route stream, route command acknowledgements, routing
or probe outputs.

### Ownship And Instrument Events

- Position fix received, source changed, source became stale/offline/live.
- SOG, COG, heading, depth, STW, wind, or other instrument values crossed a
  configured threshold.
- Track segment start/stop, distance milestone, large speed loss/gain, drift
  trend, or unexpected set.

Primary sources: nav stream, source tags, engine calculations, configured
instrument feeds.

### Weather And Met-Ocean Events

- Wind, gust, rain, pressure, swell, wave, current, or model spread changed
  materially along the active route or watch horizon.
- Forecast age crossed a freshness threshold.
- Forecast issue changed and materially affects route timing or risk windows.
- Model disagreement exceeded a configured spread threshold.

Primary sources: WX layers, weather-along-route ribbon, forecast issue/valid
times, ensemble/spread records.

### Tide, Current, And Pass Events

- Tide or current estimate changed for the active leg, destination, pass, bar,
  anchorage, or chosen waypoint.
- Station/source resolver changed source, confidence tier, datum, station
  distance, residual, or warning.
- Slack/current/pass window opened, closed, or moved materially.
- Observed current/residual became available or expired.

Primary sources: TIDES source resolver, `/tides/currents`, pass estimator, local
observations.

### AIS And Traffic Events

- Target entered/leaves guard zone, CPA/TCPA risk changed, SART/DSC/MOB event,
  or target became lost.
- AIS target risk classification changed or was acknowledged.
- Watchmate may journal traffic relevance, but COLREGS interpretation and
  maneuver advice must stay behind the AIS/ALARM/PILOT guardrails.

Primary sources: AIS target stream, engine risk tier, alarm channel, collision
advisor outputs.

### Alarm And System Events

- Alarm raised, updated, acknowledged, cleared, muted, expired, or replayed.
- Data feed changed state: LIVE, LAGGING, STALE, OFFLINE, simulated, or sample.
- Backend, forecast gateway, tide provider, or local cache became unavailable.

Primary sources: reliable alarm channel, nav staleness status, service health,
connection state.

### Human Events

- Crew notes, visual observations, sail/engine/reefing notes, manual decisions,
  approach notes, local knowledge, and "ignored advisory" records.
- Human events must preserve author, timestamp, and attachment context.
- Human notes may attach to a route leg, chart location, waypoint, alarm,
  advisory, AIS target, forecast window, or free voyage time.

Primary sources: explicit user input and imported user-owned logs.

### Generated Commentary Events

- LLM summaries, explanations, handoff text, voyage review, and generated
  comments.
- Generated commentary must link to the exact structured event ids and source
  records it used.
- Generated commentary must be replaceable. Deleting/regenerating commentary
  must not delete facts or human notes.

Primary sources: structured Watchmate events plus cited external material.

## Card Types

The UI and export format should distinguish record types visually and
structurally.

### Fact

A structured observation or calculation from Helm, a connected instrument, the
engine, a provider, or a deterministic model.

Required fields:

- `event_id`
- `time`
- `source`
- `payload`
- `why` or `trigger`

Examples:

- "Passed WP013 at 14:12."
- "XTE increased from 0.03 NM to 0.12 NM over 18 minutes."
- "Forecast issue updated at 12:00Z; gust field changed on active leg."

### Forecast

A future condition tied to a route leg, location, valid time, and model issue.

Required fields:

- `event_id`
- `valid_window`
- `route_context`
- `forecast_source`
- `issued_at`
- `confidence`
- `model_spread` when available

Examples:

- "Gusts 28 to 34 kt near WP014 between 15:20 and 16:00."
- "Current forecast turns adverse before pass arrival."

### Advisory

A rule-grounded prompt that points at a possible watchkeeping decision. It must
be explainable and dismissible or acknowledgeable.

Required fields:

- `event_id`
- `severity`
- `horizon`
- `rule_id`
- `inputs`
- `source`
- `confidence`
- `why`
- `recommended_cross_checks`

Allowed language:

- "Consider reefing before WP014; gust risk rises above configured threshold."
- "Verify pass timing locally; tide/current confidence is low."
- "Forecast is stale; do not rely on route-weather timing without refresh."

Disallowed language:

- "Safe to enter."
- "Turn now."
- "Autopilot should steer course X."
- "Ignore official chart or visual conditions."

### Note

A human-authored note or imported user-owned log item. Notes are not generated
by the LLM and must remain visually distinct.

Required fields:

- `event_id`
- `author`
- `created_at`
- `attached_to`
- `body`
- `source.kind = human`

Examples:

- "Reefed main at 14:20."
- "Saw breaking water north side of pass."
- "Delayed entry until slack."

### Decision

A human acknowledgement or explicit decision related to a fact, advisory, route
leg, or alarm.

Required fields:

- `event_id`
- `author`
- `created_at`
- `decision`
- `attached_to`
- `reason`

Examples:

- "Acknowledged gust advisory; reefed main."
- "Chose to hold offshore until daylight."
- "Ignored low-confidence current advisory after visual check."

### Comment

A generated explanation, summary, or narrative over existing records.

Required fields:

- `event_id`
- `generated_at`
- `provider`
- `input_event_ids`
- `source_records`
- `body`
- `limitations`

Comments must be labeled as generated. They are never the authoritative record.

## Time Horizons

Watchmate should support explicit horizons. Each surface may choose a subset:

| Horizon | Meaning | Typical use |
|---|---|---|
| Last fix to 15 min | Immediate watchkeeping | XTE, CPA/TCPA, feed freshness, alarm changes |
| Last watch, 2 to 6 hr | Watch handoff | what changed, ETA drift, weather/current trend |
| Active leg | Navigation context | next waypoint, turn, XTE, ETA, set/drift |
| Next decision window, 15 min to 6 hr | Advisory timeline | gusts, tide gate, arrival after dark, pass timing |
| Passage horizon, 6 to 72 hr | Briefing and routing | forecast-diff, destination dossier, model spread |
| Voyage archive | Review/export | logs, notes, decisions, lessons, future planning |

Every forecast or advisory must state its horizon. If the horizon exceeds the
trustworthy range of the source, Watchmate must label that limitation.

## Retention And Export

Watchmate is local-first. By default, voyage records belong to the boat/user and
should be stored under Helm's user data root, not committed to Git and not sent
to cloud services without an explicit feature/task that owns that behavior.

Retention policy:

- Keep structured events separately from generated comments.
- Keep human notes and decisions separately from generated comments.
- Keep source metadata and event ids through compaction, export, and import.
- Allow coarse retention controls by voyage, date range, and event type.
- Allow generated comments to be regenerated from the structured journal.
- Never let an LLM summary replace the underlying event records.

Export policy:

- Exports must preserve authorship: human, system, provider, LLM.
- Exports must preserve source, freshness, confidence, issue time, valid time,
  and citations where present.
- Exports must label generated commentary as generated.
- GPX/route/track exports may link to Watchmate logs, but they must not smuggle
  generated assertions into route data as facts.
- Sharing or sync belongs to future cloud/native tasks and must be opt-in.

## Explainability

Every card should have a "why" path that can be rendered in the UI and emitted
in exports. The "why" path must include:

- triggering rule or event;
- source records and timestamps;
- source freshness and confidence;
- route or time window affected;
- threshold or configured limit when applicable;
- limitations and cross-check prompts.

For example:

```json
{
  "type": "advisory",
  "title": "Gust risk near WP014",
  "why": {
    "rule_id": "wx.gust.active_leg.threshold",
    "inputs": ["forecast:gfs:2026-06-29T12:00Z", "route_leg:WP013-WP014"],
    "threshold": "gust >= 28 kt within active-leg ETA window",
    "freshness": "recent",
    "confidence": "medium",
    "cross_checks": ["visual weather", "barometer trend", "updated forecast"]
  }
}
```

## LLM Role

The LLM is allowed to:

- summarize a bounded set of structured event ids;
- draft watch handoff text from source-tagged journal records;
- explain why a deterministic advisory fired;
- produce a voyage review that separates facts, human notes, and generated
  comments;
- propose questions the next watch should verify.

The LLM is not allowed to:

- create new facts without a source record;
- change source freshness, confidence, timestamps, or event payloads;
- hide low confidence or stale/offline state;
- issue commands;
- clear or acknowledge alarms;
- rewrite human notes as if they were system facts;
- present external research or local cruising lore without citation and date;
- turn an advisory into a safety clearance.

Implementation should be deterministic-first: rules, thresholds, and source
checks generate candidate cards. The LLM may then phrase the card, summarize a
watch, or add a short comment, but the rule id and source records remain visible.

## MVP Contract

The first implementation should deliver a narrow but real Watchmate:

1. Event store for route events, nav snapshots, alarm changes, weather/tide
   freshness, human notes, and generated comments.
2. Active-leg card with waypoint, BRG, DTW, ETA/TTG, XTE, and source freshness.
3. Timeline showing recent facts, current watch context, and next few forecast
   or decision windows.
4. Watch handoff summary: "what changed since time X?"
5. Advisory cards for stale forecast, XTE trend, ETA slip, gust risk,
   unfavorable current, pass-confidence warning, AIS/CPA risk, and arrival
   after dark.
6. Human notes and decision acknowledgements attached to cards, route legs, or
   positions.
7. Export of a voyage interval with structured events plus clearly labeled
   generated comments.
8. Golden scenarios that prove no LLM text can create facts, stale data remains
   visible, and low-confidence tide/current output stays advisory.

## Suggested Implementation Boundaries

The live board is canonical for exact task ownership. This contract recommends
these future namespaces so Watchmate does not collide with existing epics:

- `backend/watchmate.py` or `backend/watchmate/` for journal APIs and summary
  orchestration.
- `web/watchmate.js` for the timeline panel and card rendering.
- `web/watchmate.css` or the post-SHELL style fragment namespace
  `helm-watchmate-*` for UI styles/layers.
- `engine` changes only when a future task explicitly needs new source events
  from the boat server. Watchmate should first consume existing streams.
- `~/.helm` or `HELM_USER_DATA_ROOT` for local voyage records.

Do not edit `web/index.html` or `web/style.json` for Watchmate until the live
board says the SHELL registration/seam work needed for this task is available
and the Watchmate task owns that integration.

## Dependency Map

Watchmate consumes existing Helm work rather than replacing it:

- ROUTE: active leg, waypoint, route progress, XTE, ETA/TTG, route selection.
- WX: forecast time scrubber, route-weather ribbon, forecast age, model spread.
- TIDES: tide/current source resolver, datum/station confidence, pass estimates.
- AIS: targets, CPA/TCPA, risk tiers, SART/DSC and lost-target state.
- ALARM: reliable alarm lifecycle, user acknowledgements, alarm history.
- AI: source-tagged context, cited destination/deep-read dossier primitives,
  generated-comment helpers, RAG/research, LLM provider plumbing, offline mode,
  and advise-don't-act guardrails. User-facing passage timelines, watchkeeper
  advisories, handoff summaries, logbook, and forecast-diff voyage windows are
  Watchmate product scope.
- CONTRACT: stream staleness, channels, source tags, reliable alarms.

If a required source does not expose structured facts yet, Watchmate should file
or depend on the owning epic instead of scraping UI text.

## Acceptance Checklist For WATCHMATE-1

A future agent can start WATCHMATE-2 when this checklist is true:

- Event taxonomy is defined for route, ownship, weather, tide/current, AIS,
  alarms, human notes, decisions, and generated comments.
- Card types are defined and distinguish facts, forecasts, advisories, notes,
  decisions, and generated comments.
- Every record requires source, freshness, confidence, timestamps, and a why or
  provenance path.
- Time horizons are explicit and include immediate watch, handoff, active leg,
  next decision window, passage horizon, and archive.
- Retention and export keep structured facts, generated comments, and human
  notes separable.
- Advise-don't-act guardrails are explicit.
- LLM output is clearly commentary over structured events, not authority.
- Dependencies on ROUTE, WX, TIDES, AIS, ALARM, AI, and CONTRACT are named.
- The contract preserves Helm's local-first, supplemental, stale-data-honest
  architecture.
