# Release audit — dimension: REFACTOR

Date: 2026-07-02 · Scope: `apps/fiab-console/lib` + `apps/fiab-console/app` (branch `feat/loom-marketplace`, worktree `fix-ui-wave2-a`)

## Method

1. `wc -l` sweep of every `.ts/.tsx` under `lib/` + `app/` (2,973 files, 32 MB lib + 12 MB app) to find god-files.
2. Adoption measurement of each shared primitive the repo already ships (`lib/client-fetch.ts`, `lib/api/respond.ts`, `lib/editors/shared-styles.ts`, `lib/components/canvas/canvas-node-kit.tsx`) vs. the raw pattern it replaces.
3. Dead-code scan: extracted all 1,958 distinct import specifiers, membership-checked every `lib/**` module, then hand-verified each zero-reference candidate with direct greps.
4. Status check of the two known deferred refactors (report-routes, content-bundles) and zombie-route sampling.

## Overall assessment

The console has **good primitives and real CI guardrails** (`scripts/ci/check-route-guards.mjs`, `scripts/no-bare-server-fetch.mjs`, circular-dep check) — the *server* side of the fetch/auth story is enforced. The dominant refactor debt is **adoption asymmetry**: canonical helpers exist but the client-side codebase mostly predates them (277 raw-fetch components vs 70 `clientFetch` adopters; 56/1,201 routes on `respond.ts`; 13/290 editors on `shared-styles`). Second tier: a code-splitting defeat in the editor registry (one barrel chunk for 14 editors, ~20k lines), the two acknowledged-deferred refactors (report god-routes, 3.1 MB statically-imported content bundles), duplicated SQL-quoting helpers (security-adjacent), and ~1.4k lines of verified dead code. Nothing here is release-embarrassing by itself; several items are cheap and high-leverage.

---

## Findings (ranked by risk-reduction per effort)

### R1 — clientFetch adoption gap: 277 client components still use raw `fetch` (HIGH · effort L, codemod-able)

`lib/client-fetch.ts` is the canonical browser→BFF transport: 6s timeout (`client-fetch.ts:34`), sliding-session 401→`/api/auth/refresh`→retry (`client-fetch.ts:63-110`), thundering-herd dedupe, top-level reauth. Adoption:

- Files importing `clientFetch`: **70**
- Client `.tsx` files calling raw `fetch('/api…')`: **278**, of which **277 do not import clientFetch at all**
- Call-site level inside `lib/editors` alone: **1,087 raw `fetch(` vs 25 `clientFetch(`**

Concrete example: `lib/panes/data-agent.tsx:481` (`fetch('/api/workspaces')`) and `:497` (`fetch('/api/items/data-agent', …)`).

Consequence: any surface on raw fetch (a) can pin a spinner forever on a stalled route — the exact defect class `client-fetch.ts:5-12` documents — and (b) gets **no sliding-session recovery**, so after the `loom_session` cookie lapses mid-session, hundreds of surfaces show raw `unauthenticated` errors instead of silently refreshing; behavior differs page-to-page depending on which fetch idiom that page happens to use. The server half is CI-enforced (`scripts/no-bare-server-fetch.mjs:1-24` guards `lib/azure/**`); the client half has **no guard**, so drift will continue.

**Recommendation:** codemod `lib/editors/**`, `lib/panes/**`, `lib/components/**`, `app/**/page.tsx` raw `/api` fetches → `clientFetch`, then add a `no-bare-client-fetch.mjs` CI guard mirroring the server one (allowlist SSE/streaming call sites that legitimately need an unbounded read).

### R2 — Editor registry dynamic-imports the phase3 BARREL: one ~20k-line chunk for 14 item types (HIGH · effort S)

`lib/editors/registry.ts` code-splits per editor via `dynamic(() => import(...))` — but 14 slugs all point at the barrel:

- `lib/editors/registry.ts:83-99` — `'eventhouse' | 'kql-database' | 'kql-queryset' | 'kql-dashboard' | 'eventstream' | 'activator' | 'warehouse' | 'datamart' | 'semantic-model' | 'report' | 'dashboard' | 'paginated-report' | 'scorecard' | 'workspace-monitor'` → `reg(() => import('./phase3-editors'), …)`
- `lib/editors/phase3-editors.tsx:25-57` statically re-exports every `./phase3/*` editor, so the chunk contains **all** of `lib/editors/phase3/` — **20,445 lines** (`wc -l lib/editors/phase3/*`), including `semantic-model-editor.tsx` (3,801), `eventhouse-editor.tsx` (2,575), `kql-database-editor.tsx` (2,190), `eventstream-editor.tsx` (2,033).

