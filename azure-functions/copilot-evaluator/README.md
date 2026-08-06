# copilot-evaluator — Copilot quality eval job (loom-next-level E2)

> **B-FN migration (2026-07-27): this is an in-VNet scheduled Container App
> Job — `loom-copilot-evaluator` — NOT an Azure Function.** Y1 Linux
> Consumption Functions are structurally broken on this estate (Azure Policy
> seals the storage data-plane: `publicNetworkAccess=Disabled`, AAD-only, no
> private endpoint, and the multitenant Y1 runtime is not a trusted service, so
> host keys / timer leases fail). The folder keeps its historical
> `azure-functions/` path; the runtime is a one-shot Node entrypoint
> (`src/main.ts`) in a container. Full rationale + fleet status:
> [`docs/fiab/functions-to-aca-jobs.md`](../../docs/fiab/functions-to-aca-jobs.md).

A scheduled + on-demand job that executes the **E1 golden Q/A eval sets** (`content/evals/<surface>.jsonl`) against the
**REAL** Copilot path and writes scored results to Cosmos
**`loom-copilot-evals`** (PK `/surface`).

## How a run works

1. **Probe** — for each question the job POSTs the console's internal
   `POST /api/internal/copilot/eval-probe` route (auth: the shared VNet-internal
   trust token `LOOM_INTERNAL_TOKEN`, fail-closed). The console runs the exact
   `searchDocs()` hybrid retrieval (AI Search → Cosmos fallback, telemetry
   recorded as production) **and one real Copilot turn** through the unified
   `aoai-chat-client` (tier routing included) and returns
   `{retrievedChunks, answer, tier, taskClass, backend, latencyMs}` — wiring (a)
   of the E2 spec: byte-identical retrieval + tier routing, never a
   reimplementation.
2. **Deterministic scoring** — `scoreRetrieval` (hit-rate + MRR over
   `expectedChunks`) and the `mustMention`/`mustNotMention` guards run first.
   **A forbidden phrase is an auto-fail with ZERO judge spend.**
3. **LLM judge (capped)** — grounding-fidelity rubric
   (grounding/relevance/completeness, each 1–5, strict JSON) at the top
   resolvable tier: `LOOM_COPILOT_EVAL_JUDGE_DEPLOYMENT` →
   `LOOM_AOAI_STRONG_DEPLOYMENT` → `LOOM_AOAI_MINI_DEPLOYMENT` →
   `LOOM_AOAI_DEPLOYMENT`. **No model name is hardcoded anywhere** — deployment
   names are bicep-bound per cloud from the Learn-grounded availability matrix
   (`bestReasoningModelFor`), which this package imports from the console as a
   shared pure module. The judge spend is capped by
   `LOOM_COPILOT_EVAL_JUDGE_DAILY_CAP` (default **5000 judged Q/day**, enforced
   cross-replica by a Cosmos daily ledger); over cap → runs score
   retrieval-only and judge scores are marked **`deferred`** (E3 treats
   deferred as no-change, never a regression).
4. **Write** — per-question `eval-result` docs (`ttl` 180 d) + a per-surface
   `eval-run` rollup (`{questions, retrievalHitRate, mrrAvg, groundingAvg,
   answerAvg, passRate, judged, deferred, autoFailed}`) per the E2 data model.
   `pass = retrievalHit && mentionPass && !forbiddenHit && grounding ≥ 4`.

## Triggers

- **Schedule** — `COPILOT_EVALUATOR_CRON`, default `0 7 * * *` (standard
  5-field cron; nightly 07:00 UTC, off-peak — see the capacity note). Runs
  every mode (`COPILOT_EVAL_MODE=all`).
