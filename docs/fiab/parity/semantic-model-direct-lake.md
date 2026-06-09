# semantic-model-direct-lake — parity with Fabric Direct Lake (semantic model storage mode)

Source UI: Microsoft Fabric — semantic model **Storage mode → Direct Lake**, and the
Power BI service **Scheduled refresh / refresh history** pane.
Learn: https://learn.microsoft.com/fabric/fundamentals/direct-lake-overview ·
https://learn.microsoft.com/power-bi/connect-data/asynchronous-refresh

## Why a shim (no-fabric-dependency.md)

True Direct Lake — VertiPaq reading Delta/Parquet directly from OneLake with
sub-second framing — requires a **Fabric F-SKU**, which is **not available in
Azure Government**. Per `no-fabric-dependency.md` the Loom semantic-model path
must be 100% functional on Azure-native backends. The **Direct-Lake-shim**
delivers the same *outcome* (a model that reflects new Delta rows within an SLA)
on Azure: Power BI Premium / PPU **enhanced refresh** over the Analysis Services
(XMLA) data plane, triggered by ADLS Gen2 `_delta_log` **Event Grid**
notifications. Freshness is 5–30 s (partition-scoped), not sub-second — disclosed
honestly in the UI. The shim is strictly **opt-in** (`LOOM_DIRECT_LAKE_SHIM_ENABLED`);
the editor is fully functional without it.

## Fabric/Power BI feature inventory  (Direct Lake storage mode surface)

| # | Capability (Fabric / Power BI) | Notes |
|---|--------------------------------|-------|
| 1 | Storage mode = Direct Lake (vs Import / DirectQuery) | The model reflects Delta source changes without a manual import. |
| 2 | Delta source binding (the OneLake/Lakehouse Delta table the model reads) | Direct Lake points at Delta tables in OneLake. |
| 3 | Freshness / framing cadence | How quickly source writes are reflected. |
| 4 | Per-table refresh / fallback policy (Import vs DirectQuery fallback) | Direct Lake falls back to DirectQuery when over guardrails; per-table policy. |
| 5 | Refresh history / run log | Power BI refresh-history pane (requestId, status, start, duration). |
| 6 | Change-driven (event-based) framing | Source commit triggers reframe. |

## Loom coverage

| # | Capability | Status | Loom surface |
|---|-----------|--------|--------------|
| 1 | Storage mode = Direct Lake (shim) | ✅ built | SemanticModelEditor → **Direct Lake (shim)** tab. Existing Import/DirectQuery `targetStorageMode` still shown in the header. |
| 2 | Delta source binding (ADLS Gen2) | ✅ built | "ADLS Gen2 Delta source path" field (abfss:// or https dfs/blob), persisted to the shim Cosmos config. |
| 3 | Freshness SLA | ✅ built | SLA picker — 5 min / 15 min / 1 hr / On change (Event Grid trigger). |
| 4 | Per-table refresh policy | ✅ built | One `<Select>` per model table: Partition / Full / DirectQueryFallback / Composite (1:1 with the C# `RefreshPolicyKind`), + partition-column input for Partition. |
| 5 | Refresh / shim run log | ✅ built | "Shim run log" table — last 10 enhanced-refresh runs (requestId, type, status, start, duration) from Power BI. |
| 6 | Change-driven framing | ⚠️ honest-gate when disabled | Event Grid system topic + Service Bus subscription status badge. When `LOOM_DIRECT_LAKE_SHIM_ENABLED` / `LOOM_DIRECT_LAKE_SHIM_QUEUE_ID` are unset, the tab renders the honest setup MessageBar instead. |

Zero ❌. The only non-functional state is the documented infra gate.

## Backend per control

| Control | Backend |
|---------|---------|
| Load tab (GET) | `GET /api/items/semantic-model/[id]/direct-lake` → Cosmos `direct-lake-config.refresh-policies` (config) + Power BI enhanced-refresh history (`aas-client.listShimRefreshHistory`) + Event Grid system-topic status (ARM). |
| Configure shim (Save, PUT) | `PUT …/direct-lake` → upserts the `SemanticModelConfig` doc to Cosmos (`direct-lake-config-store`) **and** best-effort ensures the Event Grid system topic + Service Bus subscription (`eventgrid-client.ensureShimSubscription`, ARM PUT). |
| Run log | Power BI **enhanced refresh** REST `GET /groups/{ws}/datasets/{id}/refreshes` via `aas-client`, sovereign-correct host (`getPbiGovHost`) + audience (`aasScope`). |
| Honest gate | `aas-client.shimEnabled()` (env `LOOM_DIRECT_LAKE_SHIM_ENABLED`) drives the MessageBar; `LOOM_DIRECT_LAKE_SHIM_QUEUE_ID` gates the Event Grid wiring. |

## Runtime topology (deployed by aas.bicep)

```
ADLS Gen2 Delta write → _delta_log/<n>.json (BlobCreated)
   → Event Grid system topic (loom-dl-shim-<account>)
   → Event Grid subscription → Service Bus queue (loom-dl-shim-events)
   → loom-direct-lake-shim container app (DeltaLogEventHandler)
   → TomRefreshClient → Power BI Premium XMLA enhanced refresh (partition-scoped)
   → warm AAS cache reflects new rows within the SLA (5–30 s)
```

## Sovereign matrix (verified against Microsoft Learn)

| | Commercial | GCC | GCC-High | DoD |
|--|-----------|-----|----------|-----|
| AAS/XMLA scope (`aasScope`) | analysis.windows.net | analysis.usgovcloudapi.net | high.analysis.usgovcloudapi.net | mil.analysis.usgovcloudapi.net |
| Power BI host (`getPbiGovHost`) | api.powerbi.com | api.powerbigov.us | api.powerbigov.us | api.powerbigov.us |
| Event Grid system topics | GA | GA | GA | GA |
| Service Bus as EG destination | GA | GA | GA | GA |
| True Direct Lake (Fabric F-SKU) | available, not required | not available | not available | not available |

(power-bi/developer/embedded/embed-sample-for-customers-national-clouds — the
GCC / DoDCON / DoD `scopeBase` values.)

## Verification

- `lib/azure/__tests__/direct-lake-shim.test.ts` — 19 green (sovereign scope/XMLA
  matrix, ADLS URI parse/build round-trip, shim gate, policy-enum mirror).
- `npx tsc --noEmit` — clean on all touched files.
- `az bicep build` — `aas.bicep` + `main.bicep` compile clean.

## Acceptance (live receipt, operator-run)

1. Set `LOOM_DIRECT_LAKE_SHIM_ENABLED=true`; deploy `aas.bicep` (queue + system topic).
2. Point the tab at a real Delta table (e.g. `abfss://gold@<acct>.dfs…/fact_sales`),
   pick SLA = 5 min, table policy = Partition (partition col `order_date`). Save.
3. `EVALUATE { COUNTROWS(FactSales) }` (XMLA) → record **before** row count.
4. Append new Delta rows to a partition. The `_delta_log` commit → Event Grid →
   Service Bus → shim → partition refresh.
5. "Refresh status" → newest run shows `Completed` within the SLA.
6. Re-run the DAX count → **after** > before.
7. Receipt = before/after row count + the shim run-log row (requestId, duration).
