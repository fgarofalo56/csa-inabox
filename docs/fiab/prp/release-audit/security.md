# CSA Loom — Public-Release Security Audit (dimension: security)

Scope: `apps/fiab-console` (Next.js App Router BFF + Fluent v9), plus the Bicep that
wires its auth secrets. Read-only review. Every finding below cites file:line I
actually read. The CSP `script-src 'unsafe-inline'` tradeoff behind Front Door is
explicitly out of scope per the task and is NOT reported.

Overall: the core cookie-session crypto (AES-256-GCM, HKDF-separated keys,
HttpOnly/Secure) is well built — BUT see Finding 1b: on the shipped param files
its **root key defaults to a predictable value**, which nullifies the crypto for
any deploy that doesn't manually set `LOOM_SESSION_SECRET`. The T-SQL
parameterization path is solid. The material
risks are (1) a **predictable, offline-derivable shared service-auth token**
(`LOOM_INTERNAL_TOKEN = guid(resourceGroup().id, const)`) that gates
internet-reachable impersonation/deploy endpoints, (1b) the **session-cookie
signing key falls back to the same predictable `guid(rg.id, const)` class** when
`LOOM_SESSION_SECRET` is unset — and no shipped param file sets it, (2) an **authenticated SSRF**
in the MCP "test connection" surface with no admin gate and no URL restriction,
(3) **no OAuth `state`/PKCE** (login CSRF), and (4) **rate limiting default-off
with near-zero coverage**.

---

## Finding 1b — HIGH (release blocker, added by main-loop spot-check 2026-07-02) — Session-cookie signing key defaults to a predictable `guid(rg.id, const)` when `LOOM_SESSION_SECRET` is unset, and NO shipped param file sets it

**Evidence**
- Fallback derivation: `platform/fiab/bicep/modules/admin-plane/main.bicep:3863`
  `{ name: 'session-secret', value: empty(loomSessionSecret) ? guid(resourceGroup().id, 'loom-session-secret-v1') : loomSessionSecret }`.
  Same predictable-secret class as Finding 1 — a deterministic hash of the
  (non-secret) resource-group id + a public literal.
- The param defaults empty and is only sourced from an env var that a stranger
  won't know to set: `main.bicep:1045` / `platform/fiab/bicep/main.bicep:786`
  `param loomSessionSecret string = ''`;
  `params/commercial-full.bicepparam:215` +
  `params/tenant-dmlz.bicepparam:143`
  `param loomSessionSecret = readEnvironmentVariable('LOOM_SESSION_SECRET', '')`.
  No param file supplies a value → the predictable fallback is what ships.
- Consumer: `lib/auth/session.ts` derives the AES-256-GCM cookie keys via HKDF
  from this `session-secret`. If the root secret is predictable, the whole
  otherwise-sound cookie crypto is forgeable: anyone who can determine the
  target RG's resource id (sub id + RG name — not secrets) can mint a valid
  `loom_session` cookie for any `oid` against an internet-reachable Front Door
  origin → full session forgery / impersonation, and (given Finding 1's
  `tenantId==oid` model) admin access.

**Impact:** Session forgery on any deploy that left `LOOM_SESSION_SECRET` unset —
which, per the gov-deployer audit, is every deploy a customer does from the
documented path. Strictly worse than Finding 1 (auth boundary, not just the
internal-tool boundary).

**Fix (folds into rel-T10 / gate G5):** default the secret from a
Key-Vault-random `newGuid()`-seeded secret generated at deploy time (or a
`utcNow()`-seeded `deploymentScript` writing to KV), NEVER `guid(rg.id, const)`;
make the console FAIL FAST (refuse to boot) if `session-secret` resolves to the
predictable form; document `LOOM_SESSION_SECRET` as a required deploy input in
the rewritten quickstart (rel-T01). Same remediation covers `loomInternalToken`
(Finding 1) and `loomBuiltinMcpApiKey` (`main.bicep:1669`, same class).

