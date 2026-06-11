---
name: loom-cloud-endpoints
description: MUST-READ root skill for CSA Loom. Resolve every Azure endpoint host and AAD scope from cloud-endpoints.ts instead of hard-coding management.azure.com / kusto.windows.net / dfs.core.windows.net. Triggers on sovereign cloud, GCC, GCC-High, DoD, IL5, endpoint, hostname, ARM, scope, token audience, government cloud.
allowed-tools: Read, Grep, Glob, Bash
---

# loom-cloud-endpoints — sovereign-cloud endpoint resolution

**Read this before writing any Loom client or BFF code that touches an Azure
endpoint.** CSA Loom runs in four boundaries — **Commercial, GCC, GCC-High (IL5),
DoD** — and every Azure resource has a *different* hostname per boundary. Code
that hard-codes a Commercial host (`management.azure.com`, `kusto.windows.net`,
`dfs.core.windows.net`, `graph.microsoft.com`, …) **silently fails in Government**.

## The single source of truth

`apps/fiab-console/lib/azure/cloud-endpoints.ts`. Every host suffix and AAD scope
lives there and nowhere else. Import a helper; never inline a literal.

### Detect the active boundary

```ts
import { detectLoomCloud, detectCloud, isGovCloud } from '@/lib/azure/cloud-endpoints';

// LoomCloud = 'Commercial' | 'GCC' | 'GCC-High' | 'DoD'
const cloud = detectLoomCloud();   // canonical 4-way discriminator
const isGov = isGovCloud();        // true for GCC-High / IL5 / DoD
```

Selection precedence (implemented in `detectLoomCloud()`):
1. `LOOM_CLOUD` — canonical enum (`Commercial|GCC|GCC-High|DoD`; `IL5` aliases `GCC-High`).
2. `AZURE_CLOUD` — legacy fallback (`AzureCloud|AzureUSGovernment|AzureDOD`).
3. `LOOM_ARM_ENDPOINT` — explicit ARM base override (wins for ARM host resolution).

`GCC` runs on Commercial Azure endpoints, so `detectCloud()` collapses it to
`AzureCloud` — but `detectLoomCloud()` keeps it distinct for badging and the
3-way Graph split.

### Resolve hosts and scopes

| Need | Helper | Commercial | GCC-High / IL5 |
|---|---|---|---|
| ARM base / scope | `armBase()`, `armScope()`, `armAudience()` | `https://management.azure.com` | `…usgovcloudapi.net` |
| ADLS Gen2 DFS | `dfsSuffix()`, `dfsUrl(account)` | `dfs.core.windows.net` | `dfs.core.usgovcloudapi.net` |
| ADX cluster | `kustoSuffix()`, `kustoClusterUri(name, region)` | `kusto.windows.net` | `kusto.usgovcloudapi.net` |
| Service Bus / EH | `serviceBusSuffix()`, `serviceBusFqdn(ns)` | `servicebus.windows.net` | `servicebus.usgovcloudapi.net` |
| Synapse SQL | `synapseSqlSuffix()`, `synapseSqlJdbcHostCert()` | `sql.azuresynapse.net` | `sql.azuresynapse.usgovcloudapi.net` |
| Key Vault | `kvSuffix()`, `kvScope()`, `kvUrlFromName(n)` | `vault.azure.net` | `vault.usgovcloudapi.net` |
| AI Search | `getSearchSuffix()`, `searchEndpointBase(svc)` + `SEARCH_AAD_SCOPE` | `search.windows.net` | `search.azure.us` |
| Graph | `getGraphHost()`, `getGraphScope()` | `graph.microsoft.com` | `graph.microsoft.us` (DoD: `dod-graph.microsoft.us`) |
| Cosmos | `cosmosSuffix()`, `cosmosEndpointFromName(n)` | `documents.azure.com` | `documents.azure.us` |
| Log Analytics query | `getLogAnalyticsHost()` | `api.loganalytics.azure.com` | `api.loganalytics.us` |
| Azure OpenAI | `getOpenAiSuffix()`, `cogScope()` | `openai.azure.com` | `openai.azure.us` |
| Cost Mgmt / Monitor | `getCostManagementBase()`, `getMonitorBase()` (= `armBase()`) | ARM host | ARM host |

`SEARCH_AAD_SCOPE` (`https://search.azure.com/.default`) is cloud-invariant — the
resource audience is byte-identical across clouds; only the token issuer changes.

## Auth credential chain (every Loom client)

```ts
import { ChainedTokenCredential, ManagedIdentityCredential, DefaultAzureCredential } from '@azure/identity';

const credential = process.env.LOOM_UAMI_CLIENT_ID
  ? new ChainedTokenCredential(
      new ManagedIdentityCredential({ clientId: process.env.LOOM_UAMI_CLIENT_ID }),
      new DefaultAzureCredential(),
    )
  : new DefaultAzureCredential();

const token = await credential.getToken(armScope()); // scope from cloud-endpoints
```

## Fabric-family gate (opt-in surfaces only)

`api.fabric.microsoft.com` / `api.powerbi.com` have **no GCC-High / DoD endpoint**.
Before any Fabric-family call, guard with:

```ts
import { assertFabricFamilyAvailable } from '@/lib/azure/cloud-endpoints';
assertFabricFamilyAvailable('fabric'); // throws an honest error in Gov, naming the Azure-native equivalent
```

This is only relevant on the **opt-in** Fabric path. The Azure-native default
never calls these hosts.

## Do / don't

- DO derive every host + scope from a `cloud-endpoints.ts` helper.
- DO read `LOOM_CLOUD` / `AZURE_CLOUD` for boundary, not a hard-coded flag.
- DON'T write `https://management.azure.com` / `kusto.windows.net` /
  `*.dfs.core.windows.net` / `graph.microsoft.com` as a string literal anywhere
  but `cloud-endpoints.ts` (the no-vaporware grep gate flags it).
- DON'T assume a Commercial scope works in Gov — token audiences differ.

## Example prompt this skill answers

> "Add a client that lists blobs in the Loom storage account."

→ Build the DFS URL with `dfsUrl(process.env.LOOM_ADLS_ACCOUNT)`, acquire a token
with the UAMI-first chain at the storage `.default` scope, and never hard-code
`.dfs.core.windows.net`. See `loom-lakehouse` for the full client.
