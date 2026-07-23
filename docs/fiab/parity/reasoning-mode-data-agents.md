# reasoning-mode-data-agents — planner→execute→verify loop (WS-5.5)

**Surface:** the Loom data-agent test-chat panel, augmented with a
`ReasoningTrace` card that shows the reasoning plan, per-step execution
results, and the verify verdict.

**This is a Loom-native feature** (no direct Azure portal or Fabric
analog; the closest analog is the Azure AI Foundry Agent Service reasoning /
multi-step planning flow). The parity target is the Azure AI Foundry agent
playground's "chain-of-thought" plan display:
- Azure AI Foundry Agent Service — <https://learn.microsoft.com/azure/ai-foundry/agents/overview>
- Reasoning models on Azure OpenAI — <https://learn.microsoft.com/azure/ai-services/openai/concepts/reasoning>
- Multi-step function calling — <https://learn.microsoft.com/azure/ai-services/openai/how-to/function-calling>

> The Azure AI Foundry agent playground shows an explicit reasoning trace when
> a reasoning model (o-series) decomposes a hard question into steps, calls
> tools per step, then synthesises a verified answer. Loom's data-agent
> reproduces this loop **natively on the Azure-native backend**, routing
> planning + verification turns through the WS-1.1 strong (reasoning-tier)
> deployment, executing each step via the existing grounded-chat path
> (`chatGrounded` → propose query → run read-only on Synapse SQL / ADX → re-ground),
> and surfacing the plan card + per-step run metadata + verdict badge to the
> user. **No Fabric capacity or Power BI workspace required** (per
> `no-fabric-dependency.md`).

## Feature inventory (what the loop does)

| # | Capability | Source file |
| --- | --- | --- |
| 1 | Multi-hop detection — `isMultiHop` + `shouldPlan` decide when a turn earns the full loop vs. cheap single-shot | `lib/azure/data-agent-planner.ts` |
| 2 | PLAN pass — reasoning-tier LLM call (`taskClass:'reasoning'` via `routeTurnTier`) produces an ordered JSON plan (source + sub-query + rationale per step, capped at 5) | `lib/azure/data-agent-reasoning.ts` `buildPlanPrompt` |
| 3 | EXECUTE pass — each plan step runs via `chatGrounded` against the real Azure backend (Synapse SQL / ADX / AI Search / semantic-model DAX); earlier step answers thread into later steps | `lib/azure/data-agent-reasoning.ts` `runReasoningAgent` |
| 4 | VERIFY pass — reasoning-tier LLM re-reads the real step results and emits a verdict (`pass`/`partial`/`fail`) + a grounded final answer | `lib/azure/data-agent-reasoning.ts` `buildVerifyPrompt` |
| 5 | Honest degradation — no `LOOM_AOAI_STRONG_DEPLOYMENT` configured → loop still runs on the standard deployment; `reasoningConfigured:false` is returned and the trace badge shows `standard tier` instead of `reasoning tier` | `model-tier-router` `reasoningTierConfigured` |
| 6 | `mode` request parameter — `auto` (default), `plan` (force), `single` (force single-shot) on `POST /api/items/data-agent/[id]/chat` | `app/api/items/data-agent/[id]/chat/route.ts` |
| 7 | Reasoning plan card UI — Fluent v9 + Loom tokens; collapsible `<details>` with step list, status icons, row-count badges, `flexWrap`; verdict badge (`Verified` / `Partly verified` / `Not verified`) + tier transparency chip | `lib/editors/phase4/data-agent-reasoning-trace.tsx` |
| 8 | Editor integration — `ReasoningTrace` rendered under each assistant turn when `mode==='plan-execute-verify'`; the full `DataAgentAnswer` type is preserved so existing tools/usage accounting keeps working | `lib/editors/phase4/data-agent-editor.tsx` |

## Loom coverage

