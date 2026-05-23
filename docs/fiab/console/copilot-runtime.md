# Loom Copilot runtime

The Loom Copilot is the chat assistant that appears throughout the
Loom Console as a right-side sidebar drawer (or full-screen chat at
`/copilot`). Same agent infrastructure as the Loom Setup Wizard and
Loom Data Agents — different system prompts and tool catalogs per
context.

## What it does

The Copilot serves multiple personas via system-prompt selection:

| Context | Persona | Tool catalog |
|---|---|---|
| Setup Wizard (`/setup`) | "loom-deploy-agent" | render_bicepparam, submit_deployment, poll_deployment, MCP tools |
| Console sidebar (every pane) | "loom-copilot" | NL2SQL, NL2DAX, NL2KQL, doc-search, workspace-search, capacity-check |
| Notebook embed | "notebook-copilot" | `/explain`, `/fix`, `/comments`, `/optimize` |
| Warehouse pane | "warehouse-copilot" | NL2SQL, EXPLAIN, optimize-query |
| Semantic Model pane (v1.1) | "dax-copilot" | NL2DAX, DAX-explain, optimize-DAX |
| KQL pane | "kql-copilot" | NL2KQL, KQL-explain |
| Activator pane | "activator-copilot" | rule-author, threshold-suggest |
| Data Agents pane | "agent-config-copilot" | example-query-generate, field-description-generate |
| Admin pane (v1.1) | "ops-copilot" | capacity-scale, OAP-toggle, workspace-create |

## Tech stack

Per [PRP-09 Data Agents](../workloads/data-agents-parity.md): reuses
the existing csa-inabox copilot scaffold.

- **Agent framework**: PydanticAI (existing `apps/copilot/`)
- **Inference**: Azure OpenAI per boundary
- **Chat backend**: extended `azure-functions/copilot-chat/function_app.py`
  with `/api/loom-chat` and per-context endpoints
- **Identity**: OBO throughout (per [AMENDMENTS A15](https://github.com/fgarofalo56/csa-inabox/blob/csa-loom-pillar/temp/fiab-prd/AMENDMENTS.md))
- **Security**: rate limiting, PII redaction, content safety,
  telemetry, feedback loops — all inherited from existing
  copilot-chat infrastructure

## Capacity isolation

| Boundary | AOAI deployment |
|---|---|
| Commercial / GCC | Dedicated "Loom Copilot Capacity" per organization |
| GCC-High / IL4 / IL5 | Per-DLZ AOAI deployment (tighter Gov TPM quotas) |

## Telemetry + feedback

Reuses the existing feedback + backlog mechanism from
`azure-functions/copilot-chat/function_app.py`:

- Per-turn telemetry (input length, output length, model invoked,
  PII detection results, off-topic / refusal detection, session ID,
  conversation ID)
- 👍 / 👎 feedback per response
- Thumbs-down opens improvement-text modal → persisted to backlog
- Uncovered-question detection (off-topic OR zero grounding hits) →
  auto-files to backlog as `kind=uncovered`

In Gov, telemetry feeds the [Sentinel pipeline](../compliance/defender-ai-workaround.md)
that replaces Defender for Cloud AI Threat Protection.

## Sidebar UX

The Copilot drawer appears on every Console pane (right-side, collapsible).
Default closed; user-toggleable. Per-pane context is automatically
loaded into the system prompt (e.g., on Warehouse pane, the active
query + table schema are included as context).

## Full-screen chat

`/copilot` route opens the Copilot in full-screen mode for extended
conversations. Same tool catalog as the active workspace context (or
admin context if accessed from Admin).

## Related

- ADR: [fiab-0009 Copilot orchestration](../adr/0009-copilot-orchestration.md)
- Build PRP: PRP-09 (Data Agents extension), PRP-03 (Console UI)
- Workload: [Data Agents parity](../workloads/data-agents-parity.md), [Copilot parity](../workloads/copilot-parity.md)
- Memory: [[copilot-chat-two-backends]]
