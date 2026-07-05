# OpenCPN Core Symbol Integration

It should be possible to use Helm's clean-room symbol package inside OpenCPN,
but it should be done as a narrow adapter, not as a wholesale engine replacement.

The practical target is:

```text
OpenCPN chart object and portrayal context
  -> Helm-compatible symbol contract adapter
  -> Helm clean-room registry, recipe, palette, and runtime gate
  -> OpenCPN drawing backend or optional experimental renderer
```

That makes the symbol package portable without forcing OpenCPN to adopt Helm's
whole runtime architecture.

## What Can Be Replaced Surgically

The most realistic surgical replacements are:

- Symbol selection rules for a bounded class of chart objects.
- Symbol lookup from object class and attributes.
- Palette-token mapping for day, dusk, and night.
- SVG or vector symbol loading.
- Atlas generation.
- Proof and comparison harnesses.
- Runtime eligibility gates.

This is the layer where Helm's database and clean-room registry are most useful.
OpenCPN could call into an adapter that answers: given this object, attributes,
display mode, and chart context, which symbol recipe is eligible and how should
it be drawn?

## What Should Not Be Replaced First

The following are not good first targets for a surgical integration:

- OpenCPN's entire chart renderer.
- OpenCPN's whole display-priority and decluttering model.
- OpenCPN's safety behavior.
- OpenCPN's chart ingestion pipeline.
- Helm's full Vulkan backend as a drop-in replacement.

Those areas have wider consequences and need separate design work. The symbol
package should prove itself at the boundary first.

## Feature-Flag Path

An upstreamable OpenCPN integration should be feature-flagged.

Recommended posture:

- Existing OpenCPN rendering remains the default.
- Helm clean-room symbols are loaded only when the experimental flag is enabled.
- The adapter fails closed when a row lacks proof or runtime eligibility.
- Existing OpenCPN assets remain the fallback when the flag is disabled.
- Test fixtures compare current OpenCPN output against Helm clean-room output.
- No copied Helm-private data is required.

This lets maintainers review the behavior without accepting a risky all-or-none
change.

## Adapter Contract

The adapter should consume public Helm data, not private workflow state.

Inputs:

- S-57 object class or S-101 feature type.
- Object attributes.
- Display category and scale context.
- Palette mode: day, dusk, night, or compatible OpenCPN mode.
- Optional chart/render context needed for rule evaluation.

Outputs:

- Symbol ID.
- Shape family or asset reference.
- Palette tokens.
- Stroke/fill recipe.
- Anchor and orientation behavior.
- Runtime eligibility result.
- Blocker reason when not eligible.

The adapter must not select a symbol from filenames alone. It should select from
the normalized semantic contract: object class, attributes, rule evidence,
recipe, palette, and proof gate.

## Licensing And Contribution Boundary

OpenCPN core uses a different project process and license posture than Helm.
Any integration intended for OpenCPN core must be prepared as an OpenCPN
contribution, with compatible licensing and no hidden dependency on private Helm
state.

The public package should be sufficient for review:

- Public registry.
- Public schemas.
- Public owned assets.
- Public proof site.
- Public local setup instructions.
- Public source-boundary document.

The integration should not require copied IHO catalogue files, copied OpenCPN
rasters, copied OpenCPN SVG wrappers, private chart data, or private Helm
workflow artifacts.

## Recommended First Milestone

The first OpenCPN-facing milestone should be a standalone proof harness:

```text
load public Helm symbol package
  -> read OpenCPN-style object and attribute fixtures
  -> resolve Helm symbol recipe
  -> render day/dusk/night output
  -> compare against OpenCPN reference output
  -> report pass, acceptable deviation, blocked, or needs repair
```

After that harness is credible, an OpenCPN core patch can be proposed behind an
experimental flag.

## Bottom Line

Replacing OpenCPN's current icons with Helm's clean-room symbols is possible in
principle.

Replacing OpenCPN's whole engine with Helm's engine is not the right first
move.

The durable path is to make the Helm symbol database and renderer contract
portable, public, testable, and feature-flagged. If the proof package is strong,
OpenCPN can consume the symbol layer without inheriting Helm's entire runtime.
