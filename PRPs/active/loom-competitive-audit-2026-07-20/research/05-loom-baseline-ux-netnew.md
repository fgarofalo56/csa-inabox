# 05 — Loom Baseline, UX Audit & Burn-the-Box Net-New

> **Anchor doc** for the CSA Loom competitive audit (2026-07-20). Parts 1–3 are
> evidence-grounded (read from `E:\Repos\GitHub\csa-inabox`, file references
> inline). Part 4 is visionary. This is the "what Loom IS today" ground truth
> the rest of the audit reasons against.

---

## Loom by the numbers (authoritative, repo-read 2026-07-20)

| Dimension | Count | Source |
|---|---:|---|
| Item types in the catalog | **132** unique slugs across **22** workload categories | `lib/catalog/item-types/*.ts` (grep `slug:`) |
| Rich editors registered | **132** item-type → editor bindings | `lib/editors/registry.ts` (`EDITOR_REGISTRY`) |
| Editor source files | **348** `.tsx` (~189k LOC) | `lib/editors/**` |
| App page routes | **112** `page.tsx` | `apps/fiab-console/app/**` |
| BFF API routes | **1,473** `route.ts` | `apps/fiab-console/app/api/**` |
| Azure client modules | **370** `.ts` | `lib/azure/*.ts` |
| Total console lib files | **2,311** `.ts`/`.tsx` | `apps/fiab-console/lib/**` |
| Parity docs | **423** `docs/fiab/parity/*.md` + dozens of `*-parity-spec.md` | `docs/fiab/**` |
| Thread/Weave cross-surface bridges | **13** one-click "Weave" actions | `lib/thread/thread-actions.ts` |
| Bicep modules | **148** `*.bicep` | `platform/fiab/bicep/**` |
| Cosmos containers (known) | **~91** | `lib/azure/cosmos-client.ts` (`KNOWN_CONTAINER_IDS`) |
| `LOOM_*` env vars referenced | **~749** | `lib/**` |
| GitHub workflows | **81** total, **~23** deploy/gov, **12** gov-named | `.github/workflows/**` |
| Deployable MCP servers catalogued | **32** + 4 deploy-ready + 12 remote-builtin | `lib/mcp/catalog.ts` |
| Service navigators (ADF-Studio-class) | **12** | `lib/components/**/*-tree.tsx` |
| Copilot tool packs | **39** files; cross-item orchestrator exposes **38+** tools; **15** per-surface personas | `lib/copilot/**`, `lib/azure/copilot-*.ts` |
| Use-case apps (install→provision→seed) | **29** content bundles | `lib/apps/content-bundles/**` |

---

# PART 1 — Authoritative Loom Current-State Inventory

## 1.1 Item catalog — 132 item types, 22 workload categories

The catalog is composed from per-category slices merged in
`lib/catalog/fabric-item-types.ts` (barrel) into `FABRIC_ITEM_TYPES`. Each item
carries `slug`, `displayName`, `restType`, `category`, `description`,
`createConfig` (runtime choices), and `learnContent` (overview + steps + docs
URL). Categories and item counts:

| Category | Items | Slice file |
|---|---:|---|
| Loom IQ (Fabric IQ / ontology-graph) | 15 | `item-types/fabric-iq.ts` |
| Data Engineering | 13 | `item-types/data-engineering.ts` |
| Real-Time Intelligence | 12 | `item-types/real-time-intelligence.ts` |
| Data Factory | 12 | `item-types/data-factory.ts` |
| Azure AI Foundry | 11 | `item-types/azure-ai-foundry.ts` |
| Azure SQL Database | 8 | `item-types/azure-sql-database.ts` |
| Copilot Studio | 7 | `item-types/copilot-studio.ts` |
| APIs and functions | 7 | `item-types/apis-and-functions.ts` |
| Power Platform | 6 | `item-types/power-platform.ts` |
| Synapse Analytics | 5 | `item-types/synapse-analytics.ts` |
| Power BI | 5 | `item-types/power-bi.ts` |
| CSA Data Products | 5 | `item-types/csa-data-products.ts` |
| Azure Graph + Vector | 5 | `item-types/azure-graph-vector.ts` |
| Azure Databricks | 5 | `item-types/azure-databricks.ts` |
| Databases | 4 | `item-types/databases.ts` |
| Azure Geoanalytics | 4 | `item-types/azure-geoanalytics.ts` |
| Fabric Apps / Loom Apps | 3 | `item-types/fabric-apps.ts` |
| Data Warehouse | 3 | `item-types/data-warehouse.ts` |
| Data Science | 3 | `item-types/data-science.ts` |
| Azure Data Factory | 3 | `item-types/azure-data-factory.ts` |
| AI & Agents | 2 | `item-types/ai-agents.ts` |
| Streaming analytics | 1 | `item-types/streaming-analytics.ts` |

