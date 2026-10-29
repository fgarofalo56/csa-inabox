# Loom integration — exactly where the plane plugs in

Paths measured at `origin/main` `b9decb4a8` (2026-10-28). **(new)** marks files
this set creates. File ownership per wave is in each `W0x-*.md`; this file is
the map an implementer reads first so nothing is re-derived.

## 1. Console navigation and pages

| Today | Change |
|---|---|
| `apps/fiab-console/lib/components/admin-shell.tsx:51` maps `/admin/api-management` → `Settings24Regular` | add `/admin/api-gateway` with `Globe24Regular`; keep the old key for the redirect |
| `app/admin/api-management/page.tsx` (198 lines; gate via `/api/marketplace/gate`; 8 tabs) | becomes a redirect to `/admin/api-gateway/gateways/<deployGatewayId>/manage`; the panes `lib/components/admin/apim-{service,apis,products,subscriptions,named-values,backends,policies,developer-portal}-pane.tsx` are reused inside the Manage view, each receiving a `gatewayId` prop and calling `/api/apim/*?gateway=<id>` |
| `app/admin/mcp-servers/page.tsx` + `lib/components/admin/mcp-servers-panel.tsx` | moves under `/admin/api-gateway/mcp-servers`; the old route redirects; the catalog picker (`lib/mcp/catalog.ts`) stays |
| `app/admin/access-requests`, `app/governance/access-requests` | gain resource kinds `model-api`, `pool-model`, `mcp-server`; the Entitlements → Requests tab embeds the same inbox filtered to plane resources |
| `app/admin/chargeback/page.tsx`, `app/admin/finops/page.tsx`, `app/admin/usage-chargeback/page.tsx` | gain **Model usage** sections fed by `/api/admin/api-gateway/analytics/*`; plane budgets listed beside Consumption budgets |
| `app/marketplace/page.tsx`, `app/api-marketplace/page.tsx` | offering kinds **Model** and **MCP server**; request-access drawer names the offering, environment, capacity badge and cost center |
| bell → `notificationsContainer` | unchanged; plane events write the same `{userId,title,body,severity,link}` shape (`app/api/notifications/route.ts:7`) |
| `app/admin/readiness` + `lib/gates/registry/index.ts` | new gate family `api-gateway.*` from `lib/gates/registry/api-gateway.ts` (new) |

New pages (new): `app/admin/api-gateway/{page,gateways,models,pools,mcp-servers,entitlements,cost-centers,analytics,pricing,settings}/**` with `error.tsx` + `loading.tsx` in the group (route-boundaries check, see `csa_loom_3699_stackedsplit_shipped_gotchas` memory), and user pages `app/marketplace/{access,requests,usage}/page.tsx` (new) plus `app/notifications/preferences/page.tsx` (new).

## 2. BFF routes

| Route family | Wrapper | Notes |
|---|---|---|
| `app/api/admin/api-gateway/**` (new) | `withTenantAdmin` (`lib/api/route-toolkit.ts:175`) | every mutation audited via `auditLogContainer` with `kind:'apiplane.<area>.<verb>'` (pattern `kind:'finops.budget'` in `app/api/admin/finops/budgets/route.ts`) |
| `app/api/me/api-gateway/**` (new) | `withSession` (`:90`) | caller resolved from the session only; never a `subject` query parameter; `runtime.error` always `null` |
| `app/api/apim/**` (existing 13 route dirs) | existing | add `?gateway=<id>`; resolution via `lib/api-gateway/registry/resolve-gateway.ts` (new) falling back to the deploy-owned gateway when omitted, so existing callers keep working |
| `app/api/marketplace/catalog`, `products`, `subscriptions` | existing | catalog adds plane offerings; subscriptions for plane offerings redirect to grants |
| `app/api/access-requests`, `app/api/admin/access-requests`, `app/api/approval-policies` | existing (`withApprovalAuthority:290`) | resource kinds added; approval of a plane request calls `lib/api-gateway/entitlements/approve.ts` (new) in the same transaction pattern Mosaic uses |
| `app/api/items/{data-agent,agent-flow,loom-app-runtime}/[id]/publish-mcp` | existing | after flipping the Cosmos flag, upsert an `mcpEndpoint` for the console-hosted URL and return `publishThroughGateway` link |

Honest gates use `apiHonestGateError` (`lib/api/gate-envelope.ts`) with the
`svc-apim` family extended by `svc-apiplane-*` ids.

## 3. Library layout (`apps/fiab-console/lib/api-gateway/`, new)

