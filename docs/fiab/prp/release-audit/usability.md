# Release Audit — Dimension: Foolproof Usability

Date: 2026-07-02 · Auditor: usability dimension agent · Worktree: `fix-ui-wave2-a`
Scope: `apps/fiab-console` — 15 user flows walked end-to-end in code (UI component → BFF route → backend call), hunting for places a normal user gets stuck, confused, or destroys something.

## Flows sampled

1. New-item create dialog → create → first-open (`lib/components/new-item-dialog.tsx`, `app/items/[type]/[id]/page.tsx`)
2. App install → Phase-2 provision → progress (`lib/components/apps/install-app-dialog.tsx`, `app/api/apps/[id]/install/route.ts`)
3. Connect a data source (`app/connections/page.tsx`, `lib/components/connections/connection-builder.tsx`, `app/api/connections/route.ts`)
4. Run a pipeline (`lib/editors/pipeline-editor-core.tsx`)
5. Share/publish an item (`lib/dialogs/share-item-dialog.tsx`, `lib/editors/item-editor-chrome.tsx`)
6. Delete an item (folders pane + `app/api/workspaces/[id]/items/[itemId]/route.ts`)
7. Delete a workspace — single (`lib/components/workspace-settings-drawer.tsx`, `app/api/workspaces/[id]/route.ts`) and bulk (`app/workspaces/page.tsx`, `app/api/workspaces/bulk-delete/route.ts`)
8. Workspace create + invite member (`app/workspaces/page.tsx`, `lib/panes/manage-access-pane.tsx`)
9. Setup wizard on empty tenant (`app/setup/page.tsx`, `lib/panes/setup-wizard.tsx`)
10. Error states when Azure denies (clientFetch 401 recovery, `lib/api/respond.ts`, editor error surfaces)
11. Long-running provisions + navigate-away (async install jobs, setup deploy poll)
12. Destructive actions without confirmation (repo-wide grep of `confirm(`/`alert(`/DELETE handlers)
13. Forms losing state on tab switch (workspace detail tabs, task-flows autosave, pipeline editor tabs)
14. No-freeform-config sweep (`<Textarea`/`MonacoTextarea` in config contexts)
15. Folder delete / bulk item ops semantics (`lib/panes/folders.tsx`, `app/api/workspaces/[id]/folders/route.ts`)

## Overall read

The console is far better than typical pre-release state: honest MessageBar gates everywhere, an async install-job pattern with a background toast, a type-to-confirm workspace delete, disabled-with-tooltip ribbon actions, and a sophisticated `clientFetch` 401-recovery layer. The traps that remain are concentrated in (a) unsaved-work loss, (b) delete semantics vs. provisioned Azure backing, (c) a handful of one-click destructive actions with swallowed errors, and (d) inconsistent use of native `window.confirm`/`alert` on ~50 destructive/error paths.

---

## Findings (full, uncapped)

### U1 — No unsaved-changes protection anywhere: dirty editors silently lose work (HIGH)
- **Evidence:** `grep -r beforeunload apps/fiab-console` → **zero files**. `lib/editors/notebook-editor.tsx:1018-1028` — the only Ctrl+S handler; there is **no autosave** in the notebook editor (the `if (notebookId && workspaceId && dirty && !saving) save()` at :1023 is inside the Ctrl+S keydown listener). `lib/editors/data-pipeline-editor.tsx:851` guards only its *internal* pipeline switch with `confirm('Discard unsaved changes?')`. `lib/editors/phase3/kql-dashboard-editor.tsx:310,740-745` has `dirty` and Ctrl+S but no nav guard.
- **Trap:** A user edits notebook cells or a pipeline spec, clicks any left-nav link (Next `<Link>` client navigation), or closes the tab — everything since the last manual save is silently discarded. No prompt, no draft, no recovery. Fluent editors show an "unsaved" badge (e.g. `apim-editors.tsx:730`) but nothing intercepts navigation.
- **Fix:** Add a shared `useUnsavedChangesGuard(dirty)` hook: `beforeunload` for browser-level close + a Next.js App Router navigation interception (or at minimum wire it into `ItemEditorChrome` and let editors register their dirty state). Consider debounced autosave for notebook/dashboard (task-flows already autosaves — `lib/panes/task-flows.tsx:218-224` is the in-repo pattern to copy).

