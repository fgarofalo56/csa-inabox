# Page-error static audit — "some pages open with an error / fail to load"

Date: 2026-07-24 · Scope: `apps/fiab-console/app/**/page.tsx` (132 pages) + their client components · Method: static sweep, evidence-grounded (file:line for every claim). Working tree = `main` @ fb3e0aac.

## TL;DR

The console's per-surface code is unusually defensive — every recently-shipped Phase-3/4 + §P2 surface I checked (finops, copilot-quality, migrate, streaming-sql, sql-lab, incident-console, code-report, admin/catalog-iceberg, health tabs) renders honest gates and error MessageBars. The load-failure exposure is **structural, not per-page**:

1. **Zero `error.tsx` / `loading.tsx` / `global-error.tsx` anywhere** (132 routes) — the only safety net is one client `GlobalErrorBoundary` that wraps page children **but not the shell chrome around them** (CommandPalette, CopilotPane, ObjectExplorer, nav, providers). A crash in any of those takes down **every page** to Next's raw production error screen.
2. **No deploy-skew protection** — no `deploymentId`, no ChunkLoadError recovery. With multiple ACA revision rolls per day, a browser that was open across a roll can 404 on old route chunks during client-side navigation → "page fails to load" until hard refresh. This is my #1 candidate for what the operator hit.
3. The **`useRuntimeFlag`-outside-provider crash class is FIXED** (commit 5ae70a8d, merged to main inside #2523/d713354e) and I found **no remaining in-app instance** of that class — the app QueryClientProvider wraps the entire tree (`app/layout.tsx:17` → `app/providers.tsx:33`).
4. A handful of surfaces have **silent-failure states** (error rendered as 0-count/healthy/blank) — the "renders fine with dead data path" class from the 2026-07-15 G1 incident, not crash-on-open.
5. **RUM client-error ingestion + reader is ALREADY-BUILT** — `/admin/rum` reads `AppExceptions` grouped by page surface; exact KQL + CLI below to pull the live top-error pages post-roll.

---

## Global architecture findings (affect all 132 pages)

### G-1 · REAL-GAP (HIGH) — no App Router error/loading boundaries at all

Evidence:
- `find app -name "error.tsx"` → **0**; `find app -name "loading.tsx"` → **0**; no `app/global-error.tsx`. Only `app/not-found.tsx` exists (`apps/fiab-console/app/` listing).
- The only render-error net is the client class boundary `GlobalErrorBoundary` (`apps/fiab-console/lib/components/error-boundary.tsx:66-96`) mounted at `apps/fiab-console/lib/components/app-shell.tsx:281` — around `{children}` only.
- Mounted **outside** that boundary, on every page: `TenantThemeBridge` (`app/layout.tsx:18`), the entire nav shell, and `CommandPalette` / `CopilotPane` / `ObjectExplorer` / `FeedbackWidget` / `GlobalJobToaster` / `OnboardingTour` (`app-shell.tsx:283-289`). A render throw in any of these → **no boundary anywhere** → Next's default production error page ("Application error: a client-side exception has occurred") on every route.

Consequences:
- Server-component throw (none currently reachable — see G-4) or any client crash outside the boundary = raw Next error page, no Loom styling, no retry, no auto-report.
- No `loading.tsx` anywhere: the two `force-dynamic` async server pages (`/setup`, `/admin/health`) block TTFB on Cosmos with no skeleton.

Fix: add `app/error.tsx` (Fluent-styled, wired to the existing `autoReport()` in `error-boundary.tsx:24`), `app/global-error.tsx`, and `loading.tsx` for `/setup` + `/admin/health`. Cheap, one PR.

### G-2 · REAL-GAP (HIGH — top candidate for the operator's report) — deploy-skew / stale-chunk failures after revision rolls

Evidence:
- No `deploymentId` in `apps/fiab-console/next.config.mjs` (grep: no match) — Next.js skew protection is off.
- No `ChunkLoadError` handling anywhere (`grep -rn "ChunkLoadError"` over app/lib/next.config → 0 hits). `GlobalErrorBoundary` (`error-boundary.tsx:66-96`) treats a chunk 404 like any render error: it shows "Something went wrong." with a **Try again** button that just re-renders — which re-requests the same dead chunk URL, so retry loops.
- `next.config.mjs:37-48`: HTML is `no-cache/no-store` (good — fixes stale shells), but `_next/static` is deliberately exempted; hashed chunk URLs from the **previous** image 404 on the new revision's origin once Front Door's copy expires or on a cold path.
- Operating reality: multiple image rolls per day (memory: workflow_dispatch rolls, Phase-4 waves). Any tab open across a roll that then client-side-navigates to a route whose JS chunk isn't cached → failed dynamic import.

Symptom exactly matches "SOME pages open with an error / fail to load": the pages that fail are whichever routes the user hadn't visited yet in that tab; a hard refresh fixes it; it's non-deterministic across users.

Fix (either/both):
1. Set a stable `deploymentId` per build (Next `deploymentId` + `NEXT_DEPLOYMENT_ID`) so skew is detected and Next hard-navigates instead of throwing.
2. In `GlobalErrorBoundary.componentDidCatch`, detect `err.name === 'ChunkLoadError'` / `/Loading chunk .* failed|Failed to fetch dynamically imported module/` and do a **one-shot `window.location.reload()`** (sessionStorage guard against loops) instead of rendering the error card.

### G-3 · ALREADY-BUILT (fixed today) — the `useRuntimeFlag` provider-crash class

- Fix: `use-runtime-flag.ts` now falls back to a lazy local `QueryClient` when mounted outside the app provider (`apps/fiab-console/lib/components/ui/use-runtime-flag.ts:30-40`; commit 5ae70a8d, merged to main via #2523 d713354e — `git log main -- …/use-runtime-flag.ts`).
- Remaining exposure from this class: **none found in-app**. `QueryClientProvider` wraps everything (`app/providers.tsx:33-41`; `app/layout.tsx:17-20`), and a sweep of every `useQuery`/`useQueryClient` consumer (29 files) found all mounted under the root tree. The other throw-if-no-provider hook, `useLakehouseCtx` (`lib/editors/lakehouse/lakehouse-editor-context.tsx:435`), is only consumed by lakehouse panes rendered inside its own provider. `useTheme` has a safe default context (`lib/theme/theme-context.tsx:22-23`).

### G-4 · ALREADY-BUILT (safe) — server components awaiting backends

Only **2** of 132 pages are async server components (grep `export default async function` over `app/**/page.tsx`):
- `/admin/health` — `app/admin/health/page.tsx:7-20` awaits 5× `runtimeFlag()`; `runtimeFlag` is fail-open by design (`lib/admin/runtime-flags.ts:532-548` — try/catch returns default; unreadable Cosmos can never throw to the page).
- `/setup` — `app/setup/page.tsx:24-28` awaits `getTenantTopologySafe()`, which catches everything and falls back to env-derived topology (`lib/setup/tenant-topology.ts:154-169`).

Neither can throw to an (absent) error boundary. Residual: both are `force-dynamic` with no `loading.tsx`, so a slow Cosmos read = blank tab during TTFB (see G-1). The other 39 server pages are thin static wrappers around `'use client'` panes (verified list — e.g. `app/admin/incident-console/page.tsx`, `app/admin/copilot-quality/page.tsx:18` is sync).

---

## Ranked per-page findings

Ranked by likelihood the operator hit it ("opens with an error / fails to load").

| # | Page / surface | Risk class | Evidence (file:line) | Verdict | Suggested fix |
|---|---|---|---|---|---|
| 1 | **ANY page navigated after an image roll** | (d)+chunk-skew: dynamic-import 404 → error card / raw error, Try-again loops | `next.config.mjs` (no `deploymentId`); `error-boundary.tsx:66-96` (no ChunkLoadError branch); `next.config.mjs:37-48` | **REAL-GAP** | G-2 fix: `deploymentId` + one-shot reload on ChunkLoadError |
| 2 | **ALL 132 routes** | (d) zero `error.tsx`/`loading.tsx`; shell chrome outside the only boundary | 0 boundary files; `app-shell.tsx:281-289`; `app/layout.tsx:17-20` | **REAL-GAP** | G-1 fix: add `app/error.tsx` + `global-error.tsx` + targeted `loading.tsx` |
| 3 | `/admin/rum` | (c) `useQuery` **isError never rendered**: a `clientFetch` throw (20s timeout `client-fetch.ts:44`, network) → toolbar renders, body silently blank. Separately, LOW-gate 503 renders a **warning** MessageBar (honest) | `lib/components/admin/rum-panel.tsx:153` destructures only `{data, isLoading}`; renders `isLoading`:198, `data?.gate`:206, `data?.error`:214 — no `isError` branch; queryFn `fetchRum` returns structured errors for HTTP but **throws** on transport (`clientFetch` at :138 can reject) | **REAL-GAP** (blank), **OPERATOR-GATED** (503 gate needs `LOOM_LOG_ANALYTICS_WORKSPACE_ID` + Log Analytics Reader — `app/api/admin/rum/route.ts:206-215`) | catch transport errors into the same `FetchState.error` shape, or render `q.isError` |
| 4 | `/admin/incident-console` | (c-silent) transport failure masked as **healthy**: `getJson` merges `_status` but a thrown `clientFetch` → `isError` (unrendered) → `incidents=[]` → "No incidents — all monitored tables are healthy" EmptyState. Error shown as success | `lib/panes/incident-console.tsx:95-99` (getJson), :120-121 (`listQ.data?.incidents \|\| []`), :198-206 (loading→Spinner, empty→healthy EmptyState; no isError branch) | **REAL-GAP** (misleading, the G1 "0-count" class) | render `listQ.isError` as an error MessageBar before the empty state |
| 5 | `/browse` | (c-silent) `.catch(() => setWorkspaces([]))` → page renders with 0 workspaces when `/api/workspaces` fails — dead data path looks fine | `app/browse/page.tsx:145-152` | **REAL-GAP** (0-count class; exact class of the 2026-07-15 live incident per `ux-standards` §9 G1) | keep an `error` state + MessageBar |
| 6 | `/workload-hub` | (c-silent) `.catch(() => setCatalog([]))` — catalog overlay failure renders as an empty hub | `app/workload-hub/page.tsx:178`, loading gate :341 | **REAL-GAP** (silent) | error state |
| 7 | `/apps` | (c-silent) `.catch(() => setApps([]))` | `app/apps/page.tsx:167` | **REAL-GAP** (silent) | error state |
| 8 | **AskAffordance** (embedded on many data surfaces) | (c) `await postAsk()` with **no try/catch**: `clientFetch` rejects on 20s timeout/network → `loading` stuck true (input disabled, ghost turn bubble) + unhandled rejection (fires RUM error beacon + auto-report) | `lib/components/ask/AskAffordance.tsx:273` (`setLoading(true)`), :279 (`await postAsk` un-tried); `postAsk` → `clientFetch` :183; timeout throw `lib/client-fetch.ts:321-323` | **REAL-GAP** (interaction-time, not page-open) | wrap submit body in try/finally, surface error as a gate |
| 9 | `/items/s3-gateway/[id]` (N8 Preview lab) | (c) `useQuery` isError never rendered — queryFn throws on `!res.ok` → editor body silently blank below toolbar | `lib/editors/s3-gateway-editor.tsx:83` (throw), :92-97 (useQuery), :134 (only `q.isLoading` rendered; zero error refs in file — the only such file in the repo-wide scan) | **REAL-GAP** (low traffic) | add error MessageBar |
| 10 | `/admin/health` | (a) async server page awaiting Cosmos flags; blank TTFB, no skeleton | `app/admin/health/page.tsx:7-20`; fail-open `lib/admin/runtime-flags.ts:536-547` | **ALREADY-BUILT** (safe) — residual is G-1 loading.tsx | add `loading.tsx` |
| 11 | `/setup` | (a) async server page; fully caught | `app/setup/page.tsx:24-28`; `lib/setup/tenant-topology.ts:154-169` | **ALREADY-BUILT** | — |
| 12 | `/admin/finops` | audited: useQuery + explicit err MessageBar; flag-off pointer state | `app/admin/finops/page.tsx:128` (structured err), :166 (error MessageBar) | **ALREADY-BUILT** | — |
| 13 | `/admin/copilot-quality` | audited: `summaries.isError` → error MessageBar; flag-off notice; Skeleton | `lib/components/admin/copilot-quality-panel.tsx:183-188`, :197-202, :255 | **ALREADY-BUILT** | — |
| 14 | `/admin/migrate` (M1/M2/M3) | audited: every fetch try/caught into `state.error` → error MessageBar; 503 flag-off honest | `app/admin/migrate/page.tsx:122-124`, :217-219; `translate-panel` + copy-in :369-376, :414-416 | **ALREADY-BUILT** | — |
| 15 | `/items/streaming-sql/[id]` | audited: statusQ + run/query/materialize all caught; honest gate EmptyState when `LOOM_RISINGWAVE_URL` unset | `lib/editors/streaming-sql-editor.tsx:166`, :181-210, :244, :327, :363 | **ALREADY-BUILT** / **OPERATOR-GATED** (RisingWave env) | — |
| 16 | `/items/sql-lab/[id]` | audited: capsQ caught, per-action errors rendered, honest Synapse fallback | `lib/editors/sql-lab-editor.tsx:190`, :209-240, :465, :491, :519 | **ALREADY-BUILT** | — |
| 17 | `/admin/catalog` (Iceberg REST catalog) | audited: queryFn throws → error MessageBars rendered; EmptyState | `app/admin/catalog/page.tsx:129-131`, :223, :239, :300-303 | **ALREADY-BUILT** | — |
| 18 | `code-report` / `metrics` (N16/N15) | no dedicated page routes — API-only (`app/api/items/code-report/**`, `POST /api/metrics/query`); render/validate 503 flag-gates are honest | flag registry `lib/admin/runtime-flags.ts:378-384`, :354-360 | **ALREADY-BUILT** | — |
| 19 | `/assets` | audited: graph.isError → error MessageBar; canvas flag fallback | `app/assets/page.tsx:292-302` | **ALREADY-BUILT** | — |
| 20 | `/governance/data-contracts`, `/admin/scaling`, `/external-shares/received`, `/admin/api-management` | audited: structured fetch helpers that never throw + error/gate rendering | `data-contracts/page.tsx:295-299`; `scaling/page.tsx:718-882` (per-service gates); `received-shares-view.tsx:19-26`; `client-fetch.ts:1-30` (the systemic no-timeout fix docs) | **ALREADY-BUILT** | — |

### Honest-gate pages that "open with an error"-looking state by design (OPERATOR-GATED, not bugs)

If the operator's report includes surfaces showing a red/yellow bar on open, these are honest env gates, not load failures:
- `/admin/rum` → 503 gate until `LOOM_LOG_ANALYTICS_WORKSPACE_ID` + Log Analytics Reader (`app/api/admin/rum/route.ts:206-215`).
- `/items/streaming-sql/*` → gate until `LOOM_RISINGWAVE_URL` (`runtime-flags.ts:330-336` description; editor EmptyState).
- `/items/s3-gateway/*`, ducklake → gates on `LOOM_S3_GATEWAY_URL` / `LOOM_DUCKLAKE_CATALOG_URL` (`runtime-flags.ts:435-448`).
- Any admin page behind `withTenantAdmin` opened by a non-admin → 401/403 body (authz, expected).
- Per `ux-baseline.md` G2, bare gates without a Fix-it button are themselves non-compliant — several of the above render plain MessageBars (separate G2 follow-up, out of scope here).

---

## RUM: pulling the live top-error pages post-roll (ALREADY-BUILT)

The pipeline exists end-to-end; use it to convert this static ranking into the operator's actual hit list:

1. **Capture** (every page): `RumTelemetry` mounted in `app/providers.tsx:38`; `window 'error'` + `'unhandledrejection'` listeners, deduped, ≤ cap per session (`lib/telemetry/rum.ts:198-254`). Gated by `LOOM_RUM_ENABLED` ≠ 'false' + `APPLICATIONINSIGHTS_CONNECTION_STRING` + `rum1-client-telemetry` flag + `LOOM_RUM_SAMPLE_RATE` (`lib/telemetry/rum-ingest.ts:67-76`).
2. **Ingest**: beacons → `POST {IngestionEndpoint}/v2.1/track` with `ai.cloud.role='loom-console-browser'` and a scrubbed `csa-loom.surface` route-shape property; errors land in LAW table **`AppExceptions`** (`lib/telemetry/rum-ingest.ts:17-26`, :163).
3. **Reader UI**: `/admin/rum` → Errors card = top 25 client errors by type/message/**surface**, windows P1D/P3D/P7D (`lib/components/admin/rum-panel.tsx`; query at `app/api/admin/rum/route.ts:110-115`).
4. **Reader API**: `GET /api/admin/rum?window=P1D` (tenant-admin session) → `rum.errors[]` (`route.ts:188-204`; 5-min cache, serve-stale).
5. **Raw KQL** (exactly what the route runs — `queryLogs` in `lib/azure/monitor-client.ts:600`):

```kusto
AppExceptions
| where AppRoleName == 'loom-console-browser'
| summarize count_ = count(), lastSeen = max(TimeGenerated)
    by type = tostring(ExceptionType), message = tostring(OuterMessage),
       surface = tostring(Properties['csa-loom.surface'])
| order by count_ desc | take 25
```

CLI: `az monitor log-analytics query -w "$LOOM_LOG_ANALYTICS_WORKSPACE_ID" --analytics-query "<above>" -t P1D`. Post-roll triage: run with `-t PT2H` right after a roll; a spike of `ChunkLoadError` / `TypeError: Failed to fetch dynamically imported module` confirms finding #1; the `surface` column names the exact pages the operator hit.

6. **Second funnel**: render crashes caught by `GlobalErrorBoundary` ALSO auto-file redacted issues via `POST /api/feedback` kind `auto-error`, deduped, ≤5/session (`lib/components/error-boundary.tsx:24-52`; `app/api/feedback/route.ts:104` builds `[auto-error] …` issue titles) — check the feedback issue queue for titles beginning `[render]`, `[window]`, `[unhandledrejection]`.

Caveat: chunk-skew failures during a **hard** page load can fail before RUM's listeners mount; the boundary/issue funnel and FD/ACA access logs (404s on `/_next/static/chunks/*`) are the complementary signals.

---

## Method / coverage notes

- 132 `page.tsx` inventoried; 41 server components (all read, only 2 async), 91 client pages.
- Systematic scans: `export default async function` (2 hits); `setLoading(true)` without reset/finally (7 files → 2 real: AskAffordance, plus reviewed-safe fetchJson wrappers); `useQuery` consumers with zero error references (1 hit: s3-gateway-editor); `throw new Error` in client render paths (all inside queryFns/mutations); `must be used within` context throws (1: lakehouse, provider-local); boundary files (0).
- NOT verified live (static audit only): actual AppExceptions contents, FD chunk caching behavior across a roll. The RUM query above is the verification step.
