# Parity gap — `/workspaces` list

**Loom route:** `/workspaces` (rendered by `apps/fiab-console/app/workspaces/page.tsx` → `WorkspacesPane`)
**Fabric reference:** Microsoft Fabric Workspaces — https://learn.microsoft.com/fabric/fundamentals/workspaces
**Loom screenshot:** `temp/parity/page-workspaces-loom.png` (unauthed shell rendered)
**Captured:** 2026-05-26

## Phase 3 — Side-by-side gap matrix

| # | Fabric Workspaces element | Loom Workspaces element | Status | Severity |
|---|---|---|---|---|
| 1 | Page header with title "Workspaces" | "Workspaces" page header from PageShell with subtitle "A workspace is where you collaborate on items — lakehouses, notebooks, warehouses, reports, and everything else." | present | — |
| 2 | "+ New workspace" primary button | "+ New workspace" appearance="primary" button — opens Fluent Dialog with Name/Description/Capacity/Domain fields, real `createWorkspace()` mutation, redirects to `/workspaces/[id]` on success | present | — |
| 3 | List/grid of workspaces showing name, description, capacity, owner, recent activity | Card grid (`grid-template-columns: repeat(auto-fill, minmax(280px, 1fr))`) showing name, description, capacity + domain meta, createdAt timestamp — each card links to `/workspaces/[id]` | present (Fabric also shows last-activity-by; Loom shows createdAt) | MINOR |
| 4 | Filter/search bar over workspaces | Not present — global header search covers item-wide search but no per-page filter input on `/workspaces` | missing | MAJOR |
| 5 | Sort by name / modified / created / capacity | Not present (only default sort by createdAt DESC server-side) | missing | MINOR |
| 6 | Column-vs-tile view toggle | Not present | missing | MINOR |
| 7 | Domain grouping (workspaces grouped by domain) | Domain shown per-card but not grouped headers | partial | MINOR |
| 8 | "Open" / quick-actions menu on each workspace card (Settings, Permissions, Delete, Endorse, Open in browser) | Card click goes to detail page only; no context menu on hover/right-click | missing | MAJOR |
| 9 | Capacity badge / state indicator (Pause / Running / F-SKU) | Capacity shown as plain text alongside domain | partial | MINOR |
| 10 | Empty state when 0 workspaces | "No workspaces yet. Click + New workspace to create your first one." with explanation of what a workspace is | present | — |
| 11 | Error state when API fails | `MessageBar intent="error"` shows "Failed to load workspaces: <err>" — when 401, dedicated `SignInRequired` component | present + honest | — |
| 12 | Permissions / sharing modal | Not present on list page (may exist on detail page) | n/a here | n/a |
| 13 | Workspace-level "Pin to nav" action | Not present on cards | missing | MINOR |
| 14 | Tenant / billing region indicator on each workspace | Not present | missing | MINOR |

## Phase 4 — Functional verification (source-code + earlier-session evidence)

**Direct browser verification was hampered by the Playwright session losing its auth cookie partway through (a fresh MSAL sign-in is required for each session and cannot be completed without interactive password entry per security policy).** Validation falls back to:
1. Live shell render (✓ confirmed renders correctly)
2. Source-code review for stub patterns (✓ no mocks)
3. Backend route inspection (✓ real Cosmos query with tenant-scoped auth)
4. Earlier-session network-trace evidence (workspaces API was 200 in first session)

| Control | Verification | Result |
|---|---|---|
| New workspace dialog | Source: `WorkspacesPane` in `lib/panes/workspaces.tsx`. Uses real `useMutation` against `createWorkspace()` → POST `/api/workspaces` | OK — real backend wired |
| Workspace card link | href=`/workspaces/[id]` — real route | OK |
| List load | `useQuery({queryKey: ['workspaces'], queryFn: listWorkspaces})` → GET `/api/workspaces` | OK — real Cosmos query in route handler `apps/fiab-console/app/api/workspaces/route.ts` with `SELECT * FROM c WHERE c.tenantId = @t` |
| Auth handling | When 401 detected, renders `SignInRequired` component instead of error MessageBar | OK — honest gate |
| Empty state | Renders friendly "No workspaces yet" with Cosmos-backed explanation | OK |

## Backend reality check (no-vaporware audit)

```typescript
// apps/fiab-console/app/api/workspaces/route.ts
export async function GET(_req: NextRequest) {
  const session = getSession();
  if (!session) return err('Unauthorized', 401, 'unauthorized');
  const tenantId = session.claims.oid;
  const c = await workspacesContainer();
  const { resources } = await c.items.query<Workspace>({
    query: 'SELECT * FROM c WHERE c.tenantId = @t ORDER BY c.createdAt DESC',
    parameters: [{ name: '@t', value: tenantId }],
  }, { partitionKey: tenantId }).fetchAll();
  return NextResponse.json(resources);
}
```

This is **real Cosmos DB SQL**, partitioned by tenant, session-gated. POST also persists via Cosmos `upsertItem()` + indexes into AI Search via `upsertLoomDoc()`. No `return []` placeholders. **Backend is production-grade.**

## Honest grade

**Grade: B**

Reasoning:
- Phase 3: 0 BLOCKER, 2 MAJOR (no filter/search, no card context menu), 6 MINOR. The MAJORs are common Fabric features (filter input over the list, card right-click menu).
- Phase 4: 0 BROKEN — every wired control reaches a real backend.
- The shell renders perfectly. The create-workspace path is real. Cosmos query is real.

Not A because Fabric's Workspaces list has a strong filter input + sort headers + card overflow menu (Settings, Endorse, Pin, Delete) — Loom currently has card→detail navigation only.

## Recommended next actions

1. Add a `<SearchBox>` filter input above the card grid with client-side name-filter + server-side facet support.
2. Add card context menu (right-click + ellipsis button) with Endorse, Pin, Settings, Delete.
3. Add column/tile view toggle in the page header.
4. Add domain grouping headers when the workspace set spans multiple domains.
5. Add per-card capacity-state badge (Paused / Running / Suspended) using the capacity-state API.
