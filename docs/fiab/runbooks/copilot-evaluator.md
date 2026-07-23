# Runbook — copilot-evaluator Function (Copilot quality eval harness, E2)

**Scope:** the `func-cpeval-*` Azure Function
(`azure-functions/copilot-evaluator`, deployed by
`platform/fiab/bicep/modules/admin-plane/copilot-evaluator-function.bicep`) —
nightly + on-demand Copilot quality evals over the E1 golden sets
(`content/evals/*.jsonl`), scored against the REAL retrieval + AOAI path via
the console's internal `POST /api/internal/copilot/eval-probe` route and
written to Cosmos `loom-copilot-evals` (PK `/surface`).

The same Function also runs two sibling deterministic modes on the nightly tick:
**SRCH1** federated-search relevance (`mode:"search"`) and **E6** tier-router
decision evals (`mode:"tier"`). The tier mode runs the REAL `routeTurnTier`
(the exact function the aoai-chat-client hot path consults) over the golden
`content/evals/_tier-labels.jsonl` label set and scores each decision's ridden
tier against its `expectedTier` — a confusion matrix + `tierAccuracy` written as
a `tier-run` doc (PK `tier:router`). It is pure (no probe, no AOAI judge), so it
only needs Cosmos to persist; the E5 `/admin/copilot-quality` "Tier routing" tab
reads it (accuracy, confusion heatmap, per-class accuracy, cost-per-quality).

## Normal operation

- **Nightly:** `COPILOT_EVALUATOR_CRON` (default `0 0 7 * * *`, off-peak UTC) —
  runs answer, search, AND tier modes.
- **On demand:** `POST https://<func-host>/api/copilotEvaluatorHttp?code=<function-key>`
  body `{"surfaces":["help"],"trigger":"manual"}` (answer), `{"mode":"search"}`
  (SRCH1), or `{"mode":"tier"}` (E6) — fired by the E4 corpus-staging workflow
  and the E5 admin "Run now" / "Run tier evals".
- **Healthy log line:**
  `[copilot-evaluator] run help: 20 Q, hit-rate 0.9, grounding 4.3 (judged=… deferred=… auto-fail=…)`
  and `[copilot-evaluator/tier] run: 64 rows, tier-accuracy 1, task-class-accuracy 1`.
- **E6 tier floor:** `content/evals/eval-floors.json` `tierFloors.router.tierAccuracy`
  (0.85, provisional seed; ratchet-up-only) — a regression in
  `DEFAULT_TASK_TIER_MAP` / `classifyTaskClass` drops accuracy below it.
- **Honest gates:** missing config → `honest-gate: not configured — set …`
  warn + no-op tick; no judge deployment → judge scores marked `deferred`
  (retrieval scoring — deterministic — remains authoritative); over the daily
  judge cap (`LOOM_COPILOT_EVAL_JUDGE_DAILY_CAP`, default 500) → `deferred`.

## Triage

