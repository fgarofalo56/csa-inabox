# loom-next-level — Workstreams V (Production Verification Depth) & DR (Disaster-Recovery Drills)

> Draft for the master PRP `loom-next-level`. Two workstreams, each a set of
> individually-shippable PR-sized items. Workstream **V is the #1 priority of
> the whole PRP** — it closes the class of failure that shipped on 2026-07-19
> (MSAL secret drift broke ALL sign-in while minted-session verify stayed green)
> and 2026-07-15 (GuidedPickerRail passed every CI gate then hard-froze the live
> renderer). The through-line: **CI green is not production green.** Every item
> here adds a check that runs against the *live, real-data* deployment, in the
> browser, on the real login path — the exact blind spots the current gates have.

## Shared conventions (bake into every item)

Each item below carries: **Goal**, **Files** (exact create/change paths),
**Backend/Infra** (bicep module per `no-vaporware.md` bicep-sync), **Env vars**
(each new var added to `apps/fiab-console/lib/admin/env-checks.ts:ENV_CHECKS`
AND enriched in `apps/fiab-console/lib/gates/registry.ts:GATE_META` with a G2
Fix-it per `ux-baseline.md`), **Acceptance** (incl. a G1 in-browser / real-data
E2E receipt per `loom_browser_e2e_before_done`), and a **Per-cloud** section:

- **Commercial** — live, `centralus`, sub via `loom-roll-and-validate.yml`
  (RG `rg-csa-loom-admin-centralus`, ACR `acrloomk6mvh5sm6z7do`, app
  `loom-console`, FD `https://csa-loom.limitlessdata.ai`).
- **Azure Government (GCC-High)** — live; endpoint suffix `.us`
  (`*.azurefd.us`, `*.documents.azure.us`, Log Analytics `.us` audience via
  `lib/azure/cloud-endpoints.ts`); deploy SP `csa-loom-gov-deploy`
  (`c63f4919…`); roll via `gov-console-roll.yml`. Some services GCC-unavailable
  (ADT / AAS / Azure Maps) — gates already tolerate this.
- **IL5 / air-gapped** — **DESIGN CONSTRAINT ONLY, do not build.** Document the
  adaptation (no public GitHub-hosted runners → self-hosted `gh-aca-runner`
  KEDA job in-enclave; no `api.github.com` → mirror; no cross-tenant egress →
  alert sinks stay in-boundary).

Every ENV_CHECKS addition MUST also set `provisionedBy:` (the bicep module that
wires it) so a fresh push-button deploy fills it with zero operator input, per
`loom_default_on_opt_out`.

### What already exists (reuse — do NOT rebuild)

| Asset | Path | Reuse for |
|---|---|---|
| In-VNet UAT runner | `apps/fiab-console/e2e/run-uat-unattended.mjs` | V1/V2/V3 execution shell; emits `UAT_RESULT pass/fail/realFails/infraGated`, uploads artifacts to Blob (`LOOM_UAT_RESULTS_CONTAINER`+`LOOM_UAT_RESULTS_ACCOUNT`, `DefaultAzureCredential`) |
| Minted-session harness | `apps/fiab-console/e2e/_lib/uat.ts` (`mintSession`, `signIn`, `createWorkspace`, `createItem`, `pollInstallJob`, `cleanupWorkspaces`, `recordVerdict`, `NAV_PAGES`) | journey auth (no MSAL), workspace/item lifecycle, verdict log |
| Session mint (raw) | `apps/fiab-console/e2e/auth/mint-session.ts`, `mint-cookie.mjs`, `global-setup.ts` | storageState minting |
| Ten-journey smoke | `apps/fiab-console/e2e/ten-journey.uat.ts` | journey spec pattern (API-level, honest-gate aware) |
| A11y slice | `apps/fiab-console/e2e/a11y.uat.ts` (`@axe-core/playwright`, `wcag2a/2aa/section508`, `A11Y_MIN_IMPACT` default `serious`) | V3 is a **ratchet on this**, not a rebuild |
| Visual markers spec | `apps/fiab-console/e2e/loom-visual-validate.spec.ts` (feature-marker DOM probe) | superseded by V2's true screenshot-diff for the surface list |
| Playwright projects | `apps/fiab-console/playwright.config.ts` (`uat`/`family-walkthrough`/`mint`/`verify`/`publish-version`) | add `journey`, `visual`, projects |
| Roll gate | `.github/workflows/loom-roll-and-validate.yml` (starts `loom-uat` ACA job, polls to completion, auto-rollback) | post-roll trigger for V1/V2; DR alerting pattern |
| Default alerts + action group | `platform/fiab/bicep/modules/admin-plane/monitoring-default-alerts.bicep` (`defaultActionGroup` `Microsoft.Insights/actionGroups`, `scheduledQueryRules`, `alertEmail`, `notifyOwners` ARM-role receiver, `LOOM_ALERT_RG`) | alerting sink for V1 + DR |
| Health surfaces | `app/admin/health/page.tsx` (`HealthPane`+`ServiceExercisePane`), `app/admin/performance/page.tsx`, `app/admin/gates/page.tsx` | admin render targets |
| Health APIs | `app/api/health/route.ts` (liveness), `app/api/health/deep/route.ts` (Cosmos+LAW probe), `app/api/monitor/health/route.ts` (ResourceHealth) | reuse `probeCosmosReachable`, deep-probe pattern |

