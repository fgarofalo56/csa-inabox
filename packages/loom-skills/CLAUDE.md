# CSA Loom — Azure-native client patterns for AI coding agents

> This file is auto-loaded by Claude Code, GitHub Copilot, Cursor, Windsurf and
> any agent that reads `AGENTS.md` / `CLAUDE.md`. It is the entry point to the
> **loom-skills** bundle. Read the relevant `skills/<name>/SKILL.md` before
> writing or modifying any CSA Loom backend, BFF route, or client call.

## The one rule that overrides everything

**CSA Loom has NO hard dependency on real Microsoft Fabric or Power BI.** Every
item type works 100% on **Azure-native backends by default**. When you generate
code for a Loom item, call the **Azure-native client**, never
`api.fabric.microsoft.com` / `api.powerbi.com` / `onelake.dfs.fabric.microsoft.com`
on the default path. A Fabric backend is strictly **opt-in** (`LOOM_<ITEM>_BACKEND=fabric`
plus a bound workspace). Never gate a feature on `fabricWorkspaceId` without an
Azure-native fallback in the same function.

## Item → Azure-native backend → client (the map you must follow)

| Loom item | Azure-native DEFAULT | Primary client(s) under `apps/fiab-console/lib/azure/` | BFF route |
|---|---|---|---|
| lakehouse | ADLS Gen2 + Delta (+ Synapse table reg) | `adls-client.ts`, `synapse-sql-client.ts` | `/api/lakehouse`, `/api/onelake` |
| warehouse | Synapse dedicated SQL pool | `synapse-sql-client.ts`, `synapse-pool-arm.ts` | `/api/warehouse`, `/api/synapse` |
| kql-database / eventhouse | Azure Data Explorer (ADX) | `kusto-client.ts`, `kusto-arm-client.ts` | `/api/adx` |
| kql-dashboard | Loom-native dashboard over ADX | `kql-dashboard-model.ts`, `kusto-client.ts` | `/api/adx` |
| eventstream | Azure Event Hubs (+ Stream Analytics) | `eventhubs-client.ts`, `stream-analytics-client.ts` | `/api/eventhubs` |
| data-pipeline | Synapse pipeline / ADF | `synapse-dev-client.ts`, `adf-client.ts` | `/api/adf`, `/api/synapse` |
| activator (Reflex) | Azure Monitor scheduled-query alert | `monitor-client.ts` | `/api/monitor` |
| mirrored-database | ADF CDC / Synapse Link → ADLS Bronze Delta | `adf-client.ts`, `mirror-engine.ts` | `/api/items`, `/api/adf` |
| semantic-model | Loom-native tabular over warehouse (AAS optional) | `aas-client.ts`, `synapse-sql-client.ts` | `/api/powerbi`, `/api/items` |
| report | Loom-native report renderer | `paginated-report-client.ts` | `/api/powerbi` |
| search / catalog | Azure AI Search + Cosmos | `loom-search.ts`, `loom-docs-index.ts` | `/api/ai-search`, `/api/search` |

## Before you touch any endpoint host: read `loom-cloud-endpoints`

CSA Loom runs in **Commercial, GCC, GCC-High and DoD**. Hostnames differ per
cloud. **Never hard-code `management.azure.com` / `kusto.windows.net` /
`dfs.core.windows.net`.** Derive every host from
`apps/fiab-console/lib/azure/cloud-endpoints.ts` helpers (`armBase()`,
`kustoSuffix()`, `dfsSuffix()`, `getGraphHost()`, …) keyed off `detectLoomCloud()`.
See `skills/loom-cloud-endpoints/SKILL.md`.

## Auth pattern (Azure-native, every client)

```ts
import { ChainedTokenCredential, ManagedIdentityCredential, DefaultAzureCredential } from '@azure/identity';
const credential = process.env.LOOM_UAMI_CLIENT_ID
  ? new ChainedTokenCredential(
      new ManagedIdentityCredential({ clientId: process.env.LOOM_UAMI_CLIENT_ID }),
      new DefaultAzureCredential(),
    )
  : new DefaultAzureCredential();
// per-resource .default scope from cloud-endpoints, e.g. armScope(), SEARCH_AAD_SCOPE
```

## BFF contract every route returns

`{ ok: true, data } | { ok: false, error, code? }` with a correct HTTP status.
When infra is missing, return an **honest config gate** (e.g. HTTP 503,
`code: 'not_configured'`, `error: "ADX cluster not configured: set LOOM_KUSTO_CLUSTER_URI."`).
Never return mock arrays / `return []` / hard-coded sample data.

## Available skills

`skills/loom-cloud-endpoints` · `loom-lakehouse` · `loom-warehouse` ·
`loom-eventhouse-kql` · `loom-eventstream` · `loom-data-pipeline` ·
`loom-activator` · `loom-mirrored-database` · `loom-semantic-model-report` ·
`loom-search-and-catalog` · `loom-items-bff`

Full detail, install instructions and the per-cloud endpoint table are in `README.md`.
