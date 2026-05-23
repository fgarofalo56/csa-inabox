# fiab-0001: Fabric feature scope

**Status:** Accepted
**Date:** 2026-05-22
**Locked decision ref:** LD-3

## Context

Microsoft Fabric ships roughly a dozen workloads + a growing set of
adjacent capabilities (Fabric IQ Ontology, Graph, Plan, Operations
Agent, Maps, Fabric Databases / HorizonDB, etc.). CSA Loom needs to
draw a scope boundary: which Fabric capabilities does Loom v1
deliver parity for, which lands in later releases, and which is out
of scope entirely?

Two constraints shape the answer:

1. **Audit-boundary availability of the underlying Azure services.**
   v1 supports Commercial + GCC + GCC-High. Some Fabric workloads
   require Azure services that aren't authorized at all Gov boundaries
   (e.g. Azure Container Apps not at IL4+; Microsoft Purview not at
   IL5; Foundry Agent Service Gov-GA unconfirmed).
2. **Public information depth on Fabric-only items.** Some recent
   Fabric items (Fabric IQ Ontology, Graph, Plan — first-class at
   FabCon March 2026) don't yet have enough public architectural
   information to design honest parity against.

## Decision

Three-release scope:

### v1 (target: 6-9 months from foundation)

Cloud boundaries: **Commercial + GCC + GCC-High**.

Fabric workloads / capabilities with v1 parity:
- OneLake (approximate — engine-layer vs storage-protocol enforcement)
- Workspaces + capacity model (approximate)
- Domains / Subdomains (exact)
- Workspace Identity (exact)
- Data Factory pipelines + Dataflows Gen2 + Copy Job + dbt Job (exact / approximate)
- Mirroring (approximate — same publisher contract; honest UX gap)
- Lakehouse + Spark notebooks + environments (exact in Commercial; approximate in Gov)
- Materialized Lake Views (approximate — DLT in Commercial; scheduled Jobs in Gov)
- User Data Functions (exact)
- Warehouse / Polaris (approximate — Databricks SQL Warehouse Commercial; Synapse Serverless Gov)
- SQL Analytics Endpoint (exact functionally)
- Data Science / MLflow / Vector Search (approximate)
- Real-Time Intelligence (exact engine via ADX; approximate UX)
- Data Activator / Reflex (approximate — Loom Activator Engine)
- Mirroring (approximate)
- **Direct Lake parity** via warm-cache materializer (approximate — honest 5-30s freshness gap)
- Data Agents (approximate — extension of `apps/copilot/`)
- Copilot in Loom (approximate — per-pane personas)
- OneSecurity (approximate — engine-layer enforcement)
- Git Integration + Deployment Pipelines + Variable Libraries (exact functionally)

### v1.1 (+3 months)

- **DoD IL5 support** — Marketplace publishing engagement with
  Microsoft federal; customer-managed plan only; Atlas-on-AKS catalog;
  HSM-CMK storage
- **Power BI embedded Console panes** — Console panes surfaceable
  inside Power BI workspaces
- **Remaining 17 industry examples** (v1.1 ports wave 2)
- **`fiab-migrate` forward-migration CLI**
- **Operations Agent** (Loom Ops Copilot — takes action on Loom
  resources)
- **Mirroring source expansion** (Open Mirroring publisher SDK +
  partner-onboarded paths)
- **UC managed Gov promotion track** — when UC managed reaches Gov-GA,
  migrate Gov customers from Purview-primary to UC-managed + Purview
  overlay

### v2 (+6 months after v1.1)

- **Fabric IQ family** — Ontology, Graph, Plan, Maps
- **HorizonDB-equivalent** (Postgres-in-Loom)
- **Fabric Maps parity** (Azure Maps / Mapbox / PMTiles)
- **AI Skills auto-config** (auto-generated example queries)

### Out of scope (never, or out of Loom's mission)

- **DoD IL6 / Azure Government Secret** — csa-inabox not authorized
  in this boundary; sponsor-specific deploys only
- **Direct Lake on OneLake (no-fallback) parity** — engineering-
  impossible without owning the VertiPaq transcoder
- **Multi-cloud destinations** — Loom is Azure-only by design
- **Replacing Power BI with an OSS BI tool** — Power BI is the BI
  surface; substituting removes the forward-migration story
- **Replacing Databricks with OSS Spark** — Databricks (Photon, UC
  managed) is the strategic compute target
- **Public-cloud Marketplace for Azure operated by 21Vianet (China)**
  — separate sovereign cloud; separate publisher relationship
- **Anti-Microsoft positioning** — Loom is Fabric-aligned, not
  Fabric-competing

## Consequences

### Positive

- Customers get a clear contract: "v1 covers these workloads at this
  parity grade; here's what comes later"
- Engineering scope is bounded; no scope creep from "but Fabric has X"
  asks
- Honest gaps (Direct Lake sub-second, Fabric IQ family) are
  documented up front so customers aren't surprised
- v1.1 + v2 give a 12-month forward visibility

### Negative

- Some federal customers in IL5 wait 3 months past v1 GA
- Fabric IQ family enthusiasts wait 6+ months
- Quarterly freshness rescans needed to keep scope decisions current
  (Build, FabCon, Ignite cadences)

### Neutral

- Build 2026 (June 2-3) and future Microsoft events may shift these
  scope decisions; quarterly review at every major Fabric event

## Alternatives considered

| Alternative | Why not chosen |
|---|---|
| All boundaries day-one (incl. IL5) | +3 months scope; IL5 publisher-managed-plan complexity adds risk |
| Commercial only v1; Gov v2 | Misses the strategic target — Loom is FOR Gov |
| Top-4 workloads only v1 | Too sparse for federal customers to commit to; sub-MVP |
| Fabric IQ family in v1 | Public info too thin in 2026-Q2 to design honest parity |
| Direct Lake "on OneLake" (no-fallback) parity | Engineering-impossible without VertiPaq transcoder ownership |

## References

- PRD: [`temp/fiab-prd/03-scope.md`](https://github.com/fgarofalo56/csa-inabox/blob/csa-loom-pillar/temp/fiab-prd/03-scope.md)
- Amendments: [`temp/fiab-prd/AMENDMENTS.md`](https://github.com/fgarofalo56/csa-inabox/blob/csa-loom-pillar/temp/fiab-prd/AMENDMENTS.md) §A2
- Research: [`temp/fiab-research/01-fabric-capability-surface.md`](https://github.com/fgarofalo56/csa-inabox/blob/csa-loom-pillar/temp/fiab-research/01-fabric-capability-surface.md), [`02-gov-boundary-availability.md`](https://github.com/fgarofalo56/csa-inabox/blob/csa-loom-pillar/temp/fiab-research/02-gov-boundary-availability.md), [`03-fabric-only-internals.md`](https://github.com/fgarofalo56/csa-inabox/blob/csa-loom-pillar/temp/fiab-research/03-fabric-only-internals.md)
- Parent ADR: [`docs/adr/0010-fabric-strategic-target.md`](../../adr/0010-fabric-strategic-target.md)
