# Access-Control & Multi-Tenancy — Public-Release Audit

**Dimension:** access-control · **Console:** `apps/fiab-console` (Next.js App Router BFF)
**Date:** 2026-07-02 · **Scope:** session lifecycle, workspace/item authorization, admin-plane
gating, the CI route-guard, per-item ACL / RLS-CLS posture.

## How authorization works here (the model that everything hangs on)

The single most important fact about this codebase's authz model is that **"tenant" ==
the individual signed-in user's Entra `oid`**, not the Entra tenant id (`tid`). This is
stated verbatim in `lib/auth/feature-gate.ts:91` (`const tenantId = session.claims.oid; //
tenantId == owning user oid in this codebase`) and is applied everywhere:

- `app/api/workspaces/route.ts:89` sets `tenantId: session.claims.oid` on workspace create.
- Every owner check (`loadOwnedItem` at `app/api/items/_lib/item-crud.ts:192`,
  `loadWorkspace` at `app/api/workspaces/[id]/items/route.ts:15`, `assertOwner` in
  `lib/auth/workspace-guard.ts:25`, `resolveWorkspaceRole` in `lib/auth/workspace-role.ts:29`)
  point-reads the workspace on partition key `= caller's own oid` and returns 404 if the
  workspace's `tenantId !== caller oid`.

The good news: this makes cross-user reads on the item routes **fail closed** — a signed-in
user can only ever resolve resources in their own `oid` partition, so the recurring "gated
only on getSession → cross-tenant read" bug class is genuinely contained on the routes that
thread these helpers. The bad news is documented in Finding 1: it also makes every
multi-user collaboration feature non-functional, because a *second* user is, by definition,
a different partition.

The session cookie itself is sound: `lib/auth/session.ts` uses AES-256-GCM (authenticated
encryption) with an HKDF-derived key from `SESSION_SECRET`, checks `exp`
(`session.ts:71`), and sets `HttpOnly; Secure; SameSite=Lax` (`session.ts:79,102`). At-rest
helpers use a distinct HKDF `info` label so a leaked at-rest blob can't be replayed as a
cookie (`session.ts:116`). No signature-bypass or downgrade issues found.

---

## Finding 1 (HIGH) — `tenantId == oid` makes workspace sharing + feature-grant delegation non-functional

The console ships four separate delegated-access surfaces:
- workspace members (`app/api/workspaces/[id]/permissions/route.ts`)
- workspace RBAC role assignments (`app/api/workspaces/[id]/role-assignments/route.ts`)
- feature-permission grants at `/admin/permissions` (`app/api/admin/permissions/grants/route.ts`)
- domain admin/contributor tiers (`lib/auth/domain-role.ts`)

None of them can actually grant a **second** user access through the Loom BFF, because
every read path partitions by the *caller's own* oid:

- **Feature grants** are written with `tenantId = s.claims.oid` (the granting admin's oid,
  `grants/route.ts:61`), but `checkCapability` looks them up with `tenantId =
  session.claims.oid` (the *grantee's* oid, `feature-gate.ts:91,96-104`,
  `{ partitionKey: tenantId }`). A grant created by admin A for user B is stored in A's
  partition and searched for in B's partition → it can never match. Delegated
  Reader/Contributor/Admin at `/admin/permissions` is therefore inert; only an
  env-configured tenant admin (`LOOM_TENANT_ADMIN_OID` / `_GROUP_ID`) ever passes
  `enforceCapability`. This is a Fabric-parity feature (item/feature-level RBAC) that renders
  and POSTs but has zero runtime effect — a `no-vaporware.md` violation on that surface.

