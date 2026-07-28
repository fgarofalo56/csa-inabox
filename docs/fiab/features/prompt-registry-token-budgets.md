# Prompt registry and token budgets

> **Surface:** `/admin/ai-operations?tab=quality&sub=prompts` and `…&sub=budgets` (the legacy `/admin/copilot-quality` deep link redirects here)
> **Backend:** the `loom-prompt-registry` and `loom-token-budgets` Cosmos containers; the existing Copilot-evaluator Function supplies the scores
> **Kill-switch flags:** `n13-prompt-registry` (default ON, gates the authoring tab) and `n13-token-budgets` (default ON, gates enforcement *and* attribution)
> **Honest gate:** `LOOM_COPILOT_EVALUATOR_URL` unset — publish records an honest gate instead of a fabricated "run started"

Two LLMOps controls that sit on top of the evaluation machinery Loom already
runs:

- **Prompt registry** — every system prompt becomes a **semver'd, eval-scored,
  human-approved version**, with audited publish / approve / rollback.
- **Token budgets** — a per-workspace and per-agent allowance, enforced on the
  Azure OpenAI hot path, with real per-turn spend attribution.

## Why they exist

The evaluation harness, the score floors, the CI regression gate and the quality
read-out already existed. What was missing was the artifact in between: prompts
were edited in code and shipped on a roll, with no version, no score attached to
that version, and no human approval step. And nothing answered "which workspace
burned the model spend this month, and can I cap it?"

Neither feature forks the existing machinery. The registry *calls* the existing
evaluator; the budget plane composes with the existing tier router in a fixed
order.

## Prompt registry — how to use it end to end

1. Go to **Admin → AI operations → Copilot quality → Prompts**.
2. **Create a version** of a prompt for a surface. Versions are semver'd.
3. **Publish it.** Publishing requests a run from the *existing* Copilot-evaluator
   Function — the exact HTTP trigger the nightly quality workflow posts to. No
   second evaluator, no second harness.
4. The evaluator writes its run documents to the eval store; the registry then
   **stamps that real run onto the version**, with its floor verdict computed by
   the same floor logic and the same `eval-floors.json` the CI gate uses.
5. **Approve** the version. Approval **refuses a below-floor version** unless an
   admin passes an explicit override. Every publish, approve and rollback writes
   an `_auditLog` row.
6. **Roll back** to a previously approved version at any time. Approval history
   is never deleted — not by a rollback, and not by flipping the kill-switch.

The runtime reads the active approved version; the existing CI regression gate
still fails the build on a below-floor run, so no second CI gate was added.

## Token budgets — how to use it end to end

1. Go to **Admin → AI operations → Copilot quality → Budgets**.
2. **Set a budget** for a workspace or an agent — the allowance and its reset
   period.
3. Every Azure OpenAI turn now runs in this order:

   ```
   resolveAoaiTarget -> routeTurnTier (which model)
                          -> enforceTokenBudget (has this scope burned its allowance?)
                               -> the real Azure OpenAI call
                                    -> recordTurnSpend (attribution)
   ```

   The tier is an **input** to the budget check (it selects the price
   coefficient spend is attributed at), never an output — nothing here re-routes
   or overrides a tier decision.
4. **On breach**, the turn is refused with an honest 429-class structured error
   carrying the exact numbers, the reset time, and an inline Fix-it to raise the
   budget. Never a silent truncation of the message list, never a hang, never a
   generic 500.
5. **Read the ledger.** Real per-turn spend is attributed to the workspace,
   agent and item. Attribution flows either explicitly on a chat-client call or
   ambiently through an async-local attribution scope, so a route attributes
   every turn it makes without rewiring existing call sites.

### Default-on, fail-open

With **no budget configured the check is a no-op** — a workspace can never be
gated by a budget nobody set. Everything fails **open**: any Cosmos or flag
error allows the turn, because an accounting subsystem outage must never take
the Copilot down with it. Only a real, enabled, positive, breached budget
refuses.

## What the backend actually does

| Control | Backend |
|---|---|
| Prompt versions | `loom-prompt-registry` Cosmos container |
| Publish -> evaluate | POST to the Copilot-evaluator Function (`LOOM_COPILOT_EVALUATOR_URL`) |
| Score + floor verdict | The existing eval-run documents plus `content/evals/eval-floors.json` |
| Approve / rollback audit | `_auditLog` (`llmops.prompt.approve`, …) plus SIEM fan-out |
| Budget definitions + usage ledger | `loom-token-budgets` Cosmos container |
| Enforcement point | The shared Azure OpenAI chat client hot path |

Only token **counts** are persisted. No prompt text and no completion text ever
enters the ledger.

## Honest gates

- **Evaluator not wired.** With `LOOM_COPILOT_EVALUATOR_URL` unset, publish
  records an honest gate on the version rather than claiming a run started. The
  version still exists and can still be approved with an explicit override.
- **No budget set.** Not a gate — the intended default. The Budgets tab shows a
  guided empty state.

## Kill-switches

| Flag | Default | OFF reverts |
|---|---|---|
| `n13-prompt-registry` | ON | Hides the Prompts tab body behind a guided notice on the next load. The Cosmos store, the runtime active-prompt read and the evaluator are unaffected; approval history is never deleted. |
| `n13-token-budgets` | ON | Stops enforcement **and** attribution on the very next turn — the estate-wide release valve if a budget misfires. Configured budgets and the accumulated usage ledger are retained. The tier router, model selection and every other part of the turn are unaffected. |

## Related

- [Answer receipts](answer-receipts.md) — the per-answer token cost the ledger prices
- [FinOps hub](finops-hub.md) — where model spend meets the rest of the estate's cost
- [Model strategy](../model-strategy.md) · [Copilot usage](../admin/copilot-usage.md)
- [Unified LLMOps](../unified-llmops.md)
