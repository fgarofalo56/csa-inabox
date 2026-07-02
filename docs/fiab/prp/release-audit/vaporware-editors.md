# Release audit — dimension: vaporware-editors

**Scope:** `apps/fiab-console/lib/editors` (95 files incl. subdirs `phase3/`, `phase4/`, `lakehouse/`, `databricks/`, `palantir/`, `report/`, `slate/`, `workshop/`, `components/`), `lib/panes`, `lib/wizards`, `lib/dialogs`.
**Date:** 2026-07-02. **Method:** (1) token greps (`return []`/`return {}`, `MOCK_`/`SAMPLE_`, `coming soon`, `TODO|FIXME`, `onClick={()=>{}}`, `Math.random`, `placeholder`, disabled-with-tooltip, "not yet"/"deferred"/"stub", "will appear here", `alert(`, `setTimeout`-theater); (2) fetch-density census per editor file; (3) deep verification of the 15 highest-traffic editors (lakehouse shell, warehouse, data-pipeline + pipeline-core, notebook, report-designer, semantic-model, kql-database, eventstream, activator, dataflow-gen2, data-agent, ontology, ml-model, connections page/pane, spark-environment) — every ribbon/primary action traced to its `/api/*` call; (4) targeted reads of every low-fetch-density file (integration-runtime, linked-service, user-data-function, variable-library, graphql-api, datamart, monitor-hub pane, etc.); (5) BFF route + bicep verification for the one suspicious surface found (user-data-function).

## Executive summary

The editor layer is, with one exception, **remarkably clean of vaporware**. Prior sweep programs (rev 173–179 refactors, the "UI A+ sweep", the catalog 100%-functional drive) clearly landed: every high-traffic editor's primary actions round-trip to real BFF routes backed by real Azure clients; empty states use `EmptyState` with honest copy; every disabled button found carries a truthful, configuration-based reason ("Create the data product first", "Power BI embed is opt-in; workspace not configured", "select a workspace and reflex first"); Fabric-gated capabilities are opt-in branches with Azure-native defaults; `SAMPLE_*` constants are starter query text fed into real Run paths, not fake results; `Math.random` usage is exclusively ID generation. Grep for classic tokens (`MOCK_`, `FIXME`, `onClick={()=>{}}`, `alert(`) returns zero product hits, and there is even a vitest (`lib/editors/__tests__/synapse-databricks-adf-exports.test.ts`) that enforces the token ban.

**The exception is the User Data Function editor**, where the entire author→run loop silently executes the wrong code on the default deployment, and two of its sections ("Manage connections", "Library management") are pure local-state theater with no consumer anywhere in the repo.

## Verified-real map (15 deep-read targets)

