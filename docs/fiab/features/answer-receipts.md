# Answer receipts

> **Surface:** the collapsible **Receipt** panel under every agentic answer in the Copilot dock (cross-item Copilot and every per-surface Copilot)
> **Backend:** the `loom-answer-receipts` Cosmos container; the receipt itself is assembled from the turn trace, tool citations, phase timers and cost estimate
> **Kill-switch flag:** `n10-answer-receipts` (default ON)
> **Honest gate:** none — receipts assemble from signals the turn already produces

Every agentic Copilot answer earns a **receipt**: the plan the loop followed,
the exact SQL / KQL / Cypher / Gremlin / DAX it executed with real row counts,
the grounding sources, graph paths and metrics it used, which model tier
answered, the token cost, the per-phase timings, and a **Verified / Unverified /
Refused** verdict — plus the persisted governance-audit reference.

For a CDO evaluating the platform this is the buy signal. In an IL5 or air-gapped
boundary **the receipt is the compliance artifact**: it is the durable, in-boundary
evidence that a given answer came from a named query against a named source at a
named time, attributable to a principal.

## Why it exists

"The AI said so" is not an auditable statement. Every other part of the platform
already produced the evidence — the trace knew the plan, the tool results knew
the row counts, the phase timer knew where the wall clock went, the cost
estimator knew the spend — but none of it reached the person reading the answer.

The receipt is **assembly, not invention**. It composes signals Loom already
emits and never fabricates a field. Any missing or malformed input degrades
gracefully to an empty section rather than throwing: an assembler hiccup must
never break an answer.

## How to use it end to end

1. **Ask a question** in any Copilot dock that runs the agentic loop (the
   cross-item Copilot, a data agent, a per-surface Copilot).
2. **Read the verdict badge.** It is always visible on the collapsed panel:
   - **Verified** — the answer matched an approved verified query, or the
     verification signal from the [semantic contract](verified-queries.md)
     confirmed the result.
   - **Unverified** — the loop executed for real but no verification signal was
     present. This is the honest default, not a failure.
   - **Refused** — the loop declined: a content-safety block, a guardrail, an
     egress block, or an out-of-contract question the
     [semantic contract](verified-queries.md) refused rather than guessed at.
3. **Expand the panel** to walk the evidence:
   - **Plan** — the ordered steps the reasoning loop chose, each naming a source
     and a sub-query.
   - **Queries** — the exact text the model sent to each backend, tagged with its
     dialect, the row count it returned, whether it succeeded, and how long it
     took. Never paraphrased.
   - **Sources** — the grounding documents, schemas, knowledge and memory the
     answer cited.
   - **Graph paths** — when [GraphRAG grounding](graphrag-grounding.md) ran, the
     exact traversal that grounded the answer.
   - **Metrics** — the governed metrics resolved through the metrics layer.
   - **Model tier, token cost and per-phase timings** — classify, prompt build,
     LLM, tools.
   - **Repairs** — when [self-healing NL2SQL](self-healing-nl2sql.md) rewrote a
     failing step, each bounded attempt is listed.
4. **Cite the audit reference.** The panel prints the persisted
   `loom-answer-receipts` document id. That is the key an auditor joins on.

## What the backend actually does

| Receipt section | Where the signal comes from |
|---|---|
| Plan steps and raw tool calls | the per-turn trace |
| Grounding sources | the tool-citation layer already on the trace |
| Per-phase milliseconds | the phase timer |
| Token cost | the cost estimate already computed onto the final step |
| Verdict | the verify verdict from the semantic contract's verified-query result |
| Graph paths | the GraphRAG retriever's typed path citations |
| Persistence | the `loom-answer-receipts` Cosmos container |

Receipts persist **regardless of the flag** — the kill-switch controls the
reader surface only.

## Honest gates

There is no infrastructure gate on receipts. Two behaviours are worth calling
out because they look like gaps and are not:

- **A verdict of Unverified is normal** when no verified-query repository has
  been adopted for the tenant. The badge lights up automatically the moment a
  verification signal appears on the final step — no rework, no code change.
- **A section renders empty** when the turn genuinely produced no such signal
  (for example, no graph paths on a non-graph question). Loom shows the absence
  rather than filling it in.

## Kill-switch

`n10-answer-receipts` — default ON. Flipping it OFF hides the collapsible
Receipt panel under each answer on the next render. The answer, its citations
and the metadata bar are unaffected, and **receipts still persist to
`loom-answer-receipts` either way** — this only controls the reader surface. No
roll required.

## Related

- [Verified queries and the semantic contract](verified-queries.md) — where the Verified verdict comes from
- [GraphRAG grounding](graphrag-grounding.md) — where the graph-path citations come from
- [Self-healing NL2SQL](self-healing-nl2sql.md) — where the repair attempts come from
- [Prompt registry and token budgets](prompt-registry-token-budgets.md) — where the cost attribution lands
- [DoD IL5 compliance](../compliance/dod-il5.md) · [Audit logs](../admin/audit-logs.md)
