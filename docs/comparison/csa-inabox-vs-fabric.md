# CSA-in-a-Box vs Microsoft Fabric — feature-by-feature

_Last updated: 2026-05-08_

This page is a side-by-side capability comparison between **CSA-in-a-Box**
(this repository's reference architecture, running on Azure PaaS) and
**Microsoft Fabric** (the unified analytics SaaS).

If you're trying to **decide which one to build on**, start with the
[Fabric vs Databricks vs Synapse decision tree](../decisions/fabric-vs-databricks-vs-synapse.md)
or [ADR-0010 — Fabric strategic target](../adr/0010-fabric-strategic-target.md).
This page complements those by giving you the **per-capability detail** so
you can validate the recommendation against your specific workload.

## Positioning at a glance

| | CSA-in-a-Box | Microsoft Fabric |
|---|---|---|
| **Shape** | Reference architecture + IaC + sample code on Azure PaaS | Unified SaaS analytics platform |
| **Where it ships** | Azure Commercial **and** Azure Government (FedRAMP High / IL4 / IL5) | Azure Commercial GA; Gov **forecasted** (see [#177](https://github.com/fgarofalo56/csa-inabox/issues/177)) |
| **Compute model** | Pay-per-resource — Databricks / Synapse / ADF / Functions / etc. priced separately | Capacity-reserved F-SKUs (CU pool); pay-as-you-use overage |
| **Vendor coupling** | Microsoft-native PaaS, replaceable per-component | Microsoft-native SaaS, single bundle |
| **Best fit** | Federal / Gov, regulated, multi-cloud, SQL-first DW estates, Spark/ML-heavy pipelines | Commercial greenfield with Power BI / OneLake at the centre |

The repo is built **for forward migration into Fabric** — every primary
technology choice (ADR-0001 through ADR-0009) has a documented Fabric
counterpart. See the [migration paths](#migration-paths) below.

## Capability matrix

### Storage and table format

| Capability | CSA-in-a-Box | Microsoft Fabric |
|---|---|---|
| Storage primitive | ADLS Gen2 (Delta tables in Bronze/Silver/Gold) | OneLake (Delta tables, single tenant-wide namespace) |
| Table format | Delta Lake (open-source) | Delta Lake (same engine; OneLake exposes tables natively) |
| Cross-region | Geo-redundant storage account (Bicep) | OneLake regional; cross-region via shortcuts (preview) |
| Cross-cloud | Manual via shortcuts to S3/GCS or Purview cross-cloud scans | OneLake **shortcuts** to S3, GCS, ADLS Gen2 (read-only) |
| Hot vs cold tiering | ADLS lifecycle rules in Bicep | Fabric handles automatically inside the F-SKU |
| Per-domain isolation | Container/path-per-domain in ADLS; RBAC + ABAC | Workspace-per-domain in Fabric; RBAC at workspace |

**Fabric advantage:** Single namespace (OneLake) for the whole tenant —
no per-storage-account sprawl. CSA-in-a-Box mimics this with consistent
naming + ADR-0006 Purview cataloging.

**CSA-in-a-Box advantage:** Direct ADLS access from any Azure service;
zero workspace abstraction cost; Gov-cloud ready today.

### Data ingestion / orchestration

| Capability | CSA-in-a-Box | Microsoft Fabric |
|---|---|---|
| Batch ETL | Azure Data Factory ([ADR-0001](../adr/0001-adf-dbt-over-airflow.md)) | Fabric Data Factory pipelines (same engine) |
| dbt integration | dbt Core in CI ([ADR-0008](../adr/0008-dbt-core-over-dbt-cloud.md)) | dbt Core supported in Fabric Data Factory natively |
| Streaming ingest | Event Hubs → Stream Analytics or Databricks Auto Loader ([ADR-0005](../adr/0005-event-hubs-over-kafka.md)) | Eventstream → KQL DB / Lakehouse / Reflex |
| Self-Hosted Integration Runtime (on-prem ingest) | ADF SHIR (documented in `docs/SELF_HOSTED_IR.md`) | Fabric Data Factory + on-prem data gateway (preview) |
| CDC / change feed | Delta change feed; Debezium-on-AKS for legacy DBs | Fabric mirroring (Cosmos, Snowflake, SQL DB GA; more in preview) |
| Trigger model | ADF schedules + event-based | Fabric activator (Reflex) — event-rule engine |

**Fabric advantage:** Mirroring connects operational DBs (Cosmos, SQL,
Snowflake) into the lakehouse with no ETL — true zero-ETL for the
covered sources.

**CSA-in-a-Box advantage:** Full control over SHIR and on-prem
connectivity; Gov-compatible.

### Transformation

| Capability | CSA-in-a-Box | Microsoft Fabric |
|---|---|---|
| Canonical engine | dbt Core for SQL; Databricks for Spark ([ADR-0013](../adr/0013-dbt-as-canonical-transformation.md)) | Fabric Data Engineering (Spark notebooks) + Warehouse (T-SQL) + dbt support |
| Spark engine | Databricks Photon + Delta ([ADR-0002](../adr/0002-databricks-over-oss-spark.md)) | Fabric Spark (Microsoft-managed runtime) |
| SQL warehouse | Synapse Dedicated / Serverless SQL pools | Fabric Warehouse (sub-second over Delta) |
| Lineage tracking | Purview ([ADR-0006](../adr/0006-purview-over-atlas.md)) — manual + ADF integration | Fabric automatic lineage across items |
| Quality checks | Great Expectations + dbt tests | dbt tests + Fabric data quality (preview) |
| Notebook environment | Databricks notebooks; VS Code remote | Fabric notebooks (browser-native) |

**Fabric advantage:** Lineage is automatic across Fabric items — no
manual Purview registration step. Single notebook environment.

**CSA-in-a-Box advantage:** Best-in-class Spark (Databricks Photon
benchmarks ahead of Fabric Spark for tuned workloads); real Unity
Catalog if you need it; ML ecosystem maturity.

### Governance and catalog

| Capability | CSA-in-a-Box | Microsoft Fabric |
|---|---|---|
| Catalog | Microsoft Purview (paid SKU) | Fabric Purview (superset; included in F-SKU) |
| Classification | Purview managed scans + custom rules | Fabric Purview + automatic classification on items |
| RBAC | Entra ID + Azure RBAC + ADLS POSIX ACLs + Purview policies | Fabric workspace + item-level + Purview policies |
| Data masking | Synapse / SQL DB dynamic masking; Purview policy enforcement | Fabric Warehouse dynamic masking + OLS/RLS at semantic-model layer |
| Data residency | Per-resource region pinning (Bicep) | Workspace region pin |
| Audit log | Activity Log + App Insights + audit-table-per-domain pattern | Fabric activity log (Purview-aligned) |

**Same on both:** Microsoft Purview is the governance plane. The
*coverage* in Fabric is wider out-of-the-box (every Fabric item is
catalog-aware), but you can reach the same coverage on CSA-in-a-Box by
disciplined Purview registration.

### BI and serving

| Capability | CSA-in-a-Box | Microsoft Fabric |
|---|---|---|
| Power BI integration | Standard import / DirectQuery; semantic models authored separately | **Direct Lake** mode (sub-second over Delta with no model refresh) — Fabric-only |
| Dashboard tool | Power BI Pro / Premium (separately licensed) | Power BI included in F-SKU |
| Real-time dashboards | Stream Analytics → Power BI streaming dataset | Fabric Real-Time Dashboards (KQL) — Fabric-only |
| Embedded analytics | Power BI Embedded (capacity-priced) | Fabric Power BI Embedded (CU-billed) |
| Custom apps | Azure App Service + Power BI APIs + portal scaffold in repo | Fabric REST API + Power BI APIs |

**Fabric advantage (significant):** Direct Lake is genuinely unique. If
your primary requirement is Power BI on a lakehouse with sub-second
refresh, Fabric is the right answer. CSA-in-a-Box does not match
Direct Lake performance — it cannot, by architecture.

### Real-time and streaming

| Capability | CSA-in-a-Box | Microsoft Fabric |
|---|---|---|
| Event ingest | Event Hubs / IoT Hub | Eventstream (built on Event Hubs) |
| Stream processing | Azure Stream Analytics, Databricks Structured Streaming | Eventstream + KQL DB |
| Time-series store | Azure Data Explorer (ADX) | Fabric KQL Database (same engine) |
| Event-driven actions | Event Grid + Logic Apps + Functions | **Reflex (Data Activator)** — Fabric-only event-rule engine |
| End-to-end SLA | Sub-second possible; depends on each hop | Sub-second across the SaaS pipeline |

**Fabric advantage:** Reflex (Data Activator) is unique — declarative
rules over streaming data with no-code action triggers.

### Machine learning and AI

| Capability | CSA-in-a-Box | Microsoft Fabric |
|---|---|---|
| Notebook training | Databricks notebooks + MLflow | Fabric notebooks + MLflow |
| Model registry | Databricks Unity Catalog + MLflow | Fabric MLflow + Power BI semantic-model integration |
| Feature store | Custom Delta-table-based or Unity Catalog feature store | Fabric **AI Skills** (preview) |
| Data Agents (RAG) | Azure OpenAI + Azure AI Search ([ADR-0007](../adr/0007-azure-openai-over-self-hosted-llm.md)) — wired into the Copilot widget | **Fabric Data Agents** (preview) — natural-language Q&A over Lakehouse |
| Endpoint hosting | Databricks Model Serving, Azure ML, Azure Functions | Fabric AI Functions (preview) |
| Copilot | Custom chat (this repo's `apps/copilot/` + `azure-functions/copilot-chat/`) | Fabric Copilot — built into the Fabric UX |

**Fabric advantage:** The Copilot and Data Agents experience is built
in — no glue code. AI Skills are a managed RAG pattern.

**CSA-in-a-Box advantage:** Full control over the Copilot pipeline (this
very widget is the proof). Bring-your-own model, bring-your-own
guardrails. Gov-compatible Azure OpenAI today.

### Deployment, IaC, CI/CD

| Capability | CSA-in-a-Box | Microsoft Fabric |
|---|---|---|
| IaC primitive | Bicep ([ADR-0004](../adr/0004-bicep-over-terraform.md)) for every resource | Fabric workspace + items via REST API + `fabric-cli` (preview) |
| Source control | dbt + Bicep + portal in Git, full GitHub Actions matrix | Fabric Git integration (workspace ↔ Git) — preview |
| Environment promotion | Dev / Stage / Prod via Bicep param files + GH Environments | Fabric deployment pipelines (UI-driven) |
| Observability | App Insights + Log Analytics; Bicep-deployed alert rules | Fabric monitoring hub |

**Same on both:** Both can be Git-driven. CSA-in-a-Box is more mature
(everything goes through PR + CI today); Fabric Git integration is
catching up but adds platform-specific quirks.

### Compliance and Gov-cloud posture

| Capability | CSA-in-a-Box | Microsoft Fabric |
|---|---|---|
| Azure Commercial GA | Yes — every component | Yes — full Fabric |
| FedRAMP Moderate | Yes — full stack inherits component certifications | Yes — Commercial only |
| FedRAMP High / IL4 / IL5 | Yes — see `docs/GOV_SERVICE_MATRIX.md` | **No (forecasted)** — see [#177](https://github.com/fgarofalo56/csa-inabox/issues/177) |
| HIPAA BAA | Component-by-component; mostly yes (`docs/compliance/hipaa-security-rule.md`) | Yes (Commercial) |
| ITAR | Azure Gov yes; CSA-in-a-Box deployable there | Not yet in Gov |
| CMMC 2.0 L2 | Yes — see `docs/compliance/cmmc-2.0-l2.md` | Commercial only |
| StateRAMP | Yes — see `docs/compliance/stateramp.md` | Pending |

**This is the headline differentiator.** Fabric is Commercial-only as of
2026-05-08. Federal, defence, and many state customers cannot adopt
Fabric today — and CSA-in-a-Box is what they should build on.

### Cost model

| Aspect | CSA-in-a-Box | Microsoft Fabric |
|---|---|---|
| Pricing primitive | Per Azure service (DBU, vCore, GB, requests, etc.) | F-SKU capacity (CU pool) + per-second overage |
| Predictability | Variable — depends on usage per service | Capacity-reserved is predictable; overage is metered |
| Multi-tenant | Each customer / domain → its own resource group, billable separately | Workspace-per-tenant; CU pool can be shared or split |
| Cost optimisation | Right-sizing per service (Cluster autoscale, Synapse pause, ADLS lifecycle) | F-SKU rightsizing + capacity bursting / smoothing |

For a single Power BI-centric workload, Fabric's bundled pricing
typically wins. For a workload that's heavy on Spark + ML + 24/7
streaming, separate-service pricing in CSA-in-a-Box is often cheaper
because you tune each component.

## Migration paths

### Today's CSA-in-a-Box → Fabric (when Gov GA arrives)

This is what ADR-0010 is built for. Most migrations are item-level
moves rather than rewrites:

| From CSA-in-a-Box | To Fabric | Migration effort |
|---|---|---|
| ADLS Delta tables | OneLake shortcut → native | **Low** — shortcut means zero data movement; later promote via copy |
| dbt Core models | Fabric Data Factory + dbt | **Low** — same engine, change connection string |
| Synapse Dedicated SQL pools | Fabric Warehouse | **Medium** — re-create schema; T-SQL syntax mostly compatible |
| Databricks notebooks | Fabric Spark notebooks | **Medium** — re-target session config + Unity Catalog → OneLake catalog |
| Purview catalog | Fabric Purview | **Low** — Fabric Purview is a superset; entries map forward |
| Power BI semantic models | Fabric / Direct Lake | **Low to Medium** — re-author for Direct Lake to get sub-second refresh |
| ADF orchestrations | Fabric Data Factory pipelines | **Low** — UI / JSON formats are compatible; some triggers re-author |

The repo's [`adr/`](../adr/README.md) directory documents the per-component
forward path; together they constitute a migration runbook.

### Microsoft Fabric → CSA-in-a-Box (Gov customer leaving Fabric pilot)

Less common but happens — a customer pilots Fabric in Commercial, then
needs to ship the production workload in Gov:

| From Fabric | To CSA-in-a-Box | Effort |
|---|---|---|
| OneLake Delta tables | ADLS Gen2 with same Delta layout | Low — `azcopy sync` |
| Fabric Warehouse | Synapse Serverless or Dedicated SQL | Medium |
| Fabric notebooks | Databricks notebooks | Medium — runtime swap |
| Fabric Data Activator (Reflex) | Event Grid + Logic Apps + Functions | High — no 1:1 equivalent; rebuild from rules |
| Direct Lake semantic models | Power BI Import or DirectQuery | High — Direct Lake is Fabric-only |
| Fabric AI Skills / Data Agents | Custom RAG pipeline (this repo's `apps/copilot/`) | High — rebuild |

The asymmetry is real: Fabric's unique features (Direct Lake, Reflex,
Data Agents) don't map cleanly back to PaaS. **If you start in Fabric,
you accept that some artifacts will need re-implementation if you ever
need to leave.**

## When to choose which (executive summary)

**Choose Microsoft Fabric if all of these are true:**

- You're on Azure Commercial (not Gov)
- Power BI is central to your delivery
- You want the simplest possible operational footprint (single CU pool,
  one workspace per domain)
- You don't need fine-grained Spark tuning
- You're comfortable with Microsoft-SaaS coupling

**Choose CSA-in-a-Box if any of these are true:**

- You need Azure Government (FedRAMP High / IL4 / IL5) **today**
- You have an existing Synapse Dedicated or Databricks investment to
  evolve, not replace
- Spark / ML workloads are heavy enough to want Photon + Unity Catalog
- You need cross-cloud read scenarios that exceed OneLake shortcut
  capabilities
- You want everything in Bicep + Git + GitHub Actions with zero SaaS-only
  surfaces
- Your security posture requires per-resource isolation (per-RG, per-NSG,
  per-Key-Vault) that Fabric workspaces don't expose

**Choose both:** A common pattern is **Fabric for interactive analytics
+ Power BI** in Commercial, plus **CSA-in-a-Box** for the Gov environment
or for Spark/ML pipelines that feed Fabric via OneLake shortcuts. The
two are not mutually exclusive — many CSA-in-a-Box customers will end
up with hybrid topologies.

## Related

- ADR: [0010 — Microsoft Fabric as strategic target](../adr/0010-fabric-strategic-target.md)
- Decision tree: [Fabric vs Databricks vs Synapse](../decisions/fabric-vs-databricks-vs-synapse.md)
- Issue tracking Gov GA: [#177 Microsoft Fabric availability + setup guidance for Azure Government](https://github.com/fgarofalo56/csa-inabox/issues/177)
- Companion site: [Supercharge Microsoft Fabric](https://fgarofalo56.github.io/Suppercharge_Microsoft_Fabric/)
- Service availability tracker: [`GOV_SERVICE_MATRIX.md`](../GOV_SERVICE_MATRIX.md)

## See also

- ← Previous: [Microsoft Fabric Platform Guide](../guides/microsoft-fabric.md)
- → Sibling: [**CSA Loom vs Microsoft Fabric**](csa-loom-vs-fabric.md) — the productized form of csa-inabox (this is the page federal customers should read first)
- → Next: [Migration paths](../migrations/README.md)
- ⌂ Index: [Documentation home](../index.md)
