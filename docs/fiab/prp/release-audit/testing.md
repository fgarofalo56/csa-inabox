# Release-readiness audit — TESTING + CI dimension

Audited: 2026-07-02, worktree `fix-ui-wave2-a` (branch `feat/loom-marketplace`).
Method: read every test/CI artifact (workflows, vitest config, playwright config,
guardrail scripts, branch protection via `gh api`), then **ran the full vitest
suite locally** to establish ground truth. Every claim below carries file:line
evidence or a command transcript.

## Executive summary

The repo has a surprisingly large and real test estate — **553 vitest test
files / 5,462 tests** in `apps/fiab-console`, a multi-project Playwright
harness (`uat`, `verify`, `family-walkthrough`, in-VNet `loom-uat` ACA job),
four bespoke merge-blocking guardrail scripts, and a genuine PR-time
`next build` compile+type gate. That is B-grade raw material.

What makes the dimension C-grade is the **wiring**: the entire 5,462-test
vitest suite is not executed by ANY CI workflow, and it is currently RED (48
failing tests across 22 files at this branch head, confirmed by a local run).
No Playwright/E2E runs on PR or before a production roll. The Loom Guardrails
workflow runs on PRs but is NOT a required status check, and branch protection
requires **zero approving reviews** — so the only thing that actually blocks a
console change from reaching `main`, and from there auto-rolling to the live
Container App, is `next build` plus five unauthenticated HTTP probes after the
prod roll. For a public release, the top-10 user journeys ship on hope.

### What runs today, at each stage

| Stage | Gate | Blocking? |
|---|---|---|
| PR | `next build` (compile + types via tsconfig.build.json) | YES (required check) |
| PR | check-item-routes + no-bare-server-fetch | YES (steps inside required build job, `.github/workflows/fiab-console-ci.yml:83,92`) |
| PR | Loom Guardrails (route-guards / env-sync / no-freeform / bicep-sync) | runs, **NOT required** |
| PR | Python tests ×3, dbt compile ×4, lints, secret scan, hygiene | YES (required) — but irrelevant to console behavior |
| PR | Trivy, Bicep lint, Checkov, copilot-evals | run, not required |
| PR | **vitest (5,462 tests)** | **NEVER RUNS** |
| PR | ESLint (console) | **NEVER RUNS** (`ignoreDuringBuilds: true`) |
| PR | Playwright E2E | **NEVER RUNS** |
| merge→prod | build-fiab-images-acr-tasks (push to main) → loom-roll-and-validate (auto) | rolls LIVE, then validates |
| post-roll | loom-validate-live.sh: 5 HTTP probes (health, version, marker, 2 page renders, copilot tools) + auto-rollback | yes, but after prod exposure |
| weekly | loom-ui-verify (`verify` project = admin health + API probes only) | scheduled Mon 06:00 |
| manual | csa-loom-validate (service-health.mjs), loom-uat ACA job, deep-functional UAT | dispatch only |

### What would catch a regression in the top-10 user journeys before ship?

