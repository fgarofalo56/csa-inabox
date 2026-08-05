# Discovery and adoption — the service reference

This page is the reference behind the [brownfield walkthrough](brownfield.md):
what Loom can discover, what it uses each service for, what it **changes** about
a service you let it adopt, and how to supply values by hand when discovery
cannot see something.

---

## How discovery works

Loom queries **Azure Resource Graph** — a tenant-wide, read-only index of ARM
resources. One query, one `type in~ (...)` filter built from the service
catalogue, projecting name, resource group, subscription, location and kind.

```kql
Resources
| where type in~ ('microsoft.purview/accounts', 'microsoft.search/searchservices', ...)
| project name, resourceGroup, subscriptionId, location, kind, sku
| order by name asc
```

**It writes nothing.** Resource Graph has no write surface.

### Which identity does the reading

| Path | Identity |
|---|---|
| `scripts/csa-loom/discover-services.sh`, `byo-wizard.sh`, `scan-and-deploy.sh` | the signed-in `az` principal (you) |
| Console `/setup` → Scan & choose | the **Console managed identity**, with no fallback to your token |
| Console `/admin/landing-zones` → Attach existing service | your delegated token first, Console managed identity second |

> **The wizard's day-0 scan runs as the Console managed identity.** At first-run
> you are typically Owner across the estate and that identity may hold Reader on
> almost nothing — so the wizard can report far less than you can see. The CLI
> paths run as you and are the more complete view. Making the day-0 scan
> user-delegated-first is in flight.

### Coverage limits you should know

| Limit | Effect | Mitigation |
|---|---|---|
| Resource Graph trims by RBAC and returns **no error** for subscriptions you cannot read | An invisible subscription is indistinguishable from an empty one | Confirm your subscription list with `az account list -o table` and compare |
| The default page size is **1000** rows; `$skipToken` is the only truncation signal | On a very large tenant the wizard's scan can be cut off. Results are ordered by name, so an alphabetical cut can zero out whole services | Use the CLI inventory, which pages, or scope the scan per subscription |
| `allowPartialScopes` is not set | A tenant-scope query above Azure's subscription limit errors rather than returning partial results | Scope to specific subscriptions |

### Run the inventory yourself

```bash
az login
bash scripts/csa-loom/discover-services.sh
```

Or directly, for one service type:

```bash
az graph query -q "Resources | where type =~ 'microsoft.purview/accounts' \
  | project name, resourceGroup, subscriptionId, location" -o table
```

---

## What is scanned

Sixteen service types. For each: the ARM type queried, the environment variables
the tooling emits, the enable flag, and what Loom uses it for.

