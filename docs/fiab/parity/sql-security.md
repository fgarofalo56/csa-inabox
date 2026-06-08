# sql-security — parity with Azure SQL / Synapse SQL granular security

Source UI:
- Azure SQL portal → Security → **Dynamic Data Masking**, **Transparent data
  encryption**, and the SSMS / query-editor security DDL surface
- Synapse Studio → SQL pool → security (GRANT, RLS, DDM via T-SQL)
- Learn:
  - GRANT (object): https://learn.microsoft.com/sql/t-sql/statements/grant-object-permissions-transact-sql
  - Column-level security: https://learn.microsoft.com/azure/synapse-analytics/sql-data-warehouse/column-level-security
  - Row-Level Security: https://learn.microsoft.com/sql/t-sql/statements/create-security-policy-transact-sql
  - Dynamic Data Masking: https://learn.microsoft.com/sql/relational-databases/security/dynamic-data-masking
  - Serverless T-SQL feature matrix (RLS unsupported): https://learn.microsoft.com/azure/synapse-analytics/sql/overview-features

## Azure/SQL feature inventory → Loom coverage

| Capability | Loom coverage | Backend per control |
|---|---|---|
| Object-level GRANT / DENY (SELECT/INSERT/UPDATE/DELETE/EXECUTE/REFERENCES), WITH GRANT OPTION | built ✅ Object GRANT wizard | `POST /sql-security {wizard:'object-grant'}` → `GRANT … ON OBJECT:: …` over TDS |
| Column-level security (GRANT/DENY SELECT on a column list) | built ✅ Column GRANT wizard | `POST {wizard:'column-grant'}` → `GRANT SELECT ON [s].[t](cols) TO …` |
| Row-Level Security (predicate function + `CREATE SECURITY POLICY`, FILTER predicate, STATE=ON, admin escape) | built ✅ RLS wizard (Dedicated/Azure SQL); honest-gate ⚠️ on Serverless | `POST {wizard:'rls'}` → CREATE FUNCTION + CREATE SECURITY POLICY (batch-split on GO) |
| Dynamic Data Masking — default/email/partial/random/datetime; add + drop mask | built ✅ DDM wizard | `POST {wizard:'ddm'|'ddm-drop'}` → `ALTER COLUMN … ADD/DROP MASKED` |
| Preview the exact T-SQL before execution | built ✅ Monaco read-only preview pane | `POST {preview:true}` returns SQL without executing |
| Verify the effect as a test principal (RLS rows / DDM masked value / column visibility) | built ✅ "Verify as principal" | `POST {action:'verify'}` → `EXECUTE AS USER … SELECT … REVERT` |
| Live security state (current grants, masked columns, RLS policies) | built ✅ Current security tab | `GET /sql-security` → `sys.database_permissions` / `sys.masked_columns` / `sys.security_policies` |
| Pickers populated from the live catalog (principals, tables/views, columns) | built ✅ | `GET` → `sys.database_principals`, `sys.tables`/`sys.views`, `sys.columns` |
| Microsoft Entra-only auth (no SQL auth) | enforced ✅ | both clients build the TDS pool with `azure-active-directory-access-token`; there is no password code path |

Zero ❌. The only non-functional states are honest gates:
- Serverless + RLS → `intent="error"` MessageBar (RLS not supported on
  Synapse Serverless; use Dedicated/Azure SQL or a view workaround).
- Serverless + Column GRANT → `intent="warning"` (applies to views, not
  external tables).
- Missing Synapse env (`LOOM_SYNAPSE_WORKSPACE` / `LOOM_SYNAPSE_DEDICATED_POOL`)
  or no Azure SQL server+db selected → `intent="warning"` naming exactly what to
  set / pick.
- No database users found → `intent="warning"` with the
  `CREATE USER … FROM EXTERNAL PROVIDER` hint.

## Backends & wiring

- Route: `app/api/items/[type]/[id]/sql-security/route.ts` dispatches by item
  type to `synapse-sql-client` (Dedicated/Serverless, env-bound) or
  `azure-sql-client` (server+database from the editor). Azure-native default —
  no Microsoft Fabric / Power BI dependency.
- SQL is built server-side by `lib/sql/tsql-builders.ts` (bracket-quoted
  identifiers, allowlisted permission verbs + mask kinds, validated names) from
  structured params — the client never sends raw SQL.
- UI: `lib/panes/sql-security-panel.tsx`, mounted in the Azure SQL editor
  (`unified-sql-database-editor` → "SQL security" tab) and the Synapse
  Dedicated + Serverless editors (ribbon "Security" → dialog).

## Bootstrap / bicep sync

No new ARM resource. The Console UAMI is already the workspace/server Microsoft
Entra admin (synapse.bicep `consoleAadAdmin`; azure-sql
`administrators/ActiveDirectory`). For the per-database security DDL the UAMI
must be db_owner in each user database — run
`platform/fiab/bootstrap/sql-security-bootstrap.sql` once per database.

## Verification

`pnpm vitest run lib/sql/__tests__/tsql-builders.test.ts` (23 builder tests) +
a live walk: each wizard Preview → Execute → Verify against a Dedicated pool /
Azure SQL database with `LOOM_DEFAULT_FABRIC_WORKSPACE` unset. Masked column
returns the masked value for the test principal; RLS filters rows; column GRANT
restricts visible columns; object GRANT lets the grantee query the object.
