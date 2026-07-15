# Admin Health / Self-Audit — coverage audit (operator review 3.1)

**Date:** 2026-07-15 · **Engine:** `apps/fiab-console/lib/admin/self-audit.ts` (+ `health-probes.ts`, `health-coverage.ts`) · **Surface:** `/admin/health`

The operator suspected the "54 checks" self-audit had big gaps. **Confirmed.**
This audit enumerates what the 54 checks actually probed, measures them against
Loom's real surface area (117 Azure clients, 129 item types in 22 workload
families, ~614 `LOOM_*` env vars read at runtime), and records what this wave
added and what still remains.

## 1. Before / after headline

| Dimension | Before (54 checks) | After this wave | Still missing |
|---|---|---|---|
| Env-gate checks (`ENV_CHECKS`) | 43 | **55** (+12 backends that had NO check at all) | per-feature toggles (~hundreds of tuning knobs — deliberately unchecked, safe defaults) |
| Live probes (real call as the Console UAMI) | 8 | **24** (+16) | 12 backends have an env gate but still no live probe (§5) |
| Derived workload-family checks | 0 | **22** (one per item-type category, auto-derived) | — |
| Gates-registry checks | 0 | bridge in place (`gate-registry.ts`) | wiring blocked until `lib/gates/registry.ts` lands (CI-guarded) |
| **Total checks on /admin/health** | **54** | **104** | — |
| Azure clients with mapped coverage | ~34 of 117 | **117 of 117** (109 checks-mapped, 8 allowlisted with reasons) | — |
| Runtime-safe healer fixes | 1 (`ensure-cosmos`) | **3** (+`ensure-search-index`, `ensure-spark-lease-container`) | env/RBAC/tenant fixes are approval-gated by design |
| CI enforcement of coverage growth | none | **`scripts/ci/check-health-coverage.mjs`** (merge-blocker in loom-guardrails.yml) | — |

Two layers exist and are complementary — this audit covers both:

- **Self-audit** (`/admin/health`, runs on page load): *is each backend configured, reachable, authorized* — env gates + bounded live probes.
- **Service exercise** (`/admin/health` → exercise pane, `lib/admin/service-probes.ts`, on demand): *does the real data path work end-to-end* — 8 deep exercises (spark session run, warehouse SQL, ADX query, ADLS round-trip, Cosmos, AOAI chat, domain sync, ADF). Unchanged this wave; deep-exercise gaps listed in §5.

## 2. What the original 54 checks covered

43 env-presence gates (identity ×3, data plane ×2, permissions ×2, Azure services ×17, builders ×6, catalog-governance ×2, AI/Copilot ×2, security ×3, H-band substrates ×4, misc ×2) + 8 live probes (Cosmos, AOAI, Purview Data Map, AI Search governance index, Databricks, Delta Sharing, DLP Graph roles, posture Function) + 3 security-posture checks.

**The structural problem:** coverage was a hand-list. Nothing forced a new
client, item family, or env var to get a check — which is exactly how the gaps
below accumulated.

## 3. Gap analysis by subsystem (the honest table)

Legend: ✅ covered before · ➕ covered by THIS wave · ⚠️ env gate only (live probe still missing) · ❌ still missing.

### 3.1 Core platform

| Subsystem | Backend | Before | Now |
|---|---|---|---|
| Loom store | Cosmos DB | ✅ env + probe + healer | ✅ |
| Identity / sign-in | MSAL app, UAMI, session secret | ✅ env | ✅ |
| Bootstrap admin | tenant-admin OID/group | ✅ env | ✅ |
| **ARM control plane** | UAMI Reader/Contributor on the deployment (every navigator, monitor, cost, scaling read) | ❌ **no check at all** | ➕ `probe-arm-reader` (live RG read, critical) |
| **Key Vault** | connection/shortcut/Git-PAT/MCP secrets | ❌ | ➕ `svc-keyvault` + `probe-keyvault` |
| Networking (PE subnet) | managed private endpoints | ✅ env (derived) | ✅ |
| Result cache | Redis (shared) / in-memory fallback | ❌ | ➕ `svc-redis-result-cache` (optionalDefault — in-memory fallback loses zero function) |

### 3.2 Data plane workloads