**The strategic point:** this single catalog spans what nine separate products
cover — Fabric (lakehouse/warehouse/RTI/pipelines/notebooks/semantic model),
Power BI (report/dashboard/semantic model), Databricks (notebook/job/UC), Synapse
(SQL/Spark/pipelines), ADF, Azure AI Foundry (hub/project/agents), Copilot Studio,
Power Platform, and Palantir-Foundry-class ontology/IQ — all as first-class item
types under one `+ New` dialog.

## 1.2 Editors — 132 registered, 348 files, organized by domain

`lib/editors/registry.ts` maps 132 item-type slugs to lazy-loaded editor
components (`dynamic(..., { ssr:false })` with a shared `EditorLoadingSkeleton`).
Domain subfolders:

- `editors/lakehouse/` (2) — `lakehouse-editor-shell.tsx` (**5,227 LOC**, the
  largest single editor: ADLS Gen2 browser + OPENROWSET preview + Spark conf).
- `editors/phase3/` (18) — RTI + semantic: `semantic-model-editor.tsx` (4,576),
  `eventhouse-editor.tsx` (2,723), `eventstream-editor.tsx` (2,494),
  `kql-database-editor.tsx` (2,426), `kql-dashboard-editor.tsx` (2,107),
  `activator-editor.tsx` (1,396).
- `editors/phase4/` (16) — ontology/agent/plan: `plan-editor.tsx` (2,843),
  `ontology-editor.tsx` (2,784), `data-agent-editor.tsx` (2,065).
- `editors/report/` (36) — Power BI report authoring subsystem (analytics pane
  2,082, plus visuals, DAX, navigator dialog).
- `editors/databricks/` (10) — `uc-dialogs.tsx` (3,063), `sql-warehouse-editor.tsx`
  (2,177), `job-editor.tsx` (1,407).
- `editors/palantir/` (7) — Foundry-parity ontology SDK / codegen.
- `editors/components/` (55) — shared canvas/model-view primitives
  (`model-view-canvas.tsx` 1,356).
- `editors/workshop/` (1), `editors/slate/` (1).
- Top-level editors (~200 files) — report-designer (5,135), notebook (3,875),
  data-pipeline (1,808), plus aggregate modules bundling several editors each
  (`apim-editors.tsx` 3,580, `foundry-sub-editors.tsx` 3,272,
  `powerplatform-editors.tsx` 2,365, `copilot-studio-editors.tsx` 1,952,
  `azure-sql-editors.tsx` 1,875, `azure-services-editors.tsx` 1,617,
  `geo-editors.tsx` 1,225, `graph-editors.tsx` 1,196).

Every editor's header comment asserts the `no-fabric-dependency` contract: the
DEFAULT path runs against Azure-native backends with zero Fabric tenant bound;
Fabric is opt-in only.

## 1.3 Pages / surfaces — 112 routes across 8 domains

`apps/fiab-console/app/**` (top-level route groups):

- **Home / workspaces / items:** `home`, `page.tsx`, `workspaces` (+`[id]`),
  `items/[type]/[id]` (+`/permissions`), `new`, `browse`, `welcome`, `experience`
  (data-science, warp).
- **Marketplace / catalog:** `marketplace`, `api-marketplace`, `catalog`
  (`browse`, `unity`, `metastores`, `domains`, `lineage`, `permissions`,
  `data-quality`, `[source]/[id]`), `data-products` (+`[id]`, `new`),
  `external-shares/received`.
- **Governance (18 routes):** `governance` + `purview`, `catalog`, `lineage`,
  `mdm`, `policies`, `scans`, `glossary`, `data-quality`, `irm`, `insights`,
  `access-requests`, `protection-policies`, `workspace-egress`, `govern`,
  `sensitivity`→redirect, `classifications`→redirect, `domains`→redirect.
- **Admin (37 routes):** `admin/*` — `access-packages`, `access-report`,
  `access-requests`, `api-management`, `attribute-groups`, `audit-logs`,
  `batch-labeling`, `capacity`, `chargeback`, `classifications`, `copilot-usage`,
  `deploy-planner`, `domains`, `embed-codes`, `env-config`, `gates`, `health`,
  `landing-zones`, `add-landing-zone`, `mcp-servers`, `network`, `org-visuals`,
  `performance`, `permissions`, `scaling`, `security`, `sensitivity-labels`,
  `tenant-settings`, `updates`, `usage`, `usage-chargeback`, `users`, `webhooks`,
  `workspaces`, `developer/tokens`.
- **Hubs:** `workload-hub` (+`[workload]/[type]`), `rti-hub`, `realtime-hub`,
  `activator-hub`, `workloads`.
