# Fabric → Azure-native mapping

CSA Loom implements every Fabric-flavored item type on an **Azure-native default
backend**. Nothing in Loom requires a Microsoft Fabric capacity, a Fabric
workspace, or a Power BI workspace to work — that is a die-hard product rule
(`.claude/rules/no-fabric-dependency.md`). A Fabric or Power BI backend may exist
as an **explicit opt-in alternative**, selected via an `LOOM_<ITEM>_BACKEND=fabric`
environment flag **and** a bound workspace; if either is absent, Loom silently
uses the Azure-native path.

This page is the canonical map. For the complete list of all 118 item types by
workload, see the [item catalog](item-catalog.md).

## Canonical mapping (the headline items)

| Loom item / object | Fabric equivalent (opt-in only) | **Azure-native DEFAULT** |
|---|---|---|
| Lakehouse | OneLake lakehouse | **ADLS Gen2 + Delta** (+ Synapse table registration) |
| Warehouse | Fabric Warehouse | **Synapse dedicated SQL pool** |
| KQL database / Eventhouse | Fabric RTI Eventhouse | **Azure Data Explorer (ADX) cluster** |
| KQL dashboard | Fabric Real-Time Dashboard | **Loom-native dashboard over ADX** (tiles query ADX) |
| Data pipeline | Fabric Data pipeline | **Synapse pipeline** (or Azure Data Factory) |
| Eventstream | Fabric Eventstream | **Azure Event Hubs** (+ Stream Analytics for processing) |
| Activator (Reflex) | Fabric Activator | **Azure Monitor** scheduled-query alert (or Logic App) |
| Mirrored database | Fabric Mirroring | **ADF CDC / Synapse Link copy → ADLS Bronze Delta** |
| Semantic model | Power BI / Fabric model | **Loom-native tabular layer** over warehouse/lakehouse (Azure Analysis Services optional) |
| Report | Power BI report | **Loom-native report renderer** over the semantic layer (OSS Superset/Grafana optional) |
| Notebook / Spark job | Fabric notebook / SJD | **Synapse Spark** (or Azure Databricks, opt-in) |
| Data agent | Fabric Data Agent | **Azure OpenAI / AI Foundry** over Loom's copilot backend |
| Fabric IQ (Ontology / Graph / Digital twin) | Fabric IQ | **Cosmos + ADX graph (Kusto `make-graph`) + Azure Digital Twins-style model** |
| Fabric Apps (Rayfin) | Fabric data apps | **Azure Functions + Cosmos DB + Static Web Apps** |

!!! warning "Power BI counts as Fabric-family"
    A "real Power BI workspace" requirement is also a Fabric dependency and is a
    rule violation. The semantic-model and report Azure-native paths render on a
    Loom-native tabular + report layer and do **not** require a Power BI or Fabric
    workspace to function.

## Storage and namespace

| Capability | CSA Loom (Azure-native) | Fabric |
|---|---|---|
| Storage primitive | **ADLS Gen2** + a unified path tree | OneLake (single tenant-wide namespace) |
| Shortcuts | **Loom Shortcuts** — ADLS external-location pointers (cross-cloud) | OneLake shortcuts |
| RBAC enforcement | Engine-layer (Unity Catalog / Purview / Synapse / ADX) | Storage-protocol layer (OneLake Security) |

## What "opt-in Fabric" actually means

A Fabric backend is reached **only** when both are true:

1. `LOOM_<ITEM>_BACKEND=fabric` is set for that item type, **and**
2. a Fabric (or Power BI) workspace is explicitly bound.

If either is missing, Loom uses the Azure-native default **silently** — there is
no "bind a Fabric workspace" gate, no error, and no empty editor. The Fabric hosts
(`api.fabric.microsoft.com`, `api.powerbi.com`, `onelake.dfs.fabric.microsoft.com`)
are never called on the default path.

## Honest Azure-side gates are fine (and expected)

The no-Fabric rule does **not** forbid honest Azure requirements. When an
Azure-native backend isn't provisioned yet, the editor renders fully and shows a
Fluent MessageBar (`intent="warning"`) naming the exact remediation — for example
"set `LOOM_EVENTHUBS_NAMESPACE`" or "grant the console UAMI Monitoring
Contributor". That is an **Azure** requirement, not a Fabric one, and is allowed
per `.claude/rules/no-vaporware.md`.

## Related

- [What is CSA Loom](index.md)
- [Architecture](architecture.md)
- [Item catalog](item-catalog.md)
- [CSA Loom vs Microsoft Fabric](../comparison/csa-loom-vs-fabric.md)
