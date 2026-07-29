# CSA Loom — architecture security audit, 2026-07-29

**Scope:** the questions scanners cannot answer — *is it safe, is it protected, does it
open vulnerabilities for customers?* Commercial + Azure Government / IL5.

**Method:** manual read of the authorization layer, a classifier over all 1,657 BFF route
handlers, targeted class sweeps, the bicep network/secret wiring, and the live CodeQL
alert set (305 open). Every claim below cites `file:line` at commit `45afb58d`.

**Bottom line.** The *designed* security model is good — genuinely better than most
platforms this size. The session crypto, the workspace ACL resolver, the SSRF core, the
PAT store, and the internal-token gate are all careful, well-reasoned work with the
threat written down in the comments. The problem is **not the design, it is the
uniformity of its application.** Loom has ~1,657 route handlers and only 555 reference
any authorization primitive stronger than "is there a session cookie." That gap is where
every finding below lives. Two of them are, in my assessment, currently exploitable to
full cross-tenant data disclosure, and one of those also allows destructive data loss.

I recommend treating F1 and F2 as incident-grade.

---

## Severity summary

| # | Finding | Severity | Exploitable by |
|---|---------|----------|----------------|
| F1 | Cosmos "navigator" is pointed at Loom's own control-plane account; session-only read/write/delete | **Critical** | any signed-in user |
| F2 | `/api/auth/cli-session` mints a Loom session from *any* Entra tenant's SP credentials | **Critical** | anyone on the internet |
| F3 | KQL query route ignores its own ownership check + honours a caller-supplied database | **High** | any signed-in user |
| F4 | 46 of 69 data-plane query/execute routes run as the shared Console UAMI behind a bare session | **High** | any signed-in user |
| F5 | Ops-Copilot ARM mutation gate defaults OFF | **High** | any signed-in user |
| F6 | Delta Sharing egress surface: no admin gate, zero audit rows | **Medium-High** | any signed-in user |
| F7 | `loom-unity` authz silently disabled (#2643, still live on `main`); internal ≠ isolated | **Medium** | anything on the VNet |
| F8 | Webhook SSRF guard is a string check, not the repo's own DNS-resolving guard | **Medium** | tenant admin |
| F9 | `loom-dab-preview` has public ingress + a plain connection-string secret + `anonymous` role is expressible | **Medium** | tenant admin |
| F10 | Hard-coded Commercial token audiences on Gov code paths | **Low-Medium** | n/a (breaks Gov) |
| F11 | `/api/org-reports/render` exposes estate-wide cost/Defender/inventory to any session | **Low-Medium** | any signed-in user |
| **F0** | **the merge-blocking route-guard ratchet cannot see 201 of 1,657 route handlers** | **systemic** | — |

---

## 0. Why the merge-blocker did not catch any of this

Loom already has the exact guardrail I would otherwise have recommended:
`scripts/ci/check-route-guards.mjs`, a merge-blocker whose header states the rule precisely
— *"a BFF route that reads or mutates another user's / tenant's data must authorize the
CALLER against that data — not merely confirm the caller is signed in."* It runs green:

```
[route-guards] scanned 1469 session-based routes across app/api
[route-guards] violations: 0
[route-guards] OK — every session-based item/admin route is authorized or allowlisted.
```

It is green while F1, F3 and F5 are all live. Three independent defeats, each verified:

**(a) The detection predicate misses any route that wraps its session check.** The ratchet
only treats a file as a "session-based route" if that file *itself* contains
`getSession(`. The F1 routes authenticate through `requireSession()` — a one-line wrapper
in `app/api/cosmos/_shared.ts:21-26` — so they contain **zero** occurrences and are never
scanned at all:

```
$ grep -c "getSession(" apps/fiab-console/app/api/cosmos/items/route.ts          → 0
$ grep -c "getSession(" apps/fiab-console/app/api/cosmos/items/action/route.ts   → 0
$ grep -c "getSession(" apps/fiab-console/app/api/cosmos/containers/route.ts     → 0
$ grep -c "getSession(" apps/fiab-console/app/api/cosmos/items/rerank/route.ts   → 1
```

**Mutation proof.** I copied the ratchet into `scripts/ci/` (so `REPO_ROOT` resolves
identically), disabled *only* the `['apps/fiab-console/app/api/cosmos/', ...]` class-prefix
allowlist entry, and re-ran it. If the allowlist were what hid F1, all ten
`/api/cosmos/*` handlers would appear. Exactly **one** did:

```
[route-guards] violations: 1
  - apps/fiab-console/app/api/cosmos/items/rerank/route.ts
```

— the only one that calls `getSession()` directly. `items`, `items/action`, `databases`,
`containers`, `scripts/execute` stayed invisible *with the allowlist removed*. The
allowlist is a red herring; the predicate is the hole. (Probe deleted after the run; the
committed ratchet is unmodified.)

Sweep for the general shape (`temp/sweep-ratchet-blindspot.mjs`):

```
route files with a real handler          : 1657
INVISIBLE to check-route-guards.mjs      : 201
  ...of which authenticate via a wrapper : 74
```

Those 74 include all 10 `/api/cosmos/*` routes and all 11 `/api/adx/*` routes. Many are
genuinely safe — the five `admin/workspaces/[id]/networking/*` routes go through the real
`authorizeNetworking` admin gate. That is not the point. The point is that **nothing
prevents a hole from being introduced in any of the 201**, because the merge-blocker never
looks at them.

**(b) The ratchet accepts the presence of a guard call as proof of enforcement.**
`loadKustoItem` is an accepted authorization signal (line 91, with a comment explaining it
"threads the caller tenant into the item read the same way loadOwnedItem does"). That is
true of the *function*. F3's route calls it and then **discards the result** — every use is
optional-chained. Substring present, enforcement absent, ratchet satisfied.

**(c) One accepted signal returns `true` by default.** `callerIsOpsAdmin` is on the
accepted list (line 85) under the comment *"all real admin-tier authz, not a bare session."*
But it short-circuits to `true` when `LOOM_OPS_ADMIN_ENTRA_GROUP` is empty
(`app/api/admin/ops-copilot/route.ts:47-48`), and bicep defaults that param to `''`
(`main.bicep:759`). The signal that convinced the ratchet is a function that authorises
everyone on a default deployment. `/execute` does not call it at all and passes on the
`session.claims.oid` signal instead.

**Recommendation — the highest-leverage fix in this document.**

1. Resolve the session check **transitively**: if a route imports a local helper, follow
   the import and inherit that helper's signals. A one-hop resolution covers all 74.
2. Change the scan population from "files containing `getSession(`" to **"files exporting a
   route handler"** — 1,657, not 1,469 — and require every one to be authorized *or*
   allowlisted. Invisibility should be impossible, not the default for a wrapper.
3. Stop accepting a bare identifier as proof. At minimum require that a guard's result is
   consumed (assigned and branched on, or returned) — that alone flags F3.
4. Re-audit the 316 per-route and 35 class-prefix allowlist entries. The
   `['apps/fiab-console/app/api/cosmos/', 'C: Cosmos rerank utility over deployment config
   (no per-tenant item read by id)']` entry describes **one** route and silently exempts a
   whole tree that reads, writes and drops Loom's control-plane store. A class prefix
   should require a reason per route, or be forbidden for trees containing mutating verbs.

This is the same lesson already recorded in this repo's own history — a required gate
passing while measuring nothing. It is worth fixing the gate before, or alongside, the
findings it missed.

---

## 1. Multi-tenant isolation

### F1 — CRITICAL: the Cosmos Data Explorer is pointed at Loom's own control plane

**Evidence.**

The "Cosmos DB account navigator" is meant to browse a *customer's* Cosmos account. Its
config helper is explicit that this is a different account from Loom's own store:

`apps/fiab-console/lib/azure/cosmos-account-client.ts:92-94`
```
'Set LOOM_COSMOS_ACCOUNT (the Cosmos DB account name to navigate — distinct '
+ "from Loom's own LOOM_COSMOS_ENDPOINT store), ..."
```

The bicep does not honour that separation. `LOOM_COSMOS_ACCOUNT` falls back to
`loomCosmosAccount` — the same account name used to build `LOOM_COSMOS_ENDPOINT`:

- `platform/fiab/bicep/modules/admin-plane/main.bicep:1249`
  `var effCosmosAccount = !empty(existingCosmosAccount) ? existingCosmosAccount : loomCosmosAccount`
- `platform/fiab/bicep/modules/admin-plane/main.bicep:3721` — `LOOM_COSMOS_ACCOUNT = effCosmosAccount`
- `platform/fiab/bicep/modules/admin-plane/main.bicep:3766` — `LOOM_COSMOS_ENDPOINT = https://${loomCosmosAccount}.documents...`

So on any deployment that does not set a BYO `cosmosAccount`, **the navigator is
Loom's own control-plane store** — the account holding `workspaces`, `items`,
`workspace-roles`, `feature-permissions`, `tenant-settings`
(`apps/fiab-console/lib/azure/cosmos-client.ts:809,814,874,1015`).

Every route over it is guarded by a session cookie and nothing else. `requireSession()`
is the whole check (`apps/fiab-console/app/api/cosmos/_shared.ts:21-26`), applied at 20
handlers — `app/api/cosmos/items/route.ts:51,84`,
`app/api/cosmos/items/action/route.ts:47`, `app/api/cosmos/databases/route.ts:21,32,51`,
`app/api/cosmos/containers/route.ts:23,36,64`, and the rest. There is no container
allowlist anywhere in the navigator (sweep in §Class sweeps returned nothing).

The database and container names are free-form caller input, and cross-partition
querying is **on by default**:

`apps/fiab-console/app/api/cosmos/items/route.ts:55-67`
```ts
if (!body.db?.trim()) return ... 'db is required' ...
if (!body.container?.trim()) return ... 'container is required' ...
const query = (body.query && body.query.trim()) || DEFAULT_QUERY;   // SELECT * FROM c
const result = await queryItems(body.db.trim(), body.container.trim(), query, {
  crossPartition: body.crossPartition !== false,                    // default TRUE
```

And the identity behind it is account-scoped Data Contributor:

`platform/fiab/bicep/modules/landing-zone/cosmos.bicep:589-597`
```bicep
roleDefinitionId: '${account.id}/sqlRoleDefinitions/00000000-0000-0000-0000-000000000002'
principalId: consolePrincipalId
scope: account.id
```

**Real-world impact.** Any authenticated user — a Viewer in one workspace, a guest, or
(via F2) anyone on the internet — can:

- `POST /api/cosmos/items {"db":"loom","container":"items","query":"SELECT * FROM c"}`
  → **every item document of every tenant**, cross-partition, ignoring `workspace-roles`,
  the `tid` boundary, and the feature gate entirely. The Cosmos partitioning that the
  entire isolation model rests on is bypassed because the query is issued against the
  raw data plane, not through `loadOwnedItem`.
- `POST /api/cosmos/items/action` (`upsertItem`, `apps/fiab-console/app/api/cosmos/items/action/route.ts:27,60`)
  → write a `feature-permissions` row granting themselves `Admin`
  (`lib/auth/feature-gate.ts:98-109` reads exactly that container), or a `workspace-roles`
  row making themselves Owner of any workspace.
- `DELETE /api/cosmos/containers?db=loom&container=items`
  (`app/api/cosmos/containers/route.ts:64,73`) → **irreversible destruction of every
  tenant's data.**

This is a complete failure of multi-tenant isolation plus a destructive-action path, in
a federal multi-tenant platform, reachable from a normal user session.

**Recommendation.** Prefer the structural fix over adding a guard:

1. **Make the bug unexpressible.** Refuse to serve the navigator at all when the resolved
   `LOOM_COSMOS_ACCOUNT` equals the account in `LOOM_COSMOS_ENDPOINT`. Enforce it in
   `cosmosConfigGate()` so *every* one of the 20 handlers inherits it from one place, and
   assert it in bicep so the two can never be wired to the same account again.
2. Gate the navigator on `requireTenantAdmin` regardless — browsing an arbitrary Cosmos
   account with a platform identity is an admin operation, not a user one.
3. Give the navigator its **own** identity with a data-plane role scoped to the BYO
   account only, so the Console UAMI's rights on the Loom store are not in reach of this
   code path at all.

---

### F3 — HIGH: the KQL query route discards its own ownership check

**Evidence.** `apps/fiab-console/app/api/items/kql-database/[id]/query/route.ts:36,44,56`

```ts
const item = await loadKustoItem(params.id, 'kql-database', session.claims.oid);
...
if (item?.state?.isFollower) { /* block .drop/.ingest/.purge/... */ }
...
const database = (body?.db && String(body.db)) || resolveDatabase(item);
```

`loadKustoItem` is a correct guard — it returns `null` when the caller's tenant does not
own the item's workspace (`lib/azure/kusto-client.ts:2010-2018`). **The route never checks
for null.** Every subsequent use is optional-chained (`item?.state`, `item?.workspaceId`),
so a denied lookup falls through silently, and `resolveDatabase(null)` returns `DEFAULT_DB`
(`lib/azure/kusto-client.ts:2057-2072`). Worse, a caller-supplied `body.db` takes
precedence over the item-derived database.

**Real-world impact.** `POST /api/items/kql-database/anything/query` with
`{"kql":"SomeTable | take 1000","db":"<any database on the cluster>"}` executes against
any ADX database on the shared cluster as the Console UAMI. Because `item` is null, the
read-only-follower guard is also skipped, so control commands (`.drop`, `.purge`,
`.ingest`, `.alter`) reach the cluster (`isMgmt` routes them to `executeMgmtCommand`,
line 93). Cross-tenant read *and* write on the Eventhouse/ADX plane.

**This exact class was already found and fixed correctly — one route over.**
`apps/fiab-console/app/api/adx/anomaly/route.ts:200-231` is the reference implementation:

```
//   (a) ITEM CONTEXT — ... We owner-check it and DERIVE the allowed database; an
//       explicit body.database is honored only when it equals that database.
//   (b) NO ITEM CONTEXT — ... restricted to tenant admins (requireTenantAdmin).
```

The sibling route kept the bug. This is the repo's documented recurring failure mode:
the reported call site was fixed, the class was not swept.

**Recommendation.** Extract the `adx/anomaly` logic into one
`resolveAuthorizedAdxDatabase(session, itemId, requestedDb)` helper and route **both**
call sites (and any future one) through it, so an unowned item can only ever produce a
403, never a fallback database.

---

### What I checked here and found SOUND

- **`tenantId` is never taken from the request body.** Sweep for
  `tenantId = body|payload|json|req|params` across `app/api` → **zero hits.** Tenant
  identity comes from the session claim via `tenantScopeId()`
  (`lib/auth/session.ts:85-87`). This is the single most important thing to get right and
  it is right.
- **The workspace ACL resolver is careful and correct.**
  `lib/auth/workspace-access.ts:109-150` runs owner fast-path → kill-switch → cross-partition
  resolve → **`tid` boundary** (line 134) → ACL → admin-open bypass, in that order, with the
  reasoning written down. `canWrite` is restricted to Owner/Admin/Member (line 57) so
  sharing cannot escalate a Viewer into a writer.
- **404-not-403 discipline.** `withWorkspaceOwner` returns `apiNotFound()` on denial
  (`lib/api/route-toolkit.ts:136-137`) so item ids cannot be probed for existence across
  tenants. `authorizeWorkspace` does the same (`lib/auth/workspace-guard.ts:62`).
- **The one cross-partition workspace read is admin-gated first.**
  `lib/auth/workspace-guard.ts:147-150` — `isTenantAdmin` is checked *before*
  `loadWorkspaceAdmin`, with a comment explaining that this is the only such path.
- **Feature grants are partition-scoped** and fail closed on a Cosmos error
  (`lib/auth/feature-gate.ts:108,133-139`).
- **`external-shares` is a model of how this should be done** — ownership verified before
  sharing (`app/api/external-shares/route.ts:33-51`), the shared subset validated to sit
  under the item's storage root (line 110-114), and only the addressed guest may accept
  (`app/api/external-shares/[id]/accept/route.ts:33-35`).

### Limits

I could not verify partition-key enforcement at runtime, or whether any deployment has
actually set a BYO `cosmosAccount` (which would mitigate F1 for that estate). Confirming
F1's live blast radius needs a read-only probe of the deployed `LOOM_COSMOS_ACCOUNT`
value against `LOOM_COSMOS_ENDPOINT` on each estate.

---

## 2. AuthN / AuthZ consistency

### F2 — CRITICAL: `/api/auth/cli-session` is an authentication bypass

**Evidence.** `apps/fiab-console/app/api/auth/cli-session/route.ts:98-121`

```ts
if (flow === 'service-principal') {
  const clientId     = body?.clientId    as string | undefined;
  const clientSecret = body?.clientSecret as string | undefined;
  const tenantId     = (body?.tenantId as string | undefined) || process.env.AZURE_TENANT_ID!;
  ...
  const cca = getSpConfidentialClient(clientId, clientSecret, tenantId);
  const result = await cca.acquireTokenByClientCredential({ scopes: [`${graphBase()}/.default`] });
  ...
  const claims: UserClaims = { oid, name, upn: clientId, email: undefined };
  const cookie = encodeSessionCookie({ claims, exp });
  return NextResponse.json({ ok: true, cookie, ... },
    { status: 200, headers: { 'set-cookie': setCookieHeader(cookie) } });
}
```

`getSpConfidentialClient` builds the authority from that caller-supplied tenant with no
allowlist (`lib/auth/msal.ts:357-370` → `getAuthority(tenantId)` → `lib/auth/msal.ts:35-37`).
**Nothing checks `tenantId === process.env.AZURE_TENANT_ID`.** The route has no session
requirement (it is the login endpoint), no rate limit, and there is no Next.js middleware
in `apps/fiab-console` to gate it.

**Real-world impact.** An attacker registers a free app registration in *their own* Entra
tenant, then:

```
POST https://<loom-host>/api/auth/cli-session
{"flow":"service-principal","clientId":"<theirs>","clientSecret":"<theirs>","tenantId":"<theirs>"}
```

Azure issues them a client-credentials token in their own tenant (any app can get
`graph/.default`); Loom decodes it, takes the `oid`, and **mints a valid, encrypted
`loom_session` cookie.** The attacker is now a signed-in Loom user.

They land in their own `oid` partition, so they do not immediately own workspaces — but
that is exactly the point: **every "any signed-in user" finding in this document
(F1, F3, F4, F5, F6, F11) becomes reachable by an unauthenticated internet attacker.**
Chained with F1 that is unauthenticated read and destruction of all customer data.

Note also that this session carries **no `tid` claim** (line 117 sets only `oid`, `name`,
`upn`), so the `tid` boundary check at `lib/auth/workspace-access.ts:134` — which requires
`opts.callerTid` to be truthy — is skipped for these sessions.

**Recommendation.** Structural, not filtering:

1. Reject any `tenantId` that is not `process.env.AZURE_TENANT_ID`. The parameter should
   not exist — derive the authority from deployment config only.
2. Require the SP's `oid` to be on an explicit allowlist (`LOOM_CLI_ALLOWED_SP_OIDS`),
   the same pattern `validateInternalOid` already uses
   (`lib/auth/internal-token.ts:71-80`). A CI principal is enumerable; a user is not.
3. Set `tid` on the minted claims so the tenant boundary applies to CLI sessions too.
4. Make the whole flow opt-in behind an env var, fail-closed when unset — the same
   posture `isValidInternalToken` takes (`lib/auth/internal-token.ts:45`).
5. Rate-limit it with `enforceRateLimitForKey(clientIp(...))`
   (`lib/azure/rate-limiter.ts:245,263`).

The device-code branch (line 143, `getMsalPublicClient(tenantOverride)`) takes a caller
`tenantId` too. That one is bounded by the Loom app registration's `signInAudience` — if
the app is single-tenant it fails. I could not verify `signInAudience` from the repo; it
is a deployment-time property. **Verify it, and remove the override regardless.**

---

### F5 — HIGH: the Ops-Copilot ARM mutation gate defaults to OFF

**Evidence.**
- `apps/fiab-console/app/api/admin/ops-copilot/route.ts:47`
  `const groupId = (process.env.LOOM_OPS_ADMIN_ENTRA_GROUP || '').trim(); if (!groupId) return true;`
- `platform/fiab/bicep/modules/admin-plane/main.bicep:759`
  `param loomOpsAdminEntraGroup string = ''` — **the default is empty**, wired straight to
  the env var at line 3225.
- Neither route checks `isTenantAdmin`. `app/api/admin/ops-copilot/route.ts:95-97` and
  `app/api/admin/ops-copilot/execute/route.ts:31-33` check only `getSession()`.

The header comment says "Unset env → any signed-in **admin**, matching the rest of the
admin pane." That is not what the code does — being under `/api/admin/` confers nothing.
It is any signed-in **user**.

**Real-world impact.** On a default deployment, any authenticated user can classify and
execute real ARM mutations through the Console UAMI
(`lib/copilot/ops-tools.ts:333-386`): `scale_sql_pool` (Synapse SKU change — cost),
`scale_adx` (ADX SKU/capacity — cost), and `toggle_oap` — which flips the Synapse
workspace **outbound-access / trusted-service-bypass policy**, a network security control.
`/execute` additionally never re-checks group membership, so a user removed from the ops
group can still execute a previously staged intention.

**Recommendation.** Add `requireTenantAdmin(session)` to **both** routes as the floor, keep
the Entra-group check as the additional narrowing control, and make an unset
`LOOM_OPS_ADMIN_ENTRA_GROUP` fail **closed** rather than open. Re-run
`callerIsOpsAdmin` inside `/execute` — the staged-intention doc should not be a capability.

---

### F4 — HIGH: 46 of 69 data-plane query routes are session-only against a shared identity

**Evidence.** Full sweep in §Class sweeps. The clearest instance:

`apps/fiab-console/app/api/items/synapse-serverless-sql-pool/[id]/query/route.ts:24`
```ts
export const POST = withSession(async (req: NextRequest, { session, params }) => {
```

There is no ownership check on `[id]`. The target is env-pinned
(`serverlessTarget(database)`), and the sibling route says so out loud —
`app/api/items/sql-analytics-endpoint/[id]/query/route.ts:11-13`: *"The endpoint is
env-pinned (LOOM_SYNAPSE_WORKSPACE) and **id-agnostic for execution**."* The default
identity is the platform's: `lib/azure/sql-access-mode.ts:56-72`, `resolveAccessMode`
returns `'service'` for a missing item, a missing state, or any error.

**Real-world impact.** Any authenticated user can `POST` arbitrary T-SQL — including
`OPENROWSET` over the lake — and it executes with the Console UAMI's Synapse rights,
which in this estate include SQL-admin-level grants. That reads across every workspace
and every tenant partition. Cosmos-level isolation is irrelevant because the data plane
is reached with a shared identity.

I want to be precise about the CodeQL overlap here: the 5 open `js/sql-injection` alerts
(`azure-sql-client.ts:412,541`, `synapse-sql-client.ts:257`,
`postgres-flex-client.ts:628,629`) are **not the bug**. These are query editors; executing
user-supplied SQL is the product. The vulnerability is *whose credentials* run it and
*which routes* can reach it. Fixing the alerts by parameterising would not close F4;
fixing F4 does not clear the alerts. They should be dismissed as by-design with that
reasoning recorded.

**Recommendation.** Introduce `withDataPlaneItem(itemType, handler)` that resolves the
item through `loadOwnedItem` and **fails closed on null**, then migrate all 46 routes onto
it. Where the backend is genuinely deployment-wide rather than per-item (serverless SQL,
the shared warehouse), require tenant-admin or per-user OBO — do not let a shared identity
serve an unscoped route. Longer term, make `accessMode: 'user'` the default and
`'service'` the opt-in.

### What I checked here and found SOUND

- **The wrapper layer itself is well built.** `lib/api/route-toolkit.ts` composes
  session → owner → admin → DLZ → backend-gate correctly, with the gate *inside* the
  session check so an unauthenticated caller never learns deployment config (lines 199-205).
  555 routes use it. The problem is the 958 that do not.
- **`requireTenantAdmin`** is a claims-only synchronous check with an honest remediation
  body (`lib/auth/feature-gate.ts:155-175`), applied at 175 admin route files.
- **Networking routes are properly gated**, and the comment records the exact bug that
  motivated it — "*a bare authenticated session used to be the ONLY check, which let ANY
  signed-in user POST an Allow 0.0.0.0/0 rule*"
  (`app/api/admin/workspaces/[id]/networking/_gate.ts:76-104`). This is the right way to
  fix a class.
- **PAT sessions are correctly subordinate.** SHA-256 hashed secrets with a timing-safe
  compare (`lib/auth/pat.ts:149,162`), expiry + revocation (lines 203, 260), read-only
  scope rejects mutating verbs, and admin scope requires the *creator* to still be a
  tenant admin at use time (`lib/auth/api-session.ts:61-87`). The cookie path strictly
  wins so browser behaviour is unchanged.
- **`/api/notebook/execute` honestly returns 501** rather than pretending
  (`app/api/notebook/execute/route.ts:43`) — a stub that was correctly *not* faked.
- **The internal service-to-service gate is textbook**: constant-time compare over
  SHA-256 digests so length does not leak, **fail-closed** when the secret is unset,
  per-service secret isolation via `preferEnv`, and defence-in-depth GUID validation of
  the forwarded `x-user-oid` so a leaked token cannot write into an arbitrary partition
  (`lib/auth/internal-token.ts:39-80`).

---

## 3. Secret handling

**No credential is logged in production code.** All 6 open
`py/clear-text-logging-sensitive-data` alerts are false positives and none is in the
product — see §Dismissed.

**Key Vault vs plain ACA secrets.** 24 `keyVaultUrl` secretrefs across the bicep. The
security-critical two — `SESSION_SECRET` and the MSAL client secret — are KV-backed when
the app-registration bootstrap has run, with an explicit inline fallback otherwise
(`main.bicep:4782-4783`, `4798-4800`). That is a defensible, documented trade-off, not an
oversight.

**The session-secret derivation is right, and the team clearly thought about it.**
`main.bicep:1436-1438`:

> *"Defaults to `newGuid()` so these are UNPREDICTABLE (never `guid(resourceGroup().id,
> <public-const>)`, which is offline-derivable from the sub id + RG name — a
> session/impersonation forgery vector)."*

That is exactly the attack, and it is avoided. `loomInternalToken`, `loomIqMcpToken`,
`loomCiToken`, the Airflow password and the built-in MCP key all derive from the same
`newGuid()` seed (`main.bicep:630,644,645,741,2168`). Good.

**Residual (Low).** Plain-value ACA secrets remain for `dab-conn`
(`dab-runtime.bicep:92` — a live SQL connection string), `pg-conn`, `admin-password`,
`webserver-secret-key` (`airflow.bicep:287-289`) and `spark-la-key`
(`main.bicep:4786`). ACA secrets are encrypted at rest, but any principal with
Contributor on the Container App can read them back via `az containerapp secret show`,
whereas a KV secretref adds a separate RBAC boundary and an access log. For a federal
estate, move at least `dab-conn` to a `keyVaultUrl` secretref.

**Token audience.** No over-broad audience found — every `getToken` requests a
`.default` scope for the specific service. The issue is the opposite: several are pinned
to the *wrong sovereign cloud* (F10).

---

## 4. Data egress

Surfaces that move data outside the boundary: Delta Sharing, external shares, outbound
webhooks, the MCP/A2A bridges, DAB, and the feedback forwarder.

### F6 — MEDIUM-HIGH: Delta Sharing has no admin gate and no audit trail at all

**Evidence.** All seven handlers are session-only:
`app/api/marketplace/sharing/recipients/route.ts:22,34`, `recipients/[name]/route.ts:14,27`,
`shares/route.ts:17,29`, `shares/[name]/route.ts:22,38,61`, `providers/route.ts:17,39`,
`providers/[name]/route.ts:22,38,65`, `catalogs/route.ts:33,61`, `query/route.ts:78`.

Creating a recipient — which mints a bearer credential handed to an **external
organisation** — needs nothing but a session:

`app/api/marketplace/sharing/recipients/route.ts:33-53`
```ts
export async function POST(req: NextRequest) {
  const s = getSession();
  if (!s) return ... 401 ...
  ...
  const recipient = await createRecipient(host, { name, authentication_type: authType, ... });
```

**A grep for `recordAudit|writeAudit|auditLog|appendAudit` across the entire
`app/api/marketplace/sharing/` tree returns zero hits** — no audit row for allows, and
none for denials either. The `sharingErrorResponse` mapper (`_lib.ts:47-70`) converts a
Databricks `PERMISSION_DENIED` into a UI gate and drops it on the floor.

`sharing/query/route.ts:78` additionally runs caller-supplied SQL against the Databricks
SQL warehouse via `runWarehouseStatement` (`lib/azure/databricks-client.ts:619-639`) — the
platform's warehouse identity, not the user's. The `READ_ONLY_LEADING` / `MUTATING` guard
(lines 46-47) limits verbs but not *which catalog* is read.

**Real-world impact.** An unprivileged internal user (or an F2 attacker) can create an
external recipient, add tables to a share, grant it, and exfiltrate data to a third party
— with no approval step and **no record that it happened**. For a federal customer the
missing audit trail is arguably worse than the missing gate: there is no way to answer
"what left, and when."

**Recommendation.** `requireTenantAdmin` on recipient/share/provider mutations, and route
every one through an audit emitter that records **denials as well as allows**. Loom
already has the emitters (`lib/admin/audit-stream.ts`, `emitLoomEvent`) and already does
denial-auditing correctly elsewhere — `lib/auth/pat.ts:286` `auditUseDenied`. Reuse it.

### F8 — MEDIUM: webhook egress uses a weaker guard than the repo's own

**Evidence.** Loom has a proper SSRF core — `lib/azure/egress-ssrf.ts` — that requires
`https`, **resolves A/AAAA records and rejects any that land in a private, loopback,
link-local, unique-local or IPv4-mapped-IPv6 range** (lines 178-196), plus an operator
allowlist. `mcp-egress-guard.ts` and `a2a-egress-guard.ts` both use it.

The webhook registry does not. `lib/events/webhook-registry.ts:108-117`:
```ts
if (parsed.protocol !== 'https:') return { ok: false, error: 'url must use https' };
const host = parsed.hostname.toLowerCase();
if (host === 'localhost' || host === '127.0.0.1' || host === '::1' ||
    host === '169.254.169.254' || host.endsWith('.local')) { ... reject ... }
```

A string equality list. `https://127.0.0.2`, `https://10.0.0.5`, `https://[::ffff:127.0.0.1]`,
a decimal-encoded IP, or any attacker-controlled DNS name pointing at a VNet address all
pass. Delivery is a real server-side POST from the Console — which sits inside the VNet
with private endpoints — and **the response body is captured and shown back to the user**:
`lib/events/webhook-emitter.ts:153` `snippet = (await res.text()...).slice(0, 300)`,
surfaced as `responseSnippet` "for the history drawer"
(`lib/events/webhook-registry.ts:65-66`). That is a read SSRF, not a blind one.

**Honest severity: Medium, not Critical** — registration is properly tenant-admin gated
(`app/api/admin/webhooks/route.ts:32,45`; `[id]/test/route.ts:27`), so this is an admin
crossing a network boundary they were not granted, not a user-to-admin escalation. It
matters because it reaches exactly the unauthenticated internal services in F7.

**Recommendation.** Delete the hand-rolled check and call `assertEgressAllowed` with a
`LOOM_WEBHOOK_EGRESS_ALLOW` policy. One guard, three callers.

### F9 — MEDIUM: `loom-dab-preview` is internet-facing with a plaintext DB credential

`platform/fiab/bicep/modules/admin-plane/dab-runtime.bicep:86` — `external: true`, one of
only two public Container Apps. Line 92 holds the SQL connection string as a plain ACA
secret. The DAB config model permits a `role: 'anonymous'` permission on an entity and the
validator only requires that at least one permission exists
(`app/api/dab/_lib/dab-config-model.ts:401-402`).

Applying config is correctly tenant-admin gated
(`app/api/dab/[id]/apply-to-runtime/route.ts:64-67`), so this is a blast-radius concern
rather than a live hole: one admin action can publish an anonymous, unauthenticated,
internet-reachable REST/GraphQL API over a customer database. In a federal boundary that
should not be one click away. Add an explicit `anonymous`-role refusal (or a second
confirmation + audit row), and put IP restrictions on the app.

### What I checked here and found SOUND

- **The SSRF core itself is excellent** — IPv4 + IPv6 + IPv4-mapped, CGNAT, an allowlist
  that doubles as the air-gap posture, and it **documents its own residual**
  (DNS-rebinding TOCTOU, `egress-ssrf.ts:32-35`) instead of overclaiming.
- **Webhooks are signed** (HMAC-SHA256 + timestamp + delivery id, `webhook-emitter.ts:137-145`)
  and the signing secret is redacted before any hook is returned to a client
  (`webhook-registry.ts:73-75`).
- **The feedback forwarder is genuinely well designed for a sovereign estate**
  (`app/api/feedback/route.ts:138-160`): a tenant *hash* rather than a tenant id, a
  redaction module, an admin kill-switch for auto-error forwarding, and it degrades to a
  local log when `LOOM_FEEDBACK_GITHUB_TOKEN` is unset — so an air-gapped deployment
  emits nothing. Residual: the free-text description is user-supplied and does reach a
  public GitHub issue when a token *is* configured; that should be off by default in Gov.

---

## 5. Network posture

**Good baseline.** Only **two** Container Apps have public ingress: the Console
(`main.bicep:3013`) and `loom-dab-preview` (`dab-runtime.bicep:86`). Twenty-one modules
are `external: false`. Private endpoints and a hub VNet are used throughout.

### F7 — MEDIUM: internal-only is being relied on as isolation, and one service has no auth at all

Issue **#2643 is still live on `main`.** `platform/fiab/bicep/modules/compute/loom-unity-app.bicep:193-194`
still reads:

```bicep
var audiencePinned = !empty(entraClientId) || !empty(entraAudiences)
var authEnabled = authMode == 'entra' && audiencePinned
```

The fix (#2638) — `authEnabled = authMode == 'entra'`, so an unpinned audience aborts the
boot instead of silently disabling authorization — has not landed. The module's own output
description admits the consequence (line 486): *"FALSE means the catalog is reachable
anonymously by anything that can reach it on the network."*

The same image runs the Iceberg REST catalog with **no auth env at all**
(`platform/fiab/bicep/modules/data-plane/iceberg-catalog-aca.bicep`), justified by a
comment that *"BFF is the sole public door"* (line 159). That assumption is exactly what
F8 breaks, and what any compromised sidecar breaks.

**Only 1 of 21 internal-ingress modules sets `ipSecurityRestrictions`** (grep returns
`loom-unity-app.bicep` alone) — and in the Gov deploy `consoleAllowedCidrs` was left unset
anyway. So "internal" currently means "reachable by every workload on the VNet," with a
catalog that mints ADLS delegation SAS at the end of it.

**Recommendation.** Land #2638. Then apply the same treatment to the Iceberg catalog, and
set `ipSecurityRestrictions` to the Console subnet on all 21 internal apps as a standing
default — defence in depth, so a single compromised in-VNet workload is not equivalent to
a platform compromise.

### F10 — LOW-MEDIUM: Commercial token audiences hard-coded on Gov paths

`lib/azure/cloud-endpoints.ts` is the single source of truth and it is well built — a
per-cloud truth table verified against Learn (lines 22-30), a 4-way `LoomCloud`
discriminator that keeps GCC distinct, and `graphScope()` / `graphBase()` helpers
(lines 323-335). Several call sites bypass it:

| Site | Hard-coded audience | Gov should be |
|---|---|---|
| `app/api/admin/permissions/principals/route.ts:29,31` | `graph.microsoft.com` | `graph.microsoft.us` |
| `app/api/lakehouse/permissions/route.ts:116` | `graph.microsoft.com` | `graph.microsoft.us` |
| `app/api/data-products/route.ts:136`, `app/api/governance-domains/route.ts:70`, `lib/install/provisioners/data-product.ts:54` | `purview.azure.net` | Gov Purview audience |
| `lib/azure/loom-search.ts:44`, `loom-docs-index.ts:143`, `memory-vector-index.ts:56`, `lib/install/provisioners/ai-search.ts:45` | `search.azure.com` | verify per cloud |
| `lib/azure/gremlin-client.ts:95` | `cosmos.azure.com` | verify per cloud |

Not exploitable — it is a **functional** failure in the sovereign path. The
`/admin/permissions` principal picker is the one that hurts: it is how an admin delegates
access, so in Gov an admin cannot add grantees and is pushed toward the
`LOOM_TENANT_ADMIN_*` bootstrap instead. A class sweep + migration onto `graphScope()`
and its siblings closes all of them.

**Fabric/Power BI on the default path:** the only `api.fabric.microsoft.com` token
acquisitions are in `lib/install/provisioners/{eventstream,report,semantic-model}.ts` —
opt-in Fabric backends per `no-fabric-dependency.md`. I did **not** verify at runtime that
each has an Azure-native fallback ahead of it in the same function; that is worth a
separate targeted pass.

---

## 6. Findings I investigated and dismissed

Recording these so the coverage claim is honest and the alerts can be closed with reasons.

1. **All 6 `py/clear-text-logging-sensitive-data` alerts — false positives, and none is in
   the product.** Every one is under `examples/`, not `apps/`:
   - `examples/supercharge-fabric/notebooks/silver/07_silver_tribal_health.py:143` logs the
     **count** of SSN-pattern matches (`f"WARNING: {col_name} contains {ssn_count} SSN-like values!"`)
     — this is an SSN *detector* reporting zero, flagged because a variable is named
     `ssn_pattern`. Same shape as the ReDoS-pattern-as-data case in alert #692.
   - `examples/supercharge-fabric/notebooks/bronze/02_bronze_player_profile.py:236,237` print
     the constant `VALID_GENDERS` list and an invalid-value count.
   - `examples/interior/data/open-data/fetch_usgs_nps.py:116` logs a public USGS/NPS URL and
     its params (unauthenticated open-data API).
   - `examples/usps/.../fetch_usps_data.py:300` and `examples/epa/.../fetch_epa_data.py:346`
     log a ZIP code and an exception from a public Census/AirNow API.
   **No credential is logged in any of them.** Dismiss as false positive; do not weaken the
   SSN scanner to clear the alert. The prompt's premise that these are "6 production hits"
   is incorrect — worth correcting in the tracking issue.

2. **`managementApiBase` is not an SSRF sink.** `/api/org-reports/render` accepts a
   caller-supplied `managementApiBase` (`route.ts:165,180`) which lands in
   `ReportParams.managementApiBase` (`live-bindings.ts:113`). I traced every use: it is
   **never** a fetch target. The ARM host used for the token-bearing call is the
   module-level `const ARM = armBase()` (`live-bindings.ts:147`, used at line 177). Grep for
   `managementApiBase` across the app returns 13 hits, all type declarations, assignment, or
   UI display. It is a display-only field. No managed-identity token is sent anywhere the
   caller chooses.

3. **The 5 `js/sql-injection` alerts are by design.** `azure-sql-client.ts:412,541`,
   `synapse-sql-client.ts:257`, `postgres-flex-client.ts:628,629` are the execution paths of
   SQL *query editors*. The named-parameter paths alongside them bind correctly
   (`azure-sql-client.ts:540` `request.input('p'+i, v)`; `synapse-sql-client.ts:252`
   `bindParams`). Dismiss with reason — but note the real issue is F4 (whose identity runs
   the statement), which those alerts do not describe.

4. **The Cosmos *navigator* being session-only is not, by itself, the bug.** Browsing a
   genuinely separate BYO customer account with a scoped identity would be defensible. F1
   exists because the bicep defaults that account to Loom's own store. I want the fix aimed
   at the wiring, not just at adding an admin check.

5. **`/api/debug/cookie` is adequately protected.** It requires
   `?secret=<LOOM_VERSION>` and 404s otherwise (`app/api/debug/cookie/route.ts:20-23`), and
   returns only fixed dummy cookies — no session material.

6. **`/api/internal/*` is properly gated.** These looked unguarded to a naive classifier but
   authenticate via `isValidInternalToken` (e.g. `internal/scheduler/tick/route.ts:24,44-51`),
   which is fail-closed and timing-safe.

7. **The `/admin/workspaces/[id]/networking/*` routes** looked unguarded for the same reason;
   they route through `authorizeNetworking` in `_gate.ts:119-140`, which is correct.

---

## 7. Class sweeps run

Reproducible; each is the sweep behind a finding, not a spot check.

```bash
# 1. Every route handler, classified by strongest authorization primitive referenced.
#    Result: 1657 total / 555 strong guard / 958 session-only (649 mutating) / 144 no ref.
node temp/audit-routes.mjs

# 2. Data-plane query/execute/run routes.  Result: 69 total / 20 guarded / 46 SESSION-ONLY.  (F4)
node temp/sweep-query.mjs

# 3. Tenant id from the request body — the highest-consequence shape.  Result: ZERO hits.
grep -rnE "tenantId\s*[:=]\s*(body|payload|json|req\.|params)" apps/fiab-console/app/api

# 4. Every session-minting site.  Result: 3 — cli-session (x2), auth/callback, refresh.  (F2)
grep -rn "encodeSessionCookie" apps/ --include=*.ts | grep -v __tests__

# 5. Every caller-controllable MSAL authority.  Result: cli-session ONLY; class closed.  (F2)
grep -rn "getAuthority(\|getMsalPublicClient(\|getSpConfidentialClient(" apps/ --include=*.ts

# 6. Caller-supplied backend target overriding an item-derived one.  (F3)
grep -rnE "body\??\.(db|database|cluster|server|warehouse|catalog|host|endpoint|resourceId|subscriptionId)\b" \
  apps/fiab-console/app/api --include=route.ts

# 7. Admin routes with no admin-level guard.  Result: 11, of which 9 are false
#    positives (shared _gate / domain-role helpers).  Real: ops-copilot x2.  (F5)
grep -rL -E "requireTenantAdmin|withTenantAdmin|isTenantAdmin|resolveAdminWorkspace|authorizeWorkspace|\
requireWorkspace|enforceCapability|withWorkspaceOwner|withDlzAccess|denyIfNoDlzAccess" \
  --include=route.ts apps/fiab-console/app/api/admin

# 8. Audit coverage of the Delta Sharing egress surface.  Result: ZERO.  (F6)
grep -rn "recordAudit\|writeAudit\|auditLog\|appendAudit" apps/fiab-console/app/api/marketplace/sharing/

# 9. Egress guards: which callers use the shared DNS-resolving core?  (F8)
grep -rn "assertEgressAllowed" apps/fiab-console/lib   # mcp-egress-guard, a2a-egress-guard — NOT webhook-registry

# 10. Network posture.  Result: 2 external:true; 21 internal; 1 with ipSecurityRestrictions.  (F7)
grep -rn "external:" platform/fiab/bicep/modules/ --include=*.bicep
grep -rln "ipSecurityRestrictions" platform/fiab/bicep/modules/

# 11. Sovereign-cloud audience leaks.  Result: 13 hard-coded .com/.net scopes.  (F10)
grep -rnE "getToken\(\s*['\`]https://[a-z0-9.-]+\.(com|net)" apps/fiab-console/lib apps/fiab-console/app --include=*.ts

# 12. Plain-value ACA secrets vs Key Vault secretrefs.  Result: 24 KV / 13 plain.  (§3)
grep -rn "keyVaultUrl" platform/fiab/bicep/modules/ --include=*.bicep

# 13. Route handlers INVISIBLE to the merge-blocking ratchet.  (F0)
#     Result: 1657 handlers / 201 invisible / 74 of those wrapper-authenticated.
node temp/sweep-ratchet-blindspot.mjs

# 14. F0 mutation proof — disable ONLY the cosmos class-prefix allowlist and re-run.
#     If the allowlist were what hid F1, all 10 /api/cosmos/* routes would appear.
#     Exactly 1 did (items/rerank — the only one calling getSession() directly),
#     proving the detection predicate, not the allowlist, is the hole.
grep -c "getSession(" apps/fiab-console/app/api/cosmos/items/route.ts        # → 0
grep -c "getSession(" apps/fiab-console/app/api/cosmos/items/action/route.ts # → 0
grep -c "getSession(" apps/fiab-console/app/api/cosmos/containers/route.ts   # → 0
grep -c "getSession(" apps/fiab-console/app/api/cosmos/items/rerank/route.ts # → 1
```

The two `node` scripts above are throwaway analysis helpers under `temp/` (gitignored).
They are reproduced in full in the PR description so the numbers can be re-derived.

---

## 8. What I checked and found SOUND — consolidated

Coverage signal, so the absence of a finding in an area means something.

**Cryptography.** AES-256-GCM with an HKDF-derived key and an authenticated tag
(`lib/auth/session.ts:89-115`); a **separate** HKDF `info` label for at-rest encryption so
a leaked at-rest blob can never be replayed as a session cookie (lines 144-157); cookies
are `HttpOnly; Secure; SameSite=Lax` (line 141); expiry checked on decode (line 110).

**Sign-in.** PKCE code-verifier and OIDC nonce both enforced on the callback
(`app/auth/callback/route.ts:313-329`), against a fixed deployment authority.

**PII in logs.** The UPN is deliberately **not** logged — a salted SHA-256 fingerprint is,
with the reasoning written out (`app/auth/callback/route.ts:359-368`). This is unusually
disciplined.

**Rate limiting.** Keyed on a trusted hop via `trustedClientIp`, with the previous
`x-forwarded-for.split(',')[0]` bug and its consequence recorded in the comment
(`lib/azure/rate-limiter.ts:253-265`). Applied on the query routes.

**Fail-closed defaults** in the places that matter: the feature gate on a Cosmos error
(`feature-gate.ts:133-139`), the internal token when unset (`internal-token.ts:45`), the
ops-admin group check on a Graph outage (`ops-copilot/route.ts:52-56`), and
`resolveAccessMode` degrading to a working path. F5 is the notable exception where a
default fails *open*.

**Denial auditing exists and works** — `lib/auth/pat.ts:231,286` audits unknown-id,
bad-secret, revoked and expired token uses. The pattern is available; Delta Sharing (F6)
just does not call it.

**Secret derivation** avoids the `guid(resourceGroup().id, …)` forgery vector explicitly
(`main.bicep:1436-1438`).

**Honest gating throughout.** The `no-vaporware` discipline has a real security dividend:
gates name the exact missing env var or role instead of failing silently, which means
misconfiguration surfaces rather than degrading into an unprotected state. F7 is the
counter-example and it is already filed.

---

## 9. Limits of this audit — what I could NOT verify

Stated plainly so this is not read as full coverage.

1. **No live probe was run.** Everything here is static analysis at `45afb58d`. I did not
   execute any request against Commercial or Gov. F1, F2 and F3 are read from the code and
   the bicep and I am confident in them, but each deserves a confirming probe with a minted
   session before remediation is scoped.
2. **Deployment-time values are unknown.** Whether any estate sets a BYO `cosmosAccount`
   (mitigates F1), whether `LOOM_OPS_ADMIN_ENTRA_GROUP` is set in practice (mitigates F5),
   and the Entra app's `signInAudience` (bounds the F2 device-code branch) are all runtime
   facts not in the repo.
3. **No Gov-side verification at all.** F10's Gov impact is inferred from the endpoint
   truth table, not observed. The Gov estate needs its own probe run.
4. **Databricks / Unity Catalog internal authorization not assessed.** F6 covers the Loom
   BFF gap; whether UC's own grants would independently stop an unprivileged user is
   untested.
5. **The remaining 300 CodeQL alerts were not individually triaged** — I examined the
   classes named in the brief (credential logging, SSRF, SQLi) plus what the architecture
   review surfaced. The 44 `js/incomplete-sanitization`, 35 `js/polynomial-redos`, 25
   `js/insecure-randomness` and 20 `py/stack-trace-exposure` alerts remain open work
   (tracked as task #22). `js/insecure-randomness` in particular deserves a pass — if any
   instance generates a token, id or secret rather than a UI key, it is a real finding.
6. **Client-side code was not reviewed** — XSS, unsafe `dangerouslySetInnerHTML`, and
   token handling in the browser are out of scope here. One open `js/reflected-xss` alert
   exists.
7. **No dependency/supply-chain assessment** beyond noting the 46 Dependabot findings.

---

## 10. Recommended order of work

1. **F1** — decouple `LOOM_COSMOS_ACCOUNT` from `loomCosmosAccount`; refuse to serve the
   navigator when they match; add `requireTenantAdmin`. *Cross-tenant read, write and
   destructive delete.*
2. **F2** — pin the `cli-session` authority to the deployment tenant and allowlist SP oids.
   *Unauthenticated attackers currently inherit every finding below.*
3. **F3** — one shared `resolveAuthorizedAdxDatabase`, both call sites, fail-closed on a
   null item.
4. **F5** — `requireTenantAdmin` on both ops-copilot routes; unset group fails closed.
5. **F7** — land #2638; extend to the Iceberg catalog; `ipSecurityRestrictions` on all 21
   internal apps.
6. **F6** — admin-gate Delta Sharing mutations and wire denial auditing.
7. **F4** — the migration: `withDataPlaneItem` across 46 routes. Largest, and the one that
   permanently closes the class.
8. **F8, F9, F10, F11** — consolidate egress onto `assertEgressAllowed`; IP-restrict DAB;
   sweep sovereign audiences onto the `cloud-endpoints` helpers.
9. Then dismiss the alerts listed in §6 **with the written reasons recorded**, so the next
   audit does not re-litigate them.

Do **F0 first or in parallel** — repairing the ratchet is what stops the next one.

A closing note on process. F3 is the most instructive finding in this document: the class
was correctly identified, correctly fixed, and correctly *documented* in
`app/api/adx/anomaly/route.ts` — and the identical bug survived one directory away because
the fix was applied to the reported call site rather than swept across the shape. The same
is true of F8 (a correct shared SSRF guard that one caller does not use) and F10 (correct
sovereign helpers that thirteen call sites bypass).

The instinct here is consistently good — the guards, the SSRF core, the fail-closed
defaults and the honest gates are the work of people who thought about the adversary. What
is missing is the mechanical step that proves a shape is gone *everywhere*. Loom even built
that step (`check-route-guards.mjs`) and wrote the right rule at the top of it; F0 is the
finding that it silently stopped covering the places the holes moved to. A guardrail that
reports "1469 scanned, 0 violations" while three live cross-tenant paths sit outside its
scan population is more dangerous than no guardrail, because it converts an open question
into a false answer.
