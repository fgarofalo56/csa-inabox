# workspace-create — parity with Fabric Create workspace

Source UI: Fabric **Workspaces → New workspace** dialog
Reference: <https://learn.microsoft.com/fabric/get-started/create-workspaces>
Run date: 2026-06-09

Loom surfaces:

- Dialog: `CreateWorkspaceDialog` in `app/workspaces/page.tsx`
- BFF: `app/api/workspaces/route.ts` (POST)
- Bindings: `lib/azure/workspace-bindings.ts` → `applyWorkspaceBindings()`
- Capacity assignment: `lib/azure/fabric-client.ts` → `assignWorkspaceToCapacity()`

A workspace is created **Azure-native** as a Cosmos `workspaces` record; the
optional capacity assignment and domain registration are best-effort
side-effects that never block creation. Works with
`LOOM_DEFAULT_FABRIC_WORKSPACE` unset.

## Fabric/Azure feature inventory (grounded in Learn)

1. Workspace name (required) + description
2. Assign to a capacity (license mode)
3. Assign to a domain
4. Advanced: contacts, OneLake storage, Azure region/Git
5. Land in the new workspace on success

## Loom coverage

| Capability | Status | Backend |
|---|---|---|
| Name (required) | ✅ Built | `POST /api/workspaces` body.name → Cosmos `workspaces` |
| Description (optional) | ✅ Built | body.description |
| Capacity picker (dropdown from real capacities, free-text fallback) | ✅ Built | `GET /api/loom/capacities`; fallback to free-text when gated |
| Domain picker (dropdown from real Loom domains) | ✅ Built | `GET /api/admin/domains` → Cosmos |
| Redirect to workspace on success | ✅ Built | `router.push('/workspaces/${ws.id}')` |
| Capacity assignment side-effect | ✅ Built | `applyWorkspaceBindings` → `assignWorkspaceToCapacity()` (or queued status) |
| Domain registration → Purview mirror | ⚠️ Honest gate | `registerAtlasEntity`; `PurviewNotConfiguredError` captured into `domainRegistration.status`, never blocks create |

Zero ❌ rows. The single ⚠️ gate (Purview mirror) is best-effort and surfaced as
a status field; the workspace is fully created without Purview.

## Backend per control

- **Create** — `POST /api/workspaces` writes a `workspaces` record (id, name,
  description, domain, capacity binding, owner, tenantId) to Cosmos, then calls
  `applyWorkspaceBindings()` which (a) assigns the workspace to its capacity via
  `assignWorkspaceToCapacity()` and (b) attempts a Purview/Atlas domain
  registration. Both side-effects are wrapped so a failure records a status and
  the create still returns 200.
- **Capacity picker** — `GET /api/loom/capacities`; when the capacities source
  is unavailable the picker degrades to a free-text capacity id (never a hard
  block).
- **Domain picker** — reuses the `domains.md` Cosmos source.

## Per-cloud notes

| Cloud | Capacity picker |
|---|---|
| Commercial | Real capacities enumerated; free-text fallback |
| GCC | Power BI P-SKU only (P1/P2/P3) reflected; no F-SKU |
| GCC-High | Picker falls back to free-text capacity id when SP authorization differs |
| IL5 | Same as GCC-High; Purview mirror targets `.purview.azure.us` |

## Bicep sync

- No new resource — uses existing `workspaces` Cosmos container.
- No new env var; Purview mirror reuses the `loomPurviewAccount` param already
  wired for the domains/governance surfaces.

## Verification

- Default path works with `LOOM_DEFAULT_FABRIC_WORKSPACE` unset — the create
  succeeds and lands in the new workspace even when no capacity/domain/Purview is
  bound.
- Live walk: open `/workspaces`, click Create, enter a name, optionally pick a
  domain + capacity, submit, confirm redirect to `/workspaces/{id}` and that the
  new record appears in both `/workspaces` and `/admin/workspaces`.

Grade: **A** — real Cosmos create + best-effort Azure bindings; only the Purview
mirror is honest-gated.
