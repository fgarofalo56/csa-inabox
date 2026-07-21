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
