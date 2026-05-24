# CSA Loom — CSA-in-a-Box alignment + v2 backlog

Date: 2026-05-24

## Where Loom already aligns with the CSA reference architecture

| CSA principle / ADR | Loom v1.x surface |
|---|---|
| **ADR 0010 — Fabric strategic target** | Loom is the Fabric-equivalent UX for tenants where Fabric isn't available. Workloads + IA + item catalog mirror Fabric 1:1. |
| **ADR 0025 — APIM as integration fabric** | New `/api-marketplace` top-level surface. APIM listed in `/admin/capacity` as the API-first runtime. New item types: `apim-api`, `apim-product`, `apim-policy`, `data-product`. Every ML endpoint / GraphQL / UDF visibly fronted by APIM. |
| **ADR 0012 — Data mesh federation** | New `data-product` item type bundles dataset + semantic contract + APIM API + access policy + SLA + owner per domain. Marketplace UI groups by domain. |
| **ADR 0014 — MSAL BFF auth pattern** | `lib/auth/msal.ts` + `lib/auth/session.ts` already follow the BFF pattern (HttpOnly encrypted cookie, server-side OBO acquisition, no tokens in browser). |
| **ADR 0006 — Purview over Atlas** | `/governance` portal embeds Purview + surfaces catalog, lineage, classifications, sensitivity, scans, policies. |
| **ADR 0011 — Multi-cloud scope** | Real-Time hub source catalog includes Google Pub/Sub, Amazon Kinesis, Kafka MSK, Solace; ADF surfacing supports cross-cloud ingest. |
| **ADR 0008 — dbt Core over dbt Cloud** | `dbt-job` item type with profiles.yml editor, Git connect, run history. |
| **ADR 0018 — Fabric RTI adapter** | Eventhouse / KQL DB / KQL queryset / KQL dashboard / Eventstream / Activator editors. |
| **ADR 0020/21 — Observability + rate limiting** | APIM marketplace surfaces P95 + error rate; Capacity page rolls cost + utilization across services. |

## What Loom v2 should pick up from the CSA docs (open backlog)

### From ADR 0007 — Azure OpenAI over self-hosted LLM
- Wire `/copilot` and the in-editor Copilot pane to a real Azure OpenAI deployment, behind APIM (using the `llm-token-limit`, `llm-semantic-cache`, `llm-content-safety`, `llm-emit-token-metric` policies per ADR 0025). Today the pane is a stubbed echo.
- LLM gateway page under `/admin` showing per-app token spend, cache hit rate, content-safety blocks.

### From ADR 0025 — APIM LLM policies + MCP fronting
- MCP server item type — every MCP backend is one APIM-fronted endpoint.
- Per-API LLM policy templates (semantic cache, content safety, token limit) as one-click attachables in the APIM API editor.

### From ADR 0012 — Data mesh federation
- Domain ownership UI: each `data-product` should have a per-domain access policy editor + producer/consumer SLA flow + cross-domain dependency map.
- Marketplace search by data subject + data classification + freshness SLA.

### From ADR 0017 — RAG service layer
- RAG service item type tying a vector store (AI Search / pgvector / Cosmos) + a Loom dataset + an APIM endpoint into a single managed RAG application.

### From ADR 0023 / docs/PRODUCTION_CHECKLIST.md
- Production readiness checklist surfaced as a per-workspace assessment, blocking promotion in Deployment Pipelines until items pass.

### From docs/MULTI_REGION.md + ADR 0019 — BFF reverse proxy
- Per-region deployment status in `/admin/capacity` with per-region health, traffic split, and DR drill log.

### From docs/SUPPLY_CHAIN.md
- SBOM viewer per workspace, image-signature verification status, ADO/GHA pipeline attestations.

### From docs/COST_MANAGEMENT.md
- Per-domain / per-workspace / per-user chargeback reports tied to the Capacity & Compute roll-up.

### From docs/GOV_SERVICE_MATRIX.md
- Per-page badge showing IL5 / FedRAMP High / Commercial readiness of the underlying service so Gov tenants know what's safe to use.

### From the Setup wizard
- Bring the wizard out of pane-stub status — make it run a real deploy via the same workflow Loom itself ships in.

