# Release audit — dimension: no-fabric-dep

Audit date: 2026-07-02. Scope: `apps/fiab-console/lib` + `apps/fiab-console/app` (+ the
bicep env wiring that selects backends), enforcing `.claude/rules/no-fabric-dependency.md`.

## Method

1. Ran the rule's canonical detection greps:
   - `needs a Fabric workspace|Bind a capacity-backed Microsoft Fabric|No bound Fabric workspace`
     → **1 hit**, inside the opt-in `LOOM_WAREHOUSE_BACKEND=fabric-warehouse` branch
     (`lib/install/provisioners/warehouse.ts:539`) — allowed (opt-in branch), see F-12.
   - `api.fabric.microsoft.com|api.powerbi.com|onelake.dfs.fabric` → ~120 code hits; each
     triaged as opt-in client, comment, test, or default-path call. Default-path calls found:
     see F-02/F-03/F-04.
2. Audited every `fabricWorkspaceId` read in `lib/install/provisioners/*` for an Azure-native
   fallback in the same function.
3. Audited the `/new` item cards (`lib/catalog/item-types/*`), editor draft/banner copy, and
   admin copy for Fabric-first FRAMING (the eventstream class fixed 06-29), specifically
   kql-dashboard, eventhouse, activator, mirrored-database, semantic-model, report.
4. Verified the bicep env-var wiring that selects the BI backend
   (`platform/fiab/bicep/modules/admin-plane/main.bicep`).

## Overall verdict

The provisioner layer is in strong shape: every canonical Fabric-flavored item
(lakehouse, warehouse, kql-database/eventhouse, kql-dashboard, data-pipeline, eventstream,
activator, mirrored-database, semantic-model, report, notebook, domains, deployment-pipelines,
workspace roles, OneLake security, UDF invoke) has an Azure-native DEFAULT with a silent
fallback when `LOOM_<ITEM>_BACKEND=fabric` is set without a bound workspace. The one systemic
defect is the **Power BI (Fabric-family) BI-backend chain**: bicep silently defaults
`LOOM_BI_BACKEND`/`NEXT_PUBLIC_LOOM_BI_BACKEND` to `'powerbi'` on any deployment without AAS,
and several BI editors call `api.powerbi.com` on mount regardless of opt-in. Plus a cluster of
Fabric-first framing/messaging violations (the class the 06-29 memory flagged as remaining).

---

## Findings

### F-01 (HIGH) — Bicep defaults the BI backend to `powerbi` (Fabric-family) when AAS is not deployed; duplicate conflicting env entries

`platform/fiab/bicep/modules/admin-plane/main.bicep:2893-2894` (loom-console app env):

```bicep
{ name: 'NEXT_PUBLIC_LOOM_BI_BACKEND', value: (!empty(existingAasServerName) || aasEnabled) ? 'aas' : 'powerbi' }
{ name: 'LOOM_BI_BACKEND', value: (!empty(existingAasServerName) || aasEnabled) ? 'aas' : 'powerbi' }
```

