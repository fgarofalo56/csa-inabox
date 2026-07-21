# agent-flow — parity with the Azure AI Foundry visual agent builder

**Source UI:** Azure AI Foundry — Agents (agent designer) + Connected Agents + the
Agent Service tool catalog (MCP / OpenAPI / function / file-search / code
interpreter), plus Foundry evaluations/guardrails.
Learn: https://learn.microsoft.com/azure/ai-foundry/agents/concepts/connected-agents ·
https://learn.microsoft.com/azure/ai-foundry/agents/how-to/tools/model-context-protocol ·
https://learn.microsoft.com/azure/ai-foundry/how-to/develop/evaluate-sdk

WS-5.1 elevates the AgentFlowCanvas to a full visual agent-builder: drag
**agents + tools + MCP servers + ontology objects** onto a canvas, wire
**handoffs**, set **guardrails/evals inline**, **run end-to-end**, and **publish
as MCP/API**. Azure-native + sovereign — no Microsoft Fabric on the default path
(`no-fabric-dependency.md`).

## Foundry / Azure feature inventory → Loom coverage

| Capability (Foundry/Azure) | Loom coverage | Backend per control |
|---|---|---|
| Canvas of agent + tool nodes | ✅ React-Flow + `canvas-node-kit` (≤190px, 2-row, one badge, typed ports) | client |
| **Agent** node (orchestrator) | ✅ orchestrator node + inline guardrails inspector | — |
| **Tool** nodes — warehouse / lakehouse / KQL / AI Search / knowledge base | ✅ typed tool nodes, grounded sources | Synapse SQL / ADX / AI Search |
| **MCP-server** node | ✅ MCP tool node (typed picker + allow-list) | `mcp-client` (Streamable-HTTP JSON-RPC) — **real `tools/call`** |
| **Ontology-object** node (typed instances) | ✅ WS-6 `ontology-object` tool → grounded `ontology` source | `ontology-resolver` (Synapse/ADX/AAS/AGE) |
| OpenAPI / function / code-interpreter tools | ✅ typed tool nodes | Foundry tool JSON on publish |
| **Handoffs** (agent → agent) | ✅ connected sub-agent nodes; edges rendered as animated **handoff** edges | `agent-orchestrator` (Azure-native `orchestrate`) |
| **Run end-to-end** | ✅ run pane → `runAgentFlowTurn` (grounded data + ontology + real MCP tool + handoff + guardrails) | AOAI `chatGrounded` / `orchestrate` |
| **Guardrails** — PII / blocked terms / grounding requirement / length cap | ✅ inline per-flow config, enforced every run (input + output) | `agent-flow-guardrails` (deterministic) |
| **Evals** — groundedness / relevance / coherence / fluency / safety | ✅ selectable eval suites recorded per run | recorded on run receipt |
| **Publish as MCP** | ✅ Publish tab → `ask_<flow>` MCP server, ready-to-paste client config | `/api/items/agent-flow/[id]/publish-mcp` + `/mcp` |
| **Publish as API** | ✅ the MCP endpoint IS a JSON-RPC-over-HTTPS API (token-auth) | same route |
| Run history | ✅ Runs tab (grounded / tools / sub-agents / tokens / status) | `state.runs[]` |
| Undo/redo, copy/paste, align, palette, zoom rail, minimap | ✅ Wave-2 canvas standards (`useCanvasHistory`, `CanvasRightRail`) | client |
| Resizable canvas (G3) | ✅ `ResizableCanvasRegion` (persisted `sizingKey`) | client |
| Draft / save before publish | ✅ save-gated publish; unsaved-changes MessageBar | — |

Zero ❌. The MCP-server node and its `tools/call` reach a **registered / enabled**
Azure-hosted MCP server; an unregistered / unconsented server is an honest gate
(names the exact Admin action), never a call to an unwired host.

## Honest gates (config-only, per `no-vaporware.md`)
- No AOAI deployment → 503 + "deploy gpt-4o-mini / set LOOM_AOAI_ENDPOINT + LOOM_AOAI_DEPLOYMENT".
- MCP node bound to a server not enabled for the tenant → "Register/enable it in Admin → MCP servers".
- entra-obo MCP server not consented → "sign in again and consent its scopes".
- Ontology-object with no bound source → WS-6 resolver gate (bind a lakehouse/KQL/semantic to the object type).

## Verification
- `npx tsc -p tsconfig.build.json --noEmit` — clean.
- `npx vitest run` — `agent-flow-guardrails` (15), `agent-flow-mcp` (6),
  `agent-flow-run` (7, incl. ontology-object grounding), `agent-tool-catalog`
  (20, incl. ontology-object), `agent-flow-layout` (9) — green.
- **Owed: browser-E2E receipt (Track-0)** — build a 3-agent flow with an MCP tool
  + an ontology-object tool + a handoff, run it end-to-end, publish as MCP, call
  `ask_<flow>` from an MCP client.
