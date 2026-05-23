# PRP-24 — Existing-Content Cross-Link Updates

## Context

The existing csa-inabox content references "Option 3" in
`docs/fabric-in-gov-cloud.md` and has a `docs/comparison/csa-inabox-vs-
fabric.md`. These references need additive callouts pointing to the
new CSA Loom pillar — without rewriting the existing content.

PRD ref: `temp/fiab-prd/02-brand-positioning.md` §2.3.3.

## Goal

Existing csa-inabox content gains additive cross-links + callouts
pointing readers from existing pages to the new CSA Loom pillar.

## Acceptance criteria

- [ ] `docs/fabric-in-gov-cloud.md` — promote Option 3 to "Option 3 —
  Use CSA Loom (the productized form of this recommendation)" with
  a prominent callout block linking to `docs/fiab/index.md`
- [ ] `docs/comparison/csa-inabox-vs-fabric.md` — "See also" footer
  links to new `docs/comparison/csa-loom-vs-fabric.md`
- [ ] `docs/comparison/csa-loom-vs-fabric.md` — NEW sister comparison
  page (CSA Loom vs Microsoft Fabric); modelled on existing csa-inabox-
  vs-fabric.md structure but Loom-specific
- [ ] `docs/adr/0010-fabric-strategic-target.md` — append addendum:
  "Productized as CSA Loom (2026-Q3+); see [`docs/fiab/`](../fiab/)"
- [ ] `docs/reference-architecture/fabric-vs-synapse-vs-databricks.md`
  — add CSA Loom as a 4th column in the comparison matrix
- [ ] `docs/decisions/fabric-vs-databricks-vs-synapse.md` — add CSA
  Loom branch to the decision tree
- [ ] `docs/index.md` (home page) — add CSA Loom callout to the
  pillar list
- [ ] No existing prose is removed — additive only

## Validation gates

- `mkdocs build --strict` clean
- Search for "CSA Loom" returns all 7 updated pages + the new pillar
- No broken links

## File changes

7 existing files modified + 1 new comparison page created.

## References

- `temp/fiab-prd/02-brand-positioning.md` §2.3.3
- Existing files listed above
