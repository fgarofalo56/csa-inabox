# PRP-25 — Solution-Store Entry

## Context

The repo's solution-store pattern (per [[api-first-data-strategy-
pillar]]) provides a curated catalog of buildable accelerators.
CSA Loom gets its own solution-store entry.

PRD ref: `temp/fiab-prd/02-brand-positioning.md` §2.3.4.

## Goal

`docs/solution-store/csa-loom/index.md` exists per the
[[api-first-data-strategy-pillar]] template, surfacing CSA Loom as a
deployable accelerator from the solution-store landing page.

## Acceptance criteria

- [ ] `docs/solution-store/csa-loom/index.md` page exists with:
  - Hero image
  - 1-2 paragraph description (CDO voice; CSA Loom brand)
  - Architecture diagram (sourced from PRP-15 / PRD §4.1)
  - GitHub deploy path: link to `platform/fiab/azd/`
  - Quickstart link: `docs/fiab/deployment/quickstart.md`
  - Cost calculator (Bicep-derived; sample monthly cost per capacity
    SKU)
  - "Coming after v1.1: Marketplace listing" footer note (per
    AMENDMENTS A4)
- [ ] `docs/solution-store/index.md` (the existing landing page)
  updated to include CSA Loom as a grid card alongside the
  API-First Accelerators card
- [ ] mkdocs nav updated to include the solution-store entry under
  Use Cases & White Papers > Solutions

## Validation gates

- `mkdocs build --strict` clean
- Grid card renders correctly in light + dark
- All links resolve

## Implementation outline

1. Create `docs/solution-store/csa-loom/index.md`
2. Modify `docs/solution-store/index.md` to add the grid card
3. Update `mkdocs.yml` if not already covered by PRP-01

## File changes

```
docs/solution-store/csa-loom/index.md                    created
docs/solution-store/index.md                             modified
mkdocs.yml                                                modified (already done in PRP-01 if covered)
```

## References

- `temp/fiab-prd/02-brand-positioning.md` §2.3.4
- Existing `docs/solution-store/` (template via [[api-first-data-
  strategy-pillar]])
