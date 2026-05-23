# 5-Day Commercial CoE Workshop

For regulated commercial verticals waiting for Fabric Gov:
healthcare (HIPAA), regional banks (sovereignty), pharma (FDA Part
11), defense industrial base running commercial Azure (non-ITAR
workloads). Focus: Commercial Azure boundary; UC managed catalog;
Foundry Agent Service.

Same 5-day structure as the [Federal CoE Workshop](../5-day-federal-coe/index.md);
content tuned to commercial concerns.

## What differs vs Federal CoE

| Topic | Federal CoE | Commercial CoE |
|---|---|---|
| Boundary content | Per-boundary `.bicepparam` walkthrough (GCC-H / IL5) | Commercial baseline; UC managed primary |
| Compliance focus | FedRAMP H / IL4 / IL5 / ITAR / CMMC | HIPAA / SOC 2 / PCI / GDPR / FDA Part 11 |
| Forward-migration target | Fabric Gov (`Forecasted`) | Fabric Commercial (already GA today) |
| Agent orchestration | MAF + AOAI direct (Gov fallback) | Foundry Agent Service (GA Mar 2026) |
| Catalog | Purview-primary in Gov | UC managed + Purview overlay |
| Defender AI | Sentinel workaround (Gov) | Defender for Cloud AI Threat Protection (Commercial) |
| Network | NSG egress allow-list + ER/VPN | Public + private mix per customer policy |
| Workshop materials | Federal-mission framing | Generic-industry framing |

## Same 5-day shape

### Day 1 — Foundation & Deploy

- Loom overview (commercial framing)
- Customer environment readiness (Azure Commercial subs)
- `azd up` install
- Loom Setup Wizard live
- Validation

### Day 2 — Ingest & Mirroring & Catalog

- Same ingest patterns
- Mirroring Engine
- UC managed catalog walkthrough (vs Purview-primary in Gov)
- Workspace RBAC + UC privileges

### Day 3 — Transform & Lakehouse & Warehouse

- Databricks notebooks + dbt
- Medallion on customer workload
- Databricks SQL Warehouse (Commercial only; uses Photon)
- KQL on real-time data

### Day 4 — BI & AI & Direct Lake & Data Agents

- Power BI Desktop + TMDL
- Direct-Lake-Shim
- Data Agents authoring + Foundry Agent Service integration
- Loom Copilot tour

### Day 5 — Operate & Govern & Forward-Migrate

- Monitoring + Cost
- DR
- Forward migration to **Fabric Commercial** (already GA — can be
  demonstrated live, not just planned)
- CoE charter
- Exec readout

## Forward migration to Fabric Commercial (Day 5 — unique to commercial)

Unlike federal where Fabric is `Forecasted`, commercial customers
can forward-migrate **today** to Fabric Commercial:
- Live demo of `fiab-migrate execute` against a real Fabric Commercial
  workspace
- OneLake shortcut creation
- Side-by-side Loom + Fabric Commercial query comparison
- Customer leaves Day 5 with a deployed Fabric workspace alongside
  Loom

This is a major differentiator vs the Federal CoE workshop where
forward migration is planning-only.

## Audience differences

| Role | Federal CoE | Commercial CoE |
|---|---|---|
| ATO / compliance officer | Day 1, 5 | Optional — replace with Risk + Audit lead |
| Federal CSU | Facilitator | Replace with Commercial CSU |
| Microsoft federal account team | Day 1, 5 | Replace with Microsoft commercial enterprise team |
| Defense industrial base specialist | Sometimes | Replace with vertical-specific (healthcare / FSI / pharma) |

## When to use Commercial CoE vs Federal CoE

| Customer | Workshop |
|---|---|
| Federal civilian, DoD, IC, state + local | Federal CoE |
| Federal contractor on Azure Government | Federal CoE |
| Hospital / health system on commercial Azure (HIPAA) | Commercial CoE |
| Regional bank on commercial Azure (sovereignty preference) | Commercial CoE |
| Pharma (FDA Part 11) | Commercial CoE |
| Defense industrial base on commercial Azure (non-ITAR) | Commercial CoE |
| Customer with both estates (hybrid) | Federal CoE primary; Commercial CoE follow-up |

## Cost

Same as Federal CoE — workshop delivery by Microsoft commercial
enterprise team + CSU resources; customer provides venue + time;
underlying Azure consumption customer-paid.

## Related

- [Workshop index](../index.md)
- [Federal CoE workshop](../5-day-federal-coe/index.md) — sibling variant
- [Pitch deck](../../marketing/pitch-deck.md)