## Native Azure-service editors — gaps to close in v2

The v1.5 editors mock the studio UX. v2 should make them functional:

| Editor | What to add |
|---|---|
| Synapse Dedicated SQL Pool | Real T-SQL execution via Azure SQL TDS, results paging, query plan view |
| Synapse Serverless | OPENROWSET helper + cost estimator hitting the real meter |
| Synapse Spark Pool | Livy session attach, kernel passthrough, live Spark UI iframe |
| Databricks Notebook | Workspace API attach, real cell exec via REST + WebSocket, cluster start/stop |
| Databricks Job | Real Jobs API + run dashboards |
| Databricks Cluster | Live cluster mgmt via Clusters API |
| Databricks SQL Warehouse | Real query execution via SQL Statements API |
| ADF Pipeline | Pipeline run + monitoring via ADF REST |
| ADF Dataset / Trigger | Real CRUD + schedule mgmt |
| U-SQL job | Real ADLA submission |
| APIM API | Real APIM REST API for import / publish / policy attach / test calls |

## Cross-cutting hardening for v2

- Real Monaco editor (currently `<textarea>` styled to look like Monaco) so KQL / T-SQL / DAX / Python / GraphQL get real syntax highlighting + IntelliSense.
- Real React Flow for canvas surfaces (Eventstream, Data Pipeline, Synapse Pipeline, ADF Pipeline).
- BFF routes that proxy to real Azure REST APIs (currently many return sample data).
- Real Purview iframe (today shows config + placeholder) — needs the X-Frame-Options work from ADR 0019.
- Per-page "Source of truth" link to the relevant CSA-in-a-Box doc / ADR so users can drill into the rationale.

---

## v2.5 — "Unleashed Loom" (the go-beyond-Fabric scope)

Per the user's "unleashing of CSA Loom" ask. Anything in this section is bigger than 1:1 Fabric parity — it's where Loom surpasses Fabric by surfacing things Fabric doesn't touch.

### Full-stack data governance
- **Data quality services** — rule authoring (completeness / uniqueness / range / referential / format), per-dataset DQ score, profile diffs, alerting on regressions. Backed by Soda Core or Great Expectations behind APIM.
- **Master data management (MDM)** — golden-record store with survivorship rules, fuzzy match config, steward review queue. Build on Microsoft MDM or open source (Talend MDM / Apache Atlas + custom).
- **Metadata management** — beyond Purview lineage: business glossary CRUD, term-to-asset binding, term approval workflow, stewardship assignments.
- **Automated data onboarding** — wizard that takes a source (SMB / SFTP / S3 / SQL / SaaS) → registers in Purview → spawns ADF/Synapse pipeline → lands in bronze → applies default classifications + label → publishes to OneLake catalog. Push-button.

### SQL Server 2025 + Azure SQL family — first-class
- Mirrored database editor: SQL Server 2025 source type with the new in-database mirroring + zero-ETL flow.
- Direct integrations: Azure SQL DB, Azure SQL MI, SQL Server on VM, SQL Server on Arc — all browsable as native item types.
- Replication topology editor (transactional / merge / snapshot) with health monitoring.
- Hyperscale + zone-redundant management surfaces.

### Geoanalytics platform (built-in)
- Map item type evolves into a full geo workbench: layer composer (vector tiles, raster, real-time pins), spatial query editor (ST_* functions over Synapse + Lakehouse), routing + isochrone via Azure Maps, demographic enrichment.
- Spatial index management (H3 / S2) per Lakehouse table.
- Map-based dashboards as a Power-BI-equivalent.

### Graph + knowledge store
- Native Graph DB item type expands to support Gremlin (Cosmos DB), Cypher (Neo4j AuraDB on Azure), and GQL (Fabric Graph).
- Knowledge-store item type — ingest unstructured docs → AI Search + vector store + graph extraction → query via APIM.
- Graph notebook with visual traversal results.

