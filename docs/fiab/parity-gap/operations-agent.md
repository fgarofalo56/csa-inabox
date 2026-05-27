# operations-agent — parity gap (validator v2, 2026-05-26)

**Loom URL**: `/items/operations-agent/new`
**Fabric reference**: Fabric IQ — Operations Agent (Activator + Power Automate orchestration; playbook generator; 5-minute polling; Teams notifications)
**Loom screenshot**: `temp/parity/operations-agent-loom.png`

## Phase 4

| Route | Status | Notes |
|---|---|---|
| `GET /api/items/operations-agent/new` | (returns 404 via the generic `/api/items/<slug>/<id>` shape because /new isn't a real Cosmos doc; editor shows "Item not found" inline) | — |
| `POST /api/items/operations-agent/<id>` | wired (PATCH state) | — |
| `POST /api/items/operations-agent/<id>/deploy` | wired (Foundry Agent Service stub) | — |

Editor renders an honest **MessageBar (warning)**: "Phase 1: Foundry Agent deploy stub — Agent config persists to Cosmos and the Deploy to Foundry button pushes a prompt-agent definition (instructions + model + tools) to the Azure AI Foundry Agent Service. Playbook generation, 5-minute polling, Activator + Power Automate handshake, and Teams notifications are tracked in `docs/fiab/operations-agent-parity-spec.md` for follow-up sessions."

Form fields: System prompt · Model · Tools (comma) · Eventhouse binding · Ontology binding. Save + Deploy to Foundry buttons.

## Phase 3 — Fabric vs Loom

| Fabric IQ element | Loom present? | Severity |
|---|---|---|
| System prompt + model | YES | — |
| **Tools picker** (eventhouse-query / activator-trigger as typed dropdowns with auto-discovery from workspace items) | NO — free text comma list | MAJOR |
| **Eventhouse binding picker** (live list of eventhouses) | NO — free text | MAJOR |
| **Playbook generator** (auto-generate Activator rule + Power Automate flow from natural-language description) | NO — "tracked for follow-up sessions" | DEFERRED + honest MessageBar |
| **5-minute polling cadence config** | NO | DEFERRED |
| **Activator + Power Automate handshake preview** | NO | DEFERRED |
| **Teams notification routing** | NO | DEFERRED |
| **Test agent on historical event** | NO | MAJOR |
| Honest warning MessageBar explaining what's stubbed | **YES** | — |
| Deploy to Foundry button surfaces success/deferred MessageBar | YES (3-state result MessageBar) | — |

## Functional

- Save persists state to Cosmos (verified)
- Deploy button pushes to Foundry Agent Service (deferred path with honest "Foundry not configured" warning)
- Item-not-found inline message because /new is the wrong route shape for a Cosmos-backed agent

## Grade — **C+**

Most honest editor of the AI/ML batch. **Phase-1 stub is explicitly labeled in a warning MessageBar** with the exact deferred features and the spec doc path. Save + Deploy actions are real (where backends exist). Minus the typed tool/eventhouse pickers and the playbook generator, but those are honestly deferred. **Grade C+** by honesty — would be B once tool pickers wire and Foundry deploy is live.