### U2 — Deleting workspaces/items never touches the provisioned Azure backing, and the confirm copy oversells (HIGH)
- **Evidence:** `app/api/workspaces/[id]/route.ts:87-101` — DELETE cascades **Cosmos items only** (`items.item(...).delete()` + search doc); no ADLS/ADX/Synapse/EventHubs teardown. `app/api/workspaces/bulk-delete/route.ts:35-36` imports only `cosmos-client` + `loom-search`. Yet the bulk confirm dialog says: *"This permanently deletes the selected workspaces and every item inside them (lakehouses, notebooks, reports, etc.) from Cosmos."* (`app/workspaces/page.tsx:1173-1174`) and the danger-zone drawer says *"removes all items, comments, and shares under it… This cannot be undone."* (`lib/components/workspace-settings-drawer.tsx:191-192`). By contrast the folders-pane item delete is honest: *"Linked back-end resources are not affected."* (`lib/panes/folders.tsx:847-848`).
- **Trap (two-sided):** (1) A user deleting a lakehouse workspace reasonably believes the data is gone — the ADLS Delta files, ADX databases, Synapse DBs, Event Hubs, and Monitor alert rules the provisioners created **remain, keep billing, and retain data** (compliance surprise). (2) Conversely there is *no way* from Loom to actually tear the backing down at delete time — orphaned resources accumulate invisibly.
- **Fix:** (a) Make every delete confirm state explicitly that provisioned Azure resources are retained, and name them (the item `state` carries the provisioned resource ids). (b) Add an opt-in "Also delete provisioned Azure resources" checkbox on workspace/item delete that calls the reverse of the provisioner (or at least emits a receipt listing orphaned resources). (c) Remove "from Cosmos" jargon from end-user copy.

### U3 — Removing a workspace member: one click, no confirmation, errors swallowed (HIGH)
- **Evidence:** `lib/panes/manage-access-pane.tsx:168-176` — `remove()` fires `fetch(..., { method:'DELETE' })` with **no confirm dialog**, **no `res.ok` check**, and no error state; :262-264 the trash `Button` in each row calls it directly.
- **Trap:** A misclick on the trash icon in the access table instantly revokes a member's access — and this pane's backend mirrors **Azure RBAC on the workspace resource group** (per header comment :7-13 and the "Azure RBAC" column). If the DELETE fails (403, transient), the row silently stays and the admin believes access was revoked (or vice-versa on refresh timing) — a security-relevant silent failure.
- **Fix:** Use the same Fluent confirm-dialog pattern as `lib/panes/data-agent.tsx:1018-1046` (target + busy + inline error), check `res.ok`/`j.ok`, and surface failures in a MessageBar.

### U4 — Connection delete: no in-use check, KV secret destroyed, UI swallows failure (HIGH/MEDIUM)
- **Evidence:** `app/api/connections/route.ts:64-75` — DELETE calls `deleteConnection(session, id)` with no referential check against mirrors/linked-services/datasets that reference the connection. UI: `app/connections/page.tsx:117-124` — `remove()` never inspects the response; on failure it just `load()`s and the user gets **zero feedback**. The confirm is a native `confirm()` that does warn "Its Key Vault secret is also removed" but says nothing about dependents.
- **Trap:** Deleting a connection that a mirrored database or ADF linked service depends on silently breaks those items; the failure shows up later as an opaque pipeline/mirror error, far from the cause. And any delete failure is invisible.
- **Fix:** Server: query dependents (connections-store consumers) and return 409 with the dependent list; UI: Fluent dialog listing dependents, check the response, show errors.

### U5 — Connection builder has no "Test connection" and barely validates (MEDIUM)
- **Evidence:** `lib/components/connections/connection-builder.tsx` (whole file, 270 lines) — no test/validate affordance (grep `test|validate|verify` → 0 hits in the component). Submit gate is only `!name.trim() || (secretRequired && !secret)` (:261) — `host` is not required, so a SQL connection with an empty server saves fine.
- **Trap:** A typo'd password/host is stored to Key Vault as if good; the user discovers it only when a downstream mirror/linked service fails with a driver error. Azure portal and Fabric both put "Test connection" on this exact dialog (ui-parity gap too).
- **Fix:** Add a "Test connection" button that POSTs to a `/api/connections/test` route reusing the existing per-type clients (azure-sql-client, kusto-client, adls-client, eventhubs-client already exist per the API inventory); require `host` for hosted types.

