# onelake-column-security — parity with Microsoft Fabric OneLake column-level security (CLS)

Source UI: Fabric OneLake item → Manage OneLake data access (security) → **Column-level security** (hide columns from a role).
Learn: https://learn.microsoft.com/fabric/onelake/security/get-started-data-access-roles
Azure-native backend: Synapse **Dedicated SQL pool** column-scope `DENY SELECT` (+ table-level `GRANT`); Serverless masked view for the OPENROWSET path. NO Fabric / Power BI dependency (`no-fabric-dependency.md`).

## Fabric feature inventory (every capability)

| # | Fabric CLS capability | Notes |
|---|------------------------|-------|
| 1 | Pick the table/object the role applies to | role is scoped to a data item |
| 2 | Pick the principal (role / user) the restriction targets | |
| 3 | Multi-select the columns to hide | the columns a role may NOT see |
| 4 | See the resulting "hidden columns" list per role | |
| 5 | Remove a column from the hidden set (un-hide) | |
| 6 | Deny-semantic behavior: a hidden column is omitted from query results | querying it errors |
| 7 | Conflict surfacing when a column is both granted and denied | DENY precedence |
| 8 | Works on the Azure-native backend with no Fabric capacity | per repo rule |

## Loom coverage

| # | Capability | Status | Where |
|---|------------|--------|-------|
| 1 | Table/view picker | ✅ built | `lib/panes/onelake-security-tab.tsx` Dropdown → `GET ?tab=cls&list=tables` (`listSqlTables`) |
| 2 | Principal UPN input | ✅ built | Input → POST body `upn` |
| 3 | Multi-select hidden-column picker | ✅ built | Checkbox list ← `GET ?tab=cls&list=columns&objectId=<n>` (`listSqlColumns`) |
| 4 | Hidden-columns list (per principal) | ✅ built | `LoomDataTable` ← `GET ?tab=cls` (`listColumnDenyGrants`) |
| 5 | Un-hide a column | ✅ built | row "Un-hide" → `DELETE ?tab=cls` (`revokeColumnDeny` → `REVOKE SELECT`) |
| 6 | Deny semantics applied for real | ✅ built | POST `tab=cls` → `denyColumnSelect` emits table `GRANT` + column-scope `DENY SELECT` on the Dedicated pool; Msg 230 on a hidden column |
| 7 | Role-conflict warning | ✅ built | UI cross-checks selected columns + existing DENY rows against column-level GRANT rows; `MessageBar intent="warning"` + per-row "GRANT conflict" badge |
| 8 | Azure-native, no Fabric | ✅ built | all DDL runs on Synapse; honest gate (`NotConfiguredBar`) when the pool isn't wired |
| + | Serverless masked view | ✅ built (opt-in) | "Also generate a Serverless masked view" → `generateMaskedView` `CREATE OR ALTER VIEW` NULL-projecting hidden columns (CLS DENY is Dedicated-only) |

Zero ❌, zero stub banners.

## Backend per control

| Control | Backend call | DDL / query |
|---------|--------------|-------------|
| Table picker | `listSqlTables` | `SELECT … FROM sys.objects WHERE type IN ('U','V')` |
| Column picker | `listSqlColumns` | `SELECT … FROM sys.columns WHERE object_id = @id` |
| Hide columns (apply) | `denyColumnSelect` | `GRANT SELECT ON [s].[t] TO [p]; DENY SELECT ON [s].[t]([c]…) TO [p];` |
| Un-hide | `revokeColumnDeny` | `REVOKE SELECT ON [s].[t]([c]) FROM [p];` |
| Hidden list + conflict source | `listColumnDenyGrants` / `listTableGrants` | `sys.database_permissions` filtered `state_desc='DENY' / 'GRANT'`, `minor_id > 0` |
| Masked view (Serverless) | `generateMaskedView` | `CREATE OR ALTER VIEW [s].[v_t_<role>] AS SELECT …, NULL AS [c], … FROM [s].[t];` |

## Verification (acceptance)

- DENY confirmed in `sys.database_permissions` (`state_desc='DENY'`, `class=1`, `minor_id>0`) after Hide columns.
- A `SELECT` as the restricted role omits the denied column (Msg 230 on explicit reference).
- Overlapping GRANT + DENY on the same `(principal, table, column)` raises the conflict warning in the UI.
- All of the above works with `LOOM_DEFAULT_FABRIC_WORKSPACE` UNSET (Azure-native default).
- Unit: `lib/azure/__tests__/synapse-permissions-client.test.ts` (denyColumnSelect / revokeColumnDeny / listColumnDenyGrants / generateMaskedView).