| Subsystem | Backend | Before | Now |
|---|---|---|---|
| Lakehouse / files | ADLS Gen2 | ✅ env only | ➕ `probe-adls` (live listContainers + RBAC detection) |
| Warehouse / notebooks / pipelines | Synapse | ✅ env only | ➕ `probe-synapse` (live listSparkPools) |
| KQL / eventhouse / RTI | ADX | ✅ env only | ➕ `probe-kusto` (live `.show version`) |
| Eventstream | Event Hubs | ✅ env only | ➕ `probe-eventhubs` (live list) |
| Pipelines (ADF) / mirroring CDC | Data Factory | ✅ env only | ➕ `probe-adf` (live factory read) |
| Databricks (notebooks/SQL/UC) | Databricks | ✅ env + probe | ✅ |
| Delta Sharing | UC metastore | ✅ probe | ✅ |
| **Azure SQL items** | SQL logical servers | ❌ | ➕ `svc-azure-sql` ⚠️ (no live probe yet) |
| **Lakebase / pgvector** | PostgreSQL Flexible | ❌ | ➕ `svc-postgres` ⚠️ |
| **Stream Analytics jobs** | ASA | ❌ | ➕ `svc-stream-analytics` ⚠️ |
| **Event Grid topics / shims** | Event Grid | ❌ | ➕ `svc-eventgrid` ⚠️ |
| **Service Bus queues/topics** | Service Bus | ❌ | ➕ `svc-servicebus` + `probe-servicebus` |
| **Batch pools** | Azure Batch | ❌ | ➕ `svc-batch` ⚠️ |
| Warm Spark pool store | Cosmos lease container / Redis | ✅ env | ✅ + healer `ensure-spark-lease-container` |

### 3.3 Analytics / BI

| Subsystem | Backend | Before | Now |
|---|---|---|---|
| **Semantic models / reports fast path** | Analysis Services | ❌ **entirely unmonitored** | ➕ `svc-aas` ⚠️ |
| Report embeds (usage/govern) | Grafana / Power BI | ✅ env | ✅ (⚠️ no live Grafana probe) |
| Maps visuals | Azure Maps | ✅ env | ✅ |
| **Paginated reports (RDL)** | renderer Function | ❌ | ➕ `probe-paginated-renderer` |
| Direct Lake / OneLake / broker | H-band ACA apps | ✅ env (optionalDefault) | ✅ |

### 3.4 AI & Copilot

| Subsystem | Backend | Before | Now |
|---|---|---|---|
| Copilot / agents model | AOAI / Foundry | ✅ env + probe | ✅ |
| AI enrichment (5 cognitive services) | shared AIServices account | ✅ env (optionalDefault) | ✅ |
| AI Search / RAG | AI Search | ✅ env + index probe | ✅ + healer `ensure-search-index` |
| **AML (ml-model / AutoML / experiments)** | Azure ML workspace | ❌ **entirely unmonitored** (the whole Data Science family) | ➕ `svc-aml` ⚠️ |
| MCP built-in server | ACA app | ✅ env only | ➕ `probe-builtin-mcp` (reachability) |
| MCP catalog deploy | ACA env | ✅ env | ✅ |

### 3.5 Builders / APIs

| Subsystem | Backend | Before | Now |
|---|---|---|---|
| DAB preview runtime | ACA app | ✅ env only | ➕ `probe-dab-runtime` |
| UDF runtime | ACA/Functions | ✅ env only | ➕ `probe-udf-runtime` |
| **APIM (publish-as-API / API marketplace)** | API Management | ❌ | ➕ `svc-apim` + `probe-apim` |
| SWA publish (Workshop/Slate) | Static Web Apps | ✅ env | ✅ (⚠️ no live probe) |
| Plan SQL writeback | Azure SQL | ✅ env (optionalDefault) | ✅ |

### 3.6 Governance / security / admin subsystems

| Subsystem | Backend | Before | Now |
|---|---|---|---|
| Purview Data Map | Purview | ✅ env + probe | ✅ |
| DLP / MIP Graph roles | Microsoft Graph | ✅ probe | ✅ |
| **Directory enrichment (Users page, identity pickers)** | Graph Directory.Read.All | ✅ env only | ➕ `probe-graph-directory` (live 1-row search) |
| **Log Analytics (monitor / audit / activator continuous eval)** | LA workspace | ✅ env only (derived) | ➕ `probe-log-analytics` (live `print` query) |
| SIEM audit stream (DCR) | Azure Monitor ingestion | ✅ env (optionalDefault) | ✅ |
| Posture refresh | Function | ✅ env + probe | ✅ |
| OneLake security ACLs | ADLS POSIX | ✅ env | ✅ |
| **Power Platform (power-* items, Copilot Studio)** | BAP API | ❌ **entirely unmonitored — the live 403 class the operator hit** | ➕ `svc-powerplatform` + `probe-powerplatform` (surfaces the SP-registration 403 with the exact one-time `New-PowerAppManagementApp` fix) |
| Defender / DSPM posture reads | ARM / LA | ❌ | ➕ covered via `probe-arm-reader` + `probe-log-analytics` |

### 3.7 Workload families (item-type catalog — 129 types, 22 categories)

Before: the catalog was **not represented in health at all** — a family whose
backend was dead only showed up as a low-level env warn, and a NEW family could
land with zero coverage.

