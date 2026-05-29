# CSA Loom expanded scope — v2 backlog from 2026-05-23 walkthrough

> **Comparative positioning note.** This document is written from the
> perspective of Microsoft Azure, Cloud Scale Analytics, and CSA Loom. Any
> description of third-party or competing products, services, pricing, or
> capabilities is derived from **publicly available documentation and sources**
> believed accurate at the time of writing, and is provided for **general
> comparison only**. We do not claim expertise in, or authority over, any
> non-Microsoft product or service; the respective vendor's official
> documentation is the authoritative source for their offerings, which may
> change over time. Nothing here is intended to disparage any vendor — where a
> competing product has genuine advantages, we aim to note them honestly.
> Verify all third-party details against the vendor's current official
> documentation before making decisions.


Direct capture of the user's expanded vision for CSA Loom, beyond the
v1 work completed in this session (25 PRPs, 14 PRs merged, infra
live in Azure). These items are tracked in this doc and will be
turned into PRPs (PRP-26 through PRP-40+) before any code work begins.

**Scope context:** v1 (current) shipped infrastructure parity + 8
Console panes mirroring Fabric's surface. v2 below extends Loom into
a **full data platform with developer portal, marketplace, governance,
and AI-driven operations** — the items below are individually each
PRP-sized.

## New v2 capabilities

### Data marketplace (PRP-26 candidate)
- Catalog of internal data products (lakehouse tables, views, semantic
  models, KQL functions) with descriptions, freshness, sensitivity,
  ownership
- Subscription + access-request workflow (admin approves, RLS applied
  on grant)
- Usage metrics + lineage per product
- Mirrors Fabric **OneLake Catalog** but with cross-DLZ federation

### OneLake-equivalent unified namespace (PRP-27)
- Logical mount of all DLZ lakehouses under one path (`loom://`)
- Shortcut creation across DLZs + external sources (S3, GCS, Snowflake,
  databases) — see PRP-29 below for shortcut builder UI
- Cross-workspace querying via either Databricks federated catalog
  or Synapse cross-database query

### APIM API builder for data sharing (PRP-28)
- Loom Console pane that generates REST/GraphQL endpoints from
  lakehouse tables or semantic measures
- Auto-publishes spec to APIM (the Premium instance we already deploy)
- Per-endpoint auth/rate-limit/quota policies driven by RBAC
- Function App backend auto-generated; OBO identity throughout

### Function API management
- Console pane that lists Azure Functions across all DLZs + Admin Plane
- Per-function: invocation metrics, app-settings editor, deployment
  slot promotion, log tail
- App Insights integration already in place

### AI/ML API management (PRP-30)
- Console pane that wraps AI Foundry deployments behind APIM
- Per-model: rate limits, content-safety enforcement, audit, cost
  controls
- Bring-your-own-model registration (HuggingFace, custom AOAI deployment)

### Developer portal + dev tools (PRP-31)
Comprehensive in-Console developer surface:
- API playground (Swagger UI / GraphiQL embedded)
- Bicep/Terraform template gallery for common Loom extensions
- SDK + CLI documentation (Loom CLI, Loom SDK for Python/.NET/TS)
- Sample code + tutorials inline
- Code generators from data models → DTOs / API clients

### Metadata-driven data source onboarding (PRP-32)
- Self-service workflow in Console
- Operator points at source (DB, API, file share) → Loom introspects
  schema → generates Bicep + Debezium connector config + Spark job
- Auto-creates lineage entries in Purview/Atlas
- Approval gate before production publish

### Domain management (PRP-33)
- First-class domain construct (Finance, HR, Mission Ops, etc.)
- Per-domain: Entra group, Power BI workspace, DLZ assignment,
  data product catalog filter, custom tags
- Mirrors Fabric **Domains** in admin portal

### New DLZ deployment + setup (already partial)
- Setup Wizard pane exists for this (PRP-04 shipped)
- v2 extension: full self-service including pre-validation (subscription
  quota check, region availability, dependency check)

### dbt builder + integration (PRP-34)
- Loom Console pane for dbt project authoring
- Visual model designer + raw SQL editor
- Auto-deploys to Databricks SQL Warehouse or Synapse Serverless
- Lineage flows into Purview/Atlas

### Complete shortcut builder (PRP-35)
- Like Fabric Lakehouse Shortcuts but expanded:
  - ADLS Gen2 shortcuts (current Fabric supports)
  - S3, GCS, Snowflake, on-prem SMB, REST API, GraphQL
  - Per-shortcut transformation (column rename, type cast, filter)
  - Cached vs live (with TTL)
- Each shortcut becomes a queryable table in the lakehouse

### Data virtualization builder + manager (PRP-36)
- Cross-database federated query UI
- Sources: Synapse Serverless EXTERNAL TABLES, Databricks Federated
  Catalog, PolyBase
- Console pane for virtual schema design + query workbench

### Complete observability — DMLZ + DLZ telemetry (PRP-37)
Already started (telemetry-everywhere standard), v2 extends:
- Per-DLZ telemetry dashboard (already in Console catalog as panes)
- Cross-DLZ rollup at DMLZ (Data Management Landing Zone) level
- DataDog/New Relic export option (in addition to LAW)
- Custom KPI definitions + alerting

### Power BI reports — management + operations (PRP-38)
Pre-built suite of Power BI reports auto-deployed:
- Capacity utilization (per DLZ, per workspace)
- Cost attribution (by domain, by tenant)
- User adoption funnel
- Data freshness SLO compliance
- Security events (failed auth, permission changes)
- Top queries, top users, top error sources
- All wired to the standardized LAW + cost-management APIs

### Loom Copilot agent — does-anything (PRP-39)
Already started (apps/copilot + apps/fiab-data-agents), v2 expands:
- Embedded in every Console pane (not just Data Agent pane)
- Can perform ANY operation a user has permission for:
  - Create workspace, deploy DLZ, build shortcut, write dbt model,
    publish API, configure activator rule, refresh semantic model,
    grant access, etc.
- Identity passthrough: agent acts as caller; nothing the user can't
  do themselves
- Conversational workflow + approval gates for destructive ops
- Multi-step task execution with progress streaming
- Tool catalog dynamically scoped to user's RBAC

## Sizing

Honest estimate: 12-15 additional PRPs, each roughly PRP-02 to PRP-09
sized (real Bicep + apps + tests). Probably 6-9 months engineering at
the same pace as v1.

## Tracking

- v2 scope locked in this doc, dated 2026-05-23
- PRP-26 through PRP-40 stubs to be authored in `PRPs/active/csa-loom/`
  before any code begins
- Each PRP gets a GitHub issue + label `csa-loom-v2`
- v2 epic to be opened referencing this doc

## Prerequisites before v2 starts

1. Complete v1 end-to-end:
   - Apps fully deployed + browser-validated (in flight; deploy iter
     J running now)
   - GCC + GCC-High validation (operator action — bootstrap secrets)
2. Build 2026 freshness rescan (auto-fires Jun 8)
3. v2 walkthrough with brand + scope decisions analogous to the
   2026-05-22 v1 walkthrough

## Related

- v1 audit: [PRP Delivery Audit](prp-audit.md)
- Portal architecture (clarifies SaaS-feel + Copilot in every pane):
  [Portal Architecture](portal-architecture.md)
- Deploy iteration log: [Deploy Iteration Log](runbooks/deploy-iteration-log.md)
