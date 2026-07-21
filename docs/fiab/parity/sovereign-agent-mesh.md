# sovereign-agent-mesh — WS-9 parity: Sovereign Agent Mesh + MCP/A2A hub (BTB-4 / BTB-9)

Source UI: no direct 1:1 Fabric/Azure analog — a burn-the-box surface. Grounded in
the Foundry Agent Service *connected agents* + A2A interop patterns
(https://learn.microsoft.com/azure/ai-foundry/agents/how-to/connected-agents) and
the Agent-to-Agent (A2A) agent-card schema. The bar it must meet/exceed is the
Foundry connected-agents experience — but 100% Azure-native + in-VNet, no Fabric.

Reviewed-on: 2026-07-20

## Capability inventory (governed multi-agent mesh)

| Capability | Loom coverage | Backend per control |
|---|---|---|
| Register named agents (governance / pipeline / BI / orchestrator / custom) | ✅ built | `POST /api/mesh/agents` → Cosmos `agent-registry` (PK /tenantId) |
| Built-in day-one mesh (opt-out, seeded on first read) | ✅ built | `listMeshAgents` seeds `builtinMeshAgents` (governance+pipeline+BI+orchestrator) |
| Per-agent native tool scope (least privilege) | ✅ built | `MeshAgentDef.toolScope`; enforced in `scopedToolCalls` |
| Per-agent MCP tool scoping | ✅ built | `scopeMcpServersForAgent` intersects the tenant MCP registry with the agent grant |
| Policy check on EVERY inter-agent call | ✅ built | `meshInterAgentPolicy` (structural) + `authorize()` PDP (`LOOM_PDP_ENFORCE` shadow/enforce, fail-closed) |
| Audit of every hop | ✅ built | `MeshDeps.audit` → `_auditLog` container (`kind:'mesh.hop'`) |
| Mesh orchestration (lead delegates → members → synthesize) | ✅ built | `runMeshTask` + real `chatGrounded` runs (`executeMeshTask`) |
| Tier-0 air-gap-safe tool catalog | ✅ built | `tier0ToolCatalog` — native in-VNet kinds + `airGapSafeServers()` from the vetted MCP catalog |
| Egress fail-closed on air-gap (nothing leaves the boundary) | ✅ built | `classifyMeshEgress` — air-gap denies ALL external hosts unless allow-listed (`LOOM_A2A_EGRESS_ALLOW`) |
| Gov AOAI direct (`*.openai.azure.us`) | ✅ built | `chatGrounded` → copilot-orchestrator resolver (gov host), surfaced via `/api/mesh/catalog` |
| A2A hub — publish OUT (agent cards) | ✅ built | `GET /api/mesh/a2a/[id]/card` → `buildA2AAgentCard` (publishA2A-gated) |
| A2A hub — external agents delegate IN | ✅ built | `POST /api/mesh/a2a/delegate` — publishA2A boundary gate → governed mesh run |
| No boundary downgrade (air-gap → commercial refused) | ✅ built | `meshInterAgentPolicy` profile-rank rule |
| Resizable registry / run layout | ✅ built | `SplitPane` (`sizingKey="mesh-registry-run"`) |
| Structured registration (no free-form JSON) | ✅ built | `RegisterAgentDialog` — name/kind/profile/switch/checkbox controls |
| Loom design tokens + clean states | ✅ built | `lib/mesh/agent-mesh-console.tsx` (tokens, EmptyState, badges w/ `flexWrap`) |

Zero ❌. The only non-functional states are honest gates: a missing AOAI deployment
returns a 503 with the exact remediation, and an air-gap agent with a non-air-gap-safe
MCP grant surfaces a per-server blocked-by-profile gate (never a silent drop).

## Acceptance (WS-9)

Governance + pipeline + BI agents complete a task entirely in-VNet, with every
inter-agent hop policy-checked + audited and egress fail-closed on an air-gap Gov
profile — nothing leaves the boundary. Proven by unit tests (`agent-mesh.test.ts`,
`agent-registry.test.ts`): a 3-agent task completes, an unauthorized hop is blocked
(the member never runs), and an air-gap agent's external tool call is refused.

## Owed (Track-0)

Browser-E2E receipt against a live deployment: the 3-agent mesh completes in-VNet,
the run pane shows each policy decision + egress-blocked tool call, and the egress
allow-list is empty (fail-closed). Requires a deployed AOAI model in the target env.
