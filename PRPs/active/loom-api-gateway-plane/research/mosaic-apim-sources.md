# Research log — microsoft/mosaic-apim (retrieved 2026-10-28)

Every Mosaic claim in this set traces to one of the documents below, read on
`main` on 2026-10-28 via raw.githubusercontent.com or the GitHub tree view.
Repository facts at retrieval: public, MIT, 275 commits, 13 open issues,
6 open PRs. Where a page was read only partially (the GitHub tree view
truncates at "View all files"), that is stated.

## Root documents

| Document | What it establishes | Read |
|---|---|---|
| `README.md` (224,907 chars; read in three parts) | Product summary, full feature list, architecture, Azure services, deployment model, security model excerpts, API tables | first 200,000 chars; the final 24,907 (contributing, local dev) not read |
| `PRODUCT.md` | Personas (administrators, end users), non-goals, operating principles, brand constraints | full |
| `DESIGN.md` | UI conventions: Fluent tokens, rail navigation, workbench list+detail pattern, unsaved-draft protection, "never show unknown as zero", a11y requirements | full |

## Architecture Decision Records (`docs/adr/`, 29 files)

| ADR | Title (filename) | Read |
|---|---|---|
| 0001 | apim-runtime-boundary | full |
| 0002 | cosmos-partitioning | full |
| 0003 | entra-applications-and-local-auth | full |
| 0004 | gateway-onboarding-and-policy-abstraction | full |
| 0005 | adopting-model-apis-and-mcp-servers | full |
| 0006 | model-endpoint-onboarding | full |
| 0007 | mcp-server-registration | full |
| 0008 | portal-identity-and-role-separation | full |
| 0009 | entitlement-subjects-resources-and-apim-binding | full |
| 0010 | publishing-models-into-apim | full |
| 0011 | governed-model-access | full |
| 0012 | format-aware-model-publishing | full |
| 0013 | runtime-readiness-by-data-actions | full |
| 0014 | environments | full |
| 0015 | end-user-usage-report | **not read** (covered by `usage-analytics.md`) |
| 0016 | agent-identities-and-security-group-grants | full |
| 0017 | mcp-gateway-enforcement | full |
| 0018 | key-authenticated-backends | full |
| 0019 | usage-telemetry | full |
| 0020 | price-list | **not read** (covered by `pricing.md`) |
| 0021 | keys-mosaic-keeps | full |
| 0022 | cost-centers | **not read** (covered by `cost-centers.md`) |
| 0023 | budgets-and-notifications | full |
| 0024 | model-pools | full |
| 0025 | mcp-model-calls-on-a-persons-behalf | full |
| 0026 | cross-cloud-government-management | full |
| 0027 | approvals-and-personal-notifications | full |
| 0028 | reviewed-azure-model-deployment | full |
| 0029 | managed-cost-center-groups | **not read**; `cost-centers.md` records it as experimental, default off |

## Guides (`docs/`, 17 files)

| Guide | Read |
|---|---|
| `azure-government.md` | full |
| `usage-analytics.md` | full |
| `cost-centers.md` | full |
| `pricing.md` | full |
| `publish-mcp-servers.md` | full |
| `budgets-and-alerts.md` | full |
| `notification-engine.md` | full |
| `call-models-with-entra-tokens.md` | full |
| `call-models-with-agent-identities.md` | full |
| `screenshots.md` | full (used as the IA inventory of console and portal) |
| `approvals-and-notifications.md`, `notification-routing.md`, `notification-setup.md`, `connect-to-mcp-servers.md`, `mcp-servers-that-call-models.md`, `cost-center-access-feasibility.md`, `identity-photos.md` | **not read**; ADR 0027 and `notification-engine.md` cover the notification design at the level this set needs |

## Code tree (names only; contents not read)

- `apps/api/src/mosaic_api/`: routers `analytics_api`, `approvals_api`,
  `azure_connections_api`, `budgets_api`, `cost_centers_api`, `directory_api`,
  `mcp_publishing_api`, `model_deployments_api`, `model_pools_api`,
  `notification_*_api`, `pricing_api`, `teams_api`; domain modules
  `approvals`, `budgets`, `clouds`, `cost_centers`, `deployment_capacity`,
  `environments`, `model_pools`, `notifications`, `observed`, `pricing`,
  `scheduling`, `usage_telemetry`; directories `data/`, `integrations/`,
  `repositories/`, `services/`.
- `apps/api/src/mosaic_api/integrations/`: `aoai/`, `apim/`, `email/`,
  `graph/`, `loganalytics/`, `mcp/`, plus `access_policy.py`,
  `mcp_access_policy.py`, `policy.py`, `pool_policy.py`, `backend_keys.py`,
  `key_vault.py`, `rbac.py`, `teams.py`, `azure_connections.py`.
- `apps/api/src/mosaic_api/data/`: `model_prices.json`, `model_prices.schema.json`.
- `scripts/`: `entra_bootstrap.py`, `mosaic_entra.py`, `price_seed.py`,
  `verify_model_access.py`, `verify_mcp_access.py`,
  `cost_center_access_probe.py`, `screenshots/`, `tests/`.

The **port list** in `adr/ADR-010-native-rebuild-and-port-list.md` names
which of these are read and ported as data during W2/W4/W6 (the policy
renderers, operation sets, price seed, KQL). Those files must be read in full
by the implementing wave; this log records only that they exist.

## Things Mosaic itself lists as unverified (carried forward, not assumed)

- ADR 0017: `.well-known` routing, live `mcpProperties.endpoints` shape,
  policy writes on MCP APIs under `2025-09-01-preview`, `on-error` seeing the
  401, streaming through the policy, `groups` claim in app-only agent tokens,
  traces reaching `ApiManagementGatewayLogs.TraceRecords`.
- ADR 0023: named-value propagation time on classic and v2 tiers; Graph
  sending in the chosen cloud.
- ADR 0024: whether `retry` sees connection failures; per-attempt traces;
  route-based deployment names behind one backend pool.
- ADR 0025: journey M9 end to end.
- `azure-government.md`: MCP regional parity in Government; `.azure-api.us`
  tier features.

These feed `apigw-W00-measurement-spike.md`.