Opening ONE kql-database editor downloads/parses the entire Real-Time-Intelligence + Power-BI family. The 07-01 barrel-split refactor moved code into `phase3/` per-file but the registry still routes through the barrel, so the code-splitting benefit of the split was never realized. Same class at smaller scale: 8 slugs → `./foundry-sub-editors` (3,081 lines), 3 → `./apim-editors` (3,421), 6+ → `./powerplatform-editors` (2,358), `./azure-services-editors` (1,616), `./copilot-studio-editors` (1,937).

**Recommendation:** point each registry entry at its per-file module (`import('./phase3/kql-database-editor')`); keep the barrel only for tests/back-compat re-export. One-file change per entry, zero behavior change, immediate bundle win.

### R3 — content-bundles: 3.1 MB of TS statically imported into the server graph (deferred refactor, still open) (MEDIUM-HIGH · effort M)

`lib/apps/content-bundles/` is **3.1 MB / ~37k lines** of notebook/report/pipeline payload encoded as TypeScript string literals — `app-supercharge-gold.ts` alone is **6,054 lines / 731 KB**, `app-supercharge-silver.ts` 5,229, `app-supercharge-bronze.ts` 4,145. `lib/apps/content-bundles/index.ts:16-44` statically imports every bundle (`index.ts:40` `import superchargeGold from './app-supercharge-gold'`), and `app/api/apps-catalog/route.ts:12` + `app/api/apps/[id]/install/route.ts:47` pull the whole registry — so listing the app catalog materializes all 30 bundles in memory. This is one of the two refactors the 07-01 session explicitly deferred; it is a prime contributor to the build-OOM history (`apps/fiab-console/Dockerfile:34` — `ENV NODE_OPTIONS=--max-old-space-size=6144`) and to `tsc` cost on every CI run. The metadata split already exists (`lib/apps/content-bundles/catalog-meta.ts` — catalog route can render from meta alone).

**Recommendation:** convert bundle payloads to JSON assets (or per-bundle `await import()` in `getBundle`), keep `catalog-meta.ts` as the eager surface. `apps-catalog` (`route.ts:88-91`) iterates `getBundle(appId)` only to enumerate items — precompute item summaries into meta so the list path never loads payloads.

### R4 — Report god-routes (the other deferred refactor, still open) (MEDIUM · effort M-L)

39 `route.ts` files under `app/api/items/report|paginated-report`. The four biggest are genuine god-routes:

- `app/api/items/report/[id]/query/route.ts` — **1,209 lines**; the header (`route.ts:1-60`) documents THREE dispatched execution backends (Power BI executeQueries / AAS XMLA / Loom-native wells→SQL) plus the Wave-1 well-fold + filter-channel contract, all in one file.
- `app/api/items/report/[id]/connector-objects/route.ts` — 1,053 lines
- `app/api/items/report/[id]/script-visual/route.ts` — 811 lines
- `app/api/items/report/[id]/fields/route.ts` — 618 lines
- Sibling: `app/api/items/semantic-model/[id]/model/route.ts` — **1,357 lines**, serves two distinct editor surfaces + aggregations by dispatching on request body shape (`route.ts:1-44`: "It serves TWO complementary editor surfaces over ONE route (the BFF dispatches on request shape)").

Shared resolution already exists (`lib/azure/report-model-resolver.ts`, imported by 11 routes) — the remaining work is extracting the per-backend executors out of `query/route.ts` into `lib/report/` modules and splitting `model/route.ts`'s A/B/C concerns into sub-routes. These files are where the hardest report bugs will land post-release; 1,200-line multi-backend handlers are the highest-friction code to patch safely.

### R5 — SQL identifier/literal escaping re-implemented 7+/59 times (MEDIUM, security-adjacent · effort M)

`quoteIdent` has at least **7 independent implementations**: the canonical exported one at `lib/azure/wells-to-sql.ts:347`, plus private copies at `lib/azure/report-accel-client.ts:267`, `lib/azure/report-model-resolver.ts:1047`, `lib/install/provisioners/warehouse.ts:297`, `app/api/items/azure-sql-database/[id]/search-management/route.ts:46`, `app/api/items/[type]/[id]/ai-function/route.ts:64`, `app/api/items/[type]/[id]/visual-query/route.ts:60`. Inline single-quote-doubling (`.replace(/'/g, "''")`) appears at **95 call sites across 59 files** (e.g. `lib/azure/adf-client.ts:446`, `lib/azure/access-policy-client.ts:76`, `lib/azure/databricks-client.ts:1776`, `lib/azure/copilot-studio-client.ts:740`). Injection-safety currently depends on 59 files each getting a one-liner right, and a fix to any quoting bug must be discovered N times. **Recommendation:** one `lib/sql/quoting.ts` (ident + literal, per dialect: T-SQL / KQL / Databricks / OData), migrate call sites, add a CI grep forbidding new inline `replace(/'/g, "''")` in `lib/azure` + `app/api`.