| Service (key) | ARM type | Adopt via | Enable flag | Loom uses it for |
|---|---|---|---|---|
| `aisearch` | `Microsoft.Search/searchServices` | `EXISTING_AI_SEARCH_SERVICE` +`_RG` +`_SUB` | `aiSearchEnabled` (default **true**) | The AI Search / vector navigators; the Copilot retrieval corpus |
| `apim` | `Microsoft.ApiManagement/service` | `EXISTING_APIM` +`_RG` +`_SUB` | `apimEnabled` (**true**) | The API Marketplace — publish, Try, curl |
| `adx` | `Microsoft.Kusto/clusters` | `EXISTING_KUSTO_CLUSTER` +`_RG` +`_SUB` | `adxEnabled` (**true**) | Real-Time Intelligence: Eventhouse, KQL database / queryset / dashboard |
| `foundry` | `Microsoft.CognitiveServices/accounts` (kind `AIServices`) | `EXISTING_AOAI` +`_RG` +`_SUB` +`_CHAT_DEPLOYMENT` +`_EMBED_DEPLOYMENT` | `aiFoundryEnabled` (**true**) — and `agentFoundryEnabled` (**true**) for the project | Copilot and the AI Foundry agent / orchestration surfaces |
| `purview` | `Microsoft.Purview/accounts` | `EXISTING_PURVIEW` +`_RG` +`_SUB` | `purviewEnabled` | Governance and the data map. **Tenant singleton** |
| `maps` | `Microsoft.Maps/accounts` | `loomAzureMapsAccount` (name only) | `azureMapsEnabled` / `loomMapsEnabled` (**true**, Commercial + GCC only) | The Geo / map editors |
| `synapse` | `Microsoft.Synapse/workspaces` | `EXISTING_SYNAPSE` +`_RG` +`_SUB` | `loomSynapseEnabled` (**true**) | Per-DLZ Synapse — Serverless SQL, dedicated pools, Spark |
| `cosmos` | `Microsoft.DocumentDB/databaseAccounts` | `EXISTING_COSMOS_ACCOUNT` +`_RG` +`_SUB` | `loomConsoleCosmosEnabled` (**true**) | Console metadata plus the graph / vector store |
| `adf` | `Microsoft.DataFactory/factories` | `EXISTING_ADF` +`_RG` +`_SUB` | `loomDataFactoryEnabled` (**true**) | Per-DLZ Data Factory — pipelines, dataflows |
| `eventhubs` | `Microsoft.EventHub/namespaces` | `EXISTING_EVENTHUB_NAMESPACE` +`_RG` +`_SUB` | `loomEventHubEnabled` (**true**) | Eventstream sources, Data Explorer ingest, mirroring CDC transport |
| `streamanalytics` | `Microsoft.StreamAnalytics/streamingjobs` | `EXISTING_ASA_JOB` +`_RG` +`_SUB` | `loomStreamAnalyticsEnabled` (**true**) | The stream-analytics-job editor and the Eventstream transform node |
| `databricks` | `Microsoft.Databricks/workspaces` | `EXISTING_DATABRICKS` +`_RG` +`_SUB` +`_HOSTNAME` | `loomDatabricksEnabled` (**true**) | Per-DLZ Databricks and Unity Catalog |
| `storage` | `Microsoft.Storage/storageAccounts` | *(no consumer — see below)* | — | The medallion lakehouse and org visuals |
| `postgres` | `Microsoft.DBforPostgreSQL/flexibleServers` | *(no consumer)* | `postgresEnabled` (default **false**) | The Postgres-flavoured stores — Loom Unity catalog, DuckLake catalog, Weave |
| `keyvault` | `Microsoft.KeyVault/vaults` | *(reported only — adoption deliberately not offered)* | — | MSAL secret, session secret, the Maps key, the Connections credential store |
| `firewall` | *(no ARM query — flag only)* | *(no adoption)* | `loomFirewallEnabled` (**true**) | Hub egress filtering |

> **Reported but not consumable.** `EXISTING_STORAGE`, `EXISTING_POSTGRES`,
> `EXISTING_KEYVAULT`, `EXISTING_FIREWALL` and `EXISTING_MAPS` are emitted by
> the discovery tooling but **no `.bicepparam` reads them**. Setting them has no
> effect. Maps has an alternate, working input (`loomAzureMapsAccount`); the
> others have none.

### Not scanned at all

Networking (VNets, subnets, Private DNS zones, firewall policies), Log
Analytics, and Azure Container Registry. There is no discovery and no parameter
for any of them, so **bring-your-own networking is not supported today**. This
is the single largest brownfield gap; closing it is in flight.

---

## What Loom changes about an adopted resource

Adoption is not read-only. Before you adopt a production resource, know what
Loom will do to it.

