# BFF API surface — parity validation report

**Generated:** 2026-05-26  
**Validator:** fabric-parity-loop v2 (Phase 3 — API surface)  
**Live base URL:** `https://<your-console-hostname>`  
**Loom version:** `v3.28-fix-44f3b00b`  

## Methodology

1. Enumerated every `route.ts` under `apps/fiab-console/app/api/` and identified its exported methods.
2. Probed each route's GET endpoint (or, when no GET is exported, the route's first mutation method) anonymously against the live Front Door URL.
3. Verdicts:
   - **401 (auth gate OK)** — route enforces session and returns `{ok:false,error:'unauthenticated'}`.
   - **200 ok** — anonymous-by-design (health / version / me).
   - **200 STUB / VAPORWARE** — route returns hardcoded sample data without session validation. Violates `.claude/rules/no-vaporware.md`.
   - **404 (gated by secret)** — diagnostic endpoint gated behind a shared secret.
   - **405** — handler returns 405 for the probe verb; mutation probe (POST/PUT/PATCH/DELETE) is recorded separately.
   - **5xx BROKEN** — unhandled exception.

## Summary

| Metric | Count | % |
|---|---:|---:|
| Total routes | 239 | 100% |
| Correct auth gate (401 or by-design 200/404) | 234 | 97.9% |
| Routes returning 5xx (BROKEN) | 0 | 0.00% |
| Routes returning STUB/VAPORWARE 200 | 5 | 2.09% |
| Routes returning suspicious 200 | 0 | — |

### BROKEN routes (5xx)

**None.** No route returned a 5xx response.

### Vaporware violations (200 stub without session check)

Per `.claude/rules/no-vaporware.md`: routes that return synthetic data on success without backend wiring AND without auth gate. These violate the die-hard rule and must surface an honest Fluent MessageBar or actually call the backend.

- `/api/data-agent/chat` (POST) — POST=200 STUB (VAPORWARE — bypasses auth) — Returns stub data on POST without session check.
- `/api/lakehouse/tables` (GET) — 200 STUB (vaporware) — STUB — returns hardcoded sample tables (bronze/silver/gold orders_*); bypasses auth and Unity Catalog.
- `/api/notebook/execute` (POST) — POST=200 STUB (VAPORWARE — bypasses auth) — Returns stub data on POST without session check.
- `/api/setup/deploy` (POST) — POST=200 STUB (VAPORWARE — bypasses auth) — Returns stub data on POST without session check.
- `/api/warehouse/query` (POST) — POST=200 STUB (VAPORWARE — bypasses auth) — Returns stub data on POST without session check.

### Routes documented in catalog specs but not wired

Not detectable from API probing alone — requires cross-reference against `docs/fiab/parity-specs/*.md`. Tracked separately in the UI parity reports.

## Full route table (grouped by family)

### activity

| Route | Methods | Status | Notes |
|---|---|---|---|
| `/api/activity` | GET | 401 (auth gate OK) |  |

### adf

| Route | Methods | Status | Notes |
|---|---|---|---|
| `/api/adf/linked-services` | GET | 401 (auth gate OK) |  |

### admin

| Route | Methods | Status | Notes |
|---|---|---|---|
| `/api/admin/azure-resources` | GET | 401 (auth gate OK) |  |
| `/api/admin/bootstrap-catalogs` | POST | POST=401 (auth gate OK) |  |
| `/api/admin/load-sample-data` | POST | POST=401 (auth gate OK) |  |
| `/api/admin/reindex-items` | POST | POST=401 (auth gate OK) |  |

### apim

| Route | Methods | Status | Notes |
|---|---|---|---|
| `/api/apim/instances` | GET | 401 (auth gate OK) |  |

### apps

| Route | Methods | Status | Notes |
|---|---|---|---|
| `/api/apps/[id]/install` | POST | POST=401 (auth gate OK) |  |

### apps-catalog

| Route | Methods | Status | Notes |
|---|---|---|---|
| `/api/apps-catalog` | GET, POST | 401 (auth gate OK) |  |

### copilot

| Route | Methods | Status | Notes |
|---|---|---|---|
| `/api/copilot/orchestrate` | POST | POST=401 (auth gate OK) |  |
| `/api/copilot/sessions` | GET | 401 (auth gate OK) |  |
| `/api/copilot/sessions/[id]` | GET | 401 (auth gate OK) |  |
| `/api/copilot/tools` | GET | 401 (auth gate OK) |  |

### cosmos-items

| Route | Methods | Status | Notes |
|---|---|---|---|
| `/api/cosmos-items/[type]/[id]` | DELETE, GET, PATCH | 401 (auth gate OK) |  |

