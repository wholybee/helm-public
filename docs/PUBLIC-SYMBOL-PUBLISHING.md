# Public Symbol Publishing

Helm's symbol work should be published as a living clean-room package that can
be repaired, regenerated, reviewed, and mirrored continuously.

The private repository remains the canonical source of truth. The public
repository receives a sanitized package that outside users can browse, clone,
test, and review.

## Published Package

The public symbol package should contain:

- A symbol registry in JSON or JSON Lines form.
- A portable SQLite database for local inspection and tooling.
- A schema or schema notes for the registry and database.
- Helm-owned SVG assets.
- Day, dusk, and night palette variants.
- Render recipes and palette tokens.
- S-57, S-52, and S-101 evidence summaries.
- Runtime gate status and blocker reasons.
- A source-boundary document explaining what is and is not copied.
- A static proof browser.

Large generated media can be published outside git history when needed, such as
through a release artifact or hosted page artifact.

## Static Review Site

The public repository should host a static review site with GitHub Pages.

The site should load public-safe JSON data and show:

- Every symbol row.
- Helm day, dusk, and night output.
- OpenCPN comparison evidence where available.
- S-101 evidence or trace output where available.
- S-57 and S-52 mapping evidence.
- Runtime eligibility status.
- Blocker and remediation fields.
- Provenance and source-boundary notes.

GitHub Pages is suitable for this because the review page can be static HTML,
CSS, JavaScript, SVG, JSON, and generated image assets.

GitHub Pages should not be treated as the canonical write path. A static page
can let reviewers export a JSON review file, open an issue, or prepare a pull
request, but canonical approvals should be imported back through the private
review workflow and regenerated from the database.

The durable intake loop is documented in
[PUBLIC-SYMBOL-FEEDBACK.md](PUBLIC-SYMBOL-FEEDBACK.md). Public feedback creates
normalized review artifacts only; it does not mutate canonical art, the private
database, or runtime eligibility.

## Update Pipeline

The public site should update automatically when the public mirror updates.

Recommended flow:

```text
private repair PR
  -> regenerate registry, database, SVGs, and proof data
  -> run proof gates
  -> merge private source ref
  -> publish sanitized public mirror
  -> public CI builds static review site
  -> GitHub Pages deploys the latest proof browser
```

This means repaired symbols become visible publicly through the same normal
pipeline as every other code change.

## Local Setup For Reviewers

The public repository should let outside reviewers run the package locally:

```text
clone public repository
  -> install documented dependencies
  -> run symbol package validation
  -> serve the static proof page
  -> inspect registry/database/SVGs
```

Reviewers should be able to test the symbol package without access to private
chart data or private runtime state.

## Data Products

The public package should prefer these forms:

- `symbols.jsonl` for diffs and review.
- `symbols.json` for browser loading.
- `symbols.sqlite` for local queries and tooling.
- `manifest.json` for package metadata and hashes.
- `coverage.json` for proof coverage.
- `missing-hard-pile.json` for rows requiring repair or human judgment.

The browser should use JSON. The SQLite database is for local tools,
chartplotter integration tests, and implementers who want to query the contract
directly.

## Public Review Intake

Outside feedback should be structured. Good public review artifacts include:

- A GitHub issue for one symbol or a small related set.
- A pull request containing review JSON.
- A generated review-export file from the static page.
- A screenshot with symbol ID, palette, and evidence context.

The static page stores decisions in the reviewer's browser first. Reviewers then
use the per-symbol `Report this symbol` link, the feedback dashboard's GitHub
issue link, or the JSON download. The public `public-symbol-feedback` workflow
validates those submissions against `proof/site-index.json` and uploads a
normalized artifact for private repair triage.

The public process should never silently change runtime eligibility. Reviews
feed the canonical repair workflow; the regenerated database decides what is
eligible.
