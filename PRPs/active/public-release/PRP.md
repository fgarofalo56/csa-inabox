# CSA Loom — Public-Release Readiness PRP (Master)

> **Goal:** Take CSA Loom from "deep but last-mile-broken" to a **defensible public v1**
> that satisfies every operator mandate — no-vaporware, ui-parity, web3-ui, no-fabric-dependency,
> and the BLOCKING memory rules — with a **real Azure-native backend behind every control**,
> **Fluent v9 + Loom tokens** on every surface, **bicep-synced day-one** infra, and **Commercial
> AND Government** working out of the box.
>
> Author: release-audit synthesis lead · Date: 2026-07-02 · Branch: `feat/loom-marketplace`
> Source of truth: `docs/fiab/prp/RELEASE-READINESS-2026-07-02.md` + the 14 dimension detail
> files under `docs/fiab/prp/release-audit/*.md`.
> Companion index: [`README.md`](./README.md).

---

## 1. How to read this PRP

Every item is `rel-Tnn` with: **title · category · severity · evidence pointer · acceptance criteria · effort · deps.**
Items are grouped into **ordered waves**. A wave is independently kick-offable; later waves may depend on
earlier ones (noted per item). Categories: **ADD** (net-new), **UPDATE** (fix existing), **ENHANCE** (deepen),
**CONSOLIDATE** (dedupe), **REMOVE** (delete), **REORGANIZE** (restructure).

**Cross-cutting acceptance gates (inherited by EVERY item — not repeated per item):**

1. **Real backend per control** — no mock arrays / `return []` / `useState(MOCK)` / stub route; a real Azure REST/Cosmos/TDS/ARM call or an honest Fluent MessageBar `intent="warning"` naming the exact env var/role/resource + bicep link (`no-vaporware.md`).
2. **Azure-native default, Fabric opt-in** — never gate on `fabricWorkspaceId`; never call `api.fabric.microsoft.com`/`api.powerbi.com`/`onelake.dfs.fabric` on the default path; works with `LOOM_DEFAULT_FABRIC_WORKSPACE` UNSET (`no-fabric-dependency.md`).
3. **Web-3.0 UI** — Fluent v9 + Loom tokens only (no raw px/hex), shared primitives (PageShell/TileGrid/EmptyState/Spinner), cards+icons+elevation, designed empty/loading/error/gate states (`web3-ui.md`, `loom_design_standards`).
4. **No freeform config** — dropdowns/wizards/WYSIWYG/canvas; JSON only for 1:1 ADF/Synapse expression parity (`loom_no_freeform_config`).
5. **Dual cloud** — Commercial + GCC/GCC-High/DoD IL5; Gov endpoints (`*.us`) and Gov-aware DNS/CSP.
6. **Bicep-synced** — every new resource/env var/role/Cosmos container/tenant config in bicep + param files; clean-sub 1-button deploy == live feature set; `scripts/ci/*` guards stay green.
7. **Proof of done** — real-data E2E receipt (endpoint + real response + screenshot/trace + bicep diff) per the no-scaffold rule; live side-by-side, click-every-control.

**Verification discipline:** audit plans go stale on an active repo (07-01 lesson). **Re-verify each item's evidence against current code before building** — several fabric-parity gaps are already partially built.

---

## 2. Wave map

| Wave | Theme | Items | Gate |
|------|-------|-------|------|
| **0** | Release blockers (vaporware / privacy / no-fabric) | rel-T01…T09 | G1–G4 |
| **1** | Security + access-control | rel-T10…T20 | G5–G6 |
| **1b** | Testing + CI enforcement | rel-T21…T30 | G7 |
| **2** | Deployment-truth + product-truth | rel-T31…T44 | G8–G9 |
| **3** | IA / navigation consolidation | rel-T45…T54 | — |
| **4** | UI polish + a11y + refactor hygiene | rel-T55…T70 | G10 |
| **5** | Docs / help / release engineering | rel-T71…T80 | G11 |
| **6** | Fabric-parity feature gaps | rel-T81…T95 | — |
| **7** | Product-gap features + nice-to-have | rel-T96…T108 | — |

---

## WAVE 0 — Release blockers

### rel-T01 — Rewrite the public onboarding funnel to the proven deploy path
- **Category:** UPDATE · **Severity:** Critical (blocker B1) · **Effort:** M
- **Evidence:** `docs/fiab/deployment/quickstart.md:18,25,47-65`; `platform/fiab/azd/azure.yaml:3` ("SCAFFOLDED"); `docs/fiab/deployment/deploy-button.md`; `docs/fiab/operations/upgrade-migration.md:54-55` (`fiab-migrate` nonexistent).
- **Acceptance:** Primary quickstart teaches `az deployment sub create -f platform/fiab/bicep/main.bicep -p params/commercial-full.bicepparam` + `csa-loom-post-deploy-bootstrap.yml` (mirroring `deploy-fiab-commercial.yml`). Remove the Power BI Premium prerequisite (it is opt-in per mandate 11). Delete or fully implement `deploy-button.md` (see rel-T77) and the `fiab-migrate` references (superseded by rel-T40). Every command in the doc executes clean on a fresh sub.
- **Deps:** none (docs); coordinate with rel-T77.

### rel-T02 — Purge live estate identifiers + operator PII from the published docs site
- **Category:** UPDATE · **Severity:** High (blocker B2) · **Effort:** M
- **Evidence:** `docs/fiab/audit/gated-services-default-on.md:8-13`; `docs/fiab/parity-gap/_top-level-nav-validation-2026-05-26.md` (email, in `mkdocs.yml:~1704`); `docs/fiab/audit/live-e2e-*.md:4`; 82 files with live `azurefd.net`; `mkdocs.yml:46-62` exclude list.
- **Acceptance:** Add `fiab/audit/`, `fiab/parity-gap/`, `fiab/design/`, `fiab/next-session-kickoff.md`, `fiab/no-cuts-sweep-v2.md`, `fiab/loom-feature-backlog.md`, `fiab/fabric-parity-tasks.json` to `exclude_docs`; run a sub-GUID / UAMI-principalId / workspace-GUID / hostname / email redaction sweep across `docs/`; add a `scripts/ci/check-docs-hygiene.mjs` grep gate (fails the build on live coordinates or `@housegarofalo.com`) wired into `docs.yml` and `loom-guardrails.yml`.
- **Deps:** none.

### rel-T03 — Give Scorecard an Azure-native default (kill the Power BI hard-gate)
- **Category:** UPDATE · **Severity:** High (blocker B11) · **Effort:** M
- **Evidence:** `lib/editors/phase3/scorecard-editor.tsx:60,116-131,354`; `app/api/items/scorecard/route.ts:8`; `lib/catalog/item-types/power-bi.ts:108-111`; Cosmos fallback exists in `_lib/pbi-content-fallback.ts` but is unreachable.
- **Acceptance:** Apply the dashboard-editor pattern (`dashboard-editor.tsx:98-107`): Cosmos-native goal store + local rollup/status engine as the DEFAULT (no Power BI workspace required, `LOOM_DEFAULT_FABRIC_WORKSPACE` unset); Power BI scorecard sync becomes the opt-in Fabric-family leg gated on `NEXT_PUBLIC_LOOM_BI_BACKEND==='powerbi'`. Reconcile `power-bi.ts` catalog copy + the fabric-parity appendix row. Real E2E: create + edit a scorecard with zero Power BI calls (network trace).
- **Deps:** rel-T04 (shared BI-backend dispatch).

### rel-T04 — Fix the default BI-backend chain: no Power BI default, no api.powerbi.com on the default render
- **Category:** UPDATE · **Severity:** High (blocker B12) · **Effort:** M
- **Evidence:** `platform/fiab/bicep/modules/admin-plane/main.bicep:2893-2894` (fallback `'powerbi'`) + duplicate `:3075-3076`; `report-editor.tsx:1268`; `semantic-model-editor.tsx:1052-1057`; `dashboard-editor.tsx:52-56`; `paginated-report-editor.tsx:198-199`; hook `workspace-picker.tsx:69-106` → `powerbi-client.ts:270-273`.
- **Acceptance:** (a) In bicep, remove the 2893-2894 pair (or change fallback `'powerbi'`→`''`); derive `'aas'` into `loomBackends.bi` so one expression owns the value; emit each BI env var exactly once (add a CI check rejecting duplicate env names per app — see rel-T33). (b) In all four editors, call `usePowerBiWorkspaces()` **only** inside the `biBackend==='powerbi'` branch; default (`''`/`aas`) renders the Loom-native/AAS surface with zero Power BI network calls. (c) Dedupe the copied `usePowerBiWorkspaces`/MessageBar back to `workspace-picker.tsx`. Network trace on a default deploy shows zero `api.powerbi.com` hits.
- **Deps:** none; unblocks rel-T03.

### rel-T05 — UDF Run must execute the authored source (not the baked-in sample)
- **Category:** UPDATE · **Severity:** High (blocker B5) · **Effort:** S
- **Evidence:** `app/api/items/user-data-function/[id]/invoke/route.ts:44-52,73`; `platform/fiab/bicep/modules/admin-plane/udf-runtime/app.py:22-31` (`X-Udf-Source-B64`); `main.bicep:395` (default-on).
- **Acceptance:** The invoke route forwards the item's saved source as `x-udf-source-b64` when calling the Loom UDF runtime (host already supports it) OR pushes source on Publish. Real E2E: author a function that returns a distinct value, Run, receive that value (not the sample). If neither ships, render an honest MessageBar in the Test panel stating only the bundled sample executes (interim only).
- **Deps:** none.

