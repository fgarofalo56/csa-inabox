---
name: loom-semantic-model-report
description: Azure-native semantic model + report in CSA Loom — build a Loom-native tabular layer over Synapse/warehouse (Azure Analysis Services optional) and render reports natively, never requiring a Power BI / Fabric workspace. Call aas-client.ts + paginated-report-client.ts via /api/powerbi and /api/items. Triggers on semantic model, tabular model, TMSL, DAX, measure, RLS, Power BI, paginated report, RDL, dataset.
allowed-tools: Read, Grep, Glob, Bash
---

# loom-semantic-model-report — Loom-native tabular + report (no Power BI/Fabric workspace)

A Loom **semantic-model** is a **Loom-native tabular layer** (metadata in Cosmos,
evaluated over Synapse SQL / warehouse), with **Azure Analysis Services (AAS)**
as an optional managed tabular engine. A **report** is rendered by the
**Loom-native report renderer**. Neither requires a Power BI / Fabric workspace
on the default path — Power BI counts as Fabric-family.

## Clients

`apps/fiab-console/lib/azure/aas-client.ts` (XMLA TMSL exec + ARM + the Gov gate),
`synapse-sql-client.ts` (the default eval engine), and
`paginated-report-client.ts` (RDL render). `aas-roles.ts` carries RLS/OLS role
authoring. Sovereign scopes come from `cloud-endpoints.ts`
(`aasScope()`, `aasXmlaUrl()`, `pbiXmlaScope()`, and — opt-in only —
`getPbiScope()` / `getPbiEmbedHostname()`).

## Backends (explicit precedence)

1. **Loom-native (DEFAULT)** — tabular metadata in Cosmos, measures evaluated via
   `executeQuery(dedicatedTarget(), …)`. No Power BI, no Fabric, works in every cloud.
2. **AAS (opt-in)** — set the AAS server; TMSL is executed over XMLA via
   `aasXmlaUrl()`. AAS is **Commercial/GCC only** — `aas-client.ts` guards on
   `isGovCloud()` and surfaces an honest "not available in this boundary" gate.
3. **Power BI / Fabric (opt-in)** — only when a workspace is explicitly bound;
   guard with `assertFabricFamilyAvailable('powerbi')`. Never the default.

## Auth

UAMI-first chain. Loom-native uses the SQL scope; AAS uses `aasScope()` (note the
literal `*` subdomain required by the AAS REST auth spec); opt-in Power BI uses
`getPbiScope()` (4-way sovereign split).

## BFF routes

`/api/powerbi/**` and `/api/items/semantic-model|report/[id]/**`. The model route
dispatches on the selected backend (loom-native → AAS → Power BI) and returns
`{ ok, data }`. The report render route returns a real rendered artifact, not a
placeholder.

## Do / don't

- DO default to the loom-native tabular layer; treat AAS and Power BI as opt-in.
- DO author measures/RLS through guided editors (not a raw TMSL textbox as the
  only surface).
- DON'T require a Power BI / Fabric workspace for the default path.
- DON'T call `api.powerbi.com` without `assertFabricFamilyAvailable('powerbi')`.

## Cross-links

UI parity: `docs/fiab/parity/semantic-model.md`, `report.md`, `paginated-report.md`.
Backend map rows: semantic-model / report in `.claude/rules/no-fabric-dependency.md`.
