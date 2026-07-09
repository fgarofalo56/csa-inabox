# Perf gate + per-roll benchmark receipt (PSR-2)

The perf gate turns *"the benchmark number is the receipt"* (per
[`no-vaporware.md`](../../.claude/rules/no-vaporware.md)) into an enforced contract.
On a roll it runs the PSR-1 benchmark suite against the deployed console, compares
each metric to the trailing-N baseline **and** the checked-in budget, and **fails the
check on a regression beyond budget** — posting the benchmark table into the roll
receipt either way.

It is the perf sibling of the existing per-roll gates: the `vitest (node 20)`
confirmation and the in-VNet `loom-uat` functional gate in
[`loom-roll-and-validate.yml`](../../.github/workflows/loom-roll-and-validate.yml).

## Pieces

| Piece | Path | Role |
|-------|------|------|
| Budget | [`perf-budgets.json`](../../perf-budgets.json) + [`perf-budgets.md`](../../perf-budgets.md) | Per-metric p95 ceiling + max regression %. Every number is justified in the `.md`. |
| Comparison engine (tested) | `apps/fiab-console/lib/perf/compare-budgets.ts` | Pure typed regression-budget math + markdown table. Unit-tested (`__tests__/compare-budgets.test.ts`). Reusable by `/admin/performance`. |
| CI script | `scripts/csa-loom/perf/compare-baseline.mjs` | Self-contained Node twin of the engine. Reads the run + baseline, prints the table, exits nonzero on breach. |
| Workflow | [`perf-gate.yml`](../../.github/workflows/perf-gate.yml) | `workflow_dispatch` + `workflow_call`. Mints a session, runs the suite via the console, compares. |

## How it works

Because the `perf-benchmarks` Cosmos container is private-endpoint / VNet-bound, a
public GitHub runner cannot read it. So the console (which is in the VNet) does the
data work and the runner only orchestrates:

1. **Mint a session** — the runner derives a `loom_session` cookie from
   `SESSION_SECRET` for a tenant-admin `LOOM_AUTOMATION_OID` (the same minting trick as
   `scripts/csa-loom/loom-verify.js` and the `loom-uat` job — no MFA, no user creds).
2. **Run the suite** — `POST {url}/api/admin/performance/run` (PSR-1, tenant-admin-gated)
   returns a `runId`.
3. **Collect** — poll `GET {url}/api/admin/performance?runId=<id>&format=gate` until
   `status:"complete"`; the console returns `{ latest:[...rows], baseline:[...rows] }`
   (it read Cosmos for you). The runner saves that to `perf-bundle.json`.
4. **Compare** — `compare-baseline.mjs` evaluates the bundle against `perf-budgets.json`
   and exits `1` on a breach (RED check), `0` on green.

A metric **breaches** when its latest `p95` exceeds the absolute `p95CeilingMs`, **or**
regresses more than `maxRegressionPct` above the trailing-N baseline median. See
[`perf-budgets.md`](../../perf-budgets.md) for the full rule + per-metric rationale.

### Honest no-op before PSR-1 lands

The gate is deliberately **tolerant**: if the `/api/admin/performance` endpoints are not
deployed yet, return no rows, or the secrets are unset, it emits a `::warning::` and
**passes** (exit 0). It only turns RED on a real measured breach — so it can never
permanently block a roll before PSR-1 ships, matching the emergency-valve philosophy of
the UAT gate.

### Justified regressions

Set `override_label` (dispatch input) / `OVERRIDE_LABEL` (env) to a reason string to
accept a breach for that roll (e.g. a deliberate cold-start trade). The breach is still
computed and printed in the receipt (marked `⚠️ override`); the gate goes green with the
label attached — never a silent pass. Prefer this one-roll override over permanently
loosening a budget.

## Required secrets

| Secret | Purpose |
|--------|---------|
| `SESSION_SECRET` | Mint the automation session cookie. **Must match** the value the target console runs with. |
| `LOOM_AUTOMATION_OID` | Entra objectId of a **tenant-admin** principal — the run route is admin-gated. |
| `LOOM_AUTOMATION_UPN` | *(optional)* UPN stamped into the session. |

The identity must be a tenant admin so `POST /api/admin/performance/run` resolves. No
Azure login is needed on the public runner (the console reaches Cosmos, not the runner).

## Wiring into the roll runbook

The gate is additive — it does not modify existing workflows. To make it a per-roll
gate, add a downstream job in the roll pipeline after the console is confirmed live
(after `loom-roll-and-validate` validates the new revision):

```yaml
  perf-gate:
    needs: roll-and-validate           # run only after the new revision is live
    uses: ./.github/workflows/perf-gate.yml
    with:
      url: https://loom-console-fvbbctd4eehqbkcs.b02.azurefd.net
      override_label: ''               # set to a reason to accept a justified regression
    secrets:
      SESSION_SECRET: ${{ secrets.SESSION_SECRET }}
      LOOM_AUTOMATION_OID: ${{ secrets.LOOM_AUTOMATION_OID }}
```

Or run it on demand from the Actions tab (`perf-gate` → **Run workflow**) against any
deployed console URL. Each run:

- posts the benchmark table into the **run summary** (`$GITHUB_STEP_SUMMARY`), and
- uploads `perf-bundle.json` as an artifact for trend inspection.

## Local / dry-run

The comparison script runs standalone against a saved bundle — handy for testing a
budget change or reproducing a red check:

```bash
# bundle = { "latest": [...rows], "baseline": [...rows] }
RUN_BUNDLE_FILE=./perf-bundle.json \
PERF_BUDGETS_FILE=./perf-budgets.json \
node scripts/csa-loom/perf/compare-baseline.mjs
```

`LATEST_RUN_FILE` (+ optional `BASELINE_FILE`) or a reachable Cosmos endpoint
(`LOOM_COSMOS_ENDPOINT`) are alternative sources — see the header of
`scripts/csa-loom/perf/compare-baseline.mjs`.

## Dual-cloud

Identical in Commercial and Government: same script, same budget file. Point `url` at the
Gov console Front Door and pass the Gov `SESSION_SECRET` / admin OID. Cosmos + the console
are day-one in Gov, so there is no region gate on the gate itself.
