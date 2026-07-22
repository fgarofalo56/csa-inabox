# Functional Audit — Catalog Items & Editors (platform-items)

**Auditor pass:** 2026-06-26 · worktree `fix-ui-wave2-a` · branch `feat/loom-marketplace`
**Scope:** the full catalog item-type set (`lib/catalog/fabric-item-types.ts`, 124 slugs),
the editor registry (`lib/editors/registry.ts`), the +New / install / provision flow
(`lib/install/provisioning-engine.ts` + `lib/install/provisioners/**`), and the per-item
BFF routes (`app/api/items/**`, 1107 `route.ts` files).

## Method

- Extracted all 124 catalog slugs and diffed against the 118 registry keys —
  **every catalog slug resolves to a dedicated editor** (no generic-fallback orphans;
  the apparent 7-slug gap was a CRLF artifact, verified false by direct grep).
- Ran the no-vaporware greps over `lib/editors` + `app/api/items`:
  - `return []` / `return {}` → only guard clauses + JSON-parse fallbacks; **no stub routes**.
  - `useState(MOCK_/SAMPLE_/[{)` → 5 hits, all legitimate **editor seed templates**
    (SAMPLE_SQL, SAMPLE_PYSPARK, SAMPLE_AVRO, SAMPLE_KQL_DB) — allowed starter content, not fake data.
  - `onClick={() => {}}` / noop handlers → **zero**.
  - `NextResponse.json([])` / `json({})` stub responses → **zero**.
  - `MOCK_/SAMPLE_` constants in `app/api/items` → 2 hits, both intentional
    (`data-pipeline/practice-seed`, `semantic-model/scaffold` — named seed/scaffold endpoints).
- Traced representative surfaces UI → BFF → Azure backend (Activator, Event Hubs,
  Service Bus, Event Grid, lakehouse-shortcut, ADF pipeline, Plan).

## Headline

This area is in **strong shape**. The canonical "installs but the editor/runtime is a
stub" problem (the **Activator/Reflex**) has been **fully resolved** — it now drives real
`Microsoft.Insights/scheduledQueryRules` + action groups, with Fabric strictly opt-in.
No F-grade (vaporware) surfaces were found among the catalog editors. Findings below are
B/C polish, one dead-code zombie cluster, and one provisioner-registration gap.

## Findings