---

## Finding 1 — HIGH — Predictable, offline-derivable `LOOM_INTERNAL_TOKEN` gates internet-reachable impersonation + deploy endpoints

**Evidence**
- Derivation: `platform/fiab/bicep/modules/admin-plane/main.bicep:301`
  `var loomInternalToken = guid(resourceGroup().id, 'loom-maf-internal-token-v1')`.
  Bicep `guid()` is a deterministic hash of ONLY its string args. Both inputs are
  non-secret: `resourceGroup().id` = `/subscriptions/<subId>/resourceGroups/<rg>`
  and the literal `'loom-maf-internal-token-v1'` is in the public repo. Anyone who
  knows the subscription id + RG name (not secrets) can reproduce the token
  offline with a public ARM-`guid()` reimplementation.
- Wired to Console env when any opt-in flag is on:
  `main.bicep:3843-3844` / `3898-3899`
  `(copilotMafActive || loomIqMcpEnabled || loomPipelineCiEnabled) ? [{ name:'LOOM_INTERNAL_TOKEN', secretRef:'loom-internal-token' }]`.
- Internet-reachable: Front Door route pattern is `/*`
  (`platform/fiab/bicep/modules/admin-plane/front-door.bicep:327 patternsToMatch: ['/*']`)
  — it forwards `/api/internal/*` and `/api/iq/mcp` to the external Console origin.
- Impersonation endpoint: `app/api/internal/copilot/tools/[name]/invoke/route.ts:36-70`
  gates ONLY on `isValidInternalToken(x-loom-internal-token)` then trusts a
  caller-supplied `x-user-oid` header as the `ToolContext` identity — tool
  handlers run with THAT user's ownership. A caller with the token can act as ANY
  user (`session:{claims:{oid:userOid,upn:userOid}}`).
- IQ MCP external surface: `app/api/iq/mcp/route.ts:17-18,63-71` accepts
  `Authorization: Bearer <LOOM_IQ_MCP_TOKEN | LOOM_INTERNAL_TOKEN>` + `x-user-oid`
  — same fallback to the derivable token.
- Deploy/CI path: `main.bicep:270-271` — `loomPipelineCiEnabled` gives the Console
  `LOOM_INTERNAL_TOKEN` as the "default Bearer secret" for
  `/api/deployment-pipelines/loom/**` (drive deploys/management). The param doc
  itself concedes: "set a dedicated LOOM_CI_TOKEN Key Vault secret to isolate CI"
  — i.e. the shared derivable token is the default.
- Token check itself is correct (constant-time, fail-closed):
  `lib/auth/internal-token.ts:27-34`. The weakness is the token's ENTROPY, not the
  comparison.

**Why it matters / exploit**: When the Gov MAF tier (`copilotMafActive`, a headline
GCC-High/IL5 feature), the external IQ-MCP surface, or the CI path is enabled, an
attacker who knows the (non-secret) subscription id + resource-group name computes
the token offline, then POSTs to `https://<console-fqdn>/api/internal/copilot/tools/<tool>/invoke`
with `x-loom-internal-token` + `x-user-oid: <victim oid>` to create/modify items,
run build-assist tools, or (CI path) drive deployments as any user. No brute
force, no per-tenant randomness.

**Not exploitable in a default Commercial deploy** (all three flags default off →
`LOOM_INTERNAL_TOKEN` unset → endpoints fail closed, `internal-token.ts:28`), which
is why this is HIGH not CRITICAL. But it is release-blocking for the Gov/MAF and
external-agent configurations that are explicitly shipped.

**Fix**: derive from a non-deterministic secret — `guid(newGuid())` stored once in
Key Vault, or a KV-generated random secret — never `guid(resourceGroup().id, <public const>)`.
Give each surface (MAF, IQ-MCP, CI) its own random secret. Consider restricting
`/api/internal/*` at Front Door (separate route excluding the pattern, or a WAF
rule) so it is only reachable on the CAE internal network as the code comments
already assume (`lib/auth/internal-token.ts:11-14`).

