# auth-identity — parity with Azure Entra sign-in + admin RBAC (deploy-readiness)

Domain: Auth, session & admin RBAC (GH #1383). PRP: `docs/fiab/prp/deploy-readiness-100pct.md`.
Source UI: Azure portal → Entra ID → App registrations (redirect URIs, client
secrets, API permissions, "Allow public client flows") + the Loom `/setup`
Identity & Admin step + `/admin/permissions` bootstrap.

## What "day-one working" requires (inventory)

| Capability | Backend |
|---|---|
| Interactive user login (OAuth code flow) | Entra app registration (confidential client) + client secret |
| Redirect URI matches the console host | App registration `web.redirectUris` reconciled to the deploy's FQDN |
| Device-code CLI login (`loom auth login`) | The same confidential app registration: the Console redeems the device code with its client secret (`isFallbackPublicClient=false`, #4805). Whether Entra accepts a secret on this grant is UNVERIFIED until the live receipt on #4805 (see the coverage row) |
| Session cookies mint/verify across redeploys | Stable `SESSION_SECRET` (HKDF input) |
| First admin can open `/admin/*` before any grants | `LOOM_TENANT_ADMIN_OID` / `_GROUP_ID` bootstrap |
| Secrets stored securely | Key Vault (`loom-msal-client-secret`, `session-secret`) |

## Loom coverage

| Capability | Status | Backend per control |
|---|---|---|
| App registration provisioned by default | built ✅ | `modules/admin-plane/entra-app-registration.bicep` (deploymentScript) + `scripts/csa-loom/bootstrap-msal-app-reg.sh` (bootstrap), gated `loomMsalAppReg.enabled` (default true) |
| Redirect URIs reconciled to console FQDN | built ✅ | `az ad app update --web-redirect-uris` (bicep script + bootstrap, runtime FQDN added by the bootstrap step) |
| Device-code flow (CLI + VS Code) | built ✅, live acceptance UNVERIFIED (#4805) | `app/api/auth/cli-session/route.ts` → `lib/auth/device-code-grant.ts`: Entra v2 `/devicecode` + `/token` as a confidential client (`client_secret` on the redemption). That the redemption must carry the secret follows from RFC 8628 §3.4 (a client issued credentials MUST authenticate the device access token request) and from the AADSTS7000218 text ("must contain … 'client_assertion' or 'client_secret'"). Microsoft Learn's MSAL authentication-flows page describes device code as "available only for public client applications", so Entra's acceptance of the secret on this grant is UNVERIFIED until a live sign-in receipt on #4805. Public-client flows stay OFF — `isFallbackPublicClient=true` makes Entra refuse the browser sign-in's secret (AADSTS700025). The minted session must belong to the deployment's tenant (`tid` = `AZURE_TENANT_ID`, matching `iss`) and is marked `authVia: 'device_code'`, which drives the in-product guardrails below. Failures stream the classified AADSTS code + remediation |
| Delegated Graph `User.Read` | built ✅ | `az ad app update --required-resource-accesses` (`e1fe6dd8-…`) |
| Client secret in Key Vault | built ✅ | `az ad app credential reset` → `az keyvault secret set` → ACA KV-backed secretRef |
| `SESSION_SECRET` always set + KV-backed | built ✅ | admin-plane env (unconditional) + `session-secret` ACA secret (KV-backed whenever the app-reg flow owns the secret — in-bicep script OR post-deploy bootstrap, GH #1534; else stable per-RG GUID) |
| Bootstrap admin never blank | built ✅ | `effectiveTenantAdminOid = loomTenantAdminOid ?? deployer().objectId` → `LOOM_TENANT_ADMIN_OID` |
| Honest gate when MSAL unset | built ✅ | `app/auth/sign-in/route.ts` 503 on `LOOM_MSAL_CLIENT_ID`/`_SECRET`/`AZURE_TENANT_ID`; `self-audit.ts` `entra-app` check re-keyed onto the MSAL vars |
| Scan-and-choose (CLI) | built ✅ | `scripts/csa-loom/scan-and-deploy.sh` + `scan-modules/auth-identity.sh` (existing/new/disable + signed-in-user admin recommendation) |
| Scan-and-choose (Wizard) | built ✅ | `app/api/setup/identity/route.ts` GET scan + recommend, POST records choice + emits apply path |
| Admin consent for Graph perms | honest-gate ⚠️ | One-time human Global/Application Admin click in Entra (documented in `MSAL-handoff.md` + bootstrap summary) |

Zero ❌. The one ⚠️ (tenant-wide admin consent) is an irreducible Entra tenant
action, surfaced honestly — not a Loom stub.

## Hardening the CLI / VS Code device-code sign-in

The device-code sign-in is a cross-device flow: the code is approved in a
browser on one device and the session is used by another (the CLI or the VS Code
extension), without that client ever running an interactive browser sign-in.
Least privilege applies to it in two independent layers.

### Loom's in-product guardrails (always on)

Operator decision 2026-09-30, implemented in `lib/auth/device-code-policy.ts`,
`middleware.ts`, `lib/auth/feature-gate.ts` and
`app/api/auth/cli-session/route.ts`. They apply whatever the tenant's
Conditional Access configuration is:

| Guardrail | Behaviour |
|---|---|
| Shorter lifetime | A device-code session lasts **1 hour** from the sign-in (`DEVICE_CODE_SESSION_MAX_AGE_SECS`); `/api/auth/refresh` never extends it. A browser session keeps the normal sliding lifetime. |
| No admin surfaces | `/admin/*` pages, `/api/admin/*` routes, every tenant-admin gate and every admin-tier capability (`admin.*`, or any capability at the Admin role) answer **403 `interactive_sign_in_required`** — "Admin actions require an interactive browser sign-in". A device-code session never holds tenant-admin standing, so no tenant-admin bypass applies to it either. |
| Rate-limited start | Starting a sign-in (`POST /api/auth/cli-session`, device-code flow) is limited per client IP to **5 per 10 minutes** (the `cli-session` class of `lib/azure/rate-limiter.ts`, in-memory and Cosmos-backed across replicas), with at most **2 sign-ins waiting per IP** and 50 per replica. Both refusals are **429 with `Retry-After`**. The IP is the one a hop Loom controls wrote (`lib/azure/client-ip.ts`), never the caller's own `X-Forwarded-For` claim. |
| Tenant binding | The session must belong to the deployment's tenant: the id token's `tid` must equal `AZURE_TENANT_ID` and its `iss` must be that tenant on this cloud's login host. |

### Restricting the flow with Conditional Access (tenant-owned, optional)

A tenant can also decide WHO may use the device-code flow at all, and from
where, with a Microsoft Entra Conditional Access policy that uses the
**Authentication flows** condition. Grounding:
[Conditional Access: Authentication flows](https://learn.microsoft.com/entra/identity/conditional-access/concept-authentication-flows)
and
[Block authentication flows with Conditional Access policy](https://learn.microsoft.com/entra/identity/conditional-access/policy-block-authentication-flows).
Microsoft's guidance is to block the device code flow wherever it is not needed
and allow it only by exception.

A policy that allows the Loom CLI / VS Code sign-in for named people only:

1. **Microsoft Entra admin center → Entra ID → Conditional Access → Policies →
   New policy.**
2. **Users**: include **All users**; exclude the group of people who may use the
   Loom CLI or VS Code extension, plus the tenant's emergency-access accounts.
3. **Target resources**: **All resources**, or narrow it to the Loom Console's
   enterprise application to scope the policy to Loom.
4. **Conditions → Authentication flows**: set **Configure = Yes** and select
   **Device code flow**.
5. Optional, **Conditions → Locations**: exclude the trusted named locations
   (for example corporate egress ranges) that the device-code sign-in may come from.
6. **Grant → Block access**.
7. Create the policy in **Report-only** mode first, review the sign-in logs for
   the Loom Console app, then switch it **On**.

When the policy blocks a sign-in, the CLI and the extension print Entra's
refusal: Loom classifies Conditional Access refusals (AADSTS53003) and names
them, with Entra's correlation id.

These two layers are independent. Conditional Access decides who may complete
a device-code sign-in; Loom's guardrails limit what the resulting session can
do, and they hold even in a tenant with no Conditional Access policy at all.

## Backend per control

- **No mocks**: every control calls real Microsoft Graph / Key Vault / ARM.
- **Azure-native default**: no Fabric/Power BI dependency; works with
  `LOOM_DEFAULT_FABRIC_WORKSPACE` unset.
- **Opt-out**: `loomMsalAppReg.enabled=false` runs the Console unauthenticated
  or BYO an existing app via `loomMsalClientId`.

## Verification

- `az bicep build --file platform/fiab/bicep/main.bicep` — type/syntax clean
  (the only error is the pre-existing repo-wide `max-params` lint that
  origin/main already trips at 258 params; this PR adds a single object param).
- `npx tsc --noEmit` clean for the touched console files.
- E2E (post-merge, real deploy): clean deploy → `/auth/sign-in` 302s to AAD →
  callback mints a session → `/admin/permissions` reachable as the bootstrap
  admin, with zero `not_configured` gates.
