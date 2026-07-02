# Release Audit — Dimension: ui-navigation (Navigation + Information Architecture)

Date: 2026-07-02 · Auditor: subagent (ui-navigation) · Worktree: `.claude/worktrees/fix-ui-wave2-a`
Scope: `apps/fiab-console` — `app/layout.tsx`, `lib/components/app-shell.tsx`, `lib/components/left-nav.tsx`, `lib/nav/nav-items.ts`, workspace switcher (`app/workspaces`, `lib/stores`), home, create flow (`lib/components/new-item-dialog.tsx`), `/browse`, `/catalog`, hubs (`realtime-hub`, `rti-hub`, `activator-hub`, `workload-hub`), marketplaces, admin entry, `/setup`.

## Intro — overall read as a first-time public user

The shell itself is solid: a Fabric-style topbar (brand, app launcher, tab strip, search, Copilot, help, admin, account — `lib/components/app-shell.tsx:160-229`), a collapsible left rail sourced from a single `NAV_ITEMS` array (`lib/nav/nav-items.ts:18-43`), a real command palette that mirrors those destinations plus admin pages plus "New <type>" verbs (`lib/components/command-palette.tsx:28-51,66-73,178-180`), Cosmos-persisted pinned items (`lib/components/pinned-section.tsx`), a work-in-progress tab strip with a sane auto-open policy (`lib/components/tab-strip.tsx:1-26`), and a first-run guided tour that auto-opens (`lib/components/onboarding/onboarding-tour.tsx:4,167-178`). Prior consolidation passes clearly happened and left GOOD redirects (`app/api-marketplace/page.tsx`, `app/catalog/domains/page.tsx`, `app/governance/domains/page.tsx`, `app/catalog/data-quality/page.tsx`, `app/items/page.tsx`, `app/experience/warp/page.tsx`).

The problems are higher-level IA problems, not broken links: the rail carries **24 flat, ungrouped destinations** (Fabric carries ~6), Real-Time Intelligence alone occupies **four** rail slots plus a fifth same-named orphan page, there are **three catalogs and three lineage surfaces**, **no sticky workspace context anywhere in the shell**, no "Create" entry in the rail, several internal codenames as nav labels ("Thread/Mesh lineage", "Warp", "RTI catalog"), and a handful of orphan pages (`/apps`, `/workloads`, `/data-products`, `/activator`, bare `/experience` + `/experience/data-science` 404). Everything below has file:line evidence.

---

## Findings

### N1 (HIGH) — 24 flat, ungrouped left-nav items; item-type list pages promoted to global nav
- Evidence: `lib/nav/nav-items.ts:18-43` — 24 entries; `lib/components/left-nav.tsx:104-127` renders them as one flat list with no group headers or dividers (the only divider is the Pinned section, `pinned-section.tsx:32`).
- Fabric's model is Home / Create / Browse / OneLake / Workspaces / Monitor (+ experience switcher). Loom's rail mixes: core surfaces (Home, Workspaces, Browse), 3 catalogs, 4 RTI entries, 2 experience deep-links (`/experience/data-science/home`, `/experience/warp/home`), single-item-type list pages (`/semantic-model` "Semantic models" → `app/semantic-model/page.tsx` is just `ItemsByTypePane` for 5 Power BI types; `/org-reports`; `/data-agent`), Copilot, Connections, Deployment, Admin, Setup.
- Why are semantic models and org reports rail-level but lakehouses, warehouses, notebooks not? A first-time user can't build a mental model.
- Recommendation: group the rail into labeled sections (Core / Catalogs / Real-Time / Experiences / Admin) or adopt the Fabric pattern: ≤8 pinned primaries + a "…More" flyout; demote `/semantic-model`, `/org-reports`, `/data-agent`, `/business-events` out of the primary rail (they remain reachable via command palette, Browse, workload hub).
- Effort: M.

