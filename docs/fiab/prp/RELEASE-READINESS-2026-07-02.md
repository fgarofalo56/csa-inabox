# CSA Loom — Public-Release Readiness Audit

**Date:** 2026-07-02 · **Branch:** `feat/loom-marketplace` · **Synthesis lead:** release-audit synthesis
**Inputs:** 14 dimension audits (graded) + adversarial verification of every critical/high finding + full per-dimension detail under `docs/fiab/prp/release-audit/*.md` + operator mandate checklist + infra-drift inventory.

---

## 1. Executive verdict

**NOT READY for public release.** CSA Loom is a genuinely deep, mostly-real product — the editor layer is nearly vaporware-free, the API layer is A-grade, Fabric parity is broad, the security fundamentals (AES-256-GCM sessions, parameterized T-SQL, secret-stripping) are sound, and the deployment machinery is unusually complete. But the audit confirmed a compact set of **release-blocking defects concentrated on the public-facing edges that no prior internal sweep exercised**: the documented install path is vaporware, an internet-reachable auth boundary rests on a predictable secret, the multi-user authorization model is silently broken, several deployment invariants are non-deterministic or Commercial-only, the entire 5,462-test suite runs in no CI job (and is currently red), and the public docs site leaks live estate identifiers plus operator PII.

None of these are deep architectural rewrites. The dominant theme is **"the last mile was never walked as a stranger"**: a brand-new public org hitting the README, the quickstart, the login flow, the first upgrade, and a second user in a shared workspace all hit walls. The core product a signed-in single operator uses today is largely B/A-grade. Fixing the Wave-0 blockers plus the security/access and deployment-truth items moves this to a defensible public v1.

**Bottom line:** ship-blocked on ~13 confirmed blockers (Wave 0–2 below). Estimated effort to green the gates: one focused multi-wave program (see `PRPs/active/public-release/PRP.md`).

### 1.1 Release-blocking list (must clear before public v1)

| # | Blocker | Dimension | Sev |
|---|---------|-----------|-----|
| B1 | Public onboarding funnel is documentation vaporware (azd `azure.yaml` marked SCAFFOLDED, "Deploy to Azure" button + `mainTemplate.json` + `fiab-migrate` CLI do not exist; quickstart lists Power BI Premium as a prerequisite) | product-gaps / docs-help | Critical |
| B2 | Live estate identifiers + operator PII published on the public docs site (live sub GUID, UAMI principalId, workspace GUID, 82+ `azurefd.net` hostnames, `fgarofalo@housegarofalo.com` in nav) | docs-help | High (was Critical) |
| B3 | Predictable `LOOM_INTERNAL_TOKEN = guid(rg.id, <public const>)` gates internet-reachable user-impersonation + deploy endpoints (Front Door forwards `/*`) | security | High |
| B3b | **Session-cookie signing key** falls back to the same predictable `guid(rg.id, const)` when `LOOM_SESSION_SECRET` is unset — and no shipped param file sets it, so every documented-path deploy ships forgeable sessions (session forgery → impersonation → admin via B4). `main.bicep:3863`; `commercial-full.bicepparam:215`. *Added by main-loop spot-check.* | security | High |
| B4 | `tenantId == oid` conflation makes workspace sharing + feature-grant delegation non-functional (shipped multi-user UIs have no runtime effect) | access-control | High |
| B5 | UDF "Run" silently executes the runtime's baked-in sample, not the authored source (default-on runtime, day-one) | vaporware-editors | High |
| B6 | Repo's own bicep-sync merge-blocker FAILS on this branch (`notebook-compute-pool.bicep` orphan) | deployment | High |
| B7 | Default deploy PUTs the same AAS server from two modules with different SKUs (S0 vs S1); `LOOM_AAS_SERVER` emitted 5× with conflicting values | deployment | High |
| B8 | Post-deploy bootstrap workflow is Commercial-only — Gov deploys cannot complete the ~50 mandatory bootstrap steps (contradicts all-Gov-day-one) | deployment | High |
| B9 | Teardown cannot purge the purge-protected, deterministically-named Key Vault + never purges Cognitive/APIM/AAS/Cosmos soft-deletes → redeploy-after-teardown blocked | deployment | High |
| B10 | Gov private-DNS zone list half hard-codes commercial names → GCC-High/IL5 PE DNS broken for KV/ACR/Search/Event Grid/AML/ACA | deployment | High |
| B11 | Scorecard item hard-requires a real Power BI workspace (no Azure-native path) — BLOCKING no-fabric-dependency violation | fabric-parity / no-fabric-dep | High |
| B12 | Bicep defaults BI backend to `powerbi` (Fabric-family) when AAS absent, with duplicate conflicting env entries; three PBI editors call `api.powerbi.com` on the default render path | no-fabric-dep | High |
| B13 | 5,462-test vitest suite runs in no CI workflow and is currently red (48 failures/22 files); merge-to-main auto-rolls LIVE prod with no test gate | testing | High (was Critical) |
| B19 | **App-install dialog emits `aria-hidden="true"` on the active modal** (inverted Tabster modalizer; Fluent 9.73.8/tabster 8.8.0 on React 19.2) → Section 508 break on the flagship install flow + takes down all 27 use-case-app UAT tests (vacuous `realFails=0`). Live-confirmed on 2 apps; 0 JS errors; one dependency fix re-greens all 27. `install-app-dialog.tsx` + lockfile drift from `^9.54.0`. *Live browser-walk finding.* | usability / testing | High |

