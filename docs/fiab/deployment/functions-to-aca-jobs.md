# Azure Functions → Container App Jobs (B-FN / C3)

**Status: pattern proven live on Commercial 2026-08-06.** One function
(`report-subscriptions`) migrated and executed end-to-end on the estate in this
pass; the ordered plan for the remainder is in §4.

---

## 1. Why this migration exists

**The Function-hosted runtime on this estate executes nothing.** That is the
claim, and the evidence for it is an execution metric — *not* `function list`,
which does not generalise here and will mislead you if you rely on it.

### The load-bearing evidence: FunctionExecutionCount

`FunctionExecutionCount`, 2026-07-25 → 2026-08-06, `--interval P1D
--aggregation Total`, per app:

```
func-cpeval-k6mvh5sm6z7do                  errorCode=Success  datapoints_with_total=13  absent=0  SUM=0
func-secexp-k6mvh5sm6z7do                  errorCode=Success  datapoints_with_total=13  absent=0  SUM=0
func-rptsub-k6mvh5sm6z7do                  errorCode=Success  datapoints_with_total=13  absent=0  SUM=0
func-loom-posture-refresh-k6mvh5sm6z7do    errorCode=Success  datapoints_with_total=13  absent=0  SUM=0
func-lblprop-k6mvh5sm6z7do                 errorCode=Success  datapoints_with_total=13  absent=0  SUM=0
func-csa-loom-mcp                          errorCode=Success  datapoints_with_total=13  absent=0  SUM=0
func-loom-prpt-renderer-k6mvh5sm6z7do      errorCode=Success  datapoints_with_total=13  absent=0  SUM=0
```

`absent=0` matters: every one of the 13 daily datapoints carries an **explicit
`total: 0.0`**, so these are measured zeros, not missing telemetry. Thirteen
days, seven apps, zero executions — including the apps that hold enabled timers.

### What `function list` actually returns (and why it is NOT the evidence)

Run per app with **stderr visible** — suppressing it is what produced the
earlier, wrong "every app returns `[]`" claim:

| App | `function list` result |
|---|---|
| `func-csa-loom-mcp` | `[]`, exit 0 |
| `func-loom-posture-refresh-k6mvh5sm6z7do` | `[]`, exit 0 |
| `func-rptsub-k6mvh5sm6z7do` | `[]`, exit 0 |
| `func-lblprop-k6mvh5sm6z7do` | `[]`, exit 0 |
| `func-secexp-k6mvh5sm6z7do` | **1 function, `isDisabled: false`** — `secretExpiryMonitor`, `timerTrigger`, schedule `0 0 6 * * *` |
| `func-cpeval-k6mvh5sm6z7do` | **2 functions, both `isDisabled: false`** — `copilotEvaluatorHttp` (httpTrigger) and `copilotEvaluatorTimer` (`0 0 7 * * *`) |
| `func-loom-prpt-renderer-k6mvh5sm6z7do` | **exit 1** — `ERROR: Operation returned an invalid status 'Bad Request'` (`ServiceUnavailable` from the host runtime). **UNKNOWN, not empty.** |

Two consequences:

1. **Do not use this command as the diagnostic.** Two apps report perfectly
   healthy, enabled functions. An engineer who re-runs it on `func-cpeval` and
   sees two live functions will reasonably conclude this document is wrong.
2. **`2>/dev/null` turns the Bad Request into a false negative.** The 400
   produces empty stdout, which reads as `[]` — the UNKNOWN-as-NEGATIVE trap and
   a `deploy-integrity.md` R7 violation (asserting a cause you did not
   establish). That is exactly how the original version of this document came to
   claim a universal that was false in 3 of 7 cases.

The 400 is also the **control that rescues the other readings**: an unreachable
host returns an error rather than an empty list, so the four genuine `[]`
responses are real empties, not silent failures.

### No root cause is asserted

An earlier draft explained this as "Azure Policy seals the AAD-only storage
data-plane, so host keys and timer leases cannot be established." **That
explanation is dropped.** `func-secexp` and `func-cpeval` index fine under the
same policy regime, so the mechanism does not account for its own variance. What
is established is the **outcome** — zero executions over 13 days — not the cause.

