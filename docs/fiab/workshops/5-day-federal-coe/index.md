# 5-Day Federal CoE Workshop

For federal civilian agencies, DoD components, intelligence
community, state + local government, federal contractors. Focus:
FedRAMP / IL4 / IL5 / ITAR / CMMC compliance.

## Audience

| Role | Day-1 attendance | Hands-on participation |
|---|---|---|
| Customer CIO / CDO | Kickoff (1 hr) + Day-5 readout (1 hr) | No |
| Platform team lead | Full week | Yes |
| Platform engineers (3-6) | Full week | Yes |
| Security architect | Day 1, 4, 5 | Yes |
| Data architect | Day 1, 2, 3 | Yes |
| BI lead | Day 4 | Yes |
| ATO / compliance officer | Day 1, 5 | No |
| Microsoft federal CSU | Full week (facilitator) | Yes |
| Microsoft account team | Day 1 kickoff + Day 5 readout | No |

## Pre-workshop prerequisites (customer-completed)

- Azure Government subscription with Contributor + UAA roles
- M365 GCC-High tenant (for IL4) OR GCC tenant (for GCC mode)
- Power BI Premium F-SKU capacity (or P-SKU for GCC)
- Available CIDR ranges + ER/VPN connectivity
- FiaB Admins Entra group created
- ATO documentation reviewer available remotely Day 5

## Five days

### Day 1 — Foundation & Deploy

Kickoff. Loom overview + per-boundary matrix walkthrough. Customer
environment readiness verification. Marketplace install (recorded
playback). Loom Setup Wizard live deploy. First DLZ deploy.
Validation: Console operational.

**Homework**: Read `docs/fiab/governance/` overview.

### Day 2 — Ingest & Mirroring & Catalog

Ingest patterns review. Mirroring Engine deep-dive (Debezium + Spark
Structured Streaming + Delta MERGE). Catalog overlay (UC tags or
Purview-primary in Gov-IL4). Workspace identity + RBAC patterns.

**Homework**: Identify a real customer workload to use as week's case
study.

### Day 3 — Transform & Lakehouse & Warehouse

Databricks notebook tour + dbt integration. Medallion (Bronze →
Silver → Gold) on customer's chosen workload — hands-on. Synapse
Serverless ad-hoc SQL. Materialized Lake Views (scheduled Jobs in
Gov). KQL exploration on real-time data.

**Homework**: Customer commits workload transform notebooks to Git.

### Day 4 — BI & AI & Direct Lake & Data Agents

Semantic model authoring in Power BI Desktop. TMDL Git workflow.
Direct-Lake-Shim configuration + refresh latency demo (honest
discussion of the 5-30 s gap). Data Agents authoring + test chat.
Activator rule design. Loom Copilot tour.

**Homework**: Customer prepares Day-5 readout slides.

### Day 5 — Operate & Govern & Forward-Migrate

Monitoring Hub. Cost management patterns. DR drill (simulated region
failover). Forward migration planning (`fiab-migrate snapshot` demo,
migration plan walkthrough, hybrid topology discussion). CoE charter
document review. Final readout to exec sponsor.

## Federal-specific content emphasis

- Per-boundary `.bicepparam` walkthrough (GCC-H vs IL5)
- CMMC L2 / L3 practice family alignment
- ITAR considerations for GCC-H deploys
- HIPAA BAA scope for healthcare-adjacent agencies
- CNSSI 1253 control mapping (when IL5 in v1.1)
- Defender for Cloud AI Threat Protection workaround (Sentinel
  pipeline)
- Federal procurement implications

## Deliverables to customer

- Working Loom Admin Plane + DLZ deployment in customer's Azure
  Gov sub
- One workload migrated end-to-end (case study)
- CoE charter document (template + customized for customer)
- Forward-migration plan to Fabric (Excel + diagram)
- Trained customer team certified ready to operate
- Post-workshop satisfaction survey

## Optional add-ons

- Half-day exec briefing (CIO / CDO / mission leadership)
- Half-day deep-dive on specific workload (e.g., Direct Lake parity
  or Data Agents)
- Quarterly check-in follow-ups

## Cost (typical)

Workshop delivery: Microsoft federal field + CSU resources. Customer
provides:
- Venue (if on-site)
- AV + projector
- Workshop participants' time

Loom platform + underlying Azure consumption: customer's existing
Azure agreement.

## Sample agenda (Day 1)

| Time | Activity |
|---|---|
| 09:00 | Kickoff with exec sponsor (30 min) |
| 09:30 | CSA Loom overview + parity matrix walkthrough (60 min) |
| 10:30 | Break (15 min) |
| 10:45 | Customer environment readiness check (60 min) |
| 11:45 | Lunch (60 min) |
| 12:45 | Marketplace install — recorded clip + Bicep deep-dive (60 min wait) |
| 13:45 | Loom Setup Wizard live session — collaborative DLZ design (90 min) |
| 15:15 | Break (15 min) |
| 15:30 | DLZ deploy + validation (60 min wait + verification) |
| 16:30 | Day-1 wrap-up + Day-2 preview (30 min) |

## Related

- [Workshop index](../index.md)
- [Commercial CoE workshop](../5-day-commercial-coe/index.md) — sibling variant
- [Federal account-team pitch](../../marketing/federal-pitch.md)
