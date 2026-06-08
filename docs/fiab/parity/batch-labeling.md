# batch-labeling — parity with Microsoft Purview / Power BI bulk sensitivity labeling

Source UI:
- Microsoft Purview compliance portal → Information protection → bulk label / auto-labeling
- Power BI / Fabric admin portal → tenant-wide sensitivity label application
- Power BI Admin REST `Information Protection - Set Labels As Admin`
  (https://learn.microsoft.com/rest/api/power-bi/admin/information-protection-set-labels-as-admin)

CSA Loom surface: `/admin/batch-labeling` (admin shell section "Batch labeling").

## Azure / Fabric feature inventory

| # | Capability (real portal/API) | Notes |
|---|------------------------------|-------|
| 1 | Multi-select a set of items/assets to label | Purview bulk action + PBI admin multi-artifact |
| 2 | Pick one sensitivity label from the tenant label set | MIP labels (real GUIDs) + org-defined labels |
| 3 | Apply the label to all selected in one action | PBI `setLabels` takes up to 2000 artifacts/request |
| 4 | Per-item success/failure outcome | PBI returns ChangeLabelStatus per artifact: Succeeded / Failed / NotFound / InsufficientUsageRights / FailedToGetUsageRights |
| 5 | Label persists as catalog metadata | Purview asset classification / label on the asset |
| 6 | Label propagates to the BI artifact | PBI semantic model / report / dashboard / dataflow |
| 7 | Honest gate when prerequisites missing | e.g. SP not a Fabric admin → 401/403 surfaced |

## Loom coverage

| # | Status | Where |
|---|--------|-------|
| 1 | built ✅ | Checkbox column in the picker `LoomDataTable`; Select all / Clear |
| 2 | built ✅ | Label dropdown (Loom-native + MIP groups, with color swatches) |
| 3 | built ✅ | "Apply to N items" → `POST /api/admin/batch-labeling` |
| 4 | built ✅ | Results `LoomDataTable`: Cosmos / Purview / Power BI columns, green Succeeded / red failure verbatim |
| 5 | built ✅ (Cosmos always) / honest-gate ⚠️ (Purview opt-in) | Cosmos `state.sensitivityLabel`; Purview `addAssetClassification` when `LOOM_PURVIEW_ACCOUNT` set |
| 6 | honest-gate ⚠️ | `setLabelsAsAdmin` when MIP GUID + `LOOM_POWERBI_ADMIN_LABELS=true` + Console UAMI = Fabric admin |
| 7 | built ✅ | MessageBars name the exact env var / role; per-row 401/403 shown verbatim, no fake success |

Zero ❌, zero stub banners. The Cosmos write is unconditional and real; Purview
and Power BI are opt-in checkboxes that only appear when their backing service
is configured, and each surfaces the true backend status per item.

## Backend per control

| Control | Backend |
|---------|---------|
| Item list | `GET /api/admin/batch-labeling` → Cosmos `workspaces` + `items` cross-partition query |
| Loom labels | Cosmos `tenant-settings` doc `sensitivity-labels:<tenantId>` |
| MIP labels | Microsoft Graph `GET /beta/security/informationProtection/sensitivityLabels` (mip-graph-client) |
| Apply → Cosmos | `itemsContainer().item(id, ws).replace()` writing `state.sensitivityLabel` (+ `sensitivityLabelId`, `sensitivityLabeledAt/By`) |
| Apply → Purview | `searchPurview(name)` match → `addAssetClassification(guid, [label])` (Atlas v2) |
| Apply → Power BI | `setLabelsAsAdmin(artifacts, labelGuid)` (POST `/admin/informationprotection/setLabels`) |

## Verification (real-data E2E)

Run with `LOOM_DEFAULT_FABRIC_WORKSPACE` UNSET (Azure-native default path):

1. `GET /api/admin/batch-labeling` returns the tenant's real Cosmos items +
   Loom labels (+ MIP labels when `LOOM_MIP_ENABLED=true`).
2. Select 10 items, pick a label, Apply → 10 Cosmos `item.replace()` writes;
   each item's `state.sensitivityLabel` is updated (verify via
   `GET /api/governance/catalog` showing the new `sensitivity`).
3. Results grid shows 10 rows; Cosmos column green "Succeeded". A bad item id
   (or wrong workspaceId) yields a red row with the verbatim error / `not_found`.
4. With Purview configured + the Purview checkbox on, matched assets show
   "Succeeded"; unmatched show "NotFound" — never fabricated success.
5. With a MIP label + `LOOM_POWERBI_ADMIN_LABELS=true` + the PBI checkbox on,
   linked artifacts show the exact `setLabels` ChangeLabelStatus; if the UAMI is
   not a Fabric admin the rows show the 401/403 text in red.