- **AI / copilot / thread:** `copilot` (+`skills`), `data-agent`, `thread`,
  `semantic-model`.
- **Ops:** `monitor`, `scheduler`, `deployment-pipelines`, `connections`,
  `business-events`, `onelake`, `org-reports`, `developer` (+`api`), `setup`,
  `settings/developer/tokens`, `apps` (+`[id]`, `view/[id]`).

## 1.4 Use-case apps — 29 install→provision→seed content bundles

`lib/apps/content-bundles/` — 29 `app-*.ts` bundles (~3.1 MB lazy chunks),
registered in `index.ts` `REGISTRY` and `catalog-meta.ts`. Three lineages:
10 curated, 12 docs-1:1 (reproduce `docs/learn/08-solutions/*`), 7 "Supercharge
Fabric" notebook packs re-platformed to Synapse Spark/Databricks + ADLS + ADX.
By domain: FedRAMP tracker, data steward/governance, federal data mesh,
multi-agency onboarding (Government); RAG builder, ML pipeline, sovereign AI
agents (AI); lakehouse inspector, pipeline designer, Fabric-mirror onboard,
Direct-Lake replacement, medallion bronze/silver/gold (Data Eng); IoT real-time,
change-feed processor, real-time dashboards (RTI); casino analytics, healthcare
pop-mgmt HIPAA (Industry); FinOps cost, workspace monitoring, Logic-Apps
integration, hybrid topology (Ops). All `publisher:'CSA'`.

## 1.5 MCP library — 32 deployable + 12 remote-builtin

`lib/mcp/catalog.ts` (2,371 LOC) — four families:
- **`MCP_CATALOG` (32):** gov-safety-tiered pull-image→ACA servers. Tier 0
  air-gap-safe (Filesystem, Git, Sequential Thinking, Time, Memory, Fetch,
  Everything); Tier 1 Microsoft/Azure (Azure MCP, Playwright, Postgres, AKS,
  Microsoft SQL/DAB, Azure DevOps, MarkItDown, NuGet); Tier 2 vendor (GitHub,
  Context7, Grafana, Sentry, Slack, Notion, Stripe, Supabase, Jira, …); Fabric
  family (`govSafe:false`, opt-in only).
- **`MCP_DEPLOY_CATALOG` (4):** operational (GitHub, Grafana, Web Fetch, Time).
- **`REMOTE_BUILTIN_MCP_CATALOG` (12):** Microsoft-hosted remote Streamable-HTTP,
  default-ON opt-out (ms-learn, azure-arm, ms-foundry, ms-graph, m365, teams,
  onedrive-sharepoint, ms-sentinel, admin-center, dataverse, github + Power BI).
- **Family C:** Power BI remote (per-user Entra OBO, opt-in).

Deploy path: image → internal ACA; secret fields → Key Vault `secretRef`;
endpoint registered in Cosmos `mcp-servers`. Supporting apps: `apps/fiab-mcp-bridge`
(stdio→HTTP/SSE front for stdio servers), `apps/fiab-mcp-config` (self-hosted
`microsoft/mcp` Azure.Mcp.Server, 40+ Azure tools; GCC-High/IL5 → AKS). Admin UI
`app/admin/mcp-servers/page.tsx`.

## 1.6 Service navigators — 12 ADF-Studio-class trees

Each `*-tree.tsx` browses live Azure REST objects in the editor left pane
(base `lib/components/shared/explorer-tree.tsx`): ADF (`factory-resources-tree`),
Synapse (`synapse-workspace-tree`), Databricks (`databricks-workspace-tree`),
ADX/KQL (`adx-database-tree`), APIM (`apim-tree`), AI Foundry/AOAI
(`foundry-tree`), AI Search (`ai-search-tree`), Event Hubs (`eventhubs-tree`),
Cosmos (`cosmos-tree`), SQL DB (`sqldb-tree`), Power BI (`powerbi-tree`), Power
Platform (`powerplatform-tree`).

## 1.7 Copilot backends — feature-work + chat, sovereign-aware

- **Cross-item orchestrator** (`lib/azure/copilot-orchestrator.ts`) — AOAI off the
  Foundry hub; **38+ built-in tools** across Synapse SQL, ADLS/Lakehouse,
  Databricks, APIM, ADX, ADF, Power BI, Foundry, Activator, Cosmos, Workspaces,
  Tabular + runtime MCP shim tools; sessions → Cosmos `copilot-sessions`;
  sovereign gating (`assertFabricFamilyAvailable`).
- **15 per-surface personas** (`lib/azure/copilot-personas-*.ts`) scope the
  orchestrator to one editor (automl, dataflow, dax, eventstream, graph, kql,
  lakehouse, MLV, mirrored-db, notebook, pipeline, slash, sql, stream-analytics).
