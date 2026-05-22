# What is CSA Loom

## The problem

Microsoft Fabric is the strategic unified analytics SaaS platform.
As of 2026-05-22, **Fabric is not generally available in any US
Government cloud:**

| Cloud / boundary | Microsoft Fabric (F-SKU platform) | Power BI (component) |
|---|---|---|
| Azure Commercial | **GA** | GA |
| Azure Government — FedRAMP High (GCC pair) | `Forecasted` (no public quarter) | GA — P-SKU only (no F-SKU in GCC) |
| Azure Government — DoD IL4 (GCC-High pair) | `Forecasted` (no public quarter) | GA — F-SKU supported |
| Azure Government — DoD IL5 | `Forecasted` (no public quarter) | GA — F-SKU supported |
| Azure Government Secret — DoD IL6 | `Forecasted` | GA in specific boundaries |

Federal civilian, DoD, intelligence-community, ITAR-bound, and many
state and local-government customers — every customer that needs
FedRAMP High, IL4, IL5, ITAR, CJIS, IRS 1075, CMMC L2/L3, or
sovereignty controls — **cannot adopt Fabric today**, and Microsoft
has not published a commitment date for Fabric GA in Gov.

## What CSA Loom is

**CSA Loom is a productized, Azure-native, Gov-deployable Microsoft
Fabric parity layer** that fills every one of those gaps, shipped
as four things working together:

### 1. A push-button deployment

- `azd up` CLI for platform engineers
- "Deploy to Azure" template button for evaluators
- Lands the full Loom stack into your own Azure subscription
- 60–100 minutes from "begin" to "Loom Console open and ready"
- Two-tier surface (azd + Deploy-to-Azure button); Azure Marketplace
  Managed Application listing **deferred to backlog** per locked
  decision LD-4 — Loom is currently free; you pay only for the
  underlying Azure consumption it stands up

### 2. A custom SaaS-feel front end (Loom Console)

A Next.js + Fluent UI v9 application that gives you the **Fabric
workspace experience** sitting on top of the Azure-native stack
underneath:

- Workspace browser
- Lakehouse pane (Delta tables, files, SQL endpoint)
- Warehouse pane (Databricks SQL Warehouse or Synapse Serverless)
- Notebook pane (embedded Databricks notebook with SSO)
- KQL pane (ADX query editor + dashboards)
- Semantic Model designer (TMDL + DAX editor)
- Catalog (UC managed + Purview overlay in Commercial; Purview-
  primary in Gov)
- Data Marketplace
- Activator rule designer
- Data Agents pane
- Monitoring Hub
- Admin

### 3. A Copilot-driven WYSIWYG setup wizard (Loom Setup Wizard)

A conversational deploy surface:

- Greets you, interviews about tenant + subs + regions + boundary +
  capacity sizing + networking + naming
- Renders the `.bicepparam` it's building **live in a right-pane
  preview**
- Validates via Azure Bicep MCP before deploy
- Calls Azure ARM through a self-hosted Azure MCP server inside your
  Admin Plane
- Streams progress narratively back to chat
- Narrates next steps post-deploy

The same conversational agent persists in the Console as the **Loom
Copilot** — chat with the platform.

### 4. Parity services that fill the Fabric-only gaps

Custom apps that deliver the Fabric-only experience even though
the underlying Fabric SaaS isn't available in Gov:

