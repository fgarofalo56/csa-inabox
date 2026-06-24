# CSA Loom — mirror E2E + follow-ups continuation plan

**Created 2026-06-23. Branch `feat/loom-marketplace`. LIVE = centralus rev 63 (Healthy).**
Console URL: `https://loom-console-k6mvh5sm6z7do-e9cmggbahge3hwf7.b02.azurefd.net`

This is the actionable remaining-work list after a long session. Full context +
recipes are in memory: `csa_loom_ui_aplus_sweep_2026_06_23.md` (read it first).
Roll recipe: `bash temp/roll-centralus.sh <sha>` (see `csa_loom_centralus_roll_recipe`).

## ✅ DONE this session (live + verified) — do NOT redo
- Publish-as-API weave (MPP table-list + source-not-found fallback)
- Permissions/bronze RBAC resource-group self-heal (Resource Graph)
- Systemic Griffel unitless-px fix (706 values / 121 files) → builders render correctly
- Marketplace response-body formatter (JSON/XML/CSV, Pretty/Raw, copy)
- 4 icon/render crashes (Variable20Regular, BrainCircuit16Regular)
- Connection edit/test backend + ConnectionBuilder edit-mode + mirror Edit/Test
- Databricks UC mirror discoverability card
- Dataverse day-one MSAL-app credential fallback
- Mirror engine: `sp_change_feed_enable_db` invalid param FIX; `[rowCount]`/`[type]` alias FIX
- Mirror wizard dialog-never-closes FIX (conditional-mount) — verified
- Postgres AAD token `.azure.com`→`.windows.net` FIX (live env + code + bicep + bootstrap) — verified UAMI connects
- **Mirror E2E proven (real data):** Azure SQL DB / MI / SQL Server 2025 / 2016-2022 → replicate 12 tables → Bronze;
  **queried back real rows via Synapse Serverless SQL**; **12 lakehouse shortcuts** created. Cosmos → replicated REAL
  containers (workspaces 399 rows, etc.). Open-mirroring path verified (awaits producer).
- UAT full-functional run `pass=25/fail=4/realFails=0` — no real defects (4 fails = apim button-label, data-product
  Save expectation, 2 lakehouse slow-load timeouts).

## ⏳ REMAINING WORK (this plan)

### 1. Notebook consumption demo (operator wants to SEE it) — HIGH
Show querying a mirrored table in a Loom **notebook**. Notebook runs real Spark via Livy
(`POST /api/items/notebook/[id]/run` {compute:'spark:<pool>'} → async, poll `/runs/[runId]`; cold-start 3-5 min).
Path: create notebook via `POST /api/thread/analyze-in-notebook` {from:{lakehouse `7bc6fb9f-7da7-4ef0-88da-d35888e67dc4`}}
→ open → run a cell reading a mirrored table → screenshot real rows. FASTER alt: a serverless-SQL cell (OPENROWSET,
seconds) — the data is already proven queryable. Needs: active session + Synapse Spark pool provisioned/running.

### 2. Mirror — remaining source types e2e — HIGH
Use the engine-API pattern (no UI): `POST /api/items/mirrored-database?workspaceId=be0de3d7-5491-4dd2-af3e-377dda595dd8`
{displayName, definition(base64 mirroring.json), sourceType, server, database, tables:[], syncMode:'snapshot'} then
`POST /api/items/mirrored-database/<id>/lifecycle?workspaceId=...` {action:'start'}. Source: demo-sql-srv01/adventureWorks
(UAMI is db_owner) for SQL; for others see below.
- **Postgres full replicate** — token fixed; needs a DB WITH user tables. Easiest: seed a table on `psql-loom-weave-default-tr4nm4dcgsqmu.postgres.database.azure.com` (UAMI is its Entra admin) via a `pg` connect + CREATE TABLE+INSERT (mint token `az account get-access-token --resource https://ossrdbms-aad.database.windows.net`), then mirror that DB → replicate → query.
- **Snowflake / BigQuery / Oracle** — external SaaS; need a credential in Key Vault (operator pre-seeds, or provide). Then create→start→replicate→query each (ADF Copy backend; needs LOOM_ADF_NAME + linked services per docs/fiab/audit/live-e2e-feature-surfaces-v2.md).
- **Databricks UC** (`mirrored-databricks` item type) — exercise create→mount→query (Unity Catalog metastore+catalog; UAMI Databricks access).
- **Cosmos consumption query** — already replicated; run the serverless OPENROWSET over a Cosmos Bronze table too.
- **Open mirroring full e2e** — upload a sample Parquet to the landing path → start → Spark merge → query.