### R6 — Three generations of BFF error helper coexist (MEDIUM · effort M, mechanical)

- Canonical: `lib/api/respond.ts` (`apiOk/apiError/apiServerError`, safe-500 that never leaks internals) — imported by **56 of 1,201** route files; `respond.ts:12-15` documents the opt-in-no-codemod decision ("the ~1180 existing route.ts files keep their hand-written NextResponse.json").
- Middle generation: `jerr` in `app/api/items/_lib/item-crud.ts:63` — 74 files.
- Legacy: **123 route files** define a local `function err(...)`/`jsonError` (e.g. `app/api/admin/workspaces/[id]/route.ts:25`, `app/api/cosmos-items/[type]/route.ts:24`, `app/api/data-products/import/route.ts:42`), and 1,169 files call `NextResponse.json` directly.

Consequence: envelope/status consistency and — more importantly — the safe-500 behavior of `apiServerError` (`respond.ts:54-58`) are only guaranteed on 5% of routes; ~32 routes return raw `e.message` on 500 (e.g. `app/api/admin/scaling/utilization/route.ts:103`). Not proposing a bulk rewrite of 1,201 files; **do** migrate the 123 local-`err` files (drop-in) and alias `jerr` to `apiError`, then add an ESLint rule banning new local error helpers.

### R7 — Verified dead code: 7 never-imported modules (~1,263 lines) + a dead legacy component + a zombie route (MEDIUM · effort S)

Zero import references anywhere in `lib/` + `app/` (membership-checked against all 1,958 import specifiers, then re-verified with direct whole-tree greps):

| File | Lines | Note |
|---|---|---|
| `lib/components/admin/mcp-catalog-panel.tsx` | 593 | superseded by `lib/components/admin/mcp-servers-panel.tsx` (1,637 lines, live) |
| `lib/panes/workspace-agent-config-dialog.tsx` | 213 | |
| `lib/data-products/data-product-details.tsx` | 185 | live one is `lib/editors/data-product-detail.tsx` |
| `lib/stores/tabs.ts` | 92 | entire `lib/stores/` dir is dead |
| `lib/theme/loom-tokens.ts` | 82 | |
| `lib/components/admin-gate.tsx` | 54 | |
| `lib/stores/ui.ts` | 44 | |

Plus: `_LoomNativeReportViewer_legacy` at `lib/editors/phase3/report-editor.tsx:1148-1272` (~125 lines, explicitly commented "Legacy read-only viewer pieces … retained above for reference"; nothing references it), and zombie route `app/api/data-agent/chat/route.ts` — an honest-503 deprecation stub whose only would-be caller (`lib/panes/data-agent.tsx`) now calls `/api/items/data-agent` (`data-agent.tsx:497`); no file references `data-agent/chat`. Dead code in a *public* release is where stale patterns get copied from; delete all of it in one PR.

### R8 — shared-styles adopted by 13 of 290 editors; the duplication it targets persists at ~48 copies (MEDIUM · effort M, zero-risk mechanical)

`lib/editors/shared-styles.ts:6-8` says the ~13 shared classes exist because "40+ editors were each re-declaring verbatim". Current state: **13** editor files import it; **48** still re-declare the `toolbar: { display: 'flex'…}` block, **36** re-declare `pad: { padding…}`, **25** re-declare the Consolas/"Cascadia Code" monaco-textarea style. Each future design-token change (web3-ui.md sweeps happen regularly per the dev log) must be repeated ~48×. The composition pattern already exists (`lib/editors/phase3/styles.ts:1-10` composes shared-styles); finish the migration mechanically.

### R9 — Editor-component god-files: 4 files ≥ 3,400 lines (MEDIUM · effort L each)

- `lib/editors/lakehouse/lakehouse-editor-shell.tsx` — **4,980 lines**. The 07-01 "split" (`lib/editors/lakehouse-editor.tsx:4-11`, now a 14-line barrel) was a verbatim move: shared helpers went to `lakehouse/shared.tsx` (200 lines) but the shell kept everything else — tabs, dialogs, uploads, SQL pane, maintenance — in one component file.
- `lib/editors/report-designer.tsx` — **4,809 lines** (pages rail + canvas + wells + gallery + format pane in one file; satellites exist under `lib/editors/report/` so the split pattern is established).
- `lib/editors/phase3/semantic-model-editor.tsx` — **3,801 lines**.
- `lib/editors/apim-editors.tsx` — **3,421 lines / 4 exported editors** in one file.

