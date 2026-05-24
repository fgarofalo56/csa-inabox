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