Now: `lib/admin/health-coverage.ts` derives **one aggregated check per family**
from `health-coverage-map.json` + the live catalog (worst status of the mapped
backend checks, with item-type slugs in the detail). A new category with no
mapping renders a RED check **and** fails CI. All 22 families mapped: Data
Engineering, Data Factory, Data Warehouse, Databases, Real-Time Intelligence,
Data Science, Loom IQ, Power BI, APIs and functions, Synapse Analytics, Azure
Databricks, Azure Data Factory, Streaming analytics, Azure AI Foundry, Azure
SQL Database, Azure Geoanalytics, Azure Graph + Vector, CSA Data Products,
Copilot Studio, Power Platform, AI & Agents, Loom Apps.

### 3.8 Azure clients (117 files in `lib/azure/*-client.ts`)

Every client now has an explicit entry in
`apps/fiab-console/lib/admin/health-coverage-map.json`:

- **109 mapped to checks** that guard their backend (per-client mapping in the file).
- **8 allowlisted with written justifications** (genuinely opt-in / uncheckable):
  `fabric-client` (Fabric is opt-in only per no-fabric-dependency.md),
  `browser-tool-client`, `cosmos-vcore-vector-client`, `devcenter-client`,
  `graph-drive-client`, `gremlin-client`, `iothub-client`, `onelake-catalog-client`.

CI (`scripts/ci/check-health-coverage.mjs`) fails when a client file appears
with no entry, an entry references a nonexistent check id, an entry goes stale,
or an allow reason is not a real justification.

### 3.9 Env manifest

The console reads ~614 distinct `LOOM_*` vars. The health-relevant backend
config subset is the union of `ENV_CHECKS` required/anyOf vars — grown
**73 → 90** editable vars this wave (env-config derives its editable whitelist
from `ENV_CHECKS`, so the 17 new vars are now settable from `/admin/env-config`
instead of being silently dropped by the PUT whitelist). The remaining ~520 are
per-feature tuning knobs with safe defaults (timeouts, caps, API versions) —
deliberately not health checks.

## 4. Inline remediation (operator review 3.3)

Every non-pass finding renders ON the page (no "see docs elsewhere"):

- **Remediation** paragraph: exact env var / role / resource, always present.
- **"How to fix" expandable**: numbered Azure-portal walkthrough + a
  copy-paste PowerShell/Az-CLI script **pre-filled with this deployment's**
  subscription, RG, app name, and UAMI client id (`CTX`).
- **Inline Heal / Dry-run buttons** next to the finding for the 3 runtime-safe
  fixes; everything else is approval-gated with the honest
  "needs redeploy / grant" badge.
- New probes carry precise RBAC portal steps + grant scripts on 401/403
  (e.g. the Power Platform probe ships the one-time
  `New-PowerAppManagementApp` fix the operator previously had to dig out of
  memory).

## 5. Prioritized remaining gaps (next wave)

Live probes still missing (env gate only today) — in priority order:

1. **AAS live probe** (semantic-model fast path — a stopped/paused server is invisible today; known env-misconfig class from 06-29).
2. **AML workspace live probe** (Data Science family: workspace read + compute list).
3. **Azure SQL live probe** (logical-server ARM read; mirroring change-feed grant check).
4. **Postgres Flexible live probe** (AAD token + `SELECT 1` — Lakebase).
5. **Grafana reachability probe** (usage/govern embeds on Gov clouds).
6. **SWA publish probe** (RG + Website Contributor verification).
7. **Stream Analytics / Event Grid / Batch ARM reads** (cheap `armGet` liveness).
8. **Deep exercises** (service-probes.ts layer): eventstream publish→consume round-trip, Purview scan trigger, Databricks SQL warehouse query, report render.
9. **Gates registry wiring** — when `lib/gates/registry.ts` lands, flip
   `GATES_REGISTRY_WIRED` per the bridge header (CI fails if forgotten).
10. **Healer growth**: `ensure-eventhub-consumer-group`, `ensure-adx-default-db`
    (idempotent createIfNotExists-class fixes the UAMI can already perform).

## 6. How coverage stays honest (no-vaporware)

- Every check is a real env read or a real Azure call as the Console UAMI; the
  family checks AGGREGATE real results — nothing invents a green.
- `optionalDefault` passes are reserved for genuine silent-fallback substrates
  and carry an honest "fallback active" detail naming the fallback.
- The healer only exposes idempotent, runtime-safe fixes; RBAC/env/tenant fixes
  return the exact command + `redeploy: true` instead of pretending.
- Tests: `lib/admin/__tests__/self-audit-healer.test.ts` proves the
  fail → heal → green loop against an injected SDK-level failure with the real
  Cosmos payloads asserted; `health-coverage.test.ts` pins the registry ↔
  catalog ↔ engine coherence; `check-health-coverage.mjs` blocks merges that
  would let coverage lag the codebase.
