# DECISIONS — finishline retirement, operator answers

Recorded here because a decision that lives only in a retirement doc, or only in
the estate, is the class of loss `OPERATOR-QUESTIONS.md` was written to prevent.
Each entry states what was asked, what was chosen, and what it obliges.

---

## OP-19 · task `C3` · Function Apps — two asks

**Asked 2026-08. Approved by the operator 2026-09-17. Re-measured at head the
same day, because the page was written from a 2026-08 program and several rows
had gone stale — this one had.**

### (a) Disable the duplicate timers — ALREADY TRUE, and nothing recorded it

**The premise is stale.** OP-19 (a) asserts both function definitions are
*enabled*, making the work run twice if either host recovers. Measured
2026-09-17 on two independent reads, all three definitions on the two hosts are
**disabled**:

```
func-secexp/secretExpiryMonitor    AzureWebJobs.secretExpiryMonitor.Disabled=true    isDisabled=true
func-cpeval/copilotEvaluatorTimer  AzureWebJobs.copilotEvaluatorTimer.Disabled=true  isDisabled=true
func-cpeval/copilotEvaluatorHttp   AzureWebJobs.copilotEvaluatorHttp.Disabled=true   isDisabled=true
```

The crons the hazard rests on are confirmed identical: NCRONTAB `0 0 6 * * *` is
06:00 UTC and job `loom-secret-expiry-monitor` is `0 6 * * *` = 06:00 UTC; the
same for `0 0 7 * * *` / `loom-copilot-evaluator` `0 7 * * *`. So the hazard was
real; it is simply already mitigated.

**Chosen: record it and guard it, do not re-perform it.** The disable was done
**out of band** — no bicep, script, workflow, issue or PR in this repo sets those
settings, and the two hosts have had no bicep declaration since #2556 deleted
`copilot-evaluator-function.bicep` and `secret-expiry-monitor-function.bicep`.
There is therefore **no bicep change that could have disabled them**; it is an
estate action, and the estate has already taken it. Re-running it would change
nothing and would prove nothing.

What was missing was any record, so a re-enable would have been silent. Added:

* `scripts/csa-loom/check-retired-function-timers.sh` — read-only by default,
  `--apply` re-disables, Commercial-boundary guard, fail-closed. It distinguishes
  three states that an earlier revision collapsed (`deploy-integrity.md` R7):
  a host **absent from a successful listing** is `GONE` and the hazard is retired
  by teardown (rc 0); a host that **exists** but whose settings or definition
  cannot be read is `UNKNOWN` (rc 2, verdict refused); a readable definition that
  is not disabled is `ENABLED` (rc 1). `ENABLED` outranks `UNKNOWN` because a
  confirmed live hazard is more actionable than an unmeasured one, and the tally
  line prints on every path so a partial-coverage run states its own partiality.
  Without the `GONE` arm the script would have broken on its OWN remediation:
  part (b) deletes both hosts, after which every read fails.
  Proved to have teeth against a sandbox copy, all arms run (`temp/timers-probe.sh`,
  a stub `az` on `PATH`; the pre-fix script extracted to a sandbox copy and run
  against the identical stub for the counterfactual):
  all-hosts-deleted 1 → 0, partial-unreadable 1 → 2, genuine `ENABLED` 1 → 1
  (unchanged), failed listing → 2 and never `GONE`, all-disabled 0 → 0.
  Measured, not predicted: the pre-fix script did not reach its own rc=2 refusal
  once the hosts were gone — its app-settings read was unguarded, so `set -e`
  killed it at the first target with rc=1, the same code as a live hazard. Both
  reads are guarded now.
* The four in-tree comments asserting "ENABLED timers" corrected at their sites,
  not just in the doc: `admin-plane/main.bicep`, `report-subscriptions-job.bicep`,
  `scripts/csa-loom/deploy-report-subscriptions-job.sh`,
  `azure-functions/report-subscriptions/src/main.ts`.

**Obliges:** run the check before any claim that the hazard is retired; if the
Console ever grows an estate-drift surface, this belongs on it. After part (b)
lands the check keeps passing — it reports `RETIRED`, not a refusal.

### (b) Teardown of the seven Function Apps — APPROVED, partly unblocked

**Re-measured, wider window, live control.** `FunctionExecutionCount`
2026-08-17 → 2026-09-17 (P1D, Total) is **0** for all seven, 31/31 datapoints
each carrying an explicit `0.0`, `absent=0`, `errorCode=Success` — against
`func-csa-inabox-copilot-fg` at **73** on the same metric, aggregation, interval,
window and code path. Full table, falsification criteria and the two window traps
that would have faked it: `docs/fiab/deployment/functions-to-aca-jobs.md` §8.1.

**Chosen: remove three now, keep two, defer two.**

| | apps | why |
|---|---|---|
| **Remove** | `func-cpeval-*`, `func-secexp-*`, `func-rptsub-*` | zero executions, live ACA replacement, and **no bicep declaration** — their modules are already deleted, so no from-scratch deploy re-creates them and removal is purely an estate action |
| **Keep** | `func-loom-posture-refresh-*`, `func-lblprop-*` | zero executions, but they are still the *intended* runtime for live capabilities with **no replacement built** (§4.1, §4.4). Deleting their producers removes a capability rather than a duplicate |
| **Defer** | `func-csa-loom-mcp`, `func-loom-prpt-renderer-*` | genuinely superseded by live Container Apps, but each producer is load-bearing for Console env vars, health probes and admin env-checks, and `builtin-mcp.bicep` sits behind 19 sites in `admin-plane/main.bicep` plus a KV secret and the generated ARM template. A Console + orchestrator change, not a Function-App teardown |

**One live reference blocked the first row and has been fixed.**
`full-app-deploy-commercial.yml`'s post-deploy eval re-baseline resolved
`func-cpeval-*` and POSTed to its `copilotEvaluatorHttp` trigger. That reference
was never repointed when B-FN retired the Function, and the step has been
**broken since**: on the last successful run of that workflow (31251849951,
2026-08-08, job 93093352285) it failed with
`ERROR: Operation returned an invalid status 'Bad Request'` / exit 1, hidden
behind `continue-on-error: true`. It now starts an execution of the live
`loom-copilot-evaluator` Container App Job using the same override contract the
Console's "Run now" uses, with the `2>/dev/null` / `|| true` result-discarding
removed (`deploy-integrity.md` R6/R7).

**Obliges:** the operator runs the three `az functionapp delete` commands in
§8.3; the Y1 plans, host storage accounts and App Insights components are
separate resources and survive that command, so the billing claim needs the
`az resource list` check in §8.3 too. `grant-navigator-rbac.sh`'s `RPTSUB_FUNC`
block becomes dead once `func-rptsub-*` is gone — it no-ops safely, so it is not
urgent, but it should go with the app.
