# folders-taskflows — parity with Fabric Workspace folders + task flows

Source UI: Fabric **Workspace → folders** + **Task flows**
Reference: <https://learn.microsoft.com/fabric/get-started/workspaces-folders>
Also: <https://learn.microsoft.com/fabric/get-started/task-flow-overview>
Grade: **A−** (see [Revision history](#revision-history) — the task-flow ⚠️ that
held rev. 5 at A− is gone, but this revision carries no in-browser G1 receipt,
and per the #3738 precedent a source-only re-verification does not sustain an A)
Run date: 2026-09-07 (rev. 6 — re-baselined against current `main`; see
[Revision history](#revision-history))

Loom surfaces:

- Folders BFF: `app/api/workspaces/[id]/folders/route.ts` (GET/POST/PATCH/DELETE)
- Folders store: Cosmos `folders` container (`foldersContainer()` in `cosmos-client.ts`)
- Task flows UI: `lib/panes/task-flows.tsx` → `TaskFlowsPane` (Flows list + a
  `@xyflow/react` canvas, the same engine the pipeline designer uses)
- Task flows BFF: `app/api/workspaces/[id]/task-flows/route.ts` (GET/POST),
  `…/[flowId]/route.ts` (GET/PUT/DELETE), `…/[flowId]/run/route.ts` (execute)
- Task flows store: Cosmos `task-flows` container, PK `/workspaceId`
  (`lib/clients/taskflow-client.ts`)
- Run engine: `lib/taskflow/step-runner.ts` (pure topological ordering + run
  shaping) + `lib/taskflow/launch-item.ts` (the real ADF / Synapse / Databricks
  / Spark launches)

Folders and task flows are both **Loom-native**, Cosmos-backed constructs. There
is **no dependency on real Microsoft Fabric** — both render and mutate with
`LOOM_DEFAULT_FABRIC_WORKSPACE` unset.

## Fabric/Azure feature inventory (grounded in Learn)

1. Create a folder inside a workspace
2. Nested (sub) folders
3. Rename a folder
4. Move items into / out of a folder
5. Delete a folder (children reparent)
6. Task flows — a visual workflow canvas of tasks linking workspace items
   (separate Fabric authoring surface)
7. Task-flow steps that link real workspace items
8. Persisted node positions + connections on the task-flow canvas

## Loom coverage

| Capability | Status | Backend |
|---|---|---|
| List folders in a workspace | ✅ Built | `GET /api/workspaces/[id]/folders` → Cosmos `folders` |
| Create folder (name, optional parent) | ✅ Built | `POST` → Cosmos create with `crypto.randomUUID()` id |
| Nested folders (parent field) | ✅ Built | `parent: body.parent ?? null` |
| Rename folder | ✅ Built | `PATCH` body `{id, name}` |
| Delete folder (children reparent to root) | ✅ Built | `DELETE ?id=` → Cosmos delete; child folders reparented, items retain `folderId` and surface at root |
| Assign item to folder (`folderId` on item) | ✅ Built | item update carries `folderId`; tree groups by it |
| Task flows — list / create / open / delete | ✅ Built | `TaskFlowsPane` "Flows" tab → `listTaskFlows` / `createTaskFlow` / `deleteTaskFlow` → `GET`/`POST` `…/task-flows`, `DELETE …/task-flows/[flowId]` → Cosmos `task-flows` |
| Task-flow visual canvas (drag nodes, connect steps) | ✅ Built | `TaskFlowsPane` "Canvas" tab on `@xyflow/react` with `canvas-node-kit` nodes/edges + `CanvasRightRail` |
| Step ↔ real workspace item link | ✅ Built | step `itemId` picked from `listItems()`; `findItemType` supplies the catalog glyph/accent |
| Canvas layout + edges persisted | ✅ Built | debounced `saveTaskFlow` → `PUT …/task-flows/[flowId]` → Cosmos |
| Task-flow EXECUTION (ordered run of the linked items) | ✅ Built — **exceeds Fabric** | `POST …/task-flows/[flowId]/run`; `step-runner.ts` topologically orders the steps (named-cycle detection) and `launch-item.ts` starts + polls the real ADF / Synapse / Databricks / Spark runs. Fabric task flows are organizational only and cannot be executed. |

Zero ❌ rows, zero ⚠️ gates.

## Backend per control

- **Folders** — all four verbs read-modify-write the Cosmos `folders` container
  (PK on workspace). Create assigns a UUID; delete reparents child folders to
  root and leaves items' `folderId` intact so they surface at the workspace root
  rather than disappearing.
- **Item ↔ folder** — items carry a `folderId`; the workspace tree groups items
  under their folder client-side.
- **Task flows** — Cosmos `task-flows` (PK `/workspaceId`) through
  `lib/clients/taskflow-client.ts`. Reads/writes go through the BFF routes
  above; the pane never talks to Cosmos directly. Run documents are persisted
  and polled (`getTaskFlowRun` / `listTaskFlowRuns`), so a run's history is real
  state, not client memory.
- **Task-flow authorization** — the task-flow routes currently gate on
  `assertOwnedWorkspace` (an owner-only workspace point read), which is why they
  are carried in `scripts/ci/owner-only-workspace-guard-baseline.json`. That is
  a NARROWER gate than the canonical ladder, not a hole: it refuses non-creators
  who arguably should pass. Tracked by the owner-only-workspace-guard ratchet.

## Per-cloud notes

| Cloud | Behaviour |
|---|---|
| Commercial / GCC / GCC-High / IL5 | Folders and the task-flow canvas are identical — Cosmos-backed, cloud-agnostic. |

Task-flow EXECUTION reaches whichever engines the boundary actually deploys
(ADF / Synapse / Databricks / Spark); a step whose engine is absent in that
boundary reports its own honest failure rather than the flow silently
succeeding.

## Bicep sync

- No new resource — the `folders` and `task-flows` Cosmos containers are created
  by the existing Cosmos init step.
- No new env var or role grant.

## Verification

- Default path works with `LOOM_DEFAULT_FABRIC_WORKSPACE` unset.
- **What THIS revision verified:** every row above was re-read against the
  current source — `lib/panes/task-flows.tsx`, the three task-flow BFF routes,
  `lib/taskflow/step-runner.ts`, and the folders route. The rev.-5 claims that
  the canvas was unbuilt and that task flows had no backend at all are
  both false against this tree and are removed.
- **What THIS revision did NOT verify, stated rather than implied:** no live
  in-browser click-walk was performed for this revision, so the `ux-baseline.md`
  G1 receipt is still owed — in particular a real `Run` of a flow against live
  engines. The walk to run: create a folder and a sub-folder (real POST →
  Cosmos), rename it (PATCH), move an item into it, delete the parent and
  confirm the child reparents to root; then create a task flow, add two linked
  steps, connect them, reload to confirm the layout persisted, and Run it.

## Revision history

| Rev | Date | What changed |
|---|---|---|
| 5 | 2026-06-09 | A− grade. Task flows recorded as a single ⚠️ deferred-capability gate: the Loom-native canvas was described as unbuilt and the feature as having no backend. (The rev.-5 wording is paraphrased, not quoted — `grep -c` over this file is the cheapest check that the false claim is gone, and quoting it would keep that check red forever.) |
| 6 | 2026-09-07 | **Re-baselined (#3725).** The rev.-5 ⚠️ row was stale: `lib/panes/task-flows.tsx` and the `…/task-flows` BFF routes exist and were last touched `3efc93be235` (2026-08-02) and `a3408c3ef5e` (#3138, 2026-08-08) — after the rev.-5 run date. Four new rows (canvas, step↔item link, persisted layout, execution) replace the single deferred-capability gate. Grade stays **A−**, for a DIFFERENT reason: the ⚠️ that held it there is gone, and the missing G1 browser receipt now holds it there instead. |
