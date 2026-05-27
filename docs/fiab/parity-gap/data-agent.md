# data-agent — parity gap (validator v2, 2026-05-26)

**Loom URL**: `/items/data-agent/new`
**Fabric reference**: Fabric IQ — Data Agents (typed 5-source picker · per-source instructions · test chat · Publish · Copilot Studio handoff)
**Loom screenshot**: `temp/parity/data-agent-loom.png`

## Phase 4

| Route | Status | Notes |
|---|---|---|
| `GET /api/items/data-agent/new` | 404 (Cosmos "Item not found" — same /new pattern issue) | — |
| `POST /api/items/data-agent/<id>` | wired (PATCH state) | — |
| `POST /api/items/data-agent/<id>/deploy` | wired (Foundry Agent Service stub) | — |

Editor renders the same honest warning MessageBar as operations-agent: "Phase 1: Foundry Agent deploy stub — Data-agent config persists to Cosmos and the Deploy to Foundry button pushes a prompt-agent definition to the Azure AI Foundry Agent Service. The typed five-source picker, per-source instructions, test chat pane, Publish flow, and Copilot Studio handoff are tracked in `docs/fiab/data-agent-parity-spec.md` for follow-up sessions."

Form: System prompt / AI instructions · Model · Sources (free text) · Synapse Serverless SQL endpoints · KQL databases · Lakehouse paths · Example queries. Save + Deploy to Foundry buttons.

## Phase 3 — Fabric vs Loom

| Fabric IQ Data Agent element | Loom present? | Severity |
|---|---|---|
| System prompt + model | YES | — |
| **Typed 5-source picker** (Warehouse · Lakehouse · Semantic model · KQL · Ontology — with live list per type) | NO — 4 free-text textareas | MAJOR (DEFERRED per MessageBar) |
| **Per-source instructions** (one prompt per source) | NO — single global system prompt | MAJOR (DEFERRED) |
| **Test chat pane** (chat with agent while authoring, see SQL/KQL it generates) | NO | BLOCKER (DEFERRED) |
| **Publish flow** (move from authoring to published; version snapshot) | NO | MAJOR (DEFERRED) |
| **Copilot Studio handoff** (publish to Copilot Studio + Teams as a packaged copilot) | NO | MAJOR (DEFERRED) |
| Example queries textarea | YES | — |
| Honest warning MessageBar | YES | — |
| Deploy to Foundry button with 3-state result | YES | — |

## Functional

- Save persists state to Cosmos
- Deploy fires Foundry Agent Service stub
- 4 free-text inputs for source bindings (no list dropdowns)
- /new is "Item not found" because of route shape

## Grade — **C+**

Same as operations-agent — honest about being a Phase-1 stub with explicit MessageBar pointing to `docs/fiab/data-agent-parity-spec.md`. Per `no-vaporware.md` rule, this passes the "honest config-only state" allowance. **Grade C+** because the deferred features are real Fabric features that an operator needs, but they're honestly flagged as not-yet-built.