### N2 (HIGH) — Real-Time Intelligence fragmented across 4 nav slots + a 5th orphan page with a duplicate title
- Evidence: `lib/nav/nav-items.ts:30-33` — `/realtime-hub` "Real-Time hub", `/activator-hub` "Activator", `/business-events` "Business events", `/rti-hub` "RTI catalog".
- Fifth surface: `app/activator/page.tsx:6-7` renders `title="Activator"` (items list) — the SAME PageShell title as `app/activator-hub/page.tsx:16` — and is reachable only from a body-text link in `lib/components/business-events/business-events-view.tsx:290`. Two different pages titled "Activator" is disorienting; the user cannot tell which one they're on.
- `/realtime-hub` vs `/rti-hub` distinction (deployed streams vs discoverable Azure sources) is explained only via two long subtitles (`app/realtime-hub/page.tsx:8`, `app/rti-hub/page.tsx:7`); the API layer even has `/api/real-time-hub` as a pure re-export alias of `/api/rti-hub` while the *pages* `realtime-hub` and `rti-hub` are different things — a naming trap for users and contributors alike.
- Fabric has ONE Real-Time hub with internal tabs (All data streams / My streams / Sources / …).
- Recommendation: one `/realtime-hub` with tabs: Streams (current realtime-hub), Discover sources (current rti-hub), Activator (current activator-hub pane), Business events. Retire `/activator` (fold into the hub's Activator tab, keep a redirect) or retitle it.
- Effort: L.

### N3 (HIGH) — Three catalogs in the primary rail, a fourth in Governance; labels don't disambiguate
- Evidence: `lib/nav/nav-items.ts:21-23` — `/browse` "Browse", `/onelake` "OneLake catalog", `/catalog` "Unified catalog"; plus `lib/components/governance-shell.tsx:22` — `/governance/catalog` "Data catalog — Unified inventory across OneLake, Synapse, Databricks, ADLS, on-prem".
- Label collision: the Unified catalog's own Browse tab labels the OneLake source "Loom workspaces" (`app/catalog/browse/page.tsx:24`), while the rail calls the same data "OneLake catalog". "Unified catalog" and "Data catalog — unified inventory" are indistinguishable phrases for two different pages.
- All four are real (onelake = Fabric OneLake-catalog parity `app/onelake/page.tsx:3-27`; catalog = federated Purview/UC search `lib/components/catalog/catalog-shell.tsx:13-19`; governance/catalog = AI-Search-backed governance inventory `app/governance/catalog/page.tsx:3-13`) — the problem is a first-time user asking "where do I find my data?" has 4 plausible answers.
- Recommendation: pick ONE rail-level catalog entry (keep `/onelake` for Fabric parity), move `/catalog` (federated/multi-source) to a tab or "Sources" scope inside it, keep `/governance/catalog` only inside Governance and rename it ("Governed inventory"). At minimum rename so the three rail labels are mutually predictive.
- Effort: L.

### N4 (HIGH) — Three lineage surfaces with three names and (at least) two engines
- Evidence: `/thread` "Mesh lineage" in nav (`nav-items.ts:26`; `app/thread/page.tsx:4-21` — Thread edge graph on the shared LineageCanvas); `/catalog/lineage` "Federated lineage" (`lib/components/catalog/catalog-shell.tsx:19`; page asks the user to paste a Purview GUID / UC table name — `app/catalog/lineage/page.tsx:27-29`); `/governance/lineage` "Purview lineage" (`governance-shell.tsx:23`) which per its own header is NOT Purview — "No Purview required — works against the real Cosmos catalog" with a hand-rolled SVG barycenter layout (`app/governance/lineage/page.tsx:4-11`).
- So: "Mesh", "Federated", "Purview" lineage — and the one labeled "Purview" is the one that doesn't use Purview. A first-time user cannot pick.
- Recommendation: one Lineage surface (the shared LineageCanvas engine `thread` and `catalog` already share, per `app/thread/page.tsx:15-19`) with a source scope switch (Loom edges / Purview / UC), reached from both Catalog and Governance rails; keep `/thread` as the nav home for it. Rename the governance rail entry honestly until merged.
- Effort: L.

### N5 (HIGH) — No sticky workspace context: no switcher in the shell, no workspace breadcrumb in editors
- Evidence: `lib/components/app-shell.tsx` renders brand / launcher / tabs / search / actions — no current-workspace control anywhere (lines 160-229). `lib/components/left-nav.tsx` has no workspace flyout (Fabric pins one). The item editor host (`app/items/[type]/[id]/page.tsx`) and `lib/editors/item-editor-chrome.tsx` show no workspace breadcrumb (grep for "workspace|Breadcrumb" in chrome returns only background-color styles). The only way to know "where am I" inside an editor is the TabStrip's optional group-by-workspace context menu (`lib/components/tab-strip.tsx:22-24`).
- The state layer confirms the gap: `lib/stores/ui.ts:14-19` declares `recentWorkspaces` + `pushWorkspace` for a "workspace selector (Phase 1)" — and NOTHING imports it (grep for `stores/ui|useUi` across app+lib returns zero call sites).
- Fabric: the workspace is THE primary container concept; its nav pins the current workspace and a workspace flyout.
- Recommendation: add a workspace switcher to the rail (current workspace pinned + recent list + "All workspaces"), and a `workspace › item` breadcrumb in ItemEditorChrome. The dead `ui.ts` store is a half-built start; either finish it or delete it (see N10).
- Effort: M.

### N6 (MEDIUM) — Create flow: no "Create" in the rail; home-created items land silently in the "newest" workspace; browsing types creates real Cosmos items
- Evidence: `lib/nav/nav-items.ts` has no create entry (Fabric's nav has "Create"). `/items` bare redirects to `/workspaces` (`app/items/page.tsx:4-7`). Create lives in the Home PageShell action (`app/page.tsx:126`), workspace detail (`app/workspaces/[id]/page.tsx:82`), and command palette "New <type>" (`command-palette.tsx:178-180`).
- `lib/components/new-item-dialog.tsx:7-16`: "On select we ALWAYS create a real Cosmos item first, then redirect… When opened from home (no prop) we resolve the caller's default (newest) workspace and scope creation to that." Confirmed at lines 239-260 (`listWorkspaces()` → `resolvedWorkspaceId`, newest first).
- Two consequences for a first-time user: (a) the dialog never asks or shows WHICH workspace the item will be created in from home — the item lands in whatever workspace is newest; (b) exploring item types mints real items, so an abandoned exploration leaves ghost drafts in a workspace the user may not think to check.
- Recommendation: add a "+ Create" rail entry opening NewItemDialog; show a workspace dropdown (default = most recent) inside the dialog when opened without a workspaceId; consider deferring the Cosmos write until the name step is confirmed.
- Effort: M.

### N7 (MEDIUM) — Orphan / dead-end pages not reachable from any nav surface
- `/apps` (gallery, 393 lines, real) — only inbound links are the back buttons inside `app/apps/[id]/page.tsx:142,154`. The AppLauncher drawer links only `/apps/[id]` cards (`lib/components/app-launcher.tsx:100`) and home's RecommendedApps likewise (`lib/components/recommended-apps.tsx:78`); neither offers "See all apps".
- `/workloads` (473 lines, real Fabric-parity workloads page) — inbound only from two buttons inside `/workload-hub` (`app/workload-hub/page.tsx:312,431`). Two workload surfaces, one rail slot; a user who lands on `/workloads` via Copilot (it's in the copilot allow-list, `lib/azure/help-copilot-orchestrator.ts:297`) has no way back into the rail model.
- `/data-products` (Purview data-products parity landing, `app/data-products/page.tsx:3-7`) — not in NAV_ITEMS; inbound only from marketplace internals (`lib/components/marketplace/api-marketplace.tsx`, wizard/details). Yet `/marketplace`'s subtitle sells "data products" as a marketplace concern (`app/marketplace/page.tsx:11`). Producer surface is effectively hidden.
- `/activator` — see N2.
- Bare `/experience` and `/experience/data-science` → hard 404: only `app/experience/warp/page.tsx` got the redirect fix (its comment at lines 4-11 documents this exact bug class — "renders a blank Next.js 404"); `app/experience/data-science/` has only `home/page.tsx` (verified via `find app/experience -type f`). The nav deep-links to `/home` so the rail works, but truncated links/bookmarks 404.
- Recommendation: add "See all" links (AppLauncher → /apps; marketplace → /data-products), fold `/workloads` into `/workload-hub` as a tab, add `app/experience/page.tsx` + `app/experience/data-science/page.tsx` redirects (copy the warp fix).
- Effort: S.

### N8 (MEDIUM) — Internal codenames as primary nav labels
- Evidence: `nav-items.ts:26` "Mesh lineage" (route `/thread` — page calls itself "Loom Thread"), `:36` "Warp" (`/experience/warp/home` — command palette sub says "Warp orchestration"), `:33` "RTI catalog" (vs `:30` "Real-Time hub" — same acronym family, spelled two ways), `:32` "Business events".
- A first-time public user cannot predict what Thread/Warp/RTI mean; the loom metaphor (thread/warp/weave) is charming internally but unglossed in the rail. Fabric labels are plain ("Real-Time hub", "Monitor", "OneLake").
- Recommendation: plain-language labels with the codename secondary ("Lineage", "Orchestration (Warp)"), or tooltips; align "RTI catalog" naming with N2's merge.
- Effort: S.

### N9 (MEDIUM) — User-plane rails deep-link into the admin plane; "Setup & landing zones" in the universal rail lands non-admins in the Admin portal
- Evidence: CatalogShell rail → `/admin/domains` (`lib/components/catalog/catalog-shell.tsx:16`); GovernanceShell rail → `/admin/domains`, `/admin/classifications`, `/admin/sensitivity-labels` (`governance-shell.tsx:21,24,25`). A non-admin steward browsing the catalog clicks "Domains" and is context-switched into AdminShell (26-section admin rail, `lib/components/admin-shell.tsx:24-50`).
- `nav-items.ts:42` "Setup & landing zones" is shown to every user; post-install `app/setup/page.tsx:26-28` redirects it to `/admin/landing-zones` — an admin surface. For every non-operator this rail slot is a dead end.
- Recommendation: gate the Setup rail entry on tenant-admin (the /api/me session already knows), and render read-only domain/classification views inside the catalog/governance shells instead of cross-plane jumps (or at least mark the links "(Admin)" — the desc text does, the link label doesn't).
- Effort: M.

### N10 (LOW) — Dead navigation-state modules: `lib/stores/ui.ts` and `lib/stores/tabs.ts` have zero importers; duplicate persistence keys
- Evidence: `grep -rn "stores/ui|useUi|stores/tabs"` across app+lib → no call sites outside the modules themselves. `ui.ts` persists `sidebarCollapsed` under localStorage key `loom-ui` (`ui.ts:40`) while the LIVE implementation in AppShell persists the same concept under `loom.navCollapsed` (`app-shell.tsx:128,137-142`). Tabs are actually persisted via `/api/tabs` (`tab-strip.tsx:4-5`), not the zustand `tabs.ts`.
- Not user-visible, but misleads contributors ("workspace selector (Phase 1)" comment suggests N5 was started here and abandoned) and risks a second collapse-state source of truth being wired later.
- Recommendation: delete both stores or finish the workspace-selector they stub.
- Effort: S.

### N11 (LOW) — Home "Get started" card mislabels a deep create-form link
- Evidence: `app/page.tsx:109` — card titled "Synapse, Databricks, ADF" ("Underlying Azure services — natively surfaced in Loom") links to `/items/synapse-dedicated-sql-pool/new`, i.e. a create-gate for one specific item type. A first-time user expecting a services overview lands on a "create a dedicated SQL pool" form.
- Recommendation: point it at `/workload-hub` (or the Synapse workload landing `/workload-hub/synapse-analytics`).
- Effort: S.

### N12 (LOW) — First-run steering relies entirely on the auto-tour; Home doesn't react to an empty tenant
- Evidence: `app/page.tsx` renders the same static hero + quick links regardless of tenant state (no workspace-count / topology query in the file). Mitigations exist: the onboarding tour auto-opens for new users (`onboarding-tour.tsx:167-178`), `/workspaces` has a real EmptyState + create CTA (`app/workspaces/page.tsx:1226-1237`), and `/setup` self-gates post-install (`app/setup/page.tsx:26-28`). But a user who dismisses the tour on an empty tenant gets a marketing hero, an empty "Recent" row, and a 24-item rail whose setup entry is last.
- Recommendation: on Home, when `/api/workspaces` is empty, swap the Recent section for a "Create your first workspace" EmptyState.
- Effort: S.

### N13 (LOW) — Marketplace concept split across a page, an orphan producer page, and an installable item type
- Evidence: `/marketplace` unified page (`app/marketplace/page.tsx`, tabs Discover/Data products/APIs/Shares/My access per `lib/components/marketplace/loom-marketplace.tsx:10-17,63-74`); `/data-products` producer landing (orphan, N7); AND `data-marketplace` is itself a creatable catalog ITEM TYPE with its own editor (`lib/editors/data-marketplace.tsx`, slug `data-marketplace` in csa-data-products family) whose `DataProductsMarketplace` component the /marketplace page reuses (`loom-marketplace.tsx:30`). "The marketplace" being both a global surface and an item you can create inside a workspace is conceptually confusing.
- Positive: the `/api-marketplace` → `/marketplace?tab=apis` merge is done right (`app/api-marketplace/page.tsx:1-10`).
- Recommendation: link Marketplace → "Publish (Data products)" to `/data-products`; consider retiring the `data-marketplace` item type or renaming it ("Data product exchange view").
- Effort: S.

### N14 (LOW) — Workspace detail lacks the standard rail context; "All workspaces" back-button is the only path
- Evidence: `app/workspaces/[id]/page.tsx:86-90` — back button to `/workspaces`; combined with N5 (no switcher) the deepest, most-used container in the product is 2 clicks from anywhere and switching workspaces always round-trips through the full list page (which is a heavy 1268-line browse surface with tiles/table/filters — `app/workspaces/page.tsx:8-20`).
- Recommendation: covered by N5's switcher; also pin the last workspace into the rail automatically (the dead `recentWorkspaces` store was clearly meant for this).
- Effort: covered by N5.

---

## What's GOOD (keep)

- Single source of truth for nav + Copilot navigate allow-list (`lib/nav/nav-items.ts:1-12`) — prevents drift by construction.
- Command palette covers all nav destinations + admin + "New <type>" verbs + live item search (`command-palette.tsx:66-73,124-137,178-180`).
- Tab strip auto-open policy (workbenches only, LRU cap, stale prune) is genuinely better-thought-out than Fabric's (`tab-strip.tsx:9-26`).
- Redirect discipline on consolidated routes (api-marketplace, catalog/domains, governance/domains, catalog/data-quality, items, experience/warp) — old links never 404.
- Collapsed rail keeps tooltips + aria-labels (`left-nav.tsx:115,121-123`); active state uses `aria-current` (`left-nav.tsx:114`).
- First-run tour auto-opens with an anti-flash localStorage guard (`onboarding-tour.tsx:12-21`).

## Consolidation summary (recommended target rail, ~10 slots)

Home · Create(+) · Browse · Workspaces (switcher flyout) · OneLake catalog (absorbs Unified-catalog scopes) · Real-Time hub (tabs: Streams / Sources / Activator / Business events) · Lineage (absorbs Thread/Federated/Governance-lineage as scopes) · Marketplace · Monitor · Governance — with Data Science/Warp/Workload hub behind an experience switcher, Copilot staying topbar-only, Admin + Setup gated to admins, and Semantic models / Org reports / Data agents / Connections / Deployment demoted to command palette + Browse + workload hub.