| Symptom | Cause / fix |
| --- | --- |
| `honest-gate: not configured` every tick | Set `LOOM_COSMOS_ENDPOINT`, `LOOM_EVAL_PROBE_URL`, `LOOM_INTERNAL_TOKEN` on the Function app (bicep wires them on a push-button deploy). |
| `eval-probe 401` | The Function's `LOOM_INTERNAL_TOKEN` ≠ the console's (both derive from the same bicep guid — redeploy admin-plane or copy the console's value). |
| `eval-probe 503 no_aoai` | The console has no AOAI deployment — resolve the `svc-aoai` gate first. |
| `AOAI judge 401/403` | The Function MI lacks *Cognitive Services OpenAI User* on the AOAI account (module grants it when `aoaiAccountName` was passed; BYO/cross-RG accounts need a manual grant). |
| Cosmos writes fail 403 | Same-RG hub account: module grants the data-plane role. DLZ-hosted (cross-RG) account: grant *Cosmos DB Built-in Data Contributor* to the Function `principalId` output via `grant-navigator-rbac.sh`. |
| Every judge score `deferred` | Cap reached (raise `LOOM_COPILOT_EVAL_JUDGE_DAILY_CAP`) or no judge deployment resolves (`LOOM_COPILOT_EVAL_JUDGE_DEPLOYMENT` → strong → mini → default all unset). |
| Kill switch | `LOOM_COPILOT_EVAL_ENABLED=false` on the Function app (seconds; honest no-op ticks). |

Rollback: see the **Rollback** section of
`azure-functions/copilot-evaluator/README.md` (last-known-good publish +
`az functionapp` redeploy + the `bicep-rollback` DR scenario).

## Threat model (STRIDE — round-3 Q6, partial I9 pulled forward)

Identity posture: system-assigned MI; **identity-based host storage**
(`AzureWebJobsStorage__credential=managedidentity`, `allowSharedKeyAccess=false`
— NO storage key anywhere); AAD-only Cosmos + AOAI data-plane; the ONLY shared
secret is the VNet-internal trust token (bicep-derived deterministic guid,
literal app setting because the private KV is unreachable from a Consumption
plan) plus the platform-managed HTTP function key.

| STRIDE | Threat | Mitigation |
| --- | --- | --- |
| **S**poofing | A forged caller triggers eval runs via the HTTP trigger. | `authLevel: 'function'` — platform-managed function key required; no anonymous route. Timer runs are platform-internal. Worst-case blast radius of a leaked key = extra eval runs (reads + additive writes), bounded by the daily judge cap. |
| **S**poofing (outbound) | The Function impersonated to the console. | The eval-probe route is fail-closed on `LOOM_INTERNAL_TOKEN` (constant-time compare, 401 when unset); the token transits HTTPS only (Front Door / CAE TLS). |
| **T**ampering | Malicious eval rows steer the judge / poison scores. | Eval sets are version-controlled (`content/evals/`, CI-linted vs `_schema.json`) and staged read-only into the package; the Function never accepts eval rows over HTTP — the trigger body only selects surface NAMES. |
| **T**ampering (data) | Forged score docs in `loom-copilot-evals`. | Writes require the Cosmos data-plane role held only by the Function MI (and the Console UAMI); AAD-only account, no keys. |
| **R**epudiation | "Who ran / changed what?" | Every run doc carries `trigger` (`nightly`/`corpus`/`manual`), `corpusCommit`, `judgeModel`, timestamps; Function invocation logs land in App Insights; E5's "Run now" proxy is session-authenticated and attributable. |
| **I**nformation disclosure | Eval docs leak sensitive data. | The corpus is the product's own public documentation; probe answers are doc-grounded. No user data, no secrets in any doc; the internal token is never logged or echoed (401 body carries no detail). |
| **D**enial of service | Trigger flood → AOAI token burn / RU burn. | Function-key gate + the **daily judge cap** (Cosmos ledger, cross-replica) bound token spend; forbidden-phrase auto-fail spends zero; probe calls are sequential (no fan-out); Y1 plan bounds instances. |
| **E**levation of privilege | The Function's identity is abused laterally. | Least-privilege, resource-scoped grants only: Search *Index Data Reader* (read), *Cognitive Services OpenAI User* (inference, no management), Cosmos *Built-in Data Contributor* (data-plane only), Storage Blob Data Owner scoped to its OWN host storage account. No ARM writes, no RBAC-write, no KV access. `skipRoleGrants` honors restricted deployers. |

**HTTP-trigger exposure:** the trigger is public-internet reachable (Consumption
plan, no VNet) but key-gated; it accepts only `{surfaces?, trigger?}` and
returns aggregate scores — no data-plane passthrough. Rotating the function key
(`az functionapp keys set`) revokes access instantly.

## Per-cloud

- **Commercial:** judge = the strong tier bicep binds from the availability
  matrix; AI Search `loom-docs` path via the console probe.
- **Gov GCC-High (`.us`):** the judge scope auto-switches to
  `cognitiveservices.azure.us` (endpoint-suffix detection); Gov's strong tier
  is whatever `bestReasoningModelFor('GCC-High')` binds (no global-standard
  deployments — standard/data-zone only).
- **IL5 / air-gapped:** all in-tenant (Functions + Cosmos + AOAI + the probe);
  eval sets ship in the package — no external fetch. With no strong-tier model
  deployed the judge falls to mini/default — answer-quality scores are
  advisory at lower judge tiers; retrieval hit-rate (deterministic) remains
  authoritative.
