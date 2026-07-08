# azure-cosmos-account — parity with the Azure **Cosmos DB Data Explorer** (NoSQL)

> **Standalone editor.** `slug: azure-cosmos-account`,
> `displayName: "Azure Cosmos DB account"`, `restType: CosmosDbAccount`,
> category **Databases**. Editor: `CosmosAccountEditor` in
> `apps/fiab-console/lib/editors/cosmos-account-editor.tsx`. One-for-one target:
> the Azure portal **Cosmos DB → Data Explorer** studio for the SQL (Core/NoSQL)
> API, plus the account-management blades (Replicate globally / Backup /
> Networking / Keys).

**Catalog description:** "Cosmos DB for NoSQL — a live Data Explorer over
databases, containers, throughput, and server-side scripts."

**No-Fabric note:** Cosmos DB is a pure Azure service
(`Microsoft.DocumentDB/databaseAccounts`). No Fabric dependency. Missing-config
surfaces render an honest Fluent MessageBar (per `no-vaporware.md`).

Source UI: **Azure portal — Cosmos DB Data Explorer** (`https://portal.azure.com` · `https://cosmos.azure.com`)
- Data Explorer: <https://learn.microsoft.com/azure/cosmos-db/data-explorer>
- NoSQL query (SQL API): <https://learn.microsoft.com/azure/cosmos-db/nosql/query/>
- Stored procedures / triggers / UDFs: <https://learn.microsoft.com/azure/cosmos-db/nosql/stored-procedures-triggers-udfs>
- Throughput (RU/s) & autoscale: <https://learn.microsoft.com/azure/cosmos-db/set-throughput>
- Global distribution: <https://learn.microsoft.com/azure/cosmos-db/distribute-data-globally>
- Backup & restore: <https://learn.microsoft.com/azure/cosmos-db/online-backup-and-restore>
- Data-plane RBAC: <https://learn.microsoft.com/azure/cosmos-db/nosql/security/how-to-grant-data-plane-role-based-access>
- Account REST (control plane): <https://learn.microsoft.com/rest/api/cosmos-db-resource-provider/>

## Cosmos DB Data Explorer + account — feature inventory

| # | Capability | Notes |
|---|-----------|-------|
| 1 | **Resource tree** — databases → containers → Items / Settings / Scale / Stored Procedures / UDFs / Triggers | Data Explorer tree |
| 2 | **New database / New container** wizard — id, partition key, throughput (manual/autoscale RU), unique keys, analytical store, TTL | create |
| 3 | **Items** — query grid, open/edit a document (JSON), New Item, Update, Delete | data-plane |
| 4 | **New SQL Query** tab — run SQL over a container's feed, query stats/RU, save query | query |
| 5 | **Container Settings** — indexing policy, default TTL, conflict resolution, geospatial config | settings |
| 6 | **Scale** — container/db throughput (manual RU or autoscale max RU) | throughput |
| 7 | **Stored Procedures / UDFs / Triggers** — list, create/edit script, delete, execute sproc | server-side |
| 8 | **Metrics** — request/RU/storage metrics per container/db | monitor |
| 9 | **Replicate globally** — add/remove read regions, multi-region writes, availability-zones, automatic failover | account |
| 10 | **Backup & Restore** — Periodic vs Continuous, redundancy, retention/interval, PITR | account |
| 11 | **Networking** — public access, IP firewall, VNet rules, private endpoints | account |
| 12 | **Keys / connection strings** — read-write & read-only master keys, per-API connection strings, regenerate | account |
| 13 | **Gremlin / other APIs** graph explorer | multi-API |

## Loom coverage

A real Data-Explorer studio with a resource **tree** + a **tabbed workspace**
(Items / Settings / Query / Scripts / Metrics) and account-management
**accordions**. Two backends: control plane = ARM
`Microsoft.DocumentDB/databaseAccounts` (api-version **2024-11-15**,
`cosmos-account-client.ts`); data plane = AAD-token direct-to-endpoint document
feed (`cosmos-data-client.ts`). Config gate (`cosmosConfigGate`) → honest 503
naming `LOOM_COSMOS_ACCOUNT` / `LOOM_COSMOS_ACCOUNT_RG` / `LOOM_COSMOS_ACCOUNT_SUB`.

