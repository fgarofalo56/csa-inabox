<!-- parity-doc-meta
Reviewed-on: 2026-07-20
Validated-against:
  - apps/fiab-console/lib/editors/phase4/operations-agent-editor.tsx
  - apps/fiab-console/app/api/items/operations-agent/[id]/rules/route.ts
  - apps/fiab-console/app/api/items/operations-agent/[id]/run/route.ts
  - apps/fiab-console/app/api/items/operations-agent/[id]/deploy/route.ts
-->

# operations-agent — parity with Fabric IQ Operations Agent

> **RE-BASELINED 2026-07-20** (rev `9ad350d3`, code-path refresh). The 2026-05-26
> capture retained below graded this **C+** ("free-text tools", "deferred playbook",
> "deploy stub only") and is **stale**: the editor now has typed pickers, a real
> rules engine, and a run/test path on real backends. A live click-walk
> re-certification is still owed before a fresh grade.

## Current state (code-grounded, 2026-07-20)

`lib/editors/phase4/operations-agent-editor.tsx` (~955 LOC) replaced the free-text
form with **`Dropdown` pickers** (tools, Eventhouse binding, model, etc.,
`:674–:714`) and Teams-notification fields. Two new real backend routes exist
beyond `/deploy`:

- **`…/rules`** — triggers = time/data-change actions on the **Azure-native**
  default: each is a real `Microsoft.Insights/scheduledQueryRule` (+ action group)
  over Log Analytics, or a KQL rule the **"Trigger now"** path runs against the
  agent's ADX Eventhouse. Carries `evaluationFrequency` / `windowSize` (the polling
  cadence the old doc listed as MISSING). Reuses the shared activator-monitor client.
- **`…/run`** — run/test the agent: the published **Azure AI Foundry** agent
  (thread → message → run → poll) with real per-tool run STEPS when deployed, else
  an Azure-native grounded turn (no Fabric dependency).

Corrections to the 2026-05-26 matrix:

| 2026-05-26 claim | Current reality |
|---|---|
| Tools = free-text comma list (MAJOR) | **`Dropdown` pickers** for tools/bindings. |
| Eventhouse binding = free text (MAJOR) | **Eventhouse binding picker** present. |
| 5-minute polling cadence config (DEFERRED) | Rules carry `evaluationFrequency` / `windowSize` via `scheduledQueryRule`. |
| Activator handshake (DEFERRED) | Real `scheduledQueryRule` + action-group rules engine (`…/rules`). |
| Test agent on historical event (MAJOR) | **"Trigger now"** evaluates the rule's KQL against ADX; `…/run` tests the agent. |
| Deploy = Foundry stub only | `…/run` runs the **published Foundry agent** with per-tool STEPS, or Azure-native fallback. |

**Remaining residuals to confirm live:** natural-language **playbook generator**
(auto-build rule + flow from a description) and **Power Automate** flow handshake +
Teams routing depth were not fully verified in this code-path pass — confirm against
the editor before claiming complete.

---

<details>
<summary>Historical capture — 2026-05-26 (superseded, kept for provenance)</summary>

Do NOT cite the "free-text"/"deferred"/"C+" claims below as current — see the
corrections above.

**Fabric reference**: Fabric IQ — Operations Agent (Activator + Power Automate orchestration; playbook generator; 5-minute polling; Teams notifications)

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

</details>
