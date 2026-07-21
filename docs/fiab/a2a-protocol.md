# A2A protocol support (WS-5.2)

CSA Loom speaks the **Agent2Agent (A2A) protocol** — the sibling of MCP. Where
MCP publishes a Loom agent as a callable *tool*, A2A publishes Loom's governed
surfaces as delegable *agents/tasks* that external agents (Google ADK, Azure AI
Foundry Agent Service, any A2A client) discover via an **Agent Card** and drive
with JSON-RPC **task delegation**.

Azure-native and sovereign — no Microsoft Fabric / Power BI dependency. This is
the P1-6 foundation for **BTB-9 / WS-9 Sovereign Agent Mesh**.

## Inbound — external agent delegates a task INTO Loom

### Discovery (agent card)
- `GET /.well-known/agent-card.json` (current spec) and `GET /.well-known/agent.json`
  (legacy) — the **platform agent card**. Also `GET /api/a2a`.
- Declares Loom's delegable **skills** and the JSON-RPC endpoint (`/api/a2a`).
- Secured with an HTTP Bearer scheme: a scoped `loom_pat_…` token or a Console
  session cookie.

### Platform skills (each = a real, governed Loom backend)
| Skill id | Backend | Delegated params (a DataPart) |
|---|---|---|
| `query-data-agent` | a published data agent's grounded chat (`chatGrounded`) | `{ agentId }` + a text question |
| `run-agent-flow` | a published agent flow (`runAgentFlowTurn`) | `{ flowId }` + a text request |
| `query-ontology-object` | WS-6 ontology object instances (OSDK read, `weave listObjects`) | `{ ontologyId, objectType, top }` |
| `run-ontology-action` | WS-6 ontology action write-back (OSDK action, `runActionType`) | `{ ontologyId, action, params, reason }` |

The last two are the **ontology objects/actions/OSDK endpoints exposed as A2A
tasks**. Every skill enforces owner-scoping (by the caller's oid), WS-4.3
object/action security, and honest gates — an external agent receives exactly
the result the caller is cleared to get.

### JSON-RPC methods (`POST /api/a2a`)
- `message/send` (+ legacy `tasks/send` alias) → executes the delegated task and
  returns a terminal `Task`.
- `tasks/get` → retrieve a delegated task (tenant-scoped Cosmos store, TTL 7d).
- `tasks/cancel` → cancel a non-terminal task.
- `message/stream` → `-32004` (streaming not advertised; use blocking `message/send`).

Every delegation is **audited** — a durable Cosmos audit-log row + SIEM/webhook
fan-out.

### A Loom agent registered as an A2A card
A **published** data-agent / agent-flow (the same `Publish as MCP` flag) also
serves its own A2A card + endpoint:
- `GET  /api/items/data-agent/[id]/a2a` · `GET /api/items/agent-flow/[id]/a2a` — the card.
- `POST …/a2a` — `message/send` runs the agent's real backend.

The publish response includes the `a2a.endpoint` alongside the MCP config.

## Outbound — a Loom agent delegates a task OUT (gov-safe egress)

`POST /api/a2a/delegate` `{ origin, text, data? }` resolves an external agent's
card, then `message/send`s the task to it. Every outbound fetch is gated by the
**gov-safe egress profile** `LOOM_A2A_EGRESS_ALLOW` (comma-separated external
host suffixes):

- **Unset → outbound A2A is disabled** (fail-closed). Nothing leaves the
  boundary — the sovereign / air-gapped default. Inbound A2A is unaffected.
- **Set → strict allow-list**: only the whitelisted host suffixes are reachable;
  every other host (incl. the whole public internet) is refused. A whitelisted
  host is also exempt from the private-IP guard (an in-VNet peer agent).

The SSRF policy (https-only, private-IP/IMDS rejection, resolve-then-validate) is
shared with the MCP egress guard (`lib/azure/egress-ssrf.ts`).

## Backend map
- Protocol core (types, card, JSON-RPC dispatch): `lib/copilot/a2a-protocol.ts`
- Skill catalog + platform card: `lib/copilot/a2a-tasks.ts`
- Platform executor: `lib/copilot/a2a-platform-execute.ts`
- Per-item server wiring: `lib/copilot/a2a-item-server.ts`
- Outbound client: `lib/copilot/a2a-client.ts`
- Egress guard: `lib/azure/a2a-egress-guard.ts` (shared core `egress-ssrf.ts`)
- Task store (Cosmos `a2a-tasks`, PK `/tenantId`, TTL 7d): `lib/azure/a2a-task-store.ts`
- Audit: `lib/azure/a2a-audit.ts`

## Config
- `LOOM_A2A_EGRESS_ALLOW` — the gov-safe OUTBOUND egress allow-list (runtime-only;
  unset = outbound disabled, the sovereign default). Editable at `/admin/env-config`.
- Cosmos container `a2a-tasks` — provisioned by `cosmos.bicep` loomContainers
  (createIfNotExists fallback in `cosmos-client.ts`).
