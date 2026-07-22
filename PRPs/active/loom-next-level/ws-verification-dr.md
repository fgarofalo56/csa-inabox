# loom-next-level — Workstreams V (Production Verification Depth), DR (Disaster-Recovery Drills), S (Secret/Credential Lifecycle) & O (Operability & Resilience)

> Draft for the master PRP `loom-next-level` (rev 2 — post-adversarial-review).
> Four workstreams, each a set of individually-shippable PR-sized items.
> Workstream **V is the #1 priority of the whole PRP** — it closes the class of
> failure that shipped on 2026-07-19 (MSAL secret drift broke ALL sign-in while
> minted-session verify stayed green) and 2026-07-15 (GuidedPickerRail passed
> every CI gate then hard-froze the live renderer). The through-line: **CI green
> is not production green.** Every item here adds a check that runs against the
> *live, real-data* deployment, in the browser, on the real login path — the
> exact blind spots the current gates have.
>
> **Rev 2 changes (from the SRE/security + completeness + consistency reviews):**
> WS-DR is re-scoped to **EXTEND the existing `.github/workflows/dr-drill.yml` +
> `docs/DR.md` scenario framework** (it was drafted greenfield — a grounding
> miss); V1's alert sink + automation credential are hardened; V2 gains narrow
> viewports; V5 (live bicep-drift detection) is new; and two new workstreams land
> here: **WS-S (secret/credential lifecycle — TOP priority)** and **WS-O
> (operability & resilience: unified alerting, RUM, SLO surface, diagnostics
> bundle, dependency chaos, workspace export, Cosmos CMK)**.

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

**Rev-2 conventions binding on every item in this file** (see the master PRP
universal standards for the full text):

- **R0 param-cap rule (BLOCKER):** `admin-plane/main.bicep` is at the 256-param
  ARM cap — every bicep param this file adds (V1, V5, DR0, DR4, S1, O1, RUM1,
  CMK1) goes via an object/config param or nested-module param, never a new
  top-level `param`. R0 (WS-R) lands first.
- **Alert standard:** all alerting routes through the shared
  `lib/azure/alert-dispatch.ts` (O1) + the ONE derived var
  `LOOM_ALERT_ACTION_GROUP_ID` (from `monitoring-default-alerts.bicep::
  defaultActionGroup`). No per-item action-group vars, no parallel Logic Apps.
- **Naming:** ENV_CHECKS ids `svc-*`; env vars `LOOM_*`; enable flags
  `LOOM_<X>_ENABLED`. New EnvSpecs carry the X2 `availability` field.
- **Serialization:** env-adding PRs serialize on `env-checks.ts` /
  `gates/registry.ts` / `registry.test.ts`; `playwright.config.ts` project
  additions (V1/V2/V4) are batched or landed in dependency order.