### Pre-built data products library (push-button)
- Marketplace of CSA-curated solution templates:
  - Modern data warehouse (Synapse + Power BI)
  - Lambda architecture (Event Hubs + Stream Analytics + Synapse)
  - Kappa / streaming-only (Eventstream + KQL + Activator)
  - Lakehouse medallion (Databricks + Unity Catalog + Delta Sharing)
  - IoT analytics (IoT Hub + Stream Analytics + ADX + Maps)
  - Federated data mesh (multi-domain APIM + Purview policy + cross-tenant Delta Sharing)
  - RAG + agent (AI Search + Azure OpenAI + APIM LLM policies)
  - Geospatial mission analytics (Azure Maps + ADX geo + Power BI)
- Each is one-click deployable into the customer's landing zone via the existing Loom deploy workflow + Bicep modules. Loom surfaces management + monitoring after deploy.

### Truly-everything-in-Loom
- Loom should never push users to: Synapse Studio, Databricks Workspace, ADF Studio, AML Studio, APIM portal, ADX Web, Stream Analytics editor, Logic Apps designer, Functions portal, Event Grid topic page, Service Bus explorer, IoT Hub device twin, Maps account, AI Foundry / OpenAI Studio, Cognitive Search admin, Purview portal (only as embed), Power BI Service. Every one of those gets a native Loom editor or an embedded iframe with token passthrough.
- Federated identity passthrough so Loom's MSAL session unlocks each backend without re-auth.

### "Unleashed" copilot
- Cross-item Copilot that can author multi-service workflows in one prompt ("ingest the SAP S/4 orders nightly, transform via dbt into a gold revenue Lakehouse table, train a churn model on it, publish as an APIM-fronted data product, alert me on accuracy drift"). Generates the pipeline + notebook + model + APIM API + Activator rule end to end.

---

## v2 add — Azure AI Foundry tab (the AI workbench surface)

User-requested top-level surface. Foundry is the modern Azure AI dev platform — Loom should surface every Foundry capability natively so users never have to leave for `ai.azure.com`.

**New top-level left-nav entry: `/foundry`** with these subpages:

- **Hub & projects** — list all Foundry hubs the user can access across all subscriptions, drill into projects, switch between projects. Same picker UX as Foundry studio.
- **Models catalog** — browse the Foundry model catalog (OpenAI, Llama, Mistral, Phi, Cohere, custom) with filters by modality / context / cost. One-click deploy to a project.
- **Deployments** — list active model deployments per project, RU/s, throughput, capacity, deployment type (Standard / GlobalStandard / DataZone / Provisioned). Toggle PTU vs PAYG. Surface real cost.
- **Prompt flow editor** — visual canvas for prompt-flow authoring (parallel to ADF / Synapse pipelines but for LLM chains). Variants, evaluation, deploy to endpoint.
- **Evaluations** — built-in evaluators (groundedness, relevance, fluency, harm, custom) running over a held-out set. Compare runs side-by-side.
- **Datasets** — manage the project's curated evaluation + grounding datasets. Connect to OneLake / ADLS / Blob.
- **Indexes** — manage Azure AI Search vector indexes used by Foundry RAG flows. Embedding model picker, chunking strategy, refresh schedule.
- **Connections** — Foundry connections to external resources (Azure OpenAI, Cosmos, AI Search, Content Safety, custom REST). Loom unifies these with its own connection registry.
- **Content safety** — content filters per deployment, jailbreak detection, prompt shield config.
- **Tracing & monitoring** — Foundry's built-in tracing UI for prompt-flow runs (per-span latency + token cost). Hooks into Loom's `/monitor` hub for unified observability.
- **Agents (Foundry-native)** — Foundry's agent service primitives, distinct from Loom Data agents (which sit on top of Foundry agent infra). Tool registration, file search, code interpreter, OpenAPI tool plug-ins.
- **Compute** — managed compute instances + clusters for fine-tuning + custom training. Surfaces in `/admin/capacity` rollup too.

