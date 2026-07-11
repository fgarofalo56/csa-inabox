# weave-powerbi — parity with Fabric "Analyze in Power BI" / "New report from lakehouse"

Source UI: https://learn.microsoft.com/fabric/data-warehouse/reporting#create-reports
            https://learn.microsoft.com/power-bi/connect-data/service-lakehouse-power-bi-report
            https://learn.microsoft.com/power-bi/connect-data/service-dataset-build-permissions ("Analyze in Power BI")
            https://learn.microsoft.com/data-integration/vnet/create-data-gateways
            https://learn.microsoft.com/data-integration/gateway/service-gateway-onprem

Resolver: `apps/fiab-console/lib/azure/pbi-source-resolver.ts` (W1)
Weave edge: `apps/fiab-console/lib/thread/thread-actions.ts` (`analyze-in-powerbi`, `PBI_SOURCEABLE`)
            `apps/fiab-console/app/api/thread/analyze-in-powerbi/route.ts` (W1 loom-native branch)
Item source route: `apps/fiab-console/app/api/items/[type]/[id]/pbi-source/route.ts` (W2)
Loom-item picker: `apps/fiab-console/lib/editors/report/loom-item-source-picker.tsx` (W2)
                  `apps/fiab-console/lib/editors/report/data-source-picker.tsx` (W2 `loom-item` kind)
                  `apps/fiab-console/lib/editors/report/pbi-binding.ts` (W2/W3 pure mappers)
Wizard unification: `apps/fiab-console/lib/editors/report/get-data-gallery.tsx` (W3)
                    `apps/fiab-console/lib/editors/phase3/paginated-report-editor.tsx` (W3)
                    `apps/fiab-console/lib/editors/phase3/semantic-model-editor.tsx` (W3)
Gateway (bicep): `platform/fiab/bicep/modules/admin-plane/pbi-vm-data-gateway.bicep` (W4, default-on)
                 `platform/fiab/bicep/modules/admin-plane/main.bicep` (`pbiDataGatewayEnabled=true`)
Gateway (status + Gov fix): `apps/fiab-console/lib/azure/network-discovery.ts` (W4)
                            `apps/fiab-console/app/api/network/pbi-gateway/route.ts` (W4)
Real Power BI Service path: `apps/fiab-console/lib/thread/pbi-service-gate.ts` (W5, pure gate/config helpers)
                            `apps/fiab-console/app/api/thread/analyze-in-powerbi/route.ts` `handlePowerBiService()` (W5 `power-bi-service` branch)
                            `apps/fiab-console/lib/azure/powerbi-client.ts` (`createPushDataset` / `postPushRows` / `cloneReport` / `addDashboard` / `bindToGateway` / `listGateways`)