- **39 copilot tool files** (`lib/copilot/**`): tool packs, `ms-skills` (~30 MS
  agent skills), `powerbi-skills`, `connected-agents`, `inline-complete`
  (autocomplete), `canvas-suggest`, memory suite, skill-learner, `tool-citations`,
  `turn-trace`, `proposed-change`/`apply-change`, **`data-agent-mcp.ts`**
  (publish a Data Agent AS an MCP server: `/api/items/data-agent/[id]/mcp`).
- **MAF app** (`apps/copilot-maf`, loom-copilot-maf) — Microsoft Agent Framework
  ACA running the agent loop against **Gov AOAI direct** (`*.openai.azure.us`) for
  GCC-High/IL5, bypassing the two unreliable Foundry paths; tool dispatch + OBO +
  persistence stay single-sourced in the Console.
- **Standalone RAG:** `apps/copilot` (PydanticAI grounded QA, 4 surfaces),
  `azure-functions/copilot-chat` (public marketing-site chat, hardened).

## 1.8 Platform / infra — 148 bicep modules, two-phase image path, sovereign

`platform/fiab/bicep/**` — **148** `*.bicep`. Orchestrators: `main.bicep`
(`targetScope='subscription'`, `topology` ∈ single-sub | tenant | dlz-attach),
`admin-plane/main.bicep`, `landing-zone/main.bicep`. Module dirs: admin-plane
(75), landing-zone (31), deploy-planner (23, generic Azure service catalog for
user-driven provisioning of ~24 resource types), integration (6), compute (6),
shared/copilot/ai.

**Azure backends provisioned:** ADLS Gen2 (medallion), Synapse (SQL + Spark +
auto-pause), Databricks (+UC/SCIM bootstrap), ADX/Kusto cluster, Event Hubs,
Event Grid, Stream Analytics, Cosmos (+graph-vector), Postgres Flexible (+weave/
AGE), Service Bus, ADF, Analysis Services, SHIR, AI Foundry (+AI Defense), AI
Search, APIM, Container Apps Env + Front Door + App Gateway, Key Vault,
Monitor/Grafana, Azure Maps, DevCenter, Airflow, VPN gateway, built-in + catalog
MCP, Presidio sidecar, Entra app reg, Conditional Access.

**Sovereignty / Gov:** `main.bicep` gates `environment` ∈ {AzureCloud,
AzureUSGovernment} × `boundary` ∈ {Commercial, GCC, GCC-High, IL5}; `loomAzureCloud`
discriminator; `lib/azure/cloud-endpoints.ts` routes ARM/Graph/Purview hosts per
cloud. **7 param files** (commercial, commercial-full, gcc, gcc-high, il5,
tenant-dmlz, dlz-attach). **~23 deploy/gov workflows** (12 gov-named:
`gov-apply-env`, `gov-bff-verify`, `gov-console-roll`, `gov-dataverse`,
`gov-discover`, `gov-exercise`, `gov-gates`, `gov-purview-verify`,
`gov-selfaudit`, `gov-uc-purview-wire`, `gov-waf-cookie-exclusion`, +
`deploy-gov`). **Two-phase image path:** `build-fiab-images.yml` (az acr build
each service) → `deploy-fiab-*.yml` (Phase 1 infra-only, Phase 2 Container Apps
onto pre-built images) → `csa-loom-post-deploy-bootstrap.yml`.

**~91 Cosmos containers** (`cosmos-client.ts` KNOWN_CONTAINER_IDS; 10 pre-created,
rest lazy). **~749 `LOOM_*` env vars**, catalogued in `lib/admin/env-checks.ts` →
self-audit → **gate registry** (`lib/gates/registry.ts`), each gate naming the
exact env var + bicep module + RBAC role with a live "Fix it" resolver.

## 1.9 Governance — real data-plane, not gates

Governance UI (`app/governance/**`, `app/catalog/**`) fronts real clients in
`lib/azure/**`:
- **Purview (real):** `purview-client.ts` (Atlas/Data Map `/datamap/api/atlas/v2`,
  scan API) + autoonboard, bulk-register, source-map, system-classifications.
- **Unity Catalog (real, dual):** `unity-catalog-client.ts` (Databricks UC) +
  `uc-backend.ts` switching to **OSS Unity Catalog** (`apps/loom-unity`, self-hosted
  ACA) for Azure Government where Databricks UC is unavailable.
- **DLP / MIP (real, MS Graph beta):** `dlp-graph-client.ts`, `mip-graph-client.ts`
  (+ `graph.microsoft.us` / `dod-graph.microsoft.us` for Gov).
