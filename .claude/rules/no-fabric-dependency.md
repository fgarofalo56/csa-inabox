# NO HARD DEPENDENCY ON "REAL" MICROSOFT FABRIC — Die-hard global rule

**Effective: 2026-06-03. Scope: every CSA Loom app, item type, object, editor,
provisioner, API route, middleware, content bundle, and bicep module. All
branches, all contributors (human or agent). This rule sits ABOVE convenience
and ABOVE the Fabric-parity rule — parity is achieved with Azure/OSS backends,
NOT by requiring a real Fabric tenant.**

## The rule (verbatim intent from the operator)

> There should be **no requirements or dependencies on "real" Microsoft Fabric**
> for anything in CSA Loom to work or run. No app, item, or object should be
> **un**supported without MS Fabric — every one must be **100% functional
> without a real Fabric capacity or workspace**. Replace any wired-in Fabric
> dependency with **Azure-backed services** (and OSS tools where needed) that
> create a **1:1 match of features, capabilities, and offerings**. Wire it all
> up: backend, API, middleware, and front end.

## What "done" means

1. **No item type, app, or object hard-gates on `fabricWorkspaceId` /
   `LOOM_DEFAULT_FABRIC_WORKSPACE` / a bound Fabric workspace.** A missing
   Fabric workspace is NEVER a blocking remediation. The provisioner falls
   through to its **Azure-native backend, which is the DEFAULT.**
2. **Fabric is strictly opt-in.** A Fabric backend may exist as an *alternative*
   selected explicitly via `LOOM_<ITEM>_BACKEND=fabric` **and** a bound
   workspace. If either is absent, Loom uses the Azure-native path silently —
   no gate, no error, no "bind a Fabric workspace" message as the default.
3. **Feature parity is preserved on the Azure-native path.** The editor's full
   surface, every control, and the real backend call must work against Azure —
   same workflow, same outcome — per `ui-parity.md` and `no-vaporware.md`.

## Canonical Azure-native backend per Fabric-flavored item

| Loom item / object        | Fabric (opt-in only)        | **Azure-native DEFAULT**                                   | Client |
|---------------------------|-----------------------------|------------------------------------------------------------|--------|
| lakehouse                 | OneLake lakehouse           | **ADLS Gen2 + Delta** (+ Synapse table registration)       | `adls-client`, `synapse-sql-client` |
| warehouse                 | Fabric Warehouse            | **Synapse dedicated SQL pool** (`LOOM_WAREHOUSE_BACKEND`)   | `synapse-sql-client`, `synapse-pool-arm` |
| kql-database / eventhouse | Fabric RTI Eventhouse       | **Azure Data Explorer (ADX) cluster**                      | `kusto-client`, `kusto-arm-client` |
| kql-dashboard             | Fabric Real-Time Dashboard  | **Loom-native dashboard over ADX** (tiles query ADX)       | `kql-dashboard-model`, `kusto-client` |
| data-pipeline             | Fabric Data pipeline        | **Synapse pipeline** (or ADF) — delegate to sibling        | `synapse-dev-client`, `adf-client` |
| eventstream               | Fabric Eventstream          | **Azure Event Hubs** (+ Stream Analytics for processing)   | `eventhubs-client`, `stream-analytics-client` |
| activator (Reflex)        | Fabric Activator            | **Azure Monitor scheduled-query alert** (or Logic App)     | `monitor-client` |
| mirrored-database         | Fabric Mirroring            | **ADF CDC / Synapse Link copy → ADLS Bronze Delta**        | `adf-client`, `synapse-dev-client` |
| semantic-model            | Power BI / Fabric model     | **Loom-native tabular layer over warehouse/lakehouse** (Azure Analysis Services optional) | `synapse-sql-client` |
| report                    | Power BI report             | **Loom-native report renderer** over the semantic layer (OSS Superset/Grafana optional) | — |

Power BI counts as Fabric-family — a "real Power BI workspace" requirement is
also a violation. The semantic-model / report Azure-native path must NOT require
a Power BI / Fabric workspace to function.

## Explicitly forbidden

- A `status:'remediation'` gate whose reason is "needs a Fabric workspace" as
  the **default/only** path for any item.
- Calling `api.fabric.microsoft.com` / `api.powerbi.com` / `onelake.dfs.fabric.microsoft.com`
  on the **default** code path. Those hosts may only be reached when a Fabric
  backend is explicitly opted into.
- A content bundle, app, or editor that renders empty / errors when no Fabric
  workspace is bound.
- New code that reads `fabricWorkspaceId` without an Azure-native fallback in
  the same function.

## Allowed (with disclosure)

- A **Fabric backend as an opt-in alternative**, selected via env, fully gated
  behind `LOOM_<ITEM>_BACKEND=fabric` + a bound workspace.
- An honest Azure-side infra gate (e.g. "set `LOOM_EVENTHUBS_NAMESPACE`" or
  "grant the Console UAMI Monitoring Contributor") — that's an Azure
  requirement, not a Fabric one, and is fine per `no-vaporware.md`.

## How to spot a violation

```bash
# Default-path Fabric gates (should return ZERO outside opt-in branches):
grep -rn "needs a Fabric workspace\|Bind a capacity-backed Microsoft Fabric\|No bound Fabric workspace" apps/fiab-console/lib apps/fiab-console/app
# Fabric/Power BI hosts on non-opt-in paths:
grep -rn "api.fabric.microsoft.com\|api.powerbi.com\|onelake.dfs.fabric" apps/fiab-console/lib apps/fiab-console/app
# fabricWorkspaceId reads — each must have an Azure fallback in the same fn:
grep -rn "fabricWorkspaceId" apps/fiab-console/lib/install/provisioners
```

Any hit on a default path is a candidate violation. Triage at every PR.

## Verification per merge

A PR touching any item type must show the item installing + its editor working
**with `LOOM_DEFAULT_FABRIC_WORKSPACE` UNSET** — real Azure backend response in
the receipt. If it only works with a Fabric workspace bound, it is NOT done.
