# loom-apex Phase E — catalog re-grade ledger (2026-08-06)

**Task:** FINISHLINE `C1` (AUDIT-2026-08-06 row C1) — "full G1 click-walk
re-grade of the catalog".

**Headline result: the click-walk did not happen, and could not happen today.**
Every one of the 142 catalog item types is graded **UNKNOWN — not exercised**.
That is the honest measured outcome, not a placeholder, and §2 explains exactly
why. What this document *does* deliver is (a) the machine-measured static
evidence base for all 142 types, (b) the live evidence that WAS obtainable, and
(c) a named, reproducible list of what each surface still owes.

Companion artifact: [`ADVERSARIAL-REVIEW.md`](ADVERSARIAL-REVIEW.md).

---

## 1. Evidence-type breakdown (read this before any number below)

| Evidence type | Count | What it proves |
|---|---:|---|
| **Live click-walk** (G1: every control clicked, real data) | **0 / 142** | — nothing was click-walked |
| **Live route probe** (unauthenticated HTTP, SSR resolves) | 127 / 127 static page routes | route exists and server-renders; **not** that the surface works |
| **Live estate probe** (build marker, `/api/version`, chunk params) | 3 measurements | see §3 |
| **Source-only** (registry / test / doc presence) | 142 / 142 item types | what the repository can prove — never that a control works |

Per `ux-baseline.md` G1 and the `no_scaffold_claims` memory, source presence is
**not** parity and DOM strings are **not** proof. Nothing in §4 is a functional
grade.

## 2. Why no click-walk was possible (measured, not assumed)

Three independent blockers, each verified today:

1. **`loom-ui-verify` — the G1 receipt mechanism — is red.** Last **success**
   was `2026-08-04T01:02:35Z` (run `30867496747`). Over the last 60 runs:
   39 success / 19 failure / 2 cancelled. The three runs dispatched today
   (`31121475312` 16:55Z, `31122589186` 17:15Z, `31123017609` 17:24Z) all failed.
2. **GitHub Actions is degraded**, which is *why* they failed — not a Loom
   defect. Run `31121475312` log, `Set up job`:
   `Failed to resolve action download info. Error: Service Unavailable`
   (retried twice, then `##[error]`). Run `31123017609` hung 79 minutes
   (17:24:11Z → 18:43:47Z) and was cancelled.
3. **No authenticated browser path exists from this worktree.** The live console
   correctly requires Entra sign-in: `GET /catalog` returns HTTP 200 but the
   body is a sign-in shell (1,354,472 bytes, 2× "Sign in", **zero** item slugs
   present — no data leak, correct posture). Minting a session requires a
   signing secret, which the global security rules forbid this agent from
   reading. No Playwright MCP browser is attached to this agent.