These are the highest-churn UI surfaces (report designer waves, lakehouse features land continuously). Split along the tab/pane seams that already exist visually. Not release-blocking, but each is a merge-conflict magnet for post-release contributors.

### R10 — Two competing client data-fetch idioms: react-query (29 files) vs hand-rolled effect+state (~100 editors) (LOW-MEDIUM · effort L)

`@tanstack/react-query` is a dependency (`package.json:39`) and used well in newer editors (`lib/editors/phase4/*`, `lib/editors/lakehouse/lakehouse-editor-shell.tsx:22`), but ~100 editor files hand-roll `useEffect` + `setLoading/setBusy` + `.catch` state machines for the same job. New contributors get no signal which idiom is canonical. Cheap first step: document the choice (react-query + `clientFetch` as `queryFn`) in `lib/editors/README` / CLAUDE.md and require it for new editors; migrate opportunistically.

### R11 — 14 bespoke wizard steppers; `lib/components/wizard/` contains no wizard shell (LOW-MEDIUM · effort M)

14 components each own a `const [step, setStep] = useState(...)` stepper with hand-built back/next/validation plumbing (`lib/components/pipeline/dataset-wizard.tsx:619`, `lib/components/cosmos/cosmos-container-wizard.tsx:81`, `lib/components/onelake/shortcut-wizard.tsx:248`, `lib/data-products/data-product-create-wizard.tsx:102`, `lib/editors/components/load-to-table-wizard.tsx:99`, …). The shared dir `lib/components/wizard/` holds only `custom-attributes-form.tsx`. Given no-freeform-config.md makes wizards the mandated config surface, a `WizardShell` primitive (steps, progress, back/next gating, dialog chrome) would pay for itself on the next wizard and standardize keyboard/a11y behavior.

### R12 — `lib/editors` organizational scheme is three-way inconsistent (LOW · effort M, mostly renames)

69 root-level `.tsx` files + domain folders (`lakehouse/`, `databricks/`, `report/`, `palantir/`, `slate/`, `workshop/`) + **development-phase** folders (`phase3/`, `phase4/`) coexist. "phase3/phase4" names are meaningless to an external contributor (phase3 = RTI + Power BI, phase4 = Fabric-IQ — pure internal history). Rename to domain names (`rti/`, `bi/`, `iq/`) and fold the root multi-editor family files (`apim-editors`, `foundry-sub-editors`, `powerplatform-editors`, `copilot-studio-editors`, `azure-services-editors`, `azure-sql-editors`) into per-domain folders when R2 touches the registry anyway. Cosmetic-adjacent, but it is the first thing a public contributor sees.

---

## Explicitly NOT findings

- `lib/azure` (257 modules): well-factored — 103 modules use the shared `getArmToken/armFetch/fetchWithTimeout` helpers; only 5 hard-code `management.azure.com` (cloud-endpoints indirection is real). `aas-client.ts` (2,913) already has satellite modules (aas-dax/tmsl/roles/xmla).
- `canvas-node-kit` adoption is healthy: 30 importers; only ~5 product surfaces still on raw `@xyflow/react` (`lib/components/deploy-planner/deploy-planner-view.tsx`, `lib/components/eventstream/visual-designer.tsx`, `lib/editors/mounted-adf-editor.tsx`, `app/thread/page.tsx`, `app/workspaces/[id]/page.tsx`).
- Datamart is correctly deprecated, not zombie: `lib/catalog/item-types/data-warehouse.ts:49-53` marks `deprecated: true` migration-template; `app/api/items/datamart/migrate/route.ts` is live and referenced.
- Route auth boilerplate: already consolidated (`loadOwnedItem`/`requireTenantAdmin`) and **CI-enforced** by `scripts/ci/check-route-guards.mjs` — no refactor needed.
- `lib/editors/warehouse-editor.tsx` (root) vs `phase3/warehouse-editor.tsx` is NOT a duplicate — root file is the Copilot bridge hook (`warehouse-editor.tsx:3-20`).
- TODO/FIXME hygiene is good: 31 total across lib+app, mostly intentional operator-facing TODO emissions in generated bicep/SQL.
- `app/api/items/sql-server-2025-vector-index/route.ts` looked orphaned in the static scan but is reachable via the generic `/api/items/${type}` template-literal path — not flagged.

## Suggested sequencing

1. **PR-sized quick wins (days):** R2 (registry per-file imports), R7 (dead-code deletion), zombie route removal.
2. **Codemod wave (1-2 weeks):** R1 (clientFetch + CI guard), R6 (err-helper migration), R8 (shared-styles migration).
3. **Structural (post-release acceptable but schedule):** R3 (content-bundles → lazy JSON), R4 (report route split), R5 (quoting module), R9 (god-editor splits), R11/R12.