### data-agent

| Route | Methods | Status | Notes |
|---|---|---|---|
| `/api/data-agent/chat` | POST | POST=200 STUB (VAPORWARE — bypasses auth) | Returns stub data on POST without session check. |

### debug

| Route | Methods | Status | Notes |
|---|---|---|---|
| `/api/debug/cookie` | GET | 404 (gated by secret) | Gated by ?secret=LOOM_VERSION; returns 404 by design when secret missing. |

### downloads

| Route | Methods | Status | Notes |
|---|---|---|---|
| `/api/downloads` | GET, POST | 401 (auth gate OK) |  |

### fabric

| Route | Methods | Status | Notes |
|---|---|---|---|
| `/api/fabric/workspaces` | GET | 401 (auth gate OK) |  |

### feedback

| Route | Methods | Status | Notes |
|---|---|---|---|
| `/api/feedback` | POST | POST=400 (validation rejects empty body) | Anonymous endpoint (by-design): rejects malformed input. |

### foundry

| Route | Methods | Status | Notes |
|---|---|---|---|
| `/api/foundry/computes` | GET | 401 (auth gate OK) |  |
| `/api/foundry/connections` | GET | 401 (auth gate OK) |  |
| `/api/foundry/datastores` | GET | 401 (auth gate OK) |  |
| `/api/foundry/deployments` | GET | 401 (auth gate OK) |  |
| `/api/foundry/workspace` | GET | 401 (auth gate OK) |  |

### health

| Route | Methods | Status | Notes |
|---|---|---|---|
| `/api/health` | GET | 200 ok | Liveness probe — 200 ok always (by design). |

### items/[type]

| Route | Methods | Status | Notes |
|---|---|---|---|
| `/api/items/[type]/[id]` | DELETE, GET, PATCH | 401 (auth gate OK) |  |
| `/api/items/[type]/[id]/audit` | GET, POST | 401 (auth gate OK) |  |
| `/api/items/[type]/[id]/comments` | DELETE, GET, POST | 401 (auth gate OK) |  |
| `/api/items/[type]/[id]/share` | DELETE, GET, POST | 401 (auth gate OK) |  |

### items/activator

| Route | Methods | Status | Notes |
|---|---|---|---|
| `/api/items/activator` | GET, POST | 401 (auth gate OK) |  |
| `/api/items/activator/[id]` | DELETE, GET, PUT | 401 (auth gate OK) |  |
| `/api/items/activator/[id]/rules` | GET, POST | 401 (auth gate OK) |  |

### items/adf-dataset

| Route | Methods | Status | Notes |
|---|---|---|---|
| `/api/items/adf-dataset` | GET, POST | 401 (auth gate OK) |  |
| `/api/items/adf-dataset/[id]` | DELETE, GET, PUT | 401 (auth gate OK) |  |

### items/adf-pipeline

| Route | Methods | Status | Notes |
|---|---|---|---|
| `/api/items/adf-pipeline` | GET, POST | 401 (auth gate OK) |  |
| `/api/items/adf-pipeline/[id]` | DELETE, GET, PUT | 401 (auth gate OK) |  |
| `/api/items/adf-pipeline/[id]/run` | POST | POST=401 (auth gate OK) |  |
| `/api/items/adf-pipeline/[id]/runs` | GET | 401 (auth gate OK) |  |

### items/adf-trigger

| Route | Methods | Status | Notes |
|---|---|---|---|
| `/api/items/adf-trigger` | GET, POST | 401 (auth gate OK) |  |
| `/api/items/adf-trigger/[id]` | DELETE, GET, PUT | 401 (auth gate OK) |  |
| `/api/items/adf-trigger/[id]/state` | POST | POST=401 (auth gate OK) |  |

### items/ai-builder-model

| Route | Methods | Status | Notes |
|---|---|---|---|
| `/api/items/ai-builder-model` | GET | 401 (auth gate OK) |  |
| `/api/items/ai-builder-model/[id]` | GET | 401 (auth gate OK) |  |

### items/ai-foundry-project

| Route | Methods | Status | Notes |
|---|---|---|---|
| `/api/items/ai-foundry-project` | GET, POST | 401 (auth gate OK) |  |
| `/api/items/ai-foundry-project/[id]` | DELETE, GET | 401 (auth gate OK) |  |

### items/ai-search-index

