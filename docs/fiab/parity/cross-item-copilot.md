# cross-item-copilot — parity with Fabric Copilot / Foundry data agent (cross-workspace assistant)

Source UI: Loom-native — closest analogues are **Fabric Copilot** (the
workspace-wide chat that reasons across items) and the **Foundry / Fabric data
agent** chat surface. There is no single Azure portal screen; this is Loom's
natural-language orchestrator across every wired Loom service. It renders in two
places from one component: the full-screen `/copilot` page and the embedded
`/items/cross-item-copilot/<id>` editor.

Azure-native backend (no Fabric): sessions + transcripts in **Cosmos**;
generation via **Azure OpenAI**; tools call the real Loom BFF routes for Synapse,
Lakehouse/ADLS, Databricks, APIM, ADX, ADF, Foundry, etc. (25+ tools). Power BI
authoring skills are exposed via an **opt-in** remote Power BI MCP server — the
only Fabric-family surface, and it is gated behind admin config, never the
default path.

## Capability inventory (cross-workspace Copilot / data agent)

1. **Session management** — list, search, group by recency, rename, pin,
   duplicate, delete; active-session state; empty state.
2. **Transcript** — user/assistant bubbles, avatars, markdown + syntax-
   highlighted code, tool-call + run-receipt rendering, citations, copy /
   regenerate / feedback.
3. **Composer** — multi-line prompt, send, streaming responses.
4. **Tools / skills panel** — self-describing available tools + active persona.
5. **Streaming orchestration** across many backend services (SSE).
6. **Grounding / citations** back to the items the answer used.

## Loom coverage

| Capability | Loom coverage | Backend (real REST) |
| --- | --- | --- |
| **Session list** — search, recency grouping, active state, empty state | ✅ built — `SessionList` | `GET /api/copilot/sessions` |
| Session **rename / pin / duplicate / delete** | ✅ built — per-session actions (rename/pin → PATCH; delete → DELETE; duplicate → new session) | `PATCH/DELETE /api/copilot/sessions/[id]` |
| **Transcript** — bubbles, avatars, markdown, code highlight, tool-calls, run-receipts, citations | ✅ built — `Transcript` (`groupTurns`) | `GET /api/copilot/sessions/[id]` |
| Message **copy / regenerate / feedback** | ✅ built — transcript controls | session routes |
| **Composer** + streaming send | ✅ built — pinned composer; only transcript scrolls | `POST /api/copilot/orchestrate` (SSE) |
| **Tools panel** — available tools + active persona | ✅ built — `ToolsPanel` | `GET /api/copilot/tools` |
| Status / readiness probe | ✅ built | `GET /api/copilot/status` |
| **25+ cross-service tools** (Synapse, Lakehouse, Databricks, APIM, ADX, ADF, Foundry, …) | ✅ built — orchestrator tool-calls hit each service's real BFF route | per-service Loom routes |
| Power BI authoring skills (agentic) | ⚠️ honest-gate — opt-in remote **Power BI MCP** server; surfaced only when configured (`POWERBI_MCP_CLIENT_ID_ENV` / tenant setting); admin config panel names the remediation | `GET /api/admin/mcp-servers/powerbi` |
| AOAI / Cosmos not configured | ⚠️ honest-gate — orchestrate/status return honest errors; MessageBar names the missing backend | n/a |

Zero ❌. Every control wires to a real Cosmos/AOAI-backed BFF route — no mocks,
no dead buttons (per `no-vaporware.md`). The one Fabric-family capability (Power
BI skills) is strictly opt-in and admin-gated, satisfying
`no-fabric-dependency.md`.

## Backend per control

- Status: `GET /api/copilot/status`.
- Sessions: `GET /api/copilot/sessions`; `GET /api/copilot/sessions/[id]` (load), `PATCH` (rename / pin), `DELETE` (delete); duplicate creates a new session.
- Tools: `GET /api/copilot/tools`.
- Generation: `POST /api/copilot/orchestrate` (SSE stream; tool-calls fan out to real Loom service routes).
- Power BI MCP (opt-in): `GET /api/admin/mcp-servers/powerbi` + `POWERBI_AUTHORING_SKILLS`.