| Editor | Primary actions traced | Backend routes hit | Verdict |
|---|---|---|---|
| lakehouse (`lakehouse/lakehouse-editor-shell.tsx`, 4,980 ln, 52 fetches) | files/tables/schemas/shortcuts/upload/download/history/permissions/MIP labels | `/api/lakehouse/*` (ADLS+Synapse+shortcuts), `/api/storage/accounts`, `/api/admin/security/mip/labels`, `/api/items/lakehouse/*` | REAL |
| warehouse (`phase3/warehouse-editor.tsx`) | Run (TDS w/ params + cancel via queryId), schema tree, script-out, CTAS, stats, accel, security dialogs | `/api/items/warehouse/[id]/query|schema|cancel`, `/query-acceleration` | REAL (bundle DDL seeding clearly labeled) |
| data-pipeline (`data-pipeline-editor.tsx` + `pipeline-editor-core.tsx`) | save/validate/publish/run/triggers/delete/practice-seed, factory bind/create, run history | `/api/items/data-pipeline/*`, `/api/adf/*` | REAL |
| notebook (`notebook-editor.tsx`, 35 fetches) | run cell (Livy w/ poll), execute-spark, session-pool warm indicator, AML CI attach, import | `/api/items/notebook/[id]/run|execute-spark`, `/api/spark/session-pool`, `/api/aml/*` | REAL |
| report-designer (`report-designer.tsx` + `report/*` panes) | visuals run real DAX/SQL via `/api/items/report/[id]/query`; panes (filters/bookmarks/themes/analytics) mutate the persisted model saved via `/definition` | `/api/items/report/*`, `/api/cosmos-items/report` | REAL (0-fetch pane files operate on host-saved model by design) |
| semantic-model (`phase3/semantic-model-editor.tsx`, 41 fetches) | AAS-native default (`NEXT_PUBLIC_LOOM_BI_BACKEND==='aas'`), refresh/schedule/history, DAX copilot, PBI opt-in gated honestly | `/api/items/semantic-model/*`, `/api/copilot/dax` | REAL |
| kql-database (`phase3/kql-database-editor.tsx`, 30 fetches) | query, table/function/MV wizards, policies, RLS, data connections, follower, schema graph | `/api/adx/*`, `/api/items/kql-database/[id]/*` | REAL |
| eventstream (`phase3/eventstream-editor.tsx`) | Azure-native default provision (Event Hubs + ASA), SQL operator, activator hop; Fabric publish opt-in | `/api/items/eventstream/[id]/provision|asa-sync|sql-operator|activator` | REAL |
| activator (`phase3/activator-editor.tsx`, read ~900 ln) | create reflex, rule wizard (ADX/LA/EventHub sources), trigger-now, enable/disable/delete, action-group test, start/stop, history | `/api/items/activator/*`, `/api/monitor/action-groups|logic-app-callback` | REAL (ADX scheduled-eval limitation disclosed inline) |
| dataflow-gen2 (`dataflow-gen2-editor.tsx`, read 100%) | list/create/save/delete, Save & Run → ADF WranglingDataFlow, honest ADF gate MessageBar | `/api/items/dataflow*`, `/api/loom/workspaces` | REAL |
| data-agent (`phase4/data-agent-editor.tsx`) | ask/chat, conversations persist, publish, M365 publish, evaluate, run-steps inspect, source-schema | `/api/items/data-agent/[id]/*`, `/api/data-agent/run-steps` | REAL |
| ontology (`phase4/ontology-editor.tsx`) | object/link/action types persist; instances/links/run-action against real AGE; datasource browse; bind; activator | `/api/items/ontology/[id]/objects|links|run-action|datasource|bind` | REAL |
| ml-model (`ml-model-editor.tsx`) | bind-to-registered-AML-model (no fake create), register, stage, endpoint deploy | `/api/items/ml-model/[id]/bind|register|stage|endpoint` | REAL |
| connections (`app/connections/page.tsx`, `lib/panes/azure-connections.tsx`) | list/create/delete KV-backed connections; workspace-scoped ADLS/LA pickers | `/api/connections` (clientFetch), `/api/admin/workspaces/[id]/connections*` | REAL |
| spark (`spark-environment-editor.tsx`, `azure-services-editors.tsx` SynapseSparkPoolEditor) | pool list, env save/publish, Livy submit (honest "runs will appear here" empty state) | `/api/spark-environment/*`, `/api/items/synapse-spark-pool/list` | REAL |

Also spot-verified real: apim-editors (ARM policy save + revisions + test console), azure-sql-editors (firewall/AAD-admin dialogs PUT/DELETE via `/api/items/azure-sql-database/[id]/firewall` — despite a stale comment, see F4), copilot-studio (agents/topics/actions/channels/directline test chat), airflow-job (DAGs/dag-runs/task-logs), mounted-adf, palantir suite (aip-logic invoke/deploy/run-agent; release-environment promote/approve/swap; ontology-sdk generate/publish; slate + workshop builders run real queries via `/query/run` and `/run-action`), graph/geo/tapestry, foundry playground (chat/images/audio), datamart (honest deprecation + real migrate route), powerplatform (honest SP-grant gates), monitor-hub pane (real LA activities + honest gate; the omitted Fabric "Schedule failures" tab is explicitly documented as intentionally not shipped rather than shipped dead).

Thin wrappers verified as reuse, not stubs: `integration-runtime-editor.tsx` → shared `IntegrationRuntimeManager` (`/api/adf/integration-runtimes`), `linked-service-editor.tsx` → shared `LinkedServiceGallery` (31-connector gallery, `/api/adf/linked-services`).