| Route | Methods | Status | Notes |
|---|---|---|---|
| `/api/items/ai-search-index` | GET, POST | 401 (auth gate OK) |  |
| `/api/items/ai-search-index/[id]` | GET | 401 (auth gate OK) |  |
| `/api/items/ai-search-index/[id]/search` | POST | POST=401 (auth gate OK) |  |

### items/apim-api

| Route | Methods | Status | Notes |
|---|---|---|---|
| `/api/items/apim-api` | GET, POST | 401 (auth gate OK) |  |
| `/api/items/apim-api/[id]` | DELETE, GET, PUT | 401 (auth gate OK) |  |
| `/api/items/apim-api/[id]/operations` | GET | 401 (auth gate OK) |  |
| `/api/items/apim-api/[id]/spec` | GET | 401 (auth gate OK) |  |

### items/apim-policy

| Route | Methods | Status | Notes |
|---|---|---|---|
| `/api/items/apim-policy/[id]` | GET, PUT | 401 (auth gate OK) |  |

### items/apim-product

| Route | Methods | Status | Notes |
|---|---|---|---|
| `/api/items/apim-product` | GET, POST | 401 (auth gate OK) |  |
| `/api/items/apim-product/[id]` | DELETE, GET, PUT | 401 (auth gate OK) |  |

### items/azure-sql-database

| Route | Methods | Status | Notes |
|---|---|---|---|
| `/api/items/azure-sql-database` | GET, POST | 401 (auth gate OK) |  |
| `/api/items/azure-sql-database/[id]/mirroring` | POST | POST=401 (auth gate OK) |  |
| `/api/items/azure-sql-database/[id]/query` | POST | POST=401 (auth gate OK) |  |
| `/api/items/azure-sql-database/[id]/replication` | POST | POST=401 (auth gate OK) |  |
| `/api/items/azure-sql-database/[id]/sql2025-features` | POST | POST=401 (auth gate OK) |  |

### items/azure-sql-managed-instance

| Route | Methods | Status | Notes |
|---|---|---|---|
| `/api/items/azure-sql-managed-instance` | GET, POST | 401 (auth gate OK) |  |

### items/azure-sql-server

| Route | Methods | Status | Notes |
|---|---|---|---|
| `/api/items/azure-sql-server` | GET, POST | 401 (auth gate OK) |  |
| `/api/items/azure-sql-server/[id]/databases` | GET | 401 (auth gate OK) |  |

### items/by-type

| Route | Methods | Status | Notes |
|---|---|---|---|
| `/api/items/by-type` | GET | 401 (auth gate OK) |  |

### items/compute

| Route | Methods | Status | Notes |
|---|---|---|---|
| `/api/items/compute` | GET, POST | 401 (auth gate OK) |  |
| `/api/items/compute/[id]` | DELETE, GET | 401 (auth gate OK) |  |
| `/api/items/compute/[id]/start` | POST | POST=401 (auth gate OK) |  |
| `/api/items/compute/[id]/stop` | POST | POST=401 (auth gate OK) |  |

### items/content-safety

| Route | Methods | Status | Notes |
|---|---|---|---|
| `/api/items/content-safety` | GET, POST | 401 (auth gate OK) |  |

### items/copilot-studio-action

| Route | Methods | Status | Notes |
|---|---|---|---|
| `/api/items/copilot-studio-action` | GET, POST | 401 (auth gate OK) |  |
| `/api/items/copilot-studio-action/[id]` | DELETE | DELETE=401 (auth gate OK) |  |

### items/copilot-studio-agent

| Route | Methods | Status | Notes |
|---|---|---|---|
| `/api/items/copilot-studio-agent` | GET, POST | 401 (auth gate OK) |  |
| `/api/items/copilot-studio-agent/[id]` | DELETE, GET, PATCH | 401 (auth gate OK) |  |
| `/api/items/copilot-studio-agent/[id]/publish` | POST | POST=401 (auth gate OK) |  |

### items/copilot-studio-analytics

| Route | Methods | Status | Notes |
|---|---|---|---|
| `/api/items/copilot-studio-analytics/[id]` | GET | 401 (auth gate OK) |  |

### items/copilot-studio-channel

| Route | Methods | Status | Notes |
|---|---|---|---|
| `/api/items/copilot-studio-channel` | GET | 401 (auth gate OK) |  |
| `/api/items/copilot-studio-channel/[id]/publish` | POST | POST=401 (auth gate OK) |  |

### items/copilot-studio-knowledge

| Route | Methods | Status | Notes |
|---|---|---|---|
| `/api/items/copilot-studio-knowledge` | GET, POST | 401 (auth gate OK) |  |
| `/api/items/copilot-studio-knowledge/[id]` | DELETE | DELETE=401 (auth gate OK) |  |

