# PRP — Weave → Power BI Source Integration, Gateways, and Wizard Fixes

**Status:** SHIPPED (2026-07-12) — Waves W1–W6 landed as PRs #1902–#1913, plus
"Get data → Use a Loom item" (#1927): every PBI-sourceable item carries the
"Analyze in Power BI" Weave edge (`analyze-in-powerbi` thread action + route),
with Loom-native and real-PBI-service destinations, VM data gateway default-on
(auto-upgrade to VNet gateway when a capacity is bound), and the W2 Loom-item
source picker in the report Get Data gallery.
**Created:** 2026-07-11 · **Owner:** autonomous build program
**Related rules:** `no-fabric-dependency.md`, `no-vaporware.md`, `ui-parity.md`,
`ux-baseline.md`, `web3-ui.md`, `loom_default_on_opt_out` (memory), `no_scaffold_claims` (memory)
**Memory:** `csa_loom_weave_powerbi_prp.md`

---

## 1. Goal (operator intent, verbatim distillation)

> For **Weave** in Loom: anything that can be a source for a Power BI report (or any
> Power BI item) gets a "Weave → analyze/use in Power BI" option that opens the
> **correct Power BI item type the user picks**, with the Loom item **pre-wired as
> the source** — no manual data-source, auth, or connection config. Works **like MS
> Fabric**. Part of Weave for **any** Loom item supported in Power BI.
>
> Also: **fix all Power BI "add data source" flows** (they get stuck; the per-type
> wizards look bad and don't work). When creating a **new Power BI report**, the user
> can **select from any supported Loom item as a data source** (they work in Loom and
> may not know the underlying Azure service). **Power BI Data Gateways configured by
> default** (VNet + VM per cloud) so Power BI reaches Loom sources **behind private
> endpoints, no public routes**.

### Real-world failure this fixes (operator's Copilot chat, 2026-07-11)
User authoring a serverless T-SQL query asked Loom Copilot to "create a blank Power BI
report with this query wired up as the data source." Copilot **could not** wire the
query — it fell back to an **existing** semantic model ("Real-Time Analytics Semantic
Model"). Root cause = **no item/query-aware source picker** (see §4). Copilot then
looped on a self-audit surfacing config gates instead of completing the task.

---

## 2. Locked operator decisions (AskUserQuestion, 2026-07-11)

| # | Decision | Choice |
|---|----------|--------|
| D1 | Default target of "use in Power BI" | **User picks per click** — dialog offers Loom-native (default, zero PBI dependency) AND real Power BI Service (when workspace+capacity+gateway configured) |
| D2 | Default gateway | **VM-based on-prem data gateway** by default (Pro-only, no premium capacity), **auto-upgrade** to managed VNet data gateway when a Fabric/Premium capacity is bound |
| D3 | PBI capacity/workspace | **Operator HAS one** — will provide Power BI workspace ID + capacity ID; real-PBI path works once given |
| D4 | v1 item scope | **All PBI-source-capable**: lakehouse, warehouse, eventhouse/kql-database, mirrored-database, dataset, semantic-model, data-product (+ the paired serverless/dedicated SQL pool items) |

---

## 3. Current state (from research, 4 agents)

### 3a. Weave / thread (extension point — READY)
- Edges: `apps/fiab-console/lib/thread/thread-actions.ts` → `THREAD_ACTIONS[]`,
  gated by `fromTypes`. Menu/wizard/field-discovery/POST/result-link all generic
  (`lib/components/thread/thread-menu.tsx`, mounted in `item-editor-chrome.tsx:359`).
- Add an edge = append a `ThreadAction` + create `app/api/thread/<id>/route.ts`.
- Template for "create item type X seeded with state Y then open its editor" =
  `app/api/thread/build-loom-report/route.ts` + `createOwnedItem(session,type,{state})`
  (`app/api/items/_lib/item-crud.ts:298`).
- Existing edges: `build-powerbi-model` (external PBI push dataset; warehouse/dedicated
  only), `publish-as-api`. `build-loom-report` (Loom-native report+semantic-model,
  seeded `state.dataSource`).
- Loom PBI item types: `lib/catalog/item-types/power-bi.ts` — `semantic-model`,
  `report`, `dashboard`, `paginated-report` (Loom-native editors).

### 3b. Source coordinates (from provisioners) — PARTIAL
Fully-in-state coordinates exist ONLY for:
- `synapse-serverless-sql-pool`: `secondaryIds.endpoint` (`<ws>-ondemand.sql.azuresynapse.net`) + `.database`
- `eventhouse` / `kql-database`: `secondaryIds.cluster` (ADX URI) + `.database`

Need resolution/reconstruction for:
- `lakehouse` → stamps `adlsRoot` but NOT its SQL endpoint; follow `ITEM_PAIRING_RULES`
  to the paired serverless-SQL-pool item, or reconstruct `<LOOM_SYNAPSE_WORKSPACE>-ondemand.sql...` + `loom_lakehouse`.
- `warehouse` → server FQDN embedded only inside `resourceId` string (`server/db/name`), must parse; `<ws>.sql.azuresynapse.net`.
- `mirrored-database` / `mirrored-databricks` → queryable SQL lives on the paired serverless item, not the mirror.
- `semantic-model` (loom-native default) → NO server coords; AAS is env-only (`LOOM_AAS_XMLA_ENDPOINT`, `LOOM_AAS_SERVER_NAME`).
- `data-product` → governance-only; must resolve referenced lakehouse/warehouse.
Gateway needed for all Synapse-backed (PE) sources; ADX public by default (no gateway unless PE).

### 3c. Power BI editors / wizards — INCONSISTENT + gaps (the "broken/ugly" complaint)
- Report (default/Loom-native) → `report-designer.tsx` `DataSourcePicker` → `GetDataGallery`
  (32-connector catalog). **Polished + working**; every unconfigured path is an honest 412 gate (no mocks).
- Report (`NEXT_PUBLIC_LOOM_BI_BACKEND=powerbi`) → `ReportLikeEditor` has **NO add-source flow** — dead end. **Verify the env flag is not set.**
- Paginated report → `DataSourceDialog` = plain 4-field form (name/type/server/db). **Minimal → "looks bad".**
- Dashboard → 3 tile dialogs (Pin/Q&A/Streaming). Working but no generic source.
- Semantic-model → `INGEST_SOURCES` = 5 **placeholder-M templates** with `<server>`/`<account>` tokens you must hand-edit. **Weak/partially-vaporware feel.**
- **New-report: can only pick an existing `semantic-model`** — NOT lakehouse/warehouse/eventhouse/data-product. Biggest functional gap (matches the Copilot failure).
- Connections: credentials → Key Vault (`connections-store.ts`), non-secret metadata → Cosmos; report `state.dataSource` stores `connectionId`+`objectRef`. OBO passthrough wired in `powerbi-client.ts:100` for embed/refresh/export (NOT for Get Data connection reads — by design).

### 3d. Gateways — NOT BUILT
- Ships delegated subnets default-on: `snet-pp-vnet-gateway` (hub), `snet-pbi-vnet-gateway` (DLZ). **Creates NO gateway resource.**
- **No VM on-prem data gateway module exists anywhere.** Must build.
- VNet gateway is an honest tenant gate (`network-discovery.ts`, `network-pane.tsx`, `app/api/network/vnet-data-gateway/route.ts`).
- **BUG:** `lib/azure/network-discovery.ts:688` hard-codes VNet gateway unavailable in GCC-High/DoD — but MS Learn confirms it IS supported in GCC L4 (VA/TX) + L5 (DoD East). Reconcile.
- PE plane READY: sources PE'd into `snet-private-endpoints` in the same VNet as the gateway subnets.
- Doc: `docs/fiab/powerbi-vnet-gateway.md`.

### 3e. MS mechanism (Learn)
Source (lakehouse→Synapse serverless SQL, warehouse→dedicated SQL, eventhouse→ADX) →
Power BI **semantic model** → reports bind to the model. VNet data gateway reaches
PE sources with no public exposure but **requires Premium/Fabric capacity (F/P SKU)**;
VM on-prem gateway works with Pro only.

---

## 4. Architecture

### 4.1 Core building block — Connection-Coordinate Resolver (NEW)
`apps/fiab-console/lib/azure/pbi-source-resolver.ts`
```
resolvePbiSource(item: WorkspaceItem): Promise<PbiSourceBinding | HonestGate>
```
Given any Loom item, returns a normalized binding:
```
interface PbiSourceBinding {
  connector: 'synapse-sql' | 'adx' | 'adls' | 'azure-sql' | 'databricks' | 'cosmos' | 'postgres';
  server?: string;      // FQDN (Synapse serverless/dedicated, AAS, SQL)
  clusterUri?: string;  // ADX
  database: string;
  defaultTable?: string;
  behindPrivateEndpoint: boolean;   // → needs a gateway on the real-PBI path
  sourceItemId: string;
  loomNativeDataSource: ReportDataSource;  // the seed for the Loom-native path
}
```
Resolution order per item type (§3b): own `secondaryIds` → paired item via
`ITEM_PAIRING_RULES` → env reconstruction (`LOOM_SYNAPSE_WORKSPACE`, `LOOM_KUSTO_CLUSTER_URI`)
→ for `data-product`, resolve the referenced lakehouse/warehouse. Returns an honest
gate (never fabricated coords) when unresolvable. **Unit-tested per item type.**

### 4.2 Weave edge — `analyze-in-powerbi` (NEW)
`ThreadAction` id `analyze-in-powerbi`, group `Visualize`, `fromTypes = PBI_SOURCEABLE`
(the §D4 set + serverless/dedicated pool items). Fields:
- `targetType` select: `report | paginated-report | dashboard | semantic-model`
- `destination` select: `loom-native` (default) | `power-bi-service` (shown only when
  `LOOM_PBI_WORKSPACE_ID` + capacity + gateway configured — else the option carries an
  honest note, per D1)
- source-shaping fields via `showWhen` (table vs query), reusing the resolver's `defaultTable`.
Route `app/api/thread/analyze-in-powerbi/route.ts` branches on `destination`:
- **loom-native** → `createOwnedItem(targetType, {state seeded from resolver.loomNativeDataSource})`, return `link:/items/<targetType>/<id>`. Auto-navigate (catalog pattern).
- **power-bi-service** → create the real artifact in the bound workspace (§4.4).
Records lineage via `recordThreadEdge`.

### 4.3 Loom-native seeding — close the two gaps
- `report`, `semantic-model`: DONE (reuse `build-loom-report` logic).
- `paginated-report` (NEW seed): build the RDL `def` — `dataSources[]` pointing at the
  resolver's server/db + a `datasets[]` SQL over `defaultTable`, one starter `tablix`.
- `dashboard` (NEW seed): mint a semantic-model over the source, seed one starter tile
  referencing it (`LoomTile` query/datasetId).

### 4.4 Real Power BI Service path (opt-in, D1/D3)
When `destination=power-bi-service` + `LOOM_PBI_WORKSPACE_ID`/`LOOM_PBI_CAPACITY_ID` set:
1. Create/ensure a PBI **semantic model** over the source's SQL/ADX endpoint (import or
   DirectQuery), via `powerbi-client.ts`. Bind the **data source connection to the
   gateway** (§4.5) so PE-only sources resolve. Auth = **OBO passthrough** (user's own
   PBI identity, per the just-fixed `powerbi-client.getToken`).
2. For `report`/`dashboard` targets, create the artifact bound to that model
   (`cloneReport`/`addDashboardTile`; Power BI REST has no create-report-bound-to-model
   authoring API beyond clone — seed from a blank template report in the workspace).
3. Return the `app.powerbi.com` deep link + record `toExternal` edge.
Honest gate when workspace/capacity/gateway absent (never silent-fail).

### 4.5 Gateways (D2) — NEW build
- **VM on-prem data gateway module** `platform/fiab/bicep/modules/admin-plane/pbi-vm-data-gateway.bicep`:
  small VM in the hub/DLZ VNet (PE subnet reachable), Custom Script Extension installs
  the standard on-prem data gateway unattended + registers it (recovery key in KV),
  Azure Relay outbound. **Default-on** (`pbiDataGatewayEnabled=true`), Pro-only.
- **Auto-upgrade path**: when `LOOM_PBI_CAPACITY_ID` (Fabric/Premium) is bound, prefer
  the managed **VNet data gateway** (enterprise policy + `vnetaccesslink` on the existing
  delegated subnet). Selector env `LOOM_PBI_GATEWAY_MODE=auto|vm|vnet` (default `auto`).
- **Gateway data-source registration**: on the real-PBI path, register the source
  connection against the active gateway so PBI routes through it (no public route).
- **Gov fix**: correct `network-discovery.ts:688` to allow VNet gateway in GCC L4/L5
  (GCC-High/DoD) per Learn; VM gateway available in every cloud.
- Console `network-pane.tsx`: replace the pure honest-gate with the real gateway status
  + a create/rotate control (VM) and the managed-VNet upgrade CTA.

### 4.6 New-report Loom-item source picker (fixes the Copilot failure + §3c gap)
Extend `DataSourcePicker` (`lib/editors/report/data-source-picker.tsx`) + the new-report
create dialog with a **`loom-item` kind** picker over `PBI_SOURCEABLE` types (the
`ThreadField kind:'loom-item'` already exists). Selecting an item runs the resolver and
seeds `state.dataSource` — user never touches Azure coords. Same picker offered in the
paginated-report and semantic-model source steps for consistency.

### 4.7 Wizard-consistency pass (fixes "look bad / don't work")
- Unify paginated-report `DataSourceDialog` and semantic-model `INGEST_SOURCES` onto the
  **same `GetDataGallery` + Loom-item picker** the report designer uses (Fluent v9 + Loom
  tokens, `ux-standards.md` §7). Kill the placeholder-M templates — real connection bind.
- Verify `NEXT_PUBLIC_LOOM_BI_BACKEND` is NOT `powerbi` in the live deploy (that path has
  no add-source flow). Default to the Loom-native designer.
- Every connector card: real backend or honest 412 gate (no dead cards, no mocks).

---

## 5. Implementation waves

**W1 — Resolver + Weave edge (Loom-native).** `pbi-source-resolver.ts` (+ tests all item
types); `analyze-in-powerbi` edge + route (loom-native branch); paginated-report + dashboard
seed builders. Receipt: Weave→PBI on a lakehouse/warehouse/eventhouse opens a wired
report/paginated/dashboard/semantic-model with real rows.

**W2 — New-report Loom-item source picker.** `loom-item` picker in DataSourcePicker +
create dialog + paginated/semantic source steps. Receipt: create report → pick a Loom
lakehouse item → real rows, no Azure coords typed. (Directly fixes the Copilot chat.)

**W3 — Wizard-consistency + de-vaporware.** Unify paginated + semantic onto GetDataGallery;
remove placeholder-M; verify BI backend flag; per-connector honest gates. Receipt:
screenshots of all 4 editors' source flows, click-walk each connector.

**W4 — VM data gateway (default-on) + Gov fix.** `pbi-vm-data-gateway.bicep`; env wiring;
`network-discovery.ts` Gov correction; `network-pane.tsx` real status. Receipt: clean
deploy stands up the VM gateway; a PBI data source resolves through it to a PE-only Synapse.

**W5 — Real Power BI Service path + gateway registration + auto-upgrade.** power-bi-service
branch of the edge; gateway data-source registration; VNet auto-upgrade when capacity bound.
Requires operator's workspace+capacity IDs (D3) + Power BI delegated consent. Receipt:
Weave→PBI(real) publishes a working report in the bound workspace over a PE source.

**W6 — Docs + parity + bicep-sync.** `docs/fiab/parity/weave-powerbi.md`, gateway doc
rewrite, tenant-bootstrap, ux-standards §7 checklist per surface, env-sync + bicep-sync CI.

Each wave: PR + real-data E2E receipt (no-vaporware), screenshots (web3/ux-baseline),
live side-by-side vs Fabric for 1:1 surfaces (ui-parity), CI green.

---

## 6. Operator asks / blocked items
- **D3:** Power BI workspace ID + capacity ID (F/P SKU) → set `LOOM_PBI_WORKSPACE_ID`,
  `LOOM_PBI_CAPACITY_ID`. Unblocks W5 real-PBI path.
- **Power BI delegated consent** (already outstanding): `Workspace.Read.All`,
  `Report.ReadWrite.All`, `Dataset.ReadWrite.All`, `Content.Create` + admin consent.
- **Gateway recovery key** storage decision (KV) + whether VM gateway may run 24/7 (cost).
- Gov: whether real Power BI Service is in scope for the Gov deployment (Gov PBI is limited;
  VNet gateway L5 supported, but the workspace/capacity must exist in Gov).

## 7. Non-goals (v1)
- Fabric OneLake / DirectLake mode (Fabric-specific; Loom uses Synapse SQL/ADX equivalents).
- Real Power BI paginated-report authoring API (no create API; clone-from-template only).
- Third-party/non-affiliated source connectors beyond the existing catalog.
