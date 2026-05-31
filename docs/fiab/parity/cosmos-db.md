# cosmos-db — parity with Azure Cosmos DB (NoSQL / Core SQL API) Data Explorer

Source UI: Azure portal → Cosmos DB account → **Data Explorer** + account-level blades
(Scale, Keys, Networking, Replicate data globally, Backup & Restore, Default consistency, Features).
Standalone Data Explorer: <https://cosmos.azure.com>

Learn grounding (not from memory):

- Data Explorer overview — <https://learn.microsoft.com/azure/cosmos-db/data-explorer>
- Data Explorer keyboard shortcuts (enumerates the toolbar verbs) — <https://learn.microsoft.com/azure/cosmos-db/data-explorer-shortcuts>
- Quickstart (Items / New Item / New SQL Query / Execute) — <https://learn.microsoft.com/azure/cosmos-db/quickstart-portal>
- Stored procedures / triggers / UDFs (author + execute) — <https://learn.microsoft.com/azure/cosmos-db/how-to-write-stored-procedures-triggers-udfs>
- Autoscale + Scale and Settings — <https://learn.microsoft.com/azure/cosmos-db/how-to-provision-autoscale-throughput>
- Manage account (keys, regions) — <https://learn.microsoft.com/azure/cosmos-db/how-to-manage-database-account>
- Replicate data globally — <https://learn.microsoft.com/azure/cosmos-db/tutorial-global-distribution>
- Periodic backup / restore — <https://learn.microsoft.com/azure/cosmos-db/periodic-backup-restore-introduction>
- Custom Column Selector (Items grid) — <https://learn.microsoft.com/azure/cosmos-db/data-explorer#customize-your-data-views-with-the-custom-column-selector>

Control-plane REST: `Microsoft.DocumentDB/databaseAccounts/{acct}` (ARM api-version **2024-11-15**).
Data-plane REST: `https://{acct}.documents.azure.com/dbs/{db}/colls/{c}/docs` (+ `/sprocs`, `/triggers`, `/udfs`).

This surface navigates a **user-selected** Cosmos DB account named by
`LOOM_COSMOS_ACCOUNT` — **distinct from Loom's own internal store**
(`LOOM_COSMOS_ENDPOINT`, handled by `lib/azure/cosmos-client.ts`). It is the
Cosmos peer of the ADF / Synapse / Databricks / APIM navigators (parity wave 7).

> **Honest verdict (2026-05-31): grade C.** Loom is a faithful read-mostly
> *control-plane navigator* (databases/containers/throughput CRUD + read-only
> script lists). The single most-used half of the real Data Explorer — the
> **data-plane** (browse/edit/query JSON items, the query editor with results
> grid, and stored-proc/trigger/UDF authoring + execution) — is **entirely
> absent** (disclosed as honest "coming" rows, no backend). It also omits all
> account-level lifecycle blades (Keys, Networking, Replicate-globally, Backup,
> Scale-on-existing, Default consistency, Features). This is the opposite split
> from the portal, where Data Explorer is overwhelmingly a data tool. Not B/A.

---

## Azure feature inventory (exhaustive, grounded in Learn + portal)

### A. Data Explorer — tree / navigation

| # | Capability | Real backend |
|---|-----------|--------------|
| A1 | List SQL (NoSQL) databases | ARM `…/sqlDatabases` |
| A2 | List containers under a database | ARM `…/sqlDatabases/{db}/containers` |
| A3 | Expand container → child nodes (Items, Settings, Scale, Stored Procedures, Triggers, UDFs, Conflicts) | mixed control + data plane |
| A4 | List stored procedures | ARM `…/containers/{c}/storedProcedures` |
| A5 | List triggers (type + operation badges) | ARM `…/containers/{c}/triggers` |
| A6 | List user-defined functions | ARM `…/containers/{c}/userDefinedFunctions` |
| A7 | Refresh node / refresh tree | re-list |
| A8 | Filter / search tree by name | client |
| A9 | Right-click context menu per node (New/Delete/Settings/Open) | UI verbs |
| A10 | Account header (name, region, serverless, free-tier) | ARM GET `…/databaseAccounts/{acct}` |

### B. Database lifecycle

| # | Capability | Real backend |
|---|-----------|--------------|
| B1 | New Database (id + optional shared throughput, manual/autoscale, "Provision database throughput") | ARM PUT `…/sqlDatabases/{db}` |
| B2 | Delete Database (typed-name confirm) | ARM DELETE `…/sqlDatabases/{db}` |
| B3 | Database **Scale** node — view/edit shared RU/s (manual↔autoscale toggle on EXISTING db) | ARM PUT `…/sqlDatabases/{db}/throughputSettings/default` |

