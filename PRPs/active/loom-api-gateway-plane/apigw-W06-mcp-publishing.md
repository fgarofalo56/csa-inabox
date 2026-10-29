---
name: apigw-W06-mcp-publishing
status: backlog
priority: P1
order: 27
depends_on: [apigw-W03-identity-entitlements]
review: required
orchestrator_model: sonnet
implementer_model: sonnet
created: 2026-10-28
---
# W6 — MCP servers: registration, discovery, gateway publication, enforcement, on-behalf attribution

**Goal**: an MCP server registered by URL is discovered read-only, published
through a managed gateway as a passthrough MCP API with RFC 9728 discovery,
enforced with `Mcp.Invoke` tokens and call limits, and its model calls can be
attributed to the person served; Loom's own agents publish through the same
path. ADR-002 (fail-closed apply), ADR-004, ADR-007 (on-behalf).
`review: required` (gateway writes).

## Items

| ID | Title | Owns | Depends on | Model | Review | Verify |
|---|---|---|---|---|---|---|
| W6-1 | MCP endpoint registry: register by URL (streamable HTTP ending `/mcp`, no query, HTTPS, userinfo rejected, canonical URL stored), SSRF guard, auth modes none / managed identity with stated audience / static bearer via Key Vault identifier, preflight handshake (protocol offer `2025-11-25`, accepted counter-offers, header rules), discovery sync (`initialize`, `notifications/initialized`, `tools/list` with page cap raising on overflow; never `tools/call`), tool annotations tri-state, `401` → `unauthorized` with `WWW-Authenticate` parsed; migrate `mcpServersContainer` records to `mcpEndpoint`; MCP servers workbench (list, detail with tools and claims, import from gateway from W2-6) | `lib/api-gateway/mcp/{client,ssrf,registry,discovery}.ts`, `app/api/admin/api-gateway/mcp-servers/**`, `app/admin/api-gateway/mcp-servers/**`, `app/api/admin/mcp-servers/route.ts` (redirect/compat), `lib/components/admin/mcp-servers-panel.tsx` (moved) | none | Sonnet | **required** (outbound calls to operator hosts) | `ssrfGuard` mutation receipt; client test: no code path calls `tools/call` (a static assertion over the module's exported methods paired with a positive `tools/list` call); a cap hit with a cursor remaining raises and exempts `observedMcpTool` from the sweep |
| W6-2 | MCP publication plan/apply: backend (URL without `/mcp`), `loom-mcp-<slug>` fragment, MCP API (`type: mcp`, `2025-09-01-preview`, path `{path}/mcp`), API policy with `on-error` `WWW-Authenticate` `resource_metadata`, shared blank-path `loom-mcp-metadata` API + `<api>-prm` operation + policy returning the RFC 9728 document, collision and prefix refusals, gateway-scoped durable write lock, fail-closed sequence (subscription required until policy installed; deny before backend change; deny before delete; failed apply leaves deny; unconfirmed deny keeps the lock), environment enforcement, diagnostics zero-body-bytes warning, unpublish review, legacy per-publication PRM layout tolerated for imports | `lib/api-gateway/mcp/publication.ts`, `lib/api-gateway/policy/{mcp,prm}.ts`, `lib/api-gateway/plan/mcp.ts`, `app/api/admin/api-gateway/mcp-publications/**`, `lib/azure/apim-client.ts` (MCP API create/update/delete with LRO) | W6-1 | Sonnet | **required** | `renderMcpFragment` receipt (strip list); order test: deny policy is written before a backend URL change; planning refused when another API occupies the blank path; live Commercial publish against `https://learn.microsoft.com/api/mcp` → `verify-mcp-access.mjs` green |
| W6-3 | MCP grants and portal: grants for users, agent identities, agent users, security groups on `mcpServer` resources (call limits only; token limits refused), approval through the F16 engine, marketplace **MCP servers** offering kind, My access connection details (server URL, VS Code `mcp.json` snippet with the scope, `Mcp.Invoke` consent note), `409 notPublished` while unpublished; `verify-mcp-access.mjs` | `lib/api-gateway/entitlements/grants.ts` (resource kind), `app/marketplace/**` (offering kind), `app/api/me/api-gateway/connection/**` (MCP branch), `scripts/measure/apiplane/verify-mcp-access.mjs` (new) | W6-2 | Sonnet | **required** | a token-limited MCP grant is refused at save; anonymous 401 with challenge; metadata 200; `invalid_token` on a bad bearer; a metadata document that only works at another URL fails the verifier |
| W6-4 | Model caller and on-behalf: `PUT/DELETE …/mcp-publications/{id}/model-caller` (application principals only; lock; audited; plan warnings when the application lacks a model grant), fragment changes (strip caller `x-loom-on-behalf-of`; set to `context.RequestId` when configured; `r=` and `i=` in the MCP trace), model fragment reads the reference only from validated application tokens (W3-4 hook), rollup join (same gateway, `r=` match, caller = model caller, within `TotalTime` ± 5 min), `onBehalf` / `onBehalfUnresolved` summaries with reasons, Consumers **Model use through MCP servers**, portal own-use only, chargeback columns **On behalf of**, refusal to delete a principal that calls models | `lib/api-gateway/mcp/model-caller.ts`, `lib/api-gateway/policy/{mcp,access}.ts` (header rules), `lib/api-gateway/telemetry/{rollup,parser}.ts` (join + summaries), analytics routes/pages (one section), chargeback CSV (two columns) | W6-2, W4-3 | Sonnet | **required** | join test: a model call 6 minutes after the MCP call's window → `late`; another application's reference → `caller`; a direct call carrying the header records nothing; live M9-style walk on Commercial with one MCP server calling a governed model |
| W6-5 | Loom's own agents through the gateway: `publish-mcp` routes for `data-agent`, `agent-flow`, `loom-app-runtime` upsert an `mcpEndpoint` for the console-hosted URL (auth = managed identity with the console audience) and return a **Publish through gateway** link; the console-hosted endpoint stays (D15); **Expose a REST API as an MCP server** action on a managed REST API (source API, tool selection from operations) using the same engine | `app/api/items/{data-agent,agent-flow,loom-app-runtime}/[id]/publish-mcp/route.ts` (one upsert + one field each), `lib/api-gateway/mcp/from-rest-api.ts`, UI actions in Models/MCP workbenches and the item publish dialogs | W6-2 | Sonnet | none | publishing a data agent registers exactly one endpoint (idempotent on re-publish); an exposed REST API lists only the selected operations as tools |
| W6-6 | Docs, parity, receipts: `apim-ai-gateway.md` § 3 rows; `docs/fiab/admin/api-management.md` MCP section; G1 walk Commercial; GCC-High: per W0-3's outcome, publish through Actions or state the measured limitation | docs listed, `e2e/api-gateway-mcp.uat.ts` (new) | W6-1..W6-5 | Sonnet | none (G1 walk) | run ids; screenshots; the Mosaic live-verification list for MCP (`TEST-STRATEGY.md` § 5) each marked measured or unknown |

Lanes: L1 = W6-1 → W6-2 → W6-3; L2 = W6-4 (after W6-2 and W4-3); L3 =
W6-5 (after W6-2); W6-6 last. No bicep.

## Done receipt (per cloud)

Commercial: external MCP server published and verified; a Loom data agent
published through the gateway and called from VS Code with a token; on-behalf
attribution visible in Consumers and the chargeback CSV. GCC-High: run id or
the W0-3 limitation quoted.

## Rollback

Unpublish plans (deny before delete); endpoints retained; `publish-mcp`
routes keep their original behaviour when the flag is off.

## Cost / credit estimate

~12 Sonnet sessions.

## Execution state

| Item | Status | Branch | Model | Evidence | Updated |
|---|---|---|---|---|---|
| W6-1 | todo | | sonnet | | 2026-10-28 |
| W6-2 | todo | | sonnet | | 2026-10-28 |
| W6-3 | todo | | sonnet | | 2026-10-28 |
| W6-4 | todo | | sonnet | | 2026-10-28 |
| W6-5 | todo | | sonnet | | 2026-10-28 |
| W6-6 | todo | | sonnet | | 2026-10-28 |
