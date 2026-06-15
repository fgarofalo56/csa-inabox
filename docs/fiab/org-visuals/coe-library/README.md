# CoE Power BI report-template library

A default library of **Cloud Center of Excellence (CoE)** Power BI report
templates for the CSA Loom **Organizational Visuals** surface
(*Admin Portal → Organizational visuals*). Use these to stand up enterprise and
environment-management reporting in minutes, then clone and rebrand them as your
own. They demonstrate the art of the possible for running a cloud estate: track
adoption and maturity, control spend, prove your security and compliance
posture, inventory and de-clutter resources, govern identity and data, and watch
operational health and landing-zone conformance.

Every report is a **version-controlled PBIP** — a Power BI Enhanced Report
(PBIR JSON) plus a TMDL semantic model — so it diffs cleanly in Git, edits in any
text editor or Power BI Desktop, and carries no binary `.pbix`. Each report reads
**your own Azure estate** (Azure Cost Management, Azure Resource Graph, Log
Analytics, Microsoft Defender for Cloud, Microsoft Purview, Microsoft Graph). No
Microsoft Fabric or Power BI workspace is required to browse or clone the library
in Loom — publishing to Power BI is an explicit, opt-in step you run when you
want it.

> Each report ships with clearly-labelled **sample data** so it opens and renders
> immediately. Connect it to live data by setting the Power Query parameters and
> uncommenting the live source block in each table (see *Connecting to live data*).

## The reports

| Report | What it shows | Data it needs |
|---|---|---|
| **CoE Adoption & Maturity Scorecard** | Cloud operating-model maturity (1–5) by pillar against target, adoption signals (active users, workloads onboarded). | Your maturity scorecard (SharePoint list / Dataverse / Cosmos), Azure Monitor / Log Analytics |
| **Cloud Cost / FinOps** | Amortized spend by subscription, resource group, service and cost-center tag; budget variance; untagged-spend leakage. | Azure Cost Management, `Microsoft.Consumption` budgets |
| **Security & Compliance Posture** | Defender for Cloud secure score; Azure Policy regulatory compliance (MCSB, NIST, CIS) by initiative and subscription. | Azure Resource Graph (`securityresources`, `policyresources`), Defender for Cloud |
| **Resource Inventory & Sprawl** | Estate inventory by type / region / subscription; untagged-resource gaps; orphaned-resource waste. | Azure Resource Graph |
| **Identity & Access Governance** | Azure RBAC assignment surface; privileged-role concentration; PIM just-in-time vs standing access. | Azure Resource Graph (`authorizationresources`), Microsoft Graph (PIM) |
| **Data Estate & Governance** | Microsoft Purview catalog coverage by collection/type; classification & ownership coverage; pipeline lineage completeness. | Microsoft Purview (catalog + lineage APIs) |
| **Operational Health / SLA** | Composite availability vs SLA targets; uptime trend; incidents by severity/service; MTTR. | Azure Monitor / Log Analytics (Heartbeat, Alerts) |
| **Landing-Zone Conformance** | Azure Landing Zone design-area conformance from policy compliance, scored by design area and per subscription / management group. | Azure Resource Graph (`policyresources`, `ResourceContainers`), Azure Policy |

The machine-readable index is [`catalog.json`](./catalog.json) (validated by
[`catalog.schema.json`](./catalog.schema.json)) — the same catalog the Loom Org
Visuals feature reads to present the library.

## PBIP structure

Each report is a folder under this directory:

```
<slug>/
  <Name>.pbip                                   # project entry point
  <Name>.Report/
    definition.pbir                             # report + dataset reference (byPath)
    definition/
      report.json                               # report-level settings + theme
      pages/pages.json                          # page order
      pages/<page>/page.json                    # one page
      pages/<page>/visuals/<id>/visual.json     # one visual (PBIR)
    .platform
  <Name>.SemanticModel/
    definition.pbism                            # model settings
    definition/
      model.tmdl                                # model + query order
      database.tmdl                             # compatibility level
      expressions.tmdl                          # the 5 shared parameters
      tables/<Table>.tmdl                        # columns + DAX measures + M source
    .platform
```

## Parameters

Every model exposes five Power Query parameters (in `expressions.tmdl`). Set them
to point a clone at your tenant and subscription:

| Parameter | Purpose |
|---|---|
| `TenantId` | Microsoft Entra tenant (directory) ID |
| `SubscriptionId` | Subscription to scope estate queries to |
| `BillingScope` | Cost Management scope (subscription / RG / billing account / MG) |
| `LogAnalyticsWorkspaceId` | Log Analytics workspace (customer) ID |
| `ManagementApiBase` | ARM endpoint — `https://management.azure.com` (Commercial) or `https://management.usgovcloudapi.net` (Gov) |

## Use it from Loom (browse → preview → clone)

1. Open **Admin Portal → Organizational visuals**. The CoE library renders at the
   top as **Default report templates**.
2. **Preview** a card to inspect its pages, Azure data sources, required roles and
   parameters.
3. **Use this template** clones it into your tenant library. The clone is recorded
   in the `coe-templates` Cosmos container, and — when the org-visuals Blob
   container is wired (`LOOM_ORG_VISUALS_URL`) — the editable PBIP files are copied
   into Blob storage under `coe-templates/<tenantId>/<cloneId>/`. If that env var is
   unset, the clone still saves (metadata only) and the UI shows an honest gate
   naming the variable to set.

## Connecting to live data

In each `tables/<Table>.tmdl`, the partition ships a `Source = #table(...)` step
holding the labelled **sample** rows, with the real, parameterized Azure query
retained immediately above as a commented `// === Live source ===` block. To go
live: set the parameters, then swap the sample step for the live block. The live
queries use the Azure Cost Management connector, the Azure Resource Graph and Log
Analytics REST APIs, the Microsoft Purview catalog API, and Microsoft Graph — each
authenticated with the data-source credential you configure in Power BI.

## Publish to Power BI (opt-in)

Publish the templates into a Power BI / Fabric workspace with the REST-driven,
idempotent helper:

```bash
scripts/csa-loom/publish-coe-reports.sh \
  --workspace-id 46c42501-e97a-4295-8cdb-b1c7000cce1f \
  --param SubscriptionId=<subId> \
  --param TenantId=<tenantId> \
  --param BillingScope=/subscriptions/<subId> \
  --param LogAnalyticsWorkspaceId=<laWorkspaceId> \
  [--slug cloud-cost-finops]     # one report; default = all
```

It publishes the semantic models then the reports (rebinding each report to its
freshly-published model) and rebinds the parameters to your estate. Re-running
updates the items in place. See the script header for the exact permissions and
prerequisites.

### Gov / Azure-native alternative

Per the no-hard-Fabric-dependency rule, Power BI is **opt-in**. Where a Power BI
service is not available (or in Azure Government), render the same semantic models
in **Azure Managed Grafana** over Azure Monitor + Azure Data Explorer — the
underlying KQL / ARG / Cost queries are identical; only the visualization layer
differs. Browsing and cloning the CoE library in Loom never requires Power BI.

## Rebrand

After cloning, apply your own theme and naming: set the report theme in
`<Name>.Report/definition/report.json` (`themeCollection`), rename pages in
`pages/<page>/page.json`, and adjust visual titles in each `visual.json`. Because
everything is text, a find-and-replace across the folder rebrands a whole report.
