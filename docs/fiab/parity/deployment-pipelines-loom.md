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

## Variable-library-aware promotion (FGC-24)

Fabric's FabCon-2026 flagship CI/CD feature — a workspace-scoped Variable Library
whose values resolve **per environment** so promotion swaps stage-appropriate
values — is delivered Azure-native with **zero new infra**:

- The Variable Library is the existing Cosmos-backed `variable-library` item;
  `state.variables[]` already carry a per-value-set override map (`default` / `dev`
  / `test` / `prod`).
- On promotion, `_lib/promote.ts` maps the **target** stage to its value set
  (`stageValueSet` — Development→dev, Test/Staging→test, Production→prod), collects
  that set's values from the pipeline's variable libraries (target-workspace
  libraries win a name clash, mirroring Fabric's per-workspace active set), and
  **rebinds** every `{{var:NAME}}` placeholder token in the promoted item's
  `state.content` to the resolved value **before** it is written to the
  destination workspace and handed to the provisioner. The rebound content is
  what the provisioner materializes and what is persisted on the target item.
- **`secret-ref`** typed variables are **never inlined** into promoted JSON — their
  tokens are left verbatim and resolved from Key Vault by the runtime dereference
  layer, so no secret material lands in Cosmos.
- A **"Variable overrides"** section on the pipeline pane (`GET .../loom/[id]/variables`)
  shows every variable's value per stage and flags which ones `differ` — mirroring
  Fabric's variable-library view in the compare. Values are edited in the Variable
  Library item (structured; no freeform config here).

## Approval-gated promotion (BR-APPROVAL)

A stage can require **N approvals from named users/groups** before a promotion INTO
it runs — governance-as-the-feature (admins **configure** the gate):

- Per-stage policy (`PUT .../loom/[id]/stages/[stageId]/approvals`): `enabled`,
  `requiredApprovals` (1–10), and an `approvers[]` list of user oids / Entra group
  ids. Default is **opt-out** (disabled ⇒ promotes freely). An enabled gate with
  no approvers, or `requiredApprovals` above the approver count, is rejected.
- When a gated target is deployed to, the deploy route **does not promote** — it
  creates a **pending approval request** carrying a diff summary of what would
  promote and returns `{ status: 'pending-approval', requestId }`.
- Approvers (matched by oid **or** group membership) approve/reject via
  `POST .../loom/[id]/approvals/[requestId]`. The **requester cannot self-approve**
  (separation of duties) but may reject/cancel. On the **final** required approval
  the route runs the **same** `runPromotion` engine the deploy route uses — under a
  synthetic **owner** session so item-crud reaches the owner's stage workspaces.
- Every decision emits a `pipeline.promotion.*` event to the **`LoomAudit_CL` SIEM
  stream** (BR-SIEM, honest-gated on `LOOM_AUDIT_DCR_*`). **BR-WEBHOOK** (`emitLoomEvent`)
  is not on `origin/main` yet, so no outbound webhook is emitted — audit only; when
  BR-WEBHOOK lands, add a `void emitLoomEvent(...)` beside each audit emit.

Both features are **Cosmos-only** and add **no** container or bicep param — the
approval policy + request lifecycle share the existing `pipeline-stage-rules`
container, discriminated by a `docType` field + id prefix.

## Cosmos containers (lazy `createIfNotExists`, no extra ARM step)

- `loom-pipelines` (PK `/tenantId`) — pipeline catalog
- `pipeline-stage-rules` (PK `/pipelineId`) — per-stage deployment rules **plus**
  approval policies (`approval-policy:<pipelineId>:<stageId>`) and approval requests
  (`approval-request:<uuid>`), discriminated by `docType`
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
- `lib/install/__tests__/pipeline-variables.test.ts` (FGC-24) — stage→value-set
  mapping, value collection (secret exclusion, target-wins merge), `{{var:NAME}}`
  rebind (nested strings, deep-clone/no-mutation, secret + unknown tokens left
  verbatim), and the per-stage variable diff.
- `lib/install/__tests__/pipeline-approvals.test.ts` (BR-APPROVAL) — eligibility
  by oid/group, distinct-approver counting, status derivation, and `applyDecision`
  (not-eligible / self-approval / threshold-reached / reject / overwrite / immutable).
- `app/api/deployment-pipelines/__tests__/wave8-alm-routes.test.ts` — the variables
  route diff, deploy-time variable rebind (provisioner + persisted item carry the
  resolved value), approval-policy CRUD + validation, the deploy gate (pending
  request, no promotion), and the approve→promote flow (eligible approve promotes;
  self-approval 403; non-approver 403; requester cancel).