---

## Findings

### F1 (HIGH) — User Data Function "Run" executes the runtime's baked-in sample, not the code you authored

- **Files:**
  - `apps/fiab-console/app/api/items/user-data-function/[id]/invoke/route.ts:60-75` — the Azure-native default branch POSTs `{fnBase}/api/{functionName}` with headers `{ 'content-type': 'application/json' }` (+ optional `x-functions-key`) and body `JSON.stringify(parameters)` only. **The item's saved `state.source` is loaded (line 44-52) but never transmitted.**
  - `platform/fiab/bicep/modules/admin-plane/udf-runtime/app.py:28-33,115` — the deployed execution host explicitly supports a pushed-source mode: *"an `X-Udf-Source-B64` request header carrying the item's current source … so any published function — not just the bundled sample — executes."* `grep -rn "X-Udf-Source-B64" apps/fiab-console` → **zero hits**: nothing ever sends it.
  - `apps/fiab-console/lib/editors/phase4/user-data-function-editor.tsx:160-181` (Run), `:202` (Publish = "Saves source + definition to Cosmos").
  - `platform/fiab/bicep/main.bicep:395` — the `loom-udf-runtime` Container App ships **default on**, so `LOOM_UDF_FUNCTION_BASE` is set day-one and the invoke route takes branch 1 (never the honest 409 gate).
- **Failure scenario (out-of-box deploy):** user opens the UDF editor, edits `compute_score` (or the bundled sample), clicks Publish (saves to Cosmos), clicks Run → the host executes its **init-container-materialized copy** of `function_app.py`, and the Test panel shows a result that looks like the user's code ran but is the stale bundled code. Editing the function body produces no behavior change; adding a new function returns a function-not-found error from the host even though the explorer tree lists it. This is exactly the no-vaporware class "control does not do what its label says", and it's silent — no MessageBar explains that authored source is not what executes.
- **Aggravating detail:** the escape hatches the route documents (`state.azureFunctionUrl`, `state.functionKeySecret`) have **no editor UI** — `grep azureFunctionUrl lib/` hits only `lib/admin/self-audit.ts:548`. A user cannot even point the item at their own Function App from the product.
- **Fix (S/M):** invoke route adds `headers['x-udf-source-b64'] = Buffer.from(st.source||'').toString('base64')` when `st.source` is present and the host kind is the Loom runtime (`LOOM_UDF_HOST_KIND`), OR the editor's Publish pushes source to the host; plus surface `azureFunctionUrl`/`functionKeySecret` as real fields. Until then, an honest MessageBar in the Test panel.

### F2 (MEDIUM) — UDF "Manage connections (Fabric data sources)" is a decorative freeform text box

- **File:** `apps/fiab-console/lib/editors/phase4/user-data-function-editor.tsx:272-273` — section header "Manage connections (Fabric data sources)" over a single `<Input value={state.connections} … placeholder="fin-warehouse, ldn-gold-lakehouse" />` persisted to Cosmos.
- **Evidence of no consumer:** `grep -rn "st.connections\|state.connections" app/api lib/azure` → no UDF-related hits; the invoke route never reads it; the runtime host has no concept of it.
- **Violations:** no-vaporware (label promises connection management; nothing is managed), no-freeform-config (comma-separated free text instead of a picker), and Fabric-first framing on what is supposed to be an Azure-native-default surface (`no-fabric-dependency.md` messaging class documented in the 06-29 audit).
- **Fix (M):** replace with the shared connections picker (`/api/connections`) and actually inject chosen connection metadata into the invocation context — or remove the section.

### F3 (MEDIUM) — UDF "Library management" persists a library list that nothing installs

