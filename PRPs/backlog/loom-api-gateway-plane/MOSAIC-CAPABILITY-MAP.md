# Mosaic capability map — every Mosaic capability and ADR → Loom disposition → wave

Legend: **adopt** = same behaviour, Loom naming · **adapt** = same intent,
different mechanism because Loom already has one · **reject** = not built,
with reason · **defer** = dated non-goal. "Loom today" cites `origin/main`
`b9decb4a8`. Mosaic facts cite `research/mosaic-apim-sources.md`.

## 1. Gateways and publishing

| # | Mosaic capability | Mosaic source | Loom today | Disposition | Wave |
|---|---|---|---|---|---|
| 1.1 | Multi-gateway registry by ARM resource ID; env vars only as an onboarding hint | ADR 0004 | single instance via `LOOM_APIM_NAME` (`admin-plane/main.bicep:5500`); `app/api/apim/instances/route.ts` lists instances in two RGs | **adopt**; the deploy's own APIM auto-registers as `ownedBy:'deploy'` (auto-bind) | W1 |
| 1.2 | Preflight: effective permissions, `canWrite`, exact `az role assignment create` remediation with principal from the ARM token `oid` | ADR 0004 | `apimConfigGate` (`apim-client.ts:75`) checks env only | **adopt**; remediation becomes a `role-grant` Fix-it (`lib/gates/registry/types.ts`) where the UAMI has authority | W1 |
| 1.3 | Observe / manage modes; observe refuses all writes regardless of Azure permissions | ADR 0010 | every pane writes if the role allows | **adopt**; existing panes gated behind the gateway's mode | W1 |
| 1.4 | Inventory sync into disposable `observed-state`; deterministic IDs; failed reads exempt from sweep; re-read gateway before writing results; in-flight set for admission | ADR 0004 | none | **adopt** (`apiplane-observed`) | W1 |
| 1.5 | Policy XML parsed in memory → SHA-256 digest + redacted facets; URLs lose query/fragment; unknown elements counted as externally authored; XML never persisted or rendered | ADR 0004 | `getPolicy`/`upsertPolicy` (`apim-client.ts:780-799`) round-trip raw XML to the Policies pane | **adapt**: the plane's own records never store XML; the existing XML Policies pane stays for customer-authored policies on managed gateways (it is the Azure portal's own behaviour, `ui-parity.md`), but plane-owned `loom-*` fragments are read-only there | W1, W2 |
| 1.6 | AI-surface detection (Azure OpenAI, Foundry, AI inference, OpenAI, Anthropic, Vertex, Bedrock) and MCP detection via `2025-09-01-preview`; import writes to Cosmos only | ADR 0005 | none | **adopt**; non-Azure kinds detect and display only (Q3) | W1 |
| 1.7 | Model publishing: 8 resources in dependency order, `mosaic-*` fragment + thin `include-fragment` API policy, curated operation sets, plan digest, step results, tracked rollback, ownership merged across applies, LRO polling | ADR 0010 | manual API/product/policy editors; `publishGraphqlApi`, `importApiFromOpenApi` | **adopt** with `loom-` prefix; engine shared with MCP and pools | W2 |
| 1.8 | API shapes `azureOpenAi`, `foundryModels`, `anthropicMessages`; `assess_deployment` from format + ARM flags + gateway tier; refusals with reasons | ADR 0012 | none | **adopt** (Q3) | W2 |
| 1.9 | Unpublish via reviewed plan; `409 planRequired` / `stalePlan`; `unpublishedAt` | ADR 0010 amendment | none | **adopt** | W2 |
| 1.10 | Drift: existence on re-plan; policy/fragment digests after apply; no auto-repair | ADR 0010, 0024 | none | **adopt** | W2 |
| 1.11 | Error reporting: Azure code + most specific detail, bounded; fixed 401/403/404/412 wording; never echo policy markup | ADR 0010 | `ApimError` (`apim-client.ts:94`) | **adopt** on top of `ApimError` | W2 |
| 1.12 | Bundled gateway self-registers at first startup under `system:bootstrap` | ADR 0004 | n/a | **adapt**: registered by the deploy (bicep output → Cosmos seed on first console start), not by a background actor | W1 |

## 2. Model endpoints

