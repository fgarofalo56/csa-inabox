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

## Agent-card generation + spec conformance (B-N14d)

Every Loom agent card — the platform card, a published `data-agent` /
`agent-flow` card, and a WS-9 mesh-agent card — is produced by **one**
generator, `lib/copilot/a2a-agent-card.ts`, from the agent metadata already
registered in the platform. There is no hand-authored card anywhere.

Cards are emitted in the **current** A2A specification shape
(<https://a2a-protocol.org/latest/specification/>), which restructured the
discovery objects relative to the 0.3 line Loom previously emitted:

| Current spec (generated) | Section | 0.3-line field it replaced |
|---|---|---|
| `supportedInterfaces[]` — `{ url, protocolBinding, tenant?, protocolVersion }` | §4.4.1 / §4.4.6 | top-level `url` + `preferredTransport` + `protocolVersion` |
| `securityRequirements[]` — `[{ schemes: { id: { list: [] } } }]` | §4.4.1 | `security[]` |
| `securitySchemes` one-of wrapper (`httpAuthSecurityScheme` …) | §4.5.1 / §4.5.3 | flat `{ type, scheme, bearerFormat }` |
| `capabilities.extendedAgentCard` | §4.4.3 | `supportsAuthenticatedExtendedCard` |
| `capabilities.extensions[]` (`AgentExtension`) | §4.4.4 | *(the mesh card's non-spec `loomEgressProfile` key)* |
| `provider.url` **required** alongside `provider.organization` | §4.4.2 | provider without a url |
| `signatures[]` (`AgentCardSignature`, RFC 7515 JWS) | §4.4.7 | — |
| `iconUrl` | §4.4.1 | — |

Each generated document is a **superset**: it also carries the 0.3-line aliases
(`url`, `preferredTransport`, `protocolVersion`, `security`,
`supportsAuthenticatedExtendedCard`, `additionalInterfaces`), because the spec's
Appendix A keeps legacy names resolvable and conformant clients ignore unknown
fields. One card therefore serves both current-line and already-deployed 0.3
clients.

`tenant` (§4.4.6) is how a single card addresses **one** agent behind the shared
`/api/a2a` endpoint: a published data agent's card lists its own per-item route
first and `/api/a2a` second with `tenant: "data-agent:<id>"`. A client that only
knows the platform endpoint can still reach the specific agent.

### Discovery surfaces
| Endpoint | Auth | Returns |
|---|---|---|
| `GET /.well-known/agent-card.json` (§14.3 registered URI) | public | the platform card |
| `GET /.well-known/agent.json` | public | the same card, legacy path |
| `GET /api/a2a/agent-cards` | session | the catalog of every agent the caller can address (card URL, endpoint, `tenant` routing id, conformance flag) |
| `GET /api/a2a/agent-cards/{kind}/{id}` | session + per-agent access | one generated card **plus** its §4.4.1–§4.4.7 conformance report; `?raw=1` returns the bare card |
| `GET /api/items/{data-agent,agent-flow}/{id}/a2a` | session / PAT | that agent's card |
| `GET /api/mesh/a2a/{id}/card` | session | that mesh agent's card |

The multi-agent catalog is deliberately **not** under `/.well-known`: §14.3
registers that URI for one card and notes it "SHOULD NOT include sensitive
credentials or internal implementation details" — enumerating a tenant's agents
is not public information.

`validateAgentCard()` is a pure, total validator over §4.4.1–§4.4.7 + §4.5.1
(one-of security schemes). It runs in the per-agent card route so a conformance
regression surfaces as a report rather than silently shipping a broken card, and
it is exercised field-by-field in `lib/copilot/__tests__/a2a-agent-card.test.ts`.

## Backend map
- Protocol core (types, card, JSON-RPC dispatch): `lib/copilot/a2a-protocol.ts`
- **Agent-card generator + spec validator: `lib/copilot/a2a-agent-card.ts`**
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