---

# WORKSTREAM V — PRODUCTION VERIFICATION DEPTH  *(PRP #1 priority)*

Five items. **V1** (synthetic journeys incl. real MSAL login probe) is the
single highest-value item in the PRP — ship it first.

## V1 — Synthetic user-journey monitoring (scheduled, in-VNet, real-login-aware)

**Goal.** A scheduled (cron) in-VNet Playwright job that runs ~5 real
end-to-end journeys against the LIVE deployment every 15 min, using **two**
auth paths so it is not blind to broken login the way minted-session-only
monitoring was on 2026-07-19:

1. **Minted-session path** (existing `mintSession()`) — exercises the app’s
   real BFF + backends without MFA. Proves the *app* works.
2. **True MSAL login-path probe** (NEW) — drives `/auth/sign-in` →
   Entra authorize → `/auth/callback` → lands authenticated, using a
   **non-interactive ROPC or a dedicated automation account credential** from
   Key Vault, then asserts a `loom_session` cookie was actually minted by the
   *real* callback (not our test mint). Proves *sign-in itself* works. This is
   the check that would have caught `AADSTS7000215` while `verify` stayed green.

The five journeys (each asserts a REAL backend outcome, honest-gate aware per
`ten-journey.uat.ts` semantics):

| # | Journey | Route(s) / action | Backend asserted |
|---|---|---|---|
| J1 | **Login** | `/auth/sign-in` → Entra → `/auth/callback` (MSAL path) | real `loom_session` minted by callback; `/api/me` 200 with claims |
| J2 | **Create item** | `POST /api/workspaces` (domain=`default`) → `POST /api/workspaces/{ws}/items` (type `lakehouse`) | Cosmos write; item doc returned with id |
| J3 | **Open editor + run primary action** | nav `/items/lakehouse/{id}` → click "Run"/"New table" → real ADLS/Synapse call | 2xx receipt body (or honest 503 gate), editor chunk mounted |
| J4 | **Query data** | `/onelake` or notebook → execute a SELECT / KQL `print 1` | real TDS/KQL response rows |
| J5 | **Share / marketplace** | `/marketplace` publish → subscribe → `/api/external-shares` or Delta Share grant | grant persisted; subscribe returns access token/manifest |

**Files.**
- `apps/fiab-console/e2e/synthetic-journeys.uat.ts` — NEW. Five `test()`s using
  `_lib/uat.ts` helpers; J1 uses the new `loginViaMsal()` helper; all seed into
  one `synthetic-journey-*` workspace and tear down in `afterAll`
  (`cleanupWorkspaces`). Records `recordVerdict` per journey.
- `apps/fiab-console/e2e/_lib/msal-login.ts` — NEW. `loginViaMsal(context)`:
  performs the real authorize-code flow with `SYNTHETIC_LOGIN_UPN` /
  `SYNTHETIC_LOGIN_SECRET` (KV-sourced), returns the browser context now
  carrying the callback-minted cookie. Falls back to a clear `skip` marker (not
  a fail) when the automation credential env is absent, so estates without it
  degrade honestly.
- `apps/fiab-console/e2e/run-synthetic.mjs` — NEW thin wrapper over the existing
  `run-uat-unattended.mjs` machinery with `UAT_GREP="synthetic"` +
  `UAT_PROJECT=journey`, so artifact upload + `UAT_RESULT` parsing are reused
  verbatim.
- `apps/fiab-console/playwright.config.ts` — add `journey` project
  (`testMatch: /synthetic-journeys\.uat\.ts/`).
- `.github/workflows/loom-synthetic-monitor.yml` — NEW. `on: schedule:
  - cron: '*/15 * * * *'` + `workflow_dispatch`. Azure-login (same creds block
  as `loom-roll-and-validate.yml`), then `az containerapp job start -n
  loom-synthetic-monitor -g $RG` and poll to completion (reuse the poll step
  from `loom-roll-and-validate.yml`). On non-zero `UAT_RESULT realFails>0`, fire
  the alert (below) and open/update a dedup GitHub issue (`synthetic-monitor:
  <journey> failing`).
- `app/admin/health-journeys/page.tsx` — NEW admin surface (see "Admin surface"
  below). Route also linked from `/admin/performance` and `/admin/health`.