**Live-walk findings (signed-in admin walk of the deployed console, 2026-07-02) — folded into the waves:** the engineering underneath graded **B+/A-** live (real Azure backends on every editor, working Copilot orchestration with real tool-calls, a 97/100 admin self-audit, honest Azure-native disclosures, nothing crashed), but the **first-time-customer experience graded C+/B-** on: (1) the B19 install-dialog a11y blocker; (2) **demo-tenant debris** — 254–436 `uat-app-*`/`tut-*`/`supercharge-*` workspaces bleeding into Workspaces, Browse (1750 items), the install picker, and Copilot answers (needs a clean seeded tenant); (3) **Governance reads as ungoverned** — live Purview wired but 0% sensitivity / 0% classification / 0 policies; (4) **no item-not-found UI** — a bogus id renders a fabricated editor over the primary lakehouse (5 console 404s) instead of a not-found state; (5) **unbranded Next.js 404 + dead `/new` route**; (6) **thundering-herd** `/api/loom/compute-targets` fired ~74× in one burst on the lakehouse editor; (7) nav redundancy (Real-Time hub vs RTI catalog; three overlapping data-finders); (8) 41 Learning-Hub walkthroughs open a **personal `fgarofalo56.github.io`** domain. All fixable in a focused pass; fixing #1–#5 makes it a confident A- demo.

Secondary gate (strongly recommended before public, not strictly blocking): B14 DR docs contradict deployed infra (claim RA-GRS/geo-Cosmos; actual ZRS/LRS single-region, failover off); B15 self-update is image-only with no schema/infra migration manifest; B16 `/api/feedback` unauthenticated + unthrottled holding a GitHub token; B17 authenticated SSRF in `/api/admin/mcp-servers/test-connection`; B18 accessibility baseline claimed (axe-core) but zero usages.

---

## 2. Per-dimension grade table

| Dimension | Grade | One-line |
|-----------|-------|----------|
| vaporware-editors | B | Editors nearly vaporware-free; UDF editor is the one real violation cluster (baked-in sample run, decorative connections/library boxes). |
| vaporware-api | A | Five prior sweeps did their job; every sampled primary-action route reaches a real Azure client; one error-swallow-into-ok:true (bootstrap-catalogs). |
| fabric-parity | B | Broad, mostly-real parity; scorecard PBI-gated (violation); tracked GA gaps (scheduler, warehouse time-travel, Data Wrangler, PREDICT); stale ledger. |
| no-fabric-dep | B | Strong at provisioner layer; default-path Power BI chain (bicep default + 3 editors calling api.powerbi.com) + Fabric-first framing are the blockers. |
| ui-navigation | C | Plumbing is well-built; IA on top is 24 flat rail slots, fragmented RTI/catalog/lineage, no sticky workspace context, orphan pages. |
| ui-consistency | B | Shared shells/primitives adopted broadly; one real CSS bug, one lineage divergence, ~562 raw-px inline styles, leftover emoji. |
| access-control | C | oid==tenant fails closed on reads but breaks all multi-user features; no OAuth state; admin gating inconsistent (some fail-open); CI guard covers ~1/4 of id routes. |
| deployment | C | Deep machinery; many manual fixes are durable, but out-of-box acceptance not satisfiable (bicep-sync fails, AAS dup SKU, Gov bootstrap gap, teardown blocked). |
| security | B | Strong crypto + injection hygiene; held back by predictable-secret auth boundary + authenticated SSRF + no OAuth state + default-off rate limiting. |
| refactor | B | Good primitives + real guardrails; adoption asymmetry (clientFetch, respond.ts, shared-styles), phase3-barrel bundling, god-files, verified dead code. |
| testing | C | Substantial assets, zero wiring: vitest in no CI + red; auto-roll to prod on merge; guardrails/reviews not required; live-validate never exits non-zero. |
| docs-help | C | A-quality item-level help dragged down by broken public entry paths + live-estate/PII leakage on the published site. |
| usability | B | Honest gates + install jobs are strong; no unsaved-work protection, delete semantics mislead, unconfirmed destructive actions, ~50 native confirm()/alert(). |
| product-gaps | C | Strong in-product infra (self-update, telemetry, feedback, chargeback); blocked by vaporware onboarding, DR-doc drift, image-only upgrade, unauth feedback. |

---

## 3. Confirmed findings by severity

> "Confirmed" = adversarially verified `isReal=true` (all critical/high were verified), or a medium/low finding whose evidence is a direct file:line pointer. Severities shown are the **corrected** severity where verification demoted the original (noted inline). Refuted findings are in the Appendix (§5) and excluded here.

### 3.1 CRITICAL

