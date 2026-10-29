# ADR-004 — Two runtime registrations, Loom's own sign-in, six principal kinds

**Status:** Proposed 2026-10-28; accepted when W3 ships.
**Mosaic lineage:** ADR 0003 (registrations), 0008 (role separation), 0011
(model client, consent), 0016 (agent identities, security groups). Operator
decision Q6 (keys and tokens day one).

## Context

Mosaic runs five Entra registrations (API, admin SPA, portal SPA, model-runtime
audience, model client) and two app roles (`Admin`, `User`). Loom already has
a sign-in registration created by `scripts/csa-loom/bootstrap-msal-app-reg.sh`
(which handles `appRoles`, `oauth2PermissionScopes`, `identifierUris`,
`groupMembershipClaims` and admin consent), tenant-admin gating
(`withTenantAdmin`) and workspace roles.

## Decision

1. **No new registrations for the console or marketplace.** Plane
   administrators hold the scoped `apiplane-admin` capability (`withCapability`,
   declared in `lib/auth/feature-catalog.ts`, assignable to an Entra group;
   tenant admins are a superset) from W1-8 (D6; Q9 answered 2026-10-29, which
   departed from the "tenant admin first" default); portal users are any
   signed-in Loom user; self routes resolve the caller from the session only.
2. **Two runtime registrations**, created idempotently by the same bootstrap
   step in every boundary:
   - `loom-<env>-model-runtime`: the audience (`api://<clientId>`), delegated
     scopes `Models.Invoke` and `Mcp.Invoke`, application roles
     `Models.Invoke.Application` and `Mcp.Invoke.Application`,
     `groupMembershipClaims: SecurityGroup`.
   - `loom-<env>-model-client`: single-tenant public client (public client
     flows on, `http://localhost` loopback redirect), requesting only the two
     delegated scopes; tenant-wide consent via an `AllPrincipals`
     `oauth2PermissionGrant`, attempted by bootstrap.
   Client IDs reach the console as `LOOM_APIPLANE_RUNTIME_CLIENT_ID` and
   `LOOM_APIPLANE_MODEL_CLIENT_ID` through the existing repo-variable path.
3. **Withheld consent is a gate, not a failure**: bootstrap warns and
   continues; the console shows a registered gate with a Fix-it carrying the
   exact `az ad app permission grant` command; key-based access is unaffected.
4. **Model and MCP permissions are separate**: `Models.Invoke*` never grants
   MCP access and `Mcp.Invoke*` never grants model access.
5. **Principals** recorded by the plane: `user`, `servicePrincipal`,
   `managedIdentity`, `agentIdentity`, `agentUser`, `securityGroup`. Graph is
   read-only through the Console UAMI with `User.ReadBasic.All`,
   `GroupMember.Read.All`, `AgentIdentity.Read.All` (D18); the plane never
   writes to Entra and the gateway never calls Graph.
6. **Group grants are token-only** (no subscription, no key); precedence is
   direct grant first, then the most generous enabled group grant within the
   same cost center; group counters are keyed by the member's `oid`; group
   overage (`_claim_names` / `hasgroups`) fails closed with the remedy "direct
   grant".
7. App-only tokens authorize through `roles`; a missing, empty or `/` `scp`
   means not delegated.

## Consequences

- Operators assign nothing new to let someone use the marketplace; they do
  assign the application role to applications and agents (directly or via an
  inheritable blueprint permission).
- Membership changes take effect when tokens expire (about an hour).
- Callers in more than 200 groups need direct grants.
- Tenants that block user consent for OpenID scopes need an administrator to
  consent `openid profile offline_access` for the model client; documented,
  not automated, verified live in W3.

## Alternatives rejected

- Mosaic's `Admin`/`User` app roles on Loom's sign-in app (Loom's capability
  model and the session already express them); APIM developer-portal users and groups
  as the identity model (gateway-local, no agents, no tokens); expanding group
  members into direct grants (drift, churn); calling Graph from the gateway
  (latency, coupling).

## Verification

`verify-model-access.mjs` matrix in `TEST-STRATEGY.md` § 3 on Commercial and
GCC-High; W0-4 records Agent ID availability per boundary before
`agentIdentity` principals are enabled there.