| # | Capability | Status | Where |
| --- | --- | --- | --- |
| 1 | Multi-hop detection | built ✅ | `isMultiHop` / `shouldPlan` — regex + source-count heuristics; 20 unit tests green |
| 2 | PLAN pass (reasoning tier) | built ✅ | `aoaiChatTurn` with `taskClass:'reasoning'` → strong deployment via `routeTurnTier`; `parsePlan` / `sequenceSteps` parse + cap the output |
| 3 | EXECUTE pass (real backend, step-chaining) | built ✅ | `chatGrounded` (→ real Synapse SQL / ADX / Search / DAX) per step; prior-step answer threaded into `priorContext` for dependent multi-hop |
| 4 | VERIFY pass (reasoning tier) | built ✅ | `aoaiChatTurn` over real step results; `parseVerify` normalises verdict; final answer is grounded ONLY in step results |
| 5 | Honest degradation (no strong deployment) | honest-gate ⚠️ | Falls through to standard deployment silently; `reasoningConfigured:false` in response; UI shows `standard tier` chip — no hard failure |
| 6 | `mode` request parameter | built ✅ | `POST /api/items/data-agent/[id]/chat` body: `{mode:'auto'|'plan'|'single'}` |
| 7 | Reasoning plan card (Fluent v9 + tokens) | built ✅ | `ReasoningTrace` — `<details open>`, step `<ol>`, `Badge` row-counts, verdict badges, `flexWrap`, `minWidth:0`; keyboard-accessible; no hard-coded px |
| 8 | Editor chat integration | built ✅ | `DataAgentEditor` chat loop: maps `j.mode==='plan-execute-verify'` → `ReasoningTraceData`; displayed under the assistant bubble |

Zero ❌. Honest-gate ⚠️ only for the degraded no-strong-deployment path, which
is a deliberate Azure-side opt-in (the tenant admin wires `LOOM_AOAI_STRONG_DEPLOYMENT`
from the Foundry hub Model tiers page) — not a Fabric dependency.

## Backend per control

| Control / UI element | Tier / backend calls |
| --- | --- |
| Multi-hop trigger (auto mode) | `classifyTaskClass` (pure, no LLM) → `shouldPlan` (pure) → decides loop vs. single-shot |
| PLAN LLM call | `POST <AOAI>/openai/deployments/<strong>/chat/completions` (reasoning tier: `LOOM_AOAI_STRONG_DEPLOYMENT` via `routeTurnTier({taskClass:'reasoning'})`) |
| Per-step EXECUTE | `chatGrounded` → `proposeQuery` (`POST <AOAI>/.../chat/completions`, standard tier) → `executeSourceQuery` (Synapse SQL TDS / ADX REST / AI Search REST / DAX tabular eval) |
| VERIFY LLM call | `POST <AOAI>/openai/deployments/<strong>/chat/completions` (same strong deployment) |
| Reasoning trace card | Client-only render from BFF response; no additional calls |
| `mode=plan` force-plan | `POST /api/items/data-agent/[id]/chat` with `{mode:'plan'}` skips `shouldPlan` check |
| `mode=single` force-single | same route with `{mode:'single'}` skips the loop entirely |
| Honest no-strong-deployment gate | `reasoningTierConfigured(tierCfg)` → `false`; BFF returns `{reasoningConfigured:false,modelTier:'standard'}`; trace chip shows `standard tier` |

## Test coverage

| File | Scope |
| --- | --- |
| `lib/azure/__tests__/data-agent-planner.test.ts` | `isMultiHop`, `shouldPlan`, `parsePlan`, `sequenceSteps`, `parseVerify` — 16 unit tests (pure, no LLM) |
| `lib/azure/__tests__/data-agent-reasoning.test.ts` | `runReasoningAgent` — 4 integration-unit tests with mocked AOAI + grounded calls; covers happy path, tier routing, no-strong-deployment degradation, no-plan fallback |

## Validation receipt (CI)

- `tsc -p tsconfig.build.json --noEmit` — 0 errors
- vitest on both test files — 20/20 green
- `check-no-freeform.mjs` — OK (no JSON textarea / freeform config)
- `check-file-size.mjs` — OK (all files within size limits)
- `check-route-guards.mjs` — OK (`POST /api/items/data-agent/[id]/chat` guarded by `getSession()`)
- `check-bff-errors.mjs` — OK (BFF returns `{ok:false,error}` on all error paths)
- No new env vars (reuses `LOOM_AOAI_STRONG_DEPLOYMENT` from WS-1.1; env-config count unchanged)

