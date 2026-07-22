# copilot-evaluator — Copilot quality eval Function (loom-next-level E2)

Timer + HTTP Azure Function (Node v4 model, Linux Y1 Consumption) that executes
the **E1 golden Q/A eval sets** (`content/evals/<surface>.jsonl`) against the
**REAL** Copilot path and writes scored results to Cosmos
**`loom-copilot-evals`** (PK `/surface`).

## How a run works

1. **Probe** — for each question the Function POSTs the console's internal
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
   `LOOM_COPILOT_EVAL_JUDGE_DAILY_CAP` (default **500 judged Q/day**, enforced
   cross-replica by a Cosmos daily ledger); over cap → runs score
   retrieval-only and judge scores are marked **`deferred`** (E3 treats
   deferred as no-change, never a regression).
4. **Write** — per-question `eval-result` docs (`ttl` 180 d) + a per-surface
   `eval-run` rollup (`{questions, retrievalHitRate, mrrAvg, groundingAvg,
   answerAvg, passRate, judged, deferred, autoFailed}`) per the E2 data model.
   `pass = retrievalHit && mentionPass && !forbiddenHit && grounding ≥ 4`.

## Triggers

- **Timer** — `COPILOT_EVALUATOR_CRON`, default `0 0 7 * * *` (nightly 07:00
  UTC, off-peak — see the capacity note).
- **HTTP** — `POST /api/copilotEvaluatorHttp` body
  `{ "surfaces": ["help"], "trigger": "manual" }` (`authLevel: function` — the
  caller presents the function key). Fired by the corpus-staging workflow (E4)
  and the admin "Run now" button (E5).

## Env contract

| Var | Meaning |
| --- | --- |
| `LOOM_COSMOS_ENDPOINT` / `LOOM_COSMOS_DATABASE` | The Loom Cosmos store (`loom-copilot-evals` is created on first write). |
| `LOOM_EVAL_PROBE_URL` | Console base URL carrying the internal eval-probe route. |
| `LOOM_INTERNAL_TOKEN` | Shared internal trust token (bicep-derived guid; literal app setting — the private KV is unreachable from a Consumption plan). |
| `LOOM_AOAI_ENDPOINT` | AOAI endpoint for the judge (Gov `.azure.us` scope handled automatically). Empty → judge `deferred`. |
| `LOOM_COPILOT_EVAL_JUDGE_DEPLOYMENT` | Optional dedicated judge deployment (isolates judge TPM). |
| `LOOM_AOAI_STRONG/MINI/_DEPLOYMENT` | Judge fallback chain (bicep-wired per cloud). |
| `LOOM_COPILOT_EVAL_JUDGE_DAILY_CAP` | Default 500 judged Q/day. |
| `LOOM_COPILOT_EVAL_ENABLED` | Default **true** (opt-out per `loom_default_on_opt_out`). |
| `COPILOT_EVALUATOR_CRON` | Nightly schedule (NCRONTAB, 6-field). |

Missing config → an honest early-exit log naming the exact vars (no-vaporware).

## Eval-set staging

`resolveEvalRoot()` looks for sets at `./evals` (the deployed package —
`scripts/stage-evals.mjs` copies `content/evals/*.jsonl` there; wired as
`prestart` and run before `func azure functionapp publish`), then
`./copilot-corpus/evals` (console-image layout), then `<repo>/content/evals`
(checkout). IL5/air-gapped: the sets ship in the package — no external fetch.

## Build / test / deploy

```bash
cd azure-functions/copilot-evaluator
npm ci
npm run build          # tsc — rootDir is the repo root (shared pure imports from the console)
npm test               # vitest — pure core (28 tests)
node scripts/stage-evals.mjs
func azure functionapp publish <func-cpeval-...>
```

Infra: `platform/fiab/bicep/modules/admin-plane/copilot-evaluator-function.bicep`
(wired in `admin-plane/main.bicep` via the R0 `functionAppsConfig` bag —
`copilotEvaluatorEnabled`, default **true**). Identity-based
`AzureWebJobsStorage` (no storage key) + all four role grants in-module
(`skipRoleGrants`-aware).

## Capacity note (one page — SRE F10 / round-3 F1)

**Judge TPM.** A full nightly run over the 10 E1 surfaces is ~146 questions;
each judged question costs one strong-tier chat completion of roughly
1.5–2.5 K prompt tokens (question + excerpts + gold + candidate) and
≤ 400 completion tokens (`max_completion_tokens: 400`) → **~0.3–0.45 M tokens
per full judged run**, well inside a single minute-level TPM window when spread
over the run's sequential HTTP round-trips. E4 additionally fires a run per
corpus-changing roll. The **daily cap (default 500 judged Q)** bounds worst-case
spend to ~1.2 M judge tokens/day regardless of roll frequency; deterministic
guards short-circuit forbidden-phrase answers at zero judge cost.

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

**Function scale.** Y1 Consumption, single timer instance (timer triggers do
not fan out); the HTTP trigger is admin/CI-rate (≤ a few runs/day). ~$0 idle.

Cost note: **`Cost: +token spend (judge — capped/day, per-roll + nightly)`**
(counted in COST0's program budget).

## Rollback

1. **Code** — keep the last-known-good package: every publish from the
   bootstrap workflow logs the release; roll back with
   ```bash
   cd azure-functions/copilot-evaluator
   git checkout <last-good-sha> -- .
   npm ci && npm run build && node scripts/stage-evals.mjs
   func azure functionapp publish <func-cpeval-...>
   ```
   (equivalently `az functionapp deployment source config-zip -g <rg> -n <app>
   --src <last-good>.zip` when a zip artifact is retained).
2. **Disable fast** — `az functionapp config appsettings set -g <rg> -n <app>
   --settings LOOM_COPILOT_EVAL_ENABLED=false` (honest no-op ticks; zero
   spend) — the seconds-level kill switch.
3. **Infra** — re-deploy `admin-plane/main.bicep` with
   `functionAppsConfig: { copilotEvaluatorEnabled: false }` to remove the app
   from the topology, or follow the existing `bicep-rollback` DR scenario
   (docs/fiab/runbooks) to restore the prior template state. Cosmos data is
   additive-only (eval docs), so rollback never needs a data restore.

## Security

See the STRIDE row in `docs/fiab/runbooks/copilot-evaluator.md` (identity
posture, no storage keys, role scopes, HTTP-trigger exposure).