- **On demand** — an ARM job start with an execution-template override. The
  corpus-staging workflow (E4) and the admin "Run now" button (E5) both take
  this path; the four run knobs the entrypoint reads are
  `COPILOT_EVAL_MODE` (`all|copilot|search|tier`), `COPILOT_EVAL_TRIGGER`
  (`nightly|manual|corpus`), `COPILOT_EVAL_SURFACES` and `COPILOT_EVAL_DOMAINS`
  (comma-separated; empty = all). The Console starts it through
  `lib/azure/copilot-evaluator-client.ts`, which reads the job's current
  template and merges the knobs on top — an override REPLACES the template, so
  a hand-built container spec would silently drop the image and secrets.
  **There is no HTTP trigger and no function key any more.**

A copilot-mode execution ends with a machine-readable
`::eval-run::{ok,trigger,surfaces:[...]}` line — the same body the retired HTTP
trigger returned — which the CI gate lifts out of the execution logs.

## Env contract

| Var | Meaning |
| --- | --- |
| `LOOM_COSMOS_ENDPOINT` / `LOOM_COSMOS_DATABASE` | The Loom Cosmos store (`loom-copilot-evals` is created on first write). |
| `LOOM_EVAL_PROBE_URL` | Console base URL carrying the internal eval-probe route. |
| `LOOM_INTERNAL_TOKEN` | Shared internal trust token (bicep-derived guid; literal app setting — the private KV is unreachable from a Consumption plan). |
| `LOOM_AOAI_ENDPOINT` | AOAI endpoint for the judge (Gov `.azure.us` scope handled automatically). Empty → judge `deferred`. |
| `LOOM_COPILOT_EVAL_JUDGE_DEPLOYMENT` | Optional dedicated judge deployment (isolates judge TPM). |
| `LOOM_AOAI_STRONG/MINI/_DEPLOYMENT` | Judge fallback chain (bicep-wired per cloud). |
| `LOOM_COPILOT_EVAL_JUDGE_DAILY_CAP` | Default 5000 judged Q/day (raised from 500 on 2026-08-06 — the CI merge volume runs up to ~31 full passes/day; 500 zero-judged every gated run after ~05:50 UTC). The in-code fallback when the env var is unset stays 500 (conservative fail-safe; bicep always wires the value). |
| `LOOM_COPILOT_EVAL_ENABLED` | Default **true** (opt-out per `loom_default_on_opt_out`). |
| `COPILOT_EVALUATOR_CRON` | Nightly schedule (standard 5-field cron, UTC). |
| `COPILOT_EVAL_MODE` / `COPILOT_EVAL_TRIGGER` / `COPILOT_EVAL_SURFACES` / `COPILOT_EVAL_DOMAINS` | Per-execution run knobs (see Triggers). |

Missing config → an honest early-exit log naming the exact vars (no-vaporware).

## Eval-set staging

`resolveEvalRoot()` looks for sets at `./evals` (the image —
`scripts/stage-evals.mjs` copies `content/evals/*.jsonl` there during the
Docker build), then `./copilot-corpus/evals` (console-image layout), then
`<repo>/content/evals` (checkout). IL5/air-gapped: the sets ship in the image —
no external fetch.

## Build / test / deploy

```bash
cd azure-functions/copilot-evaluator
npm ci
npm run build          # tsc — rootDir is the repo root (shared pure imports from the console)
npm test               # vitest — pure core (28 tests)
```

Build the image + create/refresh the job (build context is the REPO ROOT):

```bash
ADMIN_RG=rg-csa-loom-admin-centralus SUB=<sub> CAE=cae-csa-loom-centralus \
CONSOLE_UAMI_ID=<uami-resource-id> CONSOLE_UAMI_CLIENT_ID=<uami-client-id> \
ACR=<acr>.azurecr.io ./scripts/csa-loom/deploy-copilot-evaluator-job.sh
```

Infra: `platform/fiab/bicep/modules/admin-plane/copilot-evaluator-job.bicep`
(wired in `admin-plane/main.bicep` via the R0 `functionAppsConfig` bag —
`copilotEvaluatorEnabled`, default **true**). The job runs as the **console
UAMI**, which already holds Cognitive Services OpenAI User, Search Index Data
Reader and Cosmos Built-in Data Contributor — so the module declares exactly
one grant: Contributor scoped to the job itself, which ARM requires to start an
execution (`skipRoleGrants`-aware). No host storage account, no keys.

