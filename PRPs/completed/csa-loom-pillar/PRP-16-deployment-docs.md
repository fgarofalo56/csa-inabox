# PRP-16 — Deployment Documentation

## Context

Customer-facing deployment guides for every deployment path + every
boundary. Per AMENDMENTS §A4, Marketplace listing deferred to backlog;
v1 covers azd CLI + Deploy-to-Azure button only.

PRD ref: `temp/fiab-prd/07-deployment.md`; `temp/fiab-prd/02-brand-
positioning.md` §2.3.1.

## Goal

Customer can deploy CSA Loom into their tenant by following step-by-
step docs under `docs/fiab/deployment/`. Per-boundary nuances clearly
documented.

## Acceptance criteria

- [ ] `docs/fiab/deployment/index.md` — landing page with the three
  paths (Quick Start / azd CLI / Deploy-to-Azure)
- [ ] `docs/fiab/deployment/quickstart.md` — 60-minute path (Commercial)
- [ ] `docs/fiab/deployment/azd-cli.md` — full power-user walkthrough
- [ ] `docs/fiab/deployment/deploy-button.md` — Azure portal button
  walkthrough
- [ ] `docs/fiab/deployment/commercial.md` — Commercial-specific
  prereqs + post-install checklist
- [ ] `docs/fiab/deployment/gcc.md` — GCC notes (M365 GCC tenant + Azure
  Commercial subs; F-SKU prohibition; Direct Lake unavailable)
- [ ] `docs/fiab/deployment/gcc-high.md` — GCC-High notes (Azure Gov;
  Container Apps→AKS dispatch; Purview-primary; AOAI Gov region)
- [ ] `docs/fiab/deployment/multi-sub-multi-tenant.md` — production
  pattern: DMZ in sub-A; per-domain DLZs in sub-B, sub-C, ...
- [ ] `docs/fiab/deployment/upgrade.md` — how to upgrade an existing
  Loom install (azd up re-run; per-component release notes)
- [ ] Marketplace page placeholder: `docs/fiab/deployment/marketplace.md`
  with "Coming after v1.1 — see [pricing roadmap]" callout
- [ ] All pages comply with [[writing-voice-no-customer-framing]]
- [ ] All pages use CSA Loom brand

## Validation gates

- `mkdocs build --strict` clean
- Each step in quickstart actually works against staging Commercial
- Per-boundary commands actually work (validated by PRP-11 nightly
  workflows)

## Implementation outline

Page-by-page authoring. Each page is action-oriented (commands,
screenshots, expected outputs). Per-boundary pages cite the
`.bicepparam` files from PRP-02 and the dispatch matrix from PRD §4.3.

## File changes

10 pages under `docs/fiab/deployment/` + supporting screenshots.

## References

- `temp/fiab-prd/07-deployment.md`
- `temp/fiab-research/02-gov-boundary-availability.md`
- `temp/fiab-prd/AMENDMENTS.md` §A4