Honest answer: **nothing automated**. A regression in "create a lakehouse",
"run a notebook", "run a pipeline", "query a warehouse", "subscribe in
marketplace", "install an app" etc. is caught pre-merge only if it breaks
compilation, a guardrail regex, or one of the two static guards. The rich
journey-level specs exist (`e2e/deep-functional-uat.uat.ts` drives every
catalog item's primary action; `e2e/*.uat.ts` cover apps/nav/admin/copilot)
but only run manually against the single live deployment. Post-merge, the
auto-roll's probes check that two pages *render HTML* — not that any action
works.

---

## Findings (full, uncapped)

### T1 — CRITICAL: the 5,462-test vitest suite never runs in CI, and it is currently red
- Evidence (no CI wiring): `grep -in "vitest|pnpm test" .github/workflows/*` →
  zero hits for the console (only `portal/react-webapp` jest in
  `frontend-test.yml:55` and the CLI's `npm test` in `publish-loom-cli.yml:52`).
  `fiab-console-ci.yml` steps are: change-detect, check-item-routes (l.83),
  no-bare-server-fetch (l.92), install, `pnpm build` (l.109) — no test step.
- Evidence (suite is red): local run 2026-07-02,
  `npx vitest run` in `apps/fiab-console`:
  `Test Files  22 failed | 531 passed (553); Tests  48 failed | 5414 passed (5462); Duration 187.64s`.
  Example failure: `app/api/items/[type]/[id]/assist/__tests__/route.test.ts:258`
  — `expected 502 to be 200` (assist route optimize-mode contract broken).
- Failing files (second confirming run, `grep "FAIL"` on full output; count = failing tests per file):
  `app/api/admin/__tests__/admin-routes.test.ts` (12),
  `app/api/items/[type]/[id]/assist/__tests__/route.test.ts` (6),
  `app/api/items/kql-queryset/[id]/assist/__tests__/assist-route.test.ts` (4),
  `app/api/copilot/sessions/__tests__/cell-fix-route.test.ts` (4),
  `lib/components/pipeline/__tests__/connector.test.ts` (2),
  `app/api/notebook/[id]/assist/__tests__/assist-route.test.ts` (2),
  `app/api/admin/mcp-servers/deploy/__tests__/catalog-deploy.test.ts` (2),
  plus 1 each in `lib/editors/__tests__/{report,foundry-playground,data-pipeline}.test.tsx`,
  `lib/components/pipeline/__tests__/{hdinsight-activities,activities-roundtrip}.test.ts`,
  `lib/azure/__tests__/{shortcut-external-bind,monitor-routes,loom-data-products-search,data-access-mode}.test.ts`,
  `app/connections/__tests__/page.test.tsx`,
  `app/api/deployment-pipelines/__tests__/loom-pipeline-routes.test.ts`,
  `app/api/catalog/__tests__/{search,register}.test.ts`.
  Note the cluster: admin routes + every AI-assist route + catalog search/register —
  these are core-journey surfaces, not fringe tests.
- Impact: the exact failure mode the suite was written to prevent is happening —
  regressions land silently because nothing executes the tests. 48 already have.
- Fix: add a `vitest` job to `fiab-console-ci.yml` (same change-detection gate),
  make it a required check, and burn the 48 failures down first. Suite runtime
  is ~3 min — cheap.

### T2 — CRITICAL (process): nothing blocks merge except `next build`; zero required reviews
- Evidence: `gh api repos/.../branches/main/protection` → required contexts =
  `["Python Lint","Python Tests (3.10/3.11/3.12)","PowerShell Lint","Secret Scan","Repo Hygiene","dbt Compile (shared/finance/inventory/sales)","next build (node 20)"]`.
  Ruleset 15128883 `pull_request` rule: `"required_approving_review_count":0`.
- Impact: for a console change, the only behavior-relevant required gate is
  compilation. Combined with T1/T3, a PR that breaks 48 tests and a cross-tenant
  guardrail can merge with no human review, and then auto-deploys (T4).

### T3 — HIGH: Loom Guardrails (incl. the cross-tenant route-guard) is not a required check
- Evidence: `.github/workflows/loom-guardrails.yml:5-9` (runs on PR + feat/**),
  jobs run `scripts/ci/check-route-guards.mjs` etc. (l.30-37), but the required
  contexts list (T2) does not include it. `scripts/ci/check-route-guards.mjs:1-12`
  documents it as "merge-blocker" for the cross-tenant authorization hole class
  that "bit 6+ times".
- Impact: the security-regression class this was built for can merge while red
  (red check is visible but not blocking, and there are no required reviewers
  to notice).
- Fix: add `guardrails` to required status checks.

### T4 — HIGH: merge-to-main auto-rolls to the LIVE production console with no test gate in between
- Evidence: `build-fiab-images-acr-tasks.yml` `on: push: branches: [main]`;
  `loom-roll-and-validate.yml:24-27` `workflow_run` on that build →
  `az containerapp update` (l.82) against the production app, then validates
  via `.github/scripts/loom-validate-live.sh` (l.111-114) — whose probes are
  5 curl checks: `/api/health` (l.29-31), `/api/version` (l.38-46),
  `/build-marker.txt` (l.57-64), `/items/notebook/new` renders (l.72-79),
  `/items/data-pipeline/new` renders (l.87-91), `/api/copilot/tools` wired
  (l.102-116). Auto-rollback on failure (l.116-124) is good, but users see the
  bad revision first.
- Impact: prod is the test environment. For a public release there is no
  staging ring, no pre-roll UAT slice, no smoke of any user journey beyond
  "two pages render HTML".
- Fix: insert a gate between build and roll (at minimum: vitest green + a
  small authed Playwright journey slice against a staging revision label,
  Container Apps supports multi-revision traffic for exactly this).

### T5 — HIGH: no E2E/UAT runs on PR or pre-release — all Playwright harnesses are manual or weekly
- Evidence: `loom-ui-verify.yml:19-41` — `workflow_dispatch` + weekly cron
  only; and its `verify` project covers only `e2e/admin-verify.spec.ts`
  (playwright.config.ts:68-78) = admin health page + API probe classification.
  `csa-loom-validate.yml:12` — dispatch only. The deep journey specs
  (`e2e/deep-functional-uat.uat.ts:1-24` — fills forms, clicks primary action,
  asserts BFF 2xx per catalog item) and the in-VNet `loom-uat` ACA job
  (`scripts/csa-loom/deploy-loom-uat-job.sh:1-60`, tracker #1549 still OPEN)
  require an operator to trigger them.
- Impact: journey regressions are found by the operator, after ship.
- Fix: wire the loom-uat ACA job start + result poll into the roll workflow
  (it already lives in-VNet with the console UAMI; results land in Log
  Analytics as `UAT_RESULT pass/fail/skip`).

### T6 — HIGH: csa-loom-validate computes hard failures but never fails the job
- Evidence: `.github/workflows/csa-loom-validate.yml:97-99` — comment says
  "Fail the job only on hard FAILs" but the step ends with
  `FAILS=$(grep ... || echo 0)` + `echo "Hard failures: $FAILS"`; there is no
  `exit 1` / `[[ $FAILS -gt 0 ]]` check, and the file ends at line 99. With
  `set -uo pipefail` the final `echo` returns 0 → the workflow is green even
  when service-health reports hard failures.
- Impact: the one workflow whose job is to say "the BFF→Azure chain is broken"
  cannot say it. Operators reading a green run get false confidence.
- Fix: `[[ "$FAILS" -gt 0 ]] && exit 1` (one line).

### T7 — MEDIUM: four top-level test files are invisible to vitest (never run anywhere)
- Evidence: `vitest.config.ts:46-49` include globs are only
  `lib/**/__tests__/**` and `app/**/__tests__/**`; the files
  `apps/fiab-console/__tests__/{registry-coverage,apim-policy-scope,apim-xml-validation,copilot-studio-dataverse-scope}.test.ts`
  live at the package root. Confirmed: `npx vitest list __tests__/registry-coverage.test.ts`
  returns nothing. (Full-suite run also reports 553 files vs 557 on disk.)
- Impact: `registry-coverage.test.ts` in particular sounds like a
  catalog-integrity net that silently stopped existing.
- Fix: add `'__tests__/**/*.test.{ts,tsx}'` to the include list (then fix
  whatever broke while they were dark).

### T8 — MEDIUM: no ESLint gate at all for the console
- Evidence: `next.config.mjs:12` `eslint: { ignoreDuringBuilds: true }`;
  `grep -n "pnpm lint|next lint|eslint" .github/workflows/*` → only a stale
  comment in `fiab-console-ci.yml:12`. A `lint` script exists in
  `package.json:12` but nothing calls it.
- Impact: react-hooks/exhaustive-deps, unused vars, a11y lint classes ship
  unchecked in the app that is 90% of the product.

### T9 — MEDIUM: `pnpm test:a11y` matches zero tests — the accessibility gate is vaporware
- Evidence: `package.json:17` `"test:a11y": "playwright test --grep @a11y"`;
  `grep -r "@a11y" apps/fiab-console` matches ONLY package.json itself. The
  `@axe-core/playwright` devDependency (package.json:56) is installed but no
  spec imports/tags it into a runnable set via this script.
- Impact: per `no-vaporware.md` this is a labeled capability that does nothing.
  Public release implies accessibility scrutiny; there is no automated axe pass.
- Fix: tag or write axe specs, or remove the script.

### T10 — MEDIUM: test code is excluded from the type-check everywhere
- Evidence: `tsconfig.build.json:9-15` excludes `**/*.test.*`, `**/__tests__/**`,
  `e2e/**`, `**/*.uat.ts`; the build (the only type gate, `next.config.mjs:11`)
  uses this config. No workflow runs `tsc` over tests.
- Impact: combined with T1 (tests not executed) test files can rot to the point
  of not compiling and nothing notices. Acceptable trade-off ONLY once T1 lands
  (vitest itself will surface compile errors in tests it runs).

### T11 — MEDIUM: CodeQL is not PR-gated
- Evidence: `codeql.yml` `on: push: branches: [main]` + weekly cron — no
  `pull_request`. Trivy does run on PR (`trivy.yml`) but is not a required check
  (T2 contexts list).
- Impact: static security findings arrive after merge. For public release,
  CodeQL on PR (or at least required Trivy) is table stakes.

### T12 — MEDIUM: no coverage measurement or threshold for the console suite
- Evidence: Python side enforces `--cov-fail-under=60` (`test.yml:139-144`);
  the console has no coverage config anywhere (`vitest.config.ts` has no
  `coverage` block; no workflow computes it).
- Impact: even after T1 is fixed, there is no signal on what the 5,462 tests
  actually cover of the ~600 BFF routes / ~190 editors.

### T13 — LOW/MEDIUM: E2E harness is hard-wired to the single live deployment
- Evidence: `playwright.config.ts:27` baseURL defaults to the live Front Door
  URL; `e2e/deep-functional-uat.uat.ts:34` hardcodes
  `WORKSPACE_ID = '00b7b715-...'` ("e2e Playwright UAT" workspace);
  `retries: 0, workers: 1` (config l.22-23).
- Impact: E2E can never run on an ephemeral PR environment; it can only ever be
  a post-deploy check on prod. That structurally prevents pre-merge journey
  gating until a seeded staging target exists.

### T14 — LOW: `guard:circular` exists but is not wired into CI
- Evidence: `package.json:14` `"guard:circular": "node scripts/check-circular-deps.mjs"`;
  `grep check-circular .github/workflows/*` → nothing (only check-item-routes
  at `fiab-console-ci.yml:83` and no-bare-server-fetch at l.92 run in CI).

### T15 — LOW: deploy-workflow smoke is best-effort
- Evidence: `deploy-fiab-commercial.yml:356-360` — "External smoke test" step is
  `continue-on-error: true` ("Console ingress is VNet-internal; external smoke
  is best-effort").
- Impact: the from-scratch deploy workflow can go green with a dead console.
  Understandable given VNet topology, but for the public-release "1-button
  redeploy" acceptance test (no-vaporware.md §teardown validation) an in-VNet
  probe (the loom-uat job pattern) should replace it.

### T16 — LOW: stale/false comments in CI files
- Evidence: `fiab-console-ci.yml:12-15` claims "next.config sets
  typescript.ignoreBuildErrors ... it does NOT fail on pure type/lint nits" —
  but `next.config.mjs:11` now has `ignoreBuildErrors: false` (commit 9804eb4b
  gated the build on types). The comment materially misdescribes the gate.
- Impact: future editors may re-loosen the gate believing types were never
  enforced.

### T17 — LOW: tutorial-coverage check is intentionally non-blocking (tracked)
- Evidence: `fiab-console-ci.yml:121-146` — report-only "until reviewed
  screenshots are published"; documented `--strict` flip. Honest gate, noted
  for completeness; not re-reported as a defect.

### T18 — LOW: no performance gate
- Evidence: `load-tests.yml` is `workflow_dispatch` only; `perf` script
  (`package.json:18` → `scripts/perf-harness.mjs`) not referenced by any
  workflow.

---

## Ranked missing gates for public-release-quality CI

1. **Run vitest in the required `fiab-console-ci` job** (and fix the 48 red
   tests first). ~3 min runtime. (T1)
2. **Make Loom Guardrails a required status check** — it exists precisely to
   block the cross-tenant hole class. (T3)
3. **A journey gate between main-merge and prod roll**: start the in-VNet
   `loom-uat` job (or at minimum the `verify` + a 10-journey slice) and poll
   `UAT_RESULT` before `az containerapp update` shifts traffic; today's gate is
   5 curls after the fact. (T4, T5)
4. **Make csa-loom-validate actually fail on hard FAILs** (one-line fix). (T6)
5. **Required reviews ≥ 1** on main (currently 0). (T2)
6. **Console ESLint on PR** + include the 4 orphaned root test files. (T7, T8)
7. **Real a11y pass** (axe via Playwright) or delete the fake script. (T9)
8. **CodeQL/Trivy required on PR**; console coverage reporting with a floor. (T11, T12)
9. Staging-capable E2E target (parameterized baseURL + seeded workspace) to
   eventually move journey tests pre-merge. (T13)

## Grade rationale

C. Real, substantial test assets and a genuine compile+type PR gate exist (not
D territory), and post-deploy auto-rollback shows operational maturity. But the
defining property of a release-quality pipeline — "a regression in a core user
journey cannot reach users" — is absent: the unit suite is unwired AND red, E2E
is manual, guardrails are advisory, reviews are optional, and merge auto-rolls
to prod. The fixes are mostly wiring, not construction, which is why this is C
and not D.