**Browser E2E receipt owed (Track-0).** The in-browser E2E — a multi-hop question
(e.g. "Compare Q1 vs Q2 revenue, then break down by product and region") showing
the plan card, step-by-step execution with row counts, and the verify verdict —
is owed before this surface is A-grade per `ux-baseline.md` G1.

---

## N11 — GraphRAG retriever over the authored Weave/AGE ontology (2026-07-23)

The PLAN→EXECUTE→VERIFY loop now retrieves over the ontology the customer
**authored**, not just over tables. A relational (multi-hop) question routes
through `lib/azure/ontology-graphrag.ts` before any query is written.

| # | Capability | Status | Where |
| --- | --- | --- | --- |
| 1 | Seed-entity extraction from the question (declared object types + quoted phrases + content tokens) | built ✅ | `extractSeedTerms` (pure) |
| 2 | Real instance match against Apache AGE, **predicate filtered in JS post-fetch** (AGE gotcha) | built ✅ | `searchObjects` (real AGE read) + `scoreSeedObject` / `filterSeedObjects` (pure) |
| 3 | Multi-hop traversal — one assembled Cypher statement per hop over the whole frontier | built ✅ | `assembleHopCypher` + `parseHopRows` + bounded BFS in `retrieveGraphContext` |
| 4 | Subgraph + **precomputed community summaries** | built ✅ | `graphrag-index.ts` → `summariesForVertices` (Cosmos `loom-graphrag-index`, PK `/ontologyId`) |
| 5 | Typed **graph-path citations** into the N10 Answer Receipt | built ✅ | `GraphPathCitation` → `ReasoningAnswer.graph.paths` → `reasoningReceiptExtras()` → `assembleAnswerReceipt(trace, { graphPathCitations })` |
| 6 | Offline community-summary builder (schedulable item build step) on the **STANDARD** AOAI tier | built ✅ | `buildGraphRagIndex()` (`aoaiChat({ tier:'standard' })` — Gov-safe) |
| 7 | Honest extractive fallback when no model is deployed (never a mock) | built ✅ | `extractiveCommunitySummary` + `modelGenerated:false` on the doc |
| 8 | "Graph grounding" toggle on the data-agent editor (DEFAULT-ON) | built ✅ | `DataAgentEditor` Build tab → `state.graphGrounding` → BFF `resolveGraphContext()` |
| 9 | FLAG0 kill switch `n11-graphrag-grounding` (default-ON) | built ✅ | `RUNTIME_FLAGS` + `/admin/runtime-flags` |
| 10 | Honest infra gate when the Weave AGE backend is unwired | honest-gate ⚠️ | `weaveGate()` → `ReasoningAnswer.graph.gate` (the turn still answers, just without graph grounding) |

**AGE gotcha, honoured explicitly.** Only `id(a) = <numeric literal>`
disjunctions and `type(r)` / `label(b)` projections reach Cypher — the exact
forms `weave-explore.traverseObject` proves live. No variable-length `-[*1..n]-`,
no `IN [...]`, no property `WHERE`. Every property predicate runs in JS over rows
AGE actually returned (unit-tested).

**MIG1.** New Cosmos shape `loom-graphrag-index` (`CommunitySummaryDoc`,
`schemaVersion: 1`) registers its migrator chain at module scope in
`lib/azure/graphrag-index-model.ts` and is imported for that side effect by
`cosmos-client.ts` before any read materializes.

**AUDIT.** `buildGraphRagIndex` is a privileged mutation — it writes an
`_auditLog` row (`graphrag.index.build`) and fans out via `emitAuditEvent`.

## N12 — Self-healing / verified NL2SQL loop (2026-07-23)

