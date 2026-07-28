# Azure Functions → Container App Jobs (B-FN)

**Status: partially executed (2026-07-27).** This note records the operator
decision, the migration pattern, what has moved, and what is still queued.

Related rules: [`no-vaporware`](../../.claude/rules/no-vaporware.md),
[`no-fabric-dependency`](../../.claude/rules/no-fabric-dependency.md).
Parent program: `PRPs/active/loom-apex/PRP.md` (Phase B, row **B-FN**).

---

## 1. Why — Y1 Consumption Functions are structurally broken on this estate

The decision (operator, 2026-07-23) is not a preference; it is a constraint:

1. **Azure Policy seals every storage account** in this estate
   (`publicNetworkAccess=Disabled`, shared-key access discouraged, AAD-only, no
   private endpoint carved for Function host storage).
2. **The Linux Y1 (Dynamic) Functions runtime is multitenant and is NOT a
   trusted Azure service** for that sealed data-plane, so it cannot reliably
   reach `AzureWebJobsStorage`.
3. Without host storage the Functions host cannot mint or read **host keys**
   and cannot take **timer leases** — so both trigger types the Loom fleet used
   (timer + `authLevel: 'function'` HTTP) fail in ways that look like
   configuration problems but are not fixable by configuration.

Symptoms this produced live: `func-rptsub-*` dying at host start; the
`svc-copilot-evaluator` and `svc-secret-expiry` gates reading **blocked** on a
fully deployed estate because the Functions they pointed at could not run.

The workaround the platform already proved — `loom-uat`, `gh-aca-runner`,
`loom-synthetic-monitor`, `loom-cost-anomaly-monitor`, `loom-asset-reconciler`,
`loom-lineage-extractor` — is the **in-VNet Container App Job**
(`Microsoft.App/jobs`) in the console's VNet-integrated Container Apps
Environment, running as the **console UAMI**. That is now the estate standard
for all scheduled/background compute.

## 2. The two migration shapes

Both are already in the tree; pick per workload.

### Shape A — thin runner, console does the work

The job image is the existing `loom-uat` image and the entrypoint is a ~70-line
`node e2e/run-<x>.mjs` that POSTs the console's `/api/internal/<x>/run` with the
shared internal token. All real work happens in the console process, where the
Cosmos/ARM/AOAI clients already live.

*Use when* the logic is naturally console logic and would otherwise be
duplicated. *Examples:* `cost-anomaly-monitor-job.bicep`,
`asset-reconciler-job.bicep`.

### Shape B — own image, own entrypoint

The workload keeps its own package and gets a `Dockerfile` + `src/main.ts`
one-shot entrypoint; the Functions host, `host.json`, `local.settings.json` and
the `@azure/functions` dependency are deleted. Managed-identity auth only.

*Use when* the workload is substantial, already self-contained, or has its own
dependency graph. *Examples:* `lineage-extractor-job.bicep` (the precedent),
and both migrations below.

**Common to both:** Schedule trigger with a **standard 5-field cron in UTC**
(Container Apps jobs do NOT use the Functions 6-field NCRONTAB — this is a
breaking config change for anyone who set the old form), console UAMI for ACR
pull + data-plane auth, KV-backed secrets as Container Apps `secretRef`s, no
public ingress, and role grants declared in the job module (`skipRoleGrants`
aware).

## 3. What moved in this change

### 3.1 `secret-expiry-monitor` → `loom-secret-expiry-monitor` (Shape B)

| Before | After |
| --- | --- |
| `secret-expiry-monitor-function.bicep` (Y1 site + plan + own storage account) | `secret-expiry-monitor-job.bicep` (`Microsoft.App/jobs`, Schedule trigger) |
| System-assigned Function identity | **Console UAMI** |
| Storage Blob Data Owner + Queue Data Contributor on its own SA | *(none — the host storage account is gone)* |
| Key Vault Secrets User + Monitoring Contributor on the Function identity | Same two roles, granted to the console UAMI in the job module |
| Graph `Application.Read.All` consent on a **separate** Function identity (a standalone operator action) | The **same consent the Identity Picker already needs** — `scripts/csa-loom/grant-identity-graph-approles.sh`. Estates that ran it have **zero** new operator actions |
| Dedup state blob on the Function's storage account | `ops-state/secret-expiry-state.json` on the Loom lake account (`LOOM_OPS_STATE_ACCOUNT` / `LOOM_OPS_STATE_CONTAINER`); the `ops-state` container is created by `landing-zone/storage.bicep` |
| `SECRET_EXPIRY_CRON = 0 0 6 * * *` (6-field) | `secretExpiryCron = 0 6 * * *` (5-field) |
| Optional GitHub PAT set out-of-band via app settings | Optional `githubTokenSecretUri` → a KV-backed Container Apps secret |

