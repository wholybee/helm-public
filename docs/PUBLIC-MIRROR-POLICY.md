# Public Mirror Policy

Helm should publish as much source code as possible while keeping private data,
private planning material, and non-redistributable assets out of the public
repository.

The public repository is a sanitized mirror of the private development tree. It
is not a separate hand-maintained fork. Public releases should be generated from
a known private source ref by an automated sanitizer, then verified after push.

## Publish by Default

The public mirror may include:

- Helm runtime source code.
- C++ services, native shells, and render experiments.
- Browser client code, WebGPU code, style layers, and tests.
- Weather grid contracts, pack readers, renderers, and public-safe fixtures.
- Vulkan proof code, render fixtures, and conformance tests.
- Clean-room symbol registry, recipes, schemas, proof pages, and owned SVGs.
- Public-safe documentation, architecture notes, and setup guides.
- Small sample data that is explicitly public-safe and documented as sample data.

The public mirror should make the real system understandable. Code should not be
kept private merely because it is early, incomplete, or still changing. Early
work can be labeled experimental, but hiding the implementation makes outside
review weaker.

## Exclude by Default

The public mirror must not include:

- Private chart packs, cached tiles, basemaps, or user data.
- Private ENC, S-63, oeSENC, or other restricted chart material.
- Local runtime state or user-specific configuration.
- Secrets, keys, tokens, private hostnames, or private machine paths.
- Private planning, business, or internal coordination documents.
- Copied standards catalogues, copied OpenCPN artwork, or other assets whose
  redistribution rights are not clear.
- Generated bulk media unless it is intentionally published as a public artifact.

The rule is simple: source code and clean-room outputs are public-safe when they
do not carry private data or copied third-party assets. Runtime data, private
operator state, and questionable redistribution material stay out.

## Clean-room Symbol Policy

The clean-room symbol package is part of the public mirror.

Public symbol artifacts may include:

- Stable Helm symbol identifiers.
- S-57, S-52, and S-101 evidence summaries.
- Helm-owned SVG assets.
- Render recipes.
- Palette variants.
- Runtime eligibility gates.
- Blocker reasons and remediation status.
- Public proof pages showing comparison evidence.
- Public feedback artifacts that reference symbol ids and review notes.

Public symbol artifacts must not include copied IHO catalogue files, copied IHO
SVG assets, copied OpenCPN rasters, copied OpenCPN SVG wrappers, private chart
data, or private generated chart products.

OpenCPN and S-101 evidence can be used as comparison and standards evidence.
They must not become the owned source artwork for Helm.

Public feedback issues and normalized review artifacts are advisory inputs. They
must not directly update canonical private SVG/database rows or runtime
eligibility; those changes happen only through the private repair and
regeneration pipeline.

## Runtime Claims

The public mirror may show proof work before runtime promotion is complete, but
it must keep runtime claims fail-closed.

Allowed language:

- "This row is present in the proof package."
- "This row has comparison evidence."
- "This row has a Helm-owned render recipe."
- "This row is blocked from runtime export until gates pass."

Avoid language that implies regulatory or navigational approval unless the
appropriate runtime and safety gates actually pass.

## Continuous Publication

Each private change that repairs symbols, improves rendering, or updates runtime
contracts should follow the same path:

1. Change the private source of truth.
2. Regenerate public-safe artifacts.
3. Run tests and proof gates.
4. Merge to the private main branch.
5. Run the sanitizer from that exact source ref.
6. Push the sanitized snapshot to the public mirror.
7. Verify public files, public docs, and hosted pages.

The public mirror is therefore a living view of Helm, not a one-time export.