| # | Capability | Status | Detail |
|---|-----------|--------|--------|
| 1 | Resource tree | built ✅ | databases → containers → Items / Settings / Scripts, expand-to-load |
| 2 | New database / container wizard | built ✅ | `CosmosContainerWizard` (id, partition key, manual/autoscale throughput, default TTL) |
| 3 | Items (query + CRUD) | built ✅ (query/read) ⚠️ (write) | **Items** tab query grid via `queryItems`/`getItem`; document create/replace/delete routed via the sibling scripts/items action route (data-plane RBAC gate surfaced honestly) |
| 4 | New SQL Query tab | built ✅ | standalone query tabs (`SELECT * FROM c` seed) against a chosen container; "pick a container" guidance (Cosmos has no cross-container query) |
| 5 | Container Settings | built ✅ | default TTL + throughput; indexing-policy authoring is honest-gated where no write route exists |
| 6 | Scale (throughput) | built ✅ | container-throughput + container-settings routes (real RU / autoscale values); ARM returns honest error if a bound is out of range |
| 7 | Stored Procedures / UDFs / Triggers | built ✅ | script tabs (new/existing sproc/udf/trigger) — real ARM authoring (PUT/DELETE) on the `storedProcedures`/`triggers`/`userDefinedFunctions` subresources |
| 8 | Metrics | built ✅ | Metrics tab (account/db/container scope) |
| 9 | Replicate globally | built ✅ | account-management accordions: **regions** (add/remove read regions), **replication** (multi-region writes) |
| 10 | Backup & Restore | built ✅ (config) ⚠️ | Periodic/Continuous mode, redundancy (Geo/Zone/Local), Continuous 7/30-day tier — targeted ARM PATCH; PITR restore itself is honest-gated |
| 11 | Networking | built ✅ | public access, IP firewall, VNet rules, private-endpoint accordions |
| 12 | Keys / connection strings | built ✅ | `listKeys` / `listConnectionStrings` / `regenerateKey` (read-only UAMI surfaces the ARM 403 as an honest gate) |
| 13 | Gremlin graph explorer | honest-gate ⚠️ | informational — server-bound via `LOOM_COSMOS_GREMLIN_ENDPOINT`; names `cosmos-graph-vector.bicep` to enable |

## Backend per control

| Loom control | Route | Azure backend |
|--------------|-------|---------------|
| Databases / containers tree | `/api/cosmos/databases`, `/api/cosmos/containers` | ARM `…/databaseAccounts/{a}/sqlDatabases[/containers]` (2024-11-15) |
| Items query / read | `POST /api/cosmos/items` → `queryItems`/`getItem` | data-plane AAD token → account `/docs` feed |
| Settings / throughput | `/api/cosmos/container-settings`, `/api/cosmos/container-throughput` | ARM container + `throughputSettings` |
| Scripts (sproc/udf/trigger) | `/api/cosmos/scripts` | ARM `…/containers/{c}/storedProcedures`\|`triggers`\|`userDefinedFunctions` |
| Account mgmt (regions/backup/network/keys) | `/api/cosmos/account-management` | ARM `…/databaseAccounts/{a}` PATCH + `listKeys`/`listConnectionStrings`/`regenerateKey` |
| Config missing | — | `cosmosConfigGate()` → 503 honest MessageBar |

**Grade: A− / B+.** A genuine Data-Explorer studio: resource tree, container
wizard, item query grid, standalone SQL query tabs, server-side script authoring,
metrics, plus the full account-management set (global distribution, backup,
networking, keys) — all on real ARM control-plane + AAD data-plane, no mocks, no
Fabric. Honest gates cover the data-plane-RBAC-dependent writes, indexing-policy
authoring, PITR restore, and the Gremlin graph explorer (env-gated).