- `app/api/admin/synthetic-runs/route.ts` — NEW. `GET` lists the last N run
  summaries by reading the run artifacts from Blob (`LOOM_UAT_RESULTS_CONTAINER`)
  — `{ runId, ts, journeys:[{name, verdict, status, ms, screenshot}] }`.
  Session-gated, admin-only.

**Backend/Infra.**
- `platform/fiab/bicep/modules/admin-plane/synthetic-monitor-job.bicep` — NEW.
  `Microsoft.App/jobs` (`triggerType: 'Schedule'`,
  `scheduleTriggerConfig.cronExpression: '*/15 * * * *'`), in the console
  Container Apps Environment (in-VNet), image = the console image (contains the
  e2e specs) OR a dedicated `loom-synthetic` image if the console image is
  slimmed. UAMI = console UAMI (already has Cosmos + ADLS + KV data-plane).
  Env: `LOOM_URL`, `SESSION_SECRET` (secretRef), `LOOM_UAT_RESULTS_ACCOUNT`,
  `LOOM_UAT_RESULTS_CONTAINER`, `SYNTHETIC_LOGIN_UPN`, `SYNTHETIC_LOGIN_SECRET`
  (secretRef → KV `kv-loom-*/synthetic-login-secret`),
  `SYNTHETIC_ALERT_ACTION_GROUP_ID`. Wire the module into
  `modules/admin-plane/main.bicep` behind `param loomSyntheticMonitorEnabled
  bool = true` (default-ON, opt-out).
- **Alerting**: reuse `monitoring-default-alerts.bicep`’s `defaultActionGroup`.
  The workflow (and/or a wrapped `scheduledQueryRules` over the run’s emitted
  custom log) routes a failing run to that action group (email + subscription-
  Owner ARM-role receiver). Gov: same module, `.us` LAW audience.
- Failure artifacts: screenshots + traces already land in
  `test-results/uat/artifacts/` and are uploaded to Blob by
  `run-uat-unattended.mjs` — reuse; add a `synthetic/<runId>/` prefix.

**Env vars** (add to `ENV_CHECKS` + `GATE_META`):
- `SYNTHETIC_LOGIN_UPN`, `SYNTHETIC_LOGIN_SECRET` → new spec
  `id: 'synthetic-login'`, category `identity`, severity `optional`
  (`warnOnMiss`), `provisionedBy:
  'modules/admin-plane/entra-app-registration.bicep (automation account +
  KV secret)'`. Gate `GATE_META` entry: `fixit: 'wizard'` (a small wizard that
  registers/points at the automation account) surfaced on `/admin/health-journeys`.
- `SYNTHETIC_ALERT_ACTION_GROUP_ID` → derived (`derived: true`) from the default
  action group; env-config shows "derived".
- `LOOM_SYNTHETIC_MONITOR_ENABLED` (opt-out flag) → `optionalDefault`.

**Acceptance (G1 receipt required).**
1. `loom-synthetic-monitor` ACA job runs green on a live roll; paste the
   `UAT_RESULT pass=5 fail=0 realFails=0` line + the run’s `verdicts.ndjson`.
2. **Prove the login probe has teeth**: temporarily point
   `SYNTHETIC_LOGIN_SECRET` at a stale secret in a scratch run and show J1 goes
   **red** and fires the alert — demonstrating it catches the 07-19 class the
   minted-session `verify` project missed.
3. `/admin/health-journeys` renders the last runs with per-journey verdict +
   screenshot, dark AND light theme screenshots attached.
4. Alert delivered to the action group (email receipt or Teams webhook).

**Per-cloud.**
- **Commercial**: cron in-VNet job; alerts → default action group email +
  Owner role receiver.
- **Gov (GCC-High)**: identical; `.us` endpoints; automation account in the Gov
  tenant; `gov-console-roll.yml` triggers a post-roll one-shot. ROPC/automation
  sign-in must use the Gov Entra authority (`login.microsoftonline.us`).
- **IL5/air-gapped (design only)**: runner is the in-enclave `gh-aca-runner`;
  no `api.github.com` for issue dedup → write failures to an in-boundary Cosmos
  `synthetic-runs` container + the admin page instead of GitHub Issues; alert
  sink stays in-tenant (email via in-boundary SMTP relay / Log Analytics).

---

## V2 — Visual regression (screenshot-diff, light + dark, per-PR + post-roll)

**Goal.** Catch the dark-theme / overlap / empty-render defect class
(`loom_item_accent_readable_theme`, the new-item-dialog dark bug, badge overlap)
that DOM-string checks and `tsc`/`vitest` cannot see. Pixel-diff ~25 hub
surfaces in BOTH themes, per-PR against committed baselines AND against the live
deployment post-roll.

