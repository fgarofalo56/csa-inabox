# loom-skills

**Azure-native CSA Loom client patterns for AI coding agents.**

`loom-skills` is the CSA Loom analogue of Microsoft's
[`skills-for-fabric`](https://github.com/microsoft/skills-for-fabric): a bundle of
`SKILL.md` guides that teach an AI coding agent (Claude Code, GitHub Copilot,
Cursor, Windsurf, …) **which Loom BFF route and which `lib/azure` client to call**
for each data item — so the generated code targets the real Azure-native backend
instead of inventing a Microsoft Fabric / Power BI dependency.

Where `skills-for-fabric` teaches `az account get-access-token --resource
https://api.fabric.microsoft.com`, this bundle teaches the **Azure-native default**:
ADLS Gen2 + Delta, Synapse, Azure Data Explorer (ADX), Event Hubs, Azure Monitor
and Azure AI Search — every one reachable in **Commercial, GCC, GCC-High and DoD**
with no Fabric capacity or workspace.

> **Documentation-only.** This package ships no runtime code. It documents the
> contracts of clients that already live in `apps/fiab-console/lib/azure/**` and
> routes under `apps/fiab-console/app/api/**`. Pair it with the live MCP servers
> (`.mcp.json`) when you want the agent to *call* a running Loom, not just learn
> its shape.

---

## Why this exists

An AI agent asked to "add a KQL database to Loom" will, untrained, reach for the
Microsoft Fabric Real-Time Intelligence REST API. That is wrong for CSA Loom:
the Azure-native default is **Azure Data Explorer (ADX)** via `kusto-client.ts`
and the `/api/adx` routes. `loom-skills` encodes that mapping (and ten more) so
the agent produces code that compiles, authenticates, and runs against the
backend Loom actually deploys — honoring the repo's die-hard
`no-fabric-dependency` rule.

---

## Install

`loom-skills` is a Claude Code plugin published through the `loom-collection`
marketplace. From any repo:

```text
# 1. Add the marketplace (from a clone, point at the package dir)
/plugin marketplace add ./packages/loom-skills
#    …or straight from GitHub once published:
/plugin marketplace add <org>/csa-inabox

# 2. Install a bundle
/plugin install loom-skills@loom-collection        # everything (11 skills)
```

Like `skills-for-fabric`, the collection ships **four bundles** so you install
only what the task needs:

| Bundle | Install | Skills |
|---|---|---|
| **loom-skills** | `/plugin install loom-skills@loom-collection` | all 11 |
| **loom-authoring** | `/plugin install loom-authoring@loom-collection` | cloud-endpoints, lakehouse, warehouse, eventhouse-kql, eventstream, data-pipeline, mirrored-database, semantic-model-report, items-bff |
| **loom-consumption** | `/plugin install loom-consumption@loom-collection` | cloud-endpoints, search-and-catalog, semantic-model-report, eventhouse-kql, warehouse |
| **loom-operations** | `/plugin install loom-operations@loom-collection` | cloud-endpoints, activator, items-bff |

`loom-cloud-endpoints` (the MUST-READ sovereign-cloud root) and
`loom-items-bff` (the generic route contract) ship in every authoring/operations
bundle. The `loom-skills` and `loom-consumption` bundles attach the live MCP
servers from `.mcp.json` (see below); the read-only authoring/operations bundles
do not.
without the plugin system), simply having this package in the tree is enough:
`CLAUDE.md`, `AGENTS.md`, `.cursorrules`, and `.windsurfrules` carry the core
rules and point at the skills.

### Live access (optional) — `.mcp.json`

The skills teach the *patterns*; the bundled MCP servers give an agent *live*
access to a running Loom for read-back and validation:

```text
claude --mcp-config ./packages/loom-skills/.mcp.json
```

`.mcp.json` wires two servers shipped in this repo — `apps/fiab-mcp-bridge`
(the Loom MCP bridge) and the in-console iq tools (`/api/iq/mcp`, backed by
`lib/azure/iq-mcp-tools.ts`). Both authenticate with the **same Azure-native
credential chain** the skills teach; no Fabric token is involved. Set these
env vars before attaching:

| Env var | Example |
|---|---|
| `LOOM_MCP_BRIDGE_URL` | `https://<your-bridge-host>/mcp` |
| `LOOM_MCP_BRIDGE_TOKEN` | bearer token for the bridge |
| `LOOM_IQ_MCP_URL` | `https://<your-console-host>/api/iq/mcp` |
| `LOOM_IQ_TOKEN` | bearer token for the console iq tools |

The MCP servers are optional — every skill is fully usable as documentation
without them.

---

## The map every skill enforces