> **What this surface is.** In Fabric, any lakehouse / warehouse / KQL database /
> semantic model can be turned into a Power BI item ("New report", "Analyze in
> Power BI", "New paginated report") with the object **pre-wired as the source** —
> no manual data-source, auth, or connection config. CSA Loom builds the same via
> the **Weave → "Analyze in Power BI"** edge plus a **Loom-item source picker** in
> the new-report / paginated / semantic-model flows.
>
> **Azure-native by default (`no-fabric-dependency.md`).** The DEFAULT target is a
> **Loom-native** Power BI item (report / paginated-report / dashboard /
> semantic-model) bound to the Azure-native backend the source sits on — Synapse
> serverless (lakehouse / mirror), Synapse dedicated (warehouse), or Azure Data
> Explorer (eventhouse / KQL database). This path needs **NO Fabric capacity, no
> Power BI workspace, and no `api.powerbi.com` call** — the resolver only ever
> emits Azure coordinates and honest gates. A **real Power BI Service** publish
> target is an **opt-in alternative** the user picks per click (operator decision
> D1), shipped in W5 — see rows 13a-13d.

## Source-UI feature inventory (grounded in Learn + live portal)

In Fabric the flow is: pick a data item → choose the Power BI artifact type →
Fabric mints the artifact with the item bound as the source (no coordinates
typed) → the artifact opens in its editor over live data. A VNet or on-premises
data gateway carries queries to sources behind private endpoints.

| # | Fabric / Power BI capability | Behavior in the real UI |
| --- | --- | --- |
| 1 | "Analyze in Power BI" from a data item | One click from a lakehouse / warehouse / KQL DB / semantic model → a report pre-bound to that item |
| 2 | Pick the target artifact type | Report · Paginated report · Dashboard · Semantic model |
| 3 | New report from a lakehouse / warehouse | New-report dialog offers any queryable item as the source; no server/DB typed |
| 4 | Auto-build a default semantic model | Lakehouse / warehouse SQL analytics endpoint yields an auto model the report binds to |
| 5 | Source shaping (table vs. query) | Bind a specific table or a SQL/KQL query as the artifact source |
| 6 | Live column/schema preview | The source's real columns are shown before/after binding |
| 7 | Get Data connector gallery | Rich connector catalog (SQL, Synapse, ADX, ADLS, files, …) for add-source flows |
| 8 | Paginated report over a data source | RDL data source + dataset + tablix seeded from the picked source |
| 9 | Dashboard tile over a source | Pin a tile (real-time KQL / model DAX) referencing the source |
| 10 | VNet data gateway to private sources | Managed gateway reaches PE-locked sources with no public route (needs Premium/Fabric capacity) |
| 11 | On-premises (standard) data gateway | VM-hosted gateway; Azure Relay outbound; works with Pro (no premium capacity) |
| 12 | Gateway data-source registration | Bind a semantic-model / connection to a gateway so PBI routes through it |
| 13 | Publish artifact to a workspace | The minted report/model lands in a Power BI workspace on a capacity |
| 14 | Lineage from source → report | Fabric shows the source→model→report lineage graph |

## Loom coverage

Legend: built ✅ · honest-gate ⚠️ (renders + names the exact operator prerequisite,
per `no-vaporware.md`) · MISSING ❌.

| # | Capability | Status | Wave | Where |
| --- | --- | --- | --- | --- |
| 1 | "Analyze in Power BI" from a data item | ✅ | W1 | `analyze-in-powerbi` `ThreadAction` (`thread-actions.ts`), mounted on every `PBI_SOURCEABLE` item's Weave menu |
| 2 | Pick the target artifact type | ✅ | W1 | `targetType` field: `report \| paginated-report \| dashboard \| semantic-model` (`analyze-in-powerbi/route.ts` `TARGET_TYPES`) |
| 3 | New-report / add-source Loom-item picker | ✅ | W2 | `LoomItemSourcePicker` + `loom-item` kind in `data-source-picker.tsx`; also wired into paginated + semantic source steps |
| 4 | Auto-build a semantic model over the source | ✅ | W1 | `mintSemanticModel()` introspects real columns (Synapse `executeQuery` / ADX content) → Loom-native `semantic-model` item |
| 5 | Source shaping (table vs. query) | ✅ | W1 | `effectiveRead()` — `sourceShape=auto\|table\|query`; SQL validated by `readOnlySelect` (`sql-guard`); resolver `defaultTable` fallback |
| 6 | Live column/schema preview | ✅ | W2 | `pbi-source` route returns `preview.columns`; `LoomItemSourcePicker` renders the real column table |
| 7 | Get Data connector gallery in add-source flows | ✅ | W3 | `GetDataGallery` now shared by paginated (`DataSourceDialog`) + semantic-model ("Get data") steps; placeholder-M templates removed |
| 8 | Paginated report seeded from the source | ✅ | W1 | `route.ts` builds `RdlReportDefinition` (dataSource + dataset + tablix), persisted via `upsertRdlDefinition` |
| 9 | Dashboard tile over the source | ✅ | W1 | `route.ts` dashboard branch: real-time `streaming-adx` tile (ADX) or `dax` tile over a minted model (Synapse), saved to `pbiDashboardOverlaysContainer` |
| 10 | Managed VNet data gateway to PE sources | ⚠️ | W4 | `getVnetDataGatewayReadiness()` + delegated `snet-pp-vnet-gateway` (default-on). Binding the gateway itself is a Fabric/Power BI tenant action (needs Premium/Fabric capacity) — honest prerequisite checklist |
| 11 | On-premises (standard) VM data gateway | ✅ | W4 | `pbi-vm-data-gateway.bicep` (default-on `pbiDataGatewayEnabled=true`) stands up the VM + installs the gateway unattended; `getPbiVmGatewayStatus()` shows live power state |
| 11a | Gateway register-to-tenant (one-time) | ⚠️ | W4 | `Connect-DataGatewayServiceAccount` + `Add-DataGatewayCluster` needs a Power BI admin sign-in Loom cannot perform — recovery key in KV (`pbi-gateway-recovery-key`); emitted as an honest gate (bicep `registrationGate` output + Network pane `registrationNote`) |
| 12 | Auto-upgrade VM → managed VNet gateway | ✅ | W4 | `resolveRecommendedGatewayMode(mode, capacityBound)` — `auto` prefers `vnet` once `LOOM_PBI_CAPACITY_ID` binds; selector `LOOM_PBI_GATEWAY_MODE` (default `auto`) |
| 13 | Real Power BI Service publish target (opt-in, D1) | ✅ | W5 | `resolveDestination()` (`pbi-service-gate.ts`) + `handlePowerBiService()` route branch; user picks `destination=power-bi-service` per click, OBO passthrough auth (signed-in user's Power BI identity) |
| 13a | Publish a real semantic model over the source | ✅ | W5 | `buildPbiPushModel()` → `createPushDataset` + `postPushRows` (Synapse: real introspect + sample rows; ADX: schema, rows load on refresh) |
| 13b | Publish a real report bound to the model | ✅ | W5 | `resolveTemplateReportId()` + `cloneReport(ws, template, {targetModelId})` — clone-from-template (Power BI REST has no create-report-bound-to-model API) |
| 13c | Publish a real dashboard | ✅ | W5 | `addDashboard()` alongside the bound report (pin-from-visual is the one manual step — no Power BI pin-from-dataset REST API) |
| 13d | Bind a PE source to a registered gateway | ✅ | W5 | `listGateways()` + `gatewayGate()` + `bindToGateway(ws, datasetId, gatewayId)` so refresh routes through the gateway (no public path) |
| 14 | Lineage source → target | ✅ | W1/W5 | `recordThreadEdge()` — loom-native edge (W1); real-PBI `toExternal` edge with the `app.powerbi.com` deep link (`powerBiItemLink`, W5) |

**Zero ❌.** Every capability — including the opt-in real Power BI Service path
(rows 13, 13a-13d) — is built. The remaining honest gates are genuine operator
prerequisites, never a default gate: the managed VNet gateway needs a
Fabric/Premium capacity (row 10); the gateway needs a one-time Power BI-admin
registration (row 11a); and the real-PBI path honest-gates (422) when
`LOOM_PBI_WORKSPACE_ID` / `LOOM_PBI_CAPACITY_ID` are unset, when a PE source has
no registered gateway, when a report/dashboard target has no
`LOOM_PBI_TEMPLATE_REPORT`, or on a 401/403 (missing delegated Power BI consent /
workspace membership) — each naming the exact remediation. The **Azure-native
Loom-native path is always complete and self-service** with none of these set.

## Backend per control

| Control | Backend it calls |
| --- | --- |
| `resolvePbiSource(item)` | Reads the item's provisioned `state` (`secondaryIds`, `content`) + reconstructs from `LOOM_SYNAPSE_WORKSPACE` / `LOOM_SYNAPSE_DEDICATED_POOL` / `LOOM_KUSTO_CLUSTER_URI`. Pure — no network. Returns an Azure-native `PbiSourceBinding` or an honest `{ gate }` |
| `pbi-source` route preview | Synapse TDS `executeQuery()` (`synapse-sql-client`) for SQL sources; ADX schema read from item `content` for eventhouse/KQL |
| `analyze-in-powerbi` → semantic-model | `introspectSynapseColumns()` (real TDS) / `adxColumnsFromContent()` → `createOwnedItem('semantic-model', …)` (Cosmos) |
| `analyze-in-powerbi` → report | `createOwnedItem('report', { state.dataSource })` seeded from the resolver (`direct-query` / `semantic-model` / `adls-file`); ADX → routed to a dashboard tile |
| `analyze-in-powerbi` → paginated-report | Real column introspection → `upsertRdlDefinition()` (`paginated-report-client`) |
| `analyze-in-powerbi` → dashboard | ADX `streaming-adx` tile (Kusto) or minted-model `dax` tile → `pbiDashboardOverlaysContainer` upsert (Cosmos) |
| Weave lineage | `recordThreadEdge()` (`thread-edges`) → Cosmos edge store |
| VNet gateway readiness | Reader-only ARM: `Microsoft.PowerPlatform` RP registration + subnet-delegation scan (`network-discovery.ts`); no Fabric/PBI host call |
| VM gateway status | Reader-only ARM: `Microsoft.Compute/virtualMachines` list + `instanceView` for `vm-loom-pbigw-*` (`getPbiVmGatewayStatus`) |
| VM gateway provisioning | `pbi-vm-data-gateway.bicep`: NIC (PE subnet) + Windows VM + `runCommands` (unattended `Install-DataGateway`) + KV secrets + Console-UAMI Reader grant |
| Real-PBI destination decision | `resolveDestination()` / `readPbiServiceConfig()` / `pbiServiceConfigGate()` / `sourceNeedsGateway()` / `gatewayGate()` / `pickActiveGatewayId()` / `powerBiItemLink()` — pure, unit-testable gate/config helpers (`pbi-service-gate.ts`) |
| Real-PBI model | `createPushDataset()` + `postPushRows()` (`powerbi-client`), Power BI REST, **OBO passthrough** (signed-in user's Power BI identity); Synapse `executeQuery` supplies real columns + sample rows |
| Real-PBI report / dashboard | `listReports()` → `cloneReport()` (template clone bound to the new model) / `addDashboard()` (`powerbi-client`), Power BI REST |
| Real-PBI gateway binding | `listGateways()` + `bindToGateway()` (`powerbi-client`) — binds the PE source connection to the registered gateway |
| Real-PBI lineage | `recordThreadEdge({ toExternal:true, toLink: powerBiItemLink(...) })` → Cosmos edge store + `app.powerbi.com` deep link |

## Cloud boundary

| Boundary | VM on-prem gateway (default) | Managed VNet data gateway |
| --- | --- | --- |
| Commercial | ✅ deployed default-on | ⚠️ available (needs Premium/Fabric capacity + tenant registration) |
| GCC (L2) | ✅ deployed default-on (registration uses the portal flow — DataGateway PS cmdlets unsupported in GCC L2) | ❌ not offered in this boundary (use the Azure-native PE plane) |
| GCC-High (L4 / IL5) | ✅ deployed default-on | ⚠️ available (corrected in W4 `evaluateVnetGatewayReadiness` — was previously mis-flagged unavailable) |
| DoD (L5) | ✅ deployed default-on | ⚠️ available (corrected in W4) |

The **VM on-premises data gateway is available in every cloud** and is the
Loom default. The **managed VNet data gateway** availability was corrected in W4
(`network-discovery.ts`) to match Microsoft Learn — supported in Commercial,
GCC-High (L4), and DoD (L5); **not** offered in GCC L2. Where the VNet gateway
is unavailable, the Azure-native private-endpoint plane is the equivalent.

## Verification

- **Loom-native path** (`LOOM_DEFAULT_FABRIC_WORKSPACE` and `LOOM_PBI_WORKSPACE_ID`
  UNSET): Weave → "Analyze in Power BI" on a lakehouse / warehouse / eventhouse →
  the chosen report / paginated / dashboard / semantic-model opens pre-wired to
  the Azure-native backend with real rows (`no-fabric-dependency.md` receipt).
- **New-report picker**: create a report → "Pick a Loom item" → choose a lakehouse
  → real columns preview, no Azure coordinates typed (fixes the Copilot
  source-wiring gap that motivated the PRP).
- **Gateway**: a clean deploy stands up `vm-loom-pbigw-<loc>`; the Network pane
  shows its live power state; the register-to-tenant step is surfaced as the one
  honest gate.
- **Real Power BI Service path** (`destination=power-bi-service`, with
  `LOOM_PBI_WORKSPACE_ID` + `LOOM_PBI_CAPACITY_ID` set + delegated consent):
  Weave → "Analyze in Power BI" publishes a real push-dataset semantic model
  (and a template-cloned report / dashboard) into the bound workspace over live
  Power BI REST as the signed-in user, PE sources routed through the registered
  gateway — returning the `app.powerbi.com` deep link. Every missing prerequisite
  is an honest 422 gate naming the exact env var / consent / gateway registration.

Related rules: `ui-parity.md`, `no-vaporware.md`, `no-fabric-dependency.md`,
`ux-baseline.md`, `web3-ui.md`. Source PRP: `PRPs/active/weave-powerbi/PRP.md`.