---

## Finding 2 — MEDIUM — Authenticated SSRF in `/api/admin/mcp-servers/test-connection` (no admin gate, no URL restriction)

**Evidence**
- `app/api/admin/mcp-servers/test-connection/route.ts:21-27` authorizes with ONLY
  `getSession()` (any authenticated user) — no `requireTenantAdmin` (compare the
  many sibling admin routes that DO call it, e.g. `app/api/admin/tenant-settings`,
  `app/api/admin/users`). It then validates only `config.endpoint && config.authMethod`
  — no scheme check, no host allow-list, no private-IP block.
- `route.ts:55` → `listMcpTools(config.endpoint, …)` →
  `lib/azure/mcp-client.ts:161-193 initializeSession()` POSTs a JSON-RPC body to
  the endpoint URL verbatim via `fetchWithTimeout`.
- The server's response is reflected to the caller: HTTP status + first 200 chars
  of the body on failure (`mcp-client.ts:188-191`) and tool
  names/descriptions on success (`route.ts:56-60`) — a semi-blind SSRF oracle.
- The persist route's `sanitize()` at least calls `new URL(out.endpoint)`
  (`app/api/admin/mcp-servers/route.ts:80-84`) but still does not enforce
  `https:` or block internal hosts; test-connection skips even that parse.

**Exploit**: any signed-in user POSTs `{config:{endpoint:"http://169.254.169.254/…"
| "http://<internal-cae-service>/…", authMethod:"header"}}` and the Console
issues the request from inside the VNet, leaking status/body back. Reaches
internal Container Apps, metadata, and other private endpoints the pod can route
to.

**Fix**: gate on `requireTenantAdmin`; require `https:`; block RFC-1918 / link-local
/ metadata hosts (169.254.169.254, `*.internal`, loopback) after DNS resolution;
consider an egress allow-list.

---

## Finding 3 — MEDIUM — OAuth authorization-code flow has no `state`/PKCE (login CSRF)

**Evidence**
- `app/auth/sign-in/route.ts:88-94` builds `getAuthCodeUrl({ scopes, redirectUri,
  prompt })` with NO `state` and NO `codeChallenge`, and sets no state cookie.
- `app/auth/callback/route.ts:231-252` reads `code` from the query and calls
  `acquireTokenByCode({ code, scopes, redirectUri })` with NO `state` validation.
- `grep -i "state|nonce|pkce|csrf"` over `app/auth/**` returns zero matches.
- Session cookie is `SameSite=Lax` (`lib/auth/session.ts:79,102` and
  `app/auth/callback/route.ts:226`), not `Strict` — contradicting the
  `msal.ts:4-5` comment ("SameSite=Strict"). Lax does not stop a top-level
  cross-site GET to `/auth/callback`.

**Exploit (login CSRF / session fixation)**: an attacker initiates the flow, obtains
a valid `code` for the attacker's own account, and lures a victim to
`https://<console>/auth/callback?code=<attacker_code>`. The callback mints a
session cookie for the ATTACKER's identity in the victim's browser; the victim
then unknowingly operates in the attacker-controlled account (uploads data,
configures items) that the attacker can later read. The `state` parameter is the
standard defense and is absent.

**Fix**: generate a random `state` (and PKCE `code_verifier`), store it in a
short-lived HttpOnly cookie at sign-in, and reject the callback unless
`state` matches.

---

## Finding 4 — MEDIUM — Rate limiting is default-OFF and wired into only 4 routes

**Evidence**
- `lib/azure/rate-limiter.ts:69-71` `rateLimitEnabled()` returns true only when
  `LOOM_RATE_LIMIT === 'on'`; unset ⇒ `checkRate` always ok / `withRateLimit`
  always null (`:92-94`).
