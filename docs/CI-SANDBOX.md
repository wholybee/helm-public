# CI sandbox (`helm-ci`)

Helm keeps the canonical source tree on **`StevenRidder/Helm`**. GitHub Actions
are expensive on a **private** origin (especially the macOS engine fresh-clone
smoke, which bills at 10x wall-clock minutes). The **CI sandbox** is a separate
**public** repo with the **full actual Helm tree** and **all** workflows:

| Repo | Role |
|---|---|
| [`StevenRidder/Helm`](https://github.com/StevenRidder/Helm) | Canonical source, PRs, Switchboard merge webhook |
| [`StevenRidder/helm-ci`](https://github.com/StevenRidder/helm-ci) | Public CI sandbox — push branches here first |
| [`StevenRidder/helm-public`](https://github.com/StevenRidder/helm-public) | Sanitized public **mirror** (not CI); see [DEVELOPMENT.md](DEVELOPMENT.md) |

Do **not** use `helm-public` for CI. It is a scrubbed snapshot with a different
tree, rewritten history, and only three workflows. `helm-ci` is deliberately
not scrubbed: it tests the same code tree that will be pushed to `Helm`.

## Workflows on the sandbox

The sandbox runs the same GitHub Actions as Helm:

- `backend-tests`
- `engine-fresh-clone-smoke` (macOS, up to 120 min)
- `helmcxx-runtime-guard`
- `symbol-selection-smoke`
- `web-tests`
- `web-e2e`

Public repos receive **unlimited free** GitHub-hosted Actions minutes.

## One-time setup

From a Helm checkout with `gh` authenticated as a user who can create repos under
`StevenRidder`:

```bash
# If the repo does not exist yet (owner-only; cloud agent tokens often cannot create it):
gh repo create StevenRidder/helm-ci --public \
  --description "Public CI sandbox for Helm - full actual tree, all GitHub Actions workflows"

scripts/ci-sandbox.sh setup
scripts/ci-sandbox.sh refresh-main
```

This creates `StevenRidder/helm-ci` (if needed), adds a git remote named `ci`,
fetches authoritative `origin/main`, and seeds `helm-ci/main`.

## Typical branch loop

```bash
git checkout -b claude/MY-TASK-slug
# ... edit, commit ...

# 1) Prove this checkout can use the sandbox
scripts/ci-sandbox.sh doctor

# 2) Push to helm-ci, wait for green, push exact SHA to Helm,
#    stamp the required Helm status, and open the PR.
scripts/ci-sandbox.sh open-pr claude/MY-TASK-slug

# 3) After merge on Helm, refresh baseline and delete the sandbox branch
scripts/ci-sandbox.sh refresh-main
scripts/ci-sandbox.sh delete claude/MY-TASK-slug
```

Manual equivalent:

```bash
scripts/ci-sandbox.sh push claude/MY-TASK-slug
git push -u origin claude/MY-TASK-slug
scripts/ci-sandbox.sh prove claude/MY-TASK-slug
gh pr create --repo StevenRidder/Helm --fill
```

### Command reference

| Command | Purpose |
|---|---|
| `scripts/ci-sandbox.sh setup` | Create repo + `ci` remote |
| `scripts/ci-sandbox.sh sync-main` | Refresh sandbox `main` from local `main` |
| `scripts/ci-sandbox.sh refresh-main` | Fetch canonical `origin/main`, then sync sandbox `main` |
| `scripts/ci-sandbox.sh doctor [branch]` | Verify tools, repos, remotes, baseline, workflows, and optional branch pushes |
| `scripts/ci-sandbox.sh prove [branch]` | Require exact SHA on `helm-ci` and Helm, then stamp `helm-ci/full-suite` on Helm |
| `scripts/ci-sandbox.sh protect-main` | Configure Helm `main` to require `helm-ci/full-suite` before it can move |
| `scripts/ci-sandbox.sh push [branch]` | Push branch, dispatch all sandbox workflows, wait for the dispatched Actions batch |
| `scripts/ci-sandbox.sh push --no-wait [branch]` | Push and dispatch workflows without waiting |
| `scripts/ci-sandbox.sh push --no-dispatch [branch]` | Push only; rely on normal path-filter triggers |
| `scripts/ci-sandbox.sh wait [branch]` | Wait for in-progress runs |
| `scripts/ci-sandbox.sh status [branch]` | Print recent run conclusions |
| `scripts/ci-sandbox.sh delete [branch]` | Remove branch from sandbox |
| `scripts/ci-sandbox.sh open-pr [branch]` | Push to sandbox, wait for green CI, push to Helm, open PR |

Environment overrides: `CI_REPO`, `CI_REMOTE`, `CANONICAL_REPO`,
`ORIGIN_REMOTE`, `WAIT_TIMEOUT_SEC` (default 7200), `MAIN_REF` (default
`origin/main` for `sync-main`), `SANDBOX_WORKFLOWS` (space-separated workflow
file list), and `SANDBOX_WAIT_EVENT` for manual `wait`/`status` event
filtering. `STATUS_CONTEXT` defaults to `helm-ci/full-suite`; branch protection
requires that status context.

By default, `push` treats the explicit `workflow_dispatch` batch as the
authoritative sandbox CI suite. GitHub may also start duplicate push-triggered
jobs for the same SHA; those are useful signal, but they are not the gate for
the full-tree sandbox path unless you run `push --no-dispatch` or wait manually.

After a green dispatched suite, `prove` stamps the required status back on the
canonical Helm commit. GitHub branch protection on Helm `main` requires this
status. That is the mechanical guard: if an agent skips public `helm-ci`, the
Helm PR cannot merge.

## Switchboard agents

The private planning board coordinates tasks; it does **not** run GitHub Actions.
The merge webhook on **`StevenRidder/Helm`** still marks tasks Done
(`github_pr_merged`).

Agent flow:

1. Claim task on Switchboard.
2. Run `scripts/ci-sandbox.sh doctor` and fix any failures.
3. Run `scripts/ci-sandbox.sh open-pr <branch>`.
4. Confirm the Helm PR shows the required `helm-ci/full-suite` status.
5. Call `complete_claim` with the **Helm** PR URL (not the sandbox) and include the `helm-ci` Actions URL.
6. After merge, run `scripts/ci-sandbox.sh refresh-main`, then `scripts/ci-sandbox.sh delete <branch>`.

Add the sandbox Actions URL to a task comment when helpful:

```text
https://github.com/StevenRidder/helm-ci/actions?query=branch%3A<branch>
```

## Keeping sandbox `main` current

After merging to Helm `main`, refresh the sandbox baseline:

```bash
scripts/ci-sandbox.sh refresh-main
```

`refresh-main` fetches canonical `origin/main` and pushes that exact commit to
`helm-ci/main`; it does not require checking out `main`. Optional: run this from
a post-merge hook or scheduled job on a trusted machine.

## Private Helm origin

While `Helm` is public, Actions minutes are already free on both repos. The
sandbox pattern matters when `Helm` is **private** again: run heavy CI on
`helm-ci`, keep PR review on `Helm`, and optionally narrow which workflows run
on private PRs to avoid double-billing.

## Security notes

- The sandbox receives the **full actual** git tree (not the sanitized
  `helm-public` export). This is intentional so CI tests real code.
- Delete sandbox feature branches after merge so stale code does not linger on a
  public repo.
- `helm-ci` is intentionally **not** wired to Switchboard; only `Helm` PR
  merges close tasks.
