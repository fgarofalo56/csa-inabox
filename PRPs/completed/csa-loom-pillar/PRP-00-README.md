# PRP Set — CSA Loom (repo-internal: fiab)

This folder contains the v1 PRP decomposition for CSA Loom, the
Cloud Scale Analytics platform that delivers a Microsoft Fabric
equivalent experience inside any Azure tenant where Fabric isn't
yet available.

Brand note: **CSA Loom** is the public brand. **FiaB** is a
repo-internal nickname (file names, code identifiers, working
docs). Customer-facing copy uses CSA Loom throughout.

## Source documents

- PRD: `temp/fiab-prd/00-README.md` through `13-build-plan-prps.md`
- Amendments (decisions locked 2026-05-22): `temp/fiab-prd/AMENDMENTS.md`
- Research wave outputs: `temp/fiab-research/01-*.md` through `07-*.md`

## v1 PRPs (active)

| # | Title | Wave | Effort |
|---|---|---|---|
| PRP-01 | CSA Loom pillar foundation (docs scaffold + nav slot) | 0 | 3w |
| PRP-02 | Platform Bicep + ESLZ reuse + per-boundary params | 1 | 5w |
| PRP-03 | Loom Console (Next.js + Fluent UI v9 + 8 panes for v1) | 1 | 10w |
| PRP-04 | Loom Setup Wizard (two-tier orchestration) | 2 | 6w |
| PRP-05 | Self-hosted Azure MCP server | 1 | 3w |
| PRP-06 | Loom Activator Engine (NRules + Redis + Function dispatcher) | 2 | 6w |
| PRP-07 | Loom Mirroring Engine (Debezium + Spark + Delta MERGE) | 2 | 8w |
| PRP-08 | Loom Direct-Lake Shim (Event Grid → TOM partition refresh) | 2 | 4w |
| PRP-09 | Loom Data Agents (extend apps/copilot with NL2SQL/DAX/KQL) | 2 | 5w |
| PRP-11 | Per-boundary deploy validation workflows (reduced scope: no Marketplace) | 3 | 1w |
| PRP-12 | Catalog two-track wiring (UC managed + Purview Commercial; Purview Gov) | 2 | 5w |
| PRP-13 | Defender AI Threat Protection workaround (Sentinel pipeline) | 2 | 2w |
| PRP-14 | Industry examples port wave 1 (8 examples) | 4 | 8w |
| PRP-15 | Workload parity documentation | 4 | 4w |
| PRP-16 | Deployment documentation | 4 | 3w |
| PRP-17 | Operations docs + runbooks | 4 | 3w |
| PRP-18 | Compliance docs (per-boundary + Defender AI workaround) | 4 | 3w |
| PRP-19 | ADRs (12 architectural decision records) | 0 | 2w |
| PRP-20 | Tutorials (8 step-by-step pieces) | 4 | 3w |
| PRP-21 | Marketing kit (pitch deck + playbook + demo + videos + battlecard) | 4 | 4w |
| PRP-22 | 5-day workshops — Federal CoE + Commercial CoE (both day-one) | 4 | 7w |
| PRP-23 | Use-case pages (5 CSA Loom-specific use cases) | 4 | 2w |
| PRP-24 | Existing-content cross-link updates | 4 | 1w |
| PRP-25 | Solution-store entry | 4 | 1w |

## Backlog (post-v1.1)

| # | Title | Why deferred |
|---|---|---|
| PRP-10 | Marketplace Managed App package | OQ-10/OQ-4 (pricing model) deferred to backlog |
| PRP-101 | IL5 Marketplace publishing | v1.1 |
| PRP-102 | UC managed Gov promotion track | v1.1 |
| PRP-103 | Power BI Embedded Console panes | v1.1 |
| PRP-104 | Forward migration tooling (fiab-migrate CLI) | v1.1 |
| PRP-105 | Industry examples port wave 2 (17 remaining) | v1.1 |
| PRP-106 | Workshop variants (state/local + CMMC) | v1.1 |
| PRP-107 | Operations Agent (Loom Ops Copilot) | v1.1 |
| PRP-108 | Mirroring source expansion (Open Mirroring SDK + partners) | v1.1 |
| PRP-201 | Fabric IQ family parity (Ontology / Graph / Plan / Maps) | v2 |
| PRP-202 | HorizonDB-equivalent (Postgres-in-Loom) | v2 |
| PRP-203 | Operations Agent + Plan execution | v2 |

## Wave schedule

- **Wave 0** (weeks 1-3): PRP-01 + PRP-19. Foundation; field can begin marketing.
- **Wave 1** (weeks 2-12): PRP-02 + PRP-03 + PRP-05. Internal demo-ready.
- **Wave 2** (weeks 8-18): PRP-04 + PRP-06 + PRP-07 + PRP-08 + PRP-09 + PRP-12 + PRP-13. Customer demo-ready.
- **Wave 3** (weeks 14-20): PRP-11. Deploy validation operational.
- **Wave 4** (weeks 4-22): PRP-14, 15, 16, 17, 18, 20, 21, 22, 23, 24, 25. Content complete.

Total v1 effort: ~85 engineer-weeks; parallelizable to ~20 calendar
weeks with 5 engineers.

## How to use these PRPs

Each PRP follows the standard template (`Context`, `Goal`,
`Acceptance criteria`, `Validation gates`, `Implementation outline`,
`File changes`, `Open questions / risks`, `References`).

Pick a PRP, claim ownership in your tracking system (GitHub Issue
labeled `csa-loom` + `prp-NN`), execute against acceptance criteria,
PR back into main when validation gates pass.
