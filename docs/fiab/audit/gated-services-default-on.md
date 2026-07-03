# Honest-Gated Runtime Services → Default-On (disposition)

**Branch:** `fix-gated-services-default-on`
**Date:** 2026-06-16
**Goal (operator intent):** make the CSA Loom features that HONEST-GATE actually
work day-one — deploy their runtime backends **by default** (opt-out, not opt-in),
wire the console env, and keep bicep in sync so a clean deploy reproduces the
live state. Source: `docs/fiab/audit/live-e2e-feature-surfaces-v2.md` §3.

Live target: rg `rg-csa-loom-admin-centralus`, sub `<subscription-id>`,
console `loom-console`, ACA env `cae-csa-loom-centralus` (VNet-**internal**),
ACR `acrloom<hash>.azurecr.io` (public network **Disabled**),
console UAMI principalId `<uami-principal-id>`,
clientId `<uami-client-id>`.

---

## Per-service disposition

### 1. DAB preview runtime — **PROVISIONED LIVE**
- **Module:** `platform/fiab/bicep/modules/admin-plane/dab-runtime.bicep` (public
  MCR image `mcr.microsoft.com/azure-databases/data-api-builder:latest` — not
  blocked by the locked ACR).
- **Live:** deployed `loom-dab-preview` Container App into the admin RG (deployment
  `loom-dab-preview-live`, provisioningState Succeeded, revision Running, 1 replica,
  port 5000, external ingress on the internal CAE → reachable by the console over
  the VNet). SQL target = Synapse serverless endpoint
  `syn-loom-<hash>-ondemand.sql.azuresynapse.net` / db `master`. The DAB
  engine boots healthy on an empty-entities config, so REST/GraphQL/publish
  **preview** work day-one.
- **Console env set live:** `LOOM_DAB_PREVIEW_URL=https://loom-dab-preview.redplant-71d4694f.centralus.azurecontainerapps.io`
- **Bicep default-on:** new `param dabRuntimeEnabled bool = true` in `main.bicep`;
  `dabSqlServerFqdn`/`dabSqlDatabase` derived from the DLZ Synapse serverless
  endpoint when `loomSynapseEnabled`; passed into the admin-plane module.
- **Remaining (separate fix wave, B3):** entity **queries** (not preview) need the
  Console UAMI provisioned as a SQL login on the Synapse SQL endpoint
  (`scripts/csa-loom/grant-dab-sql.sh`). Preview/publish probe clears the gate today.

### 2. dbt-runner — **BICEP DEFAULT-ON (image prerequisite)**
- **Module:** `platform/fiab/bicep/modules/integration/dbt-runner.bicep` (exists,
  wired in admin-plane). The image `loom-dbt-runner:<tag>` is pulled from the
  **network-locked ACR** — and there is **no Dockerfile / build script / CI job
  for it in the repo yet**, so the image does not exist. It cannot be built or
  pushed from this workstation (ACR public access Disabled; not in the VNet).
- **Bicep default-on:** new `param dbtRunnerEnabled bool = true` +
  `param dbtRunnerImageReady bool = false` in `main.bicep`. The admin-plane only
  deploys the Container App when `dbtRunnerEnabled && dbtRunnerImageReady`, so a
  clean first deploy does **not** fail on an unresolvable image ref.
- **Honest today:** `LOOM_DBT_RUNNER_URL` stays empty → the dbt-job run surface
  honest-gates (Databricks dbt targets run natively, no runner needed).
- **One prerequisite to go fully live:** author + build the `loom-dbt-runner`
  image (dbt-core + dbt-synapse + dbt-fabric + ODBC Driver 18), push to ACR, then
  flip `dbtRunnerImageReady=true`. The Synapse dbt path then works for everyone.

### 3. Weave Postgres (Apache AGE) — **PROVISIONED LIVE (data-plane bootstrap prereq)**
- **Module:** `platform/fiab/bicep/modules/landing-zone/postgres-weave.bicep`
  (already `weaveOntologyEnabled = true`, fully wired into the orchestrator).
- **Live:** deployed PG flexible server `psql-loom-weave-default-<hash>`
  (state Ready), database `loom-weave`, AGE prerequisites set
  (`shared_preload_libraries=AGE`, `azure.extensions=AGE` — the latter re-applied
  after a `ServerIsBusy` restart race during the ARM run). Entra-only auth, Console
  UAMI is the Entra administrator.
- **Console env set live:** `LOOM_WEAVE_PG_FQDN=psql-loom-weave-default-<hash>.postgres.database.azure.com`,
  `LOOM_WEAVE_PG_DATABASE=loom-weave`, `LOOM_WEAVE_GRAPH=loom_ontology`. The
  deterministic name matches the bicep-computed `loomWeavePgFqdn`.
- **One prerequisite to go fully live:** the AGE **data-plane** bootstrap
  (`CREATE EXTENSION age` + `create_graph('loom_ontology')` + register the Console
  UAMI as a PG principal) via `scripts/csa-loom/bootstrap-weave-pg.sh`. This must
  run as an identity that can mint a token for `https://ossrdbms-aad.database.azure.com`
  — i.e. the in-Azure Console UAMI (MSI). From this workstation the token request
  returns **AADSTS500011** (the Azure-DB-for-PostgreSQL AAD resource principal is
  not consentable for an interactive user in this tenant — the SAME tenant gate the
  audit flags for PostgreSQL **mirroring**). Server + extensions + env + bicep are
  all done; only the in-tenant/in-Azure graph-create remains.