*No findings remain at Critical after verification.* The four originally-Critical findings were all demoted to High during verification (B1 stays "critical for a release audit" per the no-vaporware standard but is treated as a Wave-0 blocker alongside the Highs; B2 → High; B13's two items → High). They are listed under High below and in the blocker table.

### 3.2 HIGH (release-blocking)

**H1 — Public onboarding funnel is documentation vaporware.** `docs/fiab/deployment/quickstart.md` steps 3-4 run `azd init -t .` + `azd up`, but `platform/fiab/azd/azure.yaml:3` says "Status: SCAFFOLDED"; `docs/fiab/deployment/deploy-button.md` describes a README "Deploy to Azure" button + published `mainTemplate.json` that exist nowhere; `docs/fiab/operations/upgrade-migration.md:54-55` references a `fiab-migrate` CLI that does not exist; quickstart lists "Power BI Premium P1 or F-SKU capacity" as a prerequisite (no-fabric-dependency violation). *Verified.* (product-gaps F, docs-help; Wave 0.)

**H2 — Live estate identifiers + operator PII on the public docs site.** `docs/fiab/audit/gated-services-default-on.md:8-13` (live sub `e093f4fd…`, console UAMI principalId `41d32562…`); `docs/fiab/parity-gap/_top-level-nav-validation-2026-05-26.md` (`fgarofalo@housegarofalo.com`, in nav at `mkdocs.yml:~1704`); `docs/fiab/audit/live-e2e-every-item-and-app-…md:4` (live workspace GUID); 82 files reference live `azurefd.net` hostnames; `exclude_docs` omits `fiab/audit/`, `fiab/parity-gap/`; `docs.yml` publishes on every push to main. *Verified; severity corrected Critical → High (PII + identifiers, no credentials).* (docs-help; Wave 0.)

**H3 — Predictable internal auth secret on internet-reachable endpoints.** `platform/fiab/bicep/modules/admin-plane/main.bicep:301` `guid(resourceGroup().id,'loom-maf-internal-token-v1')` — deterministic hash of non-secret inputs; `front-door.bicep:320-333` forwards `/*`; `app/api/internal/copilot/tools/[name]/invoke/route.ts:36-70` gates only on the token then trusts caller-supplied `x-user-oid`; `app/api/iq/mcp/route.ts:63-71` falls back to the same token. *Verified.* (security; Wave 1.)

**H4 — `tenantId == oid` conflation breaks all multi-user features.** `lib/auth/feature-gate.ts:91` (`tenantId = session.claims.oid`); `admin/permissions/grants/route.ts:61` writes grants in the admin's oid partition while the grantee's lookup queries their own oid partition (never matches); `workspaces/[id]/items/route.ts:15-24,32` point-reads the workspace on the caller's own oid, so a shared workspace 404s to any second user. Fails closed (no leak) but sharing/permissions UIs are vaporware. *Verified.* (access-control; Wave 1.)

**H5 — UDF "Run" executes the runtime's baked-in sample, not the authored source.** `app/api/items/user-data-function/[id]/invoke/route.ts:73` posts only `JSON.stringify(parameters)`; loads `st.source` at :44-52 but never sends it; host supports `X-Udf-Source-B64` (`udf-runtime/app.py:22-31`) with zero senders repo-wide; `main.bicep:395` ships the runtime default-on. Day-one, Run silently runs wrong code and reports success. *Verified.* (vaporware-editors; Wave 0.)

**H6 — bicep-sync merge-blocker currently FAILS.** `node scripts/ci/check-bicep-sync.mjs` exits 1: `notebook-compute-pool.bicep` is an unwired orphan (no `module notebookComputePool` anywhere; console reads `LOOM_AML_*` the module would emit). The guard is a merge blocker in `loom-guardrails.yml:37`. *Verified.* (deployment; Wave 0/2.)

**H7 — Default deploy PUTs the same AAS server twice with different SKUs + `LOOM_AAS_SERVER` emitted 5×.** `admin-plane/main.bicep:1910` (`analysis-services.bicep`, sku S0) and `:2101` (`aas-server.bicep`, sku S1) target the identical `aasloom${uniqueString(rg.id)}` name on the default (aasEnabled) path; the console env array emits `LOOM_AAS_SERVER` at lines 2630/2646/3061/3077 (empty `loomAasServer`) plus 3183 (real). Nondeterministic SKU + the exact class behind the June "empty AAS env" live incident. *Verified.* (deployment; Wave 2.)

**H8 — Post-deploy bootstrap is Commercial-only.** `csa-loom-post-deploy-bootstrap.yml` logs in with commercial creds and never runs `az cloud set`; Gov deploy workflows have no bootstrap counterpart. MSAL app reg, Synapse SQL grants, Purview roles, Databricks SCIM, Spark PE all live only in the commercial bootstrap. Contradicts the all-Gov-day-one pillar. *Verified.* (deployment; Wave 2.)

**H9 — Teardown → redeploy blocked.** `keyvault.bicep:74-76` `enablePurgeProtection:true` + deterministic name; `fiab-teardown.sh:55` swallows the (impossible) purge; no `createMode:'recover'`. Teardown also never purges Cognitive/APIM/AAS/Cosmos soft-deletes (deterministic names) — redeploy hits `FlagMustBeSetForRestore` / name-reserved. Breaks the quarterly teardown-redeploy `no-vaporware.md` mandate. *Verified.* (deployment; Wave 2.)

**H10 — Gov private-DNS zones half hard-code commercial names.** `admin-plane/network.bicep:372-390` — `vaultcore.azure.net`, `azurecr.io`, `search.windows.net`, `eventgrid.azure.net`, `azureml.ms`, `notebooks.azure.net`, `{location}.azurecontainerapps.io`, `azconfig.io` have no GCC-High/IL5 branch while sibling zones do. PE DNS won't resolve on Gov. *Verified.* (deployment; Wave 2.)

**H11 — Scorecard hard-requires a real Power BI workspace.** `scorecard-editor.tsx:60` fetches `/api/powerbi/workspaces`; `:116-131` dead-end "Create one in Power BI"; every editor action gates on a PBI `workspaceId`; a Cosmos-native fallback exists in the BFF but is unreachable from the editor. `app/api/items/scorecard/route.ts:8` imports `listScorecards` from `powerbi-client`. Catalog copy (`power-bi.ts:108-111` `noRestApi:true`) contradicts the code. BLOCKING no-fabric-dependency violation. *Verified.* (fabric-parity / no-fabric-dep; Wave 0.)

**H12 — Default BI backend chain lands on Power BI (Fabric-family).** `admin-plane/main.bicep:2893` sets `NEXT_PUBLIC_LOOM_BI_BACKEND='powerbi'` when AAS absent (aasEnabled default false), and the same app repeats the var at 3075-3076 from `loomBackends.bi` (default `''`) — duplicate conflicting env in one app. `report-editor.tsx:1268` makes `'powerbi'` the default report editor. Plus three editors call `api.powerbi.com` on their default render path: `semantic-model-editor.tsx:1052-1057` (only `aas` branches away), `dashboard-editor.tsx:52-56` (unconditional), `paginated-report-editor.tsx:198-199` (probes to decide the opt-in tab). *Verified (dashboard severity corrected High → Medium; the bicep default + semantic-model remain High).* (no-fabric-dep; Wave 0.)

**H13 — Vitest suite runs in no CI + is red; merge auto-rolls prod with no test gate.** No `.github/workflows/*` runs the 5,462-test console suite; local run 2026-07-02 = 48 failing / 22 files (admin routes, every AI-assist route, catalog search/register). `build-fiab-images-acr-tasks.yml` on push:[main] → `loom-roll-and-validate.yml` rolls the live Container App, validated only by ~6 unauthenticated curls. *Verified; severity corrected Critical → High.* (testing; Wave 1.)

**H14 — DR docs contradict deployed infra; no tested restore runbook.** `disaster-recovery.md:25` claims GRS/RA-GRS and `:35` Cosmos geo-replication; actual `storage.bicep:52` ZRS, `main.bicep:1717/1781/1840` LRS, `loom-console-cosmos.bicep:71-73` single-region + failover disabled (PITR 7d only). *Verified.* (product-gaps; Wave 2.)

**H15 — Self-update is image-only, no schema/infra migration mechanism.** `in-product-update-path.md:85-89` — POST PATCHes each app's image; new-release env vars/RBAC arrive only via bicep redeploy; no min-infra-version or migration manifest in preflight. First real infra-adding release breaks silently. *Verified.* (product-gaps; Wave 2.)

**H16 — `/api/feedback` unauthenticated + unthrottled while holding a GitHub token.** `app/api/feedback/route.ts:47-56` no `getSession()`, no server throttle; forwards to `api.github.com` with `LOOM_FEEDBACK_GITHUB_TOKEN`; only cap is client-side (bypassable via curl). Public abuse vector on every deployed console origin. *Verified.* (product-gaps; Wave 1.)

**H17 — Accessibility baseline claimed but never tested.** `package.json:56` declares `@axe-core/playwright`; `README.md:24` claims axe-core testing; repo-wide grep finds no `AxeBuilder`/axe usage. `pnpm test:a11y` matches zero tests. Section 508/VPAT matters for the Gov audience. *Verified.* (product-gaps / testing; Wave 4.)

**H18 — No unsaved-changes protection anywhere.** Zero `beforeunload` handlers repo-wide; `notebook-editor.tsx:1018-1028` has only a Ctrl+S handler (no autosave, no nav guard). Any nav click or tab close silently discards dirty work; compounded by editors saving with bare `fetch` (a lapsed session turns Save into an unrecoverable error). *Verified.* (usability; Wave 3.)

**Reported-High (evidence-backed, not separately re-verified):** removing a workspace member is one unconfirmed click with swallowed errors that revokes Azure RBAC (`manage-access-pane.tsx:168-176`); connection delete has no in-use check, destroys the KV secret, and swallows failures (`connections/route.ts:64-75`, `connections/page.tsx:117-124`); console README declares the flagship "SCAFFOLDED, v1 ships 12 panes" (`apps/fiab-console/README.md:10-13`); root README never introduces CSA Loom (*verified, severity corrected High → Medium*). (usability, docs-help; Waves 3–5.)

### 3.3 MEDIUM

Grouped by dimension; each is a direct file:line finding. (High-verified findings demoted to Medium are noted.)

**no-fabric-dep / fabric-parity framing**
- M1 DashboardEditor unconditionally calls `api.powerbi.com` on mount, no opt-in branch (`dashboard-editor.tsx:52-56`). *Verified, demoted High → Medium (item still functional Azure-native).*
- M2 PaginatedReportDesigner probes `api.powerbi.com` on the default render to decide the opt-in tab (`paginated-report-editor.tsx:198-199`).
- M3 `/new` cards + Learn copy for semantic-model/report/dashboard/paginated-report lead with "live Power BI REST" though default is Loom-native (`power-bi.ts:15,39,63,87`). Fabric-first-framing class.
- M4 Activator editor's Loom workspace picker shows "No Power BI workspaces — Create one in Power BI" (`activator-editor.tsx:62,103-114`).
- M5 UDF "Generate invocation code" emits Fabric-only client code (`mssparkutils`, `api.fabric.microsoft.com`) unusable against the Azure default backend (`user-data-function-editor.tsx:188,191`).
- M6 UDF "Manage connections (Fabric data sources)" is a decorative freeform box with no consumer (`user-data-function-editor.tsx:272-273`) — also a no-freeform-config violation.
- M7 UDF "Library management" persists a library list nothing installs; runtime is stdlib-only (`user-data-function-editor.tsx:276-301`).
- M8 UDF invoke route's per-item overrides (`state.azureFunctionUrl`/`functionKeySecret`) have no editor UI (`self-audit.ts:548`).

**fabric-parity gaps (tracked, GA-in-Fabric)**
- M9 No unified job scheduler (`README.md:184` ❌ P7). *Verified, demoted High → Medium (known-tracked, not a regression).*
- M10 Warehouse missing time-travel/CLONE/restore-points/COPY INTO/snapshots (`warehouse/[id]/` route set; README:146-149). *Verified; High for a release audit but tracked P3.*
- M11 Data Wrangler entirely absent (`README.md:141` ❌ P3/P5). *Verified.*
- M12 Parity ledger stale in both directions (Activator/UDF/DAB/protection-policies marked D/❌ though shipped; PBI-gated Scorecard marked built; MASTER-SCORECARD dated 06-10).
- M13 AI functions 5 of 9 (missing similarity/fix_grammar/generate_response/embeddings) (`ai-functions-client.ts:44-52`).
- M14 Airflow is BYO-webserver only; day-one OSS `airflow.bicep` host unbuilt (`airflow-job/[id]/connection/route.ts`).
- M15 PREDICT guided batch scoring absent (`README.md:152` ❌ P5).
- M16 Item "sharing" is share-link tokens only; people-picker grant dialog only partially evidenced (`[type]/[id]/share/route.ts`; `item-permissions-client.ts` unrouted).
- M17 Tabbed multitasking + object explorer (Fabric GA Apr 2026) absent and untracked.
- M18 Workspace outbound access protection (OAP, Fabric GA Mar 2026) unbuilt + untracked.

**access-control / security**
- M19 OAuth code flow has no `state`/PKCE → login CSRF / session fixation (`sign-in/route.ts:88-93`, `callback/route.ts:231-251`). *Verified, demoted High → Medium.*
- M20 `isTenantAdminTier` fails OPEN when admin env unset, exposing org-wide capacity/cost/compute-warm to any authenticated user (`domain-role.ts:69-74,199-209`).
- M21 CI route-guard only scans items/admin/adx — ~a dozen id-taking route groups unchecked (`check-route-guards.mjs:69-71`).
- M22 `data-products/[id]/preview` bypasses the access-request gate and discloses 25 rows of any product (`preview/route.ts:50-64,97-100`).
- M23 `notebook/[id]/contents` ignores `[id]`, path-addressable on a shared file share (`contents/route.ts:51-86`).
- M24 Authenticated SSRF in `/api/admin/mcp-servers/test-connection` (no admin gate, no URL/scheme/private-IP restriction) (`test-connection/route.ts:21-27`).
- M25 Rate limiting default-OFF, wired into only 4 routes (`rate-limiter.ts:69-71`).

**ui-navigation** (all *verified, demoted High → Medium* — real UX/IA gaps, nothing broken)
- M26 Left rail = 24 flat, ungrouped destinations; single-item-type pages promoted to global nav (`nav-items.ts:18-43`).
- M27 RTI fragmented across 4 rail slots + a 5th orphan page duplicating title "Activator" (`nav-items.ts:30-33`; `activator/page.tsx`, `activator-hub/page.tsx`).
- M28 Three catalog destinations in rail + a fourth in Governance, non-predictive labels (`nav-items.ts:21-23`; `governance-shell.tsx:22`).
- M29 Three lineage surfaces with three names; "Purview lineage" explicitly does not use Purview (`nav-items.ts:26`; `catalog-shell.tsx:19`; `governance-shell.tsx:23`).
- M30 No sticky workspace context (no switcher, no editor breadcrumb; dead `lib/stores/ui.ts` built for it).
- M31 Create flow: no "Create" rail entry; NewItemDialog silently mints Cosmos items into the "newest" workspace with no picker (`new-item-dialog.tsx:7-16,239-260`).
- M32 Orphan pages: `/apps`, `/workloads`, `/data-products`, `/activator`; bare `/experience` + `/experience/data-science` hard-404.
- M33 Internal codenames as primary nav labels ("Mesh lineage", "Warp", "RTI catalog").
- M34 User-plane rails deep-link into `/admin`; "Setup & landing zones" shown to all users lands non-admins in the admin plane.

**ui-consistency**
- M35 Invalid CSS `var()+alpha` suffix drops the Governance Copilot chip background (`govern-admin.tsx:241`).
- M36 governance/lineage hand-rolls its own SVG graph + duplicate color map instead of the shared LineageCanvas (`governance/lineage/page.tsx:77-90,324`).
- M37 ~562 raw-px inline gap/padding/margin values across 112 files (hotspots: manage-panel 31, deployment-pipelines-pane 26, env-config-pane 25); web3-ui token violation.
- M38 governance/policies New-policy dialog uses 16 raw-px gaps (`policies/page.tsx:606…`).

**deployment / testing / product-gaps (medium)**
- M39 No-vaporware acceptance test unsatisfiable: first-run `deployAppsEnabled=true` references images in the empty ACR (`commercial-full.bicepparam:224`; `main.bicep:2376`).
- M40 `gh-runner-job.bicep` dead code defeats the orphan guard via its own commented example (`gh-runner-job.bicep:25`; guard doesn't strip comments).
- M41 Deploy + bootstrap not chained; bootstrap defaults are the operator's private estate GUIDs/UAMI/Databricks host (`csa-loom-post-deploy-bootstrap.yml:44-71`).
- M42 Bootstrap flips the PE-only KV fully public from a public runner, restore only via in-step trap (`…bootstrap.yml:190-214`).
- M43 Four root-level test files (incl. registry-coverage) excluded by vitest include globs — never run (`vitest.config.ts:46-49`).
- M44 No ESLint gate for the console anywhere (`next.config.mjs:12`).
- M45 CodeQL not PR-gated; Trivy runs on PR but not required.
- M46 No coverage measurement/floor for the console suite.
- M47 Loom Guardrails not a required status check (*verified, demoted High → Medium*); zero required approving reviews on main (*verified, demoted High → Medium*).
- M48 `csa-loom-validate` computes hard-failure count but never exits non-zero (`csa-loom-validate.yml:97-99`). *Verified.*
- M49 No E2E/journey test on PR or pre-release; weekly one only probes admin health. *Verified.*
- M50 Core list APIs unbounded — workspace items = `SELECT *` fetchAll of full docs, no pagination contract (`workspaces/[id]/items/route.ts:35-40`).
- M51 Branding split three ways (CSA-in-a-Box / CSA Loom / FiaB) + "Fabric" trademark exposure in user-visible strings.
- M52 No THIRD-PARTY-NOTICES / license-scan CI gate (scan is GPL-clean; LGPL/EPL/MPL attribution required).
- M53 No Azure-quota pre-flight in the setup/deploy wizard despite quota being a known deploy-killer.
- M54 Phone-home feedback/crash telemetry lacks an operator disclosure doc + admin toggle for auto-error forwarding.
- M55 Headline self-update capability never rehearsed end-to-end (ghcr publish + make-public not yet run).

**docs-help (medium)**
- M56 Internal working artifacts in the public site nav (agent "Next-session kickoff" prompt, stale UAT/parity dumps) (`mkdocs.yml:2032,2026,1701-1705`). *Verified, demoted High → Medium.*
- M57 Docs-site release notes = single 5-week-old entry linked as "Recent".
- M58 Day-one admin docs (tenant bootstrap, tenant-admin grants) missing from site nav.
- M59 LearnPopover contextual help stops at 6 of ~28 admin pages; zero on governance/catalog.
- M60 `docs/fiab/workloads/*` editor references drifted (stale gates + pre-refactor paths; lakehouse-shortcut mis-described as Fabric-gated).

**vaporware-api / bootstrap correctness (medium)**
- M61 `bootstrap-catalogs` returns `ok:true` with "seeded" counts that include swallowed upsert failures (`bootstrap-catalogs/route.ts:114-125`).

**usability (medium)**
- M62 Connection builder has no "Test connection" and does not require host — bad creds saved silently (`connection-builder.tsx`).
- M63 "New item" from home silently targets the newest workspace + races the workspace-list fetch (`new-item-dialog.tsx:253-260`).
- M64 ~50 destructive/error paths use native `window.confirm()`/`alert()` instead of the product's Fluent dialogs (web3-ui violation; some are Azure-destructive).
- M65 Setup-wizard deploy progress not survivable — refresh mid-deploy loses tracking + invites a duplicate deploy (`setup-wizard.tsx:496,701-726`).
- M66 Session-expiry auto-recovery lives only in clientFetch; most editors Save with bare fetch (`client-fetch.ts:57-110`; 21 clientFetch across 10 of ~95 editor files).

**refactor (medium)**
- M67 277 client components bypass clientFetch — no timeout, no sliding-session 401 recovery (*verified, demoted High → Medium*).
- M68 Editor registry dynamic-imports the phase3 barrel — one ~20k-line chunk for 14 item types (`registry.ts:83-99`) (*verified, demoted High → Medium*).
- M69 content-bundles: 3.1 MB / ~37k lines statically imported into the server graph (build-OOM driver) (`content-bundles/index.ts:16-44`).
- M70 Report god-routes: 1,209-line multi-backend query route + 1,357-line semantic-model route.
- M71 SQL ident/literal escaping re-implemented 7+ times; inline quote-doubling in 59 files (security-adjacent).
- M72 Three generations of BFF error helper coexist (respond.ts 56 / jerr 74 / 123 local `err()`).
- M73 Verified dead code: 7 never-imported modules (~1,263 lines) + legacy report viewer + zombie `/api/data-agent/chat` route.
- M74 shared-styles adopted by 13/290 editors; ~48 copies of the same style blocks persist.
- M75 Editor god-files (lakehouse-shell 4,980; report-designer 4,809; semantic-model 3,801; apim 3,421).

### 3.4 LOW

Consolidated (each is a direct pointer; full text in the per-dimension detail files):

- L1 Stale "ARM mutation BFF deferred" comment contradicts shipped Firewall/AAD-admin dialogs (`azure-sql-editors.tsx:295-297`).
- L2 Dead deprecated `/api/data-agent/chat` permanently 503 (`data-agent/chat/route.ts:18-35`).
- L3 Stale "Phase 1 — deploy stub" docstrings on now-real deploy routes (data-agent, operations-agent).
- L4 `LOOM_DATAFLOW_BACKEND=fabric` opt-in branch always 503s ("not wired in this build") (`dataflow/[id]/refresh/route.ts:38-43`).
- L5 Dashboard-builder preview fabricates labeled "Sample N" tables (disclosed) (`org-visuals/dashboards/render/route.ts:101-112`).
- L6 Best-effort Cosmos merge helpers silently degrade to empty lists on outage (no `degraded` signal).
- L7 Data-product Datasets tab leads with "OneLake / Fabric lakehouse" + onelake.dfs example URL (`apim-editors.tsx:3134,3141`).
- L8 Tenant-settings "Mirroring" copy says "into OneLake" though default is ADF CDC → ADLS (`tenant-settings.ts:147`).
- L9 Stale kql-dashboard provisioner header documents the forbidden "bind a Fabric workspace" gate (`kql-dashboard.ts:28-29`).
- L10 Notebook provisioner reaches Fabric without env opt-in when a workspace is bound + no Azure engine (`notebook.ts:324-352`).
- L11 Opt-in `LOOM_WAREHOUSE_BACKEND=fabric-warehouse` is a dead-end preview (always remediation) (`warehouse.ts:533-556`).
- L12 Mirrored-DB change feed → Eventstream connector (Build 2026) missing.
- L13 DeltaFlow CDC-flatten Eventstream transformation (Fabric Mar 2026) missing.
- L14 OneLake catalog search API / MCP tool / CLI find (Fabric Mar 2026) unverified in loom-cli + MCP tools.
- L15 No published Loom SDK / Terraform provider (P7); data-agent no M365-Copilot publish.
- L16 GPU-Warehouse positioning (Photon/Databricks-SQL accel) silent in parity docs.
- L17 Leftover emoji glyphs in four editors (activator, data-agent, pipeline).
- L18 governance/data-quality page 15 raw-px; scans drawer hard-coded font sizes; usage-chargeback `padding:48`.
- L19 Three list panes render text-only empties instead of EmptyState.
- L20 Three sanctioned card-grid dialects coexist + ~80 local copies.
- L21 Internal service token trusts caller-supplied `x-user-oid` (impersonation within trust boundary).
- L22 Auth callback reflects AAD exchange error detail into redirect URL (`callback/route.ts:307-309`).
- L23 Admin routes lack a shared authz gate; `mcp-servers` CRUD uses only `getSession()`.
- L24 Eventstream provisioner remediation names the wrong env var (`LOOM_EVENTHUBS_NAMESPACE` vs real singular) (`eventstream.ts:133`).
- L25 Stale orphan-allowlist entries (udf-runtime, legacy azure-maps) erode the bicep-sync guard.
- L26 Gov gets no Azure Maps despite Azure Maps being in Azure Government (`atlas.azure.us` CSP gap).
- L27 Editor chrome titles items by GUID fragment instead of the user's chosen name (`item-editor-chrome.tsx:116`).
- L28 Generic fallback editor renders a ribbon of permanently-disabled actions.
- L29 Admin portal nav link visible to all users; non-admins discover status via per-page errors.
- L30 Bulk item delete stops mid-loop on first failure with an unreported partial deletion (`folders.tsx:387-393`).
- L31 Legacy BFF routes return raw exception text to the client (respond.ts sanitizer opt-in).
- L32 Residual raw-JSON authoring surfaces need no-freeform triage (AI Search index schema, GeoJSON, graph docs).
- L33 33 of 118 Learning Hub editor cards reference thumbnails that don't exist.
- L34 Stale comment: Learn registry header claims "90 catalog item types" (actual 117).
- L35 `usql-job` tutorial + Learn registry entry orphaned from the catalog (uncreatable item).
- L36 i18n absent — English-only hard-coded strings (declare v1 boundary).
- L37 Single-region availability posture defensible for v1 but must be stated as a limitation.
- L38 Test code excluded from the only type-check; `guard:circular` + from-scratch smoke test not wired/continue-on-error; stale CI comments (types-not-enforced, no perf gate).

---

## 4. Positive verifications (do not re-litigate)

The audit **confirmed durable** the following, closing prior drift-list items (record as closed so future audits skip them):

- ADF managed VNet + Managed IR + managed-PE to the PE-only lake — fully in bicep (`landing-zone/adf.bicep:151-192`), closing GH task #7.
- Event Hubs namespace deploys by default; Synapse SQL Administrator grant is a bicep deploymentScript (`synapse.bicep:626`); Spark managed-PE fix is a first-class bootstrap step; Azure Maps commercial wiring end-to-end.
- Env-sync guard: reads=494, emitted=444, missing=0 (zero unallowlisted gaps).
- vaporware-api: every sampled primary-action route reaches a real Azure client; `lib/clients` has zero fabricated success responses.
- Security fundamentals: AES-256-GCM cookie sessions with HKDF-separated keys, parameterized T-SQL, secret-stripping MCP views, hashed UPNs, current deps.
- Item-level help: 117/117 catalog editors have real per-editor docs, auto-generated with dated screenshots + dual Loom/MS-Learn links + a CI link-integrity gate.

---

## 5. Refuted / demoted findings appendix

**Refuted (isReal=false — dropped):**

- **"AML workspace + default Compute Instance deploy ONLY in single-DLZ; tenant/dlz-attach ships notebooks AML-gated"** (deployment, orig. High). The cited bicep gates are accurate, but the claimed *consequence* is false: `admin-plane/main.bicep:3696` sets `LOOM_AML_WORKSPACE` with a fallback to the always-deployed AI Foundry hub (a real `MachineLearningServices/workspaces` kind=Hub); the per-user Compute Instance flow is default-ON (`aml-client.ts:432` `LOOM_AML_PERUSER_ENABLED` defaults `'true'`); and the notebook default execution backend is Synapse Spark Livy, not AML. Residual truth is only a minor enhancement gap (no warm dedicated CI in tenant topology) — captured as a Low, not a blocker.

**Demoted (isReal=true, severity corrected — reflected in §3):**

| Finding | Orig | Corrected | Why |
|---------|------|-----------|-----|
| Live estate IDs + PII on docs site | Critical | High | PII + identifiers, no credentials/secrets |
| Deploy-to-Azure button vaporware | Critical | High | Docs-only dead-end; working paths exist |
| Vitest never runs + red | Critical | High | Process/test gap, not a live defect; build type-check still gates |
| Merge-to-main auto-rolls prod | Critical | High | Auto-rollback + build gate mitigate; still real risk |
| No unified job scheduler | High | Medium | Known-tracked P7, not a regression |
| DashboardEditor calls api.powerbi.com | High | Medium | Item still fully functional Azure-native |
| Left rail 24 flat / RTI frag / 3 catalogs / 3 lineages / no workspace context | High | Medium | UX/IA gaps; everything renders + works |
| OAuth no state | High | Medium | Login CSRF/fixation (confused-deputy), not account takeover |
| isTenantAdminTier fail-open | (kept Medium) | Medium | Real, unconfigured-deploy exposure |
| 277 bypass clientFetch | High | Medium | Robustness/UX, not a functional break |
| phase3-barrel bundling | High | Medium | Bundle-size, no correctness impact |
| Loom Guardrails not required / 0 required reviews | High | Medium | CI-config + single-operator model |
| Root README no Loom intro | High | Medium | Docs/onboarding gap |
| Internal artifacts in public nav | High | Medium | Docs hygiene, no functional impact |
| Workspace/item delete no teardown | High | Medium | Errs safe (orphans, no data loss) |

---

## 6. Release-gate checklist

A public v1 tag may be cut only when **all Wave-0 and Wave-1 items are green** and Wave-2 deployment-truth items are green or explicitly waived with a documented limitation.

- [ ] **G1 (Wave 0, no-vaporware):** quickstart rewritten to the proven `az deployment sub create` + bootstrap path; deploy-button/`fiab-migrate`/Power-BI-prereq references removed or built; console + root README describe the shipped product.
- [ ] **G2 (Wave 0, privacy):** `fiab/audit/`, `fiab/parity-gap/`, `fiab/design/`, agent-kickoff docs excluded from the published site; GUID/hostname/email redaction sweep run; CI hygiene grep for live coordinates in `docs/`.
- [ ] **G3 (Wave 0, no-fabric-dep):** scorecard has an Azure-native/Cosmos default; bicep BI-backend default no longer `powerbi`, single env pair; semantic-model/dashboard/paginated-report call `api.powerbi.com` only on the `powerbi` opt-in branch; four `/new` copy blocks re-led with the Loom-native default.
- [ ] **G4 (Wave 0, vaporware):** UDF Run forwards `x-udf-source-b64` (or publishes source); decorative UDF connections/library boxes replaced or honest-gated.
- [ ] **G5 (Wave 1, security):** `LOOM_INTERNAL_TOKEN` derived from a KV-random secret; `/api/internal/*` blocked at Front Door; MCP test-connection SSRF fixed (admin gate + scheme/private-IP block); OAuth `state`+PKCE; `/api/feedback` authenticated + server-throttled; rate limiting default-on for expensive routes.
- [ ] **G6 (Wave 1, access):** tenant-shared data partitioned by `tid` with per-resource ACLs so sharing + delegated grants resolve for a second user; `isTenantAdminTier` fails closed; CI route-guard widened to all id-taking route groups; data-product preview + notebook contents per-user scoped.
- [ ] **G7 (Wave 1, testing):** vitest job added to `fiab-console-ci`, made a required check, 48 failures burned down; guardrails + ≥1 review required on main; `csa-loom-validate` exits non-zero on hard FAILs; pre-traffic gate (vitest + loom-uat job) before the prod roll.
- [ ] **G8 (Wave 2, deployment-truth):** `notebook-compute-pool.bicep` wired (bicep-sync green); single AAS owner + single SKU + one `LOOM_AAS_SERVER`; Gov bootstrap path (or cloud-agnostic composite); teardown purges KV/Cognitive/APIM/AAS/Cosmos soft-deletes; Gov private-DNS zones boundary-branched.
- [ ] **G9 (Wave 2, product-truth):** DR doc truthed to single-region + PITR + one tested Cosmos restore runbook; self-update compatibility manifest (required env/min-bicep) in the `/admin/updates` preflight; from-scratch acceptance test names the canonical `full-app-deploy-commercial.yml` path.
- [ ] **G10 (Wave 4, a11y):** axe-core specs over the top ~20 surfaces, critical violations fixed, README claim truthed.
- [ ] **G11 (release engineering):** one full self-update rehearsal (tag → publish-ghcr → flip public → in-product roll → verify `/api/version`); THIRD-PARTY-NOTICES generated + license gate in CI.

---

*Companion deliverable: the full remediation program is specified as numbered, waved items in `PRPs/active/public-release/PRP.md` (index at `PRPs/active/public-release/README.md`).*