| Loom item | Microsoft Fabric (opt-in only) | **Azure-native DEFAULT** | Client(s) | BFF route | Skill |
|---|---|---|---|---|---|
| lakehouse | OneLake lakehouse | **ADLS Gen2 + Delta** (+ Synapse table reg) | `adls-client.ts`, `synapse-sql-client.ts` | `/api/lakehouse`, `/api/onelake` | `loom-lakehouse` |
| warehouse | Fabric Warehouse | **Synapse dedicated SQL pool** | `synapse-sql-client.ts`, `synapse-pool-arm.ts` | `/api/warehouse` | `loom-warehouse` |
| kql-database / eventhouse | Fabric RTI Eventhouse | **Azure Data Explorer (ADX)** | `kusto-client.ts`, `kusto-arm-client.ts` | `/api/adx` | `loom-eventhouse-kql` |
| kql-dashboard | Fabric Real-Time Dashboard | **Loom-native dashboard over ADX** | `kql-dashboard-model.ts`, `kusto-client.ts` | `/api/adx` | `loom-eventhouse-kql` |
| eventstream | Fabric Eventstream | **Azure Event Hubs** (+ Stream Analytics) | `eventhubs-client.ts`, `stream-analytics-client.ts` | `/api/eventhubs` | `loom-eventstream` |
| data-pipeline | Fabric Data pipeline | **Synapse pipeline / ADF** | `synapse-dev-client.ts`, `adf-client.ts` | `/api/adf` | `loom-data-pipeline` |
| activator (Reflex) | Fabric Activator | **Azure Monitor scheduled-query alert** | `monitor-client.ts` | `/api/monitor` | `loom-activator` |
| mirrored-database | Fabric Mirroring | **ADF CDC / Synapse Link → ADLS Bronze Delta** | `adf-client.ts`, `mirror-engine.ts` | `/api/items`, `/api/adf` | `loom-mirrored-database` |
| semantic-model | Power BI / Fabric model | **Loom-native tabular over warehouse** (AAS optional) | `aas-client.ts`, `synapse-sql-client.ts` | `/api/powerbi`, `/api/items` | `loom-semantic-model-report` |
| report | Power BI report | **Loom-native report renderer** | `paginated-report-client.ts` | `/api/powerbi` | `loom-semantic-model-report` |
| search / catalog | Fabric OneLake catalog | **Azure AI Search + Cosmos** | `loom-search.ts`, `loom-docs-index.ts` | `/api/ai-search`, `/api/search` | `loom-search-and-catalog` |

Source of truth for this table: `.claude/rules/no-fabric-dependency.md`.

---

## Per-cloud endpoint table

CSA Loom runs in four sovereign boundaries. **Never hard-code a hostname.**
Every host comes from `apps/fiab-console/lib/azure/cloud-endpoints.ts`, keyed off
`detectLoomCloud()` (`LOOM_CLOUD` → `AZURE_CLOUD` fallback). `loom-cloud-endpoints`
is the MUST-READ root skill.

| Resource | Commercial / GCC | GCC-High / IL5 | DoD | Helper |
|---|---|---|---|---|
| ARM control plane | `management.azure.com` | `management.usgovcloudapi.net` | `management.azure.microsoft.scloud` | `armBase()` / `armScope()` |
| ADLS Gen2 (DFS) | `dfs.core.windows.net` | `dfs.core.usgovcloudapi.net` | `dfs.core.usgovcloudapi.net` | `dfsSuffix()` / `dfsUrl()` |
| ADX (Kusto) | `kusto.windows.net` | `kusto.usgovcloudapi.net` | `kusto.usgovcloudapi.net` | `kustoSuffix()` / `kustoClusterUri()` |
| Service Bus / Event Hubs | `servicebus.windows.net` | `servicebus.usgovcloudapi.net` | `servicebus.usgovcloudapi.net` | `serviceBusSuffix()` / `serviceBusFqdn()` |
| Synapse SQL | `sql.azuresynapse.net` | `sql.azuresynapse.usgovcloudapi.net` | `sql.azuresynapse.usgovcloudapi.net` | `synapseSqlSuffix()` |
| Key Vault | `vault.azure.net` | `vault.usgovcloudapi.net` | `vault.usgovcloudapi.net` | `kvSuffix()` / `kvScope()` |
| AI Search | `search.windows.net` | `search.azure.us` | `search.azure.us` | `getSearchSuffix()` (scope: `SEARCH_AAD_SCOPE`, cloud-invariant) |
| Microsoft Graph | `graph.microsoft.com` | `graph.microsoft.us` | `dod-graph.microsoft.us` | `getGraphHost()` / `getGraphScope()` |
| Cosmos DB | `documents.azure.com` | `documents.azure.us` | `documents.azure.us` | `cosmosSuffix()` |
| Log Analytics query | `api.loganalytics.azure.com` | `api.loganalytics.us` | `api.loganalytics.us` | `getLogAnalyticsHost()` |
| Azure OpenAI | `openai.azure.com` | `openai.azure.us` | `openai.azure.us` | `getOpenAiSuffix()` / `cogScope()` |