### rel-T06 — Replace/gate UDF decorative config surfaces (connections, libraries, BYO endpoint)
- **Category:** UPDATE · **Severity:** Medium (fabric-first framing + no-freeform + no-vaporware) · **Effort:** M
- **Evidence:** `lib/editors/phase4/user-data-function-editor.tsx:188,191,272-273,276-301`; `self-audit.ts:548`.
- **Acceptance:** (a) Replace the "Manage connections (Fabric data sources)" freeform box with the shared `/api/connections` picker injected into the invocation context, or remove it. (b) Wire "Library management" into the runtime (pip-install from item state) or replace with an honest MessageBar naming the stdlib-only limitation. (c) Add "Execution endpoint" fields (Function App base URL + KV key-secret name) exposing the BYO Azure Functions path the route already implements. (d) "Generate invocation code" emits the Azure Functions variant by default (`https://<fnapp>.azurewebsites.net/api/<fn>` + key/Entra audience) + a Synapse/Databricks notebook snippet; the Fabric/`mssparkutils` variant only when `LOOM_UDF_BACKEND=fabric`.
- **Deps:** rel-T05.

### rel-T07 — Re-lead the four PBI-family `/new` cards + Activator picker with the Loom-native default
- **Category:** UPDATE · **Severity:** Medium (fabric-first framing) · **Effort:** S
- **Evidence:** `lib/catalog/item-types/power-bi.ts:15,39,63,87`; `lib/editors/phase3/activator-editor.tsx:62,103-114`; `lib/install/provisioners/semantic-model.ts:526`; `report-editor.tsx:1271`.
- **Acceptance:** Rewrite the semantic-model/report/dashboard/paginated-report `learnContent` to lead with the Loom-native/AAS default (mirror `real-time-intelligence.ts` copy style), Power BI as opt-in alternative. Fix the Activator empty-state to Loom workspaces ("No workspaces — create one" → `/workspaces`), not "Create one in Power BI".
- **Deps:** rel-T04.

### rel-T08 — Wire (or delete) `notebook-compute-pool.bicep` so bicep-sync passes
- **Category:** UPDATE · **Severity:** High (blocker B6) · **Effort:** S
- **Evidence:** `node scripts/ci/check-bicep-sync.mjs` FAIL; `platform/fiab/bicep/modules/admin-plane/notebook-compute-pool.bicep:22-31`; console reads `LOOM_AML_*` (`aml-client.ts:418-434`).
- **Acceptance:** Wire the module into `admin-plane/main.bicep` and emit its four `LOOM_AML_*` outputs on the console env, OR delete it and emit the vars directly. `node scripts/ci/check-bicep-sync.mjs` exits 0. Also fix the guard to strip `//` comments before matching (rel-T39) so `gh-runner-job.bicep` self-reference stops hiding orphans.
- **Deps:** none.

### rel-T09 — Truth the console + root README to the shipped product
- **Category:** UPDATE · **Severity:** High (docs blocker) · **Effort:** S
- **Evidence:** `apps/fiab-console/README.md:10-13` ("SCAFFOLDED … 12 panes"); `README.md:5,40-53,245-249`.
- **Acceptance:** Console README describes the shipped product (117 item-type editors, 22 categories, marketplace, copilots, tech stack, dev workflow). Root README adds a prominent CSA Loom section (what it is, screenshot, links to `docs/fiab/deployment/quickstart.md` + the published docs site) and the Loom quickstart replaces the legacy path as the headline. Removes the axe-core claim until rel-T68 lands, or lands rel-T68 first.
- **Deps:** rel-T01.