### items/copilot-studio-topic

| Route | Methods | Status | Notes |
|---|---|---|---|
| `/api/items/copilot-studio-topic` | GET, POST | 401 (auth gate OK) |  |
| `/api/items/copilot-studio-topic/[id]` | DELETE, GET, PATCH | 401 (auth gate OK) |  |

### items/copilot-template-library

| Route | Methods | Status | Notes |
|---|---|---|---|
| `/api/items/copilot-template-library` | GET, POST | 401 (auth gate OK) |  |
| `/api/items/copilot-template-library/[id]` | DELETE, GET, POST | 401 (auth gate OK) |  |

### items/copy-job

| Route | Methods | Status | Notes |
|---|---|---|---|
| `/api/items/copy-job` | GET, POST | 401 (auth gate OK) |  |
| `/api/items/copy-job/[id]` | DELETE, GET, PUT | 401 (auth gate OK) |  |
| `/api/items/copy-job/[id]/run` | POST | POST=401 (auth gate OK) |  |
| `/api/items/copy-job/[id]/runs` | GET | 401 (auth gate OK) |  |

### items/cosmos-gremlin-graph

| Route | Methods | Status | Notes |
|---|---|---|---|
| `/api/items/cosmos-gremlin-graph` | GET, POST | 401 (auth gate OK) |  |
| `/api/items/cosmos-gremlin-graph/[id]/query` | POST | POST=401 (auth gate OK) |  |

### items/cypher-graph

| Route | Methods | Status | Notes |
|---|---|---|---|
| `/api/items/cypher-graph` | GET, POST | 401 (auth gate OK) |  |

### items/dashboard

| Route | Methods | Status | Notes |
|---|---|---|---|
| `/api/items/dashboard` | GET | 401 (auth gate OK) |  |
| `/api/items/dashboard/[id]` | GET | 401 (auth gate OK) |  |

### items/data-agent

| Route | Methods | Status | Notes |
|---|---|---|---|
| `/api/items/data-agent/[id]/deploy` | POST | POST=401 (auth gate OK) |  |

### items/data-pipeline

| Route | Methods | Status | Notes |
|---|---|---|---|
| `/api/items/data-pipeline` | GET, POST | 401 (auth gate OK) |  |
| `/api/items/data-pipeline/[id]` | DELETE, GET, PUT | 401 (auth gate OK) |  |
| `/api/items/data-pipeline/[id]/jobs` | GET | 401 (auth gate OK) |  |
| `/api/items/data-pipeline/[id]/run` | POST | POST=401 (auth gate OK) |  |

### items/data-product

| Route | Methods | Status | Notes |
|---|---|---|---|
| `/api/items/data-product/[id]/register-purview` | POST | POST=401 (auth gate OK) |  |

### items/data-product-instance

| Route | Methods | Status | Notes |
|---|---|---|---|
| `/api/items/data-product-instance` | GET, POST | 401 (auth gate OK) |  |
| `/api/items/data-product-instance/[id]` | GET | 401 (auth gate OK) |  |

### items/data-product-template

| Route | Methods | Status | Notes |
|---|---|---|---|
| `/api/items/data-product-template` | GET, POST | 401 (auth gate OK) |  |
| `/api/items/data-product-template/[id]` | GET | 401 (auth gate OK) |  |
| `/api/items/data-product-template/[id]/instantiate` | POST | POST=401 (auth gate OK) |  |

### items/databricks-cluster

| Route | Methods | Status | Notes |
|---|---|---|---|
| `/api/items/databricks-cluster` | GET, POST | 401 (auth gate OK) |  |
| `/api/items/databricks-cluster/[id]` | DELETE, GET | 401 (auth gate OK) |  |
| `/api/items/databricks-cluster/[id]/events` | GET | 401 (auth gate OK) |  |
| `/api/items/databricks-cluster/[id]/state` | POST | POST=401 (auth gate OK) |  |
| `/api/items/databricks-cluster/options` | GET | 401 (auth gate OK) |  |

### items/databricks-job

| Route | Methods | Status | Notes |
|---|---|---|---|
| `/api/items/databricks-job` | GET, POST | 401 (auth gate OK) |  |
| `/api/items/databricks-job/[id]` | DELETE, GET, PUT | 401 (auth gate OK) |  |
| `/api/items/databricks-job/[id]/run` | POST | POST=401 (auth gate OK) |  |
| `/api/items/databricks-job/[id]/runs` | GET | 401 (auth gate OK) |  |

### items/databricks-notebook

