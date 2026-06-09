# semantic-model-security-rls-ols — parity with Power BI / Analysis Services "Manage roles" (RLS + OLS)

Source UI:
- Power BI Desktop / Service **Manage roles** (Modeling → Manage roles) — row-level security DAX filters
- Analysis Services tabular **Roles** (object-level security: table/column visibility)
- **View as** / test-as-role (Power BI Desktop "View as roles", SSAS `EffectiveUserName`)
- Learn: https://learn.microsoft.com/power-bi/enterprise/service-admin-rls ,
  https://learn.microsoft.com/analysis-services/tabular-models/object-level-security ,
  https://learn.microsoft.com/analysis-services/tabular-models/roles-ssas-tabular

Backend (Azure-native default — **no Fabric/Power BI workspace required**):
- **Azure Analysis Services** XMLA endpoint (`LOOM_AAS_SERVER`), SPN auth. The
  default path; needs no Fabric/Power BI tenant.
- **Power BI Premium / Fabric capacity** XMLA endpoint (`LOOM_POWERBI_XMLA_ENDPOINT`)
  — opt-in alternative (Fabric-family), Console UAMI auth.

Both are reached via XMLA-over-HTTP (SOAP) TMSL from `lib/azure/aas-client.ts`.
BFF: `app/api/items/semantic-model/[id]/roles/route.ts`. UI: the **Security
(RLS/OLS)** tab in `SemanticModelEditor` (`lib/editors/phase3-editors.tsx`).

## Azure/Power BI feature inventory → Loom coverage

| Capability (real UI)                                   | Loom coverage | Backend per control |
|--------------------------------------------------------|---------------|---------------------|
| List model roles                                       | ✅ Roles grid (Section 1) | `getRoles()` → XMLA Discover `TMSCHEMA_ROLES` (+ TABLE/COLUMN_PERMISSIONS, ROLE_MEMBERSHIPS) |
| Create role                                            | ✅ "Add role" | client state → `setRoles()` TMSL `createOrReplace` on Save |
| Rename role                                            | ✅ inline name `Input` | TMSL on Save |
| Delete role                                            | ✅ per-row Delete | TMSL on Save (role omitted from createOrReplace set) |
| Row-level security DAX filter per table                | ✅ per-table `Textarea` DAX editor (Section 2) + live `validateRlsDax` | `tablePermissions[].filterExpression` |
| OLS — hide whole table (None/Read)                     | ✅ table `Select` None/Read (Section 3) | `tablePermissions[].metadataPermission='none'` |
| OLS — hide column (None/Read)                          | ✅ per-column `Select` None/Read | `columnPermissions[].metadataPermission='none'` |
| Role membership (users / groups)                       | ✅ Members `Input` (comma-separated UPN/object-id) | `roles[].members[]` |
| Service principals not allowed as members              | ✅ honest caption | (enforced by Power BI/AAS; surfaced in UI) |
| Test as role / View as roles                           | ✅ Test-as-role panel (Section 4): UPN + role + DAX → result grid | `testAsRole()` XMLA Execute w/ `EffectiveUserName` + `Roles` |
| Restricted role returns only filtered rows             | ✅ result grid is the receipt | XMLA impersonation |
| OLS-hidden column absent from query output             | ✅ hidden columns absent from result columns | XMLA impersonation |
| Model permission (Read)                                | ✅ fixed `read` (XMLA-only supported value) | `roles[].modelPermission='read'` |
| Honest gate when no engine configured                  | ⚠️ MessageBar names `LOOM_AAS_SERVER` / XMLA endpoint to set | `aasConfigGate()` 501 |

Zero ❌, zero stub banners. The previous config-tab stub ("RLS role authoring is
XMLA / Desktop only") is removed and replaced by this fully-functional tab.

## Per-cloud backend matrix

| Cloud         | `aasSuffix()`                 | `pbiXmlaScope()`                                          | Notes |
|---------------|-------------------------------|----------------------------------------------------------|-------|
| Commercial    | `asazure.windows.net`         | `https://analysis.windows.net/powerbi/api/.default`      | SPN admin `app:{clientId}@{tenantId}` |
| GCC           | `asazure.windows.net`         | `https://analysis.windows.net/powerbi/api/.default`      | runs on Commercial Azure |
| GCC-High/IL5  | `asazure.usgovcloudapi.net`   | `https://analysis.usgovcloudapi.net/powerbi/api/.default`| |
| DoD (IL6)     | n/a — AAS not offered         | n/a                                                      | `aasConfigGate()` returns a DoD gate |

## Verification (receipt)

With `LOOM_DEFAULT_FABRIC_WORKSPACE` UNSET and `LOOM_AAS_SERVER` pointed at an
AAS model that has a `Sales` table with a `Region` column:

1. Add role `East`, set `Sales` row filter `[Region] = "East"`, set OLS on
   `Customer.SSN` = None, Save (deploys TMSL `createOrReplace`).
2. Test as role `East`, UPN `analyst@contoso.com`, query `EVALUATE Sales`.

Receipt = the test-as-role JSON (`{ ok:true, rows:[…], rowCount }`): only
East-region rows are returned, and `SSN` is absent from the column set — proving
both RLS and OLS are enforced server-side by the tabular engine.

## Bootstrap

See `docs/fiab/v3-tenant-bootstrap.md` → "Analysis Services — RLS/OLS Security
tab". Summary:
- **AAS path**: deploy `analysis-services.bicep` (aasEnabled=true + aasSpnClientId),
  store the SPN secret in KV → `LOOM_AAS_CLIENT_SECRET`, deploy model DBs.
- **Power BI XMLA path**: enable XMLA Read-Write on the capacity + the tenant
  "Allow XMLA endpoints" setting, add the Console UAMI as a workspace Member, set
  `LOOM_POWERBI_XMLA_ENDPOINT`.