- **DSPM-AI:** `dspm-ai-client.ts` (Cosmos + Log Analytics posture).
- **Access-governance:** `access-policy-client.ts` (SQL DENY/RBAC compile),
  `protection-policy-client.ts` + reconciler, `lib/access/*` (assignment ledger,
  approval policy, access report, expiry), `rls-compiler.ts`.
- **Domains/MDM/lineage/DQ:** `domains-client.ts`, `domain-mesh.ts`,
  `unified-lineage.ts`, `impact-analysis.ts`, `data-quality-client.ts`.
~33 real `app/api/governance/**` routes + `app/api/catalog/*`. Gates use the one
shared honest-gate surface (`lib/components/shared/honest-gate.tsx`).

## 1.10 SDK / CLI / capacity

- **`apps/loom-cli`** (`@csa-loom/cli`, `loom`) — parity target Fabric CLI `fab`
  v1.5; workspace/item mgmt + Loom App Runtime dev loop (build/deploy/logs/
  export→`.loomapp`/ci-template).
- **`apps/loom-sdk`** (`@csa-loom/sdk`) — typed TS client to the OpenAPI 3.1
  contract (`/api/openapi.json`); resources: workspaces, items, catalog
  (federated Purview+Unity+OneLake search), thread (Weave edges), tokens.
- **`apps/loom-capacity-broker`** — Azure-native admission-control giving one
  compute currency, the **LCU (Loom Capacity Unit)**, that meters/smooths/bursts/
  throttles across Synapse, Databricks, ADX, AML — reproducing a Fabric capacity's
  behavior (bursting ⊕ smoothing over 2,880 timepoints ⊕ 4-stage throttle) with no
  Fabric dependency.

---

# PART 2 — Cross-Cutting UX / Usability Audit

Assessed against the repo's own die-hard rules (`.claude/rules/ux-baseline.md`,
`web3-ui.md`, `ui-parity.md`) and the normative `docs/fiab/ux-standards.md`
(532 lines; §7 per-surface checklist is the review gate). The standard is
explicit: **Microsoft Fabric is the FLOOR, not the target** — every surface,
including Loom-only ones, must meet or exceed the Fabric-equivalent grade, ship
with a browser-E2E receipt (G1), zero day-one gates with inline "Fix it" (G2),
resizable `SplitPane` panels (G3), compact 160–190px canvas nodes (§9.4),
non-overlapping badges (§9.5), and clean first-open (§9.6).

## 2.1 What is A-grade today

- **Canvas layer** — 11 surfaces build nodes through `canvas-node-kit.tsx`;
  9 use React Flow. Where adopted, these carry the Wave-2 richness the standard
  now mandates everywhere (undo/redo, copy/paste, align/distribute, shortcut
  sheet, ELK auto-layout, `CanvasRightRail`). This is where Loom *exceeds* Fabric
  and sets its own bar.
- **Governance / Marketplace / Catalog** — the reference "polished siblings"
  named in `web3-ui.md`; real-backend, `PageShell`/`TileGrid`/`EmptyState`,
  honest-gate surface.
- **Learning UX** — per-item Learn drawers driven by `learnContent` on all
  catalog entries, dual-linked (Loom doc primary, MS Learn secondary), honest
  "not yet authored" MessageBar rather than placeholder.
- **Gate system** — central registry + self-audit + "Fix it" resolvers is a
  genuine structural answer to G2 that no competitor ships.

## 2.2 Design debt — specific, with files

1. **Monolith editors (single-file, 3.5k–5.2k LOC).** These are hard to review,
   diff, and hold to the §7 checklist uniformly:
   - `editors/lakehouse/lakehouse-editor-shell.tsx` — **5,227**
   - `editors/report-designer.tsx` — **5,135**
   - `editors/phase3/semantic-model-editor.tsx` — **4,576**
   - `editors/notebook-editor.tsx` — **3,875**
   - `editors/apim-editors.tsx` — **3,580** (also an *aggregate* of several editors)
   These are the top refactor-for-decomposition candidates.

2. **Aggregate editor modules bundling many editors in one file** — harder to
   code-split and to apply per-surface polish consistently:
   `foundry-sub-editors.tsx` (3,272), `powerplatform-editors.tsx` (2,365),
   `copilot-studio-editors.tsx` (1,952), `azure-sql-editors.tsx` (1,875),
   `azure-services-editors.tsx` (1,617), `geo-editors.tsx` (1,225),
   `graph-editors.tsx` (1,196), `phase2-misc-editors.tsx` (969). Contrast the
   already-decomposed `phase3-editors.tsx`/`phase4-editors.tsx` (now 108/26 LOC
   shims after extraction) — that's the target pattern.

