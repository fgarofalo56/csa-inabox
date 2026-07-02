# Release audit — dimension: vaporware-api

Date: 2026-07-02. Scope: `apps/fiab-console/app/api` (75 route groups) + `apps/fiab-console/lib/clients` (15 files) + spot checks into `lib/azure` clients. Method: (a) read every route group the inventory flagged as having no lib/azure|lib/clients import; (b) sampled 20+ primary-action route groups across item types and traced each to its backend client; (c) pattern-swept the whole API tree for the vaporware signatures in `no-vaporware.md` (`return []`/`return {}` placeholders, `MOCK_`/`SAMPLE_`/`FAKE`, `Math.random()` data, `simulate|not implemented|coming soon`, `TODO|FIXME`, `catch → ok:true`, `.catch(() => {})` swallows); (d) read every suspicious hit in context.

## Verdict

This API surface is, by a wide margin, the cleanest I have audited for this class of defect. Five prior vaporware sweeps (per repo memory: PRs #1471–#1491, the 06-23 A+ sweep, the 06-29 catalog-functional drive, the 07-01/07-02 deep audits) have left almost nothing. Every sampled primary action reaches a real Azure client (TDS/Synapse SQL, Kusto, ARM, ADF run API, Event Hubs data-plane, Foundry Agent Service, Databricks SQL statements, Power BI/AAS XMLA, DAB runtime proxy). Gates are honest 501/503s that name exact env vars/roles and never fabricate results. The remaining findings below are small: one genuine swallow-into-fake-success miscount, and a handful of hygiene items.

## Sampled route groups → backend verification (all REAL)

| Route | Backend proof |
|---|---|
| `items/warehouse/[id]/query` | `executeQuery` + `dedicatedTarget` from `lib/azure/synapse-sql-client`, pool state via `synapse-pool-arm`; unset env → honest 503 gate (route.ts:29–45); TDS errors → 502 with sqlNumber |
| `warehouse/query` (group route) | same Synapse dedicated path; header documents it *used to be* a stub echoing SQL back and was fixed (route.ts:5) |
| `items/notebook/[id]/run` | Livy session / Databricks submit, async runId pattern; lakehouse auto-mount resolves REAL abfss roots (`lib/azure/lakehouse-abfss`) |
| `items/data-pipeline/[id]/run` | `runPipeline` from `lib/azure/adf-client` + `prewarmShirForPipeline` |
| `items/geo-pipeline/[id]/run` | `runPipeline`/`getPipelineParameters` from adf-client — geo items execute on real ADF |
| geo editors (`lib/editors/geo-editors.tsx`) | query execution posts to `/api/items/synapse-serverless-sql-pool/[id]/query` and `/api/items/kql-database/[id]/query` — real engines |
| `items/eventstream/[id]/provision` | `eventhubs-client` + `stream-analytics-client` + kusto-client |
| `items/kql-database/[id]/query` | `lib/azure/kusto-client` (real `POST /v1/rest/query`) |
| `items/eventhouse/[id]/ingest` | kusto-client + ARM credential |
| `items/semantic-model/[id]/refresh` | `refreshDataset` (Power BI) or AAS server client per `usingAas()` |
| `items/report/[id]/query` | `executeDatasetQueries` (PBI) / AAS DAX / Synapse serverless via `wells-to-sql` |
| `items/activator/[id]/start` | `startReflex` (activator-client) + `enableMonitorRule` (ADX-native Activator runtime) |
| `items/ml-model/[id]` | `getModel`/`listModelVersions` from foundry-client |
| `items/spark-job-definition/[id]/submit` | `submitSparkBatchJob` from synapse-dev-client |
| `items/dataflow/[id]/refresh` | `runDataflowAdf` — compiles M → ADF WranglingDataFlow, returns real ADF runId |
| `items/user-data-function/[id]/invoke` | ARM credential + KV secret → real Functions invoke |
| `items/data-agent/[id]/chat` | `chatGrounded` from data-agent-client (AOAI grounded), usage emitted to Monitor |
| `items/operations-agent/[id]/run` | foundry-agent-client + kusto-client |
| `items/ontology-sdk/[id]/query` | proxies the REAL DAB runtime on ACA (`state.serviceUrl` / `LOOM_DAB_PREVIEW_URL`); honest 503 gate at route.ts:59–68 |
| `dq/run` | `runDqRules` → Databricks `executeStatement` / Synapse / Kusto per backend (`lib/azure/data-quality-client.ts:23–31,161–184`) |
| `mdm/match`, `mdm/merge` | `runMatch` → Databricks SQL Warehouse Spark SQL (levenshtein/soundex) — `lib/azure/mdm-match-merge.ts:1–33` |
| `thread/publish-as-api` | Synapse SQL `executeQuery` + `sql-objects-client` |
| `marketplace/subscriptions` | apim-client |
| `org-reports/render` | live-bindings → Cost Management / Log Analytics (`queryLogs` at `lib/coe-library/report-render/live-bindings.ts:305`) / ARG; consumer path is LIVE-only, sample rows reduced to schema-only zero-row tables (route.ts:44–48,104–111) |
| `app-templates/[templateId]/instantiate` | `createOwnedItem` per scaffolded item → real Cosmos writes + the same Search/Purview mirroring as any create; each item opens its own real editor |
| `eventhubs/data-explorer` | real data-plane; runtime-missing dependency → honest 501 with env/hint (route.ts:50–63) |

## Findings

### F1 (medium) — bootstrap-catalogs reports "seeded" counts that include swallowed failures
`app/api/admin/bootstrap-catalogs/route.ts:114–125`:
```ts
for (const a of APPS) {
  await apps.items.upsert({ ...a, ...stamp, installedBy: [] }).catch(() => {});
  appCount++;
}
```
Both loops increment the counter unconditionally while swallowing the upsert error, then return `{ ok: true, appsSeeded: appCount, workloadsSeeded: wlCount }` (line 133). If the Cosmos writes fail (RBAC drift, throttling, partition-key mismatch), the caller is told 29 apps were seeded when zero were. This is exactly the "error-swallow into fake-success" class. Fix: catch per-item, count only successes, return `{ seeded, failed }` and `ok: failed === 0`. (Note: the route deliberately allows any signed-in user to trigger — documented at lines 8–9 as "benign and idempotent" — so this is a truthfulness bug, not a security one.)

### F2 (low) — dead deprecated stub route kept alive: `/api/data-agent/chat`
`app/api/data-agent/chat/route.ts:7–35`. The route is an HONEST 503 with remediation + `redirectTo: '/copilot'` (the old fake "you said: ..." echo was correctly removed), so it is not vaporware — but a permanently-503 endpoint sitting in the tree is dead weight for a public release. If no page still posts here, delete route + legacy pane; if one does, it's a permanently-broken pane.

### F3 (low) — stale "Phase 1 — deploy stub" docstrings on routes that are now real
`app/api/items/data-agent/[id]/deploy/route.ts:4` and `app/api/items/operations-agent/[id]/deploy/route.ts:4` both open with "Phase 1 — deploy stub with 501-gate", but the bodies call `createOrUpdateAgent` against the real Foundry Agent Service and persist `state.foundryAgentId` back to Cosmos; runtime invocation exists (`data-agent/[id]/chat`, `operations-agent/[id]/run`). The 501 is only the honest not-configured gate. Update the headers — an external code reviewer grepping "stub" will wrongly conclude these are vaporware (as this audit nearly did).

### F4 (low) — Dataflow Gen2 `LOOM_DATAFLOW_BACKEND=fabric` opt-in branch always 503s
`app/api/items/dataflow/[id]/refresh/route.ts:38–43`: with the env set AND a workspace bound, the response is still `'The Fabric refresh backend is opt-in and not wired in this build.'` (503). Honest and opt-in-only (default ADF path is fully real), and consistent with no-fabric-dependency.md — but an env knob that can never work should either be wired or removed from any docs/UI that advertise it.

### F5 (low) — dashboard-builder preview fabricates labeled 3-row "Sample N" tables
`app/api/admin/org-visuals/dashboards/render/route.ts:101–112` (`placeholderTable`) emits `Sample 1..3` rows for un-connected tiles so the chart shape renders. The route header (lines 9–14) commits the viewer to labeling every tile "live / sample / honest gate", and live mode carries per-tile `dataSources` provenance; the consumer-facing `org-reports/render` path never emits these rows (schema-only, `org-reports/render/route.ts:43–48`). Compliant "allowed with disclosure" — kept here as a watch-item: any future viewer change that drops the sample label turns this into real vaporware. Verify the builder UI actually badges sample tiles.

### F6 (low) — best-effort Cosmos-merge helpers silently degrade to empty on outage
Pattern instances (each read in context, all documented as best-effort merges/augmentations, none the primary data path):
- `app/api/items/_lib/pbi-content-fallback.ts:88–91` — whole-list `catch { return []; }`: a Cosmos outage silently drops the loom-synthetic entries from PBI lists.
- `app/api/items/activator/route.ts:38` — `listBundleActivators` `catch { return []; }` ("any Cosmos error yields [] so the live path is never blocked").
- `app/api/catalog/metastores/route.ts:95–97` — registrations read degrades to [].
- `app/api/admin/deploy-plan/route.ts:50` — domains read degrades to [].
These are deliberate availability trade-offs, but they hide a broken Cosmos from the user (lists just look empty). Consider attaching a `degraded: true`/warning field when the fallback fires.

## Explicitly cleared (checked, NOT findings)

- **`lib/clients/*` (all 15)** — no fake responses. Catch blocks are: JSON-parse fallbacks that keep the raw text (`azure-connections-client.ts:190`, `cmk-client.ts:102,118`, `networking-client.ts:152`), best-effort reparent/cleanup with an authoritative operation still throwing (`folders-client.ts:98–122`, `org-visuals-client.ts:123`, `embed-codes-client.ts:136`), enrichment fallbacks that degrade to documented defaults (`workspaces-client.ts:114,136` — counts→0/owners→createdBy; `spark-config-client.ts:134` — 404→default config), and `checkRoleAtScope` returning `'unknown'` so the UI doesn't hard-block while the real bind still surfaces its own 403 (`cmk-client.ts:461–487`). `usage-client` throws `MonitorNotConfiguredError` for honest gates.
- **`Math.random()` in app/api** — every hit is ID minting (`audit-…`, session ids), zero fake data generation.
- **`MOCK_|SAMPLE_|FAKE`** — hits are in `__tests__` or in comments *prohibiting* mocks.
- **`TODO|FIXME|XXX`** — zero hits in `app/api`, `lib/azure`, `lib/clients` (production files).
- **DLP simulate** (`admin/security/dlp/simulate/route.ts:46–56`) — honest 501-class gate: Microsoft ships no public Graph simulate API; the route says so and refuses to fabricate results. Model behavior.
- **`data-products/[id]` `return []` at :124/:217, eventstream `asa-sync:150`** — data-coercion helpers (`toCustomAttributes`, `collectSinks`), not response placeholders.
- **No-backend-import item routes** (aip-logic, graph-model, health-check, workshop-app, slate-app, vector-store, geo-*, release-environment, …) — all `_lib/item-crud` / `_lib/palantir-crud` Cosmos CRUD, i.e. the real persistence backend for Loom-native item definitions; their *execution* surfaces route to real engines elsewhere (verified for geo → serverless SQL/Kusto, ontology-sdk → DAB, dbt-job → codegen is the product, slate-app generate → real bundle codegen persisted to state).
- **`mounted-adf/[id]`** (route.ts:47–49) — per-section `.catch` captures each error message into an `errors` object returned to the client; degraded sections are visibly reported, not hidden.
- **`.catch(() => {})` sweep** — every remaining hit is an audit-log write or a secondary cleanup (KV secret delete on teardown, ADF debug-session dispose), never the primary action; the one counter-corrupting case is F1.
- **Unauthenticated groups** (`debug/cookie` secret-gated, `feedback` intentionally anonymous, `health`, `internal/*` shared-secret failing closed, `version`) — match the inventory's verified-intentional list.

## Grade rationale

Per the no-vaporware rubric, the API/back-end dimension sits at **A−/B+**: the surface is real end-to-end everywhere sampled, gates are honest and precisely worded, and the only true fake-success is a seeding counter (F1). What keeps it from a flat A is F1 plus the hygiene items (dead stub route, stale "stub" docstrings, a never-wired opt-in env branch) that a hostile external reviewer would grep up in minutes and use to question the whole "no vaporware" claim.
