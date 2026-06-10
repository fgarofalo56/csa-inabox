# deployment-pipelines-loom — parity with Fabric Deployment pipelines

Source UI: Microsoft Fabric → Workspace → **Deployment pipelines** (Dev → Test →
Prod stages, Compare, Deploy, Deployment rules).
Learn: https://learn.microsoft.com/fabric/cicd/deployment-pipelines/intro-to-deployment-pipelines
Compare: https://learn.microsoft.com/fabric/cicd/deployment-pipelines/compare-pipeline-content
Deployment rules: https://learn.microsoft.com/fabric/cicd/deployment-pipelines/create-rules

This is the **Azure-native DEFAULT** (no-fabric-dependency.md). The existing
Fabric-REST tab remains as an opt-in alternative; the **Loom-native pipelines**
tab is the default and works with `LOOM_DEFAULT_FABRIC_WORKSPACE` UNSET — no
Microsoft Fabric / Power BI workspace required. Stages bind to Loom workspaces
(Cosmos); compare, rules, deploy, and history are all Cosmos + the Azure-native
provisioner backends.

## Fabric feature inventory → Loom coverage

| Fabric capability | Loom coverage | Backend |
|---|---|---|
| Create pipeline (name + ordered stages 2–10) | ✅ `New pipeline` dialog; each stage bound to a Loom workspace | `POST /api/deployment-pipelines/loom` → Cosmos `loom-pipelines` |
| Dev → Test → Prod stage cards (coloured, ordered) | ✅ `LoomPipelineDetail` stage-flow cards (same colour language as the Fabric tab) | `GET /api/deployment-pipelines/loom/[id]` |
| Assign a workspace to a stage | ✅ at create time (workspace picker per stage) | `/api/workspaces` |
| **Distinct workspace per stage** (a workspace belongs to one stage only — [assign-pipeline limitation 1.2](https://learn.microsoft.com/fabric/cicd/deployment-pipelines/assign-pipeline#considerations-and-limitations)) | ✅ create rejects duplicate `workspaceId` (`409`-style `duplicate_workspace` 400); the create dialog disables already-chosen workspaces; deploy on a legacy same-workspace pipeline returns a readable "re-bind one stage" message instead of a raw promote error | `POST /api/deployment-pipelines/loom` + `POST …/[id]/deploy` |
| Compare two stages (sync indicator + per-item status) | ✅ `LoomStageCompare` — Same / Different / Only-in-source / Not-in-source + summary | `GET …/[id]/compare` → `computePipelineDiff` |
| **Content-level diff** (the thing Fabric REST can't do) | ✅ serialized-definition diff: TMSL (`buildTmsl`) for semantic models, stable JSON for report / paginated-report / scorecard | `lib/install/pipeline-compare.ts` |
| Deploy all | ✅ `Deploy all` in `LoomDeployDialog` | `POST …/[id]/deploy` |
| Selective deploy (choose items) | ✅ per-item checkboxes (marks *changed* / *new*) | `POST …/[id]/deploy` with `items[]` |
| Re-provision content into the next stage | ✅ runs the SAME real provisioner the install path uses (`PROVISIONERS[itemType]`) | `lib/install/provisioning-engine.ts` |
| Deployment note | ✅ note textarea, persisted to history | — |
| **Deployment rules** (data-source / parameter overrides per stage) | ✅ real, editable `LoomRulesDialog` (dropdowns for item type / kind / key + value) — applied on deploy via `applyStageRules` | `GET/PUT …/[id]/stages/[stageId]/rules` → Cosmos `pipeline-stage-rules`; `lib/install/pipeline-deploy.ts` |
| Deployment history | ✅ `LoomHistoryPanel` (from → to, status, item count, by, note) | `GET …/[id]/history` → Cosmos `pipeline-history` |
| Delete pipeline | ✅ `DeletePipelineButton` (also removes stage-rule docs) | `DELETE …/[id]` |
| Assign new workspace on empty-target deploy | ⚠️ N/A — Loom stages always bind a workspace at create time (no empty-stage state), so the Fabric "create workspace on deploy" prompt doesn't apply |

Zero ❌. The one ⚠️ is a deliberate model difference (Loom binds a workspace per
stage up front), not a missing capability.

## Backend per control

- **Compare** → reads every item in the source + target stage workspaces
  (`listAllOwnedItems`), serializes each item's `state.content`
  (`serializeItemDef`), pairs by (itemType, lowercased name), diffs byte-for-byte.
- **Selective deploy** → for each chosen source item: `applyStageRules(base, rules,
  itemType, name)` patches the env-resolved `ProvisionTarget`
  (`resolveTarget('shared')`); the paired target item is updated (or created); the
  real `PROVISIONERS[itemType]` runs against the patched target; the promoted
  definition + provision receipt are written back; the run is recorded in history.
- **Deployment rules** → `datasource` keys (warehouseServer / warehouseDatabase /
  adlsAccount / adlsContainer / synapseWorkspace / kustoClusterUri / kustoDatabase /
  aiSearchService) and `parameter` keys (synapseWorkspace / adlsAccount /
  warehouseServer / warehouseDatabase) map onto `ProvisionTarget` fields.

## No-Fabric verification

Acceptance (`LOOM_DEFAULT_FABRIC_WORKSPACE` unset): change a `semantic-model` in
the Dev workspace → `compare` labels it **Different** with a TMSL diff summary →
selective deploy to Test re-runs `semanticModelProvisioner` against a target whose
`warehouseServer` was overridden by the Test stage's `datasource` rule →
`{ ok, data: { diff, deployedItemIds } }` receipt. All Cosmos + the Loom-native
tabular backend; no `api.fabric.microsoft.com` / `api.powerbi.com` call on the
default path.

## Cosmos containers (lazy `createIfNotExists`, no extra ARM step)

- `loom-pipelines` (PK `/tenantId`) — pipeline catalog
- `pipeline-stage-rules` (PK `/pipelineId`) — per-stage deployment rules
- `pipeline-history` (PK `/pipelineId`) — deploy receipts

The Console UAMI already holds **Cosmos DB Built-in Data Contributor** at account
scope, so no new role assignment or bicep module is required.

## Tests

- `lib/install/__tests__/pipeline-compare.test.ts` — the four diff statuses +
  TMSL-based change detection.
- `app/api/deployment-pipelines/__tests__/loom-pipeline-routes.test.ts` —
  list/create, content compare, selective deploy (asserts the Test data-source
  rule reaches the provisioner + the deployed item ids + history write), rule
  GET/PUT round-trip + unknown-key rejection, and the **distinct-workspace
  guard** (create rejects two stages sharing a workspace; deploy on a legacy
  same-workspace pipeline returns `duplicate_workspace` with no side-effects).
- `app/api/deployment-pipelines/__tests__/deployment-pipelines-routes.test.ts` —
  the Fabric-path equivalents: deploy short-circuits a same-workspace promote
  before calling Fabric REST, and stage-workspace assign rejects a workspace
  already bound to another stage.