- **Admin surfaces:** journeys (V1), DR drills (DR4), Spark pools (A10) and the
  SLO view (SLO1) are TABS of one **Health & Reliability hub** (extend
  `/admin/health`), registered via `admin-shell.tsx` + `admin-overview.tsx` and
  passing `lib/nav/__tests__/nav-registries.test.ts` (#2385) — NOT `NAV_ITEMS`.

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
| **Quarterly DR drill workflow (rev 2 — the WS-DR base)** | `.github/workflows/dr-drill.yml` — "CSA-0073", `schedule: cron '0 10 1 1,4,7,10 *'` + dispatch, scenarios `cosmos-failover \| storage-failover \| keyvault-restore \| bicep-rollback`, scratch/staging environment with pre-flight + teardown | DR1–DR4 EXTEND this workflow's scenario framework — do NOT create parallel `dr-drill-*.yml` files |
| **DR runbooks/docs (rev 2)** | `docs/DR.md`, `docs/runbooks/dr-drill.md`, `docs/fiab/operations/disaster-recovery.md`, `docs/fiab/runbooks/cosmos-pitr-restore.md` (scopes exactly DR1's admin-plane `loom-console-cosmos` PITR, `Continuous7Days`) | update in place; the `bicep-rollback` scenario is the rollback story new Functions reference |
| Supply-chain workflows | `sbom.yml`, `slsa-provenance.yml`, `trivy.yml`, `dependabot.yml` (exist but decoupled from the real deploy path — see O-band SC note in CH1/V5 and WS-S) | context for the S/O items; do not rebuild |

---

# WORKSTREAM V — PRODUCTION VERIFICATION DEPTH  *(PRP #1 priority)*

Five items. **V1** (synthetic journeys incl. real MSAL login probe) is the
single highest-value item in the PRP — ship it first.

## V1 — Synthetic user-journey monitoring (scheduled, in-VNet, real-login-aware)

**Goal.** A scheduled (cron) in-VNet Playwright job that runs six real
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

The six journeys (J6 added rev 2 per the product review — the multi-user /
git-sync / promotion paths were unmonitored; each asserts a REAL backend
outcome, honest-gate aware per
`ten-journey.uat.ts` semantics):

| # | Journey | Route(s) / action | Backend asserted |
|---|---|---|---|
| J1 | **Login** | `/auth/sign-in` → Entra → `/auth/callback` (MSAL path) | real `loom_session` minted by callback; `/api/me` 200 with claims |
| J2 | **Create item** | `POST /api/workspaces` (domain=`default`) → `POST /api/workspaces/{ws}/items` (type `lakehouse`) | Cosmos write; item doc returned with id |
| J3 | **Open editor + run primary action** | nav `/items/lakehouse/{id}` → click "Run"/"New table" → real ADLS/Synapse call | 2xx receipt body (or honest 503 gate), editor chunk mounted |
| J4 | **Query data** | `/onelake` or notebook → execute a SELECT / KQL `print 1` | real TDS/KQL response rows |
| J5 | **Share / marketplace** | `/marketplace` publish → subscribe → `/api/external-shares` or Delta Share grant | grant persisted; subscribe returns access token/manifest |
| J6 | **Git sync / promotion** *(rev 2, product review — the multi-user/promotion paths were unmonitored)* | workspace git commit → pull round-trip via the surviving git-integration route (R28), or a deployment-pipelines compare→deploy | real commit SHA returned / promotion history row written |

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
- **Admin surface (rev 2 — hub consolidation):** a **"Journeys" TAB on the
  Health & Reliability hub** (extend `app/admin/health/page.tsx`), NOT a new
  top-level `/admin/health-journeys` page. Registered via `admin-shell.tsx` +
  `admin-overview.tsx`; acceptance includes passing
  `lib/nav/__tests__/nav-registries.test.ts`. Cross-linked from
  `/admin/performance`.
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
  `LOOM_ALERT_ACTION_GROUP_ID` (the shared derived alert var — rev 2). Wire the
  module into `modules/admin-plane/main.bicep` **via the R0 config-object param
  pattern** (`main.bicep` is at the 256-param ARM cap — no new top-level
  `param`; the enable flag rides the observability config object, default-ON,
  opt-out).
- **Alerting (rev 2 — unified)**: route through the shared
  `lib/azure/alert-dispatch.ts` module / O1 convention targeting
  `monitoring-default-alerts.bicep`'s `defaultActionGroup` (email +
  subscription-Owner ARM-role receiver today; a secure webhook receiver only
  once O1 adds it). Gov: same module, `.us` LAW audience.
- Failure artifacts: screenshots + traces already land in
  `test-results/uat/artifacts/` and are uploaded to Blob by
  `run-uat-unattended.mjs` — reuse; add a `synthetic/<runId>/` prefix.
  **Retention (rev 2, SRE F11):** add a Blob lifecycle-management rule (~30d) for
  `synthetic/*` artifacts (4 runs/hr × 2 clouds accumulates fast) and note the
  LAW custom-log ingestion delta in the PR.
- **External status rollup (rev 2, SRE F17, optional but recommended):** emit a
  rolled-up `/api/status` (or extend `/api/health/deep`) fed by the last
  synthetic verdict, so "is Loom up" is one unauthenticated-safe call, not an
  admin page.

**Env vars** (add to `ENV_CHECKS` + `GATE_META`; update
`lib/gates/__tests__/registry.test.ts` parity in the same PR; specs carry the X2
`availability` field):
- `SYNTHETIC_LOGIN_UPN`, `SYNTHETIC_LOGIN_SECRET` → new spec
  `id: 'svc-synthetic-login'` (rev 2: `svc-*` naming convention), category
  `identity`, severity `optional` (`warnOnMiss`), `provisionedBy:
  'modules/admin-plane/entra-app-registration.bicep (automation account +
  KV secret)'`. Gate `GATE_META` entry: `fixit: 'wizard'` (a small wizard that
  registers/points at the automation account) surfaced on the Health &
  Reliability hub's Journeys tab.
- `LOOM_ALERT_ACTION_GROUP_ID` → the ONE shared derived alert var
  (`derived: true`, from the default action group; also consumed by DR4/C3/A11/
  S1/O1); env-config shows "derived".
- `LOOM_SYNTHETIC_MONITOR_ENABLED` (opt-out flag) → `optionalDefault`.

**Automation-credential hardening (rev 2, SRE F13 — REQUIRED before the Gov
ship).** `SYNTHETIC_LOGIN_UPN`/`SYNTHETIC_LOGIN_SECRET` is a standing,
sign-in-capable, MFA-exempt secret. The item MUST: (a) create the account with a
least-privilege app role (member of nothing beyond the one Loom test workspace);
(b) document a Conditional-Access policy exception scoped to the monitor's
egress identity/IP (named-location), not a blanket MFA carve-out; (c) store +
rotate the secret in KV (rotation cadence documented; S1 tracks its expiry);
(d) add an Entra sign-in alert if the account authenticates from any client
other than the monitor (unexpected-use detection).

**Acceptance (G1 receipt required).**
1. `loom-synthetic-monitor` ACA job runs green on a live roll; paste the
   `UAT_RESULT pass=6 fail=0 realFails=0` line + the run’s `verdicts.ndjson`.
2. **Prove the login probe has teeth**: temporarily point
   `SYNTHETIC_LOGIN_SECRET` at a stale secret in a scratch run and show J1 goes
   **red** and fires the alert — demonstrating it catches the 07-19 class the
   minted-session `verify` project missed.
3. The Health & Reliability hub's Journeys tab renders the last runs with
   per-journey verdict + screenshot, dark AND light theme screenshots attached;
   `nav-registries.test.ts` green.
4. Alert delivered to the shared action group (**email receipt — the only
   receiver that exists today; rev 2 removed the phantom "Teams webhook" claim.
   A webhook receiver may be claimed only after O1 adds one**).

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
Anti-flake: `animations: 'disabled'`, primary viewport `1440×900`, `deviceScale
Factor:1`, fonts embedded in the image, `reducedMotion: 'reduce'`.

**Narrow-viewport matrix (rev 2, completeness gap 14 — REQUIRED).** The rev-1
single `1440×900` viewport could never catch the badge-overlap defect class that
`ux-baseline.md` says lives at narrow width — the per-item "narrow-width pass"
was manual-only, the exact 07-15-class "passed CI, broke live" risk V2 exists to
remove. Extend the matrix: `VISUAL_SURFACES` × {light, dark} **× {1440×900,
768×1024}** for the badge/tag-prone surfaces (browse, catalog, marketplace,
api-marketplace, admin hubs, the canvas editors, and the new-item dialog OPEN
state), with `375×812` added for the top-5 highest-traffic hubs. Per-surface
`narrow: true|false` flag on the `VISUAL_SURFACES` entry keeps the matrix
bounded. Diff at the same `maxDiffPixelRatio` with badge-region focus masks.
This makes the ux-baseline narrow-width rule an *automated* gate.

**Backend/Infra.** None new (pure test asset). CI-only; no bicep. No new env
vars. (If live post-roll diffs upload to Blob, they reuse the existing
`LOOM_UAT_RESULTS_ACCOUNT`/`CONTAINER` — already ENV_CHECKS-registered — and the
post-roll diff artifacts fall under the same ~30d Blob lifecycle rule as V1's
`synthetic/*` prefix, rev 2 SRE F11.)

**Acceptance (G1 receipt).**
1. PR run diffs the full surface × theme × viewport matrix (25×2 wide + the
   narrow slices) green against committed baselines; attach the Playwright HTML
   report. Include a seeded badge-overlap regression at 768×1024 going red
   (proves the narrow gate has teeth).
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

## V5 — Live bicep-drift detection (whatif coverage + scheduled estate what-if) *(NEW, rev 2 — SRE F3)*

**Goal.** Close the drift blind spot: `.github/workflows/bicep-whatif.yml`
triggers only on `pull_request` with `paths: deploy/bicep/**` — it never matches
`platform/fiab/bicep/**` (where ALL Loom/FiaB infra and every new module this
PRP adds lives), and there is no `schedule`/`workflow_dispatch`, so no what-if
ever runs against the LIVE Commercial or Gov estates. A hand-portal change (e.g.
the ACR "allow unsigned" toggle SC1 tracks, or a firewall rule) can silently
diverge from IaC forever.

**Files.**
- `.github/workflows/bicep-whatif.yml` — EXTEND `paths` to include
  `platform/fiab/bicep/**` (PR lane).
- Same workflow (or a sibling `loom-drift-check.yml`) — add a **scheduled lane**
  (`schedule: weekly` + `workflow_dispatch`) running
  `az deployment {sub,group} what-if` against **both live estates** (Commercial
  `e093f4fd`; Gov via SP `csa-loom-gov-deploy`) with `--no-pretty-print` JSON,
  failing/annotating on any non-`NoChange`/`Ignore` delta on a managed resource.
- Drift summary surfaced to the Health & Reliability hub as a `bicep-drift` row
  (ENV_CHECKS audit-style row `id: 'svc-bicep-drift'`; `GATE_META` Fix-it:
  "open a reconcile PR" wizard).

**Backend/Infra.** None new (uses the existing deploy SPs). Any param it needs
rides the R0 config object.

**Acceptance (G1 receipt).** (1) A PR touching `platform/fiab/bicep/**` triggers
the whatif lane (run link). (2) A dispatch of the scheduled lane against the
live Commercial estate produces the what-if JSON; seed a benign portal-side tag
change and show the lane flags it. (3) The hub row renders the last drift
verdict.

**Per-cloud.** Commercial + Gov both scheduled (per-estate SP). IL5 (design
only): the what-if runs from the in-enclave runner against the sovereign ARM
endpoint; report stays in-boundary.

---

# WORKSTREAM DR — DISASTER-RECOVERY DRILLS AS CI *(rev 2 — RE-SCOPED to extend the existing apparatus)*

Five items. **DR0 first** (it closes a real, already-found infra gap: ADLS blob
versioning is OFF — **the only new enablement in this workstream**). DR1–DR3 map
the restore drills onto the **existing `.github/workflows/dr-drill.yml` scenario
framework**; DR4 is the admin surface + alerting over that same framework.

> **Rev-2 re-scope (SRE F1 — binding).** The rev-1 draft was greenfield ("four
> new `dr-drill-*.yml` files") and never mentioned the existing apparatus — a
> grounding miss. Two competing quarterly DR workflows on overlapping scopes is
> an SRE hazard (divergent teardown, double scratch-RG cost, conflicting RBAC).
> **All DR1–DR4 work EXTENDS `dr-drill.yml` + the existing runbooks; no parallel
> workflow files.** The existing `bicep-rollback` scenario is also the rollback
> story every new Function in this PRP references (master Function standard).

### Grounded current state (verified in this repo — rev 2 corrected)

- **The DR apparatus already exists:** `.github/workflows/dr-drill.yml`
  ("CSA-0073 — Quarterly DR drill workflow", `schedule: cron '0 10 1 1,4,7,10 *'`
  + dispatch), scenario matrix `cosmos-failover | storage-failover |
  keyvault-restore | bicep-rollback`, run against a `scratch`/`staging`
  environment with pre-flight + teardown. Plus `docs/DR.md`,
  `docs/runbooks/dr-drill.md`, `docs/fiab/operations/disaster-recovery.md`, and
  `docs/fiab/runbooks/cosmos-pitr-restore.md` (which scopes exactly DR1's
  admin-plane `loom-console-cosmos` PITR).
- **Cosmos (Loom store)** — `modules/admin-plane/loom-console-cosmos.bicep`
  already uses `backupPolicy.type: 'Continuous'`,
  `continuousModeProperties.tier: 'Continuous7Days'`. **PITR is ON** (7-day
  window). Landing-zone Cosmos (`cosmos.bicep`, `cosmos-graph-vector.bicep`)
  same. → DR1 is a *drill deepening*, not an enablement. **The landing-zone
  graph/vector account (Weave AGE store, `cosmos-graph-vector.bicep`) is in NO
  drill's validation set today (SRE F15) — DR1 adds it.**
- **ADLS** — `modules/landing-zone/storage.bicep`: `deleteRetentionPolicy` +
  `containerDeleteRetentionPolicy` ON (`recycleRetentionDays`), `changeFeed` ON,
  but **`isVersioningEnabled: false`**. → **GAP** — DR0 enables versioning;
  DR2 adds the missing `adls-versioning-restore` scenario.
- **Key Vault** — `modules/admin-plane/keyvault.bicep`: `enableSoftDelete: true`,
  `softDeleteRetentionInDays: 90`, `enablePurgeProtection: true`. Good — DR3
  deepens the existing `keyvault-restore` scenario with a value-intact +
  purge-blocked validator.

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
  `params/commercial-full.bicepparam` (and the Gov paramfile) — **via the R0
  config-object pattern (`main.bicep` is at the 256-param cap; `enableBlobPitr`
  / `cosmosBackupTier` ride a DR/data-plane config object, never new top-level
  params).**

**Env vars.** No new runtime env var (infra-only). Add an ENV_CHECKS **audit**
row `id: 'svc-dr-restore-posture'` (rev 2 `svc-*` naming; category `data-plane`,
`optional`) whose check reads live ARM to confirm (a) Cosmos backup mode =
Continuous, (b) ADLS versioning enabled — surfaced on `/admin/health` so a
mis-provisioned estate is flagged. `GATE_META`: `fixit: 'wizard'` → runs the
enable via `env-apply`/ARM. (CMK1 later extends this same audit row with a
CMK-at-rest assertion.)

**Acceptance (G1 receipt).** `az storage account blob-service-properties show`
proving `isVersioningEnabled=true` on the live account; `az cosmosdb show`
proving `backupPolicy.type=Continuous`. `/admin/health` shows the new
`dr-restore-posture` row green.

**Per-cloud.** Commercial + Gov: both support blob versioning + Cosmos
continuous backup (verified GA, incl. Government). IL5 (design only): same ARM;
if the enclave storage SKU lacks versioning, document soft-delete-only fallback.

## DR1 — Cosmos point-in-time restore drill (deepen the existing `cosmos-failover` scenario)

**Goal.** Prove the Loom store is recoverable inside the EXISTING quarterly
drill: extend `dr-drill.yml`'s `cosmos-failover` scenario into a true PITR
restore drill — restore the live Cosmos account to a recent PITR timestamp into
a **scratch** account, validate row-counts + schema of the key containers
**(including the landing-zone graph/vector account — SRE F15)**, emit a drill
report, tear the scratch account down in `always()`.

**Files.**
- `.github/workflows/dr-drill.yml` — **EXTEND (no new workflow).** Deepen the
  `cosmos-failover` scenario steps (per `docs/fiab/runbooks/cosmos-pitr-restore.md`):
  Azure-login → compute latest restorable timestamp
  (`az cosmosdb restorable-database-account …` / `get-latest-restore-timestamp`)
  → `az cosmosdb restore` into `loom-cosmos-drdrill-<runId>` in a scratch RG
  `rg-csa-loom-drdrill-<cloud>` → run the validator → write report → **`always():`
  `az cosmosdb delete` + `az group delete` the scratch RG** (cost control).
  Reuse the workflow's existing pre-flight + teardown scaffolding.
- `scripts/csa-loom/dr/validate-cosmos-restore.mjs` — NEW. Connects to the
  restored account with the console UAMI (or a scratch key), counts docs per
  key container (`workspaces`, `items`, `permissions`, `config`, `audit`),
  asserts each ≥ a floor + schema-probes a sampled doc per container, and
  compares counts to a live-account snapshot taken at drill start (tolerance
  band). **Also validates the graph/vector Cosmos account
  (`cosmos-graph-vector.bicep` — the Weave AGE store, previously in no drill's
  validation set).** Emits `test-results/dr/cosmos-<runId>.json`.
- `app/api/admin/dr-drills/route.ts` — NEW `GET` reads the drill's report
  artifacts (the existing workflow's artifacts + the new Blob reports) and
  returns `{ drills: [{ id, kind:'cosmos', ts, status, checks }] }`.
- DR-drills admin surface — a TAB on the Health & Reliability hub (shared with
  DR2/DR3; see DR4).
- `docs/runbooks/dr-drill.md` + `docs/DR.md` — update in place for the deepened
  scenario.

**Backend/Infra.**
- Scratch RG per cloud (created + deleted per run). Restore target account
  inherits Continuous backup. The GH SP / Gov SP needs
  `DocumentDB Account Contributor` + RG create/delete at the drill scope — add
  the role assignment in `platform/fiab/bicep/modules/admin-plane/dr-drill-rbac.bicep`
  (NEW), scoped to the scratch RG naming pattern.
- Report artifact → Blob container `dr-drills` (reuse
  `LOOM_UAT_RESULTS_ACCOUNT`; new container).

**Env vars** (ENV_CHECKS + GATE_META; registry.test.ts parity updated):
- `LOOM_DR_DRILL_RG_PREFIX` (default `rg-csa-loom-drdrill`), `derived`.
- `LOOM_DR_RESULTS_CONTAINER` (default `dr-drills`), `optionalDefault`.
- Alerting uses the shared `LOOM_ALERT_ACTION_GROUP_ID` (rev 2 — no separate
  `LOOM_DR_ALERT_ACTION_GROUP_ID`; one derived var shared with V1/C3/A11/S1).
- New spec `id: 'svc-dr-drill'` (rev 2 naming), category `data-plane`,
  `optional` — check confirms the drill workflow ran within the last quarter
  (reads latest report ts); `GATE_META` fixit `wizard` → "Run DR drill now"
  dispatch.

**Acceptance (G1 receipt).** A `workflow_dispatch` run: restore completes,
validator prints per-container counts matching the live snapshot within
tolerance (incl. the graph/vector account), `dr-drills` report written, scratch
RG deleted (show `az group exists → false`). The Health & Reliability hub's
DR-drills tab shows the run green.

**Per-cloud.**
- **Commercial**: `centralus`, restore into scratch RG in the admin sub.
- **Gov (GCC-High)**: identical; `az cosmosdb restore` supported in Gov;
  `.us`; Gov SP `csa-loom-gov-deploy`; scratch RG in the Gov sub. Restore region
  must be one where backups exist (Gov region).
- **IL5 (design only)**: same ARM verbs; runner in-enclave; report to in-boundary
  Blob only. If cross-region restore is disallowed, restore in-region.

## DR2 — ADLS soft-delete / versioning restore drill (NEW `adls-versioning-restore` scenario)

**Goal.** Prove lake data is recoverable: write a canary blob, delete it +
overwrite a versioned blob, then restore via soft-delete undelete AND version
promotion, asserting byte-for-byte recovery. Quarterly, same cadence — **as a
NEW `adls-versioning-restore` scenario added to the existing `dr-drill.yml`
scenario matrix** (the existing `storage-failover` scenario does not cover
versioning restore; this is the one genuinely new scenario the rev-2 re-scope
keeps).

**Files.**
- `.github/workflows/dr-drill.yml` — **EXTEND: add scenario
  `adls-versioning-restore`** (schedule + dispatch ride the existing triggers).
  Steps: create canary container `drdrill-<runId>` → upload `canary.txt` (known
  hash) → upload v2 (version created) → delete canary + delete a container →
  **restore**: `az storage blob undelete` (soft-delete) and list versions +
  promote prior version → assert restored hash == original → `always():` delete
  the canary container. No scratch account needed (operates on a throwaway
  container in the live lake, namespaced + cleaned).
- `scripts/csa-loom/dr/validate-adls-restore.mjs` — NEW hash-compare + version
  enumeration validator; emits `test-results/dr/adls-<runId>.json`.
- `docs/runbooks/dr-drill.md` — document the new scenario.

**Backend/Infra.** Depends on **DR0** (versioning must be ON). UAMI already has
`Storage Blob Data Contributor`. Report → `dr-drills` Blob container.

**Env vars.** Reuse DR1’s (`LOOM_DR_RESULTS_CONTAINER`, shared
`LOOM_ALERT_ACTION_GROUP_ID`); no new app env var. The `svc-dr-drill` audit row
covers ADLS too (multi-kind).

**Acceptance (G1 receipt).** Dispatch run (scenario `adls-versioning-restore`):
canary deleted then restored, validator asserts original hash recovered from
BOTH soft-delete undelete and a prior version; canary container removed. Hub
DR-drills tab row green.

**Per-cloud.** Commercial + Gov identical (`.us` blob endpoint). IL5 (design):
same; if versioning unavailable on the enclave SKU, drill soft-delete only and
document the reduced RPO.

## DR3 — Key Vault secret recovery drill (deepen the existing `keyvault-restore` scenario)

**Goal.** Prove secrets are recoverable under soft-delete + purge protection:
create a canary secret, delete it, recover it, assert value intact; confirm
purge is BLOCKED (purge protection). Quarterly — **as a deepening of the
existing `keyvault-restore` scenario in `dr-drill.yml`** (rev 2: the rev-1
greenfield draft duplicated it).

**Files.**
- `.github/workflows/dr-drill.yml` — **EXTEND the `keyvault-restore` scenario**
  (no new workflow). Steps:
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

**Env vars.** Reuse DR results env + shared alert var. `svc-dr-drill` audit row
covers KV.

**Acceptance (G1 receipt).** Dispatch run: canary deleted → recovered with value
intact → purge rejected (paste the expected error). Hub DR-drills tab row green.

**Per-cloud.** Commercial + Gov identical (`vault.azure.us`). IL5 (design):
same; purge protection typically mandated in-enclave — drill confirms it.

## DR4 — DR-drill summary, admin surface & alerting (over the EXISTING orchestration)

**Goal.** Tie the drills together **inside the existing `dr-drill.yml`** — it is
already the quarterly orchestration (scenario matrix + pre-flight + teardown).
DR4 adds: a run-level summary artifact, a unified DR-drills tab on the Health &
Reliability hub reading the drill's report artifacts, and failure alerting via
the shared alert standard — so a failed drill is loud and the admin can see
RPO/RTO evidence. **No new orchestration workflow (rev 2 — SRE F1).**

**Files.**
- `.github/workflows/dr-drill.yml` — **EXTEND**: after the scenario matrix
  (`[cosmos-failover, storage-failover, keyvault-restore, bicep-rollback,
  adls-versioning-restore]`), aggregate a run-level `dr-summary-<runId>.json`
  (per-scenario status, duration = crude RTO, restore-point age = RPO). On ANY
  scenario failing → dispatch through the shared alert-dispatch convention
  (`LOOM_ALERT_ACTION_GROUP_ID`) + open/update a dedup GitHub issue
  `dr-drill: <scenario> FAILED`.
- Health & Reliability hub — **"DR drills" TAB** (rev 2 hub consolidation; not a
  standalone `/admin/dr-drills` page): `AdminShell` + `LearnPopover`; table of
  the last N drill runs, per-scenario pass/fail, RPO/RTO columns, a "Run drill
  now" button (`workflow_dispatch` via `/api/admin/dr-drills` POST → GH
  dispatch), and a status MessageBar when the last drill is > 1 quarter old
  (honest gate with Fix-it "Run now"). Web3/Fluent v9 + Loom tokens per
  `web3-ui.md`; dark+light. Registered via `admin-shell.tsx`/`admin-overview.tsx`;
  passes `nav-registries.test.ts`.
- `app/api/admin/dr-drills/route.ts` — NEW `GET` (list from the drill's
  artifacts/Blob) + `POST` (dispatch a drill; admin-gated, session-verified,
  structured `{ok,data,error}`).
- Cross-link from `/admin/performance`.

**Backend/Infra.** `dr-drill-rbac.bicep` (NEW) — the scratch-RG + canary-scope
role assignments for the drill principal, wired into `main.bicep` **via the R0
config-object pattern** (the enable flag rides the DR config object; no new
top-level param). Action group reused.

**Env vars** (ENV_CHECKS + GATE_META; registry.test.ts parity):
`LOOM_DR_DRILLS_ENABLED` (`optionalDefault`), plus the DR1 set. The
`svc-dr-drill` health row asserts a successful run within the last quarter
across all scenarios.

**Acceptance (G1 receipt).**
1. A `dr-drill.yml` dispatch runs all scenarios green; attach `dr-summary` JSON
   with RPO/RTO per scenario.
2. Force one scenario to fail (e.g. bad restore timestamp) → show the alert fires
   and the dedup issue opens.
3. The hub's DR-drills tab renders the runs + "Run now" works; dark AND light
   screenshots attached; the >1-quarter-stale MessageBar + Fix-it demonstrated;
   `nav-registries.test.ts` green.

**Per-cloud.** Commercial + Gov: same orchestration, per-cloud scratch RGs +
subs + `.us`; Gov alerts to a Gov action group. IL5 (design only): orchestration
runs on the in-enclave runner; GitHub-issue dedup replaced by the in-boundary
Cosmos `dr-runs` container + the admin page; alert sink in-tenant.

---

# WORKSTREAM S — SECRET / CREDENTIAL LIFECYCLE *(NEW, rev 2 — completeness gap 1; TOP priority)*

> **Why this workstream exists.** The MSAL app is a confidential client with a
> **2-year client secret**, reset by a deploymentScript in
> `platform/fiab/bicep/modules/admin-plane/entra-app-registration.bicep`
> (`az keyvault secret set --name loom-msal-client-secret`); the module comment
> explicitly assumes a secret (federated credentials not used). There is **no
> expiry monitoring, no rotation automation, no alert on approaching expiry**
> anywhere in the repo. The exact 07-19 production outage (expired/drifted MSAL
> secret broke ALL sign-in — memory `csa_loom_msal_secret_outage_2026_07_19`)
> recurs on a 2-year clock with zero warning. **V1's login probe would detect it
> every 15 min — reactively, after sign-in is already broken. Detection ≠
> prevention.** S1–S3 close prevention.

## S1 — MSAL secret expiry inventory + burn alert

- **Goal:** a scheduled check that reads the MSAL app registration's
  `passwordCredentials[].endDateTime` (Graph `/applications/{id}`) and the KV
  secret's `attributes.exp`, computes days-to-expiry, and fires the shared
  action group (`LOOM_ALERT_ACTION_GROUP_ID`) + a dedup GitHub issue at
  60/30/7-day thresholds. Inventory extends to every tracked standing credential
  (incl. V1's `SYNTHETIC_LOGIN_SECRET`, the Dataverse S2S secret, gov SP creds
  where readable).
- **Files:** `azure-functions/secret-expiry-monitor/` (timer, mirrors the
  `ops-agent-evaluator` shape: pure core + thin wrappers),
  `app/api/admin/secret-health/route.ts`, a **Secret health row/section on the
  Health & Reliability hub** (admin-shell registration; `nav-registries.test.ts`
  green), `platform/fiab/bicep/modules/admin-plane/secret-expiry-monitor-function.bicep`
  (the `<name>-function.bicep` precedent; UAMI + Graph `Application.Read.All` +
  KV read; **identity-based `AzureWebJobsStorage__accountName` — no storage
  key; roles declared in bicep, `skipRoleGrants`-aware**; Rollback subsection
  per the master Function standard). Params ride the R0 config object.
- **Env:** `LOOM_SECRET_EXPIRY_WARN_DAYS` (default 60), `SECRET_EXPIRY_CRON`
  (per the report-subscriptions cron precedent); new ENV_CHECKS
  `svc-secret-expiry` + gate Fix-it `wizard`; registry.test.ts parity;
  `availability` field set.
- **Per-cloud:** Commercial + Gov (Graph `.us` authority
  `login.microsoftonline.us`); IL5 in-boundary Graph, in-tenant alert sink.
- **Acceptance (G1):** seed a secret expiring in 5 days → alert fires + the
  Secret-health surface shows a red row with days-to-expiry; dark+light
  screenshots.

## S2 — Federated-credential migration feasibility spike (documented decision)

- **Goal:** determine whether the MSAL confidential web-app auth-code flow can
  move to **workload-identity-federation / managed-identity as the
  confidential-client credential**, eliminating the secret entirely.
  *(Verification-at-implementation flag — Learn: Entra federated credentials on
  app registrations are designed for external workload trust (CI, other IdPs);
  "managed identity as a federated credential" / certificate-less flows exist
  for confidential clients. Whether MSAL-Node's confidential-client web-app
  auth-code flow supports a managed-identity-issued client assertion in ACA
  needs a live Learn check + spike, not an assumption.)*
- **Deliverable:** `docs/fiab/runbooks/msal-credential-strategy.md` —
  feasibility verdict + migration plan, or a "stay-on-secret, automate rotation
  (S3)" decision.
- **Per-cloud:** no per-cloud build; design + one live spike on Commercial.

## S3 — Secret auto-rotation runbook + workflow (fallback if S2 is negative)

- **Goal:** a scheduled/dispatchable workflow that mints a new client secret via
  Graph, writes it to KV `loom-msal-client-secret`, and rolls a new ACA
  revision — the automated version of the manual 07-19 fix.
- **Files:** `.github/workflows/rotate-msal-secret.yml` +
  `scripts/csa-loom/rotate-msal-secret.mjs`; reuse the
  entra-app-registration deploymentScript logic.
- **Acceptance:** dispatch → new secret in KV, old secret removed after a grace
  window, sign-in stays green (V1 J1 green across the rotation — attach the
  synthetic-run receipt).
- **Per-cloud:** Commercial + Gov (Gov Graph/KV endpoints); IL5 design note
  (in-enclave runner, per X-IL5 checklist item 6).

---

# WORKSTREAM O — OPERABILITY & RESILIENCE *(NEW, rev 2 — SRE + completeness additions)*

## O1 — Unified alert-dispatch + on-call standard *(SRE F5)*

- **Goal:** ONE alerting convention for the whole program. Rev 1 had three
  ad-hoc sinks (V1/DR4 → action group, C3 → a separate Office-365 Logic App,
  V1/DR4 → GitHub issues) with no on-call escalation, no severity routing, no
  dedup standard — and V1's acceptance claimed a Teams webhook that does not
  exist (verified: `monitoring-default-alerts.bicep` has only email +
  ARM-role receivers; no `webhookReceivers` anywhere in `platform/fiab/bicep`).
- **Files:** `apps/fiab-console/lib/azure/alert-dispatch.ts` (NEW shared module:
  `dispatchAlert({source, severity:'P1'|'P2'|'P3', title, body, dedupKey})` →
  action group + optional GitHub-issue dedup; consumed by V1/V5/DR4/C3/A11/S1/
  CH1); `platform/fiab/bicep/modules/admin-plane/monitoring-default-alerts.bicep`
  — EXTEND with a **secure webhook receiver** (Teams / on-call bridge) + a
  severity tag convention (P1 page vs P3 email); `docs/fiab/runbooks/on-call.md`
  (NEW — who is paged, escalation, ack). C3's email becomes a receiver on the
  SAME action group, not a parallel Logic App channel.
- **Env:** the ONE derived `LOOM_ALERT_ACTION_GROUP_ID` (+ optional
  `LOOM_ALERT_WEBHOOK_URL` secretRef); ENV_CHECKS `svc-alerting` +
  registry.test.ts parity; params via the R0 config object.
- **Acceptance (G1):** a forced V1 failure and a forced C3 anomaly both arrive
  through the same action group (email receipt + webhook delivery log); the
  on-call runbook merged; severity routing demonstrated (P1 vs P3).
- **Per-cloud:** Commercial + Gov (`.us` action group). IL5: in-tenant sink only
  (no external webhook), per the existing V1 IL5 note.

## RUM1 — Client-side real-user monitoring → App Insights *(completeness gap 2)*

- **Goal:** the console's telemetry is server-side only
  (`lib/telemetry/app-insights.ts` — no browser SDK, no `trackPageView`, no
  client error capture). WS-V is synthetic-only; the 07-15 GuidedPickerRail
  freeze class on paths outside the 25-surface set is invisible. Bootstrap the
  App Insights Web SDK (or an OTel browser exporter) capturing page-load
  timings, route-change timings, unhandled JS errors, and a `csa-loom.surface`
  dimension; an admin RUM view charting p50/p95 load + top client errors by
  surface.
- **Files:** `apps/fiab-console/lib/telemetry/rum.ts` (client), wired in
  `app/layout.tsx`/a client provider; `app/admin/rum/page.tsx` (or a tab beside
  `/admin/performance` — register via admin-shell/admin-overview,
  `nav-registries.test.ts` green); `app/api/admin/rum/route.ts` (Kusto query
  over the App Insights LAW).
- **Env:** reuse `APPLICATIONINSIGHTS_CONNECTION_STRING`; opt-out
  `LOOM_RUM_ENABLED` (default-ON per `loom_default_on_opt_out`); ENV_CHECKS +
  registry parity; `availability` field.
- **Per-cloud:** Commercial/Gov (connection-string endpoint suffix). **IL5: the
  SDK is bundled in the image (no public CDN) per X-IL5 checklist item 4 —
  no external telemetry beacons; ingestion uses the Gov endpoint suffix** (this
  satisfies the constraint the X availability matrix already flagged).
- **Acceptance (G1):** real page loads appear as `browserTimings` in App
  Insights; a thrown client error surfaces on the RUM view; dark+light
  screenshots.

## SLO1 — Unified SLO / error-budget surface *(completeness gap 11 — the concrete surface; the SLO *program* is enterprise-hardening §1)*

- **Goal:** the program ships SLIs (V1 journey verdicts, `lib/perf/copilot-slo.ts`
  latency objectives, cost cache-hit rates, V4 route-smoke) but no single place
  shows objective vs actual vs budget burn. Build the **SLO tab on the Health &
  Reliability hub**: per-SLI objective, 28-day compliance, error-budget burn
  sparkline, and burn-rate alert wiring through O1.
- **Files:** `lib/admin/slo-rollup.ts` (pure rollup over synthetic-run
  summaries + copilot-slo + cache counters, unit-tested); the hub SLO tab;
  `app/api/admin/slo/route.ts` (cached via `getOrComputeCached`).
- **Cross-reference:** feeds/aligns with `PRPs/active/enterprise-hardening/
  appendix-ops-slo-loadtest.md §1` (RED SLI catalog, multi-window multi-burn-rate
  alerting) — this item is the in-product surface, not a second program.
- **Env:** none new (reads existing stores). **Acceptance (G1):** the tab renders
  real 28-day compliance from live synthetic runs + Copilot SLO counters; a
  seeded breach shows budget burn + fires a P2 via O1; dark+light + narrow pass;
  `nav-registries.test.ts` green.
- **Per-cloud:** Commercial + Gov live; IL5 design note (in-boundary only).

## DIAG1 — One-click diagnostics / support bundle *(completeness gap 12)*

- **Goal:** no single export exists of {gate state, env-check results, health
  probes, config snapshot} for incident triage. Add `/admin/diagnostics` →
  "Export support bundle": a ZIP/JSON of current gate-registry state, ENV_CHECKS
  results, last N `health/deep` probes, last synthetic-journey run, last DR-drill
  summary, ACA revision + image tag, and recent **redacted, secret-scrubbed**
  console logs — for attaching to an incident. Secret-scrubbing mandatory (no KV
  values, no tokens).
- **Files:** `app/api/admin/diagnostics/bundle/route.ts` (GET, admin-gated,
  streams the bundle), `lib/admin/support-bundle.ts` (assembler + redactor,
  unit-tested for scrub), `app/admin/diagnostics/page.tsx` (registered via
  admin-shell; `nav-registries.test.ts` green).
- **Per-cloud:** cloud-invariant; IL5 stays in-boundary. **Acceptance (G1):**
  export produces a bundle with real data + a redaction test proving zero
  secrets leak (assert against seeded fake secrets).

## CH1 — Dependency-fault chaos harness + circuit-breaker audit *(completeness gap 7)*

- **Goal:** A13's chaos is Spark-only; Cosmos-429, AOAI-429/timeout, ADX
  cold-start, and KV throttle have no resilience *proof* (breakers exist
  piecemeal in `aoai-apim-gateway.ts` / `redis-cache-client.ts` / Spark). Build:
  (a) a circuit-breaker inventory across `lib/azure/*` (which clients
  retry/backoff/break on 429/503/timeout — a ratcheted
  `docs/fiab/resilience-matrix.md`); (b) a chaos route/harness that injects
  Cosmos-429 (throttling proxy or forced high-RU query), AOAI-429/timeout,
  ADX-cold, KV-throttle, asserting the surface degrades to an honest gate /
  stale-serve — never a crash or dark render. Model on A13 +
  `getOrComputeCached`'s `serveStaleOnError`.
- **Files:** `app/api/admin/chaos/dependency/route.ts` (admin + flag-gated;
  extends A13's chaos route), `lib/resilience/breaker-audit.ts`, a
  `loom-ui-verify` drill; `docs/fiab/resilience-matrix.md` +
  `scripts/ci/check-breaker-coverage.mjs` ratchet (reuse the shared
  `_ratchet-count.mjs` helper).
- **Cross-reference:** enterprise-hardening owns admission-control/rate-limiting
  + AOAI 429 *retry* specs; CH1 is fault-*injection* proof — cite, don't
  duplicate.
- **Per-cloud:** Commercial + Gov live drill; IL5 design. **Acceptance (G1):**
  injected Cosmos-429 during a cost fan-out → page serves stale + honest banner,
  no 5xx; audit ratchet passes.

## EXP1 — Workspace export / import / clone bundle *(completeness gap 8 — metadata-plane portability; DR ≠ config portability)*

- **Goal:** `.loomapp` export is app-scoped only; there is no whole-workspace
  export/clone. WS-DR proves *Azure-service* restorability, not Loom-level
  config portability. Export a workspace (its items, bindings, grants-manifest,
  non-secret config) to a portable `.loomws` bundle in ADLS/Blob; import into a
  fresh workspace/estate; clone within an estate.
- **Files:** `lib/workspace/workspace-export.ts` + `workspace-import.ts` (pure
  serialize/deserialize over the Cosmos `Workspace` + item docs; respects MIG1
  schemaVersion), `app/api/workspaces/[id]/export|import|clone/route.ts`, an
  "Export / Clone" action on the workspace admin surface.
- **Per-cloud:** cloud-invariant metadata; IL5 in-boundary Blob only (no
  cross-cloud). **Acceptance (G1):** export a seeded workspace → import into a
  new one → items + bindings reproduced; dark+light screenshots.

## CMK1 — Cosmos CMK enablement + DR-posture audit row *(completeness gap 9 — IL5-readiness)*

- **Goal:** ADLS `storage.bicep` HAS full CMK (`requireCmk`/`cmkKeyUri`/
  `cmkIdentityId`/`cmkKeyVersion`), as do eventhubs/keyvault — but **Cosmos is
  not CMK-wired** (`loom-console-cosmos.bicep` + `cosmos.bicep`: no
  `keyVaultKeyUri`). For the PRP's IL5-as-design-constraint framing, Cosmos CMK
  is the missing at-rest mandate. Add `keyVaultKeyUri` + identity-based CMK to
  both cosmos modules (guarded `param requireCmk bool`, mirroring
  `storage.bicep`), and extend DR0's `svc-dr-restore-posture` audit row to
  assert CMK-at-rest where `requireCmk`. *(Verification-at-implementation:
  Cosmos CMK must be set at account-create or via a supported update path —
  Learn check.)*
- **Files:** the two cosmos bicep modules (params via the R0 config object);
  extend the DR0 audit check.
- **Per-cloud:** Commercial/Gov GA; IL5 mandated. **Acceptance:**
  `az cosmosdb show` proves `keyVaultKeyUri` set on a scratch/newly-provisioned
  account; audit row green.

## SC1 — Supply-chain enforcement on the REAL deploy path *(SRE F9)*

- **Goal:** `sbom.yml` / `slsa-provenance.yml` / `trivy.yml` exist but are
  **decoupled from the deploy path**: `full-app-deploy-commercial.yml` explicitly
  sets the ACR to allow "newly-pushed unsigned/unscanned images" before
  `az acr build`, and `build-fiab-images.yml` has no `cosign` step — so the
  images that actually run are unsigned/unscanned, and this PRP adds ≥4 more
  Function images with no gate. Wire `trivy` + `cosign` signing into
  `build-fiab-images.yml` / the ACR-build path for **all** images (console + the
  new Functions), re-enable ACR content-trust/scan enforcement in bicep, and
  make the deploy verify the signature before rolling.
- **Files:** `.github/workflows/build-fiab-images.yml` +
  `full-app-deploy-commercial.yml` (+ gov equivalent) — trivy scan + cosign
  sign/verify steps; the ACR bicep module — re-enable enforcement; the "ACR
  temporarily allows unsigned" toggle becomes a tracked drift item in **V5**'s
  scheduled what-if lane.
- **Per-cloud:** Commercial + Gov deploy paths both gated; IL5 design note
  (in-enclave ACR, offline signature verification).
- **Acceptance:** a deploy run shows scan + sign + verify steps green; an
  unsigned scratch image is REJECTED by the roll (paste the rejection); V5 drift
  lane confirms the ACR enforcement toggle matches bicep.

---

## Build order (dependency spine — rev 2)

1. **R0** (WS-R param-cap consolidation) — BLOCKER prereq for every bicep/env
   item in this file.
2. **V1** (synthetic journeys + real MSAL login probe) — PRP #1 priority, ship
   first after R0.
3. **S1 + S2** (secret expiry + feasibility spike) — TOP priority, parallel with
   V1; **S3** after S2's verdict.
4. **DR0** (ADLS versioning gap) — unblocks DR2; small bicep PR.
5. **O1** (unified alert-dispatch) — early Phase 1; V1/DR/C3/A11/S1 alert wiring
   rebases onto it when it lands.
6. **V3** (a11y ratchet) — cheap, extends existing `a11y.uat.ts`.
7. **V2** (visual regression, wide + narrow) — after V3 so contrast + pixel
   gates land together; baselines only after #2382 is deployed.
8. **V4** (route-smoke coverage) — rides the V1 job. **V5** (drift detection) —
   independent, Phase 1.
9. **RUM1** — Phase 1 (closes the real-user blind spot alongside the synthetic
   set).
10. **DR1 → DR2 → DR3 → DR4** — scenario extensions of `dr-drill.yml`, then the
    summary/admin tab.
11. **SLO1, DIAG1, CH1, EXP1, CMK1, SC1** — Phase 2, independent of each other;
    SLO1 after V1 has ≥1 week of run history.

Every PR attaches its G1 receipt (live/preview browser E2E, dark+light where a
surface is involved) per `no-vaporware.md` + `loom_browser_e2e_before_done`;
reviewers reject without it. Env-adding PRs serialize on
`env-checks.ts`/`gates/registry.ts`/`registry.test.ts`;
`playwright.config.ts` project additions are batched.
