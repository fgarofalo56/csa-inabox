# Microsoft Fabric in Azure Government

_Last updated: 2026-05-08_

This page tracks Microsoft Fabric's availability in Azure Government
clouds, the cross-cloud "M365 GCC tenant + Azure Commercial
subscriptions" question, and the recommended interim path for federal
customers who can't wait for Fabric Gov GA.

> **TL;DR.** As of 2026-05-08, **Microsoft Fabric is
> [`Forecasted`](https://learn.microsoft.com/azure/azure-government/documentation-government-product-roadmap)
> across every Azure Government audit boundary** (FedRAMP High, DoD IL4,
> IL5, IL6) — Microsoft has set an internal GA date but has not
> published it. Power BI is the only Fabric-platform component that's
> already GA in Gov. Until Fabric reaches Gov GA, federal customers
> should build on the **Synapse + ADF + Databricks + Purview + Power
> BI** stack — which is exactly what CSA-in-a-Box deploys.

## Current availability matrix

| Cloud / Boundary | Microsoft Fabric (F-SKU platform) | Power BI (component) |
|---|---|---|
| Azure Commercial (Public) | **GA** | GA |
| Azure Government — FedRAMP High | **Forecasted** | GA |
| Azure Government — DoD IL4 | **Forecasted** | GA |
| Azure Government — DoD IL5 | **Forecasted** | GA |
| Azure Government Secret — DoD IL6 | **Forecasted** | GA |
| Azure operated by 21Vianet (China) | Not available (Power BI 21Vianet is a separate, isolated instance) | Available with feature gaps |

Source: [Azure Government GA Roadmap](https://learn.microsoft.com/azure/azure-government/documentation-government-product-roadmap),
retrieved 2026-05-08. Microsoft's roadmap legend defines `Forecasted`
as *"GA date is set"* — a commitment to ship, but no public quarter.

> **Important wording note.** The roadmap uses *audit boundaries*
> (FedRAMP High, IL4, IL5, IL6), not the "GCC / GCC-High / DoD" labels
> that come from Microsoft 365. **GCC** is an M365 environment that
> pairs with **Azure Commercial**. **GCC-High** and **M365 DoD** pair
> with **Azure Government**. This distinction is the source of most
> "wait, can I use Fabric?" confusion.

## The "M365 GCC tenant + Azure Commercial subscriptions" question

A common federal scenario: an agency has a Microsoft 365 GCC tenant
(community gov cloud) but its Azure subscriptions live in Azure
Commercial. Can that customer use Microsoft Fabric today?

### The short answer

**No, not the way you might assume.** Even though Fabric is GA in
Azure Commercial, the GCC tenant home-region requirement and Fabric's
F-SKU licensing rule combine to block this scenario.

### Why

1. **F-SKU licensing rule.** Microsoft Fabric is licensed via Fabric
   capacities (F-SKUs). Power BI's
   [Government availability matrix](https://learn.microsoft.com/fabric/enterprise/powerbi/service-government-us-overview)
   is explicit:

   > "Capacity licensing: Azure Embedded (F SKU) capacities aren't
   > supported in the GCC environment. Only EM and P SKUs are
   > available for use in GCC. Azure Embedded capacities are supported
   > in GCC High and DoD environments."

   F-SKUs **are** supported in GCC High and DoD — but those are paired
   with Azure Government, where Fabric itself is still `Forecasted`.

2. **Tenant home region.** Per the
   [Fabric region availability article](https://learn.microsoft.com/fabric/admin/region-availability):

   > "Your home region is associated with your tenant. If your home
   > region doesn't reside in the following regions, you won't be
   > able to access all the Fabric functionalities."

   The published list covers Azure public-cloud regions only — **no
   `usgov*` regions appear**. A GCC tenant whose home region is a
   `usgov*` region therefore can't access full Fabric, regardless of
   what Azure subscriptions are linked to it.

3. **Azure Lighthouse doesn't bridge the gap.**
   [Azure Lighthouse](https://learn.microsoft.com/azure/lighthouse/overview)
   *can* project management of Azure subscriptions across tenants —
   but it manages Azure resources, not Fabric capacities under a
   different tenant's M365 identity. Lighthouse is not a Fabric
   tenant-bridge.

### Practical options for a GCC customer who wants Fabric today

These are synthesized from the licensing + region rules above. None of
them is a Microsoft-published "do this" article — they're the
defensible options the rules permit.

| Option | Tradeoff |
|---|---|
| **1. Stand up a separate Azure Commercial tenant** with a non-GCC home region. Run Fabric there. | Data flowing into that tenant is no longer in the GCC boundary. Apply Microsoft Purview cross-tenant scan to maintain catalog visibility from the GCC side. Won't satisfy compliance requirements that mandate GCC residency. |
| **2. Wait for Fabric Gov GA**, then migrate. | Time. ADR-0010 covers what to build *today* so the migration is forward-only. |
| **3. Use the interim stack** (Synapse + ADF + Databricks + Purview + Power BI) inside the existing Azure Government subscription. | This is what CSA-in-a-Box deploys. Gov-compatible today; Fabric-parity at the table-format and SQL layer for forward migration. |
| **3a. Use [CSA Loom](fiab/index.md) — the productized form of Option 3.** | Productized SaaS-feel deployment of the Option 3 stack: Loom Console (Fabric workspace experience), Setup Wizard (conversational deploy), parity services (Activator, Mirroring, Direct-Lake-Shim, Data Agents). Free in v1; deploys into your own Azure Gov subscription in 60-100 min. **The recommended path for federal customers wanting the Fabric experience today.** See [CSA Loom](fiab/index.md). |

**Recommendation:** **Option 3a (CSA Loom)** for federal customers
wanting the Microsoft Fabric workspace experience inside their
existing tenant — the productized form of the legacy Option 3.
Use Option 1 only if you have a specific Power BI Direct Lake or
Fabric-only feature requirement that Loom's parity services can't
meet (note: CSA Loom delivers Direct Lake parity via warm-cache
materializer with 5-30s freshness — see [Direct Lake parity](fiab/workloads/direct-lake-parity.md) for the honest gap).

## Capability gaps in Gov today

Because Fabric itself isn't GA in Gov, every Fabric-unique workload is
unavailable there:

- **OneLake** (single tenant-wide namespace) — Commercial-only
- **Direct Lake** (Power BI sub-second over Delta) — Commercial-only
- **Data Activator / Reflex** (declarative event rules) — Commercial-only
- **Real-Time Intelligence** (Fabric KQL DB + Eventstream) — Commercial-only
- **Fabric Data Agents** (natural-language Q&A over Lakehouse) — Commercial-only
- **Fabric Copilot / AI Skills** — Commercial-only

Within Power BI for Gov, several **Power-BI-component features lag**
([Power BI for US Government](https://learn.microsoft.com/fabric/enterprise/powerbi/service-government-us-overview)):

- **Azure Maps** — Not available in GCC, GCC-High, or DoD
- **Bring Your Own Storage (ADLS Gen2)** — Not in GCC; available in GCC-High
- **Autoscale** — Not in GCC; available in GCC-High and DoD

If your design depends on any of these, factor it into your platform
choice — don't assume Power BI Gov is Power BI Commercial.

## Gov-readiness signals from Ignite 2025

Microsoft hasn't named a quarter for Fabric Gov GA, but several
foundation features that **point at Gov readiness** went GA at Ignite
2025 (Nov 2025):

- **Workspace Private Link for Data Factory in Fabric** — GA
  ([Microsoft Fabric Blog: Advancing Data Integration](https://blog.fabric.microsoft.com/en-us/blog/advancing-data-integration-innovations-in-data-factory-in-ms-fabric-at-ignite-2025))
- **Workspace Outbound Access Protection** — GA (same source)
- **Customer-Managed Keys for Fabric items** — GA
  ([Security feature availability in Microsoft Fabric](https://learn.microsoft.com/fabric/security/security-feature-availability))

These don't add Gov regions, but they remove blockers that have to be
in place before Fabric can clear FedRAMP High audit. Treat them as
positive signal.

> **Honest gap:** The community signal as recently as January 2026
> ([Fabric Community thread](https://community.fabric.microsoft.com/t5/Fabric-platform/When-will-Fabric-be-available-for-GCC/m-p/4398348))
> shows Microsoft moderators stating Fabric is "not yet available for
> GCC customers, and Microsoft has not publicly announced a specific
> timeline." Anything more specific than `Forecasted` is third-party
> speculation.

## Recommended interim path (federal customers)

Build on the Gov-available stack. Every component below is GA across
FedRAMP High / IL4 / IL5 (most also IL6) per the
[Azure Government GA Roadmap](https://learn.microsoft.com/azure/azure-government/documentation-government-product-roadmap):

| Layer | Service | Why |
|---|---|---|
| Storage | **Azure Data Lake Storage Gen2** | Lake-first foundation; OneLake-compatible Delta layout for forward migration |
| Orchestration | **Azure Data Factory** | Same engine and concepts as Fabric Data Factory; pipelines move forward 1:1 |
| Transformation (Spark) | **Azure Databricks** | Best-in-class Spark; Unity Catalog gives Fabric-equivalent governance today |
| Transformation (SQL) | **Azure Synapse Analytics** (Dedicated or Serverless SQL pools) | T-SQL surface that maps forward to Fabric Warehouse |
| Real-time / time-series | **Azure Data Explorer (Kusto)** | Same engine that Fabric Real-Time Intelligence uses internally |
| Streaming ingest | **Azure Event Hubs / IoT Hub** | What Fabric Eventstream wraps |
| Catalog and lineage | **Microsoft Purview** | Same catalog plane Fabric uses; coverage is more manual today |
| Reporting | **Power BI** (P-SKU in GCC, F-SKU in GCC-High/DoD) | The only Fabric component that's already Gov-GA |

This is exactly what CSA-in-a-Box deploys via Bicep — see
[`docs/ARCHITECTURE.md`](ARCHITECTURE.md) and the
[`deploy/bicep/`](https://github.com/fgarofalo56/csa-inabox/tree/main/deploy/bicep)
tree.

## Forward migration when Fabric Gov GA arrives

CSA-in-a-Box is designed under [ADR-0010](adr/0010-fabric-strategic-target.md)
to migrate forward into Fabric with low rewrite cost:

| From CSA-in-a-Box | To Fabric (when Gov GA) | Migration effort |
|---|---|---|
| ADLS Gen2 Delta tables | OneLake shortcut → native | Low — shortcut means zero data movement |
| dbt Core models | Fabric Data Factory + dbt | Low — same engine; change connection string |
| Synapse Dedicated SQL | Fabric Warehouse | Medium — re-create schema; T-SQL mostly compatible |
| Databricks notebooks | Fabric Spark notebooks | Medium — runtime swap + Unity Catalog → OneLake catalog |
| Purview catalog | Fabric Purview | Low — Fabric Purview is a superset |
| Power BI semantic models | Fabric / Direct Lake | Low–Medium — re-author for Direct Lake to get sub-second refresh |
| ADF orchestrations | Fabric Data Factory pipelines | Low — UI / JSON formats compatible; some triggers re-author |

See the [CSA-in-a-Box vs Microsoft Fabric comparison](comparison/csa-inabox-vs-fabric.md)
for a feature-by-feature view including which Fabric features have **no
1:1 equivalent** when migrating in either direction (Direct Lake,
Reflex, Fabric Data Agents are Fabric-only).

## Compliance summary

| Question | Answer |
|---|---|
| Is Fabric available in any Azure Gov region today? | No — `Forecasted` across all four boundaries |
| Is Power BI in Gov FedRAMP High / IL4 / IL5 / IL6? | Yes (with F-SKU caveat: GCC uses P-SKU) |
| Is Azure OpenAI available in Azure Gov? | **Yes** — GA across FedRAMP High / IL2 / IL4 / IL5 / IL6 ([compliance scope](https://learn.microsoft.com/azure/azure-government/compliance/azure-services-in-fedramp-auditscope)) |
| Is the **interim stack** (Synapse + ADF + Databricks + Purview) Gov-compliant? | Yes — see [GOV_SERVICE_MATRIX](GOV_SERVICE_MATRIX.md) for service-by-service authorization |
| Can I get a HIPAA BAA in Gov for an Azure-OpenAI-based chatbot? | Yes — Microsoft's HIPAA BAA covers "Azure and Azure Government" via the Microsoft Product Terms ([HIPAA — Azure](https://learn.microsoft.com/azure/compliance/offerings/offering-hipaa-us)). Workload-level HIPAA Security Rule is the customer's responsibility |
| Is Defender for Cloud's AI threat protection available in Gov? | **No** — Microsoft documents this explicitly: *"Clouds: ✅ Commercial clouds ❌ Azure Government"* ([AI threat protection](https://learn.microsoft.com/azure/defender-for-cloud/ai-threat-protection)). Federal customers need to wire equivalent SOC alerting via Azure Monitor + Sentinel custom rules |

The Defender-for-Cloud-AI gap is the single biggest "watch out" for
federal customers building LLM workloads in Gov today. Plan a manual
SOC pipeline that watches Content Safety + Azure Monitor logs.

## How to track this page

The doc author manually re-checks the
[Azure Government GA Roadmap](https://learn.microsoft.com/azure/azure-government/documentation-government-product-roadmap)
quarterly. If you spot a status change before we do, file an issue
labeled `csa-uncovered` — the Copilot drain bot will surface it.

## Related

- ADR: [0010 — Microsoft Fabric strategic target](adr/0010-fabric-strategic-target.md)
- Comparison: [CSA-in-a-Box vs Microsoft Fabric](comparison/csa-inabox-vs-fabric.md)
- Decision tree: [Fabric vs Databricks vs Synapse](decisions/fabric-vs-databricks-vs-synapse.md)
- Compliance: [`GOV_SERVICE_MATRIX.md`](GOV_SERVICE_MATRIX.md), [`compliance/dod-il4-il5.md`](compliance/dod-il4-il5.md), [`compliance/fedramp-moderate.md`](compliance/fedramp-moderate.md)
- Original ask: [#177](https://github.com/fgarofalo56/csa-inabox/issues/177)

## See also

- ← Previous: [Gov Service Matrix](GOV_SERVICE_MATRIX.md)
- → Next: [CSA-in-a-Box vs Microsoft Fabric](comparison/csa-inabox-vs-fabric.md)
- ⌂ Index: [Documentation home](index.md)