| Loom service | What it parities | How |
|---|---|---|
| Direct-Lake Shim | Direct Lake mode in Power BI | Power BI Premium Import + Event Grid → TOM partition-scoped refresh (5–30 s freshness; honest gap vs Fabric's sub-second documented openly) |
| Activator Engine | Reflex / Data Activator | NRules + Redis state + Function dispatcher backed by ADX |
| Mirroring Engine | Zero-ETL Mirroring | OSS Debezium + Event Hubs + Spark Structured Streaming + Delta MERGE; honors Fabric's Open Mirroring publisher contract |
| Loom Data Agents | Fabric Data Agents | Extension of the existing `apps/copilot/` + `azure-functions/copilot-chat/` scaffold with NL2SQL / NL2DAX / NL2KQL tools; identity-passthrough |

## Who CSA Loom is for

| Segment | Why Loom fits |
|---|---|
| **Federal civilian agencies** (FedRAMP High / IL4) | Fabric is `Forecasted` in your boundary; Loom is available today in your existing Azure Gov tenant |
| **DoD components** (IL4 / IL5) | Same — and IL5 Loom support lands in v1.1 |
| **State + local government** (StateRAMP / CJIS) | StateRAMP and CJIS-aligned audit baselines work; Loom honors per-boundary control mappings |
| **Federal contractors** (CMMC L2/L3, ITAR) | GCC-High deploys carry ITAR-eligible Azure Gov regions; Loom is deployable there today |
| **Regulated commercial verticals** | Healthcare (HIPAA), financial services with regional sovereignty needs, pharma (FDA Part 11) |

## Who CSA Loom is **not** for

- Customers already on Azure Commercial with no sovereignty constraints
  who can adopt Microsoft Fabric directly — **use Fabric**
- Customers who want a managed-SaaS analytics product they don't
  operate themselves — Loom runs in your tenant; you operate it
- Customers needing IL6 / Top Secret — Loom is not authorized in Azure
  Government Secret; sponsor-specific deploys only
- Customers wanting a non-Microsoft data platform — Loom is
  Fabric-aligned; if you're betting on a non-Microsoft future, Loom
  isn't the right product

## What Loom is **not** trying to be

- **Not a replacement for Microsoft Fabric when Fabric is available.**
  Once Fabric reaches your audit boundary, Loom becomes a forward-
  migration source, not a competing destination.
- **Not a re-implementation of every Fabric workload.** Some Fabric-
  only items have honest gaps (notably Direct Lake's sub-second
  freshness). Loom documents those gaps explicitly; it does not claim
  parity it can't deliver.
- **Not a general-purpose data platform.** Loom is **specifically a
  Fabric parity layer** — its scope is bounded by what Fabric does
  today.
- **Not multi-cloud.** Loom is Azure-only. Cross-cloud read scenarios
  (S3, GCS) work via ADLS Gen2 shortcuts; they are not the target.

## Why now

Three things converged in 2025-2026 to make Loom the right move:

1. **Fabric's strategic position is locked.** Microsoft has committed
   Fabric as the unified analytics target — it's where Synapse + Power
   BI converge.
2. **The Gov gap is real and persistent.** No published Microsoft
   commitment for Fabric Gov GA; Microsoft's normal pattern (Commercial
   → GCC-H → IL5 → IL6) suggests 12–36 months from initial rollout.
3. **The CSA-in-a-Box stack is mature.** Databricks + Synapse
   Serverless + ADX + Purview + Power BI is what csa-inabox already
   deploys via Bicep. Loom productizes that stack with the Console +
   parity services + Setup Wizard on top.

Adopting Loom today is **investing in a year of head-start** on the
Fabric experience, not a year of waiting.

## How Loom relates to the rest of CSA in a Box

CSA Loom is a new top-nav pillar on csa-inabox, sitting alongside:

- Get Started (existing)
- Architecture (existing)
- Build (existing)
- Use Cases & White Papers (existing)
- **CSA Loom** (new — this pillar)
- Operate (existing)

The other pillars stay focused on the reference architecture +
patterns + migrations. Loom adds the productized, deployable,
Fabric-feel layer.

Customers who only need the reference architecture pick the existing
CSA-in-a-Box pillars. Customers who need the productized SaaS-feel +
custom Console + Setup Wizard pick Loom.

## Next

- [Read the whitepaper](whitepaper.md)
- [See the parity matrix](parity-matrix.md)
- [Review the reference architecture](architecture.md)
- [Deploy your first Loom](deployment/quickstart.md)
- [Walk the workloads](workloads/index.md)