**Surface list (25), enumerated from `app/` routes** — home `/`, `/browse`,
`/workspaces`, `/onelake`, `/catalog`, `/governance` (overview), `/marketplace`,
`/api-marketplace`, `/monitor`, `/realtime-hub`, `/rti-hub`, `/data-agent`,
`/copilot`, `/mesh`, `/workload-hub`, `/deployment-pipelines`, `/apps`,
`/learn`, `/estate`, `/admin` (home), `/admin/gates`, `/admin/health`,
**`/items/lakehouse/new`** (a canvas editor, dark-theme accent bug class),
**`/items/data-pipeline/new`** (canvas), and **the new-item dialog OPEN state**
(navigate `/browse`, open "New" → capture the dialog — the exact dark-theme bug
surface). Store the list as a single exported `VISUAL_SURFACES` array so it
never drifts (mirrors the `NAV_PAGES` single-source pattern).

**Files.**
- `apps/fiab-console/e2e/visual-regression.spec.ts` — NEW. For each surface ×
  {light, dark}: `signIn`, navigate, wait for network-idle + the surface’s ready
  marker, mask volatile regions (timestamps, live counts, `data-testid="clock"`)
  via Playwright `mask:`, then `await expect(page).toHaveScreenshot(
  '<slug>-<theme>.png', { maxDiffPixelRatio: 0.02, animations: 'disabled' })`.
  Theme set via the `data-theme` root attribute the app’s toggle stamps.
- `apps/fiab-console/e2e/_lib/visual-surfaces.ts` — NEW `VISUAL_SURFACES` list +
  per-surface `ready` selector + `mask` selectors.
- `apps/fiab-console/e2e/__screenshots__/` — committed baseline PNGs (Linux/CI
  render, one set; generated headless in the same container image the CI uses to
  avoid font/AA drift).
- `apps/fiab-console/playwright.config.ts` — add `visual` project
  (`testMatch: /visual-regression\.spec\.ts/`,
  `snapshotPathTemplate: '{testDir}/__screenshots__/{arg}{ext}'`), pin
  `expect.toHaveScreenshot` defaults (threshold, `maxDiffPixelRatio`).
- `.github/workflows/visual-regression.yml` — NEW. `on: pull_request` (paths:
  `apps/fiab-console/**`). Runs the `visual` project against a **built preview**
  of the PR (Next.js standalone served in the job container — NOT the live FD,
  so a PR is diffed against its own render). Uploads the Playwright HTML diff
  report as an artifact; comments the diff summary on the PR.
- `.github/workflows/loom-roll-and-validate.yml` — EXTEND: after the live-URL
  validation, add an optional `visual` slice run against the **live rolled
  revision** (`UAT_GREP="visual"`), non-blocking (report-only) initially, so
  post-roll drift is visible without gating the emergency valve.

**Baseline update workflow (intentional).** A PR that legitimately changes a
surface regenerates baselines by adding the label `visual-baseline-update` (or a
`/update-baselines` PR comment) → a `workflow_dispatch` job runs
`playwright test --project=visual --update-snapshots`, commits the new PNGs to
the PR branch, and posts "baselines updated for N surfaces". Baselines are
committed (not ADLS) so the diff is reviewable in the PR; the live post-roll
diffs are report-only and their artifacts go to Blob (reuse
`LOOM_UAT_RESULTS_*`).

**Diff-tolerance strategy.** `maxDiffPixelRatio: 0.02` global; per-surface
override for animation-heavy canvases (0.05); mask all live-data regions.
Anti-flake: `animations: 'disabled'`, fixed viewport `1440×900`, `deviceScale
Factor:1`, fonts embedded in the image, `reducedMotion: 'reduce'`.

**Backend/Infra.** None new (pure test asset). CI-only; no bicep. No new env
vars. (If live post-roll diffs upload to Blob, they reuse the existing
`LOOM_UAT_RESULTS_ACCOUNT`/`CONTAINER` — already ENV_CHECKS-registered.)

**Acceptance (G1 receipt).**
1. PR run diffs all 25×2 surfaces green against committed baselines; attach the
   Playwright HTML report.
2. Seed a deliberate dark-theme regression (e.g. dark-on-dark accent) in a
   scratch commit and show the `/items/lakehouse/new` dark baseline goes red —
   proving the harness catches the accent bug class.
3. Show the new-item-dialog OPEN-state surface is in the set and diffs.
4. Demonstrate the baseline-update path produces a reviewable PNG diff in a PR.

**Per-cloud.**
- **Commercial**: per-PR (preview render) + report-only post-roll on live.
- **Gov**: same specs; the post-roll slice runs in-VNet via `gov-console-roll.yml`
  against the `.us` FD. Baselines are cloud-agnostic (same DOM/theme) — one
  committed set; Gov-only surfaces that gate (ADT/AAS/Maps unavailable) are
  masked or excluded via a `cloud` tag on the surface entry.