**Deployment requirements wired into the Loom Setup wizard:**
- Provision a Foundry hub at first-run (or attach an existing one).
- Per-project: assign storage account, key vault, AI Search, Application Insights, content-safety resource.
- IL5 / FedRAMP variant: use the Gov-cloud Foundry endpoints (`*.api.azure.us`).
- Cost-cap per project (so a runaway prompt flow can't blow the budget).

**Item types added to the +New item dialog** (under a new `AI Foundry` workload category):
- `foundry-project`, `foundry-deployment`, `foundry-prompt-flow`, `foundry-evaluation`,
  `foundry-index`, `foundry-connection`, `foundry-agent`, `foundry-content-filter`,
  `foundry-fine-tune-job`.

**Why v2 (not v2.5):** Loom already surfaces ML model + ML experiment + Data agent + Copilot. Foundry is the umbrella those all sit under in 2026 — it's a coherence move, not net-new scope. The implementation effort is medium (a lot of REST proxying to `*.api.cognitive.microsoft.com` + `*.api.azureml.ms`).

---

## v3 — Power Platform + Copilot Studio direct integrations

The next coherence layer after AI Foundry. Targets the no-code / fusion-team audience that consumes Loom's data products from Power Apps, Power Automate, Power BI, and Copilot Studio. Goal: same "never leave Loom" promise extended to the Power Platform stack.

### Power Platform surfaces (new `/power-platform` top-level entry)

- **Environments** — list Power Platform environments + Dataverse instances across the tenant. Region, SKU, capacity, who owns what.
- **Solutions** — managed + unmanaged solutions per environment, with import / export / version diff (parallels Loom's deployment-pipelines for ALM symmetry).
- **Dataverse tables** — surface every Dataverse table as a first-class item type alongside Loom's Lakehouses. Schema editor, relationships, business rules, security roles. Backed by the Dataverse Web API.
- **Power Apps** — canvas + model-driven apps registered in each environment. One-click "Open in maker portal" passthrough, plus an in-Loom preview iframe.
- **Power Automate** — cloud flows + desktop flows + business process flows. Run history surfaced into Loom's `/monitor` hub.
- **Power Pages** — sites + branding + custom code. Edit / publish / deploy passthrough.
- **AI Builder** — prebuilt + custom AI models registered with Power Platform. Cross-pollinates with the Foundry surface.
- **Connectors** — full connector library (1100+) with custom-connector authoring. APIM-fronted Loom data products auto-published as Power Platform connectors here (closing the loop with the API marketplace).

### Copilot Studio surfaces (new `/copilot-studio` top-level entry)

- **Agents** — list, author, publish Copilot Studio agents per environment. Topic editor, knowledge-source picker, generative-AI grounding settings, channel publishing (Teams, Web, M365, custom).
- **Knowledge sources** — manage SharePoint / Dataverse / OneDrive / public-website / file-upload knowledge sources per agent. Loom's OneLake + Lakehouse + Warehouse + API marketplace items become **first-class knowledge sources** for Copilot Studio agents.
- **Topics & flows** — visual topic + dialog editor.
- **Actions** — register Power Automate flows, REST APIs (via APIM), and Foundry agents as Copilot Studio actions.
- **Analytics** — agent engagement, top topics, escalation rate, satisfaction.
- **Publishing channels** — Teams app, M365 Copilot extension, web embed, IVR, custom Bot Framework channel.
- **Templates** — Microsoft-shipped templates (HR, IT helpdesk, sales assistant) plus a CSA-curated library aligned with the v2.5 data-products library.

### Why v3 (not v2)

These are out-of-tenant-data-plane surfaces — Power Platform + Copilot Studio both have their own admin centers, identity model, and licensing. Wiring them needs:
- Separate ADAL/MSAL token paths (`https://service.flow.microsoft.com`, `https://api.bap.microsoft.com`, etc.)
- Per-environment connection management (Loom's current "workspace" primitive doesn't 1:1 map to PP environments — needs a new abstraction).
- Solution / agent ALM that runs in parallel with Loom's existing deployment pipelines (don't want two competing release stories).

Designing this right is a quarter, not a sprint — call it v3.

### Cross-cutting in v3

- **Unified ALM**: a single "Deploy" UI that promotes a coherent slice across Loom workspace items + Power Platform solution + Foundry deployment + Copilot Studio agent. One PR, one approval, one promotion — across data + AI + apps.
- **Unified observability**: `/monitor` hub absorbs Power Automate flow runs, Copilot Studio session logs, and Foundry trace spans alongside Loom's existing pipeline / notebook / dataflow runs.
- **Unified governance**: `/governance` Purview embed expands to register Power Platform connectors, Copilot Studio knowledge sources, and Foundry indexes as catalog assets with lineage to the underlying Lakehouses + Warehouses.


