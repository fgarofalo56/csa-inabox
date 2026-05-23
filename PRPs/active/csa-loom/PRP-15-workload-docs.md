# PRP-15 — Workload Parity Documentation

## Context

For each Fabric workload (and Fabric-only capability), one
documentation page in `docs/fiab/workloads/` explains: what Fabric
does, what Loom delivers, the honest gaps, the per-boundary
behavior, the forward-migration path.

PRD ref: `temp/fiab-prd/05-workload-parity.md` (the source content);
`temp/fiab-prd/02-brand-positioning.md` §2.3.1 (the IA).

## Goal

10 workload pages produced under `docs/fiab/workloads/`. Plus the
`docs/fiab/parity-matrix.md` summary page filled with the keystone
parity table from PRD §5.15.

## Acceptance criteria

- [ ] `docs/fiab/workloads/onelake-parity.md`
- [ ] `docs/fiab/workloads/data-engineering.md`
- [ ] `docs/fiab/workloads/data-warehouse.md`
- [ ] `docs/fiab/workloads/data-science.md`
- [ ] `docs/fiab/workloads/real-time-intelligence.md`
- [ ] `docs/fiab/workloads/data-activator-parity.md`
- [ ] `docs/fiab/workloads/data-agents-parity.md`
- [ ] `docs/fiab/workloads/mirroring-parity.md`
- [ ] `docs/fiab/workloads/direct-lake-parity.md`
- [ ] `docs/fiab/workloads/copilot-parity.md`
- [ ] `docs/fiab/workloads/fabric-iq-family.md` (v2 preview note)
- [ ] `docs/fiab/parity-matrix.md` filled from PRD §5.15
- [ ] Each page uses CSA Loom brand throughout (per AMENDMENTS A1)
- [ ] Each page is honest about gaps (esp. Direct Lake sub-second,
  GCC F-SKU prohibition)
- [ ] Each page links to: the relevant PRP (build PRP), the relevant
  tutorial (PRP-20), the relevant compliance note (PRP-18), the
  relevant example (PRP-14)

## Validation gates

- `mkdocs build --strict` clean
- Every page has a hero image
- Every page renders correctly in both light and dark theme
- Every workload mentioned in PRD §5 has a page
- Parity matrix page renders the full table from PRD §5.15

## Implementation outline

Each page follows the structure:
1. What Fabric does (1-2 paragraphs; cite Fabric docs)
2. Loom parity design (architecture diagram + brief implementation
   notes)
3. Honest gaps (what we can't match; why)
4. Per-boundary notes (Commercial / GCC / GCC-High / IL5)
5. Forward migration to Fabric (when Fabric Gov GA arrives)
6. Related: PRPs / tutorials / runbooks / examples

## File changes

11 page files under `docs/fiab/workloads/` + the parity matrix page.

## References

- `temp/fiab-prd/05-workload-parity.md` (full content basis)
- `temp/fiab-research/03-fabric-only-internals.md` (deep technical
  references)
- `temp/fiab-research/01-fabric-capability-surface.md` (Fabric
  reference)