The estate standard is therefore an **in-VNet `Microsoft.App/jobs`** (for
scheduled work) or a **Container App** (for HTTP services), running as the
**Console UAMI**.

### Two live hazards this uncovered

* **Double-execution risk on recovery — RETIRED 2026-09-17, see §8.2.**
  `func-secexp`'s timer `0 0 6 * * *` is *identical* to job
  `loom-secret-expiry-monitor`'s `0 6 * * *`, and `func-cpeval`'s `0 0 7 * * *`
  matches `loom-copilot-evaluator`'s `0 7 * * *`. Both function definitions were
  **enabled** when this section was written, so a host that resumed would have
  run the work **twice**, concurrently, on the same schedule. Both are now
  `isDisabled: true` with `AzureWebJobs.<fn>.Disabled=true` — measured, §8.2.
  The two hosts still **index** those definitions, so the "`function list` does
  not generalise" lesson above is unchanged.
* **Two silently dead capabilities.** `func-loom-posture-refresh` and
  `func-lblprop` are still the **intended** runtime for posture-refresh and
  scc-labels — they index zero functions *and* execute zero. Those capabilities
  are not degraded; they are not running at all, and nothing says so.

---

## 2. The migration pattern (proven)

For a **timer-triggered** function:

| Step | Artifact | Notes |
|---|---|---|
| 1 | `src/run-logger.ts` | `RunLogger` = the `log/warn/error` subset the handler used, so the body ports unchanged. |
| 2 | `src/run-<verb>.ts` | The handler body, `InvocationContext` → `RunLogger`, returning a summary object. No behaviour change. |
| 3 | `src/main.ts` | One-shot entrypoint. **Exit-code contract below.** |
| 4 | `Dockerfile` | Two-stage `node:20-bookworm-slim`, non-root `USER node`, `CMD ["node","dist/src/main.js"]`. Build context = the function dir. |
| 5 | `package.json` | Drop `@azure/functions`; `main` → `dist/src/main.js`; `start` → `node dist/src/main.js`. |
| 6 | Delete `host.json` + `src/functions/` | The Functions host is gone. |
| 7 | `modules/admin-plane/<name>-job.bicep` | `Microsoft.App/jobs@2025-02-02-preview`, `triggerType: Schedule`, 5-field UTC cron, console UAMI for identity **and** registry pull. |
| 8 | Wire into `admin-plane/main.bicep` | Guard on `… && containerPlatform == 'containerApps' && deployAppsEnabled`. |
| 9 | `scripts/csa-loom/deploy-<name>-job.sh` | ACR firewall **lease** (never a bare open — #2603) → `az acr build` → release → `job create|update`. |
| 10 | `.github/workflows/deploy-<name>.yml` | Dispatchable wrapper. **Required**, or the path is invisible to the merged≠deployed watchdog by construction. |
| 11 | Register in `scripts/ci/check-deploy-staleness.mjs` `WATCHED` | bicep creates the JOB but never builds the IMAGE. |

### The exit-code contract (do not deviate)

* **Exit 0** on a completed pass, **including an honest config gate** (an unset
  endpoint is a configuration state, not a code failure) and including
  per-item failures that are durably recorded elsewhere.
* **Non-zero only on an unexpected throw.**

So a `Failed` execution in the job history is *always* a real regression worth
paging on. This is the property that makes the job history a usable signal.

### Cron translation

Container Apps jobs take a **standard 5-field UTC cron**. The retired Functions
used **6-field NCRONTAB**. Drop the leading seconds field:
`0 */15 * * * *` → `*/15 * * * *`.

### Identity: the step that disappears

The retired Functions each had a system-assigned identity that needed grants
applied **after** deploy (`grant-navigator-rbac.sh`), because the principalId
did not exist at template time. Running as the **Console UAMI** removes that
step entirely — it already holds Cosmos Built-in Data Contributor, Storage Blob
Data Contributor, Key Vault Secrets User, and (for report-subscriptions) Logic
App Contributor on the delivery workflow, granted by
`integration/report-subscription-logicapp.bicep`.

**Watch for duplicate role assignments.** If a module salts its `guid()`
differently for a "secondary" principal, passing the Console UAMI to both
parameters attempts two assignments for the same principal+role+scope and fails
with `RoleAssignmentExists`. Pass empty instead — see `digestPrincipalId` in
`platform/fiab/bicep/main.bicep`.

---

## 3. Inventory — measured 2026-08-06

`az containerapp job list` / `az containerapp list` / `az functionapp list` on
`rg-csa-loom-admin-centralus`. **Every Function App below has executed nothing
for 13 days** (§1) regardless of its `Running` state. Note that "executes
nothing" is not the same as "indexes nothing" — two of them still hold enabled
function definitions; see the per-app table in §1.

| # | Source dir | Runtime | Trigger(s) | Function App (0 executions) | ACA equivalent | Migrated |
|---|---|---|---|---|---|---|
| 1 | `copilot-evaluator` | Node | timer → schedule | `func-cpeval-*` | **job** `loom-copilot-evaluator` `0 7 * * *` | ✅ done (pre-C3) |
| 2 | `lineage-extractor` | Node | timer → schedule | — | **job** `loom-lineage-extractor` `*/15 * * * *` | ✅ done (pre-C3) |
| 3 | `secret-expiry-monitor` | Node | timer → schedule | `func-secexp-*` | **job** `loom-secret-expiry-monitor` `0 6 * * *` | ✅ done (pre-C3) |
| 4 | `paginated-report-renderer` | Python | 2× HTTP | `func-loom-prpt-renderer-*` | **app** `loom-prpt-r3` (`loom-prpt-renderer:v0.1`, source `apps/fiab-prpt-renderer`) | ✅ done (pre-C3) |
| 5 | `mcp-server` | Python | 2× HTTP | `func-csa-loom-mcp` | **app** `loom-mcp` (`loom-mcp:0.80.0`, source `apps/loom-mcp`) | ✅ superseded (pre-C3) |
| 6 | `report-subscriptions` | Node | 1× timer | `func-rptsub-*` | **job** `loom-report-subscriptions` `*/15 * * * *` | ✅ **this PR — proven live** |
| 7 | `posture-refresh` | Python | 1× timer `*/5` + 3× HTTP | `func-loom-posture-refresh-*` | — | ❌ |
| 8 | `access-governance-sweeper` | Python | 3× timer + 4× HTTP | not deployed | — | ❌ |
| 9 | `ops-agent-evaluator` | Node | 1× timer | not deployed | `monitor-ops-agent-aca.bicep` exists but is a standalone Gov-only entrypoint and **has never been deployed** | ❌ |
| 10 | `scc-labels` | PowerShell | 2× HTTP | `func-lblprop-*` | — | ❌ |
| 11 | `copilot-chat` | Python | 5× HTTP | not in the admin RG | — | ❌ (separate deploy; confirm target before touching) |

So the audit's "11 to migrate" is really **5 already done, 1 done here, 5
remaining** — and of the 5 remaining, only 2 are purely job-shaped.

### Side findings recorded, not fixed here

* ~~**`apps/fiab-report-subscriptions` is orphaned.**~~ **CLOSED by C2
  (finishline, PR #3077).** It held the B-N19d insight digest engine
  (`insights-engine.ts`, `insight-digest-model.ts`) and was referenced by **no**
  bicep module, workflow, or script — so no scheduled digest had ever run. Its
  report-delivery half also rendered via **Power BI ExportTo**, violating
  `no-fabric-dependency.md`. The engine has been ported onto
  `azure-functions/report-subscriptions` (this job — it now runs a digest pass
  after the delivery pass in the same execution) and the orphaned tree deleted.
* **The superseded Function Apps are still deployed.** `func-cpeval-*`,
  `func-secexp-*`, `func-loom-prpt-renderer-*`, `func-csa-loom-mcp`,
  `func-rptsub-*` all have live ACA replacements and are cost + confusion — and
  for the first two, a **double-execution hazard** (§1). Removal is deliberately
  **not** paired with this PR (see §5).

---

## 4. Ordered plan for the remainder

Ordered by *risk removed per unit of work*. Each step is one PR.

1. **`posture-refresh` (timer half) → job `loom-posture-refresh`.**
   Highest value: `func-loom-posture-refresh-*` is still the **intended** runtime
   for a security-posture surface, and it indexes zero functions *and* has
   executed zero times in 13 days — so the console is reading posture that
   nothing refreshes, silently. The `*/5` timer is a clean port of the pattern
   above. Its 3 HTTP routes (`health`, `posture-refresh-admin`,
   `posture-refresh` POST) must move with it — fold them into the console BFF
   (they are admin-only and the console already authenticates), or split a small
   Container App. **Do not migrate the timer and leave the HTTP callers pointing
   at the dead host.** Check `LOOM_POSTURE_FUNCTION_KEY` /
   `loom-posture-function-key` in Key Vault: a host key for a keyless job is
   dead config to remove.

2. **`ops-agent-evaluator` → job.** Purely timer-triggered, Node, and a bicep
   module (`monitor-ops-agent-aca.bicep`) already exists — it needs an image
   build path, a `WATCHED` entry, and wiring into `admin-plane/main.bicep`
   rather than remaining a standalone Gov entrypoint. Cheapest remaining row.

3. **`access-governance-sweeper` → job + BFF routes.** 3 timers, so either one
   job with an internal dispatcher or three jobs; prefer **one job with a
   `SWEEP_MODE` env** to keep the image count down. Its 4 HTTP routes are
   "run now" triggers — those become `az containerapp job start` from the BFF, a
   strictly better design than an HTTP function. Not deployed today, so there is
   no live regression pressure.

4. **`scc-labels` → Container App (not a job).** PowerShell, 2× HTTP. Needs a
   PowerShell base image and a rewrite of `run.ps1` into a small HTTP server, or
   a port to Node. Confirm who calls `/labels` and `/dlp` **before** migrating —
   `func-lblprop-*` indexes zero functions and has executed zero times, so
   today's callers are already failing and the answer may be "nobody, delete it".

5. **`copilot-chat` → confirm target first.** 5× HTTP, and it is *not* in the
   admin RG, so its deployment target must be established before any migration.
   Per the two-backends note, feature work already lives here; do not assume it
   is dead the way the admin-RG hosts are.

6. **Removal PR** — delete the retired Function Apps and their bicep once each
   replacement has a live receipt (§5).

---

## 5. Removal is deliberately NOT paired with migration

Per the task constraint and `deploy-integrity.md` R2, a Function App is removed
only after its replacement is **proven live on the estate**. This PR deletes
`report-subscriptions-function.bicep` (the module) because
`report-subscriptions-job.bicep` is proven live — but the **already-provisioned**
`func-rptsub-*` resource is left standing for a follow-up removal commit,
together with the other four superseded hosts, so that a single reviewable change
removes them all with their receipts attached.

**That follow-up landed as §8 (OP-19, 2026-09-17).** When this was written,
`func-secexp` and `func-cpeval` still held **enabled** timer definitions on
schedules identical to their ACA replacements (`0 0 6 * * *` vs `0 6 * * *`;
`0 0 7 * * *` vs `0 7 * * *`), and nothing in the platform *prevented* them from
resuming. **Both are disabled now** (§8.2) — done out of band, so §8.2 is the
only record of it. The standing check is **added but never exercised** — the
`op19-retired-timers` job in `.github/workflows/loom-drift-check.yml` runs
`scripts/csa-loom/check-retired-function-timers.sh` read-only on the weekly
drift schedule and fails the job on both "a timer is ENABLED" and "I could not
measure", but as of this writing it **has not yet produced a run**, so it is
supported-in-code, never exercised (`cloud-parity.md`) and is not yet evidence
of anything. §8.2 carries the full disclosure. The per-app removal disposition,
with the reference audit each deletion needs, is §8.3.

---

## 6. Live receipt — `report-subscriptions`, 2026-08-06

Image built server-side by ACR Tasks under the firewall lease (registry re-locked
afterwards, fail-closed):

```
[deploy-report-subscriptions] 2/4 Building loom-report-subscriptions:latest via ACR Tasks...
  runId cj32m   status Succeeded   startTime 2026-08-06T21:32:57Z
[deploy-report-subscriptions] Image built: <acr>/loom-report-subscriptions:latest
[acr-lease] re-locking ACR (defaultAction=Deny, publicNetworkAccess=Disabled) ...
```

Job state:

```
name       loom-report-subscriptions      trigger    Schedule
cron       */15 * * * *                   container  report-subscriptions
image      <acr>/loom-report-subscriptions:latest
timeout    840        retry 0             state      Succeeded
```

Execution:

```
$ az containerapp job start -n loom-report-subscriptions -g <rg>
loom-report-subscriptions-4kbeqkv

Name                               Status     Start                 End
loom-report-subscriptions-4kbeqkv  Succeeded  2026-08-06T21:36:20Z  2026-08-06T21:36:54Z
```

Container log:

```
[report-subscriptions] 0 enabled, 0 due at 2026-08-06T21:36:44.801Z
[report-subscriptions] pass complete in 920ms — enabled=0 due=0 delivered=0 failed=0
```

**Why that proves the backend, not just a clean exit.** `0 enabled` is printed
*after* `readEnabledSubscriptions()` returns. An unset endpoint would have
printed `honest gate: LOOM_COSMOS_ENDPOINT`; an unreachable account or missing
container would have thrown and printed `cannot read subscriptions`. Neither
appeared, so the job authenticated with the Console UAMI and executed a real
cross-partition Cosmos query that legitimately returned zero rows. Both
containers exist:

```
$ az cosmosdb sql container list -g <rg> -a <cosmos> -d loom --query "[?contains(name,'report')].name" -o tsv
report-delivery-log
paginated-report-definitions
report-subscriptions
```

Config wired on the live job — note `LOOM_REPORT_RENDERER_URL`, which
`src/clients.ts` has always read and which **bicep set nowhere** before this
change (every render would have thrown):

```
LOOM_COSMOS_ENDPOINT              https://cosmos-loom-default-….documents.azure.com:443/
LOOM_REPORT_RENDERER_URL          https://loom-prpt-r3.internal.….centralus.azurecontainerapps.io
LOOM_SUBSCRIPTION_LOGIC_APP_NAME  logic-loom-report-subs-centralus
```

### Not proven, stated plainly

* **An actual email delivery.** There are zero enabled subscriptions on the
  estate, and delivery requires the Logic App's Office 365 connection to be
  authorized by an operator. Render → deliver → delivery-log is exercised by
  unit tests, not by this live run.
* **The bicep path.** The job on the estate was created by
  `deploy-report-subscriptions-job.sh` (the image-build path). The bicep module
  compiles and `check-deploy-template-sync.mjs` passes byte-identical, but no
  full admin-plane deploy has run with it — that is queued behind L-DEPLOY. Until
  then the bicep half is **merged, not deployed**.
* **Gov.** Untested. Commercial only.

---

## 7. Gotcha: Git Bash mangles ARM ids

Running the deploy script from a Windows workstation fails at job create with:

```
ERROR: --registry-identity must be an identity resource ID or 'system' or 'system-environment'
```

Git Bash rewrites the leading `/` of `/subscriptions/…` into a Windows path.
Prefix `MSYS_NO_PATHCONV=1`. CI runs on `ubuntu-latest` and is unaffected — this
is a workstation-only trap, not a script defect.

---

## 8. Teardown — measured disposition, 2026-09-17 (OP-19, #4495)

§5 deferred removal so it would pair with proof. This is that proof, plus the
per-app reference audit removal actually needs. **Nothing here deletes an estate
resource** — the deletions are operator actions, listed with their commands.

### 8.1 Re-measurement (supersedes the 13-day figure in §1)

| app | SUM | errorCode | datapoints | with_value | absent |
|---|---|---|---|---|---|
| `func-cpeval-k6mvh5sm6z7do` | **0** | Success | 31 | 31 | 0 |
| `func-secexp-k6mvh5sm6z7do` | **0** | Success | 31 | 31 | 0 |
| `func-rptsub-k6mvh5sm6z7do` | **0** | Success | 31 | 31 | 0 |
| `func-loom-posture-refresh-k6mvh5sm6z7do` | **0** | Success | 31 | 31 | 0 |
| `func-lblprop-k6mvh5sm6z7do` | **0** | Success | 31 | 31 | 0 |
| `func-csa-loom-mcp` | **0** | Success | 31 | 31 | 0 |
| `func-loom-prpt-renderer-k6mvh5sm6z7do` | **0** | Success | 31 | 31 | 0 |
| **CONTROL** `func-csa-inabox-copilot-fg` (sub DLZ) | **73** | Success | 31 | 31 | 0 |

`FunctionExecutionCount`, `--aggregation Total --interval P1D`,
`--start-time 2026-08-17T00:00:00Z --end-time 2026-09-17T12:00:00Z`, subscription
`e093f4fd…c665f3` (DMLZ — **not** the default subscription), RG
`rg-csa-loom-admin-centralus`. Run through `scripts/measure/measure.mjs`, so a
failed `az` throws instead of yielding a value and `null` is `UNKNOWN`, never 0.

**What would falsify it:** any `SUM > 0`; any row where `with_value < datapoints`
(missing telemetry read as a zero); or a control that is not `> 0`.

**The control is metric-specific, not merely query-path.** It is the same metric,
aggregation, interval, window and code path on a different Function App, and it
returns 73. A broken, mis-shaped, mis-parsed or unauthorised
`FunctionExecutionCount` query could not produce that. The first control tried —
`MemoryWorkingSet` on the subject apps themselves — returned a *genuine* 0 (these
hosts are entirely idle) and was therefore useless; `measureWithControl` refused
to report the subject at all rather than print seven zeros behind it. That
refusal is the library working.

**Two window traps, both measured here rather than reasoned about:**

* `--start-time` **without** `--end-time` returns exactly **one** datapoint
  (`dp=1`, `first == last == start-time`). A 31-day claim built on it is a
  one-day claim wearing a 31-day label. Always pass `--end-time`.
* P1D data is retained ~31 days. A query for `2026-08-06 → 2026-09-17` silently
  answers from `2026-08-17`. The §1 window (2026-07-25 → 08-06) is **no longer
  re-queryable**; this is an independent later window, not a re-run of it.

### 8.2 The §1 double-execution hazard is RETIRED — and was retired out of band

§1 and §5 warn that `func-secexp`/`func-cpeval` hold **enabled** timers on
schedules identical to their ACA twins. **That is stale at head.** Measured
2026-09-17, on two independent reads:

```
func-secexp/secretExpiryMonitor    AzureWebJobs.secretExpiryMonitor.Disabled=true    isDisabled=true
func-cpeval/copilotEvaluatorTimer  AzureWebJobs.copilotEvaluatorTimer.Disabled=true  isDisabled=true
func-cpeval/copilotEvaluatorHttp   AzureWebJobs.copilotEvaluatorHttp.Disabled=true   isDisabled=true
```

The app setting is what an operator writes; `isDisabled` is what the Functions
host computed from it. They agree.

**Nothing in this repo did that, and nothing records it** — no bicep sets those
settings (`copilot-evaluator-function.bicep` and
`secret-expiry-monitor-function.bicep` were deleted in #2556), no script, no
workflow, no issue, no PR. So a re-enable would be silent.

**What notices it** is the `op19-retired-timers` job in
`.github/workflows/loom-drift-check.yml` — weekly, on the same schedule as live
bicep-drift detection, because an out-of-band app-setting change is exactly the
unmanaged portal change that lane exists to catch and is exactly what
`az deployment sub what-if` cannot see (the settings are not in `main.bicep`).
The job runs `scripts/csa-loom/check-retired-function-timers.sh` read-only and
goes red on **both** non-zero codes, so "I could not measure" is a failure and
not a quiet pass. **That job has not yet produced a run** as of the commit that
added it — supported-in-code, never exercised (`cloud-parity.md`); its first
scheduled run is what establishes whether the Commercial deploy SP can read the
DMLZ admin RG the script targets. An earlier revision of this page called the
script itself "the standing check" while nothing invoked it; that was
`deploy-integrity.md` R3 and is corrected here rather than quietly dropped.

The script is that job's instrument, and the on-demand verifier for an
operator: read-only by default, fail-closed, `--apply` re-disables. It
separates three
states rather than collapsing them (`deploy-integrity.md` R7) — a host absent
from a *successful* listing is `GONE` and the hazard is retired by teardown
(rc 0); a host that exists but cannot be read is `UNKNOWN` (verdict refused); a
readable-but-not-disabled definition is `ENABLED` (rc 1). A failed listing is
never reported as absence.

**An `--apply` verdict is re-measured, not scored on the first read.** Writing
the app setting restarts the Functions host, and `isDisabled` is what the host
recomputed — so the write's own run could otherwise report its own fix as a
`DOUBLE-EXECUTION HAZARD`. When (and only when) the write succeeded and the
setting now reads `true` while `isDisabled` does not, the host read is repeated
up to three times with backoff. It fails closed: a host that never agrees is
still `ENABLED` (rc 1), carrying a note that the restart-lag explanation was
tested and rejected.

**A re-read that FAILS is `UNKNOWN` (rc 2), not `ENABLED`** — the same
classification the identical failure gets before the loop, because it is the
same failure. An earlier revision of this arm broke out of the loop on a failed
`az functionapp function show`, fell into the same branch as a genuine
disagreement, and emitted the restart-lag note — which asserted an elapsed time
that had not passed, that the host had answered "without agreeing" when it had
not answered at all, and that the state was "NOT a host-restart lag" when a
restarting host is precisely what makes that read fail. It then told the
operator to re-run `--apply`. Both independent reviews of PR #4564 on
2026-09-21 found it; it is `deploy-integrity.md` R7 and it is fixed rather than
quietly dropped. The elapsed seconds and the re-read count in both messages are
now accumulated as they happen rather than derived from the loop bounds, so a
change to those bounds cannot falsify the sentence. Note that the weekly CI
lane cannot reach this arm at all: it runs read-only, and the arm requires a
successful `--apply` write.

Pinned by `scripts/ci/__tests__/retired-function-timers-apply-lag.test.mjs`,
which drives the five apply-lag polarities — converges, stuck, verify-only,
read-fails, and a mixed run carrying one unreadable target beside two stuck
ones — against a shim `az`, and never touches the estate.

**The exit code is a per-RUN verdict, not a per-target label, and `ENABLED`
outranks `UNKNOWN`.** A run carrying one `ENABLED` and one `UNKNOWN` exits **1**,
not 2 — a confirmed live hazard is strictly more actionable than an unmeasured
one, and reporting 2 would send the operator to debug `az` instead of
re-disabling a live timer. rc 2 means *nothing was ENABLED and the requested
outcome could not be certified*: at least one `UNKNOWN` target, or a `--apply`
write that was denied, or a boundary that could not be read at all. The script
header states the same precedence, as does `DECISIONS.md:49`.

That matters because §8.3 deletes both
hosts: without the `GONE` arm the check would fail permanently on its own
remediation.

The ACA twins are executing — `loom-secret-expiry-monitor` Succeeded at 06:00 UTC
on 2026-09-14/15/16/17; `loom-report-subscriptions` Succeeded on its `*/15`.

### 8.3 Per-app reference audit and disposition

"Declaration" = a non-`existing` `Microsoft.Web/sites` that a deploy would
create. Three of the seven have none: their modules are already deleted, so no
from-scratch deploy re-creates them and removal is purely an estate action.

| app | declaration | live references | disposition |
|---|---|---|---|
| `func-cpeval-*` | **none** (deleted #2556) | `full-app-deploy-commercial.yml` post-deploy-evals — **fixed in this change** | estate delete, unblocked |
| `func-secexp-*` | **none** (deleted #2556) | none executable (`docs/fiab/runbooks/secret-rotation.md:539` is a runbook line) | estate delete |
| `func-rptsub-*` | **none** (deleted #3068) | `scripts/csa-loom/grant-navigator-rbac.sh:240` — discovers it and grants Cosmos + Blob + Logic App Contributor to its identity. **No-ops cleanly when absent** (`else … skipping`), so deletion does not break the bootstrap | estate delete; the grant block then becomes dead and should go with it |
| `func-loom-posture-refresh-*` | `azure-functions/posture-refresh/deploy/main.bicep` | `csa-loom-post-deploy-bootstrap.yml:2248`, `gov-provision-posture.yml:92` — both **deploy targets** | **KEEP.** §4.1: still the *intended* runtime for a live console surface, with no ACA replacement built. Deleting it removes a capability |
| `func-lblprop-*` | `label-propagation-function.bicep`, wired at `admin-plane/main.bicep:8572` (`labelPropagationEnabled`, default true) | `grant-navigator-rbac.sh:217` (no-ops when absent) | **KEEP.** §4.4: intended runtime, no replacement |
| `func-csa-loom-mcp` | `builtin-mcp.bicep`, wired at `admin-plane/main.bicep:3234` (`loomBuiltinMcpActive`, default ON) | Console `LOOM_BUILTIN_MCP_URL` (BFF route, env-check, health probe) + the generated `deploy-templates/main.json` | superseded by Container App `loom-mcp`, but removal is a **multi-file Console change** — tracked separately, see 8.4 |
| `func-loom-prpt-renderer-*` | `azure-functions/paginated-report-renderer/deploy/main.bicep` | Console `LOOM_PAGINATED_RENDER_URL` / `LOOM_PAGINATED_RENDER_KEY` | superseded by Container App `loom-prpt-r3` / `integration/prpt-renderer.bicep` — same shape, see 8.4 |

Operator commands for the three unblocked deletes (run in the DMLZ
subscription; each is idempotent and removes only the app, not its RG). Use the
DMLZ subscription id — `check-retired-function-timers.sh` carries it as the
default for `LOOM_ADMIN_SUBSCRIPTION`, and the published docs site may not
(`scripts/ci/check-docs-hygiene.mjs`):

```bash
SUB=<subscription-id>; RG=rg-csa-loom-admin-centralus
az functionapp delete --subscription "$SUB" -g "$RG" -n func-cpeval-k6mvh5sm6z7do
az functionapp delete --subscription "$SUB" -g "$RG" -n func-secexp-k6mvh5sm6z7do
az functionapp delete --subscription "$SUB" -g "$RG" -n func-rptsub-k6mvh5sm6z7do
```

Their Y1 plans, host storage accounts and Application Insights components are
separate resources and are **not** removed by that command — check
`az resource list -g "$RG" --query "[?contains(name,'secexp')||contains(name,'cpeval')||contains(name,'rptsub')]"`
before declaring the billing gone.

### 8.4 Not done here, and why

* **`func-csa-loom-mcp` / `func-loom-prpt-renderer-*` bicep removal.** Both are
  genuinely superseded by live Container Apps, but each producer is load-bearing
  for a Console env var, a health probe and an admin env-check, and
  `builtin-mcp.bicep` additionally sits behind 19 sites in
  `admin-plane/main.bicep` plus a Key Vault secret and the generated
  `deploy-templates/main.json`. That is a Console + orchestrator change, not a
  Function-App teardown, and it needs its own consumer audit. Deleting the
  producer without it would break a from-scratch deploy
  (`deploy-integrity.md` R4).
* **Drift worth its own item:**
  `apps/fiab-console/lib/admin/env-checks/ai-copilot.ts:79` already records
  `provisionedBy: 'modules/admin-plane (built-in MCP **Container App**)'` while
  `builtin-mcp.bicep` still deploys a **Function App**. The Console and the bicep
  disagree about what provisions the built-in MCP server today.
* **`loom-copilot-evaluator` job failures.** Two executions Failed on 2026-09-17
  (18:22Z, 19:15Z) after one Succeeded at 17:19Z. Per
  `copilot-evaluator-job.bicep`, a Failed execution is by contract "always a real
  regression worth paging on". Unrelated to the teardown; not diagnosed here.
