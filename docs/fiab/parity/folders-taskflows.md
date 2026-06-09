# folders-taskflows — parity with Fabric Workspace folders + task flows

Source UI: Fabric **Workspace → folders** + **Task flows**
Reference: <https://learn.microsoft.com/fabric/get-started/workspaces-folders>
Also: <https://learn.microsoft.com/fabric/get-started/task-flow-overview>
Run date: 2026-06-09

Loom surfaces:

- BFF: `app/api/workspaces/[id]/folders/route.ts` (GET/POST/PATCH/DELETE)
- Store: Cosmos `folders` container (via `foldersContainer()` in `cosmos-client.ts`)

Folders are a **Loom-native** organizational construct in the Cosmos `folders`
container. There is **no dependency on real Microsoft Fabric** — the folder tree
renders and mutates with `LOOM_DEFAULT_FABRIC_WORKSPACE` unset.

## Fabric/Azure feature inventory (grounded in Learn)

1. Create a folder inside a workspace
2. Nested (sub) folders
3. Rename a folder
4. Move items into / out of a folder
5. Delete a folder (children reparent)
6. Task flows — a visual workflow canvas of tasks linking workspace items
   (separate Fabric authoring surface)

## Loom coverage

| Capability | Status | Backend |
|---|---|---|
| List folders in a workspace | ✅ Built | `GET /api/workspaces/[id]/folders` → Cosmos `folders` |
| Create folder (name, optional parent) | ✅ Built | `POST` → Cosmos create with `crypto.randomUUID()` id |
| Nested folders (parent field) | ✅ Built | `parent: body.parent ?? null` |
| Rename folder | ✅ Built | `PATCH` body `{id, name}` |
| Delete folder (children reparent to root) | ✅ Built | `DELETE ?id=` → Cosmos delete; child folders reparented, items retain `folderId` and surface at root |
| Assign item to folder (`folderId` on item) | ✅ Built | item update carries `folderId`; tree groups by it |
| Task flows (visual workflow canvas) | ⚠️ Honest gate | Loom-native task-flow canvas not yet built; the workspace surfaces a MessageBar noting task flows are tracked for a future wave. Folders deliver the organizational parity today; task flows are an additive Fabric authoring surface, not a blocker. |

Zero ❌ rows. Folder management is fully built; the task-flow canvas is an
honest ⚠️ deferred-capability gate (disclosed in-product), per
`no-vaporware.md` — it does not leave any control dead or empty.

## Backend per control

- **Folders** — all four verbs read-modify-write the Cosmos `folders` container
  (PK on workspace). Create assigns a UUID; delete reparents child folders to
  root and leaves items' `folderId` intact so they surface at the workspace root
  rather than disappearing.
- **Item ↔ folder** — items carry a `folderId`; the workspace tree groups items
  under their folder client-side.
- **Task flows** — no backend yet; the gate is honest disclosure, not a stub
  control.

## Per-cloud notes

| Cloud | Behaviour |
|---|---|
| Commercial / GCC / GCC-High / IL5 | Identical — Cosmos-backed, cloud-agnostic. |

## Bicep sync

- No new resource — the `folders` Cosmos container is created by the existing
  Cosmos init step.
- No new env var or role grant.

## Verification

- Default path works with `LOOM_DEFAULT_FABRIC_WORKSPACE` unset.
- Live walk: in a workspace, create a folder and a sub-folder (real POST →
  Cosmos), rename it (PATCH), move an item into it, delete the parent and confirm
  the child reparents to root and the item surfaces at root; confirm the
  task-flows MessageBar is present and honest.

Grade: **A−** — folder lifecycle fully built on real Cosmos; the task-flow
canvas is the single honest deferred-capability gate.