- Only 4 API routes import it (`grep withRateLimit/checkRate app/api` →
  `admin/workspaces`, `items/[type]/[id]/assist`, `governance/govern/copilot`,
  `copilot/complete`). Auth, query-execution, provisioning, download, and the
  SSRF-adjacent surfaces are unthrottled.
- Even when on, it is in-proc per-pod (`:66-67`), so multi-replica deployments get
  a fraction of the intended budget and it resets on restart (acknowledged
  `:18-22`).

**Why it matters for a public release**: unauthenticated-adjacent and
authenticated abuse of expensive endpoints (AOAI completions, Synapse queries,
provisioning, geocoding fan-out) → cost blow-up + DoS with no server-side brake.
Known/disclosed tradeoff (EH Phase-2), but release-relevant given the app is
internet-facing.

**Fix**: default `LOOM_RATE_LIMIT=on`, apply `withRateLimit` at the top of the
expensive route classes, and move to a durable cross-replica store (the module
already documents a Redis seam).

---

## Finding 5 — LOW — Admin routes have no shared gate; enforcement is per-route and inconsistent

**Evidence**
- No `middleware.ts` exists anywhere under `apps/fiab-console` (Glob confirms),
  so `/api/admin/*` is not globally protected; each route self-enforces.
- The `mcp-servers` CRUD route (`app/api/admin/mcp-servers/route.ts:108-110,127-131,
  156-160,199-203`) uses only `getSession()` — no `requireTenantAdmin` — unlike
  ~26 sibling admin routes that do. Data is partitioned by `tenantId = claims.oid`
  so there is no cross-tenant leak, but the pattern is inconsistent and is the
  same surface as the Finding-2 SSRF. (Deeper authz coverage is the access-control
  dimension's remit; noted here only where it enables the SSRF.)

**Fix**: add a consistent `requireTenantAdmin` (or a route-group guard) to every
`/api/admin/*` handler.

---

## Low-severity / hygiene notes (not separately scored)

- **Callback error detail in redirect URL**: `app/auth/callback/route.ts:307-309`
  reflects the AAD exchange exception message (first 80 chars) into
  `?auth_error=exchange_failed&detail=…`. Minor info disclosure; keep it generic.
- **SameSite mismatch vs. comment**: cookies are `Lax` while `msal.ts:4-5` claims
  `Strict`. Align the comment or tighten to `Strict` (folds into Finding 3).
- **PII discipline is good**: the callback hashes the UPN before logging
  (`callback/route.ts:278-282`), `piiLoggingEnabled:false` in MSAL
  (`msal.ts:305`). No raw tokens logged on the paths reviewed.
- **Secrets not echoed to client**: the MCP config view strips `authValue` and
  returns `hasAuthValue` only (`app/api/admin/mcp-servers/route.ts:27-36`); KV
  `secretRefs` hold names, not values. Good.
- **T-SQL is parameterized**: `lib/azure/synapse-sql-client.ts:180-193,210-211`
  binds via `req.input()` (`sp_executesql`), never string-splices values. The SQL
  *editor* runs arbitrary `sqlText` by design (SSMS parity), under the caller's or
  the service identity — expected, not an injection bug.
- **RLS/DAX compilers** (`lib/azure/rls-compiler.ts`, `kusto-rls-predicate.ts`)
  escape string literals (`sqlString`/`sparkString`) and `safeIdent()` columns,
  and block KQL control commands / `;` in RLS predicates. Inputs are
  admin-authored policy, not end-user data — low risk.
- **Supply chain**: `package.json` deps are current (`next 15.5.18`,
  `react 19.1`, `@azure/msal-node 2.16`, `@azure/identity 4.5`, `mssql 11`). No
  obviously stale critical dependency.
- **Session crypto**: AES-256-GCM with HKDF-separated keys for cookie vs.
  at-rest (`lib/auth/session.ts:36-41,113-118`), auth-tag verified on decode,
  `exp` checked (`:71`). Sound.
