# PRP-01 — CSA Loom Pillar Foundation

## Context

CSA Loom is a new top-nav pillar on csa-inabox that delivers a
Microsoft Fabric parity layer for Azure tenants where Fabric isn't yet
available. The pillar needs a docs scaffold, hero assets, and nav slot
before any other PRPs land content.

PRD ref: `temp/fiab-prd/02-brand-positioning.md`,
`temp/fiab-prd/AMENDMENTS.md` §A1.

## Goal

`docs/fiab/` (repo-internal nickname; customer-facing brand: CSA Loom)
exists with landing page, IA scaffold, hero assets, and a working
mkdocs nav tab. Foundation content (overview, what-is, whitepaper
skeleton, parity matrix scaffold, reference architecture skeleton)
in place as placeholder pages ready to be filled by PRP-15 and others.

## Acceptance criteria

- [ ] `mkdocs.yml` has new top-nav tab "CSA Loom" pointing at
  `docs/fiab/index.md`
- [ ] `docs/fiab/` folder exists with 7 foundation pages:
  - `index.md` (pillar landing)
  - `what-is-csa-loom.md`
  - `whitepaper.md` (skeleton + outline)
  - `parity-matrix.md` (table structure ready; rows filled by PRP-15)
  - `architecture.md` (high-level diagram + sections)
  - `deployment/index.md` (sub-section landing)
  - `workloads/index.md` (sub-section landing)
- [ ] Pillar hero SVG at `docs/assets/images/hero/fiab/index.svg`
  rendered via existing `relocate_architecture_hero.py` hook
- [ ] All pages render in `mkdocs serve` without errors
- [ ] All pages use CSA Loom brand (per AMENDMENTS A1); no
  customer-facing "Fabric-in-a-Box" text anywhere
- [ ] All pages comply with [[writing-voice-no-customer-framing]] —
  CDO instructive voice; no customer framing

## Validation gates

- `mkdocs build --strict` clean
- Hero image renders correctly on landing page (visual check)
- Search returns CSA Loom + parity matrix results
- Top-nav shows the new tab as #6 (between "Use Cases & White Papers"
  and "Operate")

## Implementation outline

1. Edit `mkdocs.yml`:
   - Insert "CSA Loom" tab at slot 6 per the IA in
     `temp/fiab-prd/02-brand-positioning.md` §2.3.1
   - Add new heroes to `docs/hooks/relocate_architecture_hero.py`
     `_SECTION_DEFAULTS` dict (key `fiab/`)
2. Author hero SVG following existing `hero/` SVG conventions
   (saturated brand fills, white text; honors [[mermaid-dark-mode-pattern]])
3. Create the 7 foundation pages with structured headings + brief
   placeholder content (≤100 lines each); pages will be filled by
   later PRPs
4. Cross-link from `docs/fabric-in-gov-cloud.md` Option 3 to CSA Loom
   landing page (per PRP-24)
5. Cross-link from `docs/comparison/csa-inabox-vs-fabric.md` "See also"
   to CSA Loom (per PRP-24)

## File changes

```
mkdocs.yml                                        modified
docs/hooks/relocate_architecture_hero.py          modified
docs/fiab/index.md                                created
docs/fiab/what-is-csa-loom.md                     created
docs/fiab/whitepaper.md                           created
docs/fiab/parity-matrix.md                        created
docs/fiab/architecture.md                         created
docs/fiab/deployment/index.md                     created
docs/fiab/workloads/index.md                      created
docs/assets/images/hero/fiab/index.svg            created
docs/assets/images/hero/fiab/deployment/index.svg created
docs/assets/images/hero/fiab/workloads/index.svg  created
```

## Open questions / risks

- Brand-review timing (per AMENDMENTS A1): if Microsoft legal returns
  blocking opinion on "CSA Loom" within 30 days, this PRP's pages need
  brand re-name. Fallback brand: TapestryOne. Submit brand for review
  same week this PRP opens.

## References

- `temp/fiab-prd/02-brand-positioning.md`
- `temp/fiab-prd/AMENDMENTS.md` §A1
- Existing pattern: `docs/research/api-first-data-strategy-whitepaper.md`
- Memory: [[csa-inabox-docs-pattern]], [[hero-above-h1-hook]],
  [[mermaid-dark-mode-pattern]], [[writing-voice-no-customer-framing]]