- **File:** `apps/fiab-console/lib/editors/phase4/user-data-function-editor.tsx:276-301` — Add/Remove library rows (PyPI/wheel + version) saved into `state.libraries`.
- **Evidence of no consumer:** `grep -rn "libraries" app/api/items/user-data-function platform/…/udf-runtime` → zero hits. The execution host is deliberately stdlib-only ("no pip install at start", `app.py:34-36`); the invoke route never transmits libraries; no requirements.txt generation exists anywhere.
- **Failure scenario:** user adds `numpy 2.0.0`, sees it listed as managed, writes `import numpy` — Run fails with `ModuleNotFoundError` (or, per F1, runs stale code anyway). The UI implies environment management that does not exist.
- **Fix (M):** either wire libraries into the runtime (pip-install-on-start from state, like Spark environment does for pools) or replace the section with an honest MessageBar naming the limitation.

### F4 (LOW) — Stale "deferred" comment contradicts shipped functionality (doc rot that will mislead auditors/maintainers)

- **File:** `apps/fiab-console/lib/editors/azure-sql-editors.tsx:295-297` — comment says "Firewall + AAD admin render as disabled with reason (ARM mutation BFF deferred). See no-vaporware.md for the gate-with-reason pattern." The code directly below fully implements both: `loadFirewall`/add/delete rules via `/api/items/azure-sql-database/[id]/firewall` (lines 344-387) and the AAD-admin dialog, with the ribbon only gating on "Pick a server first" (line 485).
- **Impact:** none at runtime; flags false-positive vaporware in every future audit pass. Fix (S): delete/update the comment. (Same class: `azure-sql-editors.tsx:12` "Fabric mirroring toggle (deferred runtime by default)" header line — verify and refresh while there.)

---

## Explicitly cleared (checked, NOT findings)

- `SAMPLE_SQL` / `SAMPLE_KQL_DB` / `SAMPLE_GREMLIN` / `SAMPLE_AVRO` / `STARTER_M` etc. — starter *query text* in Monaco buffers whose Run buttons execute against real backends (warehouse `/query`, ADX `/query`, graph routes, schema-registry register). Labeled and editable; allowed.
- `return []` / `return {}` hits — all defensive parse guards or memo fallbacks, not stubbed data sources.
- Every `disabled` button found carries an honest, state-based reason; no "coming soon"/"Phase N" tooltips exist (report pane headers explicitly document "no coming-soon controls" and deliver).
- Report `report-settings.tsx` deliberately does NOT render toggles for persisted-but-unconsumed schema keys (`persistFilters`, `visualHeaders`) — the inverse of vaporware; correct per rule.
- APIM policy editor discloses the portal's guided "+ Add policy" / effective-policy / fragments as tracked gaps in an info MessageBar (`apim-editors.tsx:1961-1971`) — a ui-parity gap already tracked, not silent vaporware; not re-reported as open per audit instructions.
- Fabric-gated branches (`lib/install/provisioners/warehouse.ts:533-556` fabric-warehouse preview gate; eventhouse "Mission-critical exempt" F/P-SKU note; semantic-model Direct-Lake F-SKU shim note) — all opt-in paths with Azure-native defaults and honest remediation text.
- Activator ADX sources: continuous scheduled evaluation is on-demand unless `LOOM_ADX_ALERT_SCOPE` is set — disclosed inline in the rule wizard (`phase3/activator-editor.tsx:817-822`); honest gate, allowed.
- `monitor-hub.tsx` omits Fabric's "Schedule failures" tab with a documented rationale instead of shipping a dead tab — correct pattern.
- Orphan-looking registry key `sql-server-2025-vector-index` — actually present in the catalog (`lib/catalog/item-types/azure-sql-database.ts:96`); not a zombie.
- Thin wrappers (`integration-runtime-editor`, `linked-service-editor`) — real shared components, real ARM routes.
- `panes/`, `wizards/workspace-create.tsx`, `dialogs/share-item-dialog.tsx` — all fetch real admin/permissions routes; no theater found.

## Dimension grade rationale

95 editor files; 15 highest-traffic editors verified control-by-control as real; wide-net greps corroborate discipline (the repo even unit-tests the vaporware-token ban). One genuine violation cluster remains (F1–F3, all in the single `user-data-function` surface) whose primary loop silently executes wrong code on the out-of-box deployment — precisely the class the no-vaporware rule exists to catch, and cheap to fix given the host already supports pushed source. Everything else at or above B on the rubric. **Grade: B** (a fixed F1–F3 moves this dimension to A).