| # | Mosaic capability | Source | Loom today | Disposition | Wave |
|---|---|---|---|---|---|
| 2.1 | Endpoint registration by resource ID; preflight; projects resolve to `account_scope`; overlap refusal; removal refused while publications own gateway state | ADR 0006 | `foundry-client.ts` `listDeployments:431`, `listEndpointDeployments:448`; no registry | **adopt** | W2 |
| 2.2 | Discovery sources: pasted ID, hosts observed as AI backends, per-subscription scan with `Reader`; partial-read detection | ADR 0006 | Reader at tenant-root MG already granted to the UAMI (bootstrap step) | **adopt**; reuse `lib/azure/resource-graph-coords.ts` where it fits | W2 |
| 2.3 | Runtime readiness by data actions at the account scope; conditions three-valued; deny assignments; network path (`virtualNetworkType`, firewall); states `granted` … `noGatewayIdentity`; recommended roles | ADR 0013 | none | **adopt** | W2 |
| 2.4 | Key-authenticated Azure AI endpoints (cross-tenant); declared deployments; `<backend>-key` Key Vault named value per publication; key check with one unbilled `GET /openai/models`; gateway identity Secrets User readiness | ADR 0018 | `ApimKeyVaultRef` type exists (`apim-client.ts:1207`); named-values UI inline only (parity ❌ row 126) | **adopt**; closes that parity row | W2 |
| 2.5 | Administrator-pasted key kept in the plane's own vault (`mosaic-apikey-<resource>-<hex>`, write-only `SecretStr`, 422 bodies drop `input`, no traceback locals) | ADR 0021 | `lib/azure/keyvault*` absent; `secret-expiry-monitor` function exists | **adopt** with name `loom-apiplane-key-<resource>-<hex>` in the env vault; `KeyVaultSecretWriter` port | W2 |
| 2.6 | Reviewed creation of Azure model deployments: per-endpoint `manage` opt-in, quota by `usageName`, live catalogue, RAI policy, name availability, re-check before PUT, durable lock, never replay an uncertain PUT, never delete as rollback | ADR 0028 | AML `createOnlineDeployment:2424` only | **adopt** for Cognitive Services accounts (`2024-10-01`) | W7 |

## 3. Access governance

| # | Mosaic capability | Source | Loom today | Disposition | Wave |
|---|---|---|---|---|---|
| 3.1 | `Admin` / `User` app roles; `require_admin`, `require_portal_user`; console gating via `/console/me`; fail-closed edge | ADR 0008 | `withTenantAdmin` (`route-toolkit.ts:175`), `withSession:90`, workspace roles (`workspace-role.ts:130`) | **adapt**: a scoped `apiplane-admin` capability (`withCapability`), tenant admins a superset (Q9, 2026-10-29); any signed-in Loom user = portal user; no new app roles on the sign-in app | W1 |
| 3.2 | Entitlement = subject × resource; deterministic ID; `TokenEnforcement` / `RequestEnforcement`; unrestricted ≠ zero; resources `modelApi`, `mcpServer`, `product`, `modelDeployment`; bindings `inferred`/`manual`/`orchestrated`; `attributionKey` | ADR 0009 | `accessAssignmentsContainer`, `access-request-workflow` (tiers), `approvalPoliciesContainer` (scope kinds default/resource-type/package) | **adopt** entity; **adapt** requests and approvals onto the existing F16 workflow with new resource types `model-api`, `pool-model`, `mcp-server` | W3 |
| 3.3 | Governed access: per-grant API-scoped subscription; keys and/or Entra tokens; neither = deny; dual credentials must agree; `Models.Invoke` scope and `.Application` role; model client with `AllPrincipals` consent; `MOSAIC_ENTRA_MODEL_CLIENT=false` opt-out | ADR 0011 | `bootstrap-msal-app-reg.sh` already manages `appRoles`, `oauth2PermissionScopes`, `groupMembershipClaims`, admin consent | **adopt** (Q6); consent withheld → Fix-it gate | W3 |
| 3.4 | Key reveal: ARM `listSecrets` only on explicit reveal by the owning principal or an admin handoff; transient 60 s; never cached, logged or in URLs; `runtime.error` null on non-admin routes | ADR 0011 | `getSubscriptionKeys` (`apim-client.ts:1106`) exposed to admins; `regenerateSubscriptionKey:958` | **adopt**; owner-only self route `app/api/me/api-gateway/keys` | W3 |
| 3.5 | Principals `user`, `servicePrincipal`, `managedIdentity`, `agentIdentity`, `agentUser`, `securityGroup`; Graph read-only (`User.ReadBasic.All`, `GroupMember.Read.All`, `AgentIdentity.Read.All`; optional `Application.Read.All`); groups claim in runtime tokens; precedence direct > most generous group; overage fails closed; per-member counters | ADR 0016 | `graph-identity-client.ts`, `graph-principals.ts`, SCIM users/groups containers; Agent ID absent | **adopt**; Agent ID availability per boundary is a W0 measurement | W3 |
| 3.6 | Access requests: one final decision; approval creates the grant in one atomic batch; unregistered requester becomes a `user` principal; `409 notPublished`; environment snapshot and re-confirmation | ADR 0009, 0014 | `data-products/[id]/access-requests`, `my-access-requests`, governance inbox | **adapt** onto the existing engine | W3 |
| 3.7 | Effective access and overlapping grants explained; plan warnings on overlap | ADR 0009, 0016 | `access-report` page | **adopt** as an Entitlements → Effective tab | W3 |
| 3.8 | Bulk review (≤ 100), scheduled approval policies (off by default, production explicit opt-in, min age, local-time window), advisory AI recommendations through a governed model | ADR 0027 | approval policies with named approvers | **adopt** in W9 (automation and AI), bulk review in W3 | W3, W9 |
| 3.9 | Connection details: endpoint, operations, `tenantId`, `entraClientId`, `entraScope`, `requiredAppRole`, `costCenter`, subscription header, copy-ready samples (MSAL device code, Anthropic SDK base URL) | guides | marketplace "Try" console and curl samples (`apim.bicep seedSampleApi`) | **adopt** as the My access drawer | W3 |

