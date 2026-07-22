# loom-next-level — Workstreams E (Copilot Eval Harness) & C (Cost Intelligence)

> Draft for the master PRP. Author: copilot-cost workstream agent. Date: 2026-07-22.
> Scope: `apps/fiab-console` + `azure-functions` + `platform/fiab/bicep`.
> Conventions inherited from the master PRP: PR-sized items with IDs; each item lists
> goal, exact files, backend/infra (bicep-sync per `no-vaporware.md`), env vars
> (ENV_CHECKS in `lib/admin/env-checks.ts` + gate registry `lib/gates/registry.ts`
> with a Fix-it per G2), acceptance incl. a G1 browser/E2E receipt, and a per-cloud
> section (Commercial / Gov GCC-High / IL5-air-gapped).

---

## 0. Current-state grounding (studied before design — do NOT rebuild these)

**Copilot / eval side (WS-E builds ON these):**
- `apps/fiab-console/lib/azure/aoai-chat-client.ts` — the ONE unified AOAI chat client; 18 callers; `routeTurnTier` from `lib/foundry/model-tier-router.ts` is wired into the hot path so every turn is tier-aware. Cloud-correct (Gov `.us` scope via `cogScope`/`getOpenAiSuffix`). Honest 503 `NoAoaiDeploymentError` gate.
- `lib/foundry/model-tier-router.ts` — `routeTurnTier(input)`, `selectTier`, `DEFAULT_TASK_TIER_MAP`, `TaskClass`, `ModelTier` ('lightweight'|'mini'|'standard'|'strong'), `reasoningTierConfigured(cfg)`, `bestReasoningModelForCloud()`. Escalate-only guard on the auto path.
- `lib/copilot/skill-registry-core.ts` + `lib/copilot/ms-skills.ts` + `lib/copilot/powerbi-skills.ts` — skill descriptors keyed by **pane**. Distinct panes today (37): `ai-foundry-hub, ai-foundry-project, ai-search-index, apim-api, apim-policy, apim-product, automl, azure-cosmos-account, content-safety, copilot, cosmos-gremlin-graph, cost, data-agent, default, deploy-planner, evaluation, event-schema-set, eventhouse, eventstream, health, kql-dashboard, kql-database, kql-queryset, lakehouse, ml-model, monitor, postgres, postgres-flexible-server, powerbi, rbac, report, semantic-model, sql-database, tracing, vector-store`. `default` = the Learning-Hub / Help docs Copilot.
- `lib/copilot/turn-trace.ts` — per-turn trace record (the eval judge will read/emit against the same shape).
- `lib/perf/retrieval-metrics.ts` + `app/api/admin/performance/retrieval-stats/route.ts` + `RetrievalMetricsCard` — process-wide docs-Copilot retrieval telemetry (queries/hits/empty/fallbacks/p50/p95, backend = `ai-search|cosmos|none`). Per-replica module state.
- `lib/perf/copilot-slo.ts` — Copilot latency SLO objectives (first-token 5s, full-turn 30s, 0.95 objective).
- `azure-functions/ops-agent-evaluator/` — **timer-trigger Function precedent** (`opsAgentEvaluator.ts` + pure `evaluator-core.ts` + `azure-clients.ts`): reads Cosmos → ADX query → AOAI reason → Logic App dispatch, all managed-identity, honest `missingConfig()` gate, pure core unit-tested. **This is the shape WS-E's copilot-evaluator mirrors.**
- `lib/admin/agent-quality.ts` + `app/admin/agent-quality/page.tsx` — already consolidates **AGENT** evals (Cosmos `loom-agent-memory` `docType:'eval'`, LLM-judge 1-5), red-team, AgentOps, Copilot SLO. Owns the pure `EvalRegression` diff (`improved|regressed|stable|no-baseline`), `PromptDelta`, letter grades. **WS-E reuses these pure helpers — it does NOT re-implement regression diff.**
- `scripts/csa-loom/stage-copilot-corpus.sh` — hash-incremental corpus staging (PR #2367); writes `apps/fiab-console/copilot-corpus/.corpus-manifest.json` (git commit + counts + per-file sha). Runs before `az acr build` in `full-app-deploy-commercial.yml`. **WS-E's eval trigger reads this manifest to know when the corpus changed.**
- `.github/workflows/copilot-evals.yml` — EXISTS but is for the **legacy Python `apps/copilot`** (pydantic-ai / DryRunAgent), NOT the in-product Next.js Copilot. WS-E's workflow is new + separately named to avoid collision.

**Cost side (WS-C hardens/extends these — they already exist):**
- `lib/azure/cost-client.ts` — multi-sub throttle-aware Cost Management `query` loop; already computes a **run-rate** `forecast` (MTD daily-rate × days-in-month), `computeAnomalies(daily[])` (3σ over daily series → `CostAnomaly {severity: high|medium}`), `listBudgets(sub)` (`Microsoft.Consumption/budgets` 2023-05-01 → `CostBudget`). Per-fetch budget clamp + `MonitorError`/`MonitorNotConfiguredError`.
- `lib/azure/cost-management-client.ts` — Fabric-Capacity-Metrics-parity rollup: Cost Management $ + Azure Monitor per-engine utilization → **Loom Capacity Unit (LCU)**. `billingScope()` resolves `LOOM_BILLING_SCOPE` (billing account / MG / sub). Honest 503 when UAMI lacks *Cost Management Reader*.
- `lib/azure/domain-chargeback.ts`, `lib/azure/workspace-chargeback.ts`, `lib/azure/cost-attribution.ts` — per-domain / per-workspace chargeback rollups (tag-based attribution). Unit-tested.
- `lib/azure/monitor-client.ts` (`fetchMetrics`, `listResources`), `lib/azure/monitor-gate.ts`.
- `app/admin/chargeback/`, `app/admin/usage-chargeback/`, `app/admin/domains/`, `app/admin/copilot-usage/` — existing FinOps-ish admin surfaces (E2E'd 07-17 per memory).
- `lib/azure/query-result-cache.ts::getOrComputeCached<T>(key, modelId, compute, {ttlMs, budgetMs, serveStaleOnError, counterBackend, staleWhileRevalidate})` — **the caching primitive** every cold cost fan-out must use (Front Door 60s edge budget → `budgetMs` + `serveStaleOnError`).
- `lib/admin/env-checks.ts` (ENV_CHECKS) — declares `LOOM_AOAI_*`, `LOOM_BILLING_SCOPE`, `LOOM_SUBSCRIPTION_ID`, `LOOM_AUTOPILOT_*`. `lib/gates/registry.ts` enriches each with `surfaces`/`fixit`/`legacyCodes` and is unit-tested to cover EVERY ENV_CHECKS id (no drift).

**Learn-grounded cloud facts (verified 2026-07-22 via microsoft_docs_search):**
- **Cost Management Forecast API** = `Microsoft.CostManagement/forecast` (`.../forecast/usage`), sibling to `query`. Returns forecast + confidence bands. Caveats: `FailedDependency` when <1 week of history or mixed currencies (fix: request `CostUSD`); `GatewayTimeout` on >50-sub MGs (simplify group-by / narrow scope).
- **Gov AOAI models** (usgovarizona/usgovvirginia/USGov DataZone): `gpt-5.1` (NEW), `gpt-4.1`+`gpt-4.1-mini`, o-series reasoning, `gpt-4o`+`gpt-4o-mini`, embeddings. So the LLM-judge's "top tier" resolves to `gpt-5.1`/`gpt-4.1` in Gov (matches the tier-router's Gov floor). Global-standard deployments are NOT available in Gov (use standard/data-zone).

---

# WORKSTREAM E — COPILOT EVAL HARNESS

**Goal:** a real, gated, admin-visible quality harness for the in-product Copilot
surfaces (RAG hit-rate + grounding-faithful answer quality + tier-router
correctness), so corpus/prompt/router changes can't silently regress Copilot.
Mirrors the `ops-agent-evaluator` Function shape; reuses `agent-quality.ts` pure
helpers, `retrieval-metrics`, `turn-trace`, and the tier-router.

### Data model (Cosmos, container `loom-copilot-evals`, PK `/surface`)
Reuse the existing Cosmos account (`LOOM_COSMOS_ENDPOINT`/`LOOM_COSMOS_DATABASE`). Two doc types:
- `docType:'eval-run'` — `{ id, surface, runId, corpusCommit, startedAt, model, judgeModel, trigger:'corpus'|'nightly'|'manual', totals:{questions, retrievalHitRate, groundingAvg, answerAvg, passRate}, tierAccuracy? }`
- `docType:'eval-result'` — one per question: `{ id, surface, runId, questionId, question, expectedChunkIds[], retrievedChunkIds[], retrievalHit:boolean, mrr:number, answer, judge:{grounding:1-5, relevance:1-5, completeness:1-5, rationale}, pass:boolean, latencyMs }`
TTL 180d on results (keep run summaries indefinitely). Container created via cosmos-client `createIfNotExists` at boot (per `no-vaporware.md` bicep-sync rule 4).

---

## E1 — Golden Q/A eval-set format + seed sets for top 10 surfaces

**Goal:** authored, version-controlled eval sets living beside the corpus, one JSONL per surface.

**Files/paths:**
- `content/evals/<surface>.jsonl` — new tree. One JSON object per line:
  ```json
  {"id":"help-001","question":"How do I bind a lakehouse to a workspace without a Fabric capacity?","expectedChunks":["docs/fiab/parity/lakehouse.md#azure-native","docs/fiab/items/lakehouse.md"],"expectedAnswer":"Loom defaults to ADLS Gen2 + Delta; no Fabric workspace is required...","mustMention":["ADLS","Delta"],"mustNotMention":["requires a Fabric capacity"],"tier":"mini","taskClass":"doc-qa"}
  ```
  - `expectedChunks` = doc paths/anchors the retriever SHOULD surface (scored as hit-rate + MRR). `mustMention`/`mustNotMention` = cheap deterministic grounding guards checked BEFORE the LLM-judge. `tier`/`taskClass` = the tier-router label (feeds E6).
- `content/evals/_schema.json` — JSON-Schema for a row (CI lint validates every line).
- `content/evals/README.md` — authoring guide + how `mustNotMention` encodes the anti-Fabric-dependency and no-vaporware rules as assertions.
- `scripts/csa-loom/lint-eval-sets.mjs` — validates JSONL against `_schema.json`, asserts every `expectedChunks` path exists in the staged corpus manifest (`.corpus-manifest.json`), fails on dangling anchors.

**Seed sets (10 surfaces × 12-20 Q each), chosen by traffic + risk:**
1. `help.jsonl` (pane `default` — Learning-Hub docs Copilot; the `searchDocs` RAG path) — 20 Q spanning install, gates, Fabric-independence, deploy phases.
2. `deploy-planner.jsonl` — 15 Q (two-phase image path, bicep params, DLZ attach).
3. `lakehouse.jsonl` — 15 Q (ADLS+Delta default, Synapse registration, no-Fabric).
4. `kql-database.jsonl` — 15 Q (ADX cluster default vs Eventhouse, KQL authoring).
5. `data-agent.jsonl` — 15 Q (grounding sources, tool selection, guardrails).
6. `cost.jsonl` — 12 Q (chargeback, LCU, forecast, budgets — ties to WS-C).
7. `health.jsonl` (+`monitor`) — 15 Q (SLO, anomaly, ops-agent triggers).
8. `report.jsonl` (+`semantic-model`) — 15 Q (Loom-native renderer, DAX, AAS-native, no Power BI workspace required).
9. `rbac.jsonl` — 12 Q (access governance, ABAC, role grants).
10. `eventstream.jsonl` — 12 Q (Event Hubs default, Stream Analytics processing).

**Backend/infra:** none new — files are staged into the image by extending `stage-copilot-corpus.sh` to also copy `content/evals/` into `copilot-corpus/evals/` (so the runner reads them from the same FS the corpus uses).

**Env/gate:** none (authoring artifact). **Acceptance:** `pnpm --filter fiab-console lint:evals` passes; every `expectedChunks` resolves; `git` shows 10 JSONL files with ≥12 rows each. **G1 receipt:** N/A (data-only) — covered by E2's run receipt.

**Per-cloud:** identical everywhere (static content). IL5/air-gapped: the sets ship in the image; no external fetch.

---

## E2 — Copilot evaluator Function (`azure-functions/copilot-evaluator`)

**Goal:** the runtime that executes eval sets against the REAL retrieval + AOAI path and writes scored results to Cosmos. New Function app-in-repo mirroring `ops-agent-evaluator` (pure core + thin timer/HTTP wrappers).

**Files/paths (new dir `azure-functions/copilot-evaluator/`):**
- `src/evaluator-core.ts` — PURE (no Azure SDK): `missingConfig(env)`, `loadEvalSets(fsRoot)`, `scoreRetrieval(expectedChunks, retrievedChunks) → {hit, mrr}`, `deterministicGuards(answer, row) → {mentionPass, forbiddenHit}`, `buildJudgeMessages(row, answer, retrieved)` (grounding-fidelity rubric prompt), `parseJudge(text) → {grounding,relevance,completeness,rationale}`, `rollupRun(results) → totals`. Unit-tested (`evaluator-core.test.ts`).
- `src/azure-clients.ts` — REAL: `retrieveChunks(query)` (calls the SAME `loom-docs-index.searchDocs` path via the console's internal retrieval endpoint OR a shared package import — see note), `judgeAnswer(messages)` (AOAI chat via the unified contract, `max_completion_tokens`, top tier), `writeRun`/`writeResults` (Cosmos), `readCorpusManifest()`.
- `src/functions/copilotEvaluatorTimer.ts` — `app.timer` on `COPILOT_EVALUATOR_CRON` (default nightly `0 0 7 * * *`).
- `src/functions/copilotEvaluatorHttp.ts` — `app.http` POST trigger for on-demand runs (called by the corpus-staging workflow E4 and the admin "Run now" button E5). Body `{surfaces?:string[], trigger}`.
- `host.json`, `package.json`, `tsconfig.json`, `vitest.config.ts`, `local.settings.json.sample`, `README.md`.

**Retrieval-path note (no-vaporware — must hit the REAL retriever):** the evaluator must exercise the identical retrieval the Copilot uses, not a reimplementation. Two acceptable wirings; pick per the console's module boundaries:
(a) **Preferred** — the console exposes an internal, UAMI-authenticated `POST /api/internal/copilot/eval-probe` route that runs `searchDocs(query)` + one Copilot turn through `aoai-chat-client` and returns `{retrievedChunks, answer, tier, latency}`; the Function calls it. This guarantees byte-identical retrieval + tier routing.
(b) Extract `loom-docs-index` into a shared workspace package importable by both console + Function. (a) is lower-risk and is the design default.

**Scoring:**
- **Retrieval hit-rate** = fraction of questions where ≥1 `expectedChunks` appears in `retrievedChunks`; **MRR** across expected chunks. Fed from real AI-Search (or Cosmos fallback) results — the `retrieval-metrics` backend label is recorded per question.
- **Answer quality** = LLM-judge (grounding-fidelity rubric: grounding/relevance/completeness each 1-5) using the tier-router's **top tier** (`bestReasoningModelForCloud()` → strong deployment). Deterministic `mustMention`/`mustNotMention` guards gate BEFORE the judge (a forbidden phrase = auto-fail, no judge spend).
- `pass` = retrievalHit && grounding≥4 && !forbiddenHit && mentionPass.

**Backend/infra (bicep-sync):**
- `platform/fiab/bicep/modules/functions/copilot-evaluator.bicep` — Linux Y1 Consumption Function (same shape as report-subscriptions), UAMI with: *Cognitive Services OpenAI User* on the AOAI/Foundry account, *Cosmos DB Built-in Data Contributor* on the Loom Cosmos, *Search Index Data Reader* on the `loom-docs` AI Search. Wired into the functions orchestrator.
- Cosmos container `loom-copilot-evals` (createIfNotExists at boot).

**Env vars (ENV_CHECKS + gate registry):**
- `COPILOT_EVALUATOR_CRON` (optional default). `LOOM_COPILOT_EVAL_JUDGE_DEPLOYMENT` (optional; defaults to `LOOM_AOAI_STRONG_DEPLOYMENT`→ mini→ default). `LOOM_COPILOT_EVAL_ENABLED` (default true, opt-out per `loom_default_on_opt_out`).
- New ENV_CHECKS id `svc-copilot-evaluator` (category `ai-copilot`, severity `optional`, `warnOnMiss`), remediation naming the Function + roles, `provisionedBy` the new bicep module. Gate-registry Fix-it kind `wizard` (deploy-the-Function wizard) + `role-grant` for the three RBAC roles.

**Acceptance / G1 receipt:** POST the HTTP trigger against the live centralus deployment with `{surfaces:["help"],trigger:"manual"}`; attach the real Cosmos `eval-run` doc (first 300 chars) showing `retrievalHitRate`/`groundingAvg` computed from REAL AI-Search + AOAI; attach the Function log line `[copilot-evaluator] run help: 20 Q, hit-rate 0.9, grounding 4.3`. Vitest for `evaluator-core` green.

**Per-cloud:**
- **Commercial (centralus, live):** judge = `gpt-5.6`/`gpt-5.5` strong tier; AI-Search `loom-docs`. Run live to produce the receipt.
- **Gov GCC-High (live; `.us`):** judge = `gpt-5.1`/`gpt-4.1` (Gov floor, Learn-verified); AOAI scope `.us` handled by the unified client already; AI-Search `.us` endpoint. No global-standard deployment — use standard/data-zone. Verified Gov has reasoning + gpt-4.1 so the judge tier is real.
- **IL5/air-gapped (design-only):** no nightly cloud judge egress needed (all in-tenant). If no strong-tier model is deployed, the judge falls back to `mini`/`default` deployment; document that answer-quality scores are advisory at lower judge tiers and retrieval hit-rate (deterministic) remains authoritative. No internet dependency — corpus + eval sets are in-image.

---

## E3 — Regression gating + per-surface score floor with ratchet

**Goal:** a per-surface eval-score floor (like the vitest coverage ratchet in commit 14a16d8e) that FAILS/WARNS a corpus PR when a surface's score drops >N points.

**Files/paths:**
- `content/evals/eval-floors.json` — `{ "<surface>": { "retrievalHitRate": 0.80, "groundingAvg": 4.0, "passRate": 0.85 } }`. Ratcheted UP only (a helper script raises floors after a sustained gain, never lowers them without an explicit override commit — mirrors the coverage-floor convention).
- `scripts/csa-loom/check-eval-regression.mjs` — reads the latest `eval-run` per surface from Cosmos (or a run-artifact JSON the Function POSTs back), compares to `eval-floors.json` AND to the previous run (delta). Exit non-zero when below floor; exit-with-warning-annotation when a single run drops >`EVAL_REGRESSION_DELTA` (default 5 points) but stays above floor (flaky-judge tolerance).
- `scripts/csa-loom/ratchet-eval-floors.mjs` — raises floors to `min(observed) - margin` after a green streak; opens the ratchet as its own PR (like the coverage ratchet PR).
- Reuse `lib/admin/agent-quality.ts` `EvalRegression`/`PromptDelta` pure helpers for the per-question drill (which questions crossed pass→fail).

**Backend/infra:** none (CI script + Cosmos read via a read-only UAMI or a run-artifact). **Env:** `EVAL_REGRESSION_DELTA` (CI-only, default 5).

**Acceptance / G1:** a deliberately-broken corpus edit (delete a `help` chunk) makes `check-eval-regression.mjs` fail with the exact surface + delta; a no-op corpus edit passes. Receipt = the CI annotation text + the two run docs.

**Per-cloud:** floors are cloud-agnostic thresholds; Gov may carry a *separate* `eval-floors.gov.json` if the Gov judge tier yields systematically different grounding scores (documented, not assumed). IL5: floors checked offline against the in-tenant run artifact.

---

## E4 — Corpus-staging trigger + nightly schedule

**Goal:** run E2 automatically when the corpus changes (corpus-staging workflow) and nightly.

**Files/paths:**
- `.github/workflows/copilot-quality-evals.yml` (NEW name — avoids the legacy `copilot-evals.yml`): triggers on `push` to `main` touching `docs/**`, `PRPs/active/**`, `PRPs/completed/csa-loom-pillar/**`, `content/evals/**`; and `schedule: cron nightly`. Steps: checkout → run `stage-copilot-corpus.sh` (compute manifest delta) → if corpus changed OR nightly, POST the E2 HTTP trigger (in-VNet via the existing ACA-exec / minted-session CI recipe from memory `csa_loom_gates_zero_infra_push`) → run `check-eval-regression.mjs` → sticky PR comment with per-surface deltas (reuse the copilot-evals sticky-comment pattern).
- Extend `full-app-deploy-commercial.yml`: AFTER the corpus is staged + image built, fire a post-deploy eval run so every roll re-baselines quality.
- The corpus-staging script already emits `.corpus-manifest.json` with a `changed` count — the workflow reads it to decide whether to run (skip evals on a zero-change corpus).

**Backend/infra:** the Function must be reachable from CI — reuse the in-VNet job / ACA-exec pattern (memory: Gov Purview DNS empty-zone recipe uses ACA-exec for in-VNet calls). **Env:** GitHub secrets for the minted-session probe (existing).

**Acceptance / G1:** a real corpus PR shows the sticky comment `help: hit-rate 0.90 (+0.02), grounding 4.3 (−0.1) ✅`; a nightly run appears in the Actions log with all 10 surfaces scored. Receipt = the workflow run URL + comment.

**Per-cloud:** Commercial via `full-app-deploy-commercial.yml`; Gov via the gov deploy workflow (SP `csa-loom-gov-deploy`) with the `.us` Function URL. IL5: the workflow adapts to the air-gapped CI (self-hosted runner in-enclave; document that the trigger is an in-enclave scheduled task, not GitHub-hosted).

---

## E5 — Admin surface: `/admin/copilot-quality`

**Goal:** real-data admin page for per-surface score trends, worst questions, drill-in. New page (the existing `/admin/agent-quality` is for AGENTS; `/admin/copilot-usage` is usage not quality — a **tab-add** to a shared "Copilot & Agents" admin hub is acceptable, but the deliverable is a distinct quality view).

**Files/paths:**
- `app/admin/copilot-quality/page.tsx` — `AdminShell` + `PageShell`; top scorecard `TileGrid` (per-surface letter grade + retrieval hit-rate + grounding avg + trend sparkline), a trend chart (per-surface over runs), a "worst questions" table (lowest grounding, forbidden-phrase hits), and a drill-in dialog per question showing expected vs retrieved chunks + judge rationale. Fluent v9 + Loom tokens; `EmptyState` when no runs yet; skeletons while loading; honest MessageBar + **Fix it** if `svc-copilot-evaluator` gate is unresolved (G2).
- `app/api/admin/copilot-quality/route.ts` — GET per-surface run summaries (Cosmos, `getOrComputeCached` 5-min TTL + `budgetMs`/`serveStaleOnError`). `app/api/admin/copilot-quality/[surface]/route.ts` — GET run history + per-question results for drill-in. `app/api/admin/copilot-quality/run/route.ts` — POST "Run now" (proxies the E2 HTTP trigger, session-validated).
- `lib/admin/copilot-quality.ts` — pure roll-up/trend/grade helpers (shared with the page + route), unit-tested. Reuse `agent-quality.ts` grade + regression helpers where shapes align.
- Register in `NAV_ITEMS` single-source (memory: NAV_ITEMS single-source) under Admin → Copilot & Agents.

**Backend/infra:** reads Cosmos `loom-copilot-evals` (real). No new infra beyond E2. **Env/gate:** surfaces the `svc-copilot-evaluator` gate with Fix-it.

**Acceptance / G1 (BLOCKING browser E2E per `loom_browser_e2e_before_done`):** minted-session Playwright walk on the live deployment — page renders per-surface real scores (non-zero, from E2's run), "Run now" triggers a real run and the table updates, drill-in opens a real question with real judge rationale, narrow-width pass (no badge overlap), first-open of an unconfigured deployment shows the Fix-it not a red error. Screenshots dark+light. Receipt in PR.

**Per-cloud:** same page all clouds; Gov reads the Gov Cosmos; data differs, surface identical. IL5: reads in-tenant Cosmos.

---

## E6 — Tier-router eval (cost-per-quality)

**Goal:** verify the tier-router's decisions against a labeled set and track cost-per-quality, so a router change that saves money but tanks quality (or vice-versa) is caught.

**Files/paths:**
- `content/evals/_tier-labels.jsonl` — `{ "prompt":"summarize this table", "expectedTier":"mini", "taskClass":"summarize" }` … a labeled corpus of cheap-turn vs complex-turn prompts (≥60 rows spanning `DEFAULT_TASK_TIER_MAP` classes).
- Extend `evaluator-core.ts`: `scoreTierDecision(row, routeTurnTier(...)) → {correct, chosenTier, expectedTier}` — pure, calls the REAL `routeTurnTier` (imported from the console's `model-tier-router` shared module). Confusion matrix over tiers.
- Extend the E2 run to also emit `tierAccuracy` + per-class confusion into the `eval-run` doc; extend E5's page with a "Tier routing" tab (accuracy %, confusion heatmap, and **cost-per-quality** = judged grounding per estimated $ using the per-tier price coefficients already in `lib/copilot/cost-estimate.ts`).
- A ratchet floor in `eval-floors.json` for `tierAccuracy` (e.g. ≥0.85).

**Backend/infra:** none new (pure router + existing cost-estimate). **Env:** none.

**Acceptance / G1:** a run reports `tierAccuracy 0.88` computed from the labeled set against the live `routeTurnTier`; flipping a label surfaces a mismatch in the confusion matrix on the page. Receipt = the run doc + the Tier-routing tab screenshot.

**Per-cloud:** router availability differs (Gov strong-tier = gpt-5.1/gpt-4.1); the eval asserts the router picks the *tier* correctly regardless of the concrete deployment name, so it's cloud-portable. IL5: if only one tier is deployed, the eval records "single-tier mode — routing inert" honestly rather than failing.

---

# WORKSTREAM C — COST INTELLIGENCE

**Goal:** promote the existing cost stack from "chargeback rollup" to a FinOps
brain — hardened Cost Management pulls, first-class forecast (real Forecast API +
fallback), anomaly detection with in-product + email alerts, and an upgraded
FinOps admin page with forecast/anomaly/budget CRUD tied to the chargeback model.
Builds ON `cost-client.ts` / `cost-management-client.ts` / `domain-chargeback.ts`.

---

## C1 — Cost Management pull hardening + caching + UAMI role

**Goal:** make per-scope (sub / RG / tag) cost pulls fast, cached, and correctly permissioned; consolidate the throttle-aware loop; guarantee *Cost Management Reader* is granted by bicep.

**Files/paths:**
- `lib/azure/cost-client.ts` — wrap every cost `query`/`forecast` fan-out in `getOrComputeCached(key, 'cost-mgmt', compute, {ttlMs: 15*60_000, budgetMs: 45_000, serveStaleOnError: true, counterBackend: 'cost'})`. Add a `counterBackend: 'cost'` to `cache-counters.ts` so the perf surface shows cost-cache hit-rate. Add per-scope key builders `costKey(scope, timeframe, groupBy)`.
- `lib/azure/cost-scope.ts` (NEW) — resolve sub / RG / tag scopes: `enumerateScopes()` (Loom subs + RGs from `listResources`), `tagScope(tagKey)` (Cost Management `query` with a `grouping` on `TagKey`). Bounded, unit-tested.
- `platform/fiab/bicep/modules/**` — add a *Cost Management Reader* role assignment for the Console UAMI at the **billing/subscription** scope (widest reliable scope per `cost-management-client.ts` comment). Wire into the admin-plane orchestrator. This is the single most common honest-gate today; making it push-button-provisioned closes it.

**Env/gate:** `LOOM_BILLING_SCOPE` (exists), `LOOM_SUBSCRIPTION_ID` (exists). Update the `chargeback`/`cost` ENV_CHECKS entry `role` to reference the now-bicep-granted role; gate-registry Fix-it kind `role-grant` (grant Cost Management Reader) + `resource-picker` (pick billing scope). **Default-ON:** per `loom_default_on_opt_out`, cost pulls run by default once the role exists; no spend gate.

**Acceptance / G1:** live centralus — GET the cost route twice; first call real (X-Cache: miss, real $ body first 300 chars), second `hit` under budget; perf surface shows the `cost` hit-rate. Bicep diff granting the role attached. Vitest for `cost-scope` green.

**Per-cloud:** Commercial — `management.azure.com`. Gov — `management.usgovcloudapi.net` (the client already routes via cloud-endpoints; verify the Cost Management path uses the Gov ARM host). IL5 — Cost Management may be unavailable in a disconnected enclave; document the fallback: ingest the *Generate Cost Details Report* CSV export into ADLS and compute rollups from it (a `cost-details-ingest` timer Function), surfaced identically.

---

## C2 — Forecasting (real Forecast API + Gov/air-gapped fallback)

**Goal:** replace the run-rate stub `forecast` with the real Cost Management **Forecast API**, with a computed projection fallback where the API is unavailable or under-fed.

**Files/paths:**
- `lib/azure/cost-forecast.ts` (NEW) — `forecastCost(scope, timeframe) → {points:[{date, cost, lowerBound, upperBound}], method:'api'|'linear'|'seasonal'}`. Primary: POST `Microsoft.CostManagement/forecast/usage` (`api-version` current) with `type:'ActualCost'`, `includeActualCost/includeFreshPartialCost`, request `CostUSD` to dodge the multi-currency `FailedDependency`. Fallback (on `FailedDependency`/insufficient history/Gov-unavailable): compute a **linear** (least-squares over daily series) or **seasonal** (7-day weekday profile × trend) projection from the historical `daily[]` the client already fetches — return `method` so the UI labels it honestly.
- `lib/azure/cost-client.ts` — replace the inline MTD run-rate with a call into `cost-forecast.ts`; keep the run-rate as the `linear` fallback path.
- Confidence bands: from the API when present; else ±1σ of the daily residuals.

**Backend/infra:** none new (same UAMI role as C1). **Env:** `LOOM_COST_FORECAST_HORIZON_DAYS` (optional, default 30), `LOOM_COST_FORECAST_METHOD` (optional `auto|api|linear|seasonal`, default `auto`).

**Acceptance / G1:** live — forecast route returns `method:'api'` with bands in Commercial (attach body); a forced-fallback (unset the API path) returns `method:'linear'` with a labeled projection. Vitest covers the linear + seasonal math on a fixture daily series.

**Per-cloud:**
- **Commercial:** Forecast API live (Learn-confirmed). Attach a real forecast receipt.
- **Gov GCC-High:** Forecast API IS part of Cost Management in Gov, BUT enrollment/scope support varies; the client tries the API and falls back to `seasonal` on `FailedDependency`. Document that Gov EA/MCA scope may need the billing-scope form (`LOOM_BILLING_SCOPE`). Verified via Learn that the Forecast API exists; the fallback guarantees a number regardless.
- **IL5/air-gapped:** Cost Management/Forecast likely unavailable → `seasonal`/`linear` computed from the C1 CSV-export ingest. Design documented; no external call.

---

## C3 — Anomaly detection + alerts (timer Function, in-product + email)

**Goal:** scheduled anomaly evaluation per workspace/domain with real alerting — in-product notifications + email via the existing Logic App callback. Follows the `report-subscriptions` timer-Function precedent exactly.

**Files/paths (new dir `azure-functions/cost-anomaly-monitor/` OR extend an existing ops Function — new dir for isolation):**
- `src/schedule.ts` — PURE: reuse/generalize `computeAnomalies` (currently in `cost-client.ts`) into a shared pure module `lib/azure/cost-anomaly-core.ts` (imported by BOTH the console and the Function), plus per-scope threshold config `{ scope, method:'3sigma'|'pct', threshold, minAbsDelta }`. Unit-tested.
- `src/functions/costAnomalyTimer.ts` — `app.timer` on `COST_ANOMALY_CRON` (default daily `0 0 6 * * *`): read enabled anomaly rules from Cosmos (`loom-cost-anomaly-rules`, PK `/scope`) → for each scope pull daily series (C1 cached client) → `detectAnomalies` → for each firing anomaly: (a) write an in-product notification (Cosmos `loom-notifications` the console already reads), (b) POST the rendered alert to the delivery Logic App (same `deliverViaLogicApp` pattern as report-subscriptions) for email. Per-rule try/catch, honest failure telemetry.
- `src/clients.ts` — REAL Cosmos + Logic App + cost pull (managed identity).
- `host.json`/`package.json`/`tsconfig.json`/`vitest.config.ts`/`README.md`.

**Backend/infra (bicep-sync):**
- `platform/fiab/bicep/modules/functions/cost-anomaly-monitor.bicep` — Linux Y1 Function, UAMI: *Cost Management Reader* (billing scope) + *Cosmos Data Contributor* + rights to invoke the delivery Logic App. Wired into the functions orchestrator.
- Cosmos containers `loom-cost-anomaly-rules` + reuse `loom-notifications`. createIfNotExists at boot.
- Reuse the existing delivery Logic App (report-subscriptions' Office 365 email) — no new Logic App.

**Env vars (ENV_CHECKS + gate registry):** `COST_ANOMALY_CRON` (optional), `LOOM_COST_ANOMALY_ENABLED` (default true, opt-out), `LOOM_ALERT_LOGICAPP` (reuse report-subscriptions' delivery Logic App var if shared, else new). New ENV_CHECKS `svc-cost-anomaly-monitor` (category `cost`/`finops`, `optional`, `warnOnMiss`) with Fix-it `wizard` (deploy Function) + `role-grant`.

**Acceptance / G1:** live — seed an anomaly rule + inject a synthetic cost spike fixture (or run against a real spike), confirm the Function writes a real `loom-notifications` doc AND the Logic App sends a real email (attach the delivery-log row + the notification body first 300 chars + the Function log line). Vitest for `cost-anomaly-core` green.

**Per-cloud:** Commercial + Gov both run the timer (Gov `.us` Logic App + ARM host). IL5: email may be unavailable → the in-product notification is the primary channel; document the email path as an honest-gate when no Logic App is bound.

---

## C4 — FinOps admin page upgrade (forecast / anomaly feed / breakdown / budget CRUD)

**Goal:** upgrade the FinOps admin surface (extend `/admin/chargeback` or a new `/admin/finops` hub that composes chargeback) to a real FinOps cockpit: forecast chart, anomaly feed, per-workspace/domain breakdown tied to the chargeback model, and budget CRUD against the real Azure Budgets API.

**Files/paths:**
- `app/admin/finops/page.tsx` (NEW hub; links from / absorbs the existing chargeback + usage-chargeback tabs) — `AdminShell`; sections: (1) **Forecast** chart (actual daily + forecast band from C2, `method` badge honest-labels api/linear/seasonal), (2) **Anomaly feed** (recent firings from `loom-notifications`/anomaly rules with severity + drill to the day), (3) **Breakdown** per workspace/domain (reuse `domain-chargeback`/`workspace-chargeback` + LCU from `cost-management-client`), (4) **Budgets** CRUD. Fluent v9 + tokens, `TileGrid`, `SplitPane` resizable per G3, `EmptyState`, skeletons, honest gates with Fix-it. Charts follow the `dataviz` skill palette.
- `app/api/admin/finops/forecast/route.ts` — GET (C2, cached). `.../anomalies/route.ts` — GET feed + PUT rule config (threshold CRUD → `loom-cost-anomaly-rules`). `.../breakdown/route.ts` — GET per-scope rollup. `.../budgets/route.ts` — GET/POST/PUT/DELETE against `Microsoft.Consumption/budgets` (2023-05-01) — REAL create/update/delete, not read-only (`listBudgets` today only reads).
- `lib/azure/budgets-client.ts` (NEW) — `createBudget`/`updateBudget`/`deleteBudget` (ARM PUT/DELETE on the Consumption budgets provider) + validation. Unit-tested against a mocked ARM.
- `lib/admin/finops-view.ts` — pure view-model assembly (forecast + anomalies + breakdown + budgets → tiles), unit-tested.
- Register in `NAV_ITEMS`.

**Backend/infra:** budget CRUD needs the UAMI to have *Cost Management Contributor* (or Budgets write) at the target scope — add the role assignment in bicep (C1's module, upgraded scope). Anomaly rule CRUD writes `loom-cost-anomaly-rules` (C3's container).

**Env/gate:** reuse C1/C2/C3 vars; the page surfaces each unresolved gate with Fix-it (G2). Budget-write role is a new honest-gate `svc-budgets-write` (Fix-it `role-grant`).

**Acceptance / G1 (BLOCKING browser E2E):** minted-session Playwright on live centralus — forecast chart renders real actual+forecast with the correct `method` badge; anomaly feed shows a real firing; breakdown shows real per-domain $ + LCU tied to the chargeback model; **create a real Azure Budget** via the UI and confirm it appears in the Azure portal / a subsequent `listBudgets`, then delete it (full CRUD round-trip). Narrow-width + first-open-clean passes. Screenshots dark+light. Receipt in PR.

**Per-cloud:**
- **Commercial:** Budgets API + Forecast live; full CRUD receipt.
- **Gov GCC-High:** `Microsoft.Consumption/budgets` available on Gov ARM (`.us`); Budget CRUD works; forecast per C2 (api→fallback). Verify Cost Management Contributor is grantable on the Gov billing scope (may require the billing-account admin — document as an honest one-time admin action per `no-vaporware`).
- **IL5/air-gapped:** Budgets/Consumption may be unavailable → budget CRUD degrades to a **Loom-native budget** stored in Cosmos with the anomaly monitor enforcing thresholds locally (design documented); forecast = seasonal from CSV-ingest; the page renders identically with an honest "native budget (Consumption API unavailable in this cloud)" label.

---

## Cross-cutting

- **No-Fabric-dependency:** every backend here is Azure-native (Cost Management, Consumption, Azure Monitor, AOAI, Cosmos, AI Search, Logic App). No `api.fabric`/`api.powerbi` on any path. The Copilot judge rubric explicitly asserts answers never claim a Fabric capacity is required (`mustNotMention`).
- **Default-ON:** eval harness + cost intelligence run by default once their (bicep-provisioned) roles exist; the only gates are honest infra gates with Fix-it wizards (G2), registered in `lib/gates/registry.ts` and shown on `/admin/gates`.
- **Shared pure modules** (extract-once, import-both): `lib/azure/cost-anomaly-core.ts` (console + Function), the `model-tier-router` (console + copilot-evaluator), `agent-quality.ts` regression helpers (agent-quality + copilot-quality).
- **Ratchet convention** matches the existing vitest coverage floor (commit 14a16d8e): floors go up via a dedicated ratchet PR, never silently down.
- **Sequencing:** E1→E2→(E3,E4)→E5→E6; C1→C2→C3→C4. E2 and C1 are the load-bearing foundations; do them first. Serialize any items touching `cost-client.ts` (C1/C2) and any touching the same admin nav (E5/C4).