| Service | What Loom changes | Role it needs |
|---|---|---|
| **AI Search** | Creates up to four indexes; enables Entra (AAD) authentication on the service | Search Service Contributor + Search Index Data Contributor |
| **APIM** | Publishes Loom's API products and policies | API Management Service Contributor |
| **ADX / Kusto** | Creates a database; enables streaming ingestion; adds an `AllDatabasesAdmin` principal assignment | Contributor (+ AllDatabasesAdmin) |
| **AI Foundry / AOAI** | Reads existing deployments; creates none. Loom **requires** a chat deployment and an embedding deployment to already exist | Cognitive Services Contributor |
| **Purview** | Registers data sources; creates collections; writes classifications and lineage; runs scans | Data Source Administrator + Data Curator (granted in the **Purview portal**, not by ARM) |
| **Azure Maps** | Reads the account key; creates nothing | Contributor |
| **Synapse** | Sets the Console managed identity as a **workspace SQL administrator**; creates Spark pools if the workload tiers are enabled | Contributor + Synapse Administrator (data plane) |
| **Cosmos** | Creates Loom's containers in the account. **Check for name collisions first** | DocumentDB Account Contributor + the Built-in Data Contributor data-plane role |
| **Data Factory** | Creates Loom's pipelines and linked services in the factory | Data Factory Contributor |
| **Event Hubs** | Creates hubs and consumer groups; grants the ADX cluster receive rights | Event Hubs Data Owner + Contributor |
| **Stream Analytics** | **Edits the job's query and inputs/outputs.** Adopting a *running* production job is destructive — stop it or use a different job | Contributor |
| **Databricks** | **Assigns the workspace to a Unity Catalog metastore**; creates a SCIM service principal for the Console; creates a SQL warehouse | Contributor |
| **Azure SQL (plan backing)** | Reads only — Loom never writes schema to it | per-server Entra admin |

### Granting the roles

```bash
# Reads the same EXISTING_* names and grants at the adopted resource's own
# subscription scope.
bash scripts/csa-loom/grant-navigator-rbac.sh
```

Two things to know:

1. **`_RG` is mandatory for a cross-resource-group or cross-subscription grant.**
   With only `EXISTING_<SVC>` set and no `_RG`, the script prints
   `set its _RG to grant cross-RG/sub — skipping` and grants nothing.
2. **Coverage is seven services**: Event Hubs, Cosmos, AI Search, AOAI, APIM,
   Synapse and Data Factory. **ADX/Kusto, Databricks, Stream Analytics and Maps
   are not covered** — grant those manually using the role in the table above.
   Purview's roles are data-plane and are granted in the Purview portal.

---

## Supplying values by hand

Discovery is a convenience, not a requirement. Every adoption input is an
environment variable or a parameter you can set directly — you never need the
scan to have found something in order to adopt it.

```bash
# You know the resource exists; discovery could not see it (no Reader, another
# tenant boundary, a subscription you excluded). Name it directly.
export EXISTING_AI_SEARCH_SERVICE=corp-search
export EXISTING_AI_SEARCH_RG=rg-shared-ai
export EXISTING_AI_SEARCH_SUB=<sub-id>
```

The values go through the identical code path as a discovered candidate — there
is no separate "manual" mode and no undocumented override. The full name-to-
parameter mapping:

| Environment variable | Bicep parameter | Suppresses creation? |
|---|---|---|
| `EXISTING_AI_SEARCH_SERVICE` / `_RG` / `_SUB` | `existingAiSearchService` / `Rg` / `Sub` | yes |
| `EXISTING_APIM` / `_RG` / `_SUB` | `existingApimName` / `Rg` / `Sub` | yes |
| `EXISTING_KUSTO_CLUSTER` / `_RG` / `_SUB` | `existingAdxClusterName` / `Rg` / `Sub` | yes |
| `EXISTING_AOAI` / `_RG` / `_SUB` / `_CHAT_DEPLOYMENT` / `_EMBED_DEPLOYMENT` | `existingFoundryAccountName` / `Rg` / `Sub` / `existingFoundryChatDeployment` / `EmbedDeployment` | hub account yes; **agent project no** |
| `EXISTING_EVENTHUB_NAMESPACE` / `_RG` / `_SUB` | `existingEventHubNamespace` / `Rg` / `Sub` | yes — **`single-sub` topology only** |
| `EXISTING_ASA_JOB` / `_RG` / `_SUB` | `existingAsaJob` / `Rg` / `Sub` | yes — **`single-sub` topology only** |
| `EXISTING_COSMOS_ACCOUNT` / `_RG` / `_SUB` | `existingCosmosAccount` / `Rg` / `Sub` | yes — **`tenant` / `dlz-attach` only** |
| `EXISTING_PURVIEW` / `_RG` / `_SUB` | `existingPurviewAccount` / `Rg` / `Sub` | **no** — also set `purviewEnabled=false` |
| `EXISTING_SYNAPSE` / `_RG` / `_SUB` | `existingSynapseWorkspace` / `Rg` / `Sub` | **no** — also set `loomSynapseEnabled=false` |
| `EXISTING_DATABRICKS` / `_RG` / `_SUB` / `_HOSTNAME` | `existingDatabricksWorkspace` / `Rg` / `Sub` / `Hostname` | **no** — also set `loomDatabricksEnabled=false` |
| `EXISTING_ADF` / `_RG` / `_SUB` | `existingAdfFactory` / `Rg` / `Sub` | **no** — also set `loomDataFactoryEnabled=false` |
| *(none)* | `loomAzureMapsAccount` | **no** — also set `azureMapsEnabled=false` |
| *(none)* | `loomPlanBackingSqlServer` / `loomSqlServerRg` | adopt-only by design |

