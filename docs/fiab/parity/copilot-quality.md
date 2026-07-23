# copilot-quality — parity with Azure AI Foundry evaluation / observability

**Loom surface:** `/admin/copilot-quality` (E5, loom-next-level ws-copilot-cost.md)
**Source UI:** Azure AI Foundry portal → *Evaluation* + *Observability* (per-run
metrics, groundedness/retrieval scores, run history, row-level drill-in) —
<https://learn.microsoft.com/azure/ai-foundry/concepts/evaluation-approach-gen-ai>.
This is a **Loom-only** analytics surface over the Loom Copilot's own retrieval +
Azure OpenAI judge path — Azure-native, **no Microsoft Fabric / Power BI
dependency** (the eval sets ship in-image; scores live in Cosmos).

## Azure/Foundry feature inventory (grounded in Learn)

| # | Foundry evaluation capability | Notes |
|---|-------------------------------|-------|
| 1 | Per-run metric scorecard (retrieval, groundedness, relevance, coherence) | headline scores per evaluation run |
| 2 | Retrieval quality (document retrieval / hit-rate / MRR) | grounded-retrieval metric |
| 3 | Groundedness / relevance / completeness via an AI judge (1–5) | LLM-as-judge rubric |
| 4 | Run history + trend across runs | compare runs over time |
| 5 | Row-level drill-in (per-question: query, retrieved context, answer, judge rationale) | inspect a failing row |
| 6 | Pass/fail threshold + regression signal vs a baseline | gate a change |
| 7 | On-demand run trigger | re-run an evaluation |
| 8 | Honest state when the evaluator / model is not configured | Foundry shows a setup prompt |

## Loom coverage

| # | Capability | Status | Loom implementation |
|---|-----------|--------|---------------------|
| 1 | Per-surface scorecard | ✅ built | Per-surface cards: composite letter grade + retrieval hit-rate + grounding + pass-rate + MRR (`buildSurfaceSummaries`, `compositeGrade`) |
| 2 | Retrieval hit-rate / MRR | ✅ built | Deterministic `scoreRetrieval` (E2) → `totals.retrievalHitRate` / `mrrAvg`; authoritative even when the judge is deferred |
| 3 | Grounding / relevance / completeness judge | ✅ built | E2 LLM-judge rubric (grounding 1–5) → `totals.groundingAvg`; judge-deferred runs labeled honestly (never fabricated) |
| 4 | Run-history trend | ✅ built | Per-surface trend sparkline (LoomChart line, oldest→newest) + program overview tiles |
| 5 | Row-level drill-in | ✅ built | Drill-in dialog: run picker + worst-questions table + evidence panel (expected vs retrieved chunks + the judge's own rationale + graded answer) — `worstQuestions` |
| 6 | Floor / regression signal | ✅ built | E3 `eval-floors.json` per-surface floor status (hit-rate / grounding / pass-rate ≥ floor), "below floor" alarm count; provisional-floor labeled |
| 7 | On-demand run | ✅ built (honest-gate) | "Run now" → `POST /api/admin/copilot-quality/run` → E2 HTTP trigger; honest gate + Fix-it when `LOOM_COPILOT_EVALUATOR_URL` unwired |
| 8 | Honest unconfigured state | ✅ built | `HonestGate` (svc-copilot-evaluator) banner + guided `EmptyState` naming the exact deploy/run step; clean first-open (no red banner) |

**Zero ❌.** The only non-functional state is the honest infra-gate (Run-now
needs the evaluator Function URL / host key) — the full surface still renders and
historical scores still show. Per the 2026-07-23 estate note, the evaluator
Function's live runs are pending the estate Function-fleet decision; until then
the page renders honestly from whatever eval-run docs exist in Cosmos (empty →
guided EmptyState), which is the intended behaviour.

## Backend per control

| Control | Backend |
|---------|---------|
| Scorecard / overview / trend | `GET /api/admin/copilot-quality` → Cosmos `loom-copilot-evals` (`eval-run` docs, PK /surface) via `copilotEvalsContainer()`; cached 5 min (`getOrComputeCached`, budget + serve-stale) |
| Floors | `content/evals/eval-floors.json` (staged in-image `copilot-corpus/evals/`) via `loadEvalFloors()` |
| Drill-in | `GET /api/admin/copilot-quality/[surface]` → Cosmos `eval-result` docs (single-partition) + `eval-run` history |
| Run now | `POST /api/admin/copilot-quality/run` → `triggerEvaluatorRun` → E2 `POST {LOOM_COPILOT_EVALUATOR_URL}/api/copilotEvaluatorHttp`; writes an `_auditLog` row (`kind:'copilot.eval-run-trigger'`) |
| Kill-switch | FLAG0 `e5-copilot-quality-page` runtime flag (`/admin/runtime-flags`) |

## Per-cloud

Cloud-neutral — same page every cloud; each reads its own Cosmos
`loom-copilot-evals`. Gov reads the Gov Cosmos; IL5 reads the in-tenant Cosmos
(eval sets + floors ship in-image, no external fetch). Data differs, surface
identical.