### C. Container lifecycle + settings

| # | Capability | Real backend |
|---|-----------|--------------|
| C1 | New Container wizard — id, partition key, (sub)partition keys, unique keys, analytical store TTL, throughput manual/autoscale, "use existing/new database" | ARM PUT `…/containers/{c}` |
| C2 | Delete Container (typed-name confirm) | ARM DELETE `…/containers/{c}` |
| C3 | Container **Scale & Settings** editor — TTL (off/on/on-no-default), manual↔autoscale toggle + RU/s on EXISTING container, partition-key display | ARM PUT throughputSettings + container PUT |
| C4 | **Indexing policy** editor — includedPaths/excludedPaths/composite/spatial indexes JSON editor + Save | ARM container PUT `resource.indexingPolicy` |
| C5 | **Conflict resolution policy** — LWW path vs custom-sproc (multi-region writes) | ARM container PUT `resource.conflictResolutionPolicy` |
| C6 | Unique keys display | ARM container `resource.uniqueKeyPolicy` |
| C7 | Geospatial config (Geography/Geometry) | ARM container PUT |

### D. Items (document data plane) — the core of Data Explorer

| # | Capability | Real backend |
|---|-----------|--------------|
| D1 | **Items** node — browse documents as a paged grid (id + partition key columns) | data-plane GET/`POST …/docs` |
| D2 | **New Item** — JSON editor, Save (insert) | data-plane POST `…/docs` |
| D3 | Open / view a document (formatted JSON, _etag/_ts) | data-plane GET `…/docs/{id}` |
| D4 | **Edit / Update Item** (Ctrl+S) | data-plane PUT `…/docs/{id}` |
| D5 | **Delete Item** | data-plane DELETE `…/docs/{id}` |
| D6 | Filter bar — partial WHERE/ORDER BY over items grid | data-plane query |
| D7 | **Custom Column Selector** — add/remove/sort/reset columns from doc properties | client + query |
| D8 | Upload Item(s) from JSON file | data-plane bulk |
| D9 | Load more / continuation paging | data-plane continuation token |

### E. Query editor

| # | Capability | Real backend |
|---|-----------|--------------|
| E1 | **New SQL Query** tab (Monaco editor, syntax highlight, IntelliSense) | client |
| E2 | **Execute Query** (Shift+Enter/F5), Cancel | data-plane POST `…/docs` (query) |
| E3 | Results pane — Results / JSON / Query Stats (RU charge, doc count, round-trips) | data-plane response headers |
| E4 | Open Query / Save Query (to account or disk) | data-plane queries container + disk |
| E5 | Query Copilot (NL→NoSQL) toggle | Copilot service |
| E6 | Format / comment / multi-tab query management | client |

### F. Server-side script authoring (data plane)

| # | Capability | Real backend |
|---|-----------|--------------|
| F1 | **New Stored Procedure** — JS editor, Save, **Execute** (partition key + params), result | data-plane `…/sprocs` |
| F2 | **New Trigger** — JS editor + type(Pre/Post) + operation(All/Create/…), Save | data-plane `…/triggers` |
| F3 | **New UDF** — JS editor, Save | data-plane `…/udfs` |
| F4 | Edit / Update / Delete an existing sproc/trigger/UDF | data-plane PUT/DELETE |

### G. Account-level blades (resource menu, outside Data Explorer but in the Cosmos portal surface)

| # | Capability | Real backend |
|---|-----------|--------------|
| G1 | **Keys** — primary/secondary keys + read-only keys + connection strings, regenerate | ARM `…/listKeys`, `…/regenerateKey` |
| G2 | **Replicate data globally** — add/remove regions on map, availability zones, multi-region writes, manual failover priority | ARM `…/databaseAccounts` PATCH (locations) |
| G3 | **Default consistency** — Strong/Bounded/Session/Consistent-Prefix/Eventual | ARM PATCH consistencyPolicy |
| G4 | **Backup & Restore** — periodic interval/retention, point-in-time restore | ARM backupPolicy / restore |
| G5 | **Networking / Firewall** — public/private endpoint, IP/VNet rules | ARM PATCH ipRules/virtualNetworkRules |
| G6 | **Features** — Dynamic Scaling, Serverless, Synapse Link, etc. | ARM capabilities/features |
| G7 | **Metrics / Insights** — RU consumption, throttling (429), storage, partition heatmap | Azure Monitor |
| G8 | API-specific Data Explorers (Mongo / Cassandra / Gremlin / Table) | per-API data plane |

---

## Loom coverage (built ✅ / honest-gate ⚠️ / partial 🟡 / MISSING ❌)