3. **Canvas-standard coverage gap.** Only ~11 editors use `canvas-node-kit` and
   ~9 use React Flow, but the standard makes the canvas layer mandatory on *every*
   topology surface. Editors that render topology without the kit (heavy
   `model-view-canvas.tsx` at 1,356 LOC, hand-built graph views in
   `graph-editors.tsx`) are candidates for migration to the shared kit +
   `CanvasRightRail` + `SplitPane`.

4. **Redirect-shim governance pages** (`governance/sensitivity`,
   `/classifications`, `/domains` → `/admin/*`) — split IA: the same concept
   lives under two route trees. Consolidation would reduce navigation confusion.

5. **Scale-consistency risk.** 112 pages × 132 editors × 1,473 BFF routes is a
   very large surface for the §7 universal checklist (G1/G2/G3, node compactness,
   badge wrap, clean first-open) to be uniformly true. The audit's highest-value
   UX work is a **systematic §7 sweep** with per-surface receipts, prioritizing
   the monoliths and the non-kit canvases above.

6. **Parity-doc drift risk.** 423 parity docs + `*-parity-spec.md` are a strength,
   but `ui-parity.md` requires each to show **zero ❌**; verifying no doc has
   regressed to ❌ (or is stale vs the live portal) is an audit line item.

## 2.3 Net verdict

Loom's *structural* UX assets (shared kit, gate registry, honest-gate, Learn
drawers, token system) are ahead of any single competitor. The debt is
**concentration and consistency**: five monoliths + eight aggregates carry a
disproportionate share of LOC and are the surfaces most likely to be below the
§7 bar in places; and canvas-standard coverage needs to reach every topology
surface, not just the ~11 that adopted the kit.

---

# PART 3 — The Loom Integration Thesis

**No competitor is one product.** Fabric is a suite of separate experiences with
a shared capacity; Databricks is lakehouse + ML + a bolted-on BI; Palantir Foundry
is ontology + pipelines but not RTI/BI/warehouse-at-parity; Power BI is BI only.
**Loom is one console over all of them** — 132 item types, 1,473 BFF routes, 370
Azure clients — where the boundaries between data engineering, warehouse, RTI,
semantic modeling, BI, ontology/IQ, ML, agents, governance, and sovereignty are
**seams the product crosses for you**, not walls the user re-authenticates across.

## 3.1 Concrete cross-surface bridges that exist today

**Loom Thread / Weave** (`lib/thread/thread-actions.ts`) — 13 one-click "Weave"
actions that wire an item on one surface into another service, every field
populated from a real discovery route (no freeform config), every action POSTing
to a real BFF route:

| Bridge | From → To | Removes the gymnastics of |
|---|---|---|
| `analyze-in-notebook` | any dataset → Notebook | export/re-ingest into a separate Spark workspace |
| `add-data-agent-source` | dataset → Data Agent | wiring a RAG/agent to a governed source by hand |
| `build-report-from-model` / `build-loom-report` | semantic model / table / SQL → Report | round-tripping through Power BI Desktop + a PBI workspace |
| `analyze-in-powerbi` / `build-powerbi-model` | data → PBI (Loom-native OR real PBI) | choosing between "no BI" and "stand up a whole PBI tenant" |
| `publish-as-api` | table / SQL → REST API (APIM) | hand-building Data API Builder + APIM product + auth |
| `mirror-explore-notebook` / `mirror-to-lakehouse` | mirrored DB → Notebook / Lakehouse | CDC plumbing from an operational DB into the lake |
| `analyze-with-dax` | tabular model → DAX preview | opening a separate DAX tool against a live model |
| `materialize-to-kql` | query → ADX/KQL table | ETL from batch store into a real-time engine |
| `create-dashboard-tile-from-query` | KQL query → dashboard tile | rebuilding a query in a separate dashboarding tool |
| `promote-medallion` | bronze/silver → next layer | writing + scheduling promotion jobs by hand |

Capability manifests (`lib/items/manifest/registry.ts`) declare which item types
are `notebookAttachable`, `dataAgentSourceable`, `daxAnalyzable`,
`pbiSourceable`, `medallionPromotable`, `lakehouseKqlMaterializable`, so bridges
appear contextually on exactly the right editors.

## 3.2 The other structural bridges

- **One copilot across all surfaces** — the cross-item orchestrator's 38+ tools
  span every backend, so a single conversation can query SQL, read a lakehouse,
  run DAX, materialize to KQL, and publish an API — the agent crosses the same
  seams the human would.
- **One compute currency (LCU)** — the capacity broker meters Synapse +
  Databricks + ADX + AML as one budget; Fabric only does this *inside* Fabric.
- **One governance plane** — Purview + Unity (Databricks OR OSS) + DLP + MIP +
  DSPM + access-governance federated behind `/catalog` + `/governance`; the SDK's
  `catalog` resource does one federated search across Purview + Unity + OneLake.
