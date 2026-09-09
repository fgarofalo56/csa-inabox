# folders-taskflows — parity with Fabric Workspace folders + task flows

Source UI: Fabric **Workspace → folders** + **Task flows**
Reference: <https://learn.microsoft.com/fabric/get-started/workspaces-folders>
Also: <https://learn.microsoft.com/fabric/get-started/task-flow-overview>
Run date: 2026-09-08 (rev.7 — line counts re-measured; rev.6 source re-measure
2026-09-07; rev.5 walk was 2026-06-09)

Every "N lines" below is `wc -l` on the file, one convention throughout. The
#4348 round-7 review measured four of them one high (folders route, the run
route, `step-runner.ts`, `launch-item.ts`) — every file here ends with a
newline, so `wc -l` is the count and the mixed convention is corrected, not
re-argued.

Loom surfaces:

- Folders BFF: `app/api/workspaces/[id]/folders/route.ts` (GET/POST/PATCH/DELETE, 199 lines)
- Folders pane: `lib/panes/folders.tsx` (1028 lines)
- Task-flows BFF: `app/api/workspaces/[id]/task-flows/route.ts` (GET/POST),
  `.../[flowId]/route.ts` (GET/PUT/DELETE), `.../[flowId]/run/route.ts` (POST/GET),
  plus the admin twins under `app/api/admin/workspaces/[id]/task-flows/`
- Task-flows canvas: `lib/panes/task-flows.tsx` (869 lines, `@xyflow/react`),
  mounted at `app/workspaces/[id]/page.tsx` under the `task-flows` tab
- Clients: `lib/clients/taskflow-client.ts`, `lib/clients/taskflow-run-client.ts`
- Run engine: `lib/taskflow/step-runner.ts`, `lib/taskflow/launch-item.ts`
- Store: Cosmos `folders` and `task-flows` containers (via `cosmos-client.ts`)

Folders and task flows are both **Loom-native** constructs in Cosmos. There is
**no dependency on real Microsoft Fabric** — both surfaces render and mutate with
`LOOM_DEFAULT_FABRIC_WORKSPACE` unset.

> **rev.6 correction.** Rev.5 recorded the task-flow canvas as a ⚠️ honest gate,
> "not yet built", backed by a MessageBar saying task flows were tracked for a
> future wave. Both halves of that were wrong. The canvas shipped in
> `d423fa3de0f` on **2026-06-09 at 21:01 −04:00**, roughly two hours *after*
> rev.5 was committed (`42cc3e7964b`, 18:55 −04:00) — so the row was false
> almost immediately, and stayed false for three months. The MessageBar it
> named does not exist either: a search of every `.ts`/`.tsx` file under
> `apps/fiab-console` for "future wave", "not yet built" and "tracked for a
> future" returns no task-flow hit at head. Corrected below.

## Fabric/Azure feature inventory (grounded in Learn)

1. Create a folder inside a workspace
2. Nested (sub) folders
3. Rename a folder
4. Move items into / out of a folder
5. Delete a folder (children reparent)
6. Task flows — a visual workflow canvas of tasks linking workspace items
   (separate Fabric authoring surface)
7. Create / open / delete a task flow within a workspace
8. Place tasks on the canvas and drag to reposition
9. Connect tasks with edges to express sequence
10. Attach a real workspace item to a task
11. Persist the canvas (Fabric autosaves the task-flow layout)
12. Canvas overview map + zoom controls

## Loom coverage

| Capability | Status | Backend |
|---|---|---|
| List folders in a workspace | ✅ Built | `GET /api/workspaces/[id]/folders` → Cosmos `folders` |
| Create folder (name, optional parent) | ✅ Built | `POST` → Cosmos create with `crypto.randomUUID()` id |
| Nested folders (parent field) | ✅ Built | `parent: body.parent ?? null` |
| Rename folder | ✅ Built | `PATCH` body `{id, name}` |
| Delete folder (children reparent to root) | ✅ Built | `DELETE ?id=` → Cosmos delete; child folders reparented (`parent: null`) and member items cleared (`folderId: null`), so both surface at the workspace root |
| Assign item to folder (`folderId` on item) | ✅ Built | item update carries `folderId`; tree groups by it |
| Task flows (visual workflow canvas) | ✅ Built | `TaskFlowsPane` (869 lines, `@xyflow/react`) on the workspace `task-flows` tab; Cosmos `task-flows` container via `lib/clients/taskflow-client.ts` |
| Create / open / delete a task flow | ✅ Built | `GET`+`POST /api/workspaces/[id]/task-flows`, `GET`+`DELETE .../[flowId]` → real Cosmos |
| Drag to reposition a task | ✅ Built | `useNodesState` + `onNodesChange` → debounced `PUT .../[flowId]` |
| Connect tasks with edges | ✅ Built | `onConnect` → `addEdge` (typed `taskflow` edge, `Handle`/`Position` ports from `canvas-node-kit`) |
| Attach a real workspace item to a task | ✅ Built | step editor picks a live `WorkspaceItem`; `lib/taskflow/launch-item.ts` resolves its open target |
| Canvas persistence | ✅ Built | 1200 ms debounce → `saveTaskFlow` → `PUT .../[flowId]` (real Cosmos write, no autosave-to-memory) |
| Canvas overview map + zoom controls | ✅ Built | `MiniMap` + shared `CanvasRightRail` (zoom in/out/fit, `fitView`) |
| **Beyond Fabric:** run a task flow and watch step status | ✅ Built | `POST`+`GET .../[flowId]/run` (252 lines) driven by `lib/taskflow/step-runner.ts`; runnable kinds `notebook`, `data-pipeline`, `synapse-pipeline`, `adf-pipeline`, `databricks-job` |
| **Beyond Fabric:** run history | ✅ Built | `listTaskFlowRuns` / `getTaskFlowRun` → run drawer |