`aasEnabled` defaults `false` (line 190) and `existingAasServerName` defaults `''` (line 197),
so a stock deployment (no AAS) ships with the BI backend = **`powerbi`**. The comment above it
even says "'powerbi' is the opt-in Fabric-family path" — but the fallback silently opts IN.
Downstream effect: `lib/editors/phase3/report-editor.tsx:1267-1269` branches
`if (biBackend === 'powerbi') return <ReportLikeEditor …/>` — the live Power BI embed becomes
the DEFAULT report editor, which gates on a real Power BI tenant + workspace ("No Power BI
workspaces … Create one in Power BI" — `workspace-picker.tsx:136-141`). That is exactly the
forbidden pattern: the default path requires Fabric-family infrastructure.

Worse, the SAME app env array carries a **second, conflicting pair** at
`main.bicep:3075-3076`:

```bicep
{ name: 'LOOM_BI_BACKEND', value: loomBackends.bi }        // loomBackends.bi defaults ''
{ name: 'NEXT_PUBLIC_LOOM_BI_BACKEND', value: loomBackends.bi }
```

(`param loomBackends object = { … bi: '' … }` at line 1109/1116, with the comment at
~3071-3074: "Empty (default) → Loom-native renderer … 'powerbi' opts into the Power BI
embed"). Duplicate env names in one Container App env array are at best last-wins and at worst
a deploy-time rejection — the effective default is ambiguous per ACA behavior. Whichever wins,
one of the two definitions is wrong.

**Fix:** delete the 2893-2894 pair (or change its fallback from `'powerbi'` to `''`), keep the
single `loomBackends.bi`-driven pair, and make `'aas'` derivation feed `loomBackends.bi`
instead of a parallel expression.

### F-02 (HIGH) — SemanticModelEditor's default render path is the Power BI editor and calls `api.powerbi.com` on mount

`lib/editors/phase3/semantic-model-editor.tsx:1052-1057`:

```tsx
if (process.env.NEXT_PUBLIC_LOOM_BI_BACKEND === 'aas') {
  return <AasSemanticModelPanel item={item} id={id} />;
}
// PBI editor — picker MUST surface Power BI groupIds …
const ws = usePowerBiWorkspaces();
```

The only branch is `'aas'`; every other value — including the documented Loom-native default
`''` and the bicep fallback `'powerbi'` (F-01) — falls into the Power BI editor, whose first
effect (`usePowerBiWorkspaces`, `workspace-picker.tsx:75-104`) fetches
`/api/powerbi/workspaces` on mount. That route (`app/api/powerbi/workspaces/route.ts:17-23`)
calls `listWorkspaces()` → `powerbi-client.ts:270-273` `call('/groups')` against
`api.powerbi.com` with **no opt-in gate**. Per the rule, "Calling … `api.powerbi.com` on the
default code path" is explicitly forbidden. The in-file comment
(1082-1084: "Power BI is opt-in … only exposes Power BI actions/embed when the Console
identity actually has Power BI workspace access") concedes the gate is
*probe-api.powerbi.com-and-see*, not an explicit env opt-in.

**Fix:** make the dispatch `biBackend === 'powerbi' ? <PbiEditor/> : <AasSemanticModelPanel/>`
(the AAS panel already honest-gates when no AAS server is configured —
semantic-model-editor.tsx:279), and only call `usePowerBiWorkspaces()` inside the
opted-in branch.

### F-03 (HIGH) — DashboardEditor unconditionally calls `api.powerbi.com` on mount

`lib/editors/phase3/dashboard-editor.tsx:52-56`:

```tsx
export function DashboardEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  // PBI editor — picker MUST surface Power BI groupIds …
  const ws = usePowerBiWorkspaces();
```

There is no `NEXT_PUBLIC_LOOM_BI_BACKEND` branch at all — every dashboard-editor render fires
`/api/powerbi/workspaces` → `api.powerbi.com` (see F-02 chain). The file header (lines 5-11)
claims "the Loom dashboard canvas is Azure-native by DEFAULT … NO Power BI / Fabric workspace
is required — the Power BI embed + pin-from-PBI clone path are the opt-in Fabric-family
surface", but the "opt-in" is again a mount-time probe of the forbidden host, and when the
tenant has no Power BI the picker's warning ("No Power BI workspaces … Create one … in
Power BI", `workspace-picker.tsx:136-141`) is rendered on an Azure-native default surface.

**Fix:** gate the `usePowerBiWorkspaces()` call + PBI panels behind
`NEXT_PUBLIC_LOOM_BI_BACKEND === 'powerbi'`; render the Loom tile canvas without any
Power BI call otherwise.

### F-04 (MEDIUM) — PaginatedReportDesigner (default path) probes `api.powerbi.com` on mount

`lib/editors/phase3/paginated-report-editor.tsx:189-199` — the Azure-native RDL designer
(explicitly "the DEFAULT … no Power BI / Fabric", lines 143-150) still runs
`const pbiWs = usePowerBiWorkspaces();` (line 198) on every mount to decide whether to show
the "Live preview (Power BI)" tab (`powerBiConfigured` at line 199). Same forbidden-host-on-
default-path class as F-02/F-03, lower impact because the rest of the designer is fully
functional without it. Note this file also duplicates its own `usePowerBiWorkspaces` +
"No Power BI workspaces" MessageBar (lines 57-135).

**Fix:** show the PBI live-preview tab only when `NEXT_PUBLIC_LOOM_BI_BACKEND === 'powerbi'`
(or a dedicated opt-in flag), and lazy-load the workspace list on tab activation.

### F-05 (MEDIUM) — `/new` card + Learn copy for semantic-model / report / dashboard / paginated-report leads with "live Power BI REST" (Fabric-first framing; the eventstream class)

`lib/catalog/item-types/power-bi.ts`:

- semantic-model (line 15): "In Loom it is wired against **live Power BI REST via the Console
  UAMI**." and step 4 (line 31): "the editor calls live Power BI REST and surfaces 401/403 …
  if the UAMI isn't yet a workspace member."
- report (line 37/39): description "Interactive **Power BI** report…"; overview "In Loom it is
  reframed around embed, refresh, and export against **live Power BI REST via the Console
  UAMI**"; step 4 (line 55): "Export to PDF/PPTX via the Power BI REST export-to-file flow."
- dashboard (line 63): "wired against live Power BI REST via the Console UAMI"; step 4
  (line 79): "If the Console UAMI isn't yet registered in the Power BI tenant…"
- paginated-report (line 87): "wired against live Power BI REST via the Console UAMI."

The ACTUAL defaults are Loom-native: semantic-model provisioner
(`lib/install/provisioners/semantic-model.ts:523-563`, `backend || 'loom-native'`, "No
Power BI / Fabric / Analysis Services workspace is required"), report provisioner
(`report.ts:269-284`, Loom-native viewer), report editor (`report-editor.tsx:1264-1271`,
LoomNativeReportEditor default), paginated-report designer (Azure-native, export via the
paginated-report-renderer Azure Function). This is precisely the "Fabric-first framing"
messaging class fixed for eventstream on 06-29 — the card/Learn copy tells users the item
depends on Power BI when the shipping default does not.

**Fix:** rewrite the four `learnContent` blocks to lead with the Loom-native/AAS default and
mention Power BI as the opt-in alternative (mirror the kql-database / eventstream copy style
in `real-time-intelligence.ts:61-63,139`).

### F-06 (MEDIUM) — Activator editor's Loom workspace picker shows "No Power BI workspaces … Create one in Power BI"

`lib/editors/phase3/activator-editor.tsx:59-118` — the editor's private picker fetches
**Loom** workspaces (`fetch('/api/loom/workspaces')`, line 62), but its empty state
(lines 103-114) renders:

> "No Power BI workspaces — The Console service principal can't see any Power BI workspaces.
> Create one (or get added to one) in Power BI, then Refresh." + a primary **Open Power BI**
> button opening `app.powerbi.com/groups/me/list`.

The Activator is the flagship Azure-native item ("no Microsoft Fabric required", line 692);
an empty Loom workspace list mis-directs the user to create a Power BI workspace — Fabric-first
misdirection on the default path. (Copy was evidently copy-pasted from the PBI flavor of the
picker in `workspace-picker.tsx`.)

**Fix:** change the empty-state copy/CTA to Loom workspaces (link `/workspaces`), or reuse a
Loom-flavored picker.

### F-07 (MEDIUM) — UDF "Generate invocation code" emits Fabric-only client code on the Azure-native default

`lib/editors/phase4/user-data-function-editor.tsx:187-191`:

- notebook target (line 188): `# Fabric Notebook (mssparkutils)` /
  `notebookutils.udf.run(...)` — a Fabric-only API; Loom's default notebooks run on Synapse
  Spark / Databricks where this doesn't exist.
- python target (line 191): `DefaultAzureCredential().get_token("https://api.fabric.microsoft.com/.default")`
  posted to `<UDF_ENDPOINT>/functions/<fn>/invoke` — a Fabric UDF endpoint + audience. The
  Azure-native default backend is an Azure Functions HTTP endpoint with `x-functions-key`
  (`app/api/items/user-data-function/[id]/invoke/route.ts:15-70` — "Fabric (OPT-IN ONLY) …
  never on the default path").

So the generated snippets only work against the opt-in Fabric backend; on the shipped default
they are wrong code presented as the way to call the function (Fabric-first framing + a
vaporware-adjacent correctness gap).

**Fix:** generate the Azure Functions variant by default (`https://<fnapp>.azurewebsites.net/api/<fn>` +
function key header / Entra audience), and emit the Fabric variant only when
`LOOM_UDF_BACKEND=fabric`.

### F-08 (LOW) — Data-product Datasets tab leads with "OneLake / Fabric lakehouse" and a `onelake.dfs.fabric` example

`lib/editors/apim-editors.tsx:3134` — the asset Type dropdown's FIRST option is
`<Option value="fabric_lakehouse">OneLake / Fabric lakehouse</Option>`; line 3141 — the
qualified-name placeholder is
`https://onelake.dfs.fabric.microsoft.com/<ws>/<lh>.Lakehouse/Tables/silver_revenue`.
Loom's default lakehouse is ADLS Gen2 + Delta; the lead option/example should be the
Azure-native `abfss://…dfs.core.windows.net` form, with the Fabric flavor listed after.
Framing only (the field is free text; Purview accepts any qualified name).

### F-09 (LOW) — Tenant-settings "Mirroring" section says replication lands "into OneLake"

`lib/types/tenant-settings.ts:147` (section `mirroring`): description = "Continuous
replication from Azure SQL / Snowflake / Cosmos into OneLake." The default mirror backend is
ADF CDC → ADLS Bronze Delta (`lib/install/provisioners/mirrored-database.ts:10` — "opt-in
alternative … LOOM_MIRROR_BACKEND=fabric"; catalog card `data-factory.ts:120` "into ADLS
Bronze (Delta) — Azure-native CDC, no Fabric required"). Admin-surface copy contradicts the
Azure-native default.

### F-10 (LOW) — Stale provisioner header claims a Fabric-workspace gate that the code no longer has

`lib/install/provisioners/kql-dashboard.ts:28-29`: header says "Remediation gates: —
target.fabricWorkspaceId missing → bind a Fabric workspace." The implementation does the
opposite (line 217 `backend = … || 'adx'`; line 275 "LOOM_DASHBOARD_BACKEND=fabric but no
Fabric workspace bound — falling back to the Azure-native Loom dashboard over ADX"). Doc-rot
that reads like the forbidden default gate and invites regressions.

### F-11 (LOW) — Notebook provisioner reaches Fabric without the env opt-in when a workspace is bound and no Azure engine is configured

`lib/install/provisioners/notebook.ts:324-352`: Fabric is used "when it is the only configured
backend (ws bound, no Synapse/Databricks)" — i.e. `LOOM_DEFAULT_FABRIC_WORKSPACE` bound but
`LOOM_NOTEBOOK_BACKEND` NOT `fabric`. The rule's letter requires BOTH the env opt-in AND a
bound workspace before any Fabric call; here binding a workspace alone flips the backend
(disclosed in `steps` at line 352). A no-Fabric deployment is unaffected (the `!ws` branch at
338-348 gates on the Azure env vars honestly), so impact is low, but it is a
bound-workspace-implies-Fabric behavior the rule pattern-bans elsewhere.

### F-12 (LOW) — Opt-in `fabric-warehouse` backend is a dead-end preview

`lib/install/provisioners/warehouse.ts:533-556`: selecting `LOOM_WAREHOUSE_BACKEND=fabric-warehouse`
(the documented opt-in) always terminates in `status:'remediation'` — either "No bound Fabric
workspace…" (539) or "Fabric Warehouse provisioning is preview… on the v3.4 roadmap" (550-552).
Not a no-fabric violation (default is `synapse-dedicated`, line 26, fully implemented), but the
advertised opt-in alternative doesn't exist; either implement or remove it from docs/env
surface so the opt-in isn't vaporware.

---

## Verified compliant (no finding)

- **Provisioners with silent Azure-native fallback in the same function:** activator
  (`activator.ts:218-226`), data-pipeline (`data-pipeline.ts:60-68`), eventstream
  (`eventstream.ts:223-231`), kql-dashboard (`kql-dashboard.ts:216-277`, honest ADX gate at
  223-234), lakehouse (`lakehouse.ts:853-862`), mirrored-database (`mirrored-database.ts:365-373`),
  semantic-model (`semantic-model.ts:523-563`, loom-native default), report (`report.ts:269-284`),
  warehouse default (`warehouse.ts:26` `synapse-dedicated`).
- **Routes/clients that are genuinely opt-in:** UDF invoke (Fabric only when
  `LOOM_UDF_BACKEND=fabric`, route header 15-24), security-roles Fabric sync (only on explicit
  `action:'sync-to-fabric'` with workspaceId+fabricItemId, route:314-320), workspace-roles
  Fabric mirror (`LOOM_WORKSPACE_ROLES_FABRIC === '1'`, `workspace-roles-client.ts:206-219`),
  domains (`LOOM_DOMAINS_BACKEND` default `'cosmos'`, `domains-client.ts:514-519`), activator
  item routes (default never calls Fabric — `app/api/items/activator/[id]/route.ts:54,103,141`),
  copilot Fabric opt-in (`copilot-orchestrator.ts:1890-1923`, default OFF per
  `tenant-settings.ts` `ai.fabricCopilotOptIn` default:false), Power BI remote MCP
  (`loomBackends.powerBiMcpClientId: ''` = opt-out, bicep:1131; `lib/mcp/catalog.ts:1020-1076`
  fabric-family entries marked opt-in/not gov-safe).
- **Deployment pipelines:** default tab is `'loom'`
  (`lib/components/deployment/deployment-pipelines-pane.tsx:223,230`), backed by the
  Cosmos-only `/api/deployment-pipelines/loom` route; the Fabric tab gates honestly.
- **OneLake-branded surfaces are Azure-backed:** `/onelake` page reads Loom items/workspaces
  (`app/onelake/page.tsx:20-24`), OneLakeSecurityTab enforces real ADLS Gen2 ACLs with the
  Fabric sync hidden unless enabled (`lib/editors/components/onelake-security-tab.tsx:4-14`).
- **`/new` cards for the 06-29 TODO list:** eventhouse / kql-database / kql-dashboard /
  activator / eventstream / mirrored-database copy leads Azure-native
  (`real-time-intelligence.ts:12-211`, `data-factory.ts:120`); the New-item dialog itself
  states "The Azure-native option is the default; Fabric is opt-in only"
  (`new-item-dialog.tsx:487`).
- **Notebook content:** OneLake hosts are substituted out of vendored notebooks to
  `{{ADLS_ACCOUNT}}.dfs.core.windows.net` (`lib/apps/notebook-placeholders.ts:1-27`).
- **Warehouse query-acceleration route:** GPU honestly reported unavailable on the
  Azure-native default with the exact opt-in named
  (`app/api/items/warehouse/[id]/query-acceleration/route.ts:35-73`).

## Suggested fix order

1. F-01 (bicep one-liner; removes the systemic default flip) — do together with F-02/F-03 so
   the editors honor the corrected env.
2. F-02, F-03, F-04 (env-gate the `usePowerBiWorkspaces` mounts).
3. F-05, F-06, F-07 (copy/codegen corrections — the framing wave the 06-29 memory queued).
4. F-08–F-12 (polish/doc-rot).