| # | Surface | Grade | Type | Symptom / root cause (file:line) | Fix | Pri |
|---|---------|-------|------|----------------------------------|-----|-----|
| 1 | Activator (RTI Reflex) | A | (resolved) | Canonical stub is FIXED. `ActivatorEditor` (`lib/editors/phase3-editors.tsx:8839`) → `/api/items/activator/[id]/rules` (`route.ts:99-165`) → `createMonitorActivatorRule` → real `Microsoft.Insights/scheduledQueryRules` + action groups; Trigger runs real KQL vs Log Analytics; rules persist on the Cosmos item; honest 503/403 Monitor gate. Fabric Reflex opt-in via `LOOM_ACTIVATOR_BACKEND=fabric`. | None — reference implementation for the "honest Azure-native default" pattern. | — |
| 2 | wave2-a items not registered in the provisioning engine | B | install-flow gap | `event-hubs-namespace`, `service-bus-namespace`, `event-grid-topic`, `lakehouse-shortcut` are in the catalog (`fabric-item-types.ts:2837/2849/2861/2873`) and the registry, but **absent from `PROVISIONERS`** (`lib/install/provisioning-engine.ts:58-86`). If an app template/content bundle includes one, `provisionOne` returns `status:'skipped'` "No Phase-2 provisioner for itemType '…' (Cosmos-only)" (`provisioning-engine.ts:209-215`) — unlike sibling RTI items which provision real Azure. Direct +New still works (editors navigate the deployment-pinned shared namespace via real ARM with an honest 503 gate), so not vaporware — but the install report is silently inconsistent. | Either register a thin verify-the-namespace-gate provisioner for each, OR add an explicit allowlist comment in `provisioning-engine.ts` documenting them as intentionally navigator-only (like `linked-service`/`integration-runtime`). | P2 |
| 3 | Dead legacy stub editors in `azure-services-editors.tsx` | D | zombie / dead code | `SynapseDedicatedSqlPoolEditor` (`lib/editors/azure-services-editors.tsx:81-130`) and `DatabricksNotebookEditor`/`Job`/`Cluster`/`SqlWarehouse` (`~575-690`) render `<MessageBar>"This is the legacy stub — use the wired editor"`. The registry does **not** reference them — `synapse-dedicated-sql-pool`→`synapse-sql-editors`, `databricks-*`→`databricks-editors` (`registry.ts:117,122-125`) — so they are unreachable today, but they're a regression hazard: any direct import or a registry typo would route a user to a dead stub. | Delete the dead exports (or re-export the real editors as aliases). Pure cleanup; no user-facing behavior change. | P2 |
| 4 | phase4 editors — raw-px inline styles | C | web3-ui polish | `PlanEditor` (`lib/editors/phase4-editors.tsx:3444`) and siblings use `style={{ height: 6, minWidth: 120, maxWidth: 240, ... }}` — hard-coded px where Loom spacing/size tokens exist (web3-ui.md violation). Functional and Cosmos-backed (via `useItemState`, `phase4-editors.tsx:343-391`, real GET/PUT `/api/items/{slug}/{id}`) but visually off-system vs sibling editors. | Replace raw px with `tokens.spacing*` / bounded token sizes; lift inline grids to `TileGrid`. | P2 |
| 5 | Datamart (deprecated) | A | honest-gate | `DatamartEditor` (`phase3-editors.tsx:17705`) is correctly migration-only: catalog entry `deprecated:true, noRestApi:true` (`fabric-item-types.ts:640-642`), filtered out of the New-item dialog, Migrate action → `/api/items/datamart/migrate` (Synapse Serverless + AAS). | None — correct deprecation pattern. | — |
| 6 | SQL family slugs (consolidation, NOT zombies) | A | (note) | `sql-database` (`hiddenFromGallery`), `postgres-flexible-server` + `azure-sql-managed-instance` (`searchOnly`), and `azure-sql-database` (head tile w/ runtime selector) all map to `UnifiedSqlDatabaseEditor` (`registry.ts:178,184-185`; catalog `667/691/2376/2408`). This is intentional Wave-A/D consolidation, not duplicate zombies. | None — recorded so a future sweep doesn't false-flag the 3:1 editor mapping. | — |

## Surfaces verified real (spot-trace evidence)

- **Event Hubs namespace** — `EventHubsNamespaceEditor` (`event-hubs-namespace-editor.tsx`) → `/api/items/event-hubs-namespace/route.ts` → `eventhubs-client` real ARM (list/create/delete hubs + consumer groups); honest 503 gate when namespace env vars unset.
- **Service Bus namespace** — `/api/items/service-bus-namespace/route.ts` → `servicebus-client` real ARM (queues/topics create/delete), honest 503 gate.
- **Event Grid topic** — `/api/items/event-grid-topic/route.ts` → `eventgrid-topics-client` real ARM, 503 gate names `LOOM_EVENTGRID_SUB/RG` + the bicep module.
- **Lakehouse shortcut** — `/api/items/lakehouse-shortcut/route.ts` → `adls-client`; resolves a real `abfss://` location (sovereign-cloud-correct) and lists/verifies against ADLS Gen2; persists the shortcut as a Cosmos item.
- **ADF / Synapse pipelines** — `AdfPipelineEditor`/`SynapsePipelineEditor` (`azure-services-editors.tsx:698/541`) delegate to the shared `PipelineEditorCore` (real ARM bind + run + runs + validate), so a local fetch count of 0 in the wrapper is expected, not a stub.
- **Plan / VariableLibrary / phase4 items** — persist via `useItemState` → real GET/PUT `/api/items/{slug}/{id}` (Cosmos), not local `useState` mock data.

## Bottom line

Grade distribution for the audited catalog-items surface: **A** for the core item editors
and install dispatch, with **no F (vaporware)**. The two actionable items are P2: register
(or explicitly document) the four wave2-a items in the provisioning engine (#2) and delete
the dead `azure-services-editors.tsx` legacy stubs (#3). The web3-px cleanup (#4) is polish.
