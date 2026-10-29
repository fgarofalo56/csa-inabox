---
name: apigw-W03-identity-entitlements
status: backlog
priority: P1
order: 24
depends_on: [apigw-W02-publishing-plan-apply]
review: required
orchestrator_model: sonnet
implementer_model: sonnet
created: 2026-10-28
---
# W3 — Identity, entitlements, governed access, marketplace access

**Goal**: people, applications, agents and security groups receive grants on
published models; the gateway enforces them with keys and Entra tokens;
consumers request, receive, connect and rotate from the marketplace;
administrators see effective access. ADR-004, ADR-005. `review: required`
(entitlements and gateway writes).

## Items

| ID | Title | Owns | Depends on | Model | Review | Verify |
|---|---|---|---|---|---|---|
| W3-1 | Bootstrap: idempotent creation of `loom-<env>-model-runtime` (scopes `Models.Invoke`, `Mcp.Invoke`; roles `Models.Invoke.Application`, `Mcp.Invoke.Application`; `groupMembershipClaims: SecurityGroup`; identifier URI) and `loom-<env>-model-client` (public client, loopback redirect, two delegated permissions), `AllPrincipals` `oauth2PermissionGrant` attempt, Graph application permissions for the Console UAMI (D18), client ids persisted as repo variables → console env `LOOM_APIPLANE_RUNTIME_CLIENT_ID`, `LOOM_APIPLANE_MODEL_CLIENT_ID`; Gov login path; withheld consent → warning, not failure; gate `api-gateway.runtime-consent` with Fix-it | `scripts/csa-loom/bootstrap-msal-app-reg.sh` (new functions), `.github/workflows/csa-loom-post-deploy-bootstrap.yml` (the MSAL step and the persist step), `platform/fiab/bicep/modules/admin-plane/main.bicep` (two env vars), `lib/gates/registry/api-gateway.ts` (one gate), `docs/fiab/v3-tenant-bootstrap.md` | none | Sonnet | **required** (identity bootstrap) | a second run changes nothing (idempotence proven by `az ad app list` before/after); Commercial bootstrap run id; GCC-High bootstrap run id; the consent gate renders when the grant is absent and disappears after it is created |
| W3-2 | Principals: directory search (users; applications and managed identities when `Application.Read.All` is granted, otherwise manual object id with "unverified" badge; agent identities and agent users where W0-4 found Agent ID; security groups with read-only member list and read-verification status), principal records, Entitlements → Principals tabs (Agents, Users, Security groups) cross-linked from `/admin/users` | `lib/api-gateway/entitlements/principals.ts`, `lib/azure/graph-principals.ts` (new read helpers only), `app/api/admin/api-gateway/principals/**`, `app/admin/api-gateway/entitlements/principals/**` | W3-1 | Sonnet | none | search results select only id, displayName, appId, type; ≤ 25 results; a denied Graph read shows retry + configuration guidance + manual fallback (never an empty list) |
| W3-3 | Grants: `entitlement` entity (deterministic id; enforcement optional and non-zero when present; token vs request structures), create/enable/disable/revoke routes, Entitlements → Grants tab with limits editor; cost center selection using W4-1's entity (`general` until W4 lands; item-level dependency) | `lib/api-gateway/entitlements/grants.ts`, `app/api/admin/api-gateway/entitlements/**`, `app/admin/api-gateway/entitlements/grants/**` | W3-2, W4-1 | Sonnet | **required** | re-granting the same subject × resource × cost center → 409; an enforcement object with no restriction is refused; unrestricted shown as "Unrestricted", never 0 |
| W3-4 | Governed-access renderer and apply integration — **one Opus design session**: fragment sections for key intake against the grant snapshot, `validate-azure-ad-token` for the runtime audience with `scp`/`roles` rules, direct-then-group precedence within a cost center, overage fail-closed, cost-center resolution order and refusals, budget list check (named value created by the first plan; enforcement writer arrives in W5), attribution and deny traces with `-` defaults, per-grant counters (`llm-token-limit` or request-counting substitute per D17 with plan warning), credential stripping; typed applied snapshots; apply prepares subscriptions without granting, installs the policy before relaxing native subscription requirement, suspends/reactivates keys, revocation removes both paths | `lib/api-gateway/policy/access.ts`, `lib/api-gateway/plan/governed-access.ts`, `lib/api-gateway/entitlements/snapshot.ts` | W3-3 | **Opus** (design), Sonnet (impl) | **required** | mutation receipts for `effectiveAccess`, `resolveCostCenter`, `renderPublicationFragment` governed variant; snapshot tests; a live Commercial apply: key call 200, token call 200, wrong audience 401, no grant 403 `r=no-grant` |
| W3-5 | Keys: create / rotate (per slot) / delete for one's own grant (`app/api/me/api-gateway/keys`) and any direct grant (admin); deterministic subscription naming ending with the cost center code; reveal (`listSecrets` 2024-05-01, owner-only, active API scope check, post-call grant recheck, non-cacheable, audited `keyRevealed`); UI transient 60 s and cleared on unmount/navigation; admin handoff route shows no key (D7) | `lib/api-gateway/entitlements/keys.ts`, `app/api/me/api-gateway/keys/**`, `app/api/admin/api-gateway/entitlements/[id]/keys/**` | W3-4 | Sonnet | **required** | tests: a non-owner session → 403 with no `listSecrets` call recorded; the reveal response carries `Cache-Control: no-store`; the key never appears in the audit document (paired with: the audit document exists with the subscription id) |
| W3-6 | Access requests and approvals on the F16 engine: resource kinds `model-api` (and later `pool-model`, `mcp-server`), request records with environment snapshot and cost center, approval creates the grant + decision + audit atomically, `409 notPublished`, re-confirmation on environment change, unregistered requester → `user` principal, bulk review ≤ 100 with independent outcomes; Entitlements → Requests and Effective tabs; approval policies gain the new resource types | `lib/api-gateway/entitlements/approve.ts`, `app/api/access-requests/**` (resource-kind branches only), `app/api/admin/access-requests/**`, `app/api/approval-policies/route.ts` (resource types), `app/admin/api-gateway/entitlements/{requests,effective}/**`, `lib/types/access-request-workflow.ts` (kinds) | W3-3 | Sonnet | **required** | approving twice returns the same grant; approving when a direct grant exists → 409 conflict; a request for an unpublished model → 409 `notPublished`; bulk: one failing item leaves the others approved |
| W3-7 | Marketplace: **Models** offering kind (model-first rows, environment badge, shape), request-access drawer naming the exact offering and cost center, **My access** (grouped rows; Connection details drawer: endpoint, operations, `tenantId`, `entraClientId`, `entraScope`, `requiredAppRole`, cost-center header, copy-ready MSAL device-code and Anthropic SDK samples with placeholders; key create/rotate/delete), **My requests** reuse, `409 notPublished` handling | `app/marketplace/**` (offering kind + drawers), `app/marketplace/access/page.tsx` (new), `app/api/me/api-gateway/{catalog,access,requests,connection}/**`, `lib/components/marketplace/**` (new components only) | W3-5, W3-6 | Sonnet | none (G1 walk) | Playwright: request → approve → My access → reveal (60 s clear proven by clock advance) → call with the key succeeds; secrets absent from URLs, history state and storage (paired with the positive call) |
| W3-8 | Verifier and receipts: `scripts/measure/apiplane/verify-model-access.mjs` (matrix in `TEST-STRATEGY.md` § 3); docs; G1 walk Commercial; GCC-High matrix through Actions (key path always; token path if the Gov tenant has the registrations) | `scripts/measure/apiplane/verify-model-access.mjs` (new), `e2e/api-gateway-access.uat.ts` (new), `docs/fiab/admin/api-management.md`, `docs/fiab/parity/apim-ai-gateway.md` | W3-1..W3-7 | Sonnet | none | both run ids quoted; every verifier expectation names its breaking input |

