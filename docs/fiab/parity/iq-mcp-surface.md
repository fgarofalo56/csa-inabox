# iq-mcp-surface — parity with Microsoft Fabric IQ / Microsoft IQ MCP

Source: Microsoft Build 2026 announcements (#1 Fabric IQ — unified ontology +
semantic + signals; #6 IQ exposed to agents via MCP). Microsoft Learn:
Model Context Protocol server tools (`tools/list` / `tools/call`), Azure AI
Foundry agent tool registration, Microsoft Agent 365 connectors.

## Fabric IQ feature inventory (the capability Build 2026 describes)

- A single intelligence surface that unifies an organization's **ontology**
  (conceptual entity model), its **semantic** layer (governed tables + measures),
  and its **live operational signals** (real-time telemetry).
- Exposed to **external agents** (Agent 365, Foundry, Copilot Studio) as **one
  MCP tool endpoint** so an agent can discover and ground on the org's knowledge
  without bespoke connectors.
- MCP JSON-RPC methods: `initialize`, `tools/list`, `tools/call`, `ping`.
- Discovery → drill-in → query workflow (overview, then inspect a model, then
  query signals).
- Token-based auth for machine-to-machine agent access.

## Loom coverage

| Capability | Status | Notes |
| --- | --- | --- |
| Single MCP endpoint packaging all three IQ layers | ✅ built | `POST /api/iq/mcp` (JSON-RPC 2.0). |
| `initialize` handshake (protocolVersion + serverInfo + instructions) | ✅ built | `serverInfo.name = csa-loom-iq`. |
| `tools/list` catalog | ✅ built | 8 tools (overview, search, ontology x2, semantic x2, signals x2). |
| `tools/call` dispatch to real backends | ✅ built | Cosmos `ontology` / `semantic-model` items + ADX. |
| `ping` + `notifications/initialized` + batch | ✅ built | Liveness + notification + JSON-RPC batch. |
| Ontology layer (entities, IS_A hierarchy, data bindings) | ✅ built | Parses the ontology DSL + `state.entityBindings`. |
| Semantic layer (tables, measures/DAX, relationships) | ✅ built | Normalizes `state` / `state.content`. |
| Live signals (ADX KQL, read-only) | ✅ built | `executeQuery` with a control-command guard + auto-`take`. |
| Live signals when ADX unprovisioned | ⚠️ honest-gate | Structured `{ gate: { missing, detail } }` naming `LOOM_ADX_CLUSTER_URI`. |
| Token auth for external agents | ✅ built | Bearer `LOOM_IQ_MCP_TOKEN` / `LOOM_INTERNAL_TOKEN` + `x-user-oid`. |
| Session auth for Console users / self-test | ✅ built | MSAL cookie → tenant `oid`. |
| External path off by default | ✅ built | `LOOM_IQ_MCP_ENABLED` gates the token path; session path always on. |
| GET discovery document | ✅ built | Unauthenticated; no tenant data. |
| Bicep sync (param + env var + secret) | ✅ built | `loomIqMcpEnabled` in `admin-plane/main.bicep`. |
| Docs + tutorial | ✅ built | `docs/fiab/v3-tenant-bootstrap.md#fabric-iq-mcp`. |
| Vitest coverage | ✅ built | `lib/azure/__tests__/iq-mcp-tools.test.ts` (11 tests). |

Zero ❌. The one non-functional state (signals without ADX) is an honest,
structured gate per `no-vaporware.md` — not a stub.

## Backend per tool

| Tool | Backend |
| --- | --- |
| `iq_overview` | `listOwnedItems('ontology'/'semantic-model')` (Cosmos) + ADX table list. |
| `iq_search` | Cosmos `ontology` + `semantic-model` items (in-memory substring match). |
| `iq_list_ontologies` / `iq_get_ontology` | Cosmos `items` (type `ontology`), DSL parsed via `parseOntologyHierarchy`. |
| `iq_list_semantic_models` / `iq_get_semantic_model` | Cosmos `items` (type `semantic-model`), `state.content` normalized. |
| `iq_list_signal_tables` | ADX `listTables` (`kusto-client`). |
| `iq_query_signals` | ADX `executeQuery` (`kusto-client`), read-only guard. |

## No-Fabric-dependency compliance

Every layer resolves to an Azure-native backend with
`LOOM_DEFAULT_FABRIC_WORKSPACE` UNSET: ontology/semantic from Cosmos, signals
from Azure Data Explorer. No `api.fabric.microsoft.com` / `api.powerbi.com` /
OneLake host is reached on any code path. The endpoint reads no `fabricWorkspaceId`.

## Verification

Vitest: `npx vitest run lib/azure/__tests__/iq-mcp-tools.test.ts` → 11 passing.
tsc: the three new files (`lib/azure/iq-mcp.ts`, `lib/azure/iq-mcp-tools.ts`,
`app/api/iq/mcp/route.ts`) are clean under `tsc --noEmit`.
Live E2E (operator, after `loomIqMcpEnabled=true`): the `curl` recipes in the
bootstrap doc return the real tool catalog and a real `iq_overview` for a tenant.