- **IL5 (design only)**: preview-render diff runs entirely in-enclave; no live
  post-roll if the enclave forbids the runner reaching FD — fall back to
  preview-only.

---

## V3 — A11y / contrast gate with baseline ratchet

**Goal.** Turn the existing `a11y.uat.ts` slice into a **ratcheted gate** (like
the vitest coverage floor) so existing debt doesn’t block day-one but any NEW
serious/critical violation fails the PR — with `color-contrast` specifically
enforced (it would have caught black-on-dark).

**Files.**
- `apps/fiab-console/e2e/a11y.uat.ts` — EXTEND: keep the per-surface scan; add a
  baseline file comparison. Load `e2e/a11y-baseline.json` (map of
  `surface → { critical:n, serious:m }`); FAIL only when a surface’s current
  serious+critical count **exceeds** its baseline, OR any `color-contrast`
  violation appears that isn’t in the baseline’s explicit allow-list. Emit the
  new totals so the ratchet can be tightened.
- `apps/fiab-console/e2e/a11y-baseline.json` — NEW committed baseline (the
  current live counts per surface). Ratchet-down PRs lower the numbers, mirror
  of the 32/58/34/32 vitest-floor ratchet in commit `14a16d8e`.
- `apps/fiab-console/e2e/_lib/a11y-ratchet.ts` — NEW compare helper +
  `A11Y_CONTRAST_STRICT=1` (default) forcing `color-contrast` to zero-new.
- `.github/workflows/csa-loom-validate.yml` (or `test.yml`) — wire the a11y
  slice into the PR gate for `apps/fiab-console/**` changes (runs against a
  preview render, same as V2), required check.
- Surface list: reuse `a11y.uat.ts`’s ~20 + the V2 canvas editors so the
  contrast rule covers the accent-on-canvas case.

**Backend/Infra.** None (test asset). No bicep. No env vars beyond the existing
`A11Y_MIN_IMPACT` + new `A11Y_CONTRAST_STRICT` (test-only, not an app env var so
NOT in ENV_CHECKS).

**Acceptance (G1 receipt).**
1. PR gate runs green against baseline; attach the axe summary (serious+critical
   per surface).
2. Introduce a low-contrast token in a scratch commit → show the gate fails with
   a `color-contrast` violation naming the element.
3. A legitimate ratchet-down PR lowers a baseline count and the gate accepts it.

**Per-cloud.** Cloud-agnostic (DOM-level). Commercial/Gov share one baseline;
Gov-gated surfaces excluded via the surface `cloud` tag. IL5: runs in-enclave,
identical.

---

## V4 — Client-component (`page.tsx`) coverage ratchet

**Goal.** Close the `app/**/page.tsx` "dark zone" — the client route components
that `vitest` (jsdom, harness partially broken per
`fiab_console_vitest_harness_broken`) does not exercise and that shipped the
GuidedPickerRail freeze. Add **route-level smoke coverage** measured by a
ratchet, so every hub page is proven to mount + render its primary content
against a real render.

**Approach (decided — do not survey).** Do NOT rely on jsdom render tests (the
harness is flaky repo-wide). Instead, add a **route-mount smoke** to the
synthetic-journey / visual harness: for every `NAV_PAGES` + `VISUAL_SURFACES`
route, assert (a) HTTP 200 document, (b) the page’s ready marker present, (c)
ZERO console errors and ZERO 5xx network calls during load (reuse
`captureFailures` from `_lib/uat.ts`). Track a **coverage ratchet** = count of
`app/**/page.tsx` routes under smoke / total, committed as
`e2e/route-coverage-floor.json` and enforced like the vitest floor.

**Files.**
- `apps/fiab-console/e2e/route-smoke.uat.ts` — NEW. Enumerates every
  `app/**/page.tsx` route (glob at test-gen time), signs in, loads each, asserts
  clean mount via `captureFailures`. Honest-gate aware (a 200 page showing a
  configured MessageBar passes; a 5xx or console-thrown error fails).
- `apps/fiab-console/e2e/route-coverage-floor.json` — NEW ratchet
  (`{ covered: n, total: m }`); a helper fails if `covered/total` drops.
- `apps/fiab-console/e2e/_lib/route-enum.ts` — NEW glob of `app/**/page.tsx` →
  route paths (dynamic segments filled with a seeded fixture id).
- `.github/workflows/loom-synthetic-monitor.yml` — include the `route-smoke`
  slice in the scheduled run (so live routes are smoke-covered continuously).
- CI PR gate: add `route-smoke` against preview render, enforcing the floor.

**Backend/Infra.** None new; runs on the V1 job + PR preview. No env vars.

**Acceptance (G1 receipt).**
1. `route-smoke` covers ≥ the committed floor of `page.tsx` routes; attach the
   `covered/total` line + list of any excluded (dynamic-only) routes with reason.
