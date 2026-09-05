# CLOUD PARITY — same capabilities, every cloud (die-hard rule)

**Effective: 2026-08-07. Scope: every CSA Loom capability, item type, editor,
app, provisioner, API route, bicep module, and workflow — Commercial, GCC
(supported-in-code only, never exercised — see § Supported-in-code is not
ever-exercised), GCC-High, IL5, DoD, and any sovereign boundary Loom claims to
support. All branches, all contributors (human or agent). This rule sits ABOVE
convenience and ABOVE shipping speed.**

## The rule (operator intent, 2026-08-07)

> "They need parallel support offering the same capabilities and features no
> matter the cloud."

**A capability that works in Commercial and not in Gov is INCOMPLETE, not
"Commercial-first".** There is no tier of customer who gets a lesser product
because of the boundary they run in. Feature parity across clouds is the
definition of done, not a follow-up item.

## Why this is load-bearing, not aspirational

Sovereign customers are frequently the ones who need Loom's differentiators
MOST, because the managed services they would otherwise use do not exist in
their boundary. The clearest case: **Databricks Unity Catalog is not available
in Azure Government.** Loom Unity + Iceberg/Trino external-engine federation is
therefore not a parity checkbox in Gov — it IS the catalog and federation story
for those customers. Shipping it Commercial-only inverts the priority: the
boundary with the greatest need gets the least product.

## What "done" means

1. **A feature ships to ALL supported boundaries or it is not shipped.** If Gov
   lags, that lag is a tracked defect with an owner and a date — never a silent
   state, and never an unstated assumption in a status report.
2. **Every bicep module, param file, and workflow covers every boundary.** A
   module gated on `containerPlatform == 'containerApps'` must be verified to
   take that branch in the Gov params too, not assumed to.
3. **Where a cloud genuinely lacks a dependency, Loom supplies the
   Azure-native/OSS equivalent** — the same answer `no-fabric-dependency.md`
   gives for Fabric. "That Azure service isn't in Gov" is the START of the
   design problem, not the end of it.
4. **Parity is claimed only with a per-cloud receipt.** Commercial green proves
   nothing about Gov. Per `deploy-integrity.md` R4 each boundary is verified
   independently, and per the Gov access rule that receipt comes from a GitHub
   Actions run, never local `az`.
5. **Docs state per-cloud status explicitly.** A feature page that describes
   only the Commercial path is incomplete documentation.

## Supported-in-code is not ever-exercised

Two states, never interchangeable:

- **Supported-in-code** — the bicep, params, workflow and endpoint resolver for
  the boundary exist and pass validation (`az bicep build`, actionlint, the
  `scripts/ci/check-*` guards). This proves the code compiles for that
  boundary. It proves nothing about whether it deploys.
- **Ever-exercised** — the boundary has produced at least one real deploy
  receipt: a workflow run whose deploy job executed steps against a live
  subscription in that boundary (`deploy-integrity.md` R2 / R4). A failing
  deploy job that ran is a receipt; a green run whose deploy job was skipped
  at 0 steps is not.

Listing an unexercised boundary beside exercised ones overstates coverage.
Any table, matrix, rule scope or status report that names boundaries side by
side MUST mark the unexercised ones as such — "supported-in-code, never
exercised" plus the measurement — and link the recorded decision.