**Consequence, and it is the central Phase-E finding:** under `ux-baseline.md`
G1 ("no surface is complete or 'A grade' until a full in-browser E2E proves
every config, button, and flow works with real data"), **zero surfaces in the
catalog are currently eligible for an A or A+ grade** — not because they are
known bad, but because the evidence that would earn it cannot presently be
produced. Grading them A anyway is precisely the failure this program exists to
prevent.

## 3. Live evidence that WAS obtained

| Measurement | Result | Reading |
|---|---|---|
| `/build-marker.txt` | `sha=7e9289cc0a5106b8a860d716c50acb8d921af2fb stamp=20260806T065739Z` | estate is live and stamped |
| `/api/version` | `{"current":"0.88.0","build":{"sha":"7e9289cc…"}}` | version endpoint healthy, unauthenticated |
| Estate vs `main` | **6 commits behind** (`7e9289cc..57ab6a66`) | all 6 are docs/chore/harness — **no product code is inert**. This is drift, but benign drift (`deploy-integrity.md` R3 still wants it surfaced) |
| Chunk URLs carry `?dpl=7e9289cc0a51` | present on every `/_next/static` asset | **apex A1 (deploy-skew `deploymentId`) is genuinely live** — see ADVERSARIAL-REVIEW R1 |
| 127 static page routes probed | **127 × HTTP 200, zero 404, zero 5xx** | every page route resolves server-side. A 404 control (`/this-route-does-not-exist-xyz`) correctly returned 404, so the probe discriminates |

Reproduce: `printf '%s\n' <routes> | bash temp/probe-routes.sh` against
`https://csa-loom.limitlessdata.ai`.

## 4. The 142-type static evidence matrix

Columns are **measured from source**, each with its exact meaning:

- **Editor** — the slug has a rich editor in `EDITOR_REGISTRY`
  (`apps/fiab-console/lib/editors/registry.ts`). Slugs absent from that map fall
  back to a generic shell. **142/142 present** (independently counted two ways).
- **Parity doc** — `docs/fiab/parity/<slug>.md` exists (`ui-parity.md` deliverable).
- **Unit test** — the slug is referenced by a test under `lib/editors/**/__tests__/`.
- **E2E ref** — the slug is referenced anywhere in `apps/fiab-console/e2e/`.
  A *reference*, not a passing run.
- **Provisioner** — the slug is in the `PROVISIONERS` dispatch map
  (`lib/install/provisioning-engine.ts`) — i.e. install-time real-Azure
  provisioning. **Absence is not a defect for types with no backing object to
  create**; see the caveat below.
- **Static tier** — the *ceiling* a click-walk could confirm. **Never a grade.**

**Aggregate:**

| Signal | Coverage |
|---|---|
| Rich editor registered | **142/142 (100%)** |
| Learn guide registered (`EDITOR_DOC_SLUGS`) | 142/142 (100%) — and 144 `editor-*.md` files exist on disk, so these are real documents, not bare registrations |
| Parity doc present | 128/142 (90%) |
| Editor unit test | 113/142 (79%) |
| E2E reference | 74/142 (52%) |
| Install-time provisioner | 27/142 (19%) — see caveat |
| Dedicated `/api/items/<slug>/` route | 130/142 (91%) — **proxy only, see caveat** |
| Marked `preview: true` | 23/142 (16%) |
| **Visual tutorial published** | **0/142 (0%)** — `check-tutorial-coverage` reports `0/159` overall (items 0/142, features 0/17) |

**Two caveats I verified against my own measurement, because an unchecked proxy
is the exact failure mode this program keeps hitting:**

- *"Dedicated `/api/items/<slug>/` route" is a PROXY, not proof of a backend.*
  I spot-checked two of the 12 "missing" rows: `sql-lab` calls
  `/api/duckdb/capabilities`, `/api/duckdb/query`, `/api/sql/trino`; `s3-gateway`
  calls `/api/s3-gateway/info`. Both have real backends under a different
  prefix. **Do not read the 12 as backend-less.**
- *Provisioner 27/142 is not "115 broken types".* Many item types have no
  Azure object to create at install time and bind through their editor's API
  routes instead. It *is* the right starting list for an `auto-bind-by-default.md`
  audit, which is **out of scope for C1** and is flagged to another lane in §6.

**Tier distribution (ceilings, all live-graded UNKNOWN):**

| Static tier | Count | Meaning |
|---|---:|---|
| T1 A-candidate | 73 | editor + parity doc + unit test + E2E ref |
| T2 B-candidate | 37 | editor + parity doc + (test **or** E2E) |
| T3 C-candidate | 18 | editor + parity doc, no test and no E2E |
| **T4 needs-parity-doc** | **14** | no `docs/fiab/parity/<slug>.md` — an `ui-parity.md` deliverable is missing |

### The 14 T4 rows (missing parity doc — actionable now, no estate needed)

`ai-red-team`, `databricks-pipeline`, `data-contract`, `synthetic-data`,
`data-quality`, `sql-lab`, `ducklake-catalog`, `s3-gateway`, `feature-table`,
`lakebase-postgres`, `analysis-board`, `fusion-sheet`, `notepad`, `digital-twin`.

### The 29 rows with no editor unit test

`agent-flow`, `data-api-builder`, `ai-red-team`, `data-marketplace`,
`data-contract`, `batch-pool`, `synthetic-data`, `data-quality`,
`ducklake-catalog`, `mapping-dataflow`, `activation-sync`,
`transformation-project`, `linked-service`, `integration-runtime`, `logic-app`,
`model-serving-endpoint`, `feature-table`, `fine-tuning-job`,
`postgres-flexible-server`, `azure-cosmos-account`, `loom-app`,
`analysis-board`, `fusion-sheet`, `notepad`, `workshop-app`, `slate-app`,
`health-check`, `workspace-monitor`, `digital-twin`.

## 5. Full ledger (142 rows)

Generated by `temp/build-matrix.py` + `temp/gen-regrade.py` from the repository
at `57ab6a66`. Every **Live grade** cell is `UNKNOWN — not exercised` per §2.

<!-- BEGIN GENERATED TABLE -->
| # | Item type | Category | Static tier (ceiling) | Live grade | Editor | Parity doc | Unit test | E2E ref | Provisioner | Preview |
|---:|---|---|---|---|---|---|---|---|---|---|
| 1 | `cross-item-copilot` | AI & Agents | T1 A-candidate | **UNKNOWN — not exercised** | yes | yes | yes | yes | no | no |
| 2 | `apim-api` | APIs and functions | T1 A-candidate | **UNKNOWN — not exercised** | yes | yes | yes | yes | no | no |
| 3 | `apim-policy` | APIs and functions | T1 A-candidate | **UNKNOWN — not exercised** | yes | yes | yes | yes | no | no |
| 4 | `apim-product` | APIs and functions | T1 A-candidate | **UNKNOWN — not exercised** | yes | yes | yes | yes | no | no |
| 5 | `graphql-api` | APIs and functions | T1 A-candidate | **UNKNOWN — not exercised** | yes | yes | yes | yes | no | no |
| 6 | `user-data-function` | APIs and functions | T1 A-candidate | **UNKNOWN — not exercised** | yes | yes | yes | yes | no | no |
| 7 | `variable-library` | APIs and functions | T1 A-candidate | **UNKNOWN — not exercised** | yes | yes | yes | yes | no | no |
| 8 | `ai-foundry-hub` | Azure AI Foundry | T1 A-candidate | **UNKNOWN — not exercised** | yes | yes | yes | yes | no | no |
| 9 | `ai-foundry-project` | Azure AI Foundry | T1 A-candidate | **UNKNOWN — not exercised** | yes | yes | yes | yes | no | no |
| 10 | `ai-search-index` | Azure AI Foundry | T1 A-candidate | **UNKNOWN — not exercised** | yes | yes | yes | yes | yes | no |
| 11 | `compute` | Azure AI Foundry | T1 A-candidate | **UNKNOWN — not exercised** | yes | yes | yes | yes | no | no |
| 12 | `content-safety` | Azure AI Foundry | T1 A-candidate | **UNKNOWN — not exercised** | yes | yes | yes | yes | no | no |
| 13 | `dataset` | Azure AI Foundry | T1 A-candidate | **UNKNOWN — not exercised** | yes | yes | yes | yes | no | no |
| 14 | `evaluation` | Azure AI Foundry | T1 A-candidate | **UNKNOWN — not exercised** | yes | yes | yes | yes | yes | no |
| 15 | `prompt-flow` | Azure AI Foundry | T1 A-candidate | **UNKNOWN — not exercised** | yes | yes | yes | yes | yes | no |
| 16 | `tracing` | Azure AI Foundry | T1 A-candidate | **UNKNOWN — not exercised** | yes | yes | yes | yes | no | no |
| 17 | `adf-pipeline` | Azure Data Factory | T1 A-candidate | **UNKNOWN — not exercised** | yes | yes | yes | yes | yes | no |
| 18 | `databricks-sql-warehouse` | Azure Databricks | T1 A-candidate | **UNKNOWN — not exercised** | yes | yes | yes | yes | no | no |
| 19 | `geo-dataset` | Azure Geoanalytics | T1 A-candidate | **UNKNOWN — not exercised** | yes | yes | yes | yes | no | no |
| 20 | `geo-map` | Azure Geoanalytics | T1 A-candidate | **UNKNOWN — not exercised** | yes | yes | yes | yes | no | no |
| 21 | `geo-pipeline` | Azure Geoanalytics | T1 A-candidate | **UNKNOWN — not exercised** | yes | yes | yes | yes | no | no |
| 22 | `geo-query` | Azure Geoanalytics | T1 A-candidate | **UNKNOWN — not exercised** | yes | yes | yes | yes | no | no |
| 23 | `cosmos-gremlin-graph` | Azure Graph + Vector | T1 A-candidate | **UNKNOWN — not exercised** | yes | yes | yes | yes | no | no |
| 24 | `cypher-graph` | Azure Graph + Vector | T1 A-candidate | **UNKNOWN — not exercised** | yes | yes | yes | yes | no | no |
| 25 | `gql-graph` | Azure Graph + Vector | T1 A-candidate | **UNKNOWN — not exercised** | yes | yes | yes | yes | no | no |
| 26 | `tapestry` | Azure Graph + Vector | T1 A-candidate | **UNKNOWN — not exercised** | yes | yes | yes | yes | no | yes |
| 27 | `vector-store` | Azure Graph + Vector | T1 A-candidate | **UNKNOWN — not exercised** | yes | yes | yes | yes | no | no |
| 28 | `azure-sql-database` | Azure SQL Database | T1 A-candidate | **UNKNOWN — not exercised** | yes | yes | yes | yes | no | no |
| 29 | `data-product` | CSA Data Products | T1 A-candidate | **UNKNOWN — not exercised** | yes | yes | yes | yes | yes | no |
| 30 | `data-product-instance` | CSA Data Products | T1 A-candidate | **UNKNOWN — not exercised** | yes | yes | yes | yes | no | no |
| 31 | `data-product-template` | CSA Data Products | T1 A-candidate | **UNKNOWN — not exercised** | yes | yes | yes | yes | no | no |
| 32 | `copilot-studio-action` | Copilot Studio | T1 A-candidate | **UNKNOWN — not exercised** | yes | yes | yes | yes | no | no |
| 33 | `copilot-studio-agent` | Copilot Studio | T1 A-candidate | **UNKNOWN — not exercised** | yes | yes | yes | yes | no | no |
| 34 | `copilot-studio-analytics` | Copilot Studio | T1 A-candidate | **UNKNOWN — not exercised** | yes | yes | yes | yes | no | no |
| 35 | `copilot-studio-channel` | Copilot Studio | T1 A-candidate | **UNKNOWN — not exercised** | yes | yes | yes | yes | no | no |
| 36 | `copilot-studio-knowledge` | Copilot Studio | T1 A-candidate | **UNKNOWN — not exercised** | yes | yes | yes | yes | no | no |
| 37 | `copilot-studio-topic` | Copilot Studio | T1 A-candidate | **UNKNOWN — not exercised** | yes | yes | yes | yes | no | no |
| 38 | `copilot-template-library` | Copilot Studio | T1 A-candidate | **UNKNOWN — not exercised** | yes | yes | yes | yes | no | no |
| 39 | `environment` | Data Engineering | T1 A-candidate | **UNKNOWN — not exercised** | yes | yes | yes | yes | no | no |
| 40 | `lakehouse` | Data Engineering | T1 A-candidate | **UNKNOWN — not exercised** | yes | yes | yes | yes | yes | no |
| 41 | `notebook` | Data Engineering | T1 A-candidate | **UNKNOWN — not exercised** | yes | yes | yes | yes | yes | no |
| 42 | `spark-job-definition` | Data Engineering | T1 A-candidate | **UNKNOWN — not exercised** | yes | yes | yes | yes | no | no |
| 43 | `data-pipeline` | Data Factory | T1 A-candidate | **UNKNOWN — not exercised** | yes | yes | yes | yes | yes | no |
| 44 | `dataflow` | Data Factory | T1 A-candidate | **UNKNOWN — not exercised** | yes | yes | yes | yes | no | no |
| 45 | `ml-experiment` | Data Science | T1 A-candidate | **UNKNOWN — not exercised** | yes | yes | yes | yes | no | no |
| 46 | `ml-model` | Data Science | T1 A-candidate | **UNKNOWN — not exercised** | yes | yes | yes | yes | yes | no |
| 47 | `warehouse` | Data Warehouse | T1 A-candidate | **UNKNOWN — not exercised** | yes | yes | yes | yes | yes | no |
| 48 | `sql-database` | Databases | T1 A-candidate | **UNKNOWN — not exercised** | yes | yes | yes | yes | no | no |
| 49 | `aip-logic` | Loom IQ | T1 A-candidate | **UNKNOWN — not exercised** | yes | yes | yes | yes | no | yes |
| 50 | `data-agent` | Loom IQ | T1 A-candidate | **UNKNOWN — not exercised** | yes | yes | yes | yes | no | no |
| 51 | `graph-model` | Loom IQ | T1 A-candidate | **UNKNOWN — not exercised** | yes | yes | yes | yes | no | yes |
| 52 | `map` | Loom IQ | T1 A-candidate | **UNKNOWN — not exercised** | yes | yes | yes | yes | no | yes |
| 53 | `ontology` | Loom IQ | T1 A-candidate | **UNKNOWN — not exercised** | yes | yes | yes | yes | no | yes |
| 54 | `operations-agent` | Loom IQ | T1 A-candidate | **UNKNOWN — not exercised** | yes | yes | yes | yes | no | yes |
| 55 | `plan` | Loom IQ | T1 A-candidate | **UNKNOWN — not exercised** | yes | yes | yes | yes | no | yes |
| 56 | `dashboard` | Power BI | T1 A-candidate | **UNKNOWN — not exercised** | yes | yes | yes | yes | no | no |
| 57 | `report` | Power BI | T1 A-candidate | **UNKNOWN — not exercised** | yes | yes | yes | yes | yes | no |
| 58 | `semantic-model` | Power BI | T1 A-candidate | **UNKNOWN — not exercised** | yes | yes | yes | yes | yes | no |
| 59 | `ai-builder-model` | Power Platform | T1 A-candidate | **UNKNOWN — not exercised** | yes | yes | yes | yes | no | no |
| 60 | `dataverse-table` | Power Platform | T1 A-candidate | **UNKNOWN — not exercised** | yes | yes | yes | yes | no | no |
| 61 | `power-app` | Power Platform | T1 A-candidate | **UNKNOWN — not exercised** | yes | yes | yes | yes | no | no |
| 62 | `power-automate-flow` | Power Platform | T1 A-candidate | **UNKNOWN — not exercised** | yes | yes | yes | yes | no | no |
| 63 | `power-page` | Power Platform | T1 A-candidate | **UNKNOWN — not exercised** | yes | yes | yes | yes | no | no |
| 64 | `powerplatform-environment` | Power Platform | T1 A-candidate | **UNKNOWN — not exercised** | yes | yes | yes | yes | no | no |
| 65 | `activator` | Real-Time Intelligence | T1 A-candidate | **UNKNOWN — not exercised** | yes | yes | yes | yes | yes | no |
| 66 | `eventhouse` | Real-Time Intelligence | T1 A-candidate | **UNKNOWN — not exercised** | yes | yes | yes | yes | yes | no |
| 67 | `eventstream` | Real-Time Intelligence | T1 A-candidate | **UNKNOWN — not exercised** | yes | yes | yes | yes | yes | no |
| 68 | `kql-dashboard` | Real-Time Intelligence | T1 A-candidate | **UNKNOWN — not exercised** | yes | yes | yes | yes | yes | no |
| 69 | `kql-database` | Real-Time Intelligence | T1 A-candidate | **UNKNOWN — not exercised** | yes | yes | yes | yes | yes | no |
| 70 | `kql-queryset` | Real-Time Intelligence | T1 A-candidate | **UNKNOWN — not exercised** | yes | yes | yes | yes | yes | no |
| 71 | `synapse-dedicated-sql-pool` | Synapse Analytics | T1 A-candidate | **UNKNOWN — not exercised** | yes | yes | yes | yes | no | no |
| 72 | `synapse-pipeline` | Synapse Analytics | T1 A-candidate | **UNKNOWN — not exercised** | yes | yes | yes | yes | yes | no |
| 73 | `synapse-spark-pool` | Synapse Analytics | T1 A-candidate | **UNKNOWN — not exercised** | yes | yes | yes | yes | no | no |
| 74 | `ai-enrichment` | Azure AI Foundry | T2 B-candidate | **UNKNOWN — not exercised** | yes | yes | yes | no | no | no |
| 75 | `adf-dataset` | Azure Data Factory | T2 B-candidate | **UNKNOWN — not exercised** | yes | yes | yes | no | no | no |
| 76 | `adf-trigger` | Azure Data Factory | T2 B-candidate | **UNKNOWN — not exercised** | yes | yes | yes | no | no | no |
| 77 | `databricks-cluster` | Azure Databricks | T2 B-candidate | **UNKNOWN — not exercised** | yes | yes | yes | no | no | no |
| 78 | `databricks-job` | Azure Databricks | T2 B-candidate | **UNKNOWN — not exercised** | yes | yes | yes | no | yes | no |
| 79 | `databricks-notebook` | Azure Databricks | T2 B-candidate | **UNKNOWN — not exercised** | yes | yes | yes | no | yes | no |
| 80 | `azure-sql-managed-instance` | Azure SQL Database | T2 B-candidate | **UNKNOWN — not exercised** | yes | yes | yes | no | no | no |
| 81 | `azure-sql-server` | Azure SQL Database | T2 B-candidate | **UNKNOWN — not exercised** | yes | yes | yes | no | no | no |
| 82 | `sql-server-2025-vector-index` | Azure SQL Database | T2 B-candidate | **UNKNOWN — not exercised** | yes | yes | yes | no | no | no |
| 83 | `lakehouse-shortcut` | Data Engineering | T2 B-candidate | **UNKNOWN — not exercised** | yes | yes | yes | no | no | no |
| 84 | `materialized-lake-view` | Data Engineering | T2 B-candidate | **UNKNOWN — not exercised** | yes | yes | yes | no | yes | yes |
| 85 | `spark-environment` | Data Engineering | T2 B-candidate | **UNKNOWN — not exercised** | yes | yes | yes | no | no | no |
| 86 | `airflow-job` | Data Factory | T2 B-candidate | **UNKNOWN — not exercised** | yes | yes | yes | no | no | yes |
| 87 | `copy-job` | Data Factory | T2 B-candidate | **UNKNOWN — not exercised** | yes | yes | yes | no | no | no |
| 88 | `dbt-job` | Data Factory | T2 B-candidate | **UNKNOWN — not exercised** | yes | yes | yes | no | no | no |
| 89 | `mapping-dataflow` | Data Factory | T2 B-candidate | **UNKNOWN — not exercised** | yes | yes | no | yes | no | no |
| 90 | `mirrored-database` | Data Factory | T2 B-candidate | **UNKNOWN — not exercised** | yes | yes | yes | no | yes | no |
| 91 | `mirrored-databricks` | Data Factory | T2 B-candidate | **UNKNOWN — not exercised** | yes | yes | yes | no | yes | no |
| 92 | `mounted-adf` | Data Factory | T2 B-candidate | **UNKNOWN — not exercised** | yes | yes | yes | no | no | no |
| 93 | `automl` | Data Science | T2 B-candidate | **UNKNOWN — not exercised** | yes | yes | yes | no | no | no |
| 94 | `datamart` | Data Warehouse | T2 B-candidate | **UNKNOWN — not exercised** | yes | yes | yes | no | no | no |
| 95 | `sql-analytics-endpoint` | Data Warehouse | T2 B-candidate | **UNKNOWN — not exercised** | yes | yes | yes | no | no | no |
| 96 | `loom-app-runtime` | Loom Apps | T2 B-candidate | **UNKNOWN — not exercised** | yes | yes | yes | no | no | yes |
| 97 | `rayfin-app` | Loom Apps | T2 B-candidate | **UNKNOWN — not exercised** | yes | yes | yes | no | no | yes |
| 98 | `ontology-sdk` | Loom IQ | T2 B-candidate | **UNKNOWN — not exercised** | yes | yes | yes | no | no | yes |
| 99 | `release-environment` | Loom IQ | T2 B-candidate | **UNKNOWN — not exercised** | yes | yes | yes | no | no | yes |
| 100 | `code-report` | Power BI | T2 B-candidate | **UNKNOWN — not exercised** | yes | yes | yes | no | no | no |
| 101 | `paginated-report` | Power BI | T2 B-candidate | **UNKNOWN — not exercised** | yes | yes | yes | no | no | no |
| 102 | `scorecard` | Power BI | T2 B-candidate | **UNKNOWN — not exercised** | yes | yes | yes | no | no | no |
| 103 | `event-grid-topic` | Real-Time Intelligence | T2 B-candidate | **UNKNOWN — not exercised** | yes | yes | yes | no | no | no |
| 104 | `event-hubs-namespace` | Real-Time Intelligence | T2 B-candidate | **UNKNOWN — not exercised** | yes | yes | yes | no | no | no |
| 105 | `event-schema-set` | Real-Time Intelligence | T2 B-candidate | **UNKNOWN — not exercised** | yes | yes | yes | no | no | no |
| 106 | `service-bus-namespace` | Real-Time Intelligence | T2 B-candidate | **UNKNOWN — not exercised** | yes | yes | yes | no | no | no |
| 107 | `stream-analytics-job` | Streaming analytics | T2 B-candidate | **UNKNOWN — not exercised** | yes | yes | yes | no | no | no |
| 108 | `streaming-sql` | Streaming analytics | T2 B-candidate | **UNKNOWN — not exercised** | yes | yes | yes | no | no | no |
| 109 | `synapse-notebook` | Synapse Analytics | T2 B-candidate | **UNKNOWN — not exercised** | yes | yes | yes | no | no | no |
| 110 | `synapse-serverless-sql-pool` | Synapse Analytics | T2 B-candidate | **UNKNOWN — not exercised** | yes | yes | yes | no | yes | no |
| 111 | `agent-flow` | AI & Agents | T3 C-candidate | **UNKNOWN — not exercised** | yes | yes | no | no | no | no |
| 112 | `data-api-builder` | APIs and functions | T3 C-candidate | **UNKNOWN — not exercised** | yes | yes | no | no | no | no |
| 113 | `data-marketplace` | CSA Data Products | T3 C-candidate | **UNKNOWN — not exercised** | yes | yes | no | no | no | no |
| 114 | `batch-pool` | Data Engineering | T3 C-candidate | **UNKNOWN — not exercised** | yes | yes | no | no | no | no |
| 115 | `activation-sync` | Data Factory | T3 C-candidate | **UNKNOWN — not exercised** | yes | yes | no | no | no | no |
| 116 | `integration-runtime` | Data Factory | T3 C-candidate | **UNKNOWN — not exercised** | yes | yes | no | no | no | no |
| 117 | `linked-service` | Data Factory | T3 C-candidate | **UNKNOWN — not exercised** | yes | yes | no | no | no | no |
| 118 | `logic-app` | Data Factory | T3 C-candidate | **UNKNOWN — not exercised** | yes | yes | no | no | yes | no |
| 119 | `transformation-project` | Data Factory | T3 C-candidate | **UNKNOWN — not exercised** | yes | yes | no | no | no | no |
| 120 | `fine-tuning-job` | Data Science | T3 C-candidate | **UNKNOWN — not exercised** | yes | yes | no | no | no | no |
| 121 | `model-serving-endpoint` | Data Science | T3 C-candidate | **UNKNOWN — not exercised** | yes | yes | no | no | no | no |
| 122 | `azure-cosmos-account` | Databases | T3 C-candidate | **UNKNOWN — not exercised** | yes | yes | no | no | no | no |
| 123 | `postgres-flexible-server` | Databases | T3 C-candidate | **UNKNOWN — not exercised** | yes | yes | no | no | no | no |
| 124 | `loom-app` | Loom Apps | T3 C-candidate | **UNKNOWN — not exercised** | yes | yes | no | no | no | no |
| 125 | `slate-app` | Loom Apps | T3 C-candidate | **UNKNOWN — not exercised** | yes | yes | no | no | no | yes |
| 126 | `workshop-app` | Loom Apps | T3 C-candidate | **UNKNOWN — not exercised** | yes | yes | no | no | no | yes |
| 127 | `health-check` | Loom IQ | T3 C-candidate | **UNKNOWN — not exercised** | yes | yes | no | no | no | yes |
| 128 | `workspace-monitor` | Real-Time Intelligence | T3 C-candidate | **UNKNOWN — not exercised** | yes | yes | no | no | yes | no |
| 129 | `ai-red-team` | Azure AI Foundry | T4 needs-parity-doc | **UNKNOWN — not exercised** | yes | no | no | no | no | yes |
| 130 | `databricks-pipeline` | Azure Databricks | T4 needs-parity-doc | **UNKNOWN — not exercised** | yes | no | yes | no | no | no |
| 131 | `data-contract` | CSA Data Products | T4 needs-parity-doc | **UNKNOWN — not exercised** | yes | no | no | no | no | no |
| 132 | `data-quality` | Data Engineering | T4 needs-parity-doc | **UNKNOWN — not exercised** | yes | no | no | no | no | no |
| 133 | `ducklake-catalog` | Data Engineering | T4 needs-parity-doc | **UNKNOWN — not exercised** | yes | no | no | no | no | yes |
| 134 | `s3-gateway` | Data Engineering | T4 needs-parity-doc | **UNKNOWN — not exercised** | yes | no | yes | no | no | yes |
| 135 | `sql-lab` | Data Engineering | T4 needs-parity-doc | **UNKNOWN — not exercised** | yes | no | yes | no | no | no |
| 136 | `synthetic-data` | Data Engineering | T4 needs-parity-doc | **UNKNOWN — not exercised** | yes | no | no | no | no | no |
| 137 | `feature-table` | Data Science | T4 needs-parity-doc | **UNKNOWN — not exercised** | yes | no | no | no | no | no |
| 138 | `lakebase-postgres` | Databases | T4 needs-parity-doc | **UNKNOWN — not exercised** | yes | no | yes | no | no | no |
| 139 | `analysis-board` | Loom IQ | T4 needs-parity-doc | **UNKNOWN — not exercised** | yes | no | no | no | no | yes |
| 140 | `fusion-sheet` | Loom IQ | T4 needs-parity-doc | **UNKNOWN — not exercised** | yes | no | no | no | no | yes |
| 141 | `notepad` | Loom IQ | T4 needs-parity-doc | **UNKNOWN — not exercised** | yes | no | no | no | no | yes |
| 142 | `digital-twin` | Real-Time Intelligence | T4 needs-parity-doc | **UNKNOWN — not exercised** | yes | no | no | no | no | yes |
<!-- END GENERATED TABLE -->

## 6. What C1 still owes (receipts OWED — exact commands)

None of these can be faked; all are blocked on Actions recovering or on an
operator-attended window.

1. **The actual G1 click-walk.** Once Actions is healthy:
   ```bash
   gh workflow run loom-ui-verify.yml --ref main \
     -f target_route=/catalog -f extra_projects=uat
   ```
   Repeat per surface group; attach run URLs to this ledger and replace the
   Live-grade column per surface. Until then the column stays UNKNOWN.
2. **Visual tutorial capture (0/159)** — OPERATOR-GATED (apex D6, credentialed
   run + privacy review):
   ```bash
   pnpm exec playwright test --project=uat e2e/tutorial-capture.uat.ts
   node scripts/csa-loom/publish-tutorials.mjs
   ```
3. **Gov estate re-grade** — this ledger covers **Commercial only**. Gov was not
   probed at all (no local Gov `az` ever; Actions-only, and Actions is down).
   Gov grade for all 142 = UNKNOWN, unmeasured.
4. **14 parity docs** (§4) — no estate needed; buildable today by another lane.

## 7. Scope honesty

- **Commercial only.** Zero Gov measurements were taken.
- **Item types only.** The 136 page surfaces / 49 admin panes got the route
  probe (§3) but no per-surface `ux-standards.md` §7 checklist re-grade — that
  needs the browser.
- **No `ux-standards.md` §7 checkbox was ticked for any surface**, because every
  applicable box (node compactness, badge wrap at narrow width, clean first-open,
  resizable panels) is a *visual* assertion that only a browser can settle.