- **One deployment** — the two-phase bicep path stands up all ~20 backends
  (commercial → IL5) from one param file; no competitor deploys the whole estate,
  sovereign, push-button.
- **One publish surface** — a Data Agent becomes an MCP server; a table becomes a
  REST API; an app exports a portable `.loomapp` — the same item is projected out
  through multiple protocols without re-authoring.

**The thesis in one line:** competitors make you the integration layer between
their products; Loom *is* the integration layer, and the seams are one-click
Weaves, one copilot, one currency, one governance plane, one deploy.

---

# PART 4 — BURN-THE-BOX Net-New Ideas

The bar: beyond any single competitor. Each idea leverages the fact that Loom
already owns the whole surface — the moat is the integration, so every idea
below is something a single-product vendor *structurally cannot* do.

### 4.1 Ontology-Over-Everything (the Universal Semantic Fabric)
**What:** promote the Loom IQ ontology (15 item types in `fabric-iq.ts` +
`palantir/ontology-*`) from "a workload" to the **substrate every other item
binds to**. Every lakehouse table, warehouse column, KQL stream, semantic-model
measure, and API becomes a typed instance of an ontology object; queries,
lineage, access policy, and copilot grounding all resolve through the ontology
graph (Postgres + Apache AGE, already deployed as `postgres-weave`).
**Why no competitor:** Palantir has the ontology but not RTI/BI/warehouse at
parity; Fabric/Databricks have the data but no ontology substrate. Only Loom has
both under one metastore.
**Build shape:** ontology-binding annotations on every item's Cosmos state; an
"ontology resolver" middleware that rewrites SQL/KQL/DAX to ontology objects;
Weave bridge `bind-to-ontology` on every `notebookAttachable` type.

### 4.2 The Self-Driving Data Platform (LCU-Autopilot)
**What:** turn the capacity broker (`loom-capacity-broker`, LCU) into a closed-loop
optimizer that *acts*: auto-pauses idle Synapse/Databricks, right-sizes Spark
pools from historical LCU curves, pre-warms pools before scheduled pipelines,
migrates a workload from Databricks→Synapse (or ADX) when the LCU/$ ratio favors
it, and files FinOps recommendations that execute themselves on approval.
**Why no competitor:** Fabric capacity smooths inside Fabric only; nobody arbitrates
compute *across* Synapse+Databricks+ADX+AML because nobody else owns all four.
**Build shape:** LCU telemetry → a policy engine over the existing gate/self-audit
infra → `env-config` revision rolls (already the "Fix it" mechanism) as the
actuator; a new `admin/autopilot` page over `posture-aggregates`.

### 4.3 NL-to-Full-Estate ("describe the outcome, get the pipeline")
**What:** one natural-language prompt → the cross-item orchestrator authors the
*entire* chain across surfaces: create lakehouse, land + medallion-promote,
build semantic model, generate report, publish API, wire a Data Agent, apply the
governance policy — as a single reviewable **plan** (the phase4 `plan-editor.tsx`
plan-model already exists) that executes via the 13 Weave bridges.
**Why no competitor:** requires one agent with tools spanning all workloads +
one-click bridges between them — Loom already has 38+ tools and 13 bridges; the
net-new is the *planner* that composes them end-to-end.
**Build shape:** planner over `copilot-orchestrator` emitting a `plan-model` DAG of
Weave actions; dry-run + diff + approve; reuse `proposed-change`/`apply-change`.

### 4.4 Sovereign Agent Mesh (in-VNet multi-agent, air-gap-safe)
**What:** a fleet of specialized data agents (one per domain/ontology object)
that collaborate on a task entirely inside the customer VNet — MAF orchestration
(`apps/copilot-maf`) + the gov-safe MCP tier (32 catalogued, Tier-0 air-gap-safe)
+ Gov AOAI direct. A "data-mesh of agents" where a governance agent, a pipeline
agent, and a BI agent negotiate a request with full Purview/DLP enforcement, and
**nothing leaves the boundary**.
**Why no competitor:** no other platform runs a governed multi-agent mesh inside
GCC-High/IL5 with a curated air-gap-safe tool catalog and one governance plane.
**Build shape:** extend `connected-agents.ts` + MAF into an agent-registry over
Cosmos; per-agent MCP tool scoping via `data-agent-mcp`; policy check on every
inter-agent call through `access-policy-client`.

### 4.5 One-Canvas Cross-Workload Authoring (the Unified Studio Canvas)
**What:** a single canvas where a node can be a lakehouse table, a Spark notebook,
a KQL stream, a semantic measure, an ontology object, an ML model, an agent, or a
report — and edges are real Weave bridges. Author a *cross-workload* topology
(ingest→transform→serve→visualize→publish) on one surface instead of five
studios. Extends `canvas-node-kit` + React Flow, already the Loom-exceeds-Fabric
layer.
**Why no competitor:** each competitor's canvas is single-workload (ADF pipeline
canvas, Databricks workflow, PBI model view). Loom owns all node types + the
bridges between them.
**Build shape:** typed cross-workload node registry over the existing kit; edges
= ThreadActions; publish = a `plan-model`; the mandatory G3 `SplitPane` shell.