| # | Capability | Status | Where |
|---|-----------|--------|-------|
| A1 | List databases | ✅ built | `GET /api/cosmos/databases` |
| A2 | List containers | ✅ built | `GET /api/cosmos/containers?db=` (lazy-expand) |
| A3 | Container child nodes | 🟡 partial | tree shows Stored procs / Triggers / UDFs only — **no Items/Settings/Scale/Conflicts child nodes** |
| A4 | Stored procedures list | ✅ built | `GET /api/cosmos/scripts` |
| A5 | Triggers list (type/op badges) | ✅ built | `GET /api/cosmos/scripts` |
| A6 | UDFs list | ✅ built | `GET /api/cosmos/scripts` |
| A7 | Refresh | ✅ built | tree + ribbon Refresh |
| A8 | Filter by name | 🟡 partial | filters databases + containers; no container-internal search |
| A9 | Context (right-click) menu | 🟡 partial | inline hover buttons + a top "New" menu; no per-node right-click menu |
| A10 | Account header chip | ✅ built | `GET /api/cosmos/account` |
| B1 | New database (+ shared throughput) | ✅ built | `POST /api/cosmos/databases` → tree "New" dialog |
| B2 | Delete database | 🟡 partial | `DELETE /api/cosmos/databases?db=` — **no typed-name confirm dialog** (one-click destructive) |
| B3 | Database Scale (edit RU/s on existing) | ❌ MISSING | client reads throughput but no PUT throughputSettings; create-only |
| C1 | New container (pk + RU/s) | 🟡 partial | `POST /api/cosmos/containers` — id+pk+throughput only; **no unique keys / subpartition / analytical TTL / advanced** |
| C2 | Delete container | 🟡 partial | `DELETE /api/cosmos/containers` — **no typed-name confirm** |
| C3 | Container Scale & Settings (TTL, edit RU/s) | ❌ MISSING | client *reads* defaultTtl + throughput but never surfaces an editor or PUT |
| C4 | Indexing policy editor | ⚠️ gated | "coming" row, tooltip names `resource.indexingPolicy`; no backend |
| C5 | Conflict resolution policy | ⚠️ gated | "coming" row; no backend |
| C6 | Unique keys | ❌ MISSING | not shaped, not shown |
| C7 | Geospatial config | ❌ MISSING | — |
| D1 | Items grid (browse documents) | ⚠️ gated | "Item / document data explorer" coming row; no data-plane client |
| D2 | New Item | ❌ MISSING | — (covered by D1 gate) |
| D3 | View document | ❌ MISSING | — |
| D4 | Edit / Update Item | ❌ MISSING | — |
| D5 | Delete Item | ❌ MISSING | — |
| D6 | Items filter bar | ❌ MISSING | — |
| D7 | Custom Column Selector | ❌ MISSING | — |
| D8 | Upload Item from JSON | ❌ MISSING | — |
| D9 | Continuation paging | ❌ MISSING | — |
| E1 | New SQL Query tab | ❌ MISSING | no query editor anywhere |
| E2 | Execute Query | ❌ MISSING | — |
| E3 | Results / JSON / Query Stats (RU charge) | ❌ MISSING | — |
| E4 | Open / Save query | ❌ MISSING | — |
| E5 | Query Copilot | ❌ MISSING | — |
| E6 | Query tab management | ❌ MISSING | — |
| F1 | Stored procedure authoring + execute | ⚠️ gated | "authoring" coming row; list-only |
| F2 | Trigger authoring | ⚠️ gated | same coming row |
| F3 | UDF authoring | ⚠️ gated | same coming row |
| F4 | Edit/Delete a script | ❌ MISSING | scripts are list-only (no per-script delete even via control plane) |
| G1 | Keys / connection strings | ❌ MISSING | not surfaced |
| G2 | Replicate data globally (regions/map) | ❌ MISSING | not surfaced |
| G3 | Default consistency | ❌ MISSING | account capabilities read but consistency not shown/editable |
| G4 | Backup & restore | ❌ MISSING | — |
| G5 | Networking / firewall | ❌ MISSING | — |
| G6 | Features (Dynamic Scaling etc.) | ❌ MISSING | capabilities read-only badge only |
| G7 | Metrics / Insights | ❌ MISSING | — |
| G8 | Mongo/Cassandra/Gremlin/Table API explorers | ❌ MISSING | SQL/NoSQL only |

**Tally:** built ✅ 8 · partial 🟡 7 · gated ⚠️ 5 · MISSING ❌ 24.

The `ui-parity.md` A-grade bar is "every inventory row built ✅ or honest-gate ⚠️
— zero ❌". This surface has **24 ❌ rows** and 7 partials, so it is far from A.
The four honest-gate ⚠️ rows are legitimate per `no-vaporware.md` (tooltip names
the exact REST/data-plane path), but they paper over the entire data plane.