## Capacity note (one page — SRE F10 / round-3 F1)

**Judge TPM.** A full nightly run over the 10 E1 surfaces is ~146 questions;
each judged question costs one strong-tier chat completion of roughly
1.5–2.5 K prompt tokens (question + excerpts + gold + candidate) and
≤ 400 completion tokens (`max_completion_tokens: 400`) → **~0.3–0.45 M tokens
per full judged run**, well inside a single minute-level TPM window when spread
over the run's sequential HTTP round-trips. E4 additionally fires a run per
corpus-changing roll. The **daily cap (default 5000 judged Q)** bounds
worst-case spend to ~12 M judge tokens/day regardless of roll frequency — a
hard ceiling reached only if every one of ~31 measured worst-day passes runs
fully judged; deterministic guards short-circuit forbidden-phrase answers at
zero judge cost, and the E4 workflow stops the job execution of any cancelled
(superseded) run so orphans no longer burn the cap.

**Isolation from production Copilot.** Two mechanisms, use either or both:
(1) the **default off-peak schedule** (07:00 UTC — outside US business hours in
every deployed region) keeps the burst away from interactive traffic; (2) set
`functionAppsConfig.copilotEvalJudgeDeployment` to a **dedicated judge
deployment** (its own TPM allocation on the same account, or a separate
account) so judge spend can never throttle production turns — REQUIRED
consideration on Gov's reduced-quota catalog.

**Probe-side load.** Each question also runs one real console Copilot turn
(standard tier by default). 146 turns/night ≈ the load of one active user
session; the probe calls are sequential, so no concurrency spike hits AI
Search or AOAI.

**Cosmos RU.** Writes per full run: ~146 result upserts (~2 KB each) + 10 run
docs + ≤ 146 ledger upserts → trivially inside the serverless account's burst
capacity (shared with the I3 shadow / C3 rules / V1 summaries writers; the
container is per-doc-TTL so storage is self-bounding at 180 d).

**Job scale.** A scale-to-zero Container Apps job: `parallelism: 1`,
`replicaCompletionCount: 1`, so a scheduled execution never fans out, and
on-demand starts are admin/CI-rate (a few runs/day at most). ~$0 idle. The
45-minute `replicaTimeout` replaces Y1's hard 10-minute ceiling, which is why
ONE execution can now cover every surface instead of one HTTP POST per
surface.

Cost note: **`Cost: +token spend (judge — capped/day, per-roll + nightly)`**
(counted in COST0's program budget).

## Rollback

1. **Code** — point the job at the previous image tag:
   ```bash
   az containerapp job update -n loom-copilot-evaluator -g <admin-rg> \
     --image <acr>.azurecr.io/loom-copilot-evaluator:<last-good>
   ```
   (or re-run `scripts/csa-loom/deploy-copilot-evaluator-job.sh` from the
   last-good commit).
2. **Disable fast** — `az containerapp job update -n loom-copilot-evaluator
   -g <admin-rg> --set-env-vars LOOM_COPILOT_EVAL_ENABLED=false` (honest no-op
   executions; zero spend) — the seconds-level kill switch.
3. **Infra** — re-deploy `admin-plane/main.bicep` with
   `functionAppsConfig: { copilotEvaluatorEnabled: false }` to remove the job
   from the topology, or follow the existing `bicep-rollback` DR scenario
   (docs/fiab/runbooks) to restore the prior template state. Cosmos data is
   additive-only (eval docs), so rollback never needs a data restore.

## Security

See the STRIDE row in `docs/fiab/runbooks/copilot-evaluator.md` (identity
posture, no storage keys, role scopes, HTTP-trigger exposure).