## 4. Pools, MCP, on-behalf

| # | Mosaic capability | Source | Loom today | Disposition | Wave |
|---|---|---|---|---|---|
| 4.1 | Model pools: breaker / preferential / linear; capacity types from SKU; ≤ 30 members per backend pool; ≤ 10 attempts; shared deployment names for body-routed shapes; stateless only; Consumption tier linear only; health from `mosaic-attempt`; suggested pools; offered-twice warning; per-member pricing by backend ID → host+path → host → deployment | ADR 0024 | bicep pool `apim.bicep:433-480` (one member passed, #4442 § 3.3) | **adopt**; #4442 Wave A widens the bicep pool first, the plane adopts it in W7 (D14) | W7 |
| 4.2 | Bedrock key members; OpenAI-compatible key endpoints | ADR 0024 phase 3, ADR 0018 | none | **defer** (Q3; review 2027-04-28) | — |
| 4.3 | MCP registration by URL; read-only client; SSRF rules; static bearer token via Key Vault; protocol negotiation; tool annotations tri-state | ADR 0007 | `app/admin/mcp-servers` + `mcpServersContainer` (name, endpoint, config), `lib/azure/mcp-client.ts` (console runtime) | **adapt**: the existing registry becomes `mcpEndpoint`; discovery added; the console runtime client keeps calling tools for Copilot (that is Loom's own feature, not the plane's) | W6 |
| 4.4 | MCP publication: backend, fragment, MCP API, shared blank-path PRM API + `<api>-prm` operation; `Mcp.Invoke`; grant match; call limits only; strip credentials; fail-closed apply; deny-before-change; recovery lock | ADR 0017 + amendments | `publish-mcp` routes flip a Cosmos flag only | **adopt**; Loom's own agents publish through the gateway | W6 |
| 4.5 | On-behalf attribution: gateway sets `x-mosaic-on-behalf-of = context.RequestId`; server forwards; model fragment records `r=` only from validated application tokens; rollup joins within `TotalTime` ± 5 min; `onBehalf` summaries; chargeback columns | ADR 0025 | none | **adopt** as `x-loom-on-behalf-of` | W6, W4 |
| 4.6 | Model caller setting per MCP publication; refusals to delete a principal that calls models | ADR 0025 | none | **adopt** | W6 |

## 5. Usage, pricing, cost centers, budgets

| # | Mosaic capability | Source | Loom today | Disposition | Wave |
|---|---|---|---|---|---|
| 5.1 | Usage from resource logs via resource-centric Log Analytics queries with Monitoring Reader; resource-specific tables only; join on `CorrelationId`; validated query inputs | ADR 0019 | `cloud-endpoints.ts` has LA hosts; `domain-chargeback.ts`, `cost-client.ts` query Cost Management | **adopt** | W4 |
| 5.2 | Traces instead of `llm-emit-token-metric` (sampling, dimension limits, absent on unmanaged gateways) | ADR 0019 | `llm-emit-token-metric` absent in bicep (#4442 Wave E) | **adopt** traces as the attribution source; `llm-emit-token-metric` stays an App Insights nicety owned by #4442 Wave E, never the ledger | W4 |
| 5.3 | Plane writes per-API diagnostics on APIs it published (`azuremonitor` logger, 100%, Information, no bodies, LLM logs); never writes diagnostic settings; Telemetry card with five checks and `az` commands | ADR 0019 | `apim.bicep:131` App Insights logger, `:203` diagnostic setting with `GatewayLogs` only | **adopt**; bicep adds `GatewayLlmLogs` where the boundary supports it (W0 measures) | W4, W1 |
| 5.4 | Rollup job every 15 min; leases; today+yesterday; halve windows; never lower a day; backfill 1–730 days in 7-day slices; freshness states | ADR 0019 | Container Apps Job pattern (`cost-anomaly-monitor-job.bicep`) | **adopt** as `apiplane-worker` | W4 |
| 5.5 | Analytics views: Overview, Cost, Consumers (incl. MCP on-behalf), Limits, Reliability (gateway throttled vs backend 429), Unattributed, Access hygiene; filters; Graph name lookups ≤ 200/request cached 1 h; CSV with BOM and formula guard | `usage-analytics.md` | `app/admin/copilot-usage`, `app/admin/usage`, `app/admin/ai-operations` show console-side usage | **adopt**; the console-side pages link to the plane views for gateway-side truth | W4 |
| 5.6 | Price list: versions never edited; token / PTU hourly / monthly; cloud from host; most-specific-wins; effective dates; "No price" reasons; seed from Azure Retail Prices API for Commercial and Government; `price_seed.py --check` | ADR 0020, `pricing.md` | `lib/brain/cost/rate-card.ts` (Container Apps rates from the same API) | **adopt**; port `model_prices.json` + schema + seed script | W4 |
| 5.7 | Cost centers: `general` built-in; code rules; owners/members; keys-allowed; per-person defaults; pooled monthly tokens (second `llm-token-limit` Monthly) and calls (`quota-by-key`); header resolution order; refusals `cost-center`, `cost-center-mismatch`; keys named with the code; member removal revokes dependent grants; recheck pending | ADR 0022, `cost-centers.md` | `costAttributionContainer`, `tokenBudgetsContainer`, `capacityGuardrailsContainer` exist for console-side features | **adapt**: per-workspace auto-creation (Q5) on top of Mosaic's model | W4 |
| 5.8 | Experimental managed cost-center groups | ADR 0029 | — | **reject** for v1 (Mosaic ships it off by default; adds nothing Loom's workspaces don't) | — |
| 5.9 | Budgets per cost center (block or continue) and organization (warn); thresholds 1–1,000, default 80/100; recipients ≤ 20 + owners; forecast; evaluation every 15 min + 5-min fast path ≥ 90%; `budgetState` etag writes; `mosaic-blocked-cost-centers` named value (12-hex keys, `-`, 4,096 chars / 315 blocks); 403 `r=budget`; 503 `r=budget-list`; lifts at month end / raise / off / delete | ADR 0023, `budgets-and-alerts.md` | `app/api/admin/finops/budgets` = Azure Consumption budgets (money, not tokens) | **adopt** as plane budgets beside the Consumption budgets, both on the FinOps page | W5 |
| 5.10 | Chargeback CSV with cost center, on-behalf columns; portal Usage & cost per person with cost-center totals and pooled quota | guides | `app/admin/chargeback`, `app/admin/usage-chargeback` | **adapt**: new sections on the existing pages | W4 |

## 6. Environments, notifications, approvals

| # | Mosaic capability | Source | Loom today | Disposition | Wave |
|---|---|---|---|---|---|
| 6.1 | Environment catalog (six built-ins + custom), classification, `permits()`, require-classification, invariant, single batch route, lock order, advisory findings, tag suggestions | ADR 0014 | deployment pipelines with stages (`loomPipelinesContainer`, `pipelineStageRulesContainer`) | **adopt**; seed from pipeline stage names (D9) | W1 (catalog + classification), W2 (enforcement in plans) |
| 6.2 | In-app inbox; Graph email via managed identity with mailbox-scoped Exchange RBAC; Teams Workflows (shared) and personal bot; separate admin/user preferences; digests; delivery evidence states; `unknownOutcome`; partial-audience handling; leases, heartbeats | ADR 0023, 0027, `notification-engine.md` | `notificationsContainer` + `/api/notifications` (in-app only); `webhookSubscriptionsContainer`; `report-subscriptions` function sends email today (mechanism to be read in W5) | **adapt**: in-app reuses the bell; Graph email and Teams Workflows added; personal Teams bot **defer** | W5 |
| 6.3 | ACS email | ADR 0023 (superseded) | — | **reject** (Mosaic itself replaced it with Graph) | — |
| 6.4 | Administrator enumeration from enterprise-app role assignments; nested groups don't count | ADR 0027 | tenant admin from `adminEntraGroupId` (bicep param) | **adapt**: admins = members of the admin group (direct members via Graph) | W5 |

## 7. Cross-cloud and platform

| # | Mosaic capability | Source | Loom today | Disposition | Wave |
|---|---|---|---|---|---|
| 7.1 | Commercial plane manages Government via a Government SP in an isolated management vault; four identity boundaries; key-only Government runtime; shared cost centers; cloud-aware pricing; disclosure; blocked list | ADR 0026, `azure-government.md` | per-boundary Loom deployments; `cloud-endpoints.ts` | **adopt as opt-in** (Q4) on top of sovereign-native default | W8 |
| 7.2 | Cosmos containers `desired-state`, `sync-operations`, `observed-state`, `audit-events`, `usage-rollups`, PK `/tenantId`; audit outbox in a transactional batch | ADR 0002 | `auditLogContainer`, lazy `createIfNotExists` pattern | **adapt**: five `apiplane-*` containers; audit through the existing container in the same request | W1 |
| 7.3 | Local auth / in-memory repository refused in Azure | ADR 0003 | vitest + Playwright with `/api` stubs (#3699 notes) | **adapt**: in-memory repositories exist only under vitest; no runtime local mode | W1 |
| 7.4 | Health `/healthz`, `/readyz`; Always-On as a prerequisite for in-process workers | ADR 0027 | Container Apps Job (no in-process worker) | **adapt**: the job is the worker; its last-success time surfaces on the Telemetry card and `/admin/readiness` | W4 |
| 7.5 | README screenshots from a fictional seeded estate; capture script | `screenshots.md` | parity docs require screenshots per PR | **adapt**: Playwright screenshots against a seeded test tenant in the G1 walk | W9 |
| 7.6 | `verify_model_access.py`, `verify_mcp_access.py` live verifiers | scripts | `scripts/measure/*` pattern | **adopt** as `scripts/measure/apiplane/verify-model-access.mjs`, `verify-mcp-access.mjs` | W3, W6 |
| 7.7 | DESIGN.md rules: unknown never zero, missing telemetry never healthy, unpriced never free, no "Live data" label, drafts protected, credentials never in URLs/history/storage | DESIGN.md | `ux-standards.md` | **adopt** as additions to the per-surface checklist (W1 docs item) | W1 |

## 8. Rejected or deferred, with reasons (summary)

| Item | Why |
|---|---|
| Vendoring Mosaic's FastAPI, SPAs or Entra registration set | Operator Q1; one product, one sign-in, one design system |
| AWS Bedrock, Vertex, SaaS endpoints as backends | Operator Q3; audit scope per boundary; review 2027-04-28 |
| Government user sign-in, Government Graph, runtime Government tokens, federation | Mosaic ADR 0026 blocks them too; a sovereign-native deployment covers those users |
| Mosaic `Admin`/`User` app roles | Loom's tenant admin and session already express them |
| Separate end-user portal | Loom's marketplace, access requests and notifications already exist and must stay one product (`web3-ui.md`) |
| ACS email, managed cost-center groups | Superseded / experimental in Mosaic itself |
| Unified model API (preview), `llm-emit-token-metric` as the ledger, multi-vendor pools | Preview / sampling / explicit Mosaic limitation; D16 review date |