- **Workspace members / role rows**: `POST /api/workspaces/[id]/permissions` writes a member
  row, but the member can never *resolve* the workspace — `loadWorkspace(id,
  MEMBER_oid)` reads partition `MEMBER_oid` while the workspace lives in `OWNER_oid`
  (`workspaces/[id]/items/route.ts:32` + `:15-24`). A shared workspace and all its items
  return 404 to the member through every console read path. (Azure RBAC *is* mirrored to the
  DLZ RG by `workspace-roles-client.ts`, so a member can reach the raw ADLS/SQL directly —
  but not through Loom's own UI, which is the product.)

**Impact:** For a platform positioned as a multi-user Microsoft-Fabric replacement, this is a
broken core capability: two users in the same org cannot collaborate on a workspace or be
delegated feature access through the console. The correct model is `tenantId = Entra `tid``
(shared across the org) with per-resource ACL, not `oid`. Security-wise the current model is
conservative (no leak), but the sharing/permission UIs are effectively vaporware.
**Evidence:** `lib/auth/feature-gate.ts:91`, `app/api/admin/permissions/grants/route.ts:61`
vs `feature-gate.ts:96-104`, `app/api/workspaces/[id]/items/route.ts:15-24,32`.

---

## Finding 2 (HIGH) — OAuth authorization-code flow has no `state` parameter → login CSRF / session fixation

`app/auth/sign-in/route.ts:86-91` builds the auth URL with `getAuthCodeUrl({ scopes,
redirectUri, prompt })` — **no `state`** — and `app/auth/callback/route.ts:231-251` consumes
`?code=` and mints the session cookie **without validating any `state`/nonce** against the
initiating browser. There is also no PKCE (confidential client). The `state` parameter is the
standard OAuth CSRF defense; without it an attacker can capture their own valid `code` and
deliver `/auth/callback?code=<attacker_code>` to a victim (link / auto-submit), logging the
victim's browser into the **attacker's** account. The victim then unknowingly works inside the
attacker's account and may upload sensitive data into attacker-controlled workspaces, or have
their inputs captured. **Impact:** classic login-CSRF / session-fixation; embarrassing for a
public release. **Fix:** generate a random `state` (and ideally PKCE + nonce), store it in a
short-lived HttpOnly cookie at sign-in, and reject the callback if it doesn't match.
**Evidence:** `app/auth/sign-in/route.ts:86-91`, `app/auth/callback/route.ts:231-251`.

---

## Finding 3 (MEDIUM) — Two tenant-admin resolvers with OPPOSITE unconfigured-defaults; `isTenantAdminTier` fails OPEN

There are two admin resolvers:
- `isTenantAdmin` (`feature-gate.ts:66`) — strict; returns **false** when neither
  `LOOM_TENANT_ADMIN_OID` nor `_GROUP_ID` is set. Routes using `requireTenantAdmin` /
  `enforceCapability` therefore **fail closed** on an unconfigured deploy (chargeback,
  users, tenant-settings mutate, sensitivity-labels, env-config, self-audit remediate).
- `isTenantAdminTier` (`domain-role.ts:69-74`) — **default-allows every authenticated user**
  when neither env var is configured (`return !oidConfigured && !grpConfigured`).

Routes gated by `isTenantAdminTier` / `canAccessDlzPanes` therefore fail **open** on a
deploy that didn't set the (optional) admin env vars: `admin/capacity/cost`,
`admin/capacity/utilization`, `admin/capacity/viz-config` (all via `canAccessDlzPanes`,
`domain-role.ts:199-209`) and `spark/session-pool` (warm a shared pool). These read
**deployment-wide** Azure cost + utilization via the Console UAMI (not partitioned by user).
So on an unconfigured-but-plausible deploy, **any authenticated user reads org-wide cost and
capacity data and can warm compute** — while the fail-closed routes deny the same user. This
inconsistency is a privilege-escalation-by-default hazard for a public release unless the
deploy *forces* the admin binding. **Fix:** make the deploy require an admin principal, or make
`isTenantAdminTier` fail closed like its sibling. **Evidence:** `lib/auth/domain-role.ts:69-74`,
`app/api/admin/capacity/cost/route.ts:35`, `app/api/spark/session-pool/route.ts:20`.

---

## Finding 4 (MEDIUM) — CI route-guard only scans `items/**`, `admin/**`, `adx/**`; every other id-taking group is a blind spot

`scripts/ci/check-route-guards.mjs:402-407` builds its file list from exactly three roots:
`ITEMS_ROOT` (`app/api/items`), `ADMIN_DIR`, `ADX_DIR`. **Every other top-level route group
that reads/mutates a resource by an id from the URL is never scanned**, so a future
`getSession`-only cross-tenant regression there ships with a green CI. Groups outside the
scan that take `[id]`/`[itemId]`/`[jobId]` include: `dab`, `notebook`, `deployment-pipelines`,
`data-products`, `connections`, `cosmos-items`, `catalog/asset`, `foundry/computes`,
`loom/compute-targets`, `thread`, `realtime-hub`, `spark-environment`, `workspaces`. A scan
of those groups (excluding items/admin/adx) surfaced 25 id-routes that call `getSession`
without any owner-scoping helper. Most happen to be safe today (shared Azure backends, or
they self-scope via `loadConnection`/`loadItem` with `claims.oid`), but the guard gives
**false assurance** — it advertises "every session-based item/admin route is authorized" while
covering ~1/4 of the id-addressable surface. **Fix:** widen the walk to all of `app/api` (with
the same allowlist mechanism), or at minimum add the ownable groups above.
**Evidence:** `scripts/ci/check-route-guards.mjs:69-71,402-407`.

---

## Finding 5 (MEDIUM) — `data-products/[id]/preview` is explicitly NOT access-gated; discloses 25 rows of any product's data

`app/api/data-products/[id]/preview/route.ts:44-64` loads the data-product with a
**cross-partition** query (comment at `:50-52`: "NOT ownership-gated — data products are
discoverable by any authenticated catalog reader") and then runs `["<table>"] | take 25`
against the product's backing ADX database (`:97-100`). There is a full access-request /
access-policy workflow for data products (`app/api/data-products/[id]/access-requests/route.ts`
F15, `.../access-policy/route.ts`), but **preview bypasses it entirely** — any authenticated
user gets 25 real rows of *any* data product's underlying data regardless of whether their
access request was approved, and regardless of which user owns it (cross-partition). In a
shared deployment this is a cross-user data-sample disclosure that undercuts the marketplace's
own subscribe→access gate. **Fix:** gate preview on an approved access request / access policy
(or on ownership) the same way full access is gated. **Evidence:**
`app/api/data-products/[id]/preview/route.ts:50-64,97-100`.

---

## Finding 6 (MEDIUM) — `notebook/[id]/contents` ignores the item id and is path-addressable on a shared file share

`app/api/notebook/[id]/contents/route.ts` never uses the `[id]` route param — GET/PUT read the
`path` query param and call `contentsGet/contentsPut` against the **single shared** AML
Compute-Instance Jupyter file share (`:51-67`, `:70-86`). Any authenticated user can read or
overwrite **any** `.ipynb` on that shared share by supplying its path, with no per-user/per-
workspace scoping. This is the same "shared Azure backend resolved by type" class the CI
allowlist tolerates, and is benign under the single-user model — but under any multi-user
deployment it is cross-user notebook read/write. **Fix:** namespace notebook paths per user
(e.g. `Users/<oid>/…`) and reject paths outside the caller's prefix, or resolve the file
location from the owned Cosmos item rather than a free-form path. **Evidence:**
`app/api/notebook/[id]/contents/route.ts:51-67,70-86`.

---

## Finding 7 (LOW/MEDIUM) — PDP / RLS / CLS (per-item ABAC + row/column security) is default-OFF

`lib/auth/pdp/enforce.ts:40-43,149-150` — `pdpCheck` returns `null` immediately unless
`LOOM_PDP_ENFORCE` is `shadow`/`enforce`; default is `off`, meaning no Policy-Decision-Point
evaluation, and thus **no per-item ABAC and no row/column-level security** are enforced on the
default code path. Combined with Finding 1 (single-user partitions) the practical exposure is
low today, but a public release that advertises governance/RLS/CLS parity should ship at least
`shadow` wired-on with a documented path to `enforce`, and the policy authoring surfaces should
make clear the gate is inert until flipped. **Evidence:** `lib/auth/pdp/enforce.ts:40-43,149-150`.

---

## Finding 8 (LOW) — Internal service token trusts a caller-supplied `x-user-oid` (impersonation within the trust boundary)

`app/api/internal/copilot/tools/[name]/invoke/route.ts:36-43` authorizes with
`isValidInternalToken` (shared secret, constant-time, fails closed when unset —
`lib/auth/internal-token.ts:31-40`) and then executes tools **on behalf of** the
caller-supplied `x-user-oid` header. Anyone holding the internal token can therefore act as
any user's oid. This is by design (VNet-internal MAF tier, deterministic
`guid(resourceGroup().id)` secret) and fails closed when the env var is unset, so risk is low —
but it is a full-impersonation primitive that depends entirely on the token never leaking and
the endpoints never being exposed outside the CAE internal network. Worth an explicit note in
the threat model. **Evidence:** `app/api/internal/copilot/tools/[name]/invoke/route.ts:36-43`,
`lib/auth/internal-token.ts:31-40`.

---

## Things that are correct (so they aren't re-flagged elsewhere)

- Cookie crypto, `exp` enforcement, HttpOnly/Secure/SameSite=Lax, at-rest key separation
  (`lib/auth/session.ts`).
- `requireTenantAdmin` / `enforceCapability` routes fail closed on unconfigured admin env
  (chargeback, users, tenant-settings mutate, sensitivity-labels, env-config, self-audit
  remediate) — verified individually.
- The item CRUD owner helpers (`loadOwnedItem`, `updateOwnedItem`, `deleteOwnedItem`,
  `softDeleteOwnedItem`, `loadRecycledItem`) all re-verify workspace ownership by
  `tenantId` before returning/mutating (`item-crud.ts:191-218,342-541`).
- `connections/[id]` and `cosmos-items/[type]/[id]` self-scope by `claims.oid` even though
  they're outside the CI-guard scan (Finding 4), so they are safe today.
- Sliding-session refresh (`app/api/auth/refresh/route.ts`) re-mints only after a real
  cache-backed silent acquire and never returns/logs tokens; sign-out clears the cookie and
  federates to the AAD logout endpoint (`app/auth/sign-out/route.ts`).
- Debug/health/version/feedback/internal unauthenticated routes are all intentional and
  (except the internal token's impersonation note) benign; `debug/cookie` is `?secret=`-gated
  and returns 404 otherwise.