| Route | Methods | Status | Notes |
|---|---|---|---|
| `/api/items/databricks-notebook/[id]` | GET, PUT | 401 (auth gate OK) |  |
| `/api/items/databricks-notebook/[id]/run` | POST | POST=401 (auth gate OK) |  |
| `/api/items/databricks-notebook/[id]/runs` | GET | 401 (auth gate OK) |  |
| `/api/items/databricks-notebook/list` | GET | 401 (auth gate OK) |  |

### items/databricks-sql-warehouse

| Route | Methods | Status | Notes |
|---|---|---|---|
| `/api/items/databricks-sql-warehouse/[id]/query` | POST | POST=401 (auth gate OK) |  |
| `/api/items/databricks-sql-warehouse/[id]/schema` | GET | 401 (auth gate OK) |  |
| `/api/items/databricks-sql-warehouse/[id]/start` | POST | POST=401 (auth gate OK) |  |
| `/api/items/databricks-sql-warehouse/[id]/state` | GET, POST | 401 (auth gate OK) |  |
| `/api/items/databricks-sql-warehouse/[id]/warehouses` | GET | 401 (auth gate OK) |  |

### items/dataflow

| Route | Methods | Status | Notes |
|---|---|---|---|
| `/api/items/dataflow` | GET, POST | 401 (auth gate OK) |  |
| `/api/items/dataflow/[id]` | DELETE, GET, PUT | 401 (auth gate OK) |  |
| `/api/items/dataflow/[id]/refresh` | POST | POST=401 (auth gate OK) |  |

### items/dataset

| Route | Methods | Status | Notes |
|---|---|---|---|
| `/api/items/dataset` | GET, POST | 401 (auth gate OK) |  |
| `/api/items/dataset/[id]` | GET | 401 (auth gate OK) |  |

### items/dataverse-table

| Route | Methods | Status | Notes |
|---|---|---|---|
| `/api/items/dataverse-table` | GET | 401 (auth gate OK) |  |
| `/api/items/dataverse-table/[id]` | GET | 401 (auth gate OK) |  |

### items/dbt-job

| Route | Methods | Status | Notes |
|---|---|---|---|
| `/api/items/dbt-job` | GET, POST | 401 (auth gate OK) |  |
| `/api/items/dbt-job/[id]` | DELETE, GET, PUT | 401 (auth gate OK) |  |
| `/api/items/dbt-job/[id]/run` | POST | POST=401 (auth gate OK) |  |
| `/api/items/dbt-job/[id]/runs` | GET | 401 (auth gate OK) |  |

### items/environment

| Route | Methods | Status | Notes |
|---|---|---|---|
| `/api/items/environment` | GET, POST | 401 (auth gate OK) |  |
| `/api/items/environment/[id]` | DELETE, GET, PUT | 401 (auth gate OK) |  |

### items/evaluation

| Route | Methods | Status | Notes |
|---|---|---|---|
| `/api/items/evaluation` | GET, POST | 401 (auth gate OK) |  |
| `/api/items/evaluation/[id]` | GET | 401 (auth gate OK) |  |

### items/eventhouse

| Route | Methods | Status | Notes |
|---|---|---|---|
| `/api/items/eventhouse/[id]` | GET | 401 (auth gate OK) |  |
| `/api/items/eventhouse/[id]/database` | POST | POST=401 (auth gate OK) |  |

### items/eventstream

| Route | Methods | Status | Notes |
|---|---|---|---|
| `/api/items/eventstream/[id]` | GET, PUT | 401 (auth gate OK) |  |

### items/geo-dataset

| Route | Methods | Status | Notes |
|---|---|---|---|
| `/api/items/geo-dataset` | GET, POST | 401 (auth gate OK) |  |

### items/geo-map

| Route | Methods | Status | Notes |
|---|---|---|---|
| `/api/items/geo-map` | GET, POST | 401 (auth gate OK) |  |

### items/geo-pipeline

| Route | Methods | Status | Notes |
|---|---|---|---|
| `/api/items/geo-pipeline` | GET, POST | 401 (auth gate OK) |  |

### items/geo-query

| Route | Methods | Status | Notes |
|---|---|---|---|
| `/api/items/geo-query` | GET, POST | 401 (auth gate OK) |  |

### items/gql-graph

| Route | Methods | Status | Notes |
|---|---|---|---|
| `/api/items/gql-graph` | GET, POST | 401 (auth gate OK) |  |
| `/api/items/gql-graph/[id]/query` | POST | POST=401 (auth gate OK) |  |

### items/graph-model