**Measured example — GCC (#3078, #4071; decided 2026-09-03).** GCC is
supported-in-code (`platform/fiab/bicep/params/gcc.bicepparam`,
`.github/workflows/deploy-fiab-gcc.yml`, `boundary` `@allowed` includes
`'GCC'`) and has never been exercised:

- GCC is a different tenant type — public-cloud Azure under a
  government-community M365 identity (`deploy-fiab-gcc.yml:106`
  `AZURE_CLOUD: AzureCloud`; `:934` "no az cloud set"), whereas
  `deploy-fiab-gcch.yml` and `deploy-fiab-il5.yml` both
  `az cloud set --name AzureUSGovernment`. No GCC tenant exists to
  authenticate against, so no login unblocks it.
- The lane reads four `AZURE_GCC_*` secrets; `gh secret list` shows 0
  `AZURE_GCC_*` names against 4 `AZURE_GOV_*` (re-measured 2026-09-03).
- Its last 20 runs are 20/20 `success`; on all 20 the
  `Deploy + validate CSA Loom in GCC` and `Post-deploy bootstrap (GCC)` jobs
  were `skipped` with `steps=0` (jobs API, 2026-09-03). Green over nothing.
  Over the WHOLE population — 75 recorded runs, 2026-05-23 → 2026-08-08 — the
  count that matters is the same: **0 runs ever executed a deploy step** (63
  `success` with every deploy job present skipped at 0 steps — only the 21
  runs from 2026-07-16 on carry BOTH, since `Post-deploy bootstrap (GCC)` did
  not exist before then — and 12 `startup_failure` with no jobs at all).
  Quote the population, not just the last page of it, and check that a job
  you are counting existed across the whole window.
- `gcc.bicepparam` never sets `deployAppsEnabled` (main.bicep defaults it
  false), so even a credentialed run would stand up zero Container Apps
  (#3078) — disclosed in the param file and deliberately not flipped without
  a GCC image producer.
- The lane is `disabled_manually` with the reason recorded in
  `scripts/ci/workflow-lane-states-allowlist.json` (reviewBy 2026-11-11), and
  its cron path fails closed on missing secrets (`:137-146`, #3219). That is
  the fix completed, not neglect.

Recorded decision: `PRPs/active/drain-2026-08-31/DECISIONS.md`
(§ "#4071 + #3078") and PR #4259's closing comment. The `deployAppsEnabled`
plumbing and image-producer wiring stay on `feat/4071-gcc-enable` if a GCC
tenant is ever provisioned. Measured the same day: Commercial and GCC-High
carry deploy receipts (the GCC-High deploy job ran 33 steps on 2026-09-01);
`deploy-fiab-il5.yml` is `active` with no recorded run at all — watched by
`scripts/ci/check-deploy-staleness.mjs` (#3449, #3888), and not to be listed
as exercised either until it has one.

## Explicitly forbidden

- "Commercial-first, Gov later" as a shipping plan with no dated owner.
- A capability marked done/A-grade on a Commercial-only receipt.
- A bicep module or workflow that silently no-ops in a sovereign boundary.
- A status report that says a feature works without naming which clouds.
- A boundary table, matrix, rule scope or status report that lists a
  never-exercised boundary beside exercised ones without saying so.
- Treating a Gov gap as lower priority than a Commercial polish item.

## How to spot a violation

```bash
# Modules invoked on Commercial but not on the Gov path:
grep -rn "module loom" platform/fiab/bicep/modules/admin-plane/main.bicep
grep -rn "containerPlatform" platform/fiab/bicep/params/*gov* platform/fiab/bicep/params/*gcc* 2>/dev/null
# Backends enabled in Commercial params but absent from Gov params:
diff <(grep -o "loomBackends[^,]*" platform/fiab/bicep/params/commercial-full.bicepparam | sort) \
     <(grep -o "loomBackends[^,]*" platform/fiab/bicep/params/gov*.bicepparam 2>/dev/null | sort)
# Gov workflows that have never produced a receipt:
for wf in gov-build-images gov-provision-dataplane-images gov-provision-streaming-migrate gov-workspace-identity; do
  echo "== $wf"; gh run list --workflow "$wf.yml" --limit 1 --json conclusion --jq '.[].conclusion // "NEVER RUN"'
done
# Boundary lanes that are green without ever executing a deploy step
# (supported-in-code, never exercised — the GCC shape, `steps=0` on the deploy job):
for wf in deploy-fiab-gcc deploy-fiab-gcch deploy-fiab-il5; do
  echo "== $wf"
  for id in $(gh run list --workflow "$wf.yml" --limit 3 --json databaseId --jq '.[].databaseId'); do
    gh api "repos/:owner/:repo/actions/runs/$id/jobs" --jq '.jobs[] | "\(.name) | \(.conclusion) | steps=\(.steps|length)"'
  done
done
```

## Verification per merge

A PR adding or changing a capability states which boundaries it was verified
against and how. Commercial-only is declared Commercial-only — never implied
complete. An untested boundary is named as untested.

Related: `deploy-integrity.md` (R4 both clouds, R2 merged ≠ done),
`no-fabric-dependency.md` (supply the Azure-native equivalent),
`no-vaporware.md`, `auto-bind-by-default.md`.