### 3. UAT polish (non-blocking) — MED
- Rename apim-api ribbon button to exactly "Edit OpenAPI" to satisfy `no-cuts-sweep-v3` (capability exists in apim-editors.tsx:222; label mismatch only). OR update the spec regex.
- Investigate lakehouse editor initial-load perf (no-cuts Permissions/Settings ribbon checks timed out at 30s — likely slow live-ARM; perf-check or pre-render the ribbon).

### 4. Front Door client-JS caching — MED (systemic)
Long-lived tabs serve STALE client behavior after a roll until hard-refresh (caused the stuck-dialog confusion).
Content-hashed `/_next/static` chunks are immutable/safe, but the HTML/RSC document appears FD-cached → old chunk refs.
Add an FD cache rule: do NOT cache the document/RSC navigation responses (cache only immutable `/_next/static/*`).
After any client-side roll, until fixed, tell the operator to hard-refresh (Ctrl+Shift+R).

### 5. Dataverse verify — MED
Day-one MSAL-app fallback is wired (commit + docs). Verify once a Dataverse env exists: one-time "Promote To Admin"
on the Default env (docs/fiab/dataverse-app-user.md Step 1), then a Dataverse-scoped feature (e.g. Power Automate
flow create / data-agent publish) should work without LOOM_DATAVERSE_* set.

### 6. Data-product "test every option / add missing" — MED
Layout root-fixed (Griffel). Remaining: deeper feature pass on the data-product create wizard + detail editor —
exercise every option, add any missing capabilities vs Purview Unified Catalog parity (ui-parity.md).

### 7. Cleanup — LOW
Delete the ~9 test mirrors created this session: `adventureworks-mirror-e2e`, `e2e-AzureSqlMI`, `e2e-SqlServer2025`,
`e2e-MSSQL`, `e2e-GenericMirror`, `e2e-CosmosDb-loom`, `e2e-pg2-*`, plus the lakehouse shortcuts under
`Files/mirrors/adventureworks-mirror-e2e` in lakehouse `7bc6fb9f`. (DELETE via the mirror editor or
`DELETE /api/items/mirrored-database/<id>?workspaceId=be0de3d7-...`.)

## OPERATING NOTES (recurring gotchas)
- **Session expiry:** the operator's browser AAD session lapses every few minutes (401). Ask them to re-sign-in;
  never authenticate as them. Re-run the test once a fresh "FG" avatar shows.
- **Browser flakiness:** claude-in-chrome tabs sometimes close / navigation doesn't stick — retry ≤2-3x then re-get tab context.
- **form_input not computer.type** for React controlled inputs (type doesn't fire onChange).
- **Build gate:** `cd apps/fiab-console && pnpm build`; grep the log for `Compiled successfully` AND zero
  `Attempted import error` (those = real render crashes). The wrapper exit code lies; grep the log.
- **No creds:** never enter source secrets/passwords. SQL/Cosmos/Postgres AAD sources where the UAMI can be granted
  (operator is AAD admin via `az`) are doable; external SaaS need a KV secret.
- UAT harness: `az containerapp job start -n loom-uat -g rg-csa-loom-admin-centralus --subscription e093f4fd-5047-4ee4-968d-a56942c665f3`;
  results in LA workspace 01273839-800f-4fef-86bf-85e94cdf3a65, `ContainerAppConsoleLogs_CL | where ContainerName_s=='uat' | where Log_s has 'UAT_RESULT'`.