2. Seed a route that throws on mount → show the smoke goes red with the console
   error captured (the GuidedPickerRail-freeze class).
3. A ratchet-up PR raises the floor.

**Per-cloud.** Cloud-agnostic route set; Gov-gated routes counted as
"honest-gate pass". IL5: identical in-enclave.

---

# WORKSTREAM DR — DISASTER-RECOVERY DRILLS AS CI

Five items. **DR0 first** (it closes a real, already-found infra gap: ADLS blob
versioning is OFF). DR1–DR3 are the drills; DR4 is the orchestration + admin
surface + alerting.

### Grounded current state (verified in this repo)

- **Cosmos (Loom store)** — `modules/admin-plane/loom-console-cosmos.bicep`
  already uses `backupPolicy.type: 'Continuous'`,
  `continuousModeProperties.tier: 'Continuous7Days'`. **PITR is ON** (7-day
  window). Landing-zone Cosmos (`cosmos.bicep`, `cosmos-graph-vector.bicep`)
  same. → DR1 is a *drill*, not an enablement.
- **ADLS** — `modules/landing-zone/storage.bicep`: `deleteRetentionPolicy` +
  `containerDeleteRetentionPolicy` ON (`recycleRetentionDays`), `changeFeed` ON,
  but **`isVersioningEnabled: false`**. → **GAP** — DR0 enables versioning.
- **Key Vault** — `modules/admin-plane/keyvault.bicep`: `enableSoftDelete: true`,
  `softDeleteRetentionInDays: 90`, `enablePurgeProtection: true`. Good — DR3 is a
  recovery *drill*.

## DR0 — Close the ADLS versioning gap + confirm PITR tier (enablement)

**Goal.** Bring the data-plane to a restorable baseline before drilling it:
enable blob **versioning** on the Bronze/lake storage (currently OFF), and make
the Cosmos continuous-backup **tier** explicit + parameterized (7 vs 30 day) so
the monthly drill has a wide-enough window.

**Files / Backend/Infra.**
- `platform/fiab/bicep/modules/landing-zone/storage.bicep` — set
  `isVersioningEnabled: true` (currently `false`); keep `changeFeed`/soft-delete.
  Add `restorePolicy` (blob point-in-time restore) with `days:
  recycleRetentionDays - 1` (must be < delete retention). Guard behind
  `param enableBlobPitr bool = true`.
- `platform/fiab/bicep/modules/admin-plane/loom-console-cosmos.bicep` — hoist
  the tier to `param cosmosBackupTier string = 'Continuous7Days'`
  (allowed: `Continuous7Days` | `Continuous30Days`). Document that 30-day is
  recommended where the monthly DR drill cadence needs the window.
- Wire params through `modules/admin-plane/main.bicep` +
  `params/commercial-full.bicepparam` (and the Gov paramfile).

**Env vars.** No new runtime env var (infra-only). Add an ENV_CHECKS **audit**
row `id: 'dr-restore-posture'` (category `data-plane`, `optional`) whose check
reads live ARM to confirm (a) Cosmos backup mode = Continuous, (b) ADLS
versioning enabled — surfaced on `/admin/health` so a mis-provisioned estate is
flagged. `GATE_META`: `fixit: 'wizard'` → runs the enable via `env-apply`/ARM.

**Acceptance (G1 receipt).** `az storage account blob-service-properties show`
proving `isVersioningEnabled=true` on the live account; `az cosmosdb show`
proving `backupPolicy.type=Continuous`. `/admin/health` shows the new
`dr-restore-posture` row green.

**Per-cloud.** Commercial + Gov: both support blob versioning + Cosmos
continuous backup (verified GA, incl. Government). IL5 (design only): same ARM;
if the enclave storage SKU lacks versioning, document soft-delete-only fallback.

## DR1 — Cosmos point-in-time restore drill (quarterly, automated)

**Goal.** Quarterly CI drill that proves the Loom store is recoverable: restore
the live Cosmos account to a recent PITR timestamp into a **scratch** account,
validate row-counts + schema of the key containers, emit a drill report, tear
the scratch account down in `always()`.

**Files.**
- `.github/workflows/dr-drill-cosmos.yml` — NEW. `on: schedule:
  - cron: '0 6 1 */3 *'` (06:00 UTC, 1st of quarter) + `workflow_dispatch`.
  Steps: Azure-login → compute latest restorable timestamp
  (`az cosmosdb restorable-database-account …` / `get-latest-restore-timestamp`)
  → `az cosmosdb restore` into `loom-cosmos-drdrill-<runId>` in a scratch RG
  `rg-csa-loom-drdrill-<cloud>` → run the validator → write report → **`always():`
  `az cosmosdb delete` + `az group delete` the scratch RG** (cost control).