### 4.6 Governance-as-Code, Everywhere (Policy Compiler + Drift Reconciler)
**What:** express access, RLS, sensitivity, DLP, residency, and retention as one
declarative policy set that **compiles** to every backend simultaneously —
Synapse SQL DENY (`rls-compiler`/`access-policy-client` already do this for SQL),
Unity Catalog grants, Purview classifications, MIP labels, ADX row-level security,
API scopes — and a reconciler (`protection-policy-reconciler` exists) that
continuously drifts-checks and self-heals across all of them.
**Why no competitor:** everyone's policy stops at their own store. Loom compiles
one policy to Purview+Unity+SQL+ADX+Graph in one pass.
**Build shape:** a `policy-as-code` DSL → per-backend compilers (extend the SQL
one) → reconcile loop over the gate/self-audit infra → an `admin/policy-code`
page + `loom policy apply` CLI verb.

### 4.7 Time-Machine for the Whole Estate (Unified Point-in-Time + What-If)
**What:** one "as-of" slider across the *entire* platform — Delta time-travel +
ADX materialized views + Cosmos change-feed + ontology versioning stitched into a
single point-in-time view, so you can query the ontology, a report, and a
pipeline output all as they were at timestamp T, and run counterfactual "what-if"
branches of the estate.
**Why no competitor:** each engine has its own history; nobody unifies Delta + ADX
+ ontology + BI into one temporal coordinate.
**Build shape:** a temporal coordinator resolving each backend's native
time-travel to one `asOf` param; branch = a shadow workspace (workspace isolation
+ delete-cascade already exist); UI = a global time bar in `PageShell`.

### 4.8 The Living Marketplace (Ecosystem + Auto-Certified Data/Agent/App Products)
**What:** extend the marketplace beyond data products to **agents, MCP servers,
apps (`.loomapp`), and ontologies** as first-class, subscribable, revenue-shareable
products — each auto-certified on publish (governance scan + DQ + parity-doc +
browser-E2E receipt gates run automatically), with Delta Sharing + API + MCP as
delivery protocols. A curated, gov-safe ecosystem no single vendor's store spans.
**Why no competitor:** requires one publish surface across data+agent+app+ontology
+ one governance plane to certify them — Loom has the pieces (marketplace, Delta
Sharing, `data-agent-mcp`, `.loomapp` export, gate registry).
**Build shape:** unify product types under one Cosmos `marketplace` schema;
publish pipeline runs the existing gates as certification; entitlement via
access-governance; billing via LCU chargeback.

### 4.9 Continuous Parity Autopilot (the platform audits itself against Fabric)
**What:** a scheduled agent that captures the live Fabric/Azure UI, diffs it
against Loom's 423 parity docs, and **auto-files** the gaps as backlog items with
a proposed implementation plan — turning `ui-parity.md`'s manual side-by-side into
a self-running competitive radar that keeps Loom ahead as competitors ship.
**Why no competitor:** only makes sense for a product whose explicit design is
"be one-for-one-or-better with everyone else."
**Build shape:** Playwright capture (harness exists) → vision model diff vs parity
docs → plan-model + `gh issue` filing; runs as a `Monitor`/scheduled workflow.

### 4.10 Real-Time-Native Everything (Streaming Ontology + Predictive Surfaces)
**What:** make RTI the *default temporal mode*, not a workload — every ontology
object, semantic measure, and report can be bound to a live ADX/Event Hubs stream
so dashboards, agents, and policies react in real time; add predictive surfaces
(AML forecasts materialized back into the ontology) so "what will happen" is a
first-class column next to "what happened."
**Why no competitor:** Fabric RTI is a silo; Databricks streaming doesn't reach BI/
ontology; Palantir isn't RTI-native. Loom owns ADX + ontology + BI + ML together.
**Build shape:** stream-binding on ontology/semantic items (extend
`materialize-to-kql` + `create-dashboard-tile-from-query`); AML→ontology
write-back via a scheduled job; live-tile refresh over the existing dashboard kit.

**The through-line:** every idea is a capability that is *only* buildable because
Loom already owns the whole surface. The moat is not any one item type — it's the
1,473 routes, 13 bridges, one copilot, one currency, one governance plane, and
one sovereign deploy that let these compose. Burn the box = stop shipping
parity-with-a-competitor and start shipping capabilities that require *being all
of them at once*.