The `_SUB` value also flows into a `LOOM_<SVC>_SUB` Console environment variable
that the matching client reads at runtime, falling back to
`LOOM_SUBSCRIPTION_ID` when empty. Purview is the exception: its data plane is
reached by account host name and a portal-granted role, so it is
subscription-agnostic and has no `LOOM_PURVIEW_SUB` wire.

---

## Recommendations Loom makes

Discovery attaches a recommendation to each service. The rules:

| Recommendation | When |
|---|---|
| **Adopt (required)** | The service is a tenant singleton and one exists. **Purview** is the only one today — a second account fails `EnterpriseTenantAlreadyExists` |
| **Adopt** | Exactly one candidate, in the hub's region |
| **Create** | Everything else — including "three candidates found, none obviously right" |

A recommendation is never applied silently. You confirm every service.

---

## Where the estate view lives

There is **no Console surface today that renders "here is your estate, here is
what Loom could adopt."** Discovery output is consumed transiently inside a
wizard step and is not persisted. The `/admin/*` surfaces show Loom's *own*
resources (`/admin/capacity`, `/admin/network`, `/admin/domains`) and its
configuration readiness (`/admin/readiness`, `/admin/gates`) — not the wider
estate.

A persisted deployment plan plus an `/admin/deployment` estate view — showing
the applied plan, its diff against live, and each deploy path's last successful
run — is in flight. Until it lands, the CLI inventory is the estate view.

---

## Design in flight — the `adopt` plan

This section describes work **not on `main` as of 2026-08-05**. It is recorded
here so the shape is known, not as instructions you can follow.

`main.bicep` is at **251 of the ARM cap of 256 parameters**, and 36 of those are
the `existing*` scalars. Adding a name/resource-group/subscription triple for
even one more service breaks the build. The consolidation replaces all 36 with a
single object-typed parameter:

```bicep
@description('Operator adoption plan, keyed by service key.')
param adopt object = {}
// { purview: { mode: 'adopt', target: { name: '...', rg: '...', sub: '...' } }, ... }
```

with one derived `provisionX` variable per service gating every creation site,
so `mode: 'adopt'` **always** suppresses creation — collapsing the class A / class
B distinction in the [brownfield table](brownfield.md#step-2-choose-adopt-or-create-per-service)
and freeing roughly 40 parameters of headroom for networking, storage, Postgres,
Log Analytics and ACR adoption.

The plan is persisted so that all four deploy transports carry it (today only
the copy-paste `az` fallback does), and a blocking fitness suite runs before any
resource is created.

---

## Next

- [**Brownfield deployment**](brownfield.md) — the walkthrough this reference supports
- [**Failure recovery**](failure-recovery.md) — what to do when an adoption fails
- [**Bring-your-own services**](../bring-your-own-services.md) — the original reuse reference