- `scripts/csa-loom/dr/validate-cosmos-restore.mjs` — NEW. Connects to the
  restored account with the console UAMI (or a scratch key), counts docs per
  key container (`workspaces`, `items`, `permissions`, `config`, `audit`),
  asserts each ≥ a floor + schema-probes a sampled doc per container, and
  compares counts to a live-account snapshot taken at drill start (tolerance
  band). Emits `test-results/dr/cosmos-<runId>.json`.
- `app/api/admin/dr-drills/route.ts` — NEW `GET` reads drill reports from Blob
  and returns `{ drills: [{ id, kind:'cosmos', ts, status, checks }] }`.
- `app/admin/dr-drills/page.tsx` — NEW admin surface row (shared with DR2/DR3;
  see DR4).

**Backend/Infra.**
- Scratch RG per cloud (created + deleted per run). Restore target account
  inherits Continuous backup. The GH SP / Gov SP needs
  `DocumentDB Account Contributor` + RG create/delete at the drill scope — add
  the role assignment in `platform/fiab/bicep/modules/admin-plane/dr-drill-rbac.bicep`
  (NEW), scoped to the scratch RG naming pattern.
- Report artifact → Blob container `dr-drills` (reuse
  `LOOM_UAT_RESULTS_ACCOUNT`; new container).

**Env vars** (ENV_CHECKS + GATE_META):
- `LOOM_DR_DRILL_RG_PREFIX` (default `rg-csa-loom-drdrill`), `derived`.
- `LOOM_DR_RESULTS_CONTAINER` (default `dr-drills`), `optionalDefault`.
- `LOOM_DR_ALERT_ACTION_GROUP_ID` → derived from default action group.
- New spec `id: 'dr-drill'`, category `data-plane`, `optional` — check confirms
  the drill workflow ran within the last quarter (reads latest report ts);
  `GATE_META` fixit `wizard` → "Run DR drill now" dispatch.

**Acceptance (G1 receipt).** A `workflow_dispatch` run: restore completes,
validator prints per-container counts matching the live snapshot within
tolerance, `dr-drills` report written, scratch RG deleted (show `az group exists
→ false`). `/admin/dr-drills` shows the run green.

**Per-cloud.**
- **Commercial**: `centralus`, restore into scratch RG in the admin sub.
- **Gov (GCC-High)**: identical; `az cosmosdb restore` supported in Gov;
  `.us`; Gov SP `csa-loom-gov-deploy`; scratch RG in the Gov sub. Restore region
  must be one where backups exist (Gov region).
- **IL5 (design only)**: same ARM verbs; runner in-enclave; report to in-boundary
  Blob only. If cross-region restore is disallowed, restore in-region.

## DR2 — ADLS soft-delete / versioning restore drill

**Goal.** Prove lake data is recoverable: write a canary blob, delete it +
overwrite a versioned blob, then restore via soft-delete undelete AND version
promotion, asserting byte-for-byte recovery. Quarterly, same cadence.

**Files.**
- `.github/workflows/dr-drill-adls.yml` — NEW (schedule + dispatch). Steps:
  create canary container `drdrill-<runId>` → upload `canary.txt` (known hash)
  → upload v2 (version created) → delete canary + delete a container → **restore**:
  `az storage blob undelete` (soft-delete) and list versions + promote prior
  version → assert restored hash == original → `always():` delete the canary
  container. No scratch account needed (operates on a throwaway container in the
  live lake, namespaced + cleaned).
- `scripts/csa-loom/dr/validate-adls-restore.mjs` — NEW hash-compare + version
  enumeration validator; emits `test-results/dr/adls-<runId>.json`.

**Backend/Infra.** Depends on **DR0** (versioning must be ON). UAMI already has
`Storage Blob Data Contributor`. Report → `dr-drills` Blob container.

**Env vars.** Reuse DR1’s (`LOOM_DR_RESULTS_CONTAINER`,
`LOOM_DR_ALERT_ACTION_GROUP_ID`); no new app env var. The `dr-drill` audit row
covers ADLS too (multi-kind).

**Acceptance (G1 receipt).** Dispatch run: canary deleted then restored,
validator asserts original hash recovered from BOTH soft-delete undelete and a
prior version; canary container removed. `/admin/dr-drills` row green.

**Per-cloud.** Commercial + Gov identical (`.us` blob endpoint). IL5 (design):
same; if versioning unavailable on the enclave SKU, drill soft-delete only and
document the reduced RPO.

## DR3 — Key Vault secret recovery drill

**Goal.** Prove secrets are recoverable under soft-delete + purge protection:
create a canary secret, delete it, recover it, assert value intact; confirm
purge is BLOCKED (purge protection). Quarterly.

**Files.**
- `.github/workflows/dr-drill-keyvault.yml` — NEW (schedule + dispatch). Steps:
  `az keyvault secret set` canary `drdrill-canary-<runId>` → `az keyvault secret
  delete` → assert it appears in `az keyvault secret list-deleted` → `az keyvault
  secret recover` → assert value == original → assert `az keyvault secret purge`
  is **rejected** (purge protection ON) → `always():` delete the canary (it stays
  in soft-delete 90d, harmless; naming is swept).
