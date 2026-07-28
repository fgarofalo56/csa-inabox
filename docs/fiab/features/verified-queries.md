# Verified queries and the semantic contract

> **Surface:** semantic-model editor → **Verified Queries** tab (`/items/semantic-model/<id>`)
> **Backend:** the `loom-semantic-contract` Cosmos container (partitioned by tenant), read on every data-agent turn by the reasoning loop
> **Kill-switch flag:** `n9-verified-queries-tab` (default ON) — gates the authoring tab only
> **Honest gate:** none — a tenant with no contract behaves exactly as it did before the feature existed

A data agent that guesses is worse than one that says no. The **semantic
contract** is the governed boundary a data agent works inside: a **metric
registry** (what the business actually measures, who owns it, what people call
it) and a **Verified Query Repository** — approved question-to-query pairs the
agent retrieves *first*, before it ever generates SQL. A question that matches
neither is **refused with a guided message** listing what the agent *can*
answer, instead of being answered with a plausible-looking invention.

## Why it exists

Free-form NL2SQL is a demo, not a control. Two people ask "what was revenue last
quarter" and get two different numbers because the model picked two different
joins. The contract makes the answer deterministic where it matters:

- **A verified query is the same SQL every time** — an approved, owned artifact,
  not a fresh generation.
- **A metric has one definition** — with an owner, a grain, a source and the
  synonyms people actually use, so "revenue", "net sales" and "top line" all
  resolve to the same thing.
- **Refuse-not-guess is the compliance posture.** In an IL5 boundary the
  refusal path is a feature: the agent's blast radius is bounded by an artifact
  a human approved.

## How to use it end to end

1. **Open the semantic model** that your data agent grounds on and select the
   **Verified Queries** tab.
2. **Register your metrics.** For each metric give a label, an owner, a
   description, the **synonyms** analysts use for it, the **grain**, and the
   source — either a metric view or a measure, plus the reference.
   Synonyms are load-bearing: they are what makes a real question match.
3. **Add verified queries.** Each is a question-to-query pair: the natural
   question a user would ask, and the exact query that answers it correctly.
4. **Approve them.** A verified query is only retrievable once approved.
   Approval is a privileged mutation — it writes an `_auditLog` row and fans out
   to the SIEM stream, so "who blessed this number" is answerable.
5. **Ask the matched question** in the data agent's test chat. The reasoning
   loop resolves the contract before it plans, and can land in one of four
   states:

   | Decision | What happens |
   |---|---|
   | **verified** | An approved verified query matched above the match threshold. The agent runs *that* query. The answer carries the Verified badge in its [receipt](answer-receipts.md). |
   | **metric** | No verified query matched, but the question grounded on a registered metric. Generation proceeds, bounded by that metric's definition. |
   | **refuse** | Neither matched. The agent refuses with a reason, suggested in-contract questions, and the metric labels it *does* know. The receipt verdict is Refused. |
   | **none** | The tenant has adopted no contract (or the store was unreachable). The agent behaves exactly as it did pre-contract. |

6. **Check the receipt.** The decision, the matched artifact and the executed
   query all land in the [answer receipt](answer-receipts.md).

## What the backend actually does

| Control | Backend |
|---|---|
| Metric + verified-query read/write | `/api/items/semantic-model/<id>/verified-queries` to the `loom-semantic-contract` Cosmos container (PK `/tenantId`) |
| Approval | The same route, audited (`_auditLog` + `emitAuditEvent`) |
| Contract evaluation on a turn | Pure token matching in the model layer against approved verified queries first, then the metric registry |
| Metric compilation | The headless metrics layer compiles one governed definition natively to SQL or KQL for reports, the Copilot path and the SDK |

Contract evaluation is **fail-safe by design**: any error — Cosmos unreachable,
no contract adopted, a malformed document — yields `none`, so this wiring can
never break an existing agent.

## Interaction with the rest of the trust chain

The contract is the first link. On a matched-but-generated question the metric
registry is re-consulted on every
[self-healing repair attempt](self-healing-nl2sql.md), so a rewrite stays inside
the contract instead of drifting out of it. The decision feeds the
[receipt](answer-receipts.md) verdict.

## Honest gates

None. Two behaviours to know:

- **An empty contract is not a gate.** With no metrics and no approved verified
  queries the evaluator returns `none` and every agent works as before. The tab
  shows a guided empty state, not an error.
- **A refusal is not an error.** It is the intended outcome for an
  out-of-contract question, and it is rendered as guidance (here is what I *can*
  answer), never as a failure banner.

## Kill-switch

`n9-verified-queries-tab` — default ON. Flipping it OFF hides the tab body
behind a guided notice on the next load. The read/write routes and, critically,
**the data-agent contract evaluation are unaffected** — only this authoring
surface is gated. No roll required.

The headless metrics layer has its own separate switch (`n15-metrics-layer`),
which reverts report and NL metric resolution to their pre-metrics-layer direct
compile.

## Related

- [Answer receipts](answer-receipts.md) · [GraphRAG grounding](graphrag-grounding.md) · [Self-healing NL2SQL](self-healing-nl2sql.md)
- Editor guide — [Semantic model](../tutorials/editor-semantic-model.md) · [Data agent](../tutorials/editor-data-agent.md)
- [Data Agents parity](../workloads/data-agents-parity.md)
