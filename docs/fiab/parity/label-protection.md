# label-protection — parity with Microsoft Purview protected sensitivity labels

**Scope:** F19 (export protection), F20 (protected-label change-rights gate),
F21 (protected label → real Azure RBAC on the backing store).

**Source UI / behavior:**
- Microsoft Purview / Fabric "Protected sensitivity labels"
  (https://learn.microsoft.com/purview/sensitivity-labels) and Fabric governance
  protected-label rules (CSV/TXT export blocked; change requires EXPORT/EDIT).
- Microsoft Graph beta `sensitivityLabel.hasProtection` + `ownerEmail` rights
  filter (`usageRightsInfo`).

**Azure-native, no Microsoft Fabric / Power BI dependency** (per
`.claude/rules/no-fabric-dependency.md`). The protection tier is enforced as a
positive Azure RBAC role grant — Azure deny assignments are Azure-managed only
and cannot be created by an application.

## Feature inventory → Loom coverage

| Capability (real behavior) | Loom coverage | Backend |
|---|---|---|
| Detect that a label carries encryption (`hasProtection`) | ✅ `isProtectedLabel` | Graph beta `GET /security/informationProtection/sensitivityLabels/{id}` (`hasProtection`) |
| Block CSV/TXT export of a protected item (format strips protection) | ✅ `checkExportProtection` + `POST /api/items/[type]/[id]/export-check` + grid MessageBar | Graph label read; pure format rule |
| Hard-block export when caller lacks EXPORT usage right | ✅ `checkExportProtection(rights)` | Graph `ownerEmail` rights filter (`usageRightsInfo.allowExport`) |
| Block changing/removing a protected label without rights | ✅ `checkLabelChangeRights` + `PATCH …/sensitivity-label` → 403 | Graph `ownerEmail` filter → `allowExport \|\| allowEdit` |
| Apply protected label → adjust real access on backing store | ✅ `enforceLabelRbac` → `enforceAccessGrant` | ARM `Microsoft.Authorization/roleAssignments` (ADLS) · Synapse SQL role · ADX db role |
| Map sensitivity rank → permission tier (read vs write) | ✅ `sensitivityToPermission` (>=3 → read-only) | — |
| Persist the applied grant for later adjustment | ✅ `state.labelRbacGrant` in Cosmos item | Cosmos `items` container |
| Rights eval unavailable in Gov clouds | ⚠️ honest gate (null → "contact your Purview admin"; CSV still blocked by format) | Graph host via `LOOM_MIP_GRAPH_BASE` (graph.microsoft.us / dod-graph.microsoft.us) |
| MIP not wired in the deployment | ⚠️ honest gate — 503 `mip_not_configured` (PATCH) / `warning` (export-check) | `LOOM_MIP_ENABLED` |
| Console UAMI lacks RBAC-Admin on the lake account | ⚠️ honest gate — ARM 403 surfaced as `{status:'error',detail}` | `label-rbac-grants.bicep` grants Role Based Access Control Administrator |
| Item type with no Azure backing scope | ⚠️ honest gate — `{status:'pending',detail}` | `resolveItemBackingScope` |

Zero ❌ — every row is built or an honest infra gate.

## Per-cloud

| Feature | Commercial | GCC | GCC-High | IL5/DoD |
|---|---|---|---|---|
| `hasProtection` read | ✅ | ✅ | ✅ (`graph.microsoft.us`) | ✅ (`dod-graph.microsoft.us`) |
| Per-user EXPORT/EDIT rights | ✅ | ✅ | ⚠️ honest gate (filter may 404) | ⚠️ honest gate |
| CSV/TXT format block | ✅ | ✅ | ✅ (format rule, no Graph) | ✅ |
| RBAC enforcement (ADLS/SQL/ADX) | ✅ | ✅ | ✅ (Gov ARM host) | ✅ |

## Bicep sync

- `platform/fiab/bicep/modules/admin-plane/label-rbac-grants.bicep` — Console
  UAMI → **Role Based Access Control Administrator**
  (`f58310d9-a9f6-439a-9e8d-f62e7b41a168`) on the DLZ ADLS account, scoped to
  `resourceGroup(loomDlzRg)`. Wired in `admin-plane/main.bicep` next to
  `adx-export-rbac`. `LOOM_MIP_ENABLED=true` and `LOOM_SYNAPSE_DEDICATED_POOL`
  are already in the console `apps[].env`.

## Verification

- `vitest run lib/azure/__tests__/label-protection.test.ts` — 18 green
  (isProtectedLabel / sensitivityToPermission / checkExportProtection /
  resolveItemBackingScope / checkLabelChangeRights / enforceLabelRbac).
- `tsc --noEmit` — touched files clean.
- E2E receipts (minted-session) belong in the PR body.