| Route | Methods | Status | Notes |
|---|---|---|---|
| `/api/items/graph-model/[id]/materialize` | POST | POST=401 (auth gate OK) |  |

### items/graphql-api

| Route | Methods | Status | Notes |
|---|---|---|---|
| `/api/items/graphql-api/[id]/publish` | POST | POST=401 (auth gate OK) |  |

### items/kql-dashboard

| Route | Methods | Status | Notes |
|---|---|---|---|
| `/api/items/kql-dashboard/[id]` | GET, PUT | 401 (auth gate OK) |  |

### items/kql-database

| Route | Methods | Status | Notes |
|---|---|---|---|
| `/api/items/kql-database/[id]` | GET | 401 (auth gate OK) |  |
| `/api/items/kql-database/[id]/query` | POST | POST=401 (auth gate OK) |  |
| `/api/items/kql-database/[id]/tables` | GET | 401 (auth gate OK) |  |

### items/kql-queryset

| Route | Methods | Status | Notes |
|---|---|---|---|
| `/api/items/kql-queryset/[id]` | GET | 401 (auth gate OK) |  |
| `/api/items/kql-queryset/[id]/run` | POST | POST=401 (auth gate OK) |  |

### items/mirrored-database

| Route | Methods | Status | Notes |
|---|---|---|---|
| `/api/items/mirrored-database` | GET, POST | 401 (auth gate OK) |  |
| `/api/items/mirrored-database/[id]` | DELETE, GET | 401 (auth gate OK) |  |
| `/api/items/mirrored-database/[id]/state` | POST | POST=401 (auth gate OK) |  |

### items/ml-experiment

| Route | Methods | Status | Notes |
|---|---|---|---|
| `/api/items/ml-experiment` | GET | 401 (auth gate OK) |  |
| `/api/items/ml-experiment/[id]` | GET | 401 (auth gate OK) |  |

### items/ml-model

| Route | Methods | Status | Notes |
|---|---|---|---|
| `/api/items/ml-model` | GET | 401 (auth gate OK) |  |
| `/api/items/ml-model/[id]` | GET | 401 (auth gate OK) |  |

### items/notebook

| Route | Methods | Status | Notes |
|---|---|---|---|
| `/api/items/notebook` | GET, POST | 401 (auth gate OK) |  |
| `/api/items/notebook/[id]` | DELETE, GET, PUT | 401 (auth gate OK) |  |
| `/api/items/notebook/[id]/jobs` | GET | 401 (auth gate OK) |  |
| `/api/items/notebook/[id]/run` | POST | POST=401 (auth gate OK) |  |
| `/api/items/notebook/[id]/runs/[runId]` | GET | 401 (auth gate OK) |  |

### items/operations-agent

| Route | Methods | Status | Notes |
|---|---|---|---|
| `/api/items/operations-agent/[id]/deploy` | POST | POST=401 (auth gate OK) |  |

### items/paginated-report

| Route | Methods | Status | Notes |
|---|---|---|---|
| `/api/items/paginated-report` | GET | 401 (auth gate OK) |  |
| `/api/items/paginated-report/[id]` | GET | 401 (auth gate OK) |  |

### items/power-app

| Route | Methods | Status | Notes |
|---|---|---|---|
| `/api/items/power-app` | GET | 401 (auth gate OK) |  |
| `/api/items/power-app/[id]` | GET | 401 (auth gate OK) |  |

### items/power-automate-flow

| Route | Methods | Status | Notes |
|---|---|---|---|
| `/api/items/power-automate-flow` | GET | 401 (auth gate OK) |  |
| `/api/items/power-automate-flow/[id]` | GET | 401 (auth gate OK) |  |
| `/api/items/power-automate-flow/[id]/run` | POST | POST=401 (auth gate OK) |  |
| `/api/items/power-automate-flow/[id]/runs` | GET | 401 (auth gate OK) |  |

### items/power-page

| Route | Methods | Status | Notes |
|---|---|---|---|
| `/api/items/power-page` | GET | 401 (auth gate OK) |  |
| `/api/items/power-page/[id]` | GET | 401 (auth gate OK) |  |

### items/prompt-flow

| Route | Methods | Status | Notes |
|---|---|---|---|
| `/api/items/prompt-flow` | GET, POST | 401 (auth gate OK) |  |
| `/api/items/prompt-flow/[id]` | DELETE, GET | 401 (auth gate OK) |  |
| `/api/items/prompt-flow/[id]/run` | POST | POST=401 (auth gate OK) |  |

### items/recent

| Route | Methods | Status | Notes |
|---|---|---|---|
| `/api/items/recent` | GET | 401 (auth gate OK) |  |