Code: `src/functions/secretExpiryMonitor.ts` → `src/run-monitor.ts` (one pass,
body unchanged) + `src/main.ts` (entrypoint) + `src/run-logger.ts` (the
`log/warn/error` subset `InvocationContext` provided). `expiry-core.ts` and its
185-line unit test are untouched.

### 3.2 `copilot-evaluator` → `loom-copilot-evaluator` (Shape B)

| Before | After |
| --- | --- |
| `copilot-evaluator-function.bicep` (Y1 site + plan + own storage account) | `copilot-evaluator-job.bicep` (`Microsoft.App/jobs`, Schedule trigger) |
| Timer trigger + `authLevel:'function'` HTTP trigger | Schedule trigger + **ARM job start with an execution-template override** |
| `LOOM_COPILOT_EVALUATOR_URL` (+ optional `LOOM_COPILOT_EVALUATOR_KEY` host key) | **`LOOM_COPILOT_EVALUATOR_JOB_ID`** (the job's ARM resource id) |
| Four role grants on the Function MI (Search / AOAI / Cosmos / Blob Owner) | **One** grant: Contributor scoped to the job resource, which is what ARM requires to start an execution. The console UAMI already holds Search Index Data Reader, Cognitive Services OpenAI User and Cosmos Built-in Data Contributor |
| Eval probe looped out through **Front Door** (a Consumption plan has no VNet integration into the CAE) | Probe stays **in-VNet** (`http://loom-console`) |
| One HTTP POST **per surface** (the ~230 s load-balancer response ceiling and Y1's 10-min execution cap made a single call impossible) | **One execution covers every surface** (`replicaTimeout` 45 min) |
| CI read scores from the HTTP response body | CI lifts a `::eval-run::{json}` receipt — the *same* `{ok, trigger, surfaces[]}` shape — out of the execution's console logs |

Code: `src/functions/copilotEvaluatorTimer.ts` + `copilotEvaluatorHttp.ts` →
`src/main.ts` (one-shot entrypoint reading `COPILOT_EVAL_MODE` /
`COPILOT_EVAL_TRIGGER` / `COPILOT_EVAL_SURFACES` / `COPILOT_EVAL_DOMAINS`).
`run-evals.ts` changed by exactly one import (`InvocationContext` →
`RunLogger`); `evaluator-core.ts` and its 421-line unit test are untouched.

> **Override contract.** Per Microsoft Learn, starting a job with an override
> **replaces the entire execution template**. `lib/azure/copilot-evaluator-client.ts`
> therefore GETs the job first and merges the four run knobs onto its real
> container spec — a hand-built spec would silently drop the image, the Cosmos /
> AOAI env, and the internal-token `secretRef`. `mergeRunEnv` is pure and
> unit-tested (`lib/azure/__tests__/copilot-evaluator-client.test.ts`).

### 3.3 Gate wiring (the point of the exercise)

| Gate | Was blocked because | Resolves when |
| --- | --- | --- |
| `svc-secret-expiry` | the Y1 Function could not run, so nothing fired the shared action group | `LOOM_ALERT_ACTION_GROUP_ID` is bicep-derived (unchanged) **and** the `loom-secret-expiry-monitor` job runs; gate registry + env-check now describe the job + the console-UAMI Graph consent |
| `svc-copilot-evaluator` | `LOOM_COPILOT_EVALUATOR_URL` pointed at a Function that was never deployable here | `LOOM_COPILOT_EVALUATOR_JOB_ID` is wired from `resourceId('Microsoft.App/jobs','loom-copilot-evaluator')` in `admin-plane/main.bicep` |

`LOOM_COPILOT_EVALUATOR_JOB_ID` **replaces** `LOOM_COPILOT_EVALUATOR_URL` in
`ENV_CHECKS` — one key out, one key in, so the `EDITABLE_ENV` pin stays at
**186**.

> **Why `resourceId()` and not the module output?** The job module consumes
> `containerPlatformModule.outputs.caeId`, and the console app's `apps[]` env
> lives inside that same module — reading the job's output there would make the
> two modules circular. The job name is fixed by the module, so the id is
> deterministic.

## 4. Fleet status — every workload under `azure-functions/`

| Workload | Trigger | Status |
| --- | --- | --- |
| `lineage-extractor` | timer | **Already migrated** (pre-existing): `lineage-extractor-job.bicep`, Shape B |
| `secret-expiry-monitor` | timer | **Migrated in this change** (Shape B) |
| `copilot-evaluator` | timer + HTTP | **Migrated in this change** (Shape B) |
| `posture-refresh` | timer (Python, `*/5`) | **Queued** — Shape B; Python image, `mypy --strict` + `ruff` apply |
| `access-governance-sweeper` | 3 timers (Python) | **Queued** — Shape B; three crons → either three jobs or one entrypoint with a mode switch |
| `ops-agent-evaluator` | timer | **Queued** — Shape B; mirrors the copilot-evaluator shape closely |
| `report-subscriptions` | timer | **Queued** — Shape B; note it also drives the delivery Logic App, whose grants move to the console UAMI |
| `copilot-chat` | HTTP | **Not a job.** An HTTP surface needs a Container *App* (internal ingress), not a job — the `bridge-services` script-runner template. Separate item |
| `mcp-server` | HTTP | **Not a job** — same reasoning; the deployable MCP catalog already runs on ACA |
| `paginated-report-renderer` | HTTP | **Not a job** — same reasoning |
| `scc-labels` | HTTP (2 routes) | **Not a job** — same reasoning |

**Scope note (honest):** this change migrated the **two gate-blocking timer
workloads** end to end (code, bicep, env, gates, CI, docs, deploy scripts). The
remaining four timer workloads follow the identical recipe and are listed above
rather than half-done — per `no-vaporware`, a partially ported fleet is worse
than an explicitly queued one. The four HTTP workloads are a *different*
migration (ACA app with internal ingress, not a job) and are deliberately out of
this item's scope.

## 5. Migration recipe (for the queued four)

1. Add `src/main.ts`: a one-shot entrypoint that calls the existing handler body
   and `process.exit(0)` on a completed pass — **including an honest config
   gate** — and `exit(1)` only on an unexpected throw, so a `Failed` execution
   always means a real regression.
2. Replace `InvocationContext` with a local 3-method logger interface.
3. Add a `Dockerfile` (multi-stage, non-root `node`/`python` user). If the
   package imports shared console modules, the **build context is the repo
   root** and the Dockerfile copies exactly those files.
4. Delete `host.json`, `local.settings.json.sample`, `src/functions/**` and the
   `@azure/functions` dependency; regenerate the lockfile with
   `npm install --package-lock-only` (never a full install in a worktree).
5. Add `modules/admin-plane/<name>-job.bicep` mirroring
   `secret-expiry-monitor-job.bicep`: Schedule trigger, console UAMI, ACR
   registry by identity, KV `secretRef`s, role grants `skipRoleGrants`-aware.
6. Rewire `admin-plane/main.bicep`: swap the module, convert the cron from
   6-field NCRONTAB to 5-field, gate on
   `<x>Enabled && containerPlatform == 'containerApps' && deployAppsEnabled`,
   and fix the outputs.
7. Add `scripts/csa-loom/deploy-<name>-job.sh` (ACR open → `az acr build` →
   ACR re-lock → job create/update).
8. Update the env-check + gate-registry entries so the honest gate names the
   **job**, not a Function, and the Fix-it points at the job module.

## 6. Operator actions

* **Build the two images** before the first scheduled execution — the job is
  created by bicep but its first run fails honestly until the image exists:
  * `scripts/csa-loom/deploy-secret-expiry-job.sh`
  * `scripts/csa-loom/deploy-copilot-evaluator-job.sh`
* **Graph consent** (once per estate, if not already done for the Identity
  Picker): `scripts/csa-loom/grant-identity-graph-approles.sh` — grants the
  console UAMI `Application.Read.All`, which the secret-expiry inventory needs.
* **Delete the retired Function apps** (`func-secexp-*`, `func-cpeval-*`) and
  their storage accounts/plans after the jobs are verified green. Bicep no
  longer manages them, so they will linger as orphans otherwise.
* **Anyone who pinned `functionAppsConfig.secretExpiryCron` /
  `copilotEvaluatorCron`** must convert the value from 6-field NCRONTAB to
  5-field cron. No `params/*.bicepparam` in this repo sets either, so the
  default path is unaffected.

## 7. Verification

Per `ux-baseline.md` G1 and `no-vaporware.md`, the receipt for this item is:

1. `az containerapp job start -n loom-secret-expiry-monitor …` → an execution
   that reaches `Succeeded` with a `[secret-expiry] pass complete … worst=<band>`
   line in `ContainerAppConsoleLogs_CL`.
2. `az containerapp job start -n loom-copilot-evaluator …` → an execution that
   reaches `Succeeded` and emits `::eval-run::{...}` with real per-surface
   scores, plus new `eval-run` docs in Cosmos `loom-copilot-evals`.
3. `/admin/copilot-quality` → **Run now** starts a real execution (audit row
   `outcome:'started'`), and the page's honest gate is gone.
4. `/admin/gates` shows `svc-copilot-evaluator` and `svc-secret-expiry`
   resolved.

Those four are **operator-run** (they need the live estate); this change ships
the code, infra, env wiring, CI and scripts that make them possible.
