# lakehouse-permissions — parity with Synapse/Fabric "Manage permissions" (table/column/row security)

Source UI:
- Synapse SQL access control — https://learn.microsoft.com/azure/synapse-analytics/guidance/security-white-paper-access-control
- T-SQL feature support (Dedicated vs Serverless) — https://learn.microsoft.com/azure/synapse-analytics/sql/overview-features#security
- Column-level security — https://learn.microsoft.com/azure/synapse-analytics/sql-data-warehouse/column-level-security
- Row-level security — https://learn.microsoft.com/sql/relational-databases/security/row-level-security
- Fabric warehouse "Manage permissions" / object-level SQL GRANT — https://learn.microsoft.com/fabric/data-warehouse/sql-granular-permissions

Editor: `apps/fiab-console/lib/editors/lakehouse-editor.tsx` (Permissions dialog)
F8 sub-section: `apps/fiab-console/lib/panes/onelake-security-tab.tsx`
Route: `apps/fiab-console/app/api/lakehouse/permissions/route.ts`
       `apps/fiab-console/app/api/lakehouse/permissions/rls-test/route.ts` (F8 test-predicate)
Client: `apps/fiab-console/lib/azure/synapse-permissions-client.ts`
        `apps/fiab-console/lib/azure/rls-predicate.ts` (F8 predicate sanitizer)

This is F13 — extending the container-RBAC-only Permissions dialog to the SQL
data plane. Azure-native, **no Fabric dependency** (no-fabric-dependency.md):
all SQL grants execute against the Synapse **Dedicated SQL pool** over the
existing AAD-token TDS path. A real Power BI / Fabric workspace is never
required.

## Azure/Fabric feature inventory (grounded in Learn)

| # | Capability | Where in Azure/Fabric |
|---|---|---|
| 1 | Container/object RBAC (Storage Blob Data Reader/Contributor/Owner) | Portal IAM / Storage |
| 2 | Object-level `GRANT SELECT ON schema.table TO principal` | SSMS Securables / Synapse SQL |
| 3 | Column-level `GRANT SELECT ON schema.table(cols) TO principal` | Synapse column-level security |
| 4 | Row-level security: `CREATE SECURITY POLICY` + inline filter TVF | Synapse RLS (Dedicated only) |
| 5 | Enumerate existing grants / policies | `sys.database_permissions`, `sys.security_policies` |
| 6 | Revoke object/column grant; drop security policy | `REVOKE`, `DROP SECURITY POLICY` |
| 7 | Principal picker resolving to UPN (not raw OID) | Entra people-picker |
| 8 | Create DB user for Entra principal on first grant | `CREATE USER … FROM EXTERNAL PROVIDER` |
| 9 | RLS subject = `USER_NAME()` / `SUSER_SNAME()`, db_owner bypass | RLS predicate pattern |
| 10 | Serverless: RLS unsupported → guidance to use a filtering view | overview-features#security |
| 11 | **Free-form filter predicate** authored in a code editor (F8) | Synapse/Fabric RLS — author writes the `WHERE` body of the inline TVF |
| 12 | Preview rows a given identity would see under a predicate before saving | SSMS `EXECUTE AS USER` round-trip |

## Loom coverage

| # | Status | Notes |
|---|---|---|
| 1 | ✅ | Object (RBAC) tab — unchanged ARM path; now shows UPN when `LOOM_GRAPH_USERS_ENABLED` |
| 2 | ✅ | Table tab → POST `tab=table` → `grantTableSelect` (no columns) |
| 3 | ✅ | Column tab → checkbox multi-select → POST `tab=column` with `columnIds[]` |
| 4 | ✅ | Row tab → table + filter-column + subject pickers → `createRlsPolicy` (TVF + policy) |
| 5 | ✅ | GET `tab=table\|column` → `listTableGrants`; GET `tab=row` → `listRlsPolicies` |
| 6 | ✅ | Revoke buttons → DELETE; drop policy → DELETE `tab=row&policyObjectId` |
| 7 | ✅ | Table/Column tabs use `/api/admin/permissions/principals` user search → UPN; SQL users ARE the UPN |
| 8 | ✅ | `ensureUserClause` emits `CREATE USER [upn] FROM EXTERNAL PROVIDER` if absent |
| 9 | ✅ | `Match against` dropdown (allow-listed); predicate `@cmp = <subject> OR IS_MEMBER('db_owner')=1` |
| 10 | ⚠️ | Honest gate: Row tab only runs on Dedicated. When `LOOM_SYNAPSE_DEDICATED_POOL` unset, all SQL tabs show a precise MessageBar (env var to set). Serverless RLS guidance documented here. |
| 11 | ✅ | **F8** — `OnelakeRlsPredicateEditor` (`lib/panes/onelake-security-tab.tsx`): Monaco T-SQL WHERE editor (1000-char, regex-validated, @cmp-aware IntelliSense) → POST `tab=row` with `whereClause` → `createRlsPolicyWithPredicate` (parse/bind probe → inline TVF `WHERE (<predicate>) OR IS_MEMBER('db_owner')=1` → `CREATE SECURITY POLICY`). Preview badge; OR-union/owner-bypass note. |
| 12 | ✅ | **F8** — "Test predicate" → POST `/api/lakehouse/permissions/rls-test` → `testRlsPredicate`: `SELECT TOP n * … WHERE (<predicate>)` with `@cmp` bound to the filter column and `USER_NAME()`/`SUSER_SNAME()` bound to the test identity (defaults to the caller UPN). Returns live filtered rows. |

