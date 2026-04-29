---
status: accepted
date: 2026-04-26
deciders: csa-inabox platform team
consulted: copilot agent owners, docs site maintainers
informed: ops, contributors
---

# ADR 0022 — Copilot artifacts are surfaces of one agent plus an unrelated docs widget

## Context

The deep code review observed three "Copilot implementations" in the
repo and recommended collapsing them into one:

1. `apps/copilot/` — the Phase-1 grounded developer agent
2. `azure-functions/copilot-chat/` — an Azure Function
3. (the third entry in the review turned out to be the same `apps/copilot/`
   counted twice via its `surfaces/` subdirectories)

After reading the code: there are not three duplicate agents. There is
one agent with multiple deployment surfaces, and there is a separate
docs-site chat widget that happens to share the noun "copilot".

## Decision

**Keep the existing layout. Do not collapse.**

### What `apps/copilot/` actually is

`apps/copilot/` is **one agent** (`CopilotAgent`) with deterministic
retrieval + grounding-check + citation-verify in Python and PydanticAI
delegated only for the natural-language generation step.

The agent is exposed via three **surfaces** under `apps/copilot/surfaces/`:

| Surface                | Purpose                                                                | Imports the agent? |
| ---------------------- | ---------------------------------------------------------------------- | ------------------ |
| `surfaces/api/`        | Mountable FastAPI router (`POST /ask`, `POST /chat`, `POST /broker/*`) | Yes                |
| `surfaces/cli_daemon/` | Long-running CLI daemon for local interactive use                      | Yes                |
| `surfaces/mcp/`        | Model Context Protocol server for IDE/host integration                 | Yes                |

Plus shared infrastructure they all depend on:

- `agent.py` + `agent_loop.py` — the agent itself
- `broker/` — the confirmation broker (CSA-0102) that gates execute-class tools
- `evals/` — evaluation harness
- `tools/`, `skills/`, `prompts/` — capability registries
- `grounding.py`, `indexer.py`, `conversation.py`, `models.py` — agent internals

This is the **surface pattern**: one core agent, multiple integration
endpoints. Collapsing the surfaces would force every deployment to
ship the FastAPI stack even when the consumer is an MCP host.

### What `azure-functions/copilot-chat/` actually is

`azure-functions/copilot-chat/function_app.py` is a **single-file (555
LoC) Azure Function** that powers the chat widget on the public docs
site (`mkdocs` build). It:

- accepts `{message, history[], pageContext}` from the docs widget
- talks **directly** to Azure OpenAI (no agent, no retrieval, no
  grounding check, no broker)
- enforces docs-widget-specific guardrails: origin allowlist,
  prompt-injection regex, per-IP + global daily token caps,
  history sanitization
- has zero shared imports with `apps/copilot/`

This is a different product with a different audience, different threat
model, and different SLO. Collapsing it into the developer agent would
make the docs widget pull in PydanticAI, the broker, the index, and
~50 transitive dependencies it does not need — and it would couple the
public-internet attack surface to the privileged developer agent.

## Consequences

### Why the review's "collapse to one" recommendation was wrong

1. **Different audiences.** Developer agent serves authenticated
   engineers. Docs widget serves anonymous public traffic.

2. **Different threat models.** The broker assumes a trusted caller
   identity to issue scoped tokens. The docs widget cannot trust its
   caller and so sanitizes aggressively at the edge.

3. **Different deployment topology.** Developer agent runs as a
   long-lived service (FastAPI / daemon / MCP). Docs widget runs as
   a stateless Azure Function with a daily cost cap.

4. **Different change cadence.** Agent evolves with platform
   capabilities; widget evolves with docs UX. Coupled releases would
   block both.

### Real cleanup that _would_ be welcome (deferred)

- Rename `azure-functions/copilot-chat/` to `azure-functions/docs-chat-widget/`
  to remove the `copilot` collision. Deferred — would invalidate
  existing deployment automation outside this repo.
- Extract the docs-widget guardrail regexes into a tiny shared package
  if a second public-internet entrypoint ever needs them. Deferred —
  YAGNI until that second entrypoint exists.

## Alternatives considered

- **Move `azure-functions/copilot-chat/` under `apps/copilot/surfaces/docs_widget/`.**
  Rejected — the surfaces dir is for surfaces of the _agent_; the docs
  widget is not an agent surface.
- **Move `apps/copilot/surfaces/` up to siblings of `apps/copilot/`.**
  Rejected — they share `models.py`, `prompts/`, `grounding.py`, and
  `broker/`. Splitting them creates cross-package imports for no gain.

## Status

Accepted. No code change. This ADR exists to close a recurring
review-loop question and to make the surface vs widget distinction
explicit for new contributors.