| # | Capability | Status | Where |
| --- | --- | --- | --- |
| 1 | Classify a step outcome from REAL backend metadata (query error vs. honest infra gate vs. implausible all-empty result) | built ✅ | `classifyStepFailure` (pure) |
| 2 | Re-read the **LIVE** schema on every attempt | built ✅ | `fetchSynapseSchemaContext()` (sql-tools → live `sys.*` DMV) |
| 3 | Consult N9's governed metric contract on every attempt | built ✅ | `matchMetric(tenantId, subQuery)` |
| 4 | Schema-grounded rewrite | built ✅ | `buildRepairPrompt` / `buildRepairContext` → `aoaiChatTurn` |
| 5 | **EXPLAIN cost guardrail before re-running** (a rewrite that will not compile never spends an execution) | built ✅ | `explainQuery(dedicatedTarget(), sql, true)` → `summarizeExplainXml` |
| 6 | Pinned re-run on the real backend | built ✅ | `withPinnedQuery` → `chatGrounded` |
| 7 | **Bounded** retries (`LOOM_NL2SQL_REPAIR_MAX_ATTEMPTS`, default 2, clamped [0,5]) | built ✅ | `nl2sqlRepairMaxAttempts` |
| 8 | Every attempt recorded (attempt #, reason, error, rewritten query, EXPLAIN verdict, outcome, rows) | built ✅ | `RepairAttempt[]` on the step **and** the answer |
| 9 | Plausibility pass — the answer must follow from the REAL returned rows | built ✅ | `assessPlausibility` (pure; reads `tools[].rows`); downgrades a verify `pass` it cannot support |
| 10 | Attempts + plausibility rendered in the receipt + the reasoning trace | built ✅ | `ReceiptPanel` (`receipt-repair-attempts`, `receipt-plausibility`) + `ReasoningTrace` |

## Env / gate (G2)

| Var | Default (UNSET) | Gate |
| --- | --- | --- |
| `LOOM_GRAPHRAG_MAX_HOPS` | 2 hops — fully functional | `svc-graphrag-nl2sql-repair` (`optionalDefault`, env-picker Fix-it, `/admin/gates`) |
| `LOOM_NL2SQL_REPAIR_MAX_ATTEMPTS` | 2 attempts — fully functional | same gate |

Both are pure tuning knobs; the FEATURES are default-ON. Turning GraphRAG
grounding off is the FLAG0 runtime flag or the per-agent toggle — never an
unset env var. Both are emitted (empty) on the Console `apps[]` env in
`modules/admin-plane/main.bicep` so `/admin/env-config` can set them without a
bicep edit.

## Per-cloud + SOVEREIGN MOAT (IL5 / air-gap)

Identical in Commercial, GCC-High and IL5. **Apache AGE runs on an in-VNet
Azure Database for PostgreSQL flexible server with ZERO external egress** —
seed matching, multi-hop traversal, community summarization (in-boundary AOAI,
standard tier) and the persisted index (in-boundary Cosmos) are all inside the
boundary. The full capability therefore runs **DISCONNECTED in an air-gapped
IL5 enclave** with no code-path change, and the Answer Receipt — with the exact
graph paths, queries, row counts, repair attempts and plausibility verdict — IS
the compliance artifact an ISSO reviews. That is the moat headline. The
reasoning tier degrades to standard in Gov via the existing
`reasoningConfigured:false` honest-Fix-it pattern; N11/N12 are unaffected.

## Test coverage (added)

| File | Scope |
| --- | --- |
| `lib/azure/__tests__/ontology-graphrag.test.ts` | Seed extraction, the JS-side predicate filter, multi-hop Cypher assembly + injection guard, agtype hop parsing, path citations, community join, honest no-match note — over a real agtype ontology fixture |
| `lib/azure/__tests__/graphrag-index.test.ts` | Pure community detection (determinism, isolated-node drop, cap), title resolution, extractive fallback, STANDARD-tier summarization, real AGE reads, persistence + stale-build prune + audit row |
| `lib/azure/__tests__/data-agent-reasoning-graphrag.test.ts` | A multi-hop question yields graph-path citations; grounding reaches the planner AND every execute step; receipt-extras mapping; FLAG0 + per-agent toggle + non-relational + no-binding short-circuits |
| `lib/azure/__tests__/data-agent-reasoning-repair.test.ts` | Stale-schema failure → repairs + answers with every attempt recorded; BOUNDED retries; EXPLAIN guardrail rejects an invalid rewrite without spending an execution; plausibility pass/fail cases |

**Browser E2E receipt owed (G1)** for N11/N12: a multi-hop question against a
seeded ontology showing the graph-path rows in the reasoning trace + receipt,
and a stale-schema question showing the repair attempt chain. `tsc` + vitest are
not completion evidence.
