---
status: accepted
date: 2026-04-19
deciders: csa-inabox platform team
consulted: security, governance, dev-loop
informed: all
---

# ADR 0010 — Microsoft Fabric as strategic target; current build as Fabric-parity on Azure PaaS

## Context and Problem Statement

Microsoft Fabric is positioned as the long-term unified analytics platform:
OneLake storage, Delta as the table format, a unified Purview-backed
catalog, Synapse Data Engineering (Spark), Data Warehouse, Real-Time
Analytics, and Power BI under a single SaaS boundary. Federal and Gov
tenants, however, cannot adopt Fabric today in the same feature window as
Commercial. We must decide how to position the current CSA-in-a-Box
stack so it is a net **accelerator** toward Fabric rather than a detour
that has to be unwound later.

## Decision Drivers

- **Fabric is the stated Microsoft direction** — design now so our
  artifacts (SQL, Delta tables, lineage, governance) migrate forward.
- **Azure Government availability lag** — Fabric Gov GA lags Commercial
  by quarters to a year; federal tenants cannot wait.
- **Customer optionality** — non-federal Commercial customers may want to
  adopt Fabric today; our assets should not block that.
- **Composability** — every decision in ADRs 0001–0009 should either match
  a Fabric primitive or have a migration path to one.
- **Evidence over marketing** — we commit to Fabric parity, not Fabric
  purchase; customers should see value in the current stack on day one
  without waiting for Fabric.

## Considered Options

1. **Fabric as strategic target; current build is Fabric-parity on Azure
   PaaS (chosen)** — Build with Delta, Purview, dbt, Databricks,
   OneLake-shaped medallion today; migrate into Fabric when Gov GA
   permits.
2. **All-in on Fabric today** — Simplest architecture if we ignore Gov
   availability; non-starter for federal tenants.
3. **Pure open-source lakehouse (no Fabric allegiance)** — Maximum
   portability; forgoes the Microsoft-native governance and Power BI
   integration story.
4. **Wait for Fabric Gov GA** — Stall current federal onboardings; not
   viable.

## Decision Outcome

Chosen: **Option 1 — Fabric-parity on Azure PaaS**. Every primary choice
has been selected so it maps forward into Fabric:

- ADR-0001 ADF + dbt → Fabric Data Factory pipelines + dbt (same engine
  choice; Fabric Data Factory supports dbt).
- ADR-0002 Databricks → Fabric Synapse Data Engineering (Delta + Spark).
- ADR-0003 Delta Lake → OneLake (Delta is native).
- ADR-0005 Event Hubs → Fabric Real-Time Analytics / Eventstream.
- ADR-0006 Purview → Fabric Purview (superset).
- ADR-0007 Azure OpenAI → Fabric AI Skills / Copilot (Azure OpenAI
  underneath).
- ADR-0008 dbt Core → unchanged, runs in Fabric identically.

## Consequences

- Positive: Every SQL model, Delta table, Purview entry, and Bicep
  deployment has a forward path into Fabric with low rewrite cost.
- Positive: Federal tenants get production value today on Azure PaaS;
  Commercial tenants can migrate to Fabric when ready.
- Positive: Marketing narrative is honest — "build your own Fabric" is
  a real claim backed by the primitive-level parity choices.
- Positive: Avoids premature coupling to Fabric SaaS while maintaining
  strategic alignment.
- Negative: Some near-term work duplicates capability that Fabric will
  eventually subsume (e.g., running our own ADF instance vs. Fabric Data
  Factory).
- Negative: Customers may ask "why not just wait for Fabric?" — the
  answer is Gov availability and current feature gaps, which requires
  ongoing communication.
- Negative: Two documentation surfaces over time — current stack and
  Fabric-migration — unless we invest in keeping them aligned.
- Neutral: If Fabric's Gov roadmap slips materially, we continue
  delivering value on PaaS without needing a strategy change.

## Pros and Cons of the Options

### Option 1 — Fabric-parity on Azure PaaS
- Pros: Federal-compatible now; forward-migratable; honest positioning;
  no lock-in cost of Fabric SaaS before value is proven.
- Cons: Duplicated capability for customers who ultimately migrate to
  Fabric; dual-surface documentation burden.

### Option 2 — All-in on Fabric today
- Pros: Simplest stack; Microsoft-native end-to-end.
- Cons: Blocks all Gov tenants until Fabric Gov GA; feature gaps remain
  in several Fabric workloads.

### Option 3 — Pure open-source lakehouse
- Pros: Maximum portability; no Microsoft vendor coupling.
- Cons: Customer runs more infra; weaker governance story; Power BI /
  Fabric integration becomes a custom build.

### Option 4 — Wait for Fabric Gov GA
- Pros: Zero throwaway work.
- Cons: Stalls current federal onboardings; not an acceptable business
  position.

## Validation

We will know this decision is right if:
- When Fabric reaches Gov GA, at least 80% of each vertical example
  (SQL, tables, governance, pipelines) migrates forward without rewrite.
- Tenants who adopt Fabric early (Commercial) can bring their CSA-in-a-Box
  SQL, Delta tables, and Purview metadata into Fabric with a documented
  migration script, not a re-platform.
- If Fabric Gov GA delivers on its roadmap, we open a Fabric reference
  implementation alongside the PaaS one; if it slips materially, we
  continue on PaaS unchanged.

## References

- Decision tree:
  [Fabric vs. Databricks vs. Synapse](../decisions/fabric-vs-databricks-vs-synapse.md)
- Decision tree:
  [Lakehouse vs. Warehouse vs. Lake](../decisions/lakehouse-vs-warehouse-vs-lake.md)
- Related code: `docs/ARCHITECTURE.md` (current-stack / Fabric-parity
  narrative), `docs/GOV_SERVICE_MATRIX.md` (Gov availability tracker),
  `docs/PLATFORM_SERVICES.md` (service-by-service mapping)
- Related ADRs: 0001, 0002, 0003, 0005, 0006, 0007, 0008 (every primary
  technology choice has a Fabric-forward path recorded there).
- Framework controls: NIST 800-53 **PL-2** (system security plan —
  strategic direction is explicit), **SA-8** (security engineering
  principles — decisions are explainable and traceable), **CM-9**
  (configuration management plan — ADRs are part of the plan). See
  `governance/compliance/nist-800-53-rev5.yaml`.
- Discussion: CSA-0087, CSA-0010
