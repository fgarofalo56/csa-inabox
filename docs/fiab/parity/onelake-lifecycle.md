# onelake-lifecycle — parity with OneLake Lifecycle Management / Azure Storage "Lifecycle management"

Source UI:
- Azure portal → Storage account → Data management → **Lifecycle management** (list + rule wizard)
  https://learn.microsoft.com/azure/storage/blobs/lifecycle-management-overview
- Fabric → Workspace → OneLake → **Manage lifecycle** (≤10 rules per workspace)

Backend (Azure-native default, no Fabric dependency): the storage account's
singleton `managementPolicies/default` ARM resource, read/written in FULL via
`GET`/`PUT {arm}/.../storageAccounts/{acct}/managementPolicies/default?api-version=2023-05-01`.
Surfaced through `lib/azure/adls-client.ts` (`getLifecyclePolicy` /
`setLifecyclePolicy`) behind `/api/onelake/lifecycle`. Works with
`LOOM_DEFAULT_FABRIC_WORKSPACE` unset.

## Azure/Fabric feature inventory

| # | Capability (source UI) | Notes |
|---|------------------------|-------|
| 1 | List rules in a grid (name, status, scope, action) | Portal "Lifecycle management" list view |
| 2 | Add rule (guided wizard, no raw JSON in basic mode) | Portal "Add a rule" wizard |
| 3 | Edit an existing rule | Portal pencil / row → edit |
| 4 | Delete a rule | Portal row → delete |
| 5 | Enable / Disable (pause / reactivate) a rule | Portal status toggle → `enabled` flag |
| 6 | Rule scope: whole account or path prefix(es) | `definition.filters.prefixMatch` |
| 7 | Condition: days since modification / last access / creation | `daysAfter{Modification,LastAccessTime,Creation}GreaterThan` |
| 8 | Action: Tier to Cool / Cold / Archive | `baseBlob.tierTo{Cool,Cold,Archive}` |
| 9 | Action: Auto-tier Hot from Cool on access | `enableAutoTierToHotFromCool` (requires tierToCool + last-access) |
| 10 | Action: Delete blob | `baseBlob.delete` |
| 11 | ≤10 rules per workspace ceiling | Fabric OneLake lifecycle limit |
| 12 | Create-from-template presets | Portal common-pattern presets |
| 13 | Workspace ↔ storage-account binding | Fabric workspace → OneLake storage selection |

## Loom coverage

| # | Status | Where |
|---|--------|-------|
| 1 | built ✅ | `lifecycle-rules.tsx` `LoomDataTable` (Name/Status/Scope/Condition/Actions) |
| 2 | built ✅ | `RuleEditorDialog` wizard (dropdowns + checkboxes + SpinButton; no JSON textarea) |
| 3 | built ✅ | row Edit → same wizard, rename-aware upsert |
| 4 | built ✅ | row Delete → PUT filtered ruleset |
| 5 | built ✅ | row Pause/Reactivate → PUT with `enabled` flipped → re-GET confirms `status:Disabled` |
| 6 | built ✅ | Scope dropdown (Entire account / Path prefix) → comma-separated `prefixMatch` |
| 7 | built ✅ | Condition dropdown (3 fields) + days SpinButton (min 1) |
| 8 | built ✅ | Action checkboxes Tier to Cool/Cold/Archive |
| 9 | built ✅ | Auto-tier checkbox (shown only when Tier to Cool checked; validated requires last-access) |
| 10 | built ✅ | Delete action checkbox |
| 11 | built ✅ | client disables Add at 10 + inline error; BFF returns HTTP 422 `rule_limit_exceeded` |
| 12 | built ✅ | "Create from template" menu (5 presets) pre-fills the wizard |
| 13 | built ✅ | `workspace-settings-drawer.tsx` OneLake tab → Storage account binding dropdown → PATCH `storageAccountId` |
| — | honest-gate ⚠️ | missing Storage Account Contributor → MessageBar names role `17d1049b-9a84-46fb-8f53-869881c3d3ab` + bicep module |

Zero ❌, zero stub banners.

## Backend per control

| Control | Backend |
|---------|---------|
| List / refresh | `GET /api/onelake/lifecycle?workspaceId` → `getLifecyclePolicy` → ARM GET `managementPolicies/default` |
| Add / Edit / Delete / Pause / Reactivate | `PUT /api/onelake/lifecycle` → `setLifecyclePolicy` → ARM PUT `managementPolicies/default` (full replace), then re-GET |
| ≤10 enforcement | BFF (`MAX_RULES=10`, HTTP 422) + client Add-disable |
| Storage binding | `PATCH /api/workspaces/[id]` `{ storageAccountId }` (Cosmos); account picker from `GET /api/storage/accounts` |
| Honest gate | ARM 403 → `LifecyclePolicyError code='forbidden'` → `{ gate:true, missing:'Storage Account Contributor (17d1049b-…)' }` |

## Bicep sync

- `platform/fiab/bicep/modules/landing-zone/storage-lifecycle-rbac.bicep` — grants
  Console UAMI **Storage Account Contributor** on the DLZ storage account
  (`Microsoft.Storage/storageAccounts/managementPolicies/write`).
- Wired in `landing-zone/main.bicep` (`storageLifecycleRbac`) +
  `bicep/main.bicep` via `consolePrincipalNeedsLifecycleWrite` (default false,
  set true to enable the feature). Role GUID is global across all Azure clouds;
  ARM host resolves per sovereign boundary via `armBase()`.