### items/report

| Route | Methods | Status | Notes |
|---|---|---|---|
| `/api/items/report` | GET | 401 (auth gate OK) |  |
| `/api/items/report/[id]` | GET | 401 (auth gate OK) |  |

### items/scorecard

| Route | Methods | Status | Notes |
|---|---|---|---|
| `/api/items/scorecard` | GET | 401 (auth gate OK) |  |
| `/api/items/scorecard/[id]` | GET, POST | 401 (auth gate OK) |  |

### items/semantic-model

| Route | Methods | Status | Notes |
|---|---|---|---|
| `/api/items/semantic-model` | GET | 401 (auth gate OK) |  |
| `/api/items/semantic-model/[id]` | GET | 401 (auth gate OK) |  |
| `/api/items/semantic-model/[id]/refresh` | POST | POST=401 (auth gate OK) |  |
| `/api/items/semantic-model/[id]/refreshes` | GET | 401 (auth gate OK) |  |

### items/spark-job-definition

| Route | Methods | Status | Notes |
|---|---|---|---|
| `/api/items/spark-job-definition` | GET, POST | 401 (auth gate OK) |  |
| `/api/items/spark-job-definition/[id]` | DELETE, GET, PUT | 401 (auth gate OK) |  |
| `/api/items/spark-job-definition/[id]/runs` | GET | 401 (auth gate OK) |  |
| `/api/items/spark-job-definition/[id]/submit` | POST | POST=401 (auth gate OK) |  |

### items/sql-server-2025-vector-index

| Route | Methods | Status | Notes |
|---|---|---|---|
| `/api/items/sql-server-2025-vector-index` | GET, POST | 401 (auth gate OK) |  |

### items/synapse-dedicated-sql-pool

| Route | Methods | Status | Notes |
|---|---|---|---|
| `/api/items/synapse-dedicated-sql-pool/[id]/query` | POST | POST=401 (auth gate OK) |  |
| `/api/items/synapse-dedicated-sql-pool/[id]/resume` | POST | POST=401 (auth gate OK) |  |
| `/api/items/synapse-dedicated-sql-pool/[id]/schema` | GET | 401 (auth gate OK) |  |
| `/api/items/synapse-dedicated-sql-pool/[id]/state` | GET, POST | 401 (auth gate OK) |  |

### items/synapse-pipeline

| Route | Methods | Status | Notes |
|---|---|---|---|
| `/api/items/synapse-pipeline/[id]` | GET, PUT | 401 (auth gate OK) |  |
| `/api/items/synapse-pipeline/[id]/run` | POST | POST=401 (auth gate OK) |  |
| `/api/items/synapse-pipeline/[id]/runs` | GET | 401 (auth gate OK) |  |
| `/api/items/synapse-pipeline/list` | GET | 401 (auth gate OK) |  |

### items/synapse-serverless-sql-pool

| Route | Methods | Status | Notes |
|---|---|---|---|
| `/api/items/synapse-serverless-sql-pool/[id]/query` | POST | POST=401 (auth gate OK) |  |
| `/api/items/synapse-serverless-sql-pool/[id]/schema` | GET | 401 (auth gate OK) |  |

### items/synapse-spark-pool

| Route | Methods | Status | Notes |
|---|---|---|---|
| `/api/items/synapse-spark-pool/[id]` | GET, PUT | 401 (auth gate OK) |  |
| `/api/items/synapse-spark-pool/[id]/runs` | GET | 401 (auth gate OK) |  |
| `/api/items/synapse-spark-pool/[id]/state` | GET, POST | 401 (auth gate OK) |  |
| `/api/items/synapse-spark-pool/[id]/submit` | POST | POST=401 (auth gate OK) |  |
| `/api/items/synapse-spark-pool/list` | GET | 401 (auth gate OK) |  |

### items/tracing

| Route | Methods | Status | Notes |
|---|---|---|---|
| `/api/items/tracing` | GET | 401 (auth gate OK) |  |

### items/vector-store

| Route | Methods | Status | Notes |
|---|---|---|---|
| `/api/items/vector-store` | GET, POST | 401 (auth gate OK) |  |

### items/warehouse

| Route | Methods | Status | Notes |
|---|---|---|---|
| `/api/items/warehouse/[id]/query` | POST | POST=401 (auth gate OK) |  |
| `/api/items/warehouse/[id]/schema` | GET | 401 (auth gate OK) |  |

### lakehouse

