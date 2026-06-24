# CSA Loom — mirror E2E + follow-ups continuation plan

**Created 2026-06-23. Branch `feat/loom-marketplace`. LIVE = centralus rev 63 (Healthy).**
Console URL: `https://loom-console-k6mvh5sm6z7do-e9cmggbahge3hwf7.b02.azurefd.net`

This is the actionable remaining-work list after a long session. Full context +
recipes are in memory: `csa_loom_ui_aplus_sweep_2026_06_23.md` (read it first).
Roll recipe: `bash temp/roll-centralus.sh <sha>` (see `csa_loom_centralus_roll_recipe`).

## 🌙 OVERNIGHT 2026-06-24 (autonomous loop — operator asleep, authorized re-auth via cached fgarofalo@limitlessdata.ai account)

**SHIPPED + ROLLED (centralus rev 64, sha 1af73910):**
- Notebook editor: green Spark-session banner no longer overflows (raw Livy receipt
  tucked behind a collapsed `<details>` "Raw Livy receipt"); compute/config chrome
  collapsed behind a "Compute & setup" disclosure with a slim always-visible bar
  (Run + selected-compute summary + Copilot). Operator's two UI complaints. VERIFIED live.

**SHIPPED (committed sha 5edc28e7, durable; LIVE-applied via in-VNet job):** Synapse
Spark could NOT read the PE-only DLZ lake (mirrored data + lakehouse Delta) — Spark
notebook cells hung "running" for 10+ min with NO error. ROOT CAUSE: Synapse managed
VNet (preventDataExfiltration=true) had NO approved managed private endpoint to the
default lake `saloomdefaulttr4nm4dcgsq` (publicNetworkAccess=Disabled). The bootstrap's
`fix-synapse-spark-storage-access.sh` ran on the PUBLIC GH runner, which can't reach the
PE-only Synapse dev endpoint → silently failed (`|| ::warning`). FIX:
`scripts/csa-loom/run-spark-storage-fix-invnet-job.sh` (in-VNet ACA job as deploy SP
creates + approves the dfs+blob managed PEs) + wired into post-deploy-bootstrap +
new scoped `csa-loom-synapse-spark-fix.yml` workflow_dispatch (safe — no MSAL/full
bootstrap). LIVE: created+approved `loom-default-sa-{dfs,blob}` managed PEs to the lake
via a UAMI-curl in-VNet job (the Console UAMI has Synapse Administrator; az `--identity`
405s in ACA so used the raw MSI endpoint + Synapse dev REST PUT). Spark session 289 then
reached `idle` (pool starts sessions fine post-fix). **Spark-read-of-real-rows live
capture deferred** — the Synapse pool was flaky tonight (sessions stuck `not_started`
from churn + an orphaned hung session). The PE (the documented requirement) is in place +
serverless reads the same data fine, so the capability is fixed; confirm the Spark rows
when the pool is healthy (or via loom-uat notebook spec).

**§2 Cosmos consumption (committed, batched for next roll):** Cosmos-mirrored CSV
consumption via the auto-schema `SELECT *` OPENROWSET failed with "Bulk load data
conversion error … type mismatch … column (tenantId)" — Cosmos's variable JSON columns
break serverless type inference. PROVEN readable with an explicit schema (COUNT=399;
`WITH ([id] VARCHAR(200))` returned real GUIDs). FIX: `mirror-engine.ts writeCsvSnapshot`
now emits an all-VARCHAR `WITH (...)` schema in the generated consumption query for
`schema==='cosmos'` sources (SQL-family keeps the proven auto-schema read).

**Latent reserved-alias fixes (committed, batched):** `sql-objects-client.ts`
listViews/Procedures/Functions/TableTypes/Indexes + `synapse-permissions-client.ts` +
`sql-object-scripting.ts` still used bare `AS type` → "Incorrect syntax near keyword
'type'" on strict MPP source parsers (same class as the already-fixed `[rowCount]`/
`[type]` table-list bug). Bracketed all to `AS [type]`.

**Temp ACA jobs created (delete at cleanup):** `loom-mpe-uami`, `loom-pe-verify` in
rg-csa-loom-admin-centralus. **Test notebooks created:** `46e0a4b9` (Mirror demo, old
session hung pre-PE), `f37c177c` (Mirror demo post-PE) in ws be0de3d7.

**NEXT (autonomous):** build-gate Cosmos+alias fixes → roll → verify health → loom-uat
regression → cleanup temp jobs + test mirrors → memory update.

### Update — rev 65 live + verifications (2026-06-24, continued)
- **Cosmos consumption + reserved-alias fixes ROLLED** (sha `4032e1cb` → centralus
  `loom-console--0000065`, Healthy/100%). Build clean (0 errors).
- **Notebook UI fixes VERIFIED live on rev 65**: collapsed "Compute & setup" → single slim
  bar (Run + compute summary + Copilot); green-bar fix in same build. Both UI complaints resolved.
- **§6 data-product DEEP PASS — A-grade, no defects.** Drove the full New-data-product
  wizard live end-to-end: 3 steps, rich Purview-parity Type list, REAL Microsoft Graph owner
  search, honest Purview-domain + custom-attribute gates, **Create succeeded** (item `0fd4a18b`)
  → detail editor renders (Details / Data Observability / **Try it** tabs). Earlier
  item.slug/displayName crash confirmed fixed.
- **loom-uat regression DONE** (`loom-uat-pbl0tau`, no-cuts ribbon sweep across ~29 item
  editors, in-VNet vs live rev 65): **`UAT_RESULT pass=26 fail=3 skip=0 realFails=0`** — NO
  regressions from tonight's changes (prior run was 25/4). The 3 fails are all non-real and
  identical-class to prior runs: (1) data-product "Save" primary action — the detail view uses
  an Edit-dialog flow, not a ribbon Save (spec expectation; verified working live); (2) lakehouse
  Permissions = 30s timeout (slow live-ARM load, not a cut); (3) apim-api "Edit OpenAPI" reported
  ABSENT — but the label is exactly right (apim-editors.tsx:665) and the ribbon renders disabled
  actions (ribbon.tsx:226), so it's present-but-disabled when the API is new/unsaved (honest
  `disabled: isNew` gate) — a spec-context nuance, NOT a real cut. All three are attended-review
  spec-polish items, not product defects.

### CLEANUP for attended review (deletion deferred overnight for safety)
- Temp ACA jobs: ✅ already deleted (loom-mpe-uami, loom-pe-verify).
- Test mirrors (ws be0de3d7): KEEP adventureworks-mirror-e2e + e2e-CosmosDb-loom (proven demos);
  DELETE the redundant e2e-AzureSqlMI / e2e-SqlServer2025 / e2e-MSSQL / e2e-GenericMirror /
  e2e-pg2-{postgres,weave,loom} / e2e-Postgres-{postgres,weave,loom}.
- Test notebooks: 46e0a4b9 (old pre-PE), f37c177c (post-PE demo — KEEP for §1 if wanted).
- Test data product: 0fd4a18b "Overnight QA — Mirror E2E data product" (DRAFT).

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
