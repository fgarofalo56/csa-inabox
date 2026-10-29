# Loom API & AI Gateway Plane — Product Requirements Document

| Field | Value |
|---|---|
| Product | Loom API & AI Gateway Plane ("the API plane"), a capability of CSA Loom |
| Status | DRAFT, design complete; W0 may start (`apigw-W00-measurement-spike.md`) |
| Created | 2026-10-28 |
| Decision source | Operator mandate 2026-10-28 (verbatim in `README.md`); operator decisions Q1–Q8 in `OPERATOR-DECISIONS-2026-10-28.md` are fixed inputs |
| Model | `microsoft/mosaic-apim` (MIT), its 29 ADRs and 17 guides (`research/mosaic-apim-sources.md`); the Azure portal's own AI gateway / Models / MCP surfaces (`research/learn-apim-ai-gateway-sources.md`) |
| Boundaries | Commercial and GCC-High with receipts; IL5 supported-in-code via params (no deploy run exists); GCC supported-in-code only, never exercised (`cloud-parity.md`) |
| Related rules | all of `.claude/rules/*.md`; how each is met: `PRP.md` § 8 |
| Related programs | `apim-ai-gateway` (#4442, the runtime gateway; greenlit 2026-10-28), `loom-health-data-services` (shares the one-bicep-PR rule and the `health/apim-fragment.bicep` fragment pattern), `governance-autopilot`, `per-workspace-spark-identity` |

## 1. Problem

Loom already fronts its API marketplace with Azure API Management and ships a
full ARM client (`apps/fiab-console/lib/azure/apim-client.ts`, 1,583 lines), an
eight-tab admin page (`app/admin/api-management/page.tsx`: Service & SKU, APIs,
Products, Subscriptions, Named values, Backends, Policies, Developer portal),
three APIM item types (`apim-api`, `apim-product`, `apim-policy`), and a
bicep-authored GenAI gateway that is switched off pending the direction #4442
asked for (`platform/fiab/bicep/modules/admin-plane/apim.bicep:60-90`). What it
does **not** have is the layer Mosaic proves customers need on top of APIM:

- **One gateway, by env var.** `LOOM_APIM_NAME` / `LOOM_APIM_RG` select a
  single instance (`admin-plane/main.bicep:5500-5501`); there is no gateway
  registry, no observe/manage mode, no inventory, and no way to govern a
  customer's existing gateways alongside Loom's own.
- **No model or MCP publishing.** Publishing a model means hand-authoring an
  API, backend, policy, product and subscription. Loom's own "publish as MCP"
  routes (`app/api/items/data-agent/[id]/publish-mcp/route.ts`) only flip a
  Cosmos flag and expose a console-hosted endpoint; nothing reaches the gateway.
- **No entitlements.** Access is an APIM subscription with no link to an Entra
  principal, no Entra-token path, no security-group or agent-identity grants,
  no effective-access view, and no connection details a consumer can act on.
- **No metering, pricing or chargeback for AI traffic.** The gateway logs only
  `GatewayLogs` (`apim.bicep:203-215`); token logs, attribution traces, rollups,
  a dated price list, cost centers and budgets do not exist. The existing
  FinOps pages read Azure Cost Management by the `loom-domain` tag
  (`app/api/admin/chargeback/route.ts`), which cannot see tokens or callers.
- **No environments.** Nothing stops a development endpoint from being
  published through a production gateway.
- **28 ❌ rows** remain in `docs/fiab/parity/apim-service.md` (monitoring and
  analytics, policy fragments, Key Vault named values, backend credentials and
  pools, users and groups, versions, self-hosted gateways, certificates).

Mosaic solved exactly this problem as a separate product. The operator wants it
inside Loom as one plane, Azure-native, every boundary, no second sign-in.

## 2. Personas and scenarios

| Persona | Scenario (what "working" looks like) | Primary surfaces |
|---|---|---|
| Platform administrator (Loom tenant admin) | Onboards every APIM instance the estate owns across subscriptions; sees inventory, policy facets (never XML), telemetry health and environment classification per gateway; switches a gateway to **manage** only after preflight proves `canWrite`; repairs a missing role with one click | Admin → API & AI Gateway → Gateways |
| AI platform owner | Publishes a Foundry deployment as a governed model through a reviewed plan, chooses key and/or Entra access, sets per-grant and per-publication limits, sees runtime readiness ("can invoke" / "not confirmed" / "cannot invoke") before publishing; builds a pool of three regional deployments behind one URL with PTU-first routing | Models, Pools, Entitlements |
| Agent builder | Registers an MCP server by URL, reviews its tools (schemas and annotations) read-only, publishes it through the gateway with Entra-token enforcement and RFC 9728 discovery, sets a model caller so model calls made for a person are attributed to that person | MCP servers, Entitlements, Analytics → Consumers |
| App developer / data scientist (consumer) | Finds a model in the marketplace, requests access naming a cost center and a reason, gets a decision, opens **Connection details** (endpoint, operations, `entraScope`, `entraClientId`, cost-center header, a copy-ready sample), creates and rotates their own key, sees their own usage and remaining limits | Marketplace → Catalog, My access, My requests, Usage & cost |
| Workspace owner / cost-center owner | Sees the workspace's cost center created automatically, sets a monthly budget with 80%/100% alerts and optional blocking, adds members and pooled quotas, exports chargeback | Cost centers, Budgets, Admin → Chargeback |
| FinOps analyst | Reads measured usage by caller, application, grant, model, deployment, API and cost center, priced from a dated, sourced price list; "No price" never shows as $0; CSV and chargeback exports | Analytics → Cost, Consumers, Limits, Reliability; Pricing |
| Security officer / ISSO | Verifies policy XML is never stored, keys are never stored, writes run only from reviewed plans whose digest matches, every gateway write is audited, Government metadata never leaves the boundary unless cross-cloud was explicitly enabled and disclosed | Audit log, Settings → Runtime, Connections |
| Loom Copilot (actor) | Answers "who can call gpt-4o in production and at what limit", drafts an access decision with a structured recommendation, and resolves a registered gate; never writes to a gateway | Copilot tools (read-only + draft) |
| Loom operator (platform) | Greenfield and brownfield deploys stand the plane up with its containers, job, registrations and roles; readiness shows per-boundary capability state including declared gaps | Deploy, `/admin/readiness`, gate registry |

## 3. Capability inventory (v1 unless marked)

| Area | Capabilities | Source of truth |
|---|---|---|
| Gateways | Multi-gateway registry by ARM resource ID (any subscription the Console UAMI can read); preflight with exact-role remediation; observe → manage mode gate; inventory sync (APIs, operations, products, subscriptions, APIM users and groups, backends, named-value metadata, MCP servers); policy analysis as SHA-256 digest + redacted facets; AI-surface and MCP detection; telemetry readiness card; **the existing eight tabs become the per-gateway Manage plane** | ADR-001, ADR-003; Mosaic ADR 0004, 0005 |
| Models | Endpoint registry (Azure OpenAI / Foundry accounts and projects by resource ID; key-authenticated Azure AI endpoints with declared deployments); deployment discovery; runtime readiness by data actions and network path; publications with three API shapes (`azureOpenAi`, `foundryModels`, `anthropicMessages`) and curated operation sets; deterministic plan → reviewed apply → per-step results → tracked rollback; unpublish via reviewed plan; drift on re-plan; reviewed creation of Azure model deployments (opt-in per endpoint) | ADR-002; Mosaic ADR 0006, 0010, 0012, 0013, 0018, 0021, 0028 |
| Pools | Model pools (breaker, preferential, linear) over many endpoints and regions behind one URL; capacity types from SKU; health from attempt traces; drift digests; suggested pools; Loom's own Copilot traffic as a governed application principal on a pool model | Mosaic ADR 0024; #4442 Waves A/B1 |
| MCP servers | Registration by URL with read-only tool discovery (`initialize`, `tools/list`; never `tools/call`) and SSRF protections; passthrough MCP publication (backend, fragment, MCP API, shared blank-path PRM metadata API); `Mcp.Invoke` token enforcement; call limits; fail-closed apply; on-behalf attribution; Loom's own data-agent / agent-flow / loom-app-runtime "publish as MCP" routed through the gateway | Mosaic ADR 0007, 0017, 0025; Learn MCP pages |
| Identity and entitlements | Principals: user, service principal, managed identity, agent identity, agent user, security group (Graph read-only); grants (subject × resource × cost center) with token and request enforcement; keys per grant and cost center, created on request, rotated per slot, revealed only to the owner, never stored; Entra tokens (`Models.Invoke`, `Mcp.Invoke`, application roles); group precedence and overage fail-closed; effective access and overlap explanation; access requests, bulk review, scheduled approval policies (opt-in), advisory AI recommendations | ADR-004, ADR-005; Mosaic ADR 0008, 0009, 0011, 0016, 0027 |
| Usage and analytics | Rollups from `ApiManagementGatewayLogs` + `ApiManagementGatewayLlmLog` via resource-centric queries every 15 minutes into Cosmos; attribution traces (`loom-attribution`, `loom-deny`, `loom-attempt`); dimensions gateway, environment, grant, caller, client app, API, model, deployment, cost center; views Overview, Cost, Consumers, Limits, Reliability, Unattributed, Access hygiene; freshness states; CSV exports; retention beyond workspace retention | ADR-007; Mosaic ADR 0019, `usage-analytics.md` |
| Pricing | Sourced, dated, versioned price list seeded from the Azure Retail Prices API for Commercial and Government; administrator versions; most-specific-wins matching; PTU hourly and monthly amounts; "No price" with reasons; cost computed at read time | Mosaic ADR 0020, `pricing.md` |
| Cost centers and budgets | Cost centers auto-created per workspace, extensible; `code`, owners, members, keys-allowed, per-person defaults and pooled quotas; `x-loom-cost-center` header and resolution order; monthly budgets per cost center (warn or block) and organization (warn); 80/100 thresholds; blocking through the `loom-blocked-cost-centers` named value; chargeback export joined to Admin → Chargeback / FinOps | ADR-006; Mosaic ADR 0022, 0023, `cost-centers.md`, `budgets-and-alerts.md` |
| Environments | Catalog (Development, Test, QC, Staging, Production, Sandbox, custom; seeded with Loom pipeline stage names); classification of gateways, endpoints, MCP servers; `permits()` verdicts; require-classification; invariant that no change leaves an applied publication blocked; advisory findings | ADR-008; Mosaic ADR 0014 |
| Notifications | In-app inbox (existing `notifications` container and bell), Graph email through the Console UAMI with mailbox-scoped Exchange RBAC, Teams Workflows; separate administrator and user preferences; digests; delivery evidence states | Mosaic ADR 0023, 0027, `notification-engine.md` |
| Cross-cloud (opt-in) | Azure connections: a Government-tenant service principal in an isolated management vault; Government gateways and endpoints registered through it; key-only runtime; shared cost centers; cloud-aware pricing and rollups; disclosure | ADR-009; Mosaic ADR 0026, `azure-government.md` |
| Platform | Five Cosmos containers; one Container Apps Job worker (rollup, budgets, notifications, sync); two Entra registrations added to bootstrap; Monitoring Reader and Reader grants; gate registry entries with Fix-it; Copilot tools; parity docs; greenfield + brownfield docs | `LOOM-INTEGRATION.md`, ADR-010 |

## 4. Non-goals (v1)

- Proxying model or MCP traffic through the console. The plane is a control
  plane; APIM is the runtime (ADR-001). Loom's own BFF-internal model routing
  (#3777) is out of scope here and is consumed by it, not replaced.
- AWS Bedrock pool members, direct OpenAI/Anthropic SaaS endpoints, Google
  Vertex publishing (operator decision Q3; review by 2027-04-28). Detection and
  display of such adopted APIs stays.
- Being an identity provider: no Government user sign-in, no account linking,
  no Graph expansion in Government, no runtime Government Entra tokens
  (Mosaic ADR 0026 blocked list, adopted as-is).
- A second developer portal. Mosaic's end-user portal maps onto Loom's existing
  marketplace, access-request and notification surfaces (`LOOM-INTEGRATION.md`
  § 3).
- APIM's own managed developer-portal designer, self-hosted gateway lifecycle,
  certificates, custom domains and workspaces. These stay on the
  `apim-service` parity backlog and are not pulled in by this set.
- Any claim of compliance, authorization or that cross-cloud management is
  sovereign.
- Replacing #4442's bicep-authored day-one gateway. It is adopted and shown as
  deploy-owned until a reviewed "adopt into plane" apply (W7, D14).

## 5. Requirements (binding)

R1. Every capability ships in Commercial and GCC-High with a receipt; IL5 is a
param set; GCC is supported-in-code and labelled never exercised in every
table (`cloud-parity.md`). Where a boundary genuinely lacks a dependency
(`llm-*` policies, LLM logs, Agent ID, Anthropic shape), the gap is declared
with an owner, a date and a substitute on the readiness surface, never
silently dropped.

R2. A clean deploy provisions the containers, the worker job, the two Entra
registrations, the Monitoring Reader and Reader grants, and registers the
deploy's own APIM as a gateway in **observe** mode automatically
(`auto-bind-by-default.md`). Switching to **manage** is the one deliberate
human step and it is one click after preflight.

R3. The plane never stores or renders policy XML (digest + facets only), never
stores a subscription key, API key or client secret (Key Vault references and
APIM-held keys only), never writes to a gateway in observe mode, and never
writes except from a reviewed plan whose digest still matches
(`SECURITY-AND-COMPLIANCE.md`). The diagnostics writes of W4 are the single
disclosed exception, as in Mosaic.

R4. Every gateway write is one of: a plan step with a recorded outcome, a
rollback of a resource that run created, a named-value block update, or a
diagnostic enable; each is audited with `kind: 'apiplane.*'` and visible in
the admin audit log.

R5. Every surface meets `ux-baseline.md` § 7, `web3-ui.md` and has a parity
doc at `docs/fiab/parity/apim-ai-gateway*.md` with zero ❌ at A-grade; every
gate is in `lib/gates/registry` with a Fix-it; first open of a freshly
registered gateway, endpoint or MCP server is clean.

R6. Unknown is never shown as zero, missing telemetry is never shown as
healthy, unpriced usage is never shown as free, a failed query is never an
empty result (Mosaic DESIGN.md rules, adopted).

R7. Every assertion in the test suites names the input that breaks it; the
policy renderers, digest, `permits()`, attribution parser, price matcher and
budget `evaluate()` each carry a mutation receipt (`assertion-design.md`,
`TEST-STRATEGY.md`).

R8. Docs carry greenfield and brownfield walkthroughs for the plane, per-cloud
status tables, and the Mosaic attribution (MIT) for ported artifacts.

R9. Loom's own AI traffic (#4442 B1) is a governed principal of the plane:
the console's identity holds an application grant on a pool model under the
`platform` cost center, so platform usage is metered, priced and budgeted
like any tenant's.

## 6. Success metrics

| Metric | Target | Measured by |
|---|---|---|
| Time from "register gateway" to full inventory and telemetry health card | ≤ 5 minutes for a gateway with ≤ 200 APIs | W1 receipt, Playwright timing |
| Publish a model (plan + apply) with governed access | ≤ 3 minutes wall clock, zero policy XML typed | W2/W3 G1 walk |
| Share of governed calls attributed to a grant | ≥ 99% on the Loom estate after W4 | Analytics → Unattributed |
| Rollup freshness | "Current" (≤ 2 intervals + 30 min) on every managed gateway 95% of hours | Telemetry health panel, job logs |
| Priced share of tokens | ≥ 95% of tokens priced on Commercial; Government share stated, never substituted | Analytics → Cost, Unpriced tab |
| Budget block latency | ≤ 30 minutes from spend crossing 100% to 403 `r=budget` | W5 receipt |
| Parity | `docs/fiab/parity/apim-ai-gateway.md` zero ❌; `apim-service.md` ❌ count drops from 28 by the rows this set builds (policy fragments, KV named values, backend pools and circuit breakers, loggers and diagnostics, monitoring) | parity docs |
| Cloud parity | every wave's done receipt names Commercial and GCC-High run IDs | wave files |

## 7. Release plan

| Release | Waves | Outcome |
|---|---|---|
| R1 — Governed access | W0, W1, W2, W3 | Any APIM instance onboarded; models published through reviewed plans; keys and Entra tokens; consumers request, receive and use access from the marketplace. Commercial + GCC-High receipts. |
| R2 — Metering and money | W4, W5, W6 | Usage rollups, pricing, cost centers, chargeback, budgets with blocking, notifications; MCP publishing and enforcement. |
| R3 — Scale and operations | W7, W8, W9 | Model pools (incl. Loom's own traffic), reviewed model deployment, cross-cloud connections (opt-in), approvals automation, advisory AI, Copilot tools, hardening, parity docs, greenfield/brownfield docs. |

Each release is reported as "merged, not deployed" until the roll is verified
from the estate's `/build-marker.txt` and the G1 walk is attached
(`deploy-integrity.md` R2).

## 8. Open decisions

Operator questions still open (Q-items) and designer decisions with defaults
(D-items) are in `RISKS-AND-OPEN-DECISIONS.md`. The two that most change the
shape of W1–W3:

- **Q9** — who is a "gateway administrator"? Default: Loom tenant admin
  (`withTenantAdmin`) for every write; a scoped `apiplane-admin` capability is
  a D-item for W9.
- **Q10** — does the plane take ownership of the bicep-authored day-one
  gateway (#4442 B1) in W7, or stay observe-only over it indefinitely?
  Default: adopt in W7 via a reviewed apply, with bicep continuing to author
  until that apply succeeds.