---

## Backend per control

| Control | Backend (real) |
|---------|---------|
| Databases list / create / delete | ARM `…/sqlDatabases` (GET/PUT/DELETE 2024-11-15) — real, async-polled |
| Containers list / create / delete | ARM `…/sqlDatabases/{db}/containers` — real, async-polled |
| Throughput **read** badges | ARM `…/throughputSettings/default` (manual / autoscale / serverless mapped honestly) |
| Throughput **write** (scale existing) | **none** — read-only; no PUT throughputSettings |
| Stored procedures / triggers / UDFs | ARM `…/containers/{c}/{storedProcedures\|triggers\|userDefinedFunctions}` — **list only** |
| Account header | ARM GET `…/databaseAccounts/{acct}` |
| Item/document CRUD | **none** — no `documents.azure.com` data-plane client exists |
| Query execution | **none** |
| Script authoring/execution | **none** |
| Indexing / conflict / TTL editors | **none** |
| Keys / networking / regions / backup / consistency | **none** |
| Auth | `ChainedTokenCredential(ManagedIdentityCredential(LOOM_UAMI_CLIENT_ID), DefaultAzureCredential)` → `https://management.azure.com/.default` |

Note: every wired call is the **ARM control plane**. There is **no Cosmos
data-plane client** (no `documents.azure.com` SDK/fetch, no resource-token or
AAD data-plane RBAC path) anywhere in the app — confirmed by grep. That is the
structural reason the entire D/E/F group is missing.

---

## Infra gate (honest, per no-vaporware + ui-parity)

When the navigator account isn't configured every route returns
`503 { ok:false, code:'not_configured', missing, hint }` and the tree renders a
single Fluent `MessageBar intent="warning"` naming:

- env vars: `LOOM_COSMOS_ACCOUNT`, `LOOM_COSMOS_ACCOUNT_RG`, `LOOM_SUBSCRIPTION_ID`
- role: **Cosmos DB Operator** (or **DocumentDB Account Contributor**) at the account scope

403 from ARM (UAMI missing the role) is surfaced verbatim with that role hint.
This gate is correct and matches the standard. **However**, per the
`csa_loom_remaining_work` note, these `LOOM_COSMOS_ACCOUNT*` env vars are **not
yet wired into the admin-plane bicep `apps[]` env list**, so in the live
deployment this navigator is silently config-gated — it shows the warning
MessageBar, not real data. Bicep-sync is a prerequisite before any A/A+ claim.

---

## Files

- `lib/azure/cosmos-account-client.ts` — ARM control-plane client + `cosmosConfigGate()` (461 lines)
- `app/api/cosmos/{databases,containers,scripts,account}/route.ts` — session-guarded BFF
- `app/api/cosmos/_shared.ts` — session / gate / error helpers
- `lib/components/cosmos/cosmos-tree.tsx` — Fluent v9 Data Explorer tree (628 lines)
- `lib/editors/cosmos-account-editor.tsx` — host editor (slug `azure-cosmos-account`, registered in `lib/editors/registry.ts:144`, catalogued in `lib/catalog/fabric-item-types.ts:2123`)

## Highest-value gaps to build next (in priority order)

1. **Items data explorer (D1–D5)** — a `documents.azure.com` data-plane client
   (AAD data-plane RBAC) + Items grid + New/Edit/Delete JSON editor. This is the
   single most-used Data Explorer feature and the biggest credibility gap.
2. **Query editor (E1–E3)** — Monaco NoSQL tab + Execute against the data plane
   + results grid with RU-charge / doc-count query stats.
3. **Scale & Settings editors (B3 + C3)** — PUT `throughputSettings/default`
   (manual↔autoscale toggle, edit RU/s on existing db/container) + TTL editor.
   The client already *reads* these values; only the write path is missing.
4. **Script authoring + execute (F1–F4)** — JS editor for sprocs/triggers/UDFs
   with partition-key-scoped Execute.
5. **Indexing policy editor (C4)** — container PUT `resource.indexingPolicy`.
6. **Destructive-action confirms (B2/C2)** — typed-name confirm dialogs to match
   the portal and prevent one-click data loss.
7. **Bicep-sync** `LOOM_COSMOS_ACCOUNT*` into admin-plane `apps[]` env so the
   navigator is live (not silently gated) in the deployed Console.

## Verification

- `pnpm build` exit 0 (control-plane routes compile).
- Real-data E2E receipt (minted-session probe + real ARM response + screenshot)
  must attach to the PR per `no-vaporware.md` once a Cosmos account is pinned
  AND the env vars are bicep-synced into the deployment.
