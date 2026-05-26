# Loom Cross-Item Copilot Orchestrator — Loom-native parity spec

> Captured 2026-05-26 by maintainer (fill-in for `ad7c658a` misc-pack agent that skipped this item). No Fabric equivalent; this is Loom-native.

## Overview
The cross-item Copilot is Loom's agentic chat surface that spans multiple Loom item types in a single session. Unlike Fabric's per-item Copilot (which is scoped to a single notebook / dataflow / report), Loom's orchestrator can call tools across Lakehouse, Warehouse, Notebook, Data Pipeline, Power BI Semantic Model, KQL Database, AI Search Index, and any other registered item type within the user's session — backed by Azure OpenAI Assistants v2 or AI Foundry Agents.

No Fabric equivalent exists today. The closest analog is Microsoft 365 Copilot's connector ecosystem, but cross-item-copilot is in-tenant, identity-scoped, and grounded on Loom's Cosmos item catalog.

## UI components

### Chat surface
- Standalone full-page surface at `/copilot` and embedded pane within every editor (right-side drawer)
- Message bubbles (user / assistant) with markdown rendering, code blocks, citations
- Streaming token output
- Suggested follow-ups
- Per-message kebab menu: Copy / Cite / Regenerate / Show tool calls
- Session list (left rail): chronological sessions, rename, delete, share

### Tool call inspector
- Each assistant message that invoked tools expands into a structured trace:
  - Tool name
  - Arguments JSON
  - Result (truncated to 4KB display, full payload via "Expand")
  - Duration + cost (token + tool invocation)
- Drill into a tool call to see the underlying Loom item it touched (item id, displayName, route to its editor)

### Tool registry pane (admin)
- List of registered tools per tenant
- Per-tool: name, description, schema, allowed scopes (workspace-scoped vs tenant-scoped)
- Enable/disable toggle
- Add custom tool (HTTPS endpoint + auth mode + JSON schema)

### Grounding picker
- Before sending a message, optionally attach Loom items as grounding context
- Multi-select from a tree (workspaces → items)
- Selected items get their state JSON + access metadata passed to the assistant as system context
- Same picker reused from the Data Agent editor (where Loom items are also the grounding surface)

### Settings
- Default Assistant model (gpt-4.1 / gpt-4o / o-series via AOAI deployment ids)
- Per-session model override
- Tool execution policy (auto / ask-first / disabled)
- Max turns per session
- Session expiration TTL
- Token budget per session

## What Loom has today
- **Backend**: `/api/copilot/orchestrate` exists and is wired through to Azure OpenAI Assistants with a real tool catalog
- **Sessions**: `/api/copilot/sessions` + `/api/copilot/sessions/[id]` for Cosmos-backed session persistence
- **Tools**: `/api/copilot/tools` returns the tool registry
- **CopilotPane component** (`lib/components/copilot-pane.tsx`) renders the chat surface — currently embedded in editor chrome
- **Wiring-audit verdict**: **🟢 LOCAL-AZURE** — works with real AOAI orchestrator
- Cosmos containers: `copilotSessions`, `copilotMessages`

What's NOT yet wired:
- Tool call inspector UI (the trace exists in the API response but is just dumped as JSON)
- Tool registry admin pane
- Grounding picker (sessions today only see items the assistant proactively decides to fetch)
- Per-session model override (uses tenant default)
- Cost + token telemetry surfaced in the chat UI

## Gaps for parity (vs a polished agentic chat surface like ChatGPT / Copilot Studio)
1. **Tool call inspector** — render `tool_calls[]` from the assistant response as expandable cards with Loom-item deep-links
2. **Grounding picker** — share the Data Agent's source picker; let the user explicitly attach items as RAG context
3. **Tool registry admin UI** — surface `/api/copilot/tools` as a Fluent UI Table with enable/disable per tool; add custom-tool form
4. **Streaming** — switch from full-response polling to SSE/WebSocket so tokens stream live
5. **Citations** — when tools return Loom items, render them as bottom-of-message citation chips linking to the editor
6. **Cost meter** — running token+cost counter in the chat header, updated after each turn
7. **Session sharing** — make sessions shareable via signed URL (read-only or read+continue)
8. **Per-session model override** — let user choose model in the chat header
9. **Tool result formatting** — table/code/chart rendering inline rather than raw JSON
10. **Multi-turn tool plans** — let the assistant write a plan, confirm with the user, then execute (Plan-Execute-Reflect)

## Backend mapping
- AOAI Assistants v2 API (or AI Foundry Agents — pivot recommended for v3.30+)
- Tool implementations live in `lib/copilot/tools/*.ts` — each tool wraps a Loom REST endpoint and exposes a JSON schema
- Session persistence in Cosmos containers `copilotSessions` (partition key `tenantId`) and `copilotMessages` (partition key `sessionId`)
- Citation generation: when a tool returns a Loom item id, the orchestrator backfills `displayName` + route + tenant-aware permissions check

## Required Azure resources
- AOAI account with Assistants v2 access (or AI Foundry project with Agents enabled)
- Cosmos containers (auto-created via `createIfNotExists` in `lib/azure/cosmos-client.ts`)
- Application Insights for tracing tool calls (optional but recommended)

## Estimated effort
**5-7 sessions** to bring all 10 gaps to A+:
- Session 1: Tool call inspector + citations
- Session 2: Grounding picker (re-use Data Agent source picker)
- Session 3: Tool registry admin UI + custom-tool form
- Session 4: SSE streaming for token-level updates
- Session 5: Cost meter + per-session model override
- Session 6: Multi-turn Plan-Execute-Reflect
- Session 7: Vitest + Playwright coverage + bicep sync (A+ grade gate per `no-vaporware.md`)

## Notes
- Cross-item-copilot is THE differentiating Loom feature vs Fabric — Fabric's Copilot is per-item-locked; Loom's spans the whole workspace via tools
- The tool registry is the leverage point: every wave-2/3/4 editor that lands a `/api/items/<type>/.../run` endpoint can be auto-registered as a tool with minimal additional work
- See `lib/copilot/tool-registry.ts` for the current 12-tool baseline (lakehouse-query, warehouse-query, notebook-run, kql-query, semantic-model-query, ai-search-search, items-search, items-list, workspaces-list, copilot-list, copilot-create, copilot-update)
