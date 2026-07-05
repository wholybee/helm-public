# Public Symbol Feedback Loop

The public symbol catalog is a static GitHub Pages site. It can collect review
decisions in the reviewer's browser and help create GitHub issues, but it cannot
and must not write directly into Helm's private canonical symbol database.

The feedback loop is:

```text
GitHub Pages review decision
  -> exported JSON or public GitHub issue
  -> public-symbol-feedback GitHub Action
  -> normalized feedback artifact
  -> private Helm repair queue / Switchboard triage
  -> canonical SVG/DB repair
  -> regenerated public package
  -> public mirror and GitHub Pages update
```

## Reviewer Path

1. Open the public catalog page.
2. Click a symbol.
3. Choose `Approve`, `Needs work`, or `Reject`.
4. Add a short note that says what is wrong or what should be preserved.
5. Use either:
   - `Report this symbol` for one symbol, or
   - `Feedback dashboard` for a batch.

The review page stores decisions in browser `localStorage` until the reviewer
exports them or opens a GitHub issue.

## Public Issue Format

The page opens a GitHub issue containing machine-readable JSON:

```json
{
  "schema": "helm.forge.public_review_decisions.v1",
  "site_schema": "helm.forge.public_symbol_catalog.v1",
  "count": 1,
  "decisions": [
    {
      "symbol_id": "BOYCAN60",
      "family": "BOYCAN",
      "decision": "needs_work",
      "notes": "Dot is too low; waterline missing.",
      "current_helm_art": "assets/svg/canonical/BOYCAN60.svg",
      "symbol_url": "https://stevenridder.github.io/helm-public/?symbol=BOYCAN60"
    }
  ]
}
```

Valid decisions are:

- `approve`
- `needs_work`
- `reject`

## CI Normalization

The public repo workflow `.github/workflows/public-symbol-feedback.yml` runs on
symbol-feedback issues and manual dispatches. It calls:

```bash
python3 scripts/normalize-symbol-feedback.py \
  --site-index pipeline/iconforge/public/proof/site-index.json \
  --input symbol-feedback-input.md \
  --output-dir symbol-feedback-artifact
```

The parser:

- extracts JSON from an exported file or fenced issue body;
- validates every `symbol_id` against `proof/site-index.json`;
- rejects malformed JSON, unknown symbol IDs, and invalid decisions;
- writes `symbol-feedback-normalized.json`;
- writes `symbol-feedback-normalized.jsonl`;
- uploads those files as the `symbol-feedback-normalized` artifact.

If the public repository is configured with a private import token, the workflow
also sends a `repository_dispatch` event:

```text
event_type: symbol_feedback_normalized
target repo: $HELM_PRIVATE_REPO, default StevenRidder/Helm
token secret: HELM_PRIVATE_FEEDBACK_TOKEN
payload: symbol-feedback-normalized.json
```

If `HELM_PRIVATE_FEEDBACK_TOKEN` is absent, the workflow skips the dispatch and
leaves the normalized artifact for manual/private import.

## Private Repair Import

The normalized artifact is input to private Helm triage. It should be imported
into Switchboard or the private repair queue as review evidence. It is not an
approval gate by itself.

Public feedback must never directly:

- replace a canonical SVG;
- edit the private symbol database;
- mark a runtime export row as eligible;
- change owner final approval state;
- hide a red/yellow proof gate.

An agent repairing feedback should record:

- source issue URL;
- normalized artifact hash or workflow run;
- affected symbol IDs;
- repaired private branch/PR;
- regenerated public package proof;
- public mirror SHA after publish.

## Maintainer Closeout

After a private repair lands and the public mirror republishes, comment on the
original public issue with the new public link:

```text
Fixed in public catalog build <sha>.
Review: https://stevenridder.github.io/helm-public/?symbol=BOYCAN60
```

If the feedback is intentionally rejected, comment with the reason and leave the
canonical symbol unchanged.