### rel-T09b — Fix the app-install dialog `aria-hidden` regression (Section 508 + re-greens 27 UAT apps)
- **Category:** UPDATE · **Severity:** High (blocker B19) · **Effort:** S · **Live-confirmed**
- **Evidence:** Live: active `fui-DialogSurface` on `/apps/<id>` carries `role="dialog"`+`aria-modal="true"` AND `aria-hidden="true"` on the same node (inverted Tabster modalizer; 0 JS errors; reproduced on app-ml-pipeline + app-fedramp-tracker; screenshot `browser-walk/11a-app-detail.png`). Code: `lib/components/apps/install-app-dialog.tsx` (plain Fluent `<Dialog><DialogSurface>`, never sets aria-hidden). Dep drift: `apps/fiab-console/package.json` `@fluentui/react-components:^9.54.0` → lockfile resolved `9.73.8` / `@fluentui/react-tabster@9.26.14` / `tabster@8.8.0` on React 19.2. Exposed by `a34ee904` DOM reorder (pages only; provider roots untouched — `theme/fluent-ssr.tsx`, `theme/theme-context.tsx`).
- **Acceptance:** Live `getByRole('dialog')` on the install modal is visible with NO `aria-hidden` on the surface and focus trapped inside it; keyboard/SR user can operate the install flow (Section 508). Fix via Fluent/tabster version pin-or-bump past the modalizer aria-hidden-on-self regression (and/or portal-under-FluentProvider), not by mutating the DOM by hand. Re-run `loom-uat` `UAT_GREP="use-case app"` → all 27 previously-failing apps reach the install POST (green or honest infra-gate). Add a Playwright a11y regression assertion (dialog visible + surface not aria-hidden) to the UAT suite so it can't silently regress. NO change to `use-case-apps-uat.uat.ts` selectors — they are correct. Audit other Fluent `<Dialog>`/`<Drawer>`/`<Popover>` surfaces for the same modalizer inversion (likely systemic post-bump).
- **Deps:** none; do FIRST in Wave 0 (unblocks the entire use-case-app E2E safety net that gates every other wave's verification).

### rel-T09c — Ship with a clean seeded tenant (purge demo/UAT debris)
- **Category:** UPDATE · **Severity:** High (first-impression) · **Effort:** M · **Live-confirmed**
- **Evidence:** Live walk: 254–436 workspaces named `uat-app-*` / `tut-*` / `supercharge-*` surfaced in Workspaces, Browse (1750 items), the install workspace-picker, and a Copilot answer; Workspaces count "254" vs Browse "427" inconsistency.
- **Acceptance:** A fresh public deploy lands in a clean tenant (no test/tutorial debris); provide a documented + scripted purge for the operator's existing estate and ensure UAT/tutorial runs write to a disposable workspace namespace (or clean up after themselves). Reconcile the workspace-count discrepancy (single source of truth for the list). Copilot + Browse + install-picker show only the customer's real workspaces.
- **Deps:** none.

### rel-T09d — Branded not-found state for bad item ids + bad URLs (kill the fabricated-editor fallback)
- **Category:** UPDATE · **Severity:** Medium (data-integrity + polish) · **Effort:** S · **Live-confirmed**
- **Evidence:** Live: `/items/lakehouse/does-not-exist-id` silently renders a working editor titled "Lakehouse (does-not)" backed by the PRIMARY lakehouse (5 console 404s) instead of a not-found state (API is correct: `{"ok":false,"error":"Item not found","code":"not_found"}`); `/new` route 404s bare Next.js; no branded 404 for any bad URL.
- **Acceptance:** A non-existent item id renders a branded not-found state (no fabricated editor, no fallback to another item's backend); add a branded `app/not-found.tsx`; remove or redirect the dead `/new` route. (Overlaps the IA cleanup in Wave 3 rel-T50/T52 for `/new`.)
- **Deps:** none.

### rel-T09e — Debounce/coalesce the compute-targets fetch storm
- **Category:** UPDATE · **Severity:** Medium (perf) · **Effort:** S · **Live-confirmed**
- **Evidence:** Live: opening the lakehouse editor fired `/api/loom/compute-targets` ~74× in one burst (network trace).
- **Acceptance:** The editor requests compute targets once per mount (shared query/cache or debounce); network trace shows ≤2 calls on editor open. Audit sibling editors for the same pattern.
- **Deps:** none.

> **Note (Wave 3/5 overlap for remaining live-walk items):** Learning-Hub walkthroughs pointing at the personal `fgarofalo56.github.io` domain fold into rel-T02 (privacy/PII) + the docs wave (host tutorials on the product's own docs site); Real-Time-hub-vs-RTI-catalog + three-data-finder nav redundancy fold into Wave 3 IA items rel-T45–T54; Governance-shows-all-zeros is a function of the debris tenant (rel-T09c) + a first-run "run your first scan" guided state (Wave 3 EmptyState work).

---

## WAVE 1 — Security + access-control

### rel-T10 — Replace the predictable `LOOM_INTERNAL_TOKEN` + block `/api/internal/*` externally
- **Category:** UPDATE · **Severity:** High (blocker B3) · **Effort:** M
- **Evidence:** `main.bicep:301` (`guid(rg.id,'loom-maf-internal-token-v1')`); `front-door.bicep:320-333` (`/*`); `app/api/internal/copilot/tools/[name]/invoke/route.ts:36-70`; `app/api/iq/mcp/route.ts:63-71`.
- **Acceptance:** Derive the token from a KV-generated random secret (`guid(newGuid())` / KV secret), never `guid(rg.id,<const>)`; give MAF, IQ-MCP, and CI their own random secrets (KV secretRef). Add a Front Door route/WAF rule blocking `/api/internal/*` so it is reachable only on the CAE internal network. Constrain the accepted `x-user-oid` set where feasible. Bicep diff + a test proving external `/api/internal/*` returns 403.
- **Deps:** none.

### rel-T10b — Fix the predictable session-secret + MCP-key fallbacks (auth-boundary; blocker B3b)
- **Category:** UPDATE · **Severity:** High (blocker B3b) · **Effort:** S
- **Evidence:** `platform/fiab/bicep/modules/admin-plane/main.bicep:3863` (`empty(loomSessionSecret) ? guid(resourceGroup().id,'loom-session-secret-v1') : …`); `:1669` (`loomBuiltinMcpApiKey = guid(rg.id,'loom-builtin-mcp-api-key-v1')`); `main.bicep:1045` + `platform/fiab/bicep/main.bicep:786` (`param loomSessionSecret string = ''`); `params/commercial-full.bicepparam:215` + `params/tenant-dmlz.bicepparam:143` (read env, default `''` — no file sets it); consumer `lib/auth/session.ts` (HKDF over `session-secret`).
- **Acceptance:** Default `session-secret` (and the builtin-MCP key) from a deploy-time random (KV secret seeded by `newGuid()`/`utcNow()` deploymentScript), NEVER `guid(rg.id,const)`. Console FAILS FAST at boot if `session-secret` resolves to the predictable form (refuse to serve). Document `LOOM_SESSION_SECRET` as a required input in the rewritten quickstart (rel-T01). Same KV-random pattern as rel-T10. Proof: two deploys of the same RG name produce different session secrets; a cookie minted against deploy A is rejected by deploy B.
- **Deps:** shares the KV-random-secret mechanism with rel-T10; coordinate with rel-T01 (quickstart).

### rel-T11 — Fix the multi-user authorization model (tid partitioning + per-resource ACLs)
- **Category:** UPDATE · **Severity:** High (blocker B4) · **Effort:** XL
- **Evidence:** `lib/auth/feature-gate.ts:91`; `admin/permissions/grants/route.ts:61`; `app/api/workspaces/[id]/items/route.ts:15-24,32`; `resolveEffectiveRole` exists but unwired.
- **Acceptance:** Partition tenant-shared data (workspaces, feature grants, item membership) by the Entra tenant id (`tid`) with per-resource ACLs, not the individual user `oid`. A second user added to a workspace can open it + its items; a delegated feature grant at `/admin/permissions` resolves for the grantee. Real E2E with two distinct signed-in oids. Regression: no cross-tenant read (tid boundary + ACL). This unblocks the shipped sharing/permissions UIs (currently vaporware).
- **Deps:** none; large — sequence early in Wave 1.

### rel-T12 — Add OAuth `state` + PKCE + nonce (login CSRF / session fixation)
- **Category:** UPDATE · **Severity:** Medium (blocker-adjacent) · **Effort:** S
- **Evidence:** `app/auth/sign-in/route.ts:88-93`; `app/auth/callback/route.ts:231-251`; cookie SameSite=Lax despite `msal.ts:4-5` comment.
- **Acceptance:** Generate a random `state` + PKCE `code_verifier` + nonce at sign-in, persist in a short-lived HttpOnly cookie, reject `/auth/callback` on mismatch. Fix the stale Strict comment. Return a generic `auth_error` code (stop reflecting AAD exchange detail, `callback/route.ts:307-309`).
- **Deps:** none.

### rel-T13 — Fix the authenticated SSRF in `/api/admin/mcp-servers/test-connection`
- **Category:** UPDATE · **Severity:** Medium (blocker B17) · **Effort:** S
- **Evidence:** `app/api/admin/mcp-servers/test-connection/route.ts:21-27,55`; `lib/azure/mcp-client.ts:173-191`.
- **Acceptance:** Require `requireTenantAdmin`; enforce `https:` scheme; after DNS resolution block RFC-1918 / link-local / `169.254.169.254`; add an egress allow-list. Test proving a private-IP target is rejected.
- **Deps:** none.

### rel-T14 — Make `isTenantAdminTier` fail closed
- **Category:** UPDATE · **Severity:** Medium · **Effort:** S
- **Evidence:** `lib/auth/domain-role.ts:69-74,199-209`; gates admin/capacity/cost/utilization + spark session-pool.
- **Acceptance:** When neither `LOOM_TENANT_ADMIN_OID` nor `_GROUP_ID` is set, `isTenantAdminTier`/`canAccessDlzPanes` return false (match `isTenantAdmin`). Deploy binds an admin principal (bootstrap step or bicep). Org-wide capacity/cost/compute-warm no longer exposed on an unconfigured deploy.
- **Deps:** none.

### rel-T15 — Authenticate + throttle `/api/feedback`
- **Category:** UPDATE · **Severity:** High (blocker B16) · **Effort:** S
- **Evidence:** `app/api/feedback/route.ts:47-56,89-105`; client cap only (`error-boundary.tsx:16`).
- **Acceptance:** Server-side per-IP/fingerprint rate limit + dedupe; require a session for `kind=bug|feature`; keep auto-error anonymous but heavily throttled. The GitHub token is never reachable by unbounded anonymous POST.
- **Deps:** rel-T16 (durable rate-limit store) preferred.

### rel-T16 — Default rate limiting ON + apply to expensive route classes
- **Category:** ENHANCE · **Severity:** Medium (blocker B-adjacent) · **Effort:** M
- **Evidence:** `lib/azure/rate-limiter.ts:66-71,92-94`; only 4 routes wired.
- **Acceptance:** Default `LOOM_RATE_LIMIT=on`; wrap auth, query, provision, AOAI, and download route classes with `withRateLimit`; back it with a durable cross-replica store (Redis seam already documented; add bicep if a new resource). Env-synced.
- **Deps:** none.

### rel-T17 — Widen the CI route-guard to every id-taking route group
- **Category:** UPDATE · **Severity:** Medium · **Effort:** S
- **Evidence:** `scripts/ci/check-route-guards.mjs:69-71,402-407` (only items/admin/adx).
- **Acceptance:** Scan all of `app/api` (reuse the allowlist mechanism) so dab, notebook, deployment-pipelines, data-products, connections, cosmos-items, catalog/asset, foundry/computes, loom/compute-targets, thread, realtime-hub, spark-environment, workspaces are covered. Guard fails on a getSession-only cross-tenant regression anywhere.
- **Deps:** none; pairs with rel-T11.

### rel-T18 — Gate `data-products/[id]/preview` on an approved access request
- **Category:** UPDATE · **Severity:** Medium · **Effort:** M
- **Evidence:** `app/api/data-products/[id]/preview/route.ts:50-64,97-100`.
- **Acceptance:** Preview requires an approved access request / access policy (or ownership), same gate as full data access; cannot disclose 25 rows of any product to a non-subscriber. Real E2E: non-subscriber gets 403, subscriber gets rows.
- **Deps:** rel-T11 (ACL model).

### rel-T19 — Per-user scope `notebook/[id]/contents`
- **Category:** UPDATE · **Severity:** Medium · **Effort:** M
- **Evidence:** `app/api/notebook/[id]/contents/route.ts` (ignores `[id]`, path-addressable).
- **Acceptance:** Resolve the notebook file location from the owned Cosmos item, or namespace paths under `Users/<oid>/` and reject paths outside the caller's prefix. Two users cannot read/overwrite each other's notebooks.
- **Deps:** rel-T11.

### rel-T20 — Shared admin authz gate + PDP shadow-on
- **Category:** CONSOLIDATE · **Severity:** Low/Medium · **Effort:** M
- **Evidence:** `app/api/admin/mcp-servers/route.ts:108-131,199-203` (getSession-only); `lib/auth/pdp/enforce.ts:40-43,149-150` (default off).
- **Acceptance:** Apply a consistent `requireTenantAdmin` (or route-group guard) to every `/api/admin/*` handler. Ship the release with PDP at least in shadow mode wired-on + a documented enforce path; the policy-authoring UI surfaces that the gate is inert until flipped.
- **Deps:** rel-T17.

---

## WAVE 1b — Testing + CI enforcement

### rel-T21 — Burn down the 48 vitest failures + add vitest to CI as a required check
- **Category:** UPDATE · **Severity:** High (blocker B13) · **Effort:** M
- **Evidence:** local run 48 failed/22 files (admin routes, all AI-assist routes, catalog search/register); `fiab-console-ci.yml` ends at `pnpm build`.
- **Acceptance:** Fix the 48 failures; add a vitest job (same change-detection) to `fiab-console-ci.yml`; make it a required status check in branch protection. `next build` type-check stays enforced (`ignoreBuildErrors:false`).
- **Deps:** none.

### rel-T22 — Gate the production roll on tests + the loom-uat job
- **Category:** ADD · **Severity:** High (blocker B13) · **Effort:** L
- **Evidence:** `build-fiab-images-acr-tasks.yml` push:[main] → `loom-roll-and-validate.yml:24-27,82`; `loom-validate-live.sh` (unauthenticated curls only).
- **Acceptance:** Before shifting Container App traffic: vitest green + start the in-VNet loom-uat ACA job (`scripts/csa-loom/deploy-loom-uat-job.sh`) and poll its `UAT_RESULT` line; keep the existing auto-rollback as backstop.
- **Deps:** rel-T21, rel-T30.

### rel-T23 — Make Loom Guardrails + ≥1 review required on main
- **Category:** UPDATE · **Severity:** Medium · **Effort:** S
- **Evidence:** branch protection required contexts lack `guardrails`; ruleset 15128883 `required_approving_review_count:0`.
- **Acceptance:** Add the guardrails job to required status checks; require ≥1 approving review on main. (Single-operator model retains admin-merge authority per release-authorization memory, but a red guardrails run can no longer merge.)
- **Deps:** none.

### rel-T24 — Make `csa-loom-validate` exit non-zero on hard FAILs
- **Category:** UPDATE · **Severity:** Medium · **Effort:** S
- **Evidence:** `csa-loom-validate.yml:97-99` (never exits).
- **Acceptance:** Append `if [ "$FAILS" -gt 0 ]; then exit 1; fi`. Live validation can now fail the job.
- **Deps:** none.

### rel-T25 — Include the four dark root-level test files in the vitest run
- **Category:** UPDATE · **Severity:** Medium · **Effort:** S
- **Evidence:** `vitest.config.ts:46-49`; `__tests__/{registry-coverage,apim-policy-scope,apim-xml-validation,copilot-studio-dataverse-scope}.test.ts` never run.
- **Acceptance:** Add `__tests__/**/*.test.{ts,tsx}` to the include list; fix whatever broke while they were dark.
- **Deps:** rel-T21.

### rel-T26 — Add a console ESLint gate
- **Category:** ADD · **Severity:** Medium · **Effort:** S
- **Evidence:** `next.config.mjs:12` (`ignoreDuringBuilds:true`); `package.json:12` lint script never invoked.
- **Acceptance:** `pnpm lint` step in `fiab-console-ci` (behind change-detection).
- **Deps:** none.

### rel-T27 — PR-gate CodeQL + require Trivy
- **Category:** ADD · **Severity:** Medium · **Effort:** S
- **Evidence:** `codeql.yml` push+cron only; `trivy.yml` on PR but not required.
- **Acceptance:** CodeQL `pull_request` trigger (or make Trivy required) added to branch protection.
- **Deps:** none.

### rel-T28 — Console coverage measurement + ratcheting floor
- **Category:** ADD · **Severity:** Medium · **Effort:** M
- **Evidence:** `vitest.config.ts` no coverage block; Python has `--cov-fail-under=60`.
- **Acceptance:** vitest v8 coverage enabled with a ratcheting floor once the suite is wired in.
- **Deps:** rel-T21.

### rel-T29 — Wire `guard:circular` + from-scratch smoke into CI
- **Category:** ADD · **Severity:** Low · **Effort:** S
- **Evidence:** `package.json:14`; `deploy-fiab-commercial.yml:356-360` (continue-on-error smoke).
- **Acceptance:** `guard:circular` runs in the `fiab-console-ci` build job; the from-scratch deploy smoke uses the in-VNet loom-uat job pattern (not continue-on-error).
- **Deps:** rel-T30.

### rel-T30 — Expand E2E to a 10-journey slice + parameterize the harness target
- **Category:** ADD · **Severity:** High · **Effort:** L
- **Evidence:** `loom-ui-verify.yml:19-41` (weekly, admin-only); `playwright.config.ts:27,68-78`; `deep-functional-uat.uat.ts:1-34` (no workflow, hardcoded workspace).
- **Acceptance:** Schedule the loom-uat job on every roll; expand the verify project to 10 journeys (create item, run notebook cell, pipeline save+run, warehouse query, marketplace subscribe, app install, catalog search, report open, admin health, login/session refresh). Parameterize `baseURL` + seed a staging workspace so journeys can run pre-traffic-shift.
- **Deps:** rel-T21.

---

## WAVE 2 — Deployment-truth + product-truth

### rel-T31 — Single AAS owner + single SKU + one `LOOM_AAS_SERVER`
- **Category:** UPDATE · **Severity:** High (blocker B7) · **Effort:** M
- **Evidence:** `admin-plane/main.bicep:1910,2101,1357,194,476,2630,2646,3061,3077,3183`; `app-deployments.bicep:114-154`.
- **Acceptance:** One module owns the AAS server; the other receives only the existing name; single SKU param. Compute one `effectiveAasServer = (param || aas.outputs.serverFullName)` and emit `LOOM_AAS_SERVER`/`_MODEL`/`_DATABASE` exactly once. Redeploy is deterministic. Pairs with the duplicate-env CI check (rel-T33).
- **Deps:** none.

### rel-T32 — Gov post-deploy bootstrap path
- **Category:** ADD · **Severity:** High (blocker B8) · **Effort:** L
- **Evidence:** `csa-loom-post-deploy-bootstrap.yml` (commercial creds, no `az cloud set`); Gov deploy workflows have no bootstrap.
- **Acceptance:** Parameterize the bootstrap on cloud (Gov secret set + `az cloud set --name AzureUSGovernment`) or extract cloud-agnostic composite steps both clouds invoke (MSAL app reg, Synapse SQL grants, Purview roles, Databricks SCIM, Spark PE). Drop the operator's private estate GUIDs as defaults (rel-T34). Required before any all-Gov-day-one claim.
- **Deps:** rel-T34.

### rel-T33 — Duplicate-env-name CI check
- **Category:** ADD · **Severity:** Medium · **Effort:** S
- **Evidence:** AAS/BI vars emitted multiple times in one app env array; `app-deployments.bicep` no dedupe.
- **Acceptance:** A `scripts/ci/` guard rejects duplicate env names per app (after concat), wired into `loom-guardrails.yml`. Fails the current AAS/BI dup state until rel-T04/rel-T31 land.
- **Deps:** none.

### rel-T34 — Scrub bootstrap defaults + chain deploy→bootstrap
- **Category:** UPDATE · **Severity:** Medium · **Effort:** S
- **Evidence:** `csa-loom-post-deploy-bootstrap.yml:44-71` (legacy sub/UAMI/DBX host defaults); no chaining from deploy workflows.
- **Acceptance:** Make region+subscription required inputs (drop legacy fallbacks); auto-dispatch bootstrap from the deploy workflow with computed inputs; remove `|| true` masking on required steps. Scrub estate GUIDs before public release.
- **Deps:** none.

### rel-T35 — Teardown purges soft-deleted KV + Cognitive/APIM/AAS/Cosmos
- **Category:** UPDATE · **Severity:** High (blocker B9) · **Effort:** M
- **Evidence:** `keyvault.bicep:74-76`; `fiab-teardown.sh:49-64`; `ai-foundry.bicep:93,237`; `apim.bicep` (no purge).
- **Acceptance:** Add a KV recover/reconcile path (`createMode` param) or salt the KV name per deploy generation; make purge protection a boundary param so CI/test subs can purge. Extend `fiab-teardown.sh` with `az cognitiveservices account list-deleted/purge`, `az apim deletedservice purge`, Cosmos restorable purge, AAS handling. Real E2E: teardown → redeploy into the same RG succeeds.
- **Deps:** none.

### rel-T36 — Boundary-branch the remaining Gov private-DNS zones
- **Category:** UPDATE · **Severity:** High (blocker B10) · **Effort:** S
- **Evidence:** `admin-plane/network.bicep:372-390` (KV/ACR/Search/Event Grid/AML/ACA/AppConfig hard-coded commercial).
- **Acceptance:** Apply the GCC-High/IL5 conditional to `vaultcore.usgovcloudapi.net`, `azurecr.us`, `search.windows.us`, `eventgrid.azure.us`, `api.ml.azure.us`, `notebooks.usgovcloudapi.net`, `azurecontainerapps.us`, Gov AppConfig — per the Azure Government private-link DNS table. PE DNS resolves on Gov.
- **Deps:** none.

### rel-T37 — First-run image bootstrap (make the acceptance test satisfiable)
- **Category:** UPDATE · **Severity:** Medium · **Effort:** M
- **Evidence:** `commercial-full.bicepparam:224` (`deployAppsEnabled=true`); `main.bicep:2376` (own-ACR image, no fallback); working path is `full-app-deploy-commercial.yml`.
- **Acceptance:** Seed a public bootstrap/placeholder image (with a post-build update step) so first-run `deployAppsEnabled=true` succeeds against the freshly-created ACR, OR amend `no-vaporware.md`'s acceptance test to name `full-app-deploy-commercial.yml` as the canonical from-scratch path (and update rel-T01 docs to match).
- **Deps:** rel-T01.

### rel-T38 — Harden the bootstrap KV-public flip
- **Category:** ENHANCE · **Severity:** Medium · **Effort:** S
- **Evidence:** `csa-loom-post-deploy-bootstrap.yml:190-214` (full-public + trap-only restore).
- **Acceptance:** Scope a firewall IP rule to the runner egress IP instead of `--default-action Allow`; add an `if: always()` restore step (like the Synapse/Databricks safety nets).
- **Deps:** rel-T32.

### rel-T39 — Fix the bicep-sync guard comment-stripping + prune stale allowlist
- **Category:** UPDATE · **Severity:** Low · **Effort:** S
- **Evidence:** `check-bicep-sync.mjs` MODULE_DECL_RE doesn't strip `//`; stale `udf-runtime`/legacy `azure-maps` allowlist entries; `gh-runner-job.bicep:25` self-reference.
- **Acceptance:** Strip comments before matching (so a commented `module` example no longer marks a file reachable); remove stale allowlist entries; wire `gh-runner-job.bicep` behind `deployGitHubRunner=false` or delete it; delete/wire legacy `landing-zone/azure-maps.bicep`.
- **Deps:** rel-T08.

### rel-T40 — Truth the DR docs + write one tested Cosmos restore runbook
- **Category:** UPDATE · **Severity:** High (blocker B14) · **Effort:** M
- **Evidence:** `disaster-recovery.md:25,35,53-58`; actual `storage.bicep:52` ZRS, `main.bicep:1717/1781/1840` LRS, `loom-console-cosmos.bicep:71-73` single-region + failover off.
- **Acceptance:** Rewrite DR to the real posture (single-region + zone redundancy + PITR + redeploy-from-git) with honest RPO/RTO; write + execute one Cosmos PITR restore runbook for the workspace/item metadata store; drop the scaffolded azd DR steps. Add a one-paragraph "supported availability model" to deployment docs.
- **Deps:** rel-T01.

### rel-T41 — Self-update compatibility manifest (schema/infra migration gate)
- **Category:** ADD · **Severity:** High (blocker B15) · **Effort:** M
- **Evidence:** `in-product-update-path.md:85-89` (image-only); no min-infra/migration check; Cosmos containers self-heal but env/RBAC don't.
- **Acceptance:** Per-release compatibility manifest (required env vars / min bicep version) consumed by the `/admin/updates` preflight, surfacing "this update requires an infra re-deploy first" as an honest gate. Bicep-synced env-var list is the source. Real E2E: an update to a release adding a new env var is blocked with the exact remediation.
- **Deps:** none.

### rel-T42 — Add Azure-quota pre-flight to the setup/deploy wizard
- **Category:** ENHANCE · **Severity:** Medium · **Effort:** M
- **Evidence:** no quota checks in `lib/setup`/`setup-wizard.tsx`/`app/api/setup`; quota=0 previously blocked live provisioning.
- **Acceptance:** `Microsoft.Capacity/usages` checks for the SKUs the selected topology will deploy, surfaced as honest pre-deploy gates in the setup wizard (Fluent MessageBar naming the SKU + region + request-increase link).
- **Deps:** none.

### rel-T43 — Setup-wizard deploy progress survives refresh
- **Category:** UPDATE · **Severity:** Medium · **Effort:** M
- **Evidence:** `setup-wizard.tsx:496,701-726` (all state in useState, no persistence).
- **Acceptance:** Persist `{deploymentId, workflowFile, dispatchedAt}` (localStorage or a Cosmos setup-state doc); re-attach on mount (mirror the app-install background-job pattern in `lib/state/jobs-store.ts`). No duplicate-deploy risk on refresh.
- **Deps:** none.

### rel-T44 — Fix eventstream provisioner env-var name mismatch
- **Category:** UPDATE · **Severity:** Low · **Effort:** S
- **Evidence:** `eventstream.ts:133` (`LOOM_EVENTHUBS_NAMESPACE`) vs `eventhubs-client.ts:73` + bicep singular `LOOM_EVENTHUB_NAMESPACE`; `app-change-feed-processor.ts:92` plural secretRef.
- **Acceptance:** Align remediation strings + content-bundle secretRef on `LOOM_EVENTHUB_NAMESPACE`. The honest gate names an env var that exists.
- **Deps:** none.

---

## WAVE 3 — IA / navigation consolidation

### rel-T45 — Group the left rail into ≤10 labeled sections (or ≤8 primary + More)
- **Category:** REORGANIZE · **Severity:** Medium · **Effort:** M
- **Evidence:** `nav-items.ts:18-43` (24 flat); `left-nav.tsx:104-127`; single-item-type pages promoted.
- **Acceptance:** Rail grouped into labeled sections (or Fabric-style ≤8 primary + "More" flyout); demote `/semantic-model`, `/org-reports`, `/data-agent`, `/business-events` to command palette / Browse / workload hub. Consistent with sibling shells.
- **Deps:** rel-T46…T49 (they change what the rail points at).

### rel-T46 — Consolidate RTI into one hub with tabs
- **Category:** CONSOLIDATE · **Severity:** Medium · **Effort:** L
- **Evidence:** `nav-items.ts:30-33`; `activator/page.tsx`, `activator-hub/page.tsx` both title "Activator".
- **Acceptance:** One `/realtime-hub` with tabs (Streams, Discover sources, Activator, Business events); redirect `/activator` into it; remove the duplicate title.
- **Deps:** none.

### rel-T47 — Consolidate the catalog destinations
- **Category:** CONSOLIDATE · **Severity:** Medium · **Effort:** L
- **Evidence:** `nav-items.ts:21-23`; `governance-shell.tsx:22`; `catalog/browse/page.tsx:24`.
- **Acceptance:** One rail catalog (`/onelake`); fold `/catalog` federated search in as a scope; keep `/governance/catalog` inside Governance renamed "Governed inventory". At minimum make all labels mutually predictive.
- **Deps:** none.

### rel-T48 — Merge the three lineage surfaces onto LineageCanvas + fix the "Purview lineage" label
- **Category:** CONSOLIDATE · **Severity:** Medium · **Effort:** L
- **Evidence:** `nav-items.ts:26`; `catalog-shell.tsx:19`; `governance-shell.tsx:23`; `governance/lineage/page.tsx:9,77-90,324`.
- **Acceptance:** Port governance/lineage onto the shared `LineageCanvas` + `itemVisual()` registry (theme-aware colors); a source-scope switch replaces three names; fix the "Purview lineage" label immediately.
- **Deps:** overlaps rel-T57 (lineage consistency).

### rel-T49 — Add a sticky workspace switcher + editor breadcrumb
- **Category:** ADD · **Severity:** Medium · **Effort:** M
- **Evidence:** `app-shell.tsx:160-229` (no control); `item-editor-chrome.tsx` (no breadcrumb); dead `lib/stores/ui.ts:14-19`.
- **Acceptance:** Workspace switcher (current + recent + All workspaces) in the rail; workspace›item breadcrumb in `ItemEditorChrome`; finish or delete `lib/stores/ui.ts` (auto-pin last-opened workspace).
- **Deps:** none.

### rel-T50 — Add a "+ Create" rail entry + workspace picker in NewItemDialog
- **Category:** ADD/UPDATE · **Severity:** Medium · **Effort:** M
- **Evidence:** `new-item-dialog.tsx:7-16,239-260,253-260`; no create entry.
- **Acceptance:** "+ Create" rail entry; workspace Dropdown (seeded with the resolved default) shown in the dialog; defer the Cosmos write to name-confirm to stop ghost items from type-browsing.
- **Deps:** rel-T49.

### rel-T51 — Fix orphan pages + hard-404 experience routes
- **Category:** UPDATE · **Severity:** Medium · **Effort:** S
- **Evidence:** `/apps`, `/workloads`, `/data-products`, `/activator` orphaned; `/experience` + `/experience/data-science` 404; `experience/warp/page.tsx:4-11` documents the fix.
- **Acceptance:** "See all apps" in AppLauncher; fold `/workloads` into `/workload-hub` as a tab; Marketplace → `/data-products` link; redirect pages for `/experience` + `/experience/data-science` (copy the warp fix).
- **Deps:** rel-T46 (activator orphan).

### rel-T52 — Plain-language nav labels (retire internal codenames)
- **Category:** UPDATE · **Severity:** Medium · **Effort:** S
- **Evidence:** `nav-items.ts:26,33,36` ("Mesh lineage", "RTI catalog", "Warp").
- **Acceptance:** Plain primary labels with codename secondary ("Lineage", "Orchestration (Warp)"); unify RTI naming as part of rel-T46.
- **Deps:** rel-T46, rel-T48.

### rel-T53 — Gate cross-plane rail links on tenant-admin
- **Category:** UPDATE · **Severity:** Medium · **Effort:** M
- **Evidence:** `catalog-shell.tsx:16`; `governance-shell.tsx:21,24,25` link `/admin/*`; `nav-items.ts:42` Setup shown to all; `setup/page.tsx:26-28`.
- **Acceptance:** Gate the Setup rail entry on tenant-admin via `/api/me`; render read-only domain/classification views in user-plane shells or mark cross-plane links "(Admin)". Probe admin status once in the shell (rel-T54).
- **Deps:** rel-T54.

### rel-T54 — Probe admin status once in the shell (hide/gate Admin portal)
- **Category:** ENHANCE · **Severity:** Low · **Effort:** S
- **Evidence:** `nav-items.ts:41` (Admin portal shown to all); admin routes 403 per-page.
- **Acceptance:** One shell-level admin probe; hide the entry or render a single friendly "Tenant-admin required" gate instead of a wall of forbidden MessageBars.
- **Deps:** none.

---

## WAVE 4 — UI polish + a11y + refactor hygiene

### rel-T55 — Fix the invalid CSS var()+alpha suffix bug
- **Category:** UPDATE · **Severity:** Medium · **Effort:** S
- **Evidence:** `lib/panes/govern-admin.tsx:241` (`var(--loom-accent-violet,#8b5cf6)1f`).
- **Acceptance:** Use `color-mix(in srgb, var(--loom-accent-violet,#8b5cf6) 12%, transparent)` or a `--loom-accent-violet-soft` var. Chip renders tinted.
- **Deps:** none.

### rel-T56 — Sweep ~562 raw-px inline styles to tokens + add a CI guard
- **Category:** UPDATE · **Severity:** Medium · **Effort:** L
- **Evidence:** 522/107 lib files + 40/5 app pages (hotspots manage-panel 31, deployment-pipelines-pane 26, env-config-pane 25); `policies/page.tsx:606…`; `data-quality/page.tsx`; `scans/page.tsx`; `usage-chargeback/page.tsx:271`.
- **Acceptance:** Mechanical map to `tokens.spacing*`/font tokens; extend `scripts/ci/` to fail new numeric gap/padding/margin inline styles.
- **Deps:** none.

### rel-T57 — Port governance/lineage onto the shared LineageCanvas
- **Category:** CONSOLIDATE · **Severity:** Medium · **Effort:** M
- **Evidence:** `governance/lineage/page.tsx:77-90,324` (duplicate color map, dark-mode-hostile).
- **Acceptance:** Reuse `lib/components/catalog/lineage-canvas.tsx` + `itemVisual()`; one visual dialect + theme-aware colors across all lineage surfaces. (Combine with rel-T48.)
- **Deps:** rel-T48.

### rel-T58 — Replace leftover emoji glyphs with Fluent icons
- **Category:** UPDATE · **Severity:** Low · **Effort:** S
- **Evidence:** `activator-editor.tsx:880,1105`; `data-agent-editor.tsx:802`; `pipeline-editor.tsx:254`.
- **Acceptance:** Mail/Call/Link/Settings/Wrench/Comment `16Regular` icons per the web5 sweep.
- **Deps:** none.

### rel-T59 — Swap text-only empties for the EmptyState primitive
- **Category:** CONSOLIDATE · **Severity:** Low · **Effort:** S
- **Evidence:** `data-marketplace.tsx:612`; `my-access.tsx:103`; `governance/lineage/page.tsx:296-301`.
- **Acceptance:** Shared `EmptyState` (icon + CTA) matching `thread/page.tsx:94-102`.
- **Deps:** none.

### rel-T60 — Consolidate card-grid dialects
- **Category:** CONSOLIDATE · **Severity:** Low · **Effort:** M
- **Evidence:** TileGrid / `shared-styles.cardGrid` / `admin-tab-styles.statsRow` + ~80 local copies.
- **Acceptance:** Opportunistically fold local `cardGrid`/`kpiGrid` defs onto one shared primitive when touching a surface. Not release-blocking.
- **Deps:** none.

### rel-T61 — Codemod raw client fetch → clientFetch + add a guard
- **Category:** CONSOLIDATE · **Severity:** Medium · **Effort:** L
- **Evidence:** 277 client components use raw `fetch('/api…')`; `lib/client-fetch.ts:63-110`; `scripts/no-bare-server-fetch.mjs` guards only server code.
- **Acceptance:** Codemod raw `/api` fetches in `lib/editors`, `lib/panes`, `lib/components`, `app/**/page.tsx` to `clientFetch` (prioritize editor Save paths — pairs with rel-T18-usability); add a no-bare-client-fetch CI guard (allowlist SSE/stream call sites).
- **Deps:** none.

### rel-T62 — Per-file editor registry imports (kill the phase3-barrel chunk)
- **Category:** UPDATE · **Severity:** Medium · **Effort:** S
- **Evidence:** `registry.ts:83-99` (14 slugs → `phase3-editors` barrel, ~20,445 lines); same for foundry-sub-editors/apim-editors/powerplatform/copilot-studio/azure-services.
- **Acceptance:** Point each registry entry at its per-file module; keep the barrel only for tests. Code-splitting restored.
- **Deps:** none.

### rel-T63 — Move content-bundle payloads out of the server graph
- **Category:** REORGANIZE · **Severity:** Medium · **Effort:** M
- **Evidence:** `content-bundles/index.ts:16-44` (3.1 MB static import); `apps-catalog/route.ts:88-91`; Dockerfile heap 6144.
- **Acceptance:** Bundle payloads → JSON assets or per-bundle `await import()` in `getBundle`; render the catalog list from `catalog-meta.ts` alone. Build heap can drop.
- **Deps:** none.

### rel-T64 — Split the report + semantic-model god-routes
- **Category:** REORGANIZE · **Severity:** Medium · **Effort:** L
- **Evidence:** `report/[id]/query/route.ts` 1,209; `connector-objects` 1,053; `script-visual` 811; `semantic-model/[id]/model/route.ts` 1,357.
- **Acceptance:** Extract per-backend executors into `lib/report/` modules; split `model/route.ts` A/B/C concerns into sub-routes. Behavior-preserving.
- **Deps:** none.

### rel-T65 — Centralize SQL identifier/literal quoting
- **Category:** CONSOLIDATE · **Severity:** Medium (security-adjacent) · **Effort:** M
- **Evidence:** 7+ `quoteIdent` copies; 95 inline `replace(/'/g,"''")` across 59 files.
- **Acceptance:** `lib/sql/quoting.ts` (ident + literal per dialect); migrate call sites; CI grep forbidding new inline quote-doubling in `lib/azure` + `app/api`.
- **Deps:** none.

### rel-T66 — Unify the BFF error envelope
- **Category:** CONSOLIDATE · **Severity:** Medium · **Effort:** M
- **Evidence:** respond.ts 56 / jerr 74 / 123 local `err()`; ~32 routes return raw `e.message` on 500.
- **Acceptance:** Migrate the 123 local-err files to `apiError`/`apiServerError`; alias `jerr`; ESLint rule banning new local error helpers; stop returning raw exception text (pairs with L31).
- **Deps:** none.

### rel-T67 — Delete verified dead code + finish shared-styles adoption
- **Category:** REMOVE/CONSOLIDATE · **Severity:** Medium · **Effort:** M
- **Evidence:** 7 never-imported modules (~1,263 lines), legacy report viewer, zombie `/api/data-agent/chat`; shared-styles in 13/290 editors with ~48 copies remaining.
- **Acceptance:** Delete the nine dead artifacts in one PR; finish the mechanical shared-styles migration (zero visual change, pattern proven 07-01). Dead files no longer seed stale patterns for external contributors.
- **Deps:** none.

### rel-T68 — Wire axe-core accessibility specs + fix critical violations
- **Category:** ADD · **Severity:** High (blocker B18) · **Effort:** M
- **Evidence:** `package.json:56` (`@axe-core/playwright` unused); `README.md:24` claims it; `test:a11y` matches zero tests.
- **Acceptance:** Axe scans tagged `@a11y` over the top ~20 surfaces in the Playwright harness; fix critical violations; truth the README claim. Section 508 baseline for the Gov audience.
- **Deps:** rel-T30.

### rel-T69 — Build a shared ConfirmDialog + sweep native confirm()/alert()
- **Category:** CONSOLIDATE · **Severity:** Medium · **Effort:** L
- **Evidence:** ~60 `confirm(`/`window.confirm`/`alert(` incl. Azure-destructive (`cluster-editor.tsx:409`, `lakehouse-editor-shell.tsx:849` DROP SCHEMA CASCADE, `api-marketplace.tsx:385` revokes keys; `purview-panel.tsx:280…`).
- **Acceptance:** One `<ConfirmDialog>` primitive (title/body/danger label/busy/inline error); sweep call sites, prioritizing Azure-destructive actions. Native dialogs (unthemed, suppressible) removed from destructive paths.
- **Deps:** none.

### rel-T70 — Shared unsaved-changes guard + editor autosave
- **Category:** ADD · **Severity:** High (blocker B-adjacent, usability H18) · **Effort:** M
- **Evidence:** zero `beforeunload` repo-wide; `notebook-editor.tsx:1018-1028` (Ctrl+S only); `data-pipeline-editor.tsx:851`.
- **Acceptance:** A `useUnsavedChangesGuard(dirty)` hook wiring `beforeunload` + App Router navigation interception into `ItemEditorChrome`; debounced autosave on notebook/dashboard (copy `task-flows.tsx:218-224`). Dirty work is never silently lost. Pairs with rel-T61 (clientFetch on Save).
- **Deps:** rel-T61 preferred.

---

## WAVE 5 — Docs / help / release engineering

### rel-T71 — Move engineering-diary docs out of the public nav
- **Category:** REORGANIZE · **Severity:** Medium · **Effort:** S
- **Evidence:** `mkdocs.yml:2032,2026,1701-1705`; built-but-unnav'd `no-cuts-sweep-v2.md`, `loom-feature-backlog.md`, `fabric-parity-tasks.json` still published.
- **Acceptance:** Move to `fiab/archive/` (already excluded) or extend `exclude_docs`; keep only customer-relevant pages in nav. (Overlaps rel-T02.)
- **Deps:** rel-T02.

### rel-T72 — Fix docs-site release notes
- **Category:** UPDATE · **Severity:** Medium · **Effort:** S
- **Evidence:** single 5-week-old entry; `fiab/index.md:20`.
- **Acceptance:** Point the landing link at GitHub releases (or auto-generate `docs/fiab/releases/` from release-please tags); remove the stale singleton from nav.
- **Deps:** none.

### rel-T73 — Add an "Administer" nav group (bootstrap + tenant-admin docs)
- **Category:** ADD · **Severity:** Medium · **Effort:** S
- **Evidence:** `v3-tenant-bootstrap.md`, `tenant-admin-walkthroughs.md` absent from nav though every honest-gate MessageBar references them.
- **Acceptance:** Nav group: deploy → post-deploy bootstrap → tenant-admin walkthroughs → admin pages.
- **Deps:** none.

### rel-T74 — Extend LearnPopover to remaining admin + governance/catalog pages
- **Category:** ENHANCE · **Severity:** Medium · **Effort:** M
- **Evidence:** LearnPopover on 6 of ~28 admin pages; zero on governance (18)/catalog (7).
- **Acceptance:** Extend the wave-9 LearnPopover pattern to remaining admin pages; add SectionExplainer headers to governance/catalog. (Global Help Copilot mitigates but consistency is the standard.)
- **Deps:** none.

### rel-T75 — Currency-sweep `docs/fiab/workloads/*`
- **Category:** UPDATE · **Severity:** Medium · **Effort:** M
- **Evidence:** `workloads/lakehouse.md:5,15-17,26` (pre-refactor paths; lakehouse-shortcut mis-described as Fabric-gated → no-fabric violation).
- **Acceptance:** Currency-sweep the 29 workload docs or banner each as superseded by the UAT-dated `fiab/tutorials/editor-*.md` guides. Remove Fabric-REST-dependency language.
- **Deps:** none.

### rel-T76 — Fix Learning Hub metadata drift (thumbnails, counts, orphan slug)
- **Category:** UPDATE/REMOVE · **Severity:** Low · **Effort:** S
- **Evidence:** 33 of 118 editor cards reference nonexistent thumbnails; `content.ts:8` "90 catalog item types" (actual 117); `usql-job` orphan slug (`content.ts:108,640-643`).
- **Acceptance:** Capture the 33 missing screenshots (via `csa-loom-tutorial-capture.yml`) or gate `loomThumbUrl` on a verified-thumbs set; fix/derive the count comment; remove the `usql-job` doc+slug+registry entry (uncreatable item).
- **Deps:** none.

### rel-T77 — Build or delete the "Deploy to Azure" button + mainTemplate.json
- **Category:** ADD/REMOVE · **Severity:** High (blocker B1 sibling) · **Effort:** M
- **Evidence:** `deploy-button.md:7-8,30-32`; no `mainTemplate.json`, no publishing workflow.
- **Acceptance:** Either build it (`az bicep build` in a release workflow, publish `mainTemplate.json` to Pages, add README buttons) OR delete `deploy-button.md` + its two promotions (`deployment/index.md:25`, `fiab/index.md:47`) until real.
- **Deps:** rel-T01.

### rel-T78 — Generate THIRD-PARTY-NOTICES + add a license-scan CI gate
- **Category:** ADD · **Severity:** Medium · **Effort:** S
- **Evidence:** MIT root LICENSE; scan GPL-clean but 30× LGPL (sharp), elkjs EPL, 4× MPL, CC-BY; no NOTICES file, no license CI step.
- **Acceptance:** Generate `THIRD-PARTY-NOTICES` at image build (license-checker/oss-attribution-generator); add an allowlist license gate to CI so a future GPL transitive dep fails the PR.
- **Deps:** none.

### rel-T79 — Ship a "what leaves your tenant" disclosure doc + auto-error toggle
- **Category:** ADD · **Severity:** Medium · **Effort:** S
- **Evidence:** `feedback/route.ts:27-28` (defaults upstream + hashed tenant id); auto-forward on when `LOOM_FEEDBACK_GITHUB_TOKEN` set; no tenant-settings toggle.
- **Acceptance:** One disclosure page (data, destination, redaction rules, how to disable) + a `/admin/tenant-settings` toggle for auto-error forwarding. (Redaction is already well built — this is consent/disclosure.)
- **Deps:** none.

### rel-T80 — Rehearse the self-update end-to-end
- **Category:** UPDATE · **Severity:** Medium (release-engineering gate) · **Effort:** S
- **Evidence:** `in-product-update-path.md:137-146` (ghcr publish + make-public not yet run; updater currently gates).
- **Acceptance:** One full rehearsal: tag → `publish-ghcr-images` → flip packages public → in-product roll on a live tenant → verify `/api/version`. Process-only.
- **Deps:** rel-T41.

---

## WAVE 6 — Fabric-parity feature gaps

> Re-verify each against current code first (07-01 stale-plan lesson). Sequence per the fabric-parity PRP phases where they overlap.

### rel-T81 — Unified job scheduler (P7)
- **Category:** ADD · **Severity:** Medium · **Effort:** L
- **Evidence:** only `semantic-model/[id]/refresh-schedule` + `notebook/[id]/schedule`; `fabric-parity/README.md:184` ❌ P7.
- **Acceptance:** Cosmos schedule store + cross-item scheduler with CRON wizard (no-freeform), run history, exit values, failure notifications; wire ADF/Livy/ADX job kinds through it. Bicep-synced.
- **Deps:** none.

### rel-T82 — Warehouse time-travel / CLONE / restore points / COPY INTO / snapshots (P3)
- **Category:** ADD · **Severity:** Medium (High for a warehouse audience) · **Effort:** XL
- **Evidence:** `warehouse/[id]/` route set; `fabric-parity/README.md:146-149` all ❌ P3; `PHASES.md:209`.
- **Acceptance:** On the Delta/Synapse default: SHALLOW CLONE, FOR TIMESTAMP AS OF, restore points, COPY INTO wizard, snapshots — each a real route + Fluent surface.
- **Deps:** none.

### rel-T83 — Data Wrangler (P3/P5)
- **Category:** ADD · **Severity:** Medium · **Effort:** XL
- **Evidence:** zero `wrangler` surface; `README.md:141` ❌.
- **Acceptance:** `DataWranglerPanel` (op gallery + live preview + PySpark/pandas export-to-cell) on an ACA pandas host; bicep-synced day-one.
- **Deps:** none.

### rel-T84 — PREDICT guided batch scoring (P5)
- **Category:** ADD · **Severity:** Medium · **Effort:** M
- **Evidence:** zero PREDICT surface; `README.md:152` ❌.
- **Acceptance:** PREDICT stepper (model → table column-mapping → Spark MLFlowTransformer job → scored Delta table).
- **Deps:** none.

### rel-T85 — Complete AI functions 5→9 + per-call cost stats (P5)
- **Category:** ADD · **Severity:** Medium · **Effort:** M
- **Evidence:** `ai-functions-client.ts:44-52` (5 functions); `README.md:154`.
- **Acceptance:** Add similarity, fix_grammar, generate_response, embeddings on the unified AOAI client; per-call token/cost stats in usage-chargeback.
- **Deps:** none.

### rel-T86 — Day-one OSS Airflow-on-ACA host (P1)
- **Category:** UPDATE · **Severity:** Medium · **Effort:** L
- **Evidence:** `airflow-job/[id]/connection/route.ts` (BYO-webserver only); no `airflow.bicep`; `PHASES.md:115-120`.
- **Acceptance:** `airflow.bicep` ACA host (webserver+scheduler + Postgres Flex + DAG share); item works out-of-box, Commercial + Gov.
- **Deps:** none.

### rel-T87 — Finish the people-picker item-sharing grant dialog (P4)
- **Category:** ENHANCE · **Severity:** Medium · **Effort:** M
- **Evidence:** `[type]/[id]/share/route.ts` (share-link tokens only); `item-permissions-client.ts` unrouted; `README.md:178` D.
- **Acceptance:** People-picker grant dialog wired to `item-permissions-client` on every editor; close the P4 row with evidence. (Depends on the tid/ACL model.)
- **Deps:** rel-T11.

### rel-T88 — Tabbed multitasking + object explorer (Fabric GA Apr 2026)
- **Category:** ADD · **Severity:** Medium · **Effort:** L
- **Evidence:** no `multitask`/`tabStrip` in `lib/components`; absent from PRP inventory.
- **Acceptance:** Item tab strip + cross-workspace object explorer pane in the console shell; add to the PRP platform-alm inventory.
- **Deps:** rel-T49 (workspace context).

### rel-T89 — Workspace outbound access protection (Fabric GA Mar 2026)
- **Category:** ADD · **Severity:** Medium · **Effort:** L
- **Evidence:** no "outbound access" surface; absent from PRP.
- **Acceptance:** Workspace-scoped egress allow-list (Synapse outbound firewall / NSG-Firewall egress) in the P4 governance set + PRP inventory.
- **Deps:** none.

### rel-T90 — Mirrored-DB change feed → Eventstream connector (Build 2026)
- **Category:** ADD · **Severity:** Low · **Effort:** M
- **Evidence:** no `changeFeed` in `mirror-engine.ts`.
- **Acceptance:** Delta change-data-feed reader job → Event Hubs producer path from mirrored-database into the eventstream canvas as a source.
- **Deps:** none.

### rel-T91 — DeltaFlow CDC-flatten Eventstream operator (Fabric Mar 2026)
- **Category:** ADD · **Severity:** Low · **Effort:** M
- **Evidence:** no `deltaflow` in RTI components.
- **Acceptance:** CDC-flatten operator (Debezium JSON → tabular + change-metadata columns) on the ASA-compiled eventstream canvas.
- **Deps:** none.

### rel-T92 — Estate-wide catalog search API + loom-cli find + MCP tool (Fabric Mar 2026)
- **Category:** ADD · **Severity:** Low · **Effort:** S
- **Evidence:** `iq-mcp-tools.ts` covers IQ/eventhouse only; no estate item-search endpoint/CLI verified.
- **Acceptance:** Expose the Cosmos catalog query as a search REST endpoint + `loom-cli find` + an MCP tool.
- **Deps:** none.

### rel-T93 — Loom SDK / Terraform provider + data-agent M365 publish (P7)
- **Category:** ADD · **Severity:** Low · **Effort:** L
- **Evidence:** no `loom-sdk-*`; `README.md:187` ❌; data-agent no Teams/M365 publish.
- **Acceptance:** Keep P7 sequencing; add a data-agent "publish to Teams/M365" path via the existing Copilot Studio channel plumbing; roadmap the SDK/Terraform provider.
- **Deps:** none.

### rel-T94 — Wire (or remove) the dead Fabric opt-in branches
- **Category:** UPDATE/REMOVE · **Severity:** Low · **Effort:** M
- **Evidence:** `dataflow/[id]/refresh/route.ts:38-43` (fabric always-503); `warehouse.ts:533-556` (fabric-warehouse dead-end preview).
- **Acceptance:** Either wire the opt-in Fabric refresh + Fabric-warehouse TDS-discovery paths, or remove the env knobs from docs/UI until built (an advertised backend selector that always 503s is a trust gap).
- **Deps:** none.

### rel-T95 — Re-baseline the parity ledger + add GPU-Warehouse positioning row
- **Category:** UPDATE · **Severity:** Medium · **Effort:** M
- **Evidence:** `README.md:156,170,176-179,183` stale vs shipped (Activator/UDF/DAB/protection-policies/workspace-identity); `MASTER-SCORECARD.md:491` dated 06-10; no GPU-DW row.
- **Acceptance:** One re-baseline pass over README §3 scorecard + MASTER-SCORECARD (dated rev-notes); add an honest positioning row mapping Fabric's GPU-DW → Photon/Databricks-SQL acceleration.
- **Deps:** none.

---

## WAVE 7 — Product-gap features + nice-to-have

### rel-T96 — Fix `bootstrap-catalogs` success-fabrication
- **Category:** UPDATE · **Severity:** Medium · **Effort:** S
- **Evidence:** `bootstrap-catalogs/route.ts:114-125` (swallows upsert failures, returns ok:true).
- **Acceptance:** Count only successful upserts; return `{seeded, failed}` with `ok:false`/warning when any write failed. A Cosmos RBAC/throttle failure can't masquerade as a completed seed.
- **Deps:** none.

### rel-T97 — Add pagination contract to core list APIs
- **Category:** ENHANCE · **Severity:** Medium · **Effort:** M
- **Evidence:** `workspaces/[id]/items/route.ts:35-40` (`SELECT *` fetchAll, bare array).
- **Acceptance:** Project out `state` from list responses (cheap, non-breaking); add continuation-token pagination as an additive mode before external clients freeze on the bare-array shape; virtualize 1000-item render paths.
- **Deps:** none.

### rel-T98 — Add a "Test connection" to the connection builder + require host
- **Category:** ADD · **Severity:** Medium · **Effort:** M
- **Evidence:** `connection-builder.tsx` (no test/validate; host not required).
- **Acceptance:** "Test connection" button backed by `/api/connections/test` reusing per-type clients (azure-sql/kusto/adls/eventhubs); require host for hosted types. Azure/Fabric parity per ui-parity.md.
- **Deps:** none.

### rel-T99 — In-use check + confirm dialog for connection delete
- **Category:** UPDATE · **Severity:** High (usability) · **Effort:** M
- **Evidence:** `connections/route.ts:64-75` (no referential check, destroys KV secret); `connections/page.tsx:117-124` (swallows failures, native confirm).
- **Acceptance:** Server queries dependents, returns 409 with the list; UI ConfirmDialog lists dependents, checks `{ok}`, renders errors. (Uses rel-T69 ConfirmDialog.)
- **Deps:** rel-T69.

### rel-T100 — Confirm + error-surface for workspace member removal
- **Category:** UPDATE · **Severity:** High (usability, security-relevant) · **Effort:** S
- **Evidence:** `manage-access-pane.tsx:168-176,262-264` (one-click, no confirm, swallowed errors, revokes Azure RBAC).
- **Acceptance:** Fluent confirm dialog (pattern `data-agent.tsx:1018-1046`), check response, surface failures in a MessageBar. Silent RBAC-revoke failure eliminated.
- **Deps:** rel-T69.

### rel-T101 — Truth workspace/item delete copy + orphaned-resource disclosure
- **Category:** UPDATE · **Severity:** Medium · **Effort:** L
- **Evidence:** `workspaces/[id]/route.ts:87-101` + `bulk-delete/route.ts:35-36` (Cosmos-only) vs `workspaces/page.tsx:1173-1174` / `workspace-settings-drawer.tsx:191` copy.
- **Acceptance:** Every delete confirm states provisioned Azure resources are retained (name them from item state); add an opt-in "also delete provisioned Azure resources" path or emit an orphaned-resource receipt; drop "from Cosmos" jargon. (`folders.tsx:847-848` is the honest template.)
- **Deps:** rel-T69.

### rel-T102 — Continue-on-error bulk item delete with per-item outcomes
- **Category:** UPDATE · **Severity:** Low · **Effort:** S
- **Evidence:** `folders.tsx:387-393` (stops mid-loop, unreported partial deletion).
- **Acceptance:** Continue-on-error + per-item outcome report like `workspaces/page.tsx:1150-1163`.
- **Deps:** none.

### rel-T103 — Editor chrome shows the item display name (not a GUID fragment)
- **Category:** ENHANCE · **Severity:** Low · **Effort:** S
- **Evidence:** `item-editor-chrome.tsx:116`.
- **Acceptance:** Accept an optional `displayName` prop (editors hold the query data) with the current format as fallback.
- **Deps:** none.

### rel-T104 — Wire trivially-real actions in the generic fallback editor
- **Category:** UPDATE · **Severity:** Low · **Effort:** S
- **Evidence:** `app/items/[type]/[id]/page.tsx:31-45`; `ribbon.tsx:229-236` (permanently-disabled actions).
- **Acceptance:** Wire Refresh (refetch) + Share; drop the rest from the fallback ribbon.
- **Deps:** none.

### rel-T105 — Declare the v1 support boundary (i18n + availability model)
- **Category:** UPDATE · **Severity:** Low · **Effort:** S
- **Evidence:** no i18n framework; single-region posture (`container-platform.bicep:67` zoneRedundant; cosmos failover off).
- **Acceptance:** Document "English (en-US) only" + "in-region zone redundancy + redeploy-from-git DR" as v1 support boundaries. (Pairs with rel-T40.)
- **Deps:** rel-T40.

### rel-T106 — Consolidate branding + trademark read
- **Category:** CONSOLIDATE · **Severity:** Medium · **Effort:** M
- **Evidence:** `README.md:1` / `layout.tsx:8` / `app-rag-builder.ts:71` / 14 FiaB docs / `azure.yaml:10`.
- **Acceptance:** Pick one public name for v1; sweep user-visible strings + docs landing pages (keep internal paths); get a trademark read on any name containing "Fabric".
- **Deps:** none.

### rel-T107 — Triage residual raw-JSON authoring surfaces (no-freeform)
- **Category:** UPDATE · **Severity:** Low · **Effort:** M
- **Evidence:** `foundry-sub-editors.tsx:2228` (AI Search index schema JSON); `geo-editors.tsx:327`; `map-editor.tsx:589`; `graph-editors.tsx:1096`.
- **Acceptance:** One-pass triage tagging each surface "parity JSON view (allowed)" or converting; convert the AI Search index schema box to a typed field-grid + secondary JSON-view combo.
- **Deps:** none.

### rel-T108 — Hygiene cleanups (dead deprecated routes + stale docstrings + degraded signal)
- **Category:** REMOVE/UPDATE · **Severity:** Low · **Effort:** S
- **Evidence:** `data-agent/chat/route.ts:18-35` (always-503, also in rel-T67); "Phase 1 stub" docstrings on real deploy routes; `azure-sql-editors.tsx:295-297` stale comment; best-effort Cosmos merge helpers lacking a `degraded` signal.
- **Acceptance:** Delete the dead route; rewrite stale docstrings/comments to real behavior; attach `degraded:true` to responses when Cosmos fallbacks fire so the UI distinguishes "empty" from "store unreachable".
- **Deps:** none.

---

## 3. Traceability

Every item above traces to either a **confirmed finding** in `docs/fiab/prp/RELEASE-READINESS-2026-07-02.md` (§3, with file:line evidence) or a **named mandate** (`.claude/rules/*.md` + BLOCKING memory) / **fabric-parity PRP** row (`PRPs/active/fabric-parity/{README.md,PHASES.md}`). The single refuted finding (AML tenant-topology gating) is excluded; its residual truth is folded into rel-T08 scope only where bicep-sync requires it.

**Effort roll-up:** S ≈ 46 · M ≈ 42 · L ≈ 15 · XL ≈ 5. Wave 0–1b (blockers) is the critical path to a v1 tag; Waves 2 gate Gov + teardown; Waves 3–7 raise the grade from "shippable" to A/A+.