### 4. Event Hubs receive (AMQP peek) — **CODE + BICEP DEFAULT-ON (image rebuild prereq)**
- **Finding:** `@azure/event-hubs` was **NOT bundled** (absent from package.json,
  pnpm-lock, node_modules) despite the brief saying so. Event Hubs has no HTTPS
  REST receive, so View/Peek genuinely needs the AMQP SDK.
- **Code:** added `@azure/event-hubs@^5.12.0` to `apps/fiab-console/package.json`
  and implemented a **real** `peekEvents()` in `lib/azure/eventhubs-data-client.ts`
  — opens an Entra-authenticated `EventHubConsumerClient`, reads a **bounded**
  batch from one partition with a short `maxWaitTime`, closes (request-scoped, no
  long-lived link). The SDK is loaded via a **runtime-specifier dynamic import** so
  `tsc --noEmit` stays green without the package installed in this worktree; on the
  opted-in path it loads the real SDK or throws the honest dependency-gate.
- **Gate:** `LOOM_EVENTHUB_RECEIVE_ENABLED` (off → honest 501 gate; on → real peek).
- **Bicep default-on:** new `param loomEventHubReceiveEnabled bool = true` →
  emits `LOOM_EVENTHUB_RECEIVE_ENABLED=1`. The Console UAMI already holds
  **Azure Event Hubs Data Owner** on `evhns-csa-loom-centralus` (covers receive),
  so no extra grant is needed.
- **Not set live yet (honesty):** the **running** console image does not yet
  contain `@azure/event-hubs`. Setting `=1` live now would just hit the dependency
  gate. It activates automatically on the next image build (dependency declared) —
  bicep then defaults it on. Left the live env unset rather than claim a capability
  the current image can't serve.

### 5. Activator default events table — **FIXED + SET LIVE + BICEP DEFAULT**
- **Root cause:** `LOOM_ACTIVATOR_DEFAULT_TABLE` / `LOOM_EVENTSTREAM_EVENTS_TABLE`
  defaulted to `AppEvents_CL`, a table that does **not** exist in the LAW
  (`law-csa-loom-centralus`) → `SEM0100` semantic error → 502 on the activator
  quick-create (eventstream + ontology).
- **Fix (code):** default changed to **`AppEvents`** (a real, always-present
  Application Insights custom-events table — verified present in the live LAW). The
  entity/condition predicates now resolve columns with **`column_ifexists`** (with
  a fallback into the App Insights `Properties` custom-dimension bag), so the
  scheduledQueryRule **validates + provisions** against a real table whose literal
  columns may not exist — verified live: `AppEvents | extend ... | where ...`
  returns `[]` (no SEM error), where the old `AppEvents_CL` query SEM0100-errored.
  Files: `lib/editors/_family-utils.ts` (`buildEntityChangeQuery`),
  `lib/azure/activator-monitor.ts` (`buildRuleQuery`),
  `app/api/items/eventstream/[id]/activator/route.ts` (`buildStreamAlertQuery` +
  the POST now accepts a per-rule body `sourceTable`).
- **Console env set live:** `LOOM_ACTIVATOR_DEFAULT_TABLE=AppEvents`.
- **Bicep default:** `loomBackends.activatorTable` default `AppEvents` in admin-plane.
- **Tests:** `family-utils.test.ts` updated for the column-safe query; all pass.

---

## Correctly-opt-in (confirmed documented, NOT changed)

These stay opt-in per `no-fabric-dependency.md` / tenant-consent reality and remain
documented in the audit §3 honest-gate table:

- **Fabric deployment pipelines / git / UDF-to-Fabric** — require a real Fabric
  tenant + SPN authorization. Azure-native (Loom) pipelines are the default and
  fully work; Fabric is the opt-in alternative.
- **MIP** (`LOOM_MIP_ENABLED` / `LOOM_MIP_ADMIN_ENABLED`) — Microsoft Purview
  Information Protection admin plane; opt-in.
- **DLP Graph** — Microsoft 365 DLP (Graph) consent; opt-in (also has a B12 code fix).
- **Purview data-plane** (sources/domains/lineage) — needs UAMI Purview
  Data Curator/Reader (B11), a data-plane RBAC grant, not a runtime to deploy.
- **Snowflake / BigQuery / Oracle mirroring** — ADF + connector linked services /
  source grants; opt-in per source family.

---

## Verification

- `az bicep build -f platform/fiab/bicep/main.bicep` → **PASS** (no errors; only
  pre-existing lint warnings).
- `npx tsc --noEmit` → **0 errors in the files this branch touched** (the repo has
  ~1.7k pre-existing test-file TS errors unrelated to this change; the dynamic
  `@azure/event-hubs` import compiles without the package installed).
- `vitest run` on the affected suites (`eventhubs-data-client`, `family-utils`,
  `monitor-client`, `activator-pane`) → **140 passed**.

## Console env vars set live (loom-console)

| Env var | Value |
|---|---|
| `LOOM_DAB_PREVIEW_URL` | `https://loom-dab-preview.redplant-71d4694f.centralus.azurecontainerapps.io` |
| `LOOM_WEAVE_PG_FQDN` | `psql-loom-weave-default-<hash>.postgres.database.azure.com` |
| `LOOM_WEAVE_PG_DATABASE` | `loom-weave` |
| `LOOM_WEAVE_GRAPH` | `loom_ontology` |
| `LOOM_ACTIVATOR_DEFAULT_TABLE` | `AppEvents` |