- `scripts/csa-loom/dr/validate-kv-recovery.mjs` — NEW; emits
  `test-results/dr/kv-<runId>.json`.

**Backend/Infra.** Uses existing KV `kv-loom-*` (soft-delete + purge protection
already ON per `keyvault.bicep`). SP/UAMI needs `Key Vault Secrets Officer` on
the canary (scope to a naming-pattern via `dr-drill-rbac.bicep`). Report → Blob.

**Env vars.** Reuse DR results/alert env. `dr-drill` audit row covers KV.

**Acceptance (G1 receipt).** Dispatch run: canary deleted → recovered with value
intact → purge rejected (paste the expected error). `/admin/dr-drills` row green.

**Per-cloud.** Commercial + Gov identical (`vault.azure.us`). IL5 (design):
same; purge protection typically mandated in-enclave — drill confirms it.

## DR4 — DR-drill orchestration, admin surface & alerting

**Goal.** One umbrella that ties DR1–DR3 together: a single quarterly
orchestration, a unified `/admin/dr-drills` surface, and failure alerting — so a
failed drill is loud, and the admin can see RPO/RTO evidence.

**Files.**
- `.github/workflows/dr-drill-all.yml` — NEW. `on: schedule:
  - cron: '0 6 1 */3 *'` + dispatch. Calls DR1/DR2/DR3 as reusable
  `workflow_call` jobs (matrix over `[cosmos, adls, keyvault]`), each with its
  own `always()` teardown; aggregates a run-level `dr-summary-<runId>.json`
  (per-kind status, duration = crude RTO, restore-point age = RPO). On ANY kind
  failing → fire `LOOM_DR_ALERT_ACTION_GROUP_ID` (reuse
  `monitoring-default-alerts.bicep` action group) + open/update a dedup GitHub
  issue `dr-drill: <kind> FAILED`.
- `app/admin/dr-drills/page.tsx` — NEW. `AdminShell` + `LearnPopover`; table of
  the last N drill runs, per-kind pass/fail, RPO/RTO columns, a "Run drill now"
  button (`workflow_dispatch` via `/api/admin/dr-drills` POST → GH dispatch), and
  a status MessageBar when the last drill is > 1 quarter old (honest gate with
  Fix-it "Run now"). Web3/Fluent v9 + Loom tokens per `web3-ui.md`; dark+light.
- `app/api/admin/dr-drills/route.ts` — NEW `GET` (list from Blob) + `POST`
  (dispatch a drill; admin-gated, session-verified, structured
  `{ok,data,error}`).
- Cross-link from `/admin/health` and `/admin/performance`.

**Backend/Infra.** `dr-drill-rbac.bicep` (NEW) — the scratch-RG + canary-scope
role assignments for the drill principal, wired into `main.bicep` behind
`param loomDrDrillsEnabled bool = true`. Action group reused.

**Env vars** (ENV_CHECKS + GATE_META): `LOOM_DR_DRILLS_ENABLED`
(`optionalDefault`), plus the DR1 set. The `dr-drill` health row asserts a
successful run within the last quarter across all three kinds.

**Acceptance (G1 receipt).**
1. `dr-drill-all` dispatch runs all three kinds green; attach `dr-summary` JSON
   with RPO/RTO per kind.
2. Force one kind to fail (e.g. bad restore timestamp) → show the alert fires and
   the dedup issue opens.
3. `/admin/dr-drills` renders the runs + "Run now" works; dark AND light
   screenshots attached; the >1-quarter-stale MessageBar + Fix-it demonstrated.

**Per-cloud.** Commercial + Gov: same orchestration, per-cloud scratch RGs +
subs + `.us`; Gov alerts to a Gov action group. IL5 (design only): orchestration
runs on the in-enclave runner; GitHub-issue dedup replaced by the in-boundary
Cosmos `dr-runs` container + the admin page; alert sink in-tenant.

---

## Build order (dependency spine)

1. **V1** (synthetic journeys + real MSAL login probe) — PRP #1 priority, ship first.
2. **DR0** (ADLS versioning gap) — unblocks DR2; small bicep PR.
3. **V3** (a11y ratchet) — cheap, extends existing `a11y.uat.ts`.
4. **V2** (visual regression) — after V3 so contrast + pixel gates land together.
5. **V4** (route-smoke coverage) — rides the V1 job.
6. **DR1 → DR2 → DR3 → DR4** — drills then orchestration/admin surface.

Every PR attaches its G1 receipt (live/preview browser E2E, dark+light where a
surface is involved) per `no-vaporware.md` + `loom_browser_e2e_before_done`;
reviewers reject without it.
