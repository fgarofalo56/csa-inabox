# CSA Loom v3.0 → v3.1 Handoff

**Status:** v3.0 shipped to prod 2026-05-25 (Chunks 0 + 1). v3.1 building now
with Chunks 2, 3, 6, 7. v3.2+ remaining = Chunks 4, 5, 8 of the parity plan.

Live URL: <https://loom-console-fvbbctd4eehqbkcs.b02.azurefd.net>

## What shipped in v3.0 (live now)

### Chunk 0 — Foundation
- 11 new Cosmos containers (created at runtime via `createIfNotExists`):
  `apps-catalog`, `workloads-catalog`, `user-prefs`, `tabs-state`,
  `notifications`, `audit-log`, `comments`, `shares`, `folders`,
  `downloads`, `search-history`.
- 13 new BFF routes, all session-gated and tenant-scoped:
  - `GET/POST /api/apps-catalog`
  - `GET/POST /api/workloads-catalog`
  - `GET/POST/DELETE /api/user-prefs`
  - `GET/POST /api/tabs`
  - `GET/POST/PATCH /api/notifications`
  - `GET/POST /api/downloads`
  - `POST /api/search/items`
  - `GET /api/items/recent`
  - `GET/POST/DELETE /api/workspaces/[id]/folders`
  - `GET/POST /api/items/[type]/[id]/audit`
  - `GET/POST/DELETE /api/items/[type]/[id]/comments`
  - `GET/POST/DELETE /api/items/[type]/[id]/share`

Smoke results (unauth): all 12 GET routes return **401** (= deployed + auth gate working).

### Chunk 1 — Top header refactor
- `AppLauncher` waffle drawer (reads `/api/apps-catalog`).
- `TabStrip` multi-tab persisted to `/api/tabs`; pinned Home, auto-open on
  navigation, X to close, `loom:open-tab` CustomEvent for external triggers.
- `SavedStatus` (`loom:item-saving` + `loom:item-saved` indicator).
- `NotificationsButton` with unread badge polling `/api/notifications`.
- New topbar order: Brand · Launcher · TabStrip · SavedStatus · Search · 7-button actions.

## In v3.1 (built, awaiting deploy)

### Chunk 2 — Left sidebar Pinned section
- `PinnedSection` below primary nav. Reads/writes
  `/api/user-prefs?key=pinnedItems`. Listens for `loom:pin-toggle` so any
  component can pin without knowing storage shape.

### Chunk 3 — Home page Recent + Recommended
- `RecentItems` (top 8 from `/api/items/recent`).
- `RecommendedApps` (top 8 from `/api/apps-catalog`).
- Honest empty states ("Open or edit an item to see it here").

### Chunk 6 — Bootstrap + top-level pages
- `POST /api/admin/bootstrap-catalogs` — idempotent in-container seed
  (Cosmos is PE-locked so the bash script `seed-catalogs.sh` can't run from
  outside the VNet; this route runs the same seed from inside).
- Both `/api/apps-catalog` and `/api/workloads-catalog` auto-copy from
  `GLOBAL` → `session.claims.oid` on first GET that returns `[]`. New
  tenants get the seed without admin action.
- New pages: `/apps`, `/apps/[id]`, `/workloads`, `/learn`.

### Chunk 7 — Editor side panel + Learn popups
- `ItemSidePanel` adds four drawer buttons to every editor's action row:
  - **Comments** → `/api/items/[type]/[id]/comments`
  - **Version history** → `/api/items/[type]/[id]/audit`
  - **Share** → `/api/items/[type]/[id]/share` (signed token URL + revoke)
  - **Learn** → `lib/learn/content.ts` (11 hand-authored entries today)
- Learn auto-opens on first visit per item type unless dismissed (via
  `/api/user-prefs?key=learnDismissed:${type}`).
- Per the no-vaporware rule: missing Learn entries show an honest
  "not yet authored" MessageBar — never auto-generated placeholder text.

## Bicep sync (no-vaporware §3)

The 11 new Cosmos containers are **not** declared in bicep. They are
created via `createIfNotExists` from `apps/fiab-console/lib/azure/cosmos-client.ts`
on container app cold start. The BFF is the source of truth for the
container list — there is no drift possible between code and infra,
because there's only one source.

A push-button teardown + redeploy still reproduces full running state:
1. Bicep provisions the Cosmos account + `loom` database.
2. First BFF cold-start creates all 11 containers via SDK.
3. Operator calls `POST /api/admin/bootstrap-catalogs` once per environment
   (or first user sign-in triggers per-tenant copy from GLOBAL automatically).

## Post-deploy operator checklist

After v3.1 image goes live:
1. `curl -s https://loom-console-fvbbctd4eehqbkcs.b02.azurefd.net/api/version`
   → should report `v3.1`.
2. Sign in (MSAL flow), then `curl` `/api/admin/bootstrap-catalogs` from
   the signed-in browser (or with a minted cookie). Expect:
   `{ ok: true, tenant: 'GLOBAL', appsSeeded: 10, workloadsSeeded: 13 }`.
3. Refresh the app → home page should show 10 RecommendedApps cards;
   Apps page filter works; Workloads page lists 13 entries.
4. Click the App launcher (waffle) → drawer shows the same 10 apps.
5. Open any item → Learn drawer auto-pops; dismiss via "Don't show again";
   re-open via the Learn button.
6. Add a comment + create a share link → both should round-trip with
   real Cosmos backing (visible via Comments and Share buttons after refresh).
7. Notifications bell — mention yourself in a comment (paste your `oid`
   into the mentions array via curl) → bell badge increments.

## Remaining chunks (v3.2+)

- **Chunk 4** — Workspace view + +New item modal (existing `new-item-dialog`
  works; needs the Fabric-style category browser layout).
- **Chunk 5** — Workspace Settings drawer (15 sections: capacity, license,
  Git integration, OneLake settings, capacity assignment, sensitivity,
  etc.). Each section must be a real form posting to the right Azure REST.
- **Chunk 8** — Switch `/api/search/items` to AI Search indexer (today it
  uses Cosmos cross-partition queries; works for small catalogs but won't
  scale to enterprise. Index workspaces + items + comments via indexer
  defined in `ai-search-index` item type).
- **Chunk 10** — Vitest + Playwright UAT pass before declaring v3 GA.

## Files of note

- `apps/fiab-console/lib/azure/cosmos-client.ts` — single source of truth
  for container list. Adding a container = add to `ensure()` + add a getter.
- `apps/fiab-console/lib/learn/content.ts` — Learn registry. Add entries
  as item types are documented.
- `apps/fiab-console/app/api/admin/bootstrap-catalogs/route.ts` — bumps
  the seed when curated apps/workloads list changes; idempotent.
- `.claude/rules/no-vaporware.md` — die-hard rule. Every chunk must
  satisfy: front + BFF + real backing or it doesn't ship.

## Cosmos data plane

Cosmos `cosmos-loom-default-mwfaiy3trukkk` is `publicNetworkAccess=Disabled`.
All container ops must happen from inside the VNet — typically from
inside the container app. Operator-side `az cosmosdb sql container item *`
commands from a workstation will **not** work; use the bootstrap endpoint
or `az containerapp exec` instead.
