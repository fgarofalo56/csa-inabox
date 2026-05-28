# Data engineering family — Synapse · Databricks · Azure Data Factory

> CSA Loom landing surface for the 11 data-engineering editors. Every editor below is wired to a real Azure REST backend (Synapse dev REST + TDS, Databricks Jobs / SCIM / SQL Statements / Workspace REST, ADF Author REST), is push-button-deployable via `platform/fiab/bicep/modules/landing-zone/{synapse,databricks,adf}.bicep`, and is graded against the no-vaporware rule (`.claude/rules/no-vaporware.md`).

## At a glance

| Slug | Editor | Backing service | Bicep module |
| --- | --- | --- | --- |
| `synapse-dedicated-sql-pool` | T-SQL editor with ARM pause/resume + MPP catalog browse | ARM (`Microsoft.Synapse/workspaces/sqlPools`) + TDS over private endpoint | `landing-zone/synapse.bicep` |
| `synapse-serverless-sql-pool` | T-SQL editor on the always-on ondemand endpoint with OPENROWSET catalog | TDS over `*-ondemand.sql.azuresynapse.net` | `landing-zone/synapse.bicep` |
| `synapse-spark-pool` | Pool configuration browser + Livy `batches` submission + run history | Synapse dev REST (`/livyApi/versions/2019-11-01-preview/sparkPools`) + ARM PATCH | `landing-zone/synapse.bicep` |
| `synapse-pipeline` | DAG view + JSON spec editor + `createRun` + run history | Synapse dev REST (`/pipelines`, `/pipelineruns`) | `landing-zone/synapse.bicep` |
| `databricks-notebook` | Workspace tree + Monaco editor + `Workspace/Export`/`Import` + Jobs `runs/submit` | Databricks Workspace REST + Jobs REST | `landing-zone/databricks.bicep` |
| `databricks-job` | Multi-task job authoring + schedule + `Jobs/runs` history | Databricks Jobs REST (2.1) | `landing-zone/databricks.bicep` |
| `databricks-cluster` | Cluster create + start/stop/restart + event log | Databricks Clusters REST | `landing-zone/databricks.bicep` |
| `databricks-sql-warehouse` | SQL Warehouse picker + Unity Catalog browse + SQL Statements execution | Databricks SQL Warehouses REST + SQL Statements REST | `landing-zone/databricks.bicep` |
| `adf-pipeline` | DAG view + JSON spec editor + `createRun` + run history | ADF Author REST (`/pipelines`, `/pipelineruns`) | `landing-zone/adf.bicep` |
| `adf-dataset` | Type + linked-service picker + path/table editor + schema panel | ADF Author REST (`/datasets`) | `landing-zone/adf.bicep` |
| `adf-trigger` | Schedule / Tumbling / Blob trigger editor + Start/Stop | ADF Author REST (`/triggers`, `/start`, `/stop`) | `landing-zone/adf.bicep` |

## Deployment posture

- **Bicep-deployed**: every backing service is provisioned by the orchestrator at `platform/fiab/bicep/modules/landing-zone/main.bicep`.
- **Default-on**:
  - **Commercial / GCC**: Synapse + Databricks + ADF all default-on (see `params/commercial-full.bicepparam`, `params/commercial.bicepparam`, `params/gcc.bicepparam`).
  - **Gov-High / IL5**: Synapse + ADF default-on; Databricks is honestly gated off where the SKU isn't published (see `params/gcc-high.bicepparam`, `params/il5.bicepparam`).
- **Private connectivity**: each service is wired through the hub VNet with private endpoints (`*.sql.azuresynapse.net`, `*.azuredatabricks.net`, `*.datafactory.azure.com`).
- **One-time bootstrap**: `platform/fiab/bicep/modules/landing-zone/databricks-scim-bootstrap.bicep` registers the Console UAMI as a workspace ServicePrincipal with `workspace-access` + `databricks-sql-access` entitlements — invoked from the `csa-loom-post-deploy-bootstrap.yml` workflow.

## Acceptance signals

- **Vitest** — `apps/fiab-console/lib/editors/__tests__/synapse-databricks-adf-*.test.ts` asserts (a) the registry maps every family slug to the right component, (b) every editor source file exports the expected names, and (c) every BFF route under `app/api/items/<slug>/**/route.ts` imports from a real Azure backing client (no `return []` stubs).
- **Playwright UAT** — `apps/fiab-console/e2e/editors.uat.ts` walks each editor in a real browser against the live deployment, classifies network responses, and emits a verdict (A / B / C / D / F). Expected-gate 4xx/5xx responses (e.g. paused pool returning 409) are recognised as honest disclosure rather than failures.
- **Parity specs** — per-editor gap analysis lives in `docs/fiab/{editor}-parity-spec.md` and `docs/fiab/parity-gap/{editor}.md`.

## Per-editor deep dives

- [Synapse Dedicated SQL Pool parity spec](synapse-dedicated-sql-pool-parity-spec.md)
- [Synapse Serverless SQL Pool parity spec](synapse-serverless-sql-pool-parity-spec.md)
- [Synapse Spark Pool parity spec](synapse-spark-pool-parity-spec.md)
- [Synapse Pipeline parity spec](synapse-pipeline-parity-spec.md)
- [Databricks Notebook parity spec](databricks-notebook-parity-spec.md)
- [Databricks Job parity spec](databricks-job-parity-spec.md)
- [Databricks Cluster parity spec](databricks-cluster-parity-spec.md)
- [Databricks SQL Warehouse parity spec](databricks-sql-warehouse-parity-spec.md)
- [ADF Pipeline parity spec](adf-pipeline-parity-spec.md)
- [ADF Dataset parity spec](adf-dataset-parity-spec.md)
- [ADF Trigger parity spec](adf-trigger-parity-spec.md)
