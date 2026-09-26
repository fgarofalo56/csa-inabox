# Unified LLMOps (N13) — prompt registry, eval-in-CI gate, per-workspace token budgets

**Status:** shipped (N13). **Owner:** loom-next-level copilot-cost workstream.
**Scope rule:** N13 **extends** WS-E. It adds no second eval harness and no
second CI gate.

## What already existed (WS-E, E1–E6 — do not duplicate)

| Plane | Where it lives |
|---|---|
| Golden eval sets | `content/evals/*.jsonl` |
| Eval harness (retrieval + LLM judge + tier + search modes) | `azure-functions/copilot-evaluator/src/{evaluator-core,run-evals}.ts` |
| Score floors (ratchet-up-only) | `content/evals/eval-floors.json` |
| **The CI gate** | `scripts/csa-loom/check-eval-regression.mjs` |
| The workflow that runs it | `.github/workflows/copilot-quality-evals.yml` |
| Admin read surface | `/admin/copilot-quality` (E5 + SRCH1 Search tab + E6 Tier-routing tab) |
| Tier router (which model a turn rides) | `lib/foundry/model-tier-router.ts` → applied in `lib/azure/aoai-chat-client.ts` |

## What N13 adds

### 1. Prompt registry — `lib/copilot/prompt-registry.ts`

Cosmos `loom-prompt-registry` (PK `/promptId`, no TTL — approval history is ATO
evidence). Two doc kinds share the partition: `prompt` and `prompt-version`.
Doc shapes + the pure semver layer + the MIG1 migrator chain live in the LEAF
module `lib/azure/prompt-registry-model.ts` (imported by `cosmos-client` for the
side effect — the `copilot-evals-model` / `semantic-contract-model` precedent).

API: `registerPrompt` · `listPrompts` · `getActivePrompt` · `publishVersion` ·
`approveVersion` · `rollbackTo` (+ `attachLatestEvalScore`, `listVersions`).

**How a prompt bump reaches the EXISTING gate (no second CI gate):**

```
publishVersion(promptId, {template, bump})
  ├─ mints the next semver, status 'published'
  └─ triggerEvaluatorRun({surfaces:[prompt.surface], trigger:'manual'})
        ↑ lib/azure/copilot-evaluator-client.ts — the SAME client E5's
          "Run now" button and .github/workflows/copilot-quality-evals.yml use
          to start the loom-copilot-evaluator Container App Job through ARM.
          (It POSTed /api/copilotEvaluatorHttp on the E2 Function until the
          2026-07-27 migration recorded in that client's header; that trigger
          is disabled and the host is on the OP-19 delete list.)
        └─ the job writes an ordinary `eval-run` doc to loom-copilot-evals
             ├─ attachLatestEvalScore() stamps that REAL run onto the version,
             │  with the floor verdict from floorStatusFor() + eval-floors.json
             │  (the SAME function + SAME file E3/E5 use — one source of truth)
             └─ scripts/csa-loom/check-eval-regression.mjs (artifact mode in the
                E4 workflow, or `--cosmos` mode) grades it. UNCHANGED.
```

`approveVersion` is the human control point layered on top: it **refuses** a
version with no eval score, and **refuses** a below-floor version unless an admin
passes an explicit override (recorded as `overrodeFloor: true`). Every
register / publish / approve / rollback writes an `_auditLog` row via
`auditLogContainer()` (`kind: 'llmops.prompt.approve'`, …) and fans out through
`emitAuditEvent`.

`getActivePrompt()` only ever serves an **approved** active version — a draft is
never served, which is what makes the registry a control rather than a filing
cabinet. Callers fall back to their built-in prompt when it returns `null`
(default-ON / opt-out).

### 2. Per-workspace / per-agent token budgets — `lib/copilot/token-budget.ts`

Cosmos `loom-token-budgets` (PK `/scopeKey` = `<scope>:<scopeId>`, `defaultTtl -1`).
Two doc kinds: `budget` (durable) and `usage` (one period row, 400-day `ttl`).
Doc shapes + the pure attribution/verdict math + MIG1 live in the LEAF module
`lib/azure/token-budget-model.ts`.

**Hot-path order in `lib/azure/aoai-chat-client.ts`** (all four entry points —
`aoaiChat`, `aoaiChatJson`, `aoaiChatRaw`, `aoaiChatStream`):

```
resolveAoaiTarget ─► routeTurn()            ← E6 routeTurnTier, UNCHANGED semantics
                        │                      (renamed from applyTierRouting;
                        │                       now also returns the chosen tier)
                        ├─► enforceTokenBudget(attribution)   ← N13, before the fetch
                        ├─► the real AOAI fetch
                        └─► recordTurnSpend(attribution, {model, tier, usage})
```

The tier is an **input** to N13 (it selects the blended price coefficient from
`lib/copilot/cost-estimate`), never an output — nothing in N13 can re-route,
re-classify, or override an E6 decision.

* **On breach:** `TokenBudgetExceededError` — an honest 429-class structured
  refusal carrying the scope, the exact numbers, the reset time, and an inline
  Fix-it pointing at `/admin/copilot-quality?tab=budgets`. Never a silent
  truncation, never a hang.
* **Attribution:** explicit `opts.attribution`, or ambient via
  `withTokenAttribution(...)` (AsyncLocalStorage — the `adf-factory-context`
  precedent), so a route can attribute every AOAI turn it makes without
  rewiring the ~18 existing call sites.
* **Streaming:** `aoaiChatStream` enforces but does not record (the caller owns
  the SSE body, so the trailing `usage` block is unreadable here). The streaming
  orchestrator calls `recordTurnSpend` itself with the real usage it parses. No
  estimate is ever invented.
* **Fails OPEN:** unattributed turn, no budget, disabled budget, non-positive
  limit, flag OFF, or any Cosmos error → the turn proceeds. Only an affirmative,
  freshly-read over-budget verdict refuses.

### 3. Panels folded into the EXISTING E5 page

`lib/components/admin/copilot-quality-tabs.tsx` gains **Prompts** and **Budgets**
alongside Answer quality / Search relevance / Tier routing. No orphan admin tile,
no new admin page, no nav-registry change.

## Configuration

**No new environment variable.** Budgets are Cosmos docs created through the
audited CRUD; the code default is "no budget = unlimited" (default-ON / opt-out).
Retention, the initial semver, and the warn threshold are code constants in the
leaf models.

FLAG0 kill-switches (`lib/admin/runtime-flags.ts`, default ON):

| Flag | OFF behaviour |
|---|---|
| `n13-prompt-registry` | Hides the Prompts tab behind a guided notice. The store, `getActivePrompt()`, and the evaluator are untouched; approval history is never deleted. |
| `n13-token-budgets` | Stops enforcement **and** attribution on the very next turn (seconds, no roll). Budgets and the usage ledger are retained. |

## Per-cloud & sovereignty

Identical in Commercial and GCC-High — pure Cosmos metadata plus the in-VNet
evaluator Function both clouds deploy. No Fabric or Power BI dependency.

**IL5 note.** The registry, the eval scores it carries, the approval records, the
budgets, and the usage ledger all live in the deployment's **own** Cosmos, and
the scoring runs on the deployment's **own** evaluator Function inside the VNet.
There is **no external LLMOps SaaS** anywhere in this path — no Braintrust, no
LangSmith, no Weights & Biases. That is exactly why Loom builds this natively: an
IL5 enclave cannot ship prompts, completions, or eval scores to a commercial
multi-tenant service, so in-boundary prompt governance and in-boundary token
metering are the only compliant options. Only token **counts** are persisted —
no prompt or completion text enters the budget ledger.