`GCC` runs on Commercial Azure endpoints but is kept a distinct `LoomCloud`
value so the console can badge it; `IL5` is an alias of `GCC-High`. The
Fabric-family surfaces (`api.fabric.microsoft.com`, `api.powerbi.com`) have **no
GCC-High / DoD endpoint** — `assertFabricFamilyAvailable()` throws an honest
error directing callers to the Azure-native equivalent there.

---

## Required environment per backend

The skills introduce **no new env vars** — they document the ones bicep already
wires (`platform/fiab/bicep/modules/**`, projected into the console's `apps[]`
env list in `admin-plane/main.bicep`). Common ones:

| Backend | Key env vars | Bicep module |
|---|---|---|
| Sovereign cloud selector | `LOOM_CLOUD`, `AZURE_CLOUD`, `LOOM_ARM_ENDPOINT` | `admin-plane` |
| Identity | `LOOM_UAMI_CLIENT_ID` (UAMI), `AZURE_CLIENT_ID` | `shared` |
| Lakehouse (ADLS) | `LOOM_ADLS_ACCOUNT` | `landing-zone` |
| Warehouse / pipelines | `LOOM_SYNAPSE_WORKSPACE`, `LOOM_WAREHOUSE_BACKEND` | `integration` |
| ADX / KQL | `LOOM_KUSTO_CLUSTER_URI`, `LOOM_KUSTO_DATABASE` | `ai` / `integration` |
| Eventstream | `LOOM_EVENTHUBS_NAMESPACE` | `integration` |
| Activator | `LOOM_MONITOR_*`, Log Analytics workspace id | `admin-plane` |
| Search / catalog | `LOOM_AI_SEARCH_SERVICE`, `LOOM_COSMOS_ENDPOINT` | `ai` / `admin-plane` |
| Fabric (opt-in only) | `LOOM_<ITEM>_BACKEND=fabric`, `LOOM_DEFAULT_FABRIC_WORKSPACE`, `LOOM_FABRIC_BASE` | n/a (tenant) |

When an env var is unset, the matching BFF route returns an **honest config gate**
(HTTP 503, `code: 'not_configured'`, naming the exact var) — never a mock.

---

## Governance honored

- **no-fabric-dependency** — every skill defaults to the Azure-native column;
  Fabric is documented only as a `LOOM_<ITEM>_BACKEND=fabric` opt-in. No skill
  puts `api.fabric.microsoft.com` on a default path.
- **no-vaporware** — every documented route teaches the real `{ok,data,error}`
  contract and the honest MessageBar / 503 gate. No skill documents a mock or
  `return []` path.
- **loom-no-freeform-config** — skills present enumerated choices (backend enums,
  catalog ids, `KnownContainer`), not "paste arbitrary JSON".
- **ui-parity** — each skill cross-links the matching `docs/fiab/parity/<slug>.md`
  inventory so the agent-facing API doc and the UI parity doc stay aligned.

---

## Layout

```text
packages/loom-skills/
├── README.md                 ← you are here
├── LICENSE                   ← MIT
├── CLAUDE.md  AGENTS.md      ← auto-pickup rules (Claude / generic agents)
├── .cursorrules  .windsurfrules
├── .claude-plugin/
│   └── marketplace.json      ← loom-collection marketplace (4 bundles)
├── plugins/                  ← one manifest dir per bundle
│   ├── loom-skills/.claude-plugin/plugin.json
│   ├── loom-authoring/.claude-plugin/plugin.json
│   ├── loom-consumption/.claude-plugin/plugin.json
│   └── loom-operations/.claude-plugin/plugin.json
├── .mcp.json                 ← live MCP servers (loom-bridge, loom-iq)
├── package.json
├── scripts/
│   ├── loom-token.sh         ← acquire an Azure-native token for the active cloud
│   └── loom-endpoint-probe.sh← print the resolved per-cloud endpoint table
└── skills/
    ├── loom-cloud-endpoints/SKILL.md      (MUST-READ root)
    ├── loom-lakehouse/SKILL.md
    ├── loom-warehouse/SKILL.md
    ├── loom-eventhouse-kql/SKILL.md
    ├── loom-eventstream/SKILL.md
    ├── loom-data-pipeline/SKILL.md
    ├── loom-activator/SKILL.md
    ├── loom-mirrored-database/SKILL.md
    ├── loom-semantic-model-report/SKILL.md
    ├── loom-search-and-catalog/SKILL.md
    └── loom-items-bff/SKILL.md
```

## License

MIT — see [LICENSE](./LICENSE).