```
lib/api-gateway/
  registry/      gateway + endpoint + mcp-endpoint records, preflight, resolve-gateway
  observe/       sync (snapshot, sweep, partial types), policy-analysis (digest+facets), detection
  plan/          plan(), apply(), rollback(), locks, LRO polling, step results
  policy/        renderers: publication, mcp, pool, prm, budget-named-value  (pure; xml never persisted)
  shapes/        curated operation sets per apiShape; assess-deployment()
  entitlements/  principals (Graph), grants, keys (listSecrets reveal), effective-access, approve
  telemetry/     kql, attribution-parser, rollup, freshness, diagnostics-writer
  pricing/       model-prices.json (+schema), matcher, cost
  cost-centers/  entity, resolution order, workspace auto-bind hook
  budgets/       evaluate(), block-list, named-value writer
  environments/  catalog, permits(), batch re-classify, findings
  mcp/           read-only client (initialize/tools-list), ssrf guard, publication
  pools/         pool model, member rules, capacity types, health from attempt traces
  connections/   azure connections (opt-in), cloud profile binding
  notify/        events, routing, graph-mail, teams-workflows, digests, preferences
  __tests__/     vitest, in-memory repositories only
```

Conventions to copy: `lib/util/arm-counted-raw-fetch.ts` for every ARM call
(`[arm-reads]` accounting, #5074); `lib/azure/cloud-endpoints.ts` for every
host (ARM, Log Analytics, login authority per cloud); `ApimError`
(`lib/azure/apim-client.ts:94`) for APIM failures; Fluent v9 + tokens only
(`web3-ui.md`); `EmptyState`, `TileGrid`, `SplitPane` primitives.

## 4. Cosmos

`lib/azure/cosmos-client.ts` declares containers lazily with
`createIfNotExists` (comments at `:136-187`) and exports typed accessors (e.g.
`mcpServersContainer():1373`, `notificationsContainer():1640`,
`auditLogContainer():1641`). Add `apiplaneDesiredContainer`,
`apiplaneObservedContainer`, `apiplanePlansContainer`, `apiplaneUsageContainer`,
`apiplaneNotifyContainer`, all PK `/tenantId`, TTL enabled (`defaultTtl: -1`
on desired/plans/notify; `-1` with per-document TTL on usage). Where the
landing-zone Cosmos is bicep-managed (`platform/fiab/bicep/modules/landing-zone/cosmos.bicep`),
declare the same five containers there too (`no-vaporware.md` Bicep sync
item 4).

## 5. Bicep and deploy

| Module | Change | Wave |
|---|---|---|
| `platform/fiab/bicep/modules/admin-plane/apim.bicep` | diagnostic setting adds `GatewayLlmLogs` where supported (`:203-215`); outputs `apimResourceId`, `aoaiPoolName`, `aoaiBackendNames` for deploy-owned registration; Monitoring Reader for the Console UAMI at the service scope next to the existing Contributor grant (`consolePrincipalId`) | W1 (one bicep PR, sequenced with #4442) |
| `modules/admin-plane/main.bicep` | env vars in the console `apps[]` list near `:5500`: `LOOM_APIPLANE_ENABLED` (default `true`), `LOOM_APIPLANE_DEPLOY_GATEWAY_ID`, `LOOM_APIPLANE_RUNTIME_CLIENT_ID`, `LOOM_APIPLANE_MODEL_CLIENT_ID`, `LOOM_APIPLANE_CROSS_CLOUD` (default `false`), `LOOM_APIPLANE_MGMT_KEY_VAULT_URI` (empty unless cross-cloud); the first two from bicep, the client IDs from bootstrap via repo variables → the same path the MSAL app values take today | W1, W3, W8 |
| `modules/admin-plane/apiplane-worker-job.bicep` (new) | Container Apps Job on the `loom-uat` image (as the existing jobs), `command: ['node','e2e/run-apiplane-worker.mjs']`, cron `*/15 * * * *`, Console UAMI, env `LOOM_URL` / `LOOM_UAMI_CLIENT_ID` / `LOOM_INTERNAL_TOKEN`; pattern `cost-anomaly-monitor-job.bicep:89-133` | W4 |
| `modules/admin-plane/apiplane-mgmt-vault.bicep` (new, opt-in) | Key Vault for cross-cloud management secrets; RBAC, soft delete, purge protection; only the Console UAMI as Secrets Officer; **no** APIM identity access | W8 |
| `modules/landing-zone/cosmos.bicep` | five containers | W1 |
| params `commercial*.bicepparam`, `gcc.bicepparam`, `gcc-high.bicepparam`, `il5.bicepparam`, `tenant-dmlz.bicepparam` | `apiplaneLlmLogs` per boundary from W0 results; cross-cloud stays `false` everywhere | W1, W8 |
| ARM headroom | `main.json` has 7,624 B of ARM 4 MiB headroom (memory `csa_loom_main_json_arm_4mib_headroom_lhds_own_deploy_unit`): the job and vault modules are **their own deploy units** invoked from the admin-plane orchestrator only if the measured size allows; otherwise they become a sibling deployment like LHDS health infra | W4, W8 |

Greenfield: the deploy registers its own APIM (`ownedBy:'deploy'`) on first
console start from `LOOM_APIPLANE_DEPLOY_GATEWAY_ID`. Brownfield: the
Gateways page discovers APIM instances in readable subscriptions
(`app/api/apim/instances` generalised) and **offers** each one; never silently
adopts, never duplicates (`deploy-integrity.md` R5).

## 6. Bootstrap and identity

`.github/workflows/csa-loom-post-deploy-bootstrap.yml` step "Provision MSAL
app registration (sign-in app + redirect URIs + secret in KV)" (`:402`) calls
`scripts/csa-loom/bootstrap-msal-app-reg.sh` (1,629 lines; already uses
`appRoles`, `oauth2PermissionScopes`, `identifierUris`,
`groupMembershipClaims`, admin consent). W3-1 extends the script with the two
registrations in § 6 of `ARCHITECTURE.md`, idempotent by display name, and
persists the client IDs as repo variables the same way "Persist console URL +
audience as repo variables" (`:578`) does. Graph application permissions for
the Console UAMI (`User.ReadBasic.All`, `GroupMember.Read.All`,
`AgentIdentity.Read.All`) are granted in the same step; a withheld consent
produces a gate, never a failure of the bootstrap (deploy-integrity R6).
Gov boundaries run the same step through the Gov login path (`:264-282`).

## 7. Jobs

`azure-functions/` hosts `secret-expiry-monitor`, `report-subscriptions`,
`posture-refresh`; admin-plane Container Apps Jobs exist for cost anomaly,
access-governance sweeper, asset reconciler. The plane uses **one Container
Apps Job** (`apiplane-worker`) running the `loom-uat` image with `node e2e/run-apiplane-worker.mjs` (new; sibling of `run-cost-anomaly.mjs`), which calls the internal-token-guarded routes `app/api/internal/api-gateway/{sync,rollup,budgets,notify}` (new; pattern `app/api/internal/cost-anomaly`, token from `lib/auth/internal-token.ts`), so the rollup, budget, notification and sync code is the same TypeScript the BFF uses and runs inside the console process. Leases: `rollupState` per gateway (15 min),
`budgets` scope lease, `notifications` worker state; last-success timestamps
surface on the Telemetry card and `/admin/readiness`.

## 8. Gate registry entries (`lib/gates/registry/api-gateway.ts`, new)

| Gate id | Trigger | FixitKind | Remediation |
|---|---|---|---|
| `api-gateway.gateway-role` | preflight `canRead=false` or `manage` requested with `canWrite=false` | `role-grant` | Reader / API Management Service Contributor at the service scope |
| `api-gateway.monitoring-reader` | telemetry probe denied | `role-grant` | Monitoring Reader at the service scope |
| `api-gateway.llm-logs-unavailable` | diagnostic category rejected in this boundary | none (declared gap) | links the per-boundary substitute and #4460 |
| `api-gateway.runtime-consent` | `oauth2PermissionGrant` missing for the model client | `wizard` | shows `az ad app permission grant …`; key-based access unaffected |
| `api-gateway.mailbox` | Graph email enabled without a mailbox + Exchange RBAC | `wizard` | names the mailbox step (tenant action) |
| `api-gateway.cross-cloud-vault` | `LOOM_APIPLANE_CROSS_CLOUD=true` without the management vault | `provision` | deploys `apiplane-mgmt-vault.bicep` |

## 9. Copilot

Tools in `lib/copilot/api-gateway-tools.ts` (new), registered with the
existing skill descriptors (`lib/copilot/skill-registry-core.ts`); read-only
plus draft tools as in `ARCHITECTURE.md` § 12; LearnPopovers and a Copilot
entry on every plane surface (`ux-baseline.md`).

## 10. Docs to create or update (same PR as the behaviour)

- `docs/fiab/admin/api-management.md` → describes the hub, the Manage view
  and the redirect (W1).
- `docs/fiab/parity/apim-ai-gateway.md` (new, W1) and the rows it closes in
  `apim-service.md` (W2, W4, W7).
- `docs/fiab/model-strategy.md` → the plane as the owner of model access (W7).
- `docs/fiab/v3-tenant-bootstrap.md` → the two registrations, Graph
  permissions, mailbox and consent (W3, W5).
- `docs/fiab/api-gateway/{greenfield,brownfield,government,cross-cloud}.md`
  (new, W9) per `deploy-integrity.md` R8.
- `docs/adr/` → one accepted ADR per `adr/ADR-0xx` here when its wave ships.
- `CHANGELOG.md` is release-please managed; never hand-edited.

## 11. Tests and scripts

- Vitest under `lib/api-gateway/__tests__/` and the route `__tests__/`
  folders (`app/api/apim/__tests__/apim-admin-routes.test.ts` is the pattern).
- Playwright `e2e/api-gateway-*.uat.ts` beside
  `e2e/ai-apim-copilot-family.uat.ts`.
- Live verifiers `scripts/measure/apiplane/verify-model-access.mjs`,
  `verify-mcp-access.mjs`, `telemetry-probe.mjs` (new), run from Actions for
  Gov receipts (`csa_loom_gov_verify_via_actions_2026_07_30`).
- Gates: `powershell -NoProfile -ExecutionPolicy Bypass -File .claude/hooks/run-tests.ps1 -Fast`
  per item; `make validate` before a wave is called done.
