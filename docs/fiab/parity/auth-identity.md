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
| Device-code CLI login (`loom auth login`) | App registration `isFallbackPublicClient=true` |
| Session cookies mint/verify across redeploys | Stable `SESSION_SECRET` (HKDF input) |
| First admin can open `/admin/*` before any grants | `LOOM_TENANT_ADMIN_OID` / `_GROUP_ID` bootstrap |
| Secrets stored securely | Key Vault (`loom-msal-client-secret`, `session-secret`) |

## Loom coverage

| Capability | Status | Backend per control |
|---|---|---|
| App registration provisioned by default | built ✅ | `modules/admin-plane/entra-app-registration.bicep` (deploymentScript) + `scripts/csa-loom/bootstrap-msal-app-reg.sh` (bootstrap), gated `loomMsalAppReg.enabled` (default true) |
| Redirect URIs reconciled to console FQDN | built ✅ | `az ad app update --web-redirect-uris` (bicep script + bootstrap, runtime FQDN added by the bootstrap step) |
| Public-client / device-code flows | built ✅ | `az ad app update --set isFallbackPublicClient=true` |
| Delegated Graph `User.Read` | built ✅ | `az ad app update --required-resource-accesses` (`e1fe6dd8-…`) |
| Client secret in Key Vault | built ✅ | `az ad app credential reset` → `az keyvault secret set` → ACA KV-backed secretRef |
| `SESSION_SECRET` always set + KV-backed | built ✅ | admin-plane env (unconditional) + `session-secret` ACA secret (KV-backed when script-provisioned, else stable per-RG GUID) |
| Bootstrap admin never blank | built ✅ | `effectiveTenantAdminOid = loomTenantAdminOid ?? deployer().objectId` → `LOOM_TENANT_ADMIN_OID` |
| Honest gate when MSAL unset | built ✅ | `app/auth/sign-in/route.ts` 503 on `LOOM_MSAL_CLIENT_ID`/`_SECRET`/`AZURE_TENANT_ID`; `self-audit.ts` `entra-app` check re-keyed onto the MSAL vars |
| Scan-and-choose (CLI) | built ✅ | `scripts/csa-loom/scan-and-deploy.sh` + `scan-modules/auth-identity.sh` (existing/new/disable + signed-in-user admin recommendation) |
| Scan-and-choose (Wizard) | built ✅ | `app/api/setup/identity/route.ts` GET scan + recommend, POST records choice + emits apply path |
| Admin consent for Graph perms | honest-gate ⚠️ | One-time human Global/Application Admin click in Entra (documented in `MSAL-handoff.md` + bootstrap summary) |

Zero ❌. The one ⚠️ (tenant-wide admin consent) is an irreducible Entra tenant
action, surfaced honestly — not a Loom stub.

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
