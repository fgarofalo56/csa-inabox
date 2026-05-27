# KQL Database editor

The **KQL Database** editor is a Monaco-backed query surface targeting a
single ADX database. Both queries and management commands run through the
same editor; commands starting with `.` are routed to the Kusto management
endpoint, everything else to the query endpoint.

## Backend

| Layer | Implementation |
|---|---|
| Storage | Single Microsoft.Kusto/clusters/databases resource on the shared cluster |
| Auth | Console UAMI via `AllDatabasesAdmin` on the cluster |
| Query endpoint | `POST https://adx-csa-loom-shared.eastus2.kusto.windows.net/v1/rest/query` |
| Mgmt endpoint | `POST https://adx-csa-loom-shared.eastus2.kusto.windows.net/v1/rest/mgmt` |
| BFF routes | `/api/items/kql-database/[id]` (details + table list), `/api/items/kql-database/[id]/query` (run KQL), `/api/items/kql-database/[id]/tables` (list / schema) |

## What works today

| Action | Backend call | Status |
|---|---|---|
| Show database details (size, hot cache, soft delete) | `.show database ["<db>"] details` | live |
| List tables | `.show tables` | live |
| Get table schema as JSON | `.show table ["<t>"] schema as json` | live |
| Run KQL query (5,000 row cap, server-side) | `/v1/rest/query` | live |
| Run management command (`.show`, `.create`, `.ingest`, …) | `/v1/rest/mgmt` | live |
| Click table name in tree → insert `["table"] | take 100` | client | live |

## What still surfaces a "not yet wired" tooltip in the ribbon

The KQL Database editor's primary action — `Run` — is the Monaco editor + the
big primary button. Ribbon "wizards" for table / materialized view / function
creation are intentionally disabled with `title="<reason> not yet wired"`.
Authors can still issue the equivalent management commands (`.create table`,
etc.) directly in the editor.

## Bicep

- Same as [Eventhouse](eventhouse.md) — KQL databases ride the shared cluster
  and are deployed by `platform/fiab/bicep/modules/landing-zone/adx.bicep`.

## Env vars

| Variable | Purpose |
|---|---|
| `LOOM_KUSTO_CLUSTER_URI` | ADX cluster URI |
| `LOOM_KUSTO_DEFAULT_DB` | Default database name for queries when item state has no `databaseName` |