### U6 — "New item" from home silently targets an arbitrary workspace; result depends on a race (MEDIUM)
- **Evidence:** `lib/components/new-item-dialog.tsx:253-260` — on open without a `workspaceId` prop it resolves `listWorkspaces()[0]` ("newest") as the create target; :321-344 — if the user clicks an item type **before** that resolution lands (or the tenant has none), `onPick` falls through to `router.push('/items/<slug>/new')` (the editor create-gate) instead. The configure pane (:474-556) shows Name/Runtime/Template — but **never shows which workspace the item will be created in**.
- **Trap:** (1) The same click can produce two different flows depending on network timing. (2) Users with several workspaces create items into whichever workspace happens to sort first and then can't find them where they expected — the classic "where did my item go?" ticket.
- **Fix:** Show (and let the user change) the target workspace in the configure step — a small Dropdown seeded with the resolved default; disable type cards until resolution settles (or treat pending as the /new fallback consistently).

### U7 — ~50 destructive/error paths use native `window.confirm` / `alert` instead of the product's own dialog pattern (MEDIUM)
- **Evidence (sample of ~60 grep hits):** deletes via `confirm()`: `app/connections/page.tsx:118`, `app/admin/domains/page.tsx:144`, `app/governance/policies/page.tsx:388`, `lib/editors/notebook-editor.tsx:1314`, `lib/editors/data-pipeline-editor.tsx:843`, `lib/editors/dataflow-gen2-editor.tsx:248`, `lib/editors/databricks/cluster-editor.tsx:409` ("Permanently delete cluster"), `lib/editors/lakehouse/lakehouse-editor-shell.tsx:849` (DROP SCHEMA … CASCADE), `lib/components/marketplace/api-marketplace.tsx:385` (revokes subscription keys). Errors/success via `alert()`: `lib/components/admin-security/purview-panel.tsx:280,294,471,475` (including success feedback `alert('Run triggered…')`), `lib/components/admin/mcp-catalog-wizard.tsx:402-405`, `app/workloads/page.tsx:202`, `lib/components/realtime-hub/realtime-hub-view.tsx:262-267`.
- **Trap/quality gap:** Native dialogs are unthemed (breaks web3-ui "same product" rule), give no busy state, can't enumerate what's being destroyed, and on some browser configs can be suppressed ("prevent this page from creating additional dialogs") — which turns a guarded delete into an unguarded one. Meanwhile the repo already has excellent patterns (type-to-confirm in `workspace-settings-drawer.tsx:195-206`, list-what-you're-deleting in `app/workspaces/page.tsx:1166-1213`, target+busy+inline-error in `lib/panes/data-agent.tsx:1018-1046`).
- **Fix:** One shared `<ConfirmDialog>` primitive (title, body, danger label, busy, inline error) and a codemod sweep of the `confirm(`/`alert(` call sites. Prioritize the Azure-destructive ones (cluster delete, DROP SCHEMA CASCADE, subscription-key revoke, MCP server teardown).

### U8 — Setup-wizard deploy progress is not survivable: refresh mid-deploy loses the tracking view (MEDIUM)
- **Evidence:** `lib/panes/setup-wizard.tsx:496` — the entire wizard (including `step:'deploying'`, `deploymentId`, workflow-dispatch coords :152-156) lives in a `useState`; grep `localStorage|sessionStorage|resume` in the file → 0 hits. Poll loop at :701-726 dies with the component.
- **Trap:** A landing-zone deploy runs 30+ minutes. If the operator refreshes, closes the tab, or the session redirects (common during first-run auth churn), the wizard restarts at `intro` with no way to re-attach to the in-flight deployment. The deploy itself continues server-side (workflow dispatch), so the operator may even start a *second* one. (Post-install, `/setup` redirects to `/admin/landing-zones` — `app/setup/page.tsx:24-27` — which softens but does not cover the first-run case where no hub exists yet.)
- **Fix:** Persist `{deploymentId, workflowFile, dispatchedAt}` (localStorage or a Cosmos setup-state doc) and re-attach on mount, exactly like the app-install job store (`lib/state/jobs-store.ts`) already does for installs.

### U9 — Session-expiry recovery only exists where `clientFetch` is used; most editors use bare `fetch` (MEDIUM)
- **Evidence:** `lib/client-fetch.ts:57-110` implements the silent-refresh + retry on session-lapse 401s. But grep `clientFetch(` in `lib/editors` → **21 occurrences across 10 of ~95 editor files**; the flagship editors (notebook `:1314ff`, pipeline core `:432`, share dialog `:143,167`, manage-access `:157,171`) all use bare `fetch`.
- **Trap:** After the session cookie lapses mid-edit (long notebook session), Save fails with `{error:'unauthenticated'}` shown as a raw string ("Save failed: unauthenticated") and no recovery — combined with U1, the work may be permanently lost. The next *clientFetch* call would have healed the cookie; the bare-fetch editors never do.
- **Fix:** Alias bare `fetch` to `clientFetch` in editors (it is drop-in per its doc header), or at minimum in every Save path.

### U10 — Editor chrome titles the item by GUID fragment, not its name (LOW/MEDIUM)
- **Evidence:** `lib/editors/item-editor-chrome.tsx:116` — `title = ... : \`${item.displayName} (${id.substring(0, 8)})\`` — the chrome has no prop for the persisted `displayName`.
- **Trap:** After creating "Q3 Sales Lakehouse" the page header reads "Lakehouse (3f2a91bc)". Users identify items by the name they typed; multi-tab work becomes guesswork.
- **Fix:** Accept an optional `displayName` prop (editors already hold the `['item', type, id]` query) and fall back to the current form.

### U11 — Generic fallback editor shows a ribbon of permanently disabled actions (LOW)
- **Evidence:** `app/items/[type]/[id]/page.tsx:31-45` — `genericRibbon` declares `Save`, `Save as`, `Refresh`, `Sensitivity`, `Endorse`, `Recent runs`, `Schedule`, `Commit`, `Update` with **no onClick**; `lib/components/ribbon.tsx:229-236` renders these disabled with a "not wired" tooltip (honest per no-vaporware).
- **Trap:** Low reach (catalog inventory shows only `cross-item-copilot` lacks a registry editor, and it has a dedicated page) — but any registry regression lands users on a surface whose Save/Refresh are disabled with no path forward.
- **Fix:** Replace the dead groups with real generic actions (Refresh = refetch query; Share already works) or drop them from the fallback ribbon.

### U12 — Admin portal nav entry is visible to everyone; non-admins discover their status via per-page 403s (LOW)
- **Evidence:** `lib/nav/nav-items.ts:41` — `{ href: '/admin', label: 'Admin portal' }` with no role gating; admin BFF routes gate via `requireTenantAdmin` → `{ok:false,error:'forbidden'}` 403 (`lib/api/respond.ts:43`), so each admin page fails independently.
- **Trap:** A non-admin clicks "Admin portal" and lands in a shell where every pane errors with "forbidden" — reads as broken, generates support noise.
- **Fix:** Probe `/api/auth/me` admin status once in the shell; either hide the nav entry or render a single friendly "Tenant-admin required — ask <role> to grant you access" gate page.

### U13 — Residual raw-JSON authoring surfaces in config-ish contexts (LOW — triage vs no-freeform rule)
- **Evidence:** `lib/editors/foundry-sub-editors.tsx:2228` — AI Search index schema edited as raw JSON Monaco; `lib/editors/geo-editors.tsx:327` and `lib/editors/phase4/map-editor.tsx:589` — GeoJSON overlay textareas; `lib/editors/pipeline-editor-core.tsx:1051` — pipeline spec JSON Monaco; `lib/editors/graph-editors.tsx:1096` — documents-JSON ingestion box.
- **Assessment:** Most are defensible 1:1 parity (ADF Studio has a JSON view; Azure portal has "Edit JSON (JSON view)" for search indexes) or are *data* input rather than config. The repo has clearly swept this class already (KeyValueGrid replaced the Copilot-channel JSON box — `copilot-studio-editors.tsx:1487-1494`; catalogs at `lib/pipeline/*-catalog.ts` are explicitly typed-forms). Recommend a one-pass triage to tag each surviving raw-JSON surface as "parity view (allowed)" or convert.
- **Fix:** Label the JSON views as secondary ("JSON view" tab next to the designer, as ADF does — pipeline core already does this) and convert the AI Search index schema box to the existing field-grid + JSON-view combo.

### U14 — Bulk item delete in folders pane stops mid-loop on first failure with a single error (LOW)
- **Evidence:** `lib/panes/folders.tsx:387-393` — `for (const id of selected) await deleteWorkspaceItem(...)` inside one try/catch; a failure at item N leaves 1..N-1 deleted, N..end intact, one generic error, selection cleared.
- **Trap:** Partial deletion with no per-item report; user can't tell what survived. (Workspace bulk-delete does this right — it returns `{deleted, failed}` and renders both: `app/workspaces/page.tsx:1150-1163`.)
- **Fix:** Continue-on-error and report per-item outcomes like the workspace bulk-delete result bar.

### U15 — Install flow (positive finding, no action): long-running provisions are handled correctly
- **Evidence:** `app/api/apps/[id]/install/route.ts:7-19` — async job pattern (202 + `AppInstallJob` + floating promise), dialog polls every 5s with real `percentComplete` and states "runs in the background — you can close this dialog and a toast will name…" (`lib/components/apps/install-app-dialog.tsx:367-376`). Per-step remediation semantics documented in `lib/install/provisioning-engine.ts:8-23`.
- This is the pattern U8 (setup wizard) should adopt.

### U16 — Error envelopes are good; a few surfaces still print raw/plumbing strings (LOW)
- **Evidence:** `lib/api/respond.ts:54-59` sanitizes 500s (server-side log, safe public message) — but it is **opt-in** ("the ~1180 existing route.ts files keep their hand-written NextResponse.json") and legacy routes like `app/api/workspaces/[id]/items/[itemId]/route.ts:99,144` return `e?.message` verbatim (Cosmos SDK messages can include request ids/hosts). UI-side, several panels stringify errors into `alert()` (see U7). The 401 story is strong (`client-fetch.ts:72-84` distinguishes session-lapse vs authz 401 to avoid yanking users to sign-in).
- **Fix:** Adopt `apiServerError` in the highest-traffic legacy routes; keep human remediation strings (the `gate`/`missing`/`hint` convention in lakehouse/kql editors is exemplary — `lib/editors/lakehouse/lakehouse-editor-shell.tsx:975-993`).

### U17 — Tab switches: no state loss found in the sampled surfaces (positive)
- **Evidence:** Workspace detail unmounts panes on tab switch (`app/workspaces/[id]/page.tsx:131-132`) but FoldersPane refetches and TaskFlowsPane **autosaves debounced 1.2s** (`lib/panes/task-flows.tsx:218-224`); pipeline editor keeps spec state in the parent across its internal tabs (`pipeline-editor-core.tsx:197-215`). Copilot Studio editors guard list-reload clobbering explicitly (:348, :789).

---

## What was checked and found sound

- **New-item dialog**: real create-then-redirect (no /new 404 class), required-attribute validation, RadioGroup configure step, Labs gating (`new-item-dialog.tsx:273-306,351-455`).
- **Workspace single delete**: type-the-name-to-confirm + dialog (`workspace-settings-drawer.tsx:195-216`) — the best delete UX in the app.
- **Workspace bulk delete**: admin-probed, lists targets, reports failures (`app/workspaces/page.tsx:563-599,1141-1213`).
- **Share dialog**: real Graph search with remediation-carrying errors, DLP-aware disabled states, review step, honest ACL-mirroring caption (`share-item-dialog.tsx` throughout).
- **Pipeline run**: Trigger/Debug disabled until bound + saved, with explanatory tooltips ("Save the spec first") (`pipeline-editor-core.tsx:633-637`).
- **Run-away safety for installs**: async job + toast (U15).
- **401/refresh**: `clientFetch` session-lapse detection is carefully engineered (`client-fetch.ts:63-110`).
- **Folder delete**: children reparent to root — no accidental subtree loss (`app/api/workspaces/[id]/folders/route.ts:5`).
- **Item delete cascade**: paired SQL-endpoint items cascade + lineage edges reconciled (`items/[itemId]/route.ts:115-141`).

## Priority fix order

1. U1 unsaved-changes guard (shared hook + notebook autosave)
2. U3 member-removal confirm + error surfacing
3. U2 delete-semantics disclosure (+ optional Azure teardown)
4. U4 connection in-use check + error surfacing
5. U5 Test connection
6. U6 workspace picker in home create
7. U7 ConfirmDialog primitive sweep
8. U8 setup-deploy re-attach; U9 clientFetch adoption
9. U10-U14, U16 polish items