Zero ❌ rows against the Fabric inventory: folder management and the task-flow
canvas are both fully built on real Cosmos, and the run/run-history pair exceeds
the Fabric surface. Zero ⚠️ gates — rev.5's single gate was the false task-flow
row, now corrected.

### Residual gaps against the Loom UX baseline (not Fabric inventory)

These are `ux-standards.md` obligations Loom sets for *itself*; Fabric's task-flow
canvas does not carry them either, so they are not parity ❌ rows — but they are
open work and are recorded here rather than left unsaid:

- **No undo / redo** on the canvas. `ux-baseline.md` makes the Wave-2 canvas
  layer (undo/redo, copy/paste, align/distribute, shortcut sheet) the standard
  for *every* canvas; `task-flows.tsx` has none of it.
- **No `SplitPane` with a persisted `sizingKey`** — the canvas is fixed-height,
  which is an explicit G3 violation.
- **No shared `EmptyState`** on the no-flows / no-steps panes (`web3-ui.md`
  requires the primitive rather than a hand-rolled empty pane).

## Backend per control

- **Folders** — all four verbs read-modify-write the Cosmos `folders` container
  (PK on workspace). Create assigns a UUID; delete reparents child folders to
  root (`parent: null`) and clears `folderId` on the folder's member items, so
  both surface at the workspace root rather than disappearing. (Rev.5 said items
  *retained* their `folderId`; the route explicitly nulls it — corrected here.)
- **Item ↔ folder** — items carry a `folderId`; the workspace tree groups items
  under their folder client-side.
- **Task flows** — real Cosmos, not a stub. `GET`/`POST
  /api/workspaces/[id]/task-flows` list and create; `GET`/`PUT`/`DELETE
  .../[flowId]` open, persist and remove; `POST`/`GET .../[flowId]/run` start a
  run and poll it. The admin twins under `app/api/admin/workspaces/[id]/
  task-flows/` serve the same shapes for the admin plane. Clients:
  `lib/clients/taskflow-client.ts` (143 lines) and
  `lib/clients/taskflow-run-client.ts` (61 lines).
- **Task-flow run engine** — `lib/taskflow/step-runner.ts` (243 lines) exports
  `RUNNABLE_ITEM_TYPES`, `isRunnableType`, `flowHasRunnableItems`,
  `topoSortSteps`, `buildFlowRunSkeleton`, `rollupStepStatus`,
  `rollupFlowStatus`. `lib/taskflow/launch-item.ts` (266 lines) resolves a step's
  attached item to its open target.
- **Tests** — `lib/clients/__tests__/taskflow-client.test.ts` (128),
  `lib/panes/__tests__/task-flows-run.test.tsx` (105),
  `lib/taskflow/__tests__/step-runner.test.ts` (185).

## Per-cloud notes

| Cloud | Behaviour |
|---|---|
| Commercial / GCC / GCC-High / IL5 | Identical — Cosmos-backed, cloud-agnostic. |

## Bicep sync

- No new resource — the `folders` and `task-flows` Cosmos containers are created
  by the existing Cosmos init step.
- No new env var or role grant.

## Verification

- Default path works with `LOOM_DEFAULT_FABRIC_WORKSPACE` unset.
- Live walk (folders): in a workspace, create a folder and a sub-folder (real
  POST → Cosmos), rename it (PATCH), move an item into it, delete the parent and
  confirm the child reparents to root and the item surfaces at root.
- Live walk (task flows): open the workspace `task-flows` tab, create a flow,
  add two steps, connect them, attach a real item to each, drag one, wait out the
  1200 ms debounce, reload and confirm the layout persisted; then Run and confirm
  the step status rolls up and the run appears in history.

**Evidence basis for rev.6.** This revision is a **source re-measure, not a live
browser walk** — every ✅ above is grounded in the route verbs, client functions,
canvas handlers and test files named in this doc, read at head. Per
`ux-baseline.md` G1 that is *not* completion evidence, so the grade below is
stated on the source-measured basis and the live-walk receipt is still owed.

Grade: **A− (source-measured)** — the Fabric inventory is fully built on real
Cosmos and the run pair exceeds it; held below A by the three Loom-baseline
canvas gaps above and by the absence of a G1 live receipt at this revision.
Rev.5's **A−** was recorded for the opposite reason (a task-flow gate that did
not exist); the letter is unchanged, the reasoning is not.
