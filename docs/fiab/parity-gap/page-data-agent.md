# Parity gap — `/data-agent`

**Loom route:** `/data-agent` (rendered by `apps/fiab-console/app/data-agent/page.tsx` → `DataAgentPane`)
**Fabric reference:** Microsoft Fabric Data Agents — https://learn.microsoft.com/fabric/data-science/concept-data-agent
**Loom screenshot:** `temp/parity/page-data-agent-loom.png`
**Captured:** 2026-05-26

## Phase 3 — Side-by-side gap matrix

| # | Fabric Data Agents element | Loom Data agent element | Status | Severity |
|---|---|---|---|---|
| 1 | Page header "Data agent" with subtitle | Present — subtitle explicitly labels "Legacy stub — Phase 4 ships the Fabric-parity editor" | present + honest disclosure | — |
| 2 | List of data agents in tenant | Single hard-coded "Finance Analyst Agent" | partial | MAJOR |
| 3 | "+ New data agent" action | Not visible at this route (Loom uses generic NewItemDialog elsewhere; data-agent is treated as legacy here) | missing | MAJOR |
| 4 | Conversational chat UI with message bubbles | Present — full chat UI with user/assistant avatars, message bubbles, citations support, Send button | present | — |
| 5 | Citation rendering (SQL/DAX/KQL snippets) | Component has `citations` rendering with kind: 'sql' / 'dax' / 'kql' / 'doc' (verified in code) | present | — |
| 6 | "Sources" / data binding panel showing which lakehouses/warehouses/models the agent is grounded in | Not present in legacy stub | missing | MAJOR |
| 7 | Agent prompt / persona configuration | Not present in legacy stub | missing | MAJOR |
| 8 | Query under user's Entra identity (RLS/CLS applies) | Subtitle text claims this — actual backend is a stub that doesn't execute queries | claim without implementation | MAJOR |
| 9 | NL2SQL / NL2DAX / NL2KQL execution | Backend (`/api/data-agent/chat`) returns honest "Data Agent is online but not yet wired to the orchestrator in this deploy" | stub but honest | — |
| 10 | Test run / sample-questions surface | Not present | missing | MINOR |

## Phase 4 — Functional verification

| Control | Source | Result |
|---|---|---|
| Send button + input | Wires to `/api/data-agent/chat` POST | OK technically |
| Backend route | `apps/fiab-console/app/api/data-agent/chat/route.ts` returns `"Data Agent is online but not yet wired to the orchestrator in this deploy. You said: <user input>"` | Honest stub — no fake LLM responses |
| Citation rendering | Code-wise supports `sql/dax/kql/doc` kinds, but the stub never returns citations | n/a in current deploy |

## Critical observation

The page is **flagged in its own subtitle** as "Legacy stub — Phase 4 ships the Fabric-parity editor." This is honest disclosure per `no-vaporware.md`. The backend stub returns an honest "not yet wired" message rather than fake LLM output.

There IS a separate parity work in flight: `docs/fiab/data-agent-parity-spec.md` exists, and the project includes `lib/editors/data-agent-editor.tsx` (per the file listing). This `/data-agent` page is the *old* surface; the new surface is per-item editor at `/items/data-agent/[id]`.

## Honest grade

**Grade: C** (honest stub)

Reasoning:
- Per `no-vaporware.md`'s "Honest config-only state" exemption: this page clearly labels itself as "Legacy stub" and the backend returns an honest "not yet wired" message. That's a B-track behavior.
- BUT it doesn't render any honest MessageBar with the bicep module / env var that would be required to wire the agent backend.
- And the chat UI looks like it works — user types, message appears, "response" comes back with text — which a casual viewer would mistake for a working agent.

Not B because there's no honest MessageBar saying "LOOM_FOUNDRY_PROJECT_ENDPOINT not set; chat will not query real data." Not D because the page is labeled "Legacy stub" and the backend doesn't fake LLM output.

## Recommended next actions

1. Replace legacy stub with the new per-item Data Agent editor (`/items/data-agent/[id]`) and redirect `/data-agent` → `/items/data-agent` list view.
2. Add an honest MessageBar at the top of the chat saying "Data Agent backend not wired in this deploy. Set `LOOM_FOUNDRY_PROJECT_ENDPOINT` and grant the Loom SP `Cognitive Services User` on the AI Foundry project. See `docs/fiab/data-agent-parity-spec.md`."
3. Disable the Send button (or show a tooltip) until the backend is configured.
4. Add `+ New data agent` button that opens the Fabric-style item dialog filtered to data-agent type.
5. Move the chat UI inside the per-item editor instead of as a top-level route.