Zero ❌. The only non-functional state is the honest infra-gate (#10) when the
Dedicated SQL pool isn't configured — full UI still renders.

## Backend per control

| Control | Backend |
|---|---|
| Object RBAC grant/revoke/list | `Microsoft.Authorization/roleAssignments` (ARM) at container scope |
| OID → UPN enrichment | Microsoft Graph `/v1.0/users/{id}?$select=userPrincipalName` (opt-in via `LOOM_GRAPH_USERS_ENABLED`) |
| Table/Column grant + revoke | Synapse Dedicated TDS `GRANT/REVOKE SELECT` (catalog-resolved identifiers) |
| Table/column enumeration | `sys.objects`, `sys.schemas`, `sys.columns` over TDS |
| Grant enumeration | `sys.database_permissions` (class=1, SELECT, GRANT) + `sys.columns` |
| RLS create/drop | `CREATE/DROP SECURITY POLICY` + inline `WITH SCHEMABINDING` TVF in `LoomSecurity` schema |
| RLS free-form predicate (F8) | `createRlsPolicyWithPredicate` — `validateWhereClause` → parse/bind probe → `CREATE FUNCTION`/`CREATE SECURITY POLICY` over the Dedicated pool |
| RLS predicate test (F8) | `testRlsPredicate` → `SELECT TOP n` over the live table, predicate applied with `@cmp`→filter column and identity functions→test UPN |
| RLS enumeration | `sys.security_policies` + `sys.security_predicates` |

## Injection safety

No user string is interpolated into DDL. Schema/table/column identifiers are
resolved from the `sys.*` catalog by integer object_id / column_id and
bracket-quoted (`]` doubled); the principal UPN is bracket-quoted for the
identifier and `N''`-escaped for the existence-check literal; the RLS subject
expression is chosen from a fixed allow-list (`USER_NAME()`, `SUSER_SNAME()`).
Covered by `lib/azure/__tests__/synapse-permissions-client.test.ts`.

For the **F8 free-form predicate**, the predicate body is the only user-authored
SQL that reaches the DDL. It is sanitized by `validateWhereClause`
(`lib/azure/rls-predicate.ts`, a dependency-free module shared by the BFF and
the editor): ≤ 1000 chars; no `;`, no `--` / `/* */`, no `'` literal, no
DDL/DML/exec/set-operator/subquery keywords, and it must reference `@cmp`. A
parse/bind probe (`SELECT TOP 0 1 WHERE (<predicate>) …`) runs **before** any
`DROP`, so a predicate that passes the regex but is still invalid T-SQL returns
a precise SQL error and never leaves the table unprotected. In the test path the
only substituted tokens — `@cmp`→bracket-quoted column, identity functions→
`N''`-escaped test UPN — are escaped, so the rest of the validated clause is the
sole embedded text.

## Per-cloud

| | Commercial | Gov (GCC-H / IL5) |
|---|---|---|
| Graph | `graph.microsoft.com` | `graph.microsoft.us` via `LOOM_GRAPH_BASE` |
| Synapse TDS host | `*.sql.azuresynapse.net` (default) | `*.sql.azuresynapse.us` via `LOOM_SYNAPSE_HOST_SUFFIX` |
| Token audience | `database.windows.net/.default` (same both clouds) | same |

When Graph is unreachable (e.g. IL5 cross-tenant restriction) the OID→UPN
enrichment degrades gracefully — the Object tab falls back to the OID prefix;
the SQL-plane tabs are unaffected because their principals are already UPNs.

## Bicep / bootstrap

- `platform/fiab/bicep/modules/admin-plane/main.bicep` — wires
  `LOOM_SYNAPSE_WORKSPACE`, `LOOM_SYNAPSE_DEDICATED_POOL` (pre-existing) and the
  new `LOOM_SYNAPSE_HOST_SUFFIX` env var onto loom-console.
- `.github/workflows/csa-loom-post-deploy-bootstrap.yml` — new step creates the
  Console UAMI as a `db_owner` contained user on the Dedicated pool DB and
  pre-creates the `LoomSecurity` schema (the RLS predicate functions live there).

## Verification

`pnpm vitest run lib/azure/__tests__/synapse-permissions-client.test.ts`
(15 green — object/column GRANT, fixed + **free-form (F8)** RLS DDL, the F8
predicate sanitizer, and the test-predicate substitution). Live walk
(LOOM_DEFAULT_FABRIC_WORKSPACE UNSET): open a lakehouse → Permissions →
Table tab grants SELECT on a Synapse table to a UPN; Column tab restricts to a
column subset (a `SELECT *` by the constrained principal then fails on the hidden
columns); Row tab creates a SECURITY POLICY so the principal sees only matching
rows; in the **Custom WHERE predicate** sub-section, author `@cmp = USER_NAME()`,
**Test predicate** returns the live rows the test identity would see, **Save
policy** creates `LoomSecurity.pol_rls_<table>` (confirm with
`SELECT name, is_enabled FROM sys.security_policies`), and an invalid predicate
(`@cmp = USER_NAME(); DROP TABLE x`) is rejected with a precise error and creates
no policy. Principals display as UPNs throughout.
