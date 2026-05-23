# PRP-19 — Architectural Decision Records (12 ADRs)

## Context

Per the existing csa-inabox ADR pattern (`docs/adr/0001-...md`
through `0026-...md`), CSA Loom needs its own ADR series capturing
the 12 architectural decisions locked in AMENDMENTS.

PRD ref: `temp/fiab-prd/02-brand-positioning.md` §2.3.1 (the IA);
`temp/fiab-prd/AMENDMENTS.md` (the locked decisions).

## Goal

12 ADRs under `docs/fiab/adr/` documenting Loom's architectural
decisions. Each ADR is short (one page), reasoned, and references the
PRD + research files.

## Acceptance criteria

- [ ] `docs/fiab/adr/README.md` — ADR index
- [ ] `docs/fiab/adr/0001-fabric-feature-scope.md` — what's in/out
  per release (LD-3)
- [ ] `docs/fiab/adr/0002-compute-hybrid.md` — Databricks + Synapse
  Serverless + ADX (LD-2)
- [ ] `docs/fiab/adr/0003-catalog-layering.md` — UC + Purview overlay
  (Commercial); Purview-primary (Gov-IL4); Atlas at IL5 (LD-8)
- [ ] `docs/fiab/adr/0004-direct-lake-parity.md` — Premium Import +
  warm-cache materializer; honest gap (LD-7)
- [ ] `docs/fiab/adr/0005-activator-engine.md` — ADX + NRules + Redis
- [ ] `docs/fiab/adr/0006-mirroring-engine.md` — Debezium + Spark
  Structured Streaming + Delta MERGE (LD-9)
- [ ] `docs/fiab/adr/0007-console-framework.md` — Next.js + Fluent UI
  v9 + MSAL BFF (LD-5)
- [ ] `docs/fiab/adr/0008-deployment-shape.md` — Two-tier (azd CLI
  + Deploy-to-Azure); Marketplace deferred to backlog (LD-4)
- [ ] `docs/fiab/adr/0009-copilot-orchestration.md` — Two-tier
  (Foundry Agent Service Commercial; MAF + AOAI Gov)
- [ ] `docs/fiab/adr/0010-container-host.md` — Container Apps in
  Commercial / GCC; AKS in GCC-High / IL5
- [ ] `docs/fiab/adr/0011-tenancy-model.md` — DMZ + DLZ + workspace-
  as-data-product (LD-6)
- [ ] `docs/fiab/adr/0012-forward-migration.md` — OneLake shortcut
  zero-copy + hybrid topology first-class (LD-13)
- [ ] Each ADR follows the existing csa-inabox ADR template (Status,
  Context, Decision, Consequences, Alternatives considered,
  References)
- [ ] All ADRs use CSA Loom brand throughout

## Validation gates

- `mkdocs build --strict` clean
- Each ADR has a status header (Accepted)
- Each ADR cites the relevant PRD section + AMENDMENTS section
- Index page links all 12

## File changes

12 ADR files + README.md.

## References

- `temp/fiab-prd/AMENDMENTS.md`
- Existing `docs/adr/*.md` (template)