Lanes: L1 = W3-1 → W3-2 → W3-3 → W3-4 → W3-5; L2 = W3-6 (after W3-3);
L3 = W3-7 (after W3-5, W3-6); W3-8 last. No bicep beyond two env vars
(same PR as W3-1; queue per the collision rule).

## Done receipt (per cloud)

Commercial: bootstrap idempotent; grant → key → call; grant → token → call;
group grant via token; refusals as specified; marketplace walk; reveal rules
proven. GCC-High: bootstrap run id; verifier run id (key path at minimum,
token path stated as measured).

## Rollback

Grants disabled through the plane (reviewed apply); registrations left in
place and documented; marketplace offering kind hidden by the feature flag.

## Cost / credit estimate

~16 Sonnet sessions + 1 Opus design session.

## Execution state

| Item | Status | Branch | Model | Evidence | Updated |
|---|---|---|---|---|---|
| W3-1 | todo | | sonnet | | 2026-10-28 |
| W3-2 | todo | | sonnet | | 2026-10-28 |
| W3-3 | todo | | sonnet | | 2026-10-28 |
| W3-4 | todo | | opus (design) / sonnet | | 2026-10-28 |
| W3-5 | todo | | sonnet | | 2026-10-28 |
| W3-6 | todo | | sonnet | | 2026-10-28 |
| W3-7 | todo | | sonnet | | 2026-10-28 |
| W3-8 | todo | | sonnet | | 2026-10-28 |