| Route | Methods | Status | Notes |
|---|---|---|---|
| `/api/lakehouse/containers` | GET | 401 (auth gate OK) |  |
| `/api/lakehouse/path` | DELETE, POST | DELETE=401 (auth gate OK) |  |
| `/api/lakehouse/paths` | GET | 401 (auth gate OK) |  |
| `/api/lakehouse/preview` | GET | 401 (auth gate OK) |  |
| `/api/lakehouse/tables` | GET | 200 STUB (vaporware) | STUB — returns hardcoded sample tables (bronze/silver/gold orders_*); bypasses auth and Unity Catalog. |
| `/api/lakehouse/upload` | POST | POST=401 (auth gate OK) |  |

### loom

| Route | Methods | Status | Notes |
|---|---|---|---|
| `/api/loom/compute-targets` | GET | 401 (auth gate OK) |  |
| `/api/loom/workspaces` | GET | 401 (auth gate OK) |  |

### me

| Route | Methods | Status | Notes |
|---|---|---|---|
| `/api/me` | GET | 200 ok | Returns {authenticated:false,user:null} when unauthed (by design). |

### notebook

| Route | Methods | Status | Notes |
|---|---|---|---|
| `/api/notebook/execute` | POST | POST=200 STUB (VAPORWARE — bypasses auth) | Returns stub data on POST without session check. |

### notifications

| Route | Methods | Status | Notes |
|---|---|---|---|
| `/api/notifications` | GET, PATCH, POST | 401 (auth gate OK) |  |

### powerbi

| Route | Methods | Status | Notes |
|---|---|---|---|
| `/api/powerbi/workspaces` | GET | 401 (auth gate OK) |  |

### powerplatform

| Route | Methods | Status | Notes |
|---|---|---|---|
| `/api/powerplatform/environments` | GET | 401 (auth gate OK) |  |

### search

| Route | Methods | Status | Notes |
|---|---|---|---|
| `/api/search/items` | POST | POST=401 (auth gate OK) |  |

### setup

| Route | Methods | Status | Notes |
|---|---|---|---|
| `/api/setup/deploy` | POST | POST=200 STUB (VAPORWARE — bypasses auth) | Returns stub data on POST without session check. |

### tabs

| Route | Methods | Status | Notes |
|---|---|---|---|
| `/api/tabs` | GET, POST | 401 (auth gate OK) |  |

### tenant-theme

| Route | Methods | Status | Notes |
|---|---|---|---|
| `/api/tenant-theme` | GET, PUT | 401 (auth gate OK) |  |

### user-prefs

| Route | Methods | Status | Notes |
|---|---|---|---|
| `/api/user-prefs` | DELETE, GET, POST | 401 (auth gate OK) |  |

### version

| Route | Methods | Status | Notes |
|---|---|---|---|
| `/api/version` | GET | 200 ok | Returns running version + upstream release info (anonymous). |

### warehouse

| Route | Methods | Status | Notes |
|---|---|---|---|
| `/api/warehouse/query` | POST | POST=200 STUB (VAPORWARE — bypasses auth) | Returns stub data on POST without session check. |

### workloads-catalog

| Route | Methods | Status | Notes |
|---|---|---|---|
| `/api/workloads-catalog` | GET, POST | 401 (auth gate OK) |  |

### workspaces

| Route | Methods | Status | Notes |
|---|---|---|---|
| `/api/workspaces` | GET, POST | 401 (auth gate OK) |  |
| `/api/workspaces/[id]` | DELETE, GET, PATCH | 401 (auth gate OK) |  |
| `/api/workspaces/[id]/folders` | DELETE, GET, POST | 401 (auth gate OK) |  |
| `/api/workspaces/[id]/items` | GET, POST | 401 (auth gate OK) |  |
| `/api/workspaces/[id]/permissions` | DELETE, GET, POST | 401 (auth gate OK) |  |
| `/api/workspaces/[id]/scm` | DELETE, GET, POST | 401 (auth gate OK) |  |

## Notes on probe limits

- Mutation routes were probed with `POST/PUT/PATCH/DELETE` and an empty JSON body. A 401 confirms the session gate fires before validation runs.
- Routes whose only export is a mutation method return 405 on the GET probe, then the mutation probe records the actual auth-gate behavior.
- This validator does NOT exercise an authenticated session — it cannot confirm whether the back half (Azure REST, Cosmos, Databricks SQL, etc.) actually returns real data once a session is minted. That requires the live-browser Phase 4 walk per parity-validation-standard.
- The probe used path placeholders (`probe-id`, `notebook`, `probe-run`) for dynamic segments. Status codes reflect the auth gate only — they do not test whether a specific item id would resolve in Cosmos.
