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

## Round-2 corrections to this document (2026-07-29, after adversarial review)

The first revision of this audit **overstated its own coverage in two places.** Both are
corrected below and both were wrong in the direction that matters — a shape claimed closed
that is not closed. Recording them here rather than silently editing, because an audit that
quietly repairs its own claims is not auditable.

| # | What r1 claimed | What is actually true | Where |
|---|---|---|---|
| C1 | The 11 wrapper-authenticated `/api/adx/*` routes were folded into a bulk "many are genuinely safe" and never examined individually | **All 11 are session-only.** Their shared wrapper `guardAdxRequest` calls `loadKustoItem` and **discards the null** — the exact F3 defect, in a wrapper, times 27 handlers. One of them (`/api/adx/principals`) issues `.add database … admins` | §0.1, F3b |
| C2 | *"`tenantId` is never taken from the request body … zero hits. This is the single most important thing to get right and it is right."* | **False.** The sweep matched ONE syntax. Four call sites take a tenant/scope id from the request; one of them (`azure-sql-database/[id]/aad-admin`) takes `server` + `sid` + `tenantId` from the body behind a bare session and PUTs an Entra administrator onto an Azure SQL server | §1.5, F12 |

C2 is the more serious of the two, both because the claim was the strongest sentence in the
document and because chasing it down surfaced **F12** — a route that lets any signed-in user
nominate an arbitrary principal, in an arbitrary Entra tenant, as the AAD administrator of a
caller-chosen Azure SQL server, and its sibling **F13**, which re-opens a firewall hole the
audit had praised the platform for closing.

Three further corrections of the same kind, smaller. (a) The `x-user-oid` GUID validation
praised in §8 is a property of a helper used at **2 of the 3** header-forwarding routes, not
of the internal surface (§8). (b) F11 understated `/api/org-reports/render`: it also honours a
**caller-supplied `subscriptionId`** as the Azure Resource Graph query scope (F11). (c) r1's
"20 handlers, all 10 `/api/cosmos/*`" count for F1 is wrong — it is **22 handlers across 11
files**, and the eleventh file is outside the `/api/cosmos/` prefix, so neither r1's count nor
the ratchet's class-prefix allowlist reaches it; it discloses the account's ARM master keys
(F1).

One dismissal I re-argued and **upheld**: `managementApiBase` really is display-only. The
re-trace is in §6 #2 and it now cites the specific consumers.

Everything else in §8 and in the per-section "found SOUND" lists has been re-checked against
the call graph; the entries that survived now each carry a `file:line`. Entries I could not
re-verify to that standard were deleted rather than softened.

---

## Severity summary

| # | Finding | Severity | Exploitable by |
|---|---------|----------|----------------|
| F1 | Cosmos "navigator" is pointed at Loom's own control-plane account; session-only read/write/delete | **Critical** | any signed-in user |
| F2 | `/api/auth/cli-session` mints a Loom session from *any* Entra tenant's SP credentials | **Critical** | anyone on the internet |
| F12 | `azure-sql-database/[id]/aad-admin` PUT: caller-supplied `server` + `sid` + **`tenantId`** set the Entra admin of an Azure SQL server, behind a bare session | **High** | any signed-in user |
| F13 | `azure-sql-database/[id]/firewall` **and** `postgres-flexible-server/[id]/firewall` POST: caller-supplied `server` + IP range, behind a bare session — the `0.0.0.0/0` bug the networking gate was built to stop, four directories over | **High** | any signed-in user |
| F3 | KQL query route ignores its own ownership check + honours a caller-supplied database | **High** | any signed-in user |
| F3b | The shared ADX wrapper `guardAdxRequest` discards `loadKustoItem`'s null → **all 11** non-`anomaly` `/api/adx/*` routes are session-only over the shared cluster, incl. `.add database … admins` | **High** | any signed-in user |
| F4 | 46 of 69 data-plane query/execute routes run as the shared Console UAMI behind a bare session | **High** | any signed-in user |
| F5 | Ops-Copilot ARM mutation gate defaults OFF | **High** | any signed-in user |
| F6 | Delta Sharing egress surface: no admin gate, zero audit rows | **Medium-High** | any signed-in user |
| F7 | `loom-unity` authz silently disabled (#2643, still live on `main`); internal ≠ isolated | **Medium** | anything on the VNet |
| F8 | Webhook SSRF guard is a string check, not the repo's own DNS-resolving guard | **Medium** | tenant admin |
| F9 | `loom-dab-preview` has public ingress + a plain connection-string secret + `anonymous` role is expressible | **Medium** | tenant admin |
| F10 | Hard-coded Commercial token audiences on Gov code paths | **Low-Medium** | n/a (breaks Gov) |
| F11 | `/api/org-reports/render` is session-only **and** takes its ARG query scope (`subscriptionId`) from the caller | **Low-Medium** | any signed-in user |
| **F0** | **the merge-blocking route-guard ratchet cannot see 201 of 1,657 route handlers — and explicitly allowlists 231 more, two of which are F12 and F13** | **systemic** | — |

Severity notes, because two of these are bounded and saying so is part of being useful:
**F12** requires the Console UAMI to hold `Microsoft.Sql/servers/administrators/write`, which
bicep does not grant — but the platform's own docs say the Azure SQL schema browser needs
exactly that grant, set from exactly this route (`sql-rbac.bicep:15-22`), so any estate where
that browser works is exposed. **F1's key-disclosure sibling** is bounded by
`disableLocalAuth=true` on the DLZ account; the network-posture write in the same tree is not
bounded at all. Full reasoning in each finding.

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

Those 74 include all 10 `/api/cosmos/*` routes and all 11 wrapper-authenticated
`/api/adx/*` routes.

**Correction (r1 was wrong here).** r1 wrote *"Many are genuinely safe"* and moved on,
offering the five `admin/workspaces/[id]/networking/*` routes as the example. That sentence
did real damage: it let the `/api/adx/*` tree be counted as probably-fine without anyone
reading it. I have now read all twelve files individually — see §0.1. The networking example
is still correct (`authorizeNetworking`, `_gate.ts:119-140`). The ADX one is not: **11 of
the 12 enforce nothing beyond a session cookie**, and one of them grants ADX database
administrator. Do not read a bulk "many are safe" in a security document as coverage;
that is the failure mode the rest of §0 is about.

The point about the ratchet stands independently: **nothing prevents a hole from being
introduced in any of the 201**, because the merge-blocker never looks at them.

### 0.1 The 11 wrapper-authenticated `/api/adx/*` routes, individually

All twelve files import a single wrapper, `guardAdxRequest`
(`apps/fiab-console/app/api/adx/_shared.ts:49-89`). It is the *whole* authorization for
eleven of them. What it actually enforces:

1. `getSession()` → 401 if absent (`_shared.ts:50-53`). **That is the only mandatory check.**
2. `kustoConfigGate()` → honest 503 (`_shared.ts:60-68`). Config, not authz.
3. **Optionally** an ownership check — and only when the caller chooses to supply `?id=`:

```ts
// _shared.ts:70-80
const itemId = req.nextUrl.searchParams.get('id')?.trim() || null;
let database = defaultDatabase();                       // ← env-pinned shared DB
if (itemId && itemId !== 'new') {
  const item = await loadKustoItem(itemId, 'kql-database', session.claims.oid);
  database = resolveDatabase(item);                     // ← item is NEVER null-checked
}
```

Two independent ways this fails to authorize anything:

- **Omit `?id=` entirely** and no ownership code runs at all — `database` stays
  `defaultDatabase()` (`kusto-client.ts:31,135-136`), the shared cluster's default database.
- **Supply someone else's `?id=`** and `loadKustoItem` returns **`null`** — `kusto-client.ts:2014`
  (`if (!resource || resource.tenantId !== tenantId) return null`), plus `:2010` (no such item)
  and `:2016` (workspace not in the caller's partition). `resolveDatabase(null)` then returns
  `DEFAULT_DB` (`kusto-client.ts:2057-2072`). The denial is silently converted into "use the
  shared database."

That is **F3's defect, hoisted into a wrapper** — one discarded null covering 27 handlers.
Per-route, what each one actually enforces:

| Route (`app/api/adx/…`) | Verbs (line) | Enforces beyond a session cookie | Worst primitive reachable |
|---|---|---|---|
| `anomaly/route.ts` | POST (137) | **YES — the reference implementation.** Owner-checks the item and **fail-closes 404** (`:222-224`); no-item path requires `requireTenantAdmin` (`:229-230`); a caller `body.database` ≠ the item's database is a 403 (`:226-231`) | — |
| `principals/route.ts` | GET (43), POST (62) | **Nothing.** `guardAdxRequest` only | `.add database <db> admins ('<fqn>')` — `addDatabasePrincipal`, `kusto-client.ts:1607-1610`. Grants a caller-named Entra User/App/Group ADX **database admin**. `App` accepts `appId;tenantId`, i.e. a principal in **any** tenant (`buildKustoPrincipalFqn`, `kusto-client.ts:1543-1562`) |
| `rls/route.ts` | GET (29), POST (44) | **Nothing.** | `.alter table T policy row_level_security disable` — **turns row-level security off** for a table. Note `enabled:false` skips `validateKustoRlsQuery` entirely (`rls/route.ts:56-60`) while the query is still interpolated into the command (`kusto-client.ts:1679-1695`) |
| `tables/route.ts` | GET (23), POST (40), PATCH (56), DELETE (72) | **Nothing.** | `.drop table` (`:72-83`). `POST`/`PATCH` interpolate an unvalidated `schema` string into `.create table X (…)` / `.alter-merge table X (…)` (`kusto-client.ts:1707-1725`) |
| `external-tables/route.ts` | GET (50), POST (61), DELETE (119) | **Nothing.** | `.create-or-alter external table` against a **caller-supplied `abfss://` URI** and a caller-supplied `miObjectId` (`:67,72,100-103`); `.drop external table` (`:119-131`) |
| `continuous-exports/route.ts` | GET (41), POST (52), DELETE (84) | **Nothing.** | `.create-or-alter continuous-export` with a **free-form `query`** (`:59`) on a caller-chosen interval, writing to a caller-chosen external table — a scheduled egress primitive; `.drop continuous-export` |
| `materialized-views/route.ts` | GET (18), POST (29), DELETE (48) | **Nothing.** | `.create materialized-view` with a **free-form `query`** (`:34`); `.drop materialized-view` |
| `functions/route.ts` | GET (18), POST (29), DELETE (46) | **Nothing.** | `.create-or-alter function` with a **free-form body** (`:34-35`); `.drop function` — a stored function is callable by anything that later queries the DB |
| `policy-authoring/route.ts` | POST (39) | **Nothing.** | `.alter … policy retention softdelete = 0d` / `recoverability = Disabled` — a **retention-destruction** primitive; caching policy (cost) |
| `policies/route.ts` | GET (32), POST (43) | **Nothing.** | `.alter table … policy update` with a **free-form `query`** — rewrites rows on ingest |
| `ingestion-mappings/route.ts` | GET (25), POST (36), DELETE (56) | **Nothing.** | `.create/.drop table ingestion mapping` with a free-form JSON mapping |
| `overview/route.ts` | GET (21) | **Nothing.** | `.show database schema as json` — schema disclosure of the shared default DB |

Counted honestly: **28 handlers across 12 files; 27 of them, in 11 files, enforce nothing
beyond "a `loom_session` cookie exists."** The header comment on `principals/route.ts:15-17`
states the identity behind them: *"the Console UAMI holds AllDatabasesAdmin."*

`anomaly` shows the fix already exists in the tree. It is the only route in the directory
that uses it.

**Recommendation.** Change `guardAdxRequest` itself — do not patch eleven routes:

1. Make the null unrepresentable: on `loadKustoItem === null`, **return a 404 response** in
   the guard. Never fall through to `defaultDatabase()`.
2. Make `?id=` **mandatory** for every mutating verb; the no-item path becomes
   `requireTenantAdmin`, exactly as `anomaly/route.ts:229-230` already does.
3. Extract `anomaly`'s `resolveOwnedItemDatabase` (`anomaly/route.ts:59-65`) into the shared
   module and have `guardAdxRequest` call it, so there is one implementation.
4. Split the guard's return type so `ctx.database` is only obtainable from an owned item or
   an admin session — a type-level fix beats a review convention.

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
4. **Widen the pattern, or narrow the stated claim** (added in r2). The header comment
   asserts a property the predicate does not check. Either fix the predicate for all four
   spellings a session check takes in this repo — direct `getSession(`, a local wrapper
   (`requireSession()`, `guardAdxRequest()`), a toolkit HOF (`withSession(`), and an early
   `if (!s) return` — or rewrite the header to say "scans files containing a literal
   `getSession(` call." A merge-blocker whose comment over-states its predicate is worse than
   one with a modest comment, because reviewers cite the comment. (Same defect this document
   committed in r1 — see the closing note.)
5. Re-audit the 316 per-route and 35 class-prefix allowlist entries, **plus the 231
   `SHARED_BACKEND_ITEM_ROUTES` entries, which hold F12 and F13** (`:294`, `:296`). The
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
is the whole check (`apps/fiab-console/app/api/cosmos/_shared.ts:21-26`), applied at
**22 handlers across 11 files** — `app/api/cosmos/items/route.ts:51,84`,
`app/api/cosmos/items/action/route.ts:47`, `app/api/cosmos/databases/route.ts:21,32,51`,
`app/api/cosmos/containers/route.ts:23,36,64`, `account/route.ts`,
`account-management/route.ts:39,69`, `container-settings/route.ts`,
`container-throughput/route.ts`, `scripts/route.ts`, `scripts/execute/route.ts`, and one
more that is **not under the `/api/cosmos/` prefix at all** — see the sibling note below.
There is no container allowlist anywhere in the navigator (sweep in §Class sweeps returned
nothing).

**Sibling missed in r1 — the eleventh file, and the worst two handlers.** r1 said "20
handlers … all 10 `/api/cosmos/*`". The count is 22/11, and the file r1 missed sits under a
different prefix, so neither the count nor the ratchet's `'apps/fiab-console/app/api/cosmos/'`
class-prefix allowlist reaches it:

- **`app/api/items/cosmos-db/[id]/keys/route.ts:67-68`** (`requireSession()`, then
  `gateResponse()`) returns the account's **four ARM master keys and every connection
  string** (`listAccountKeys` / `listConnectionStrings`,
  `lib/azure/cosmos-account-client.ts:946-975`). `POST` on the same route calls
  `regenerateKey` (`:981-990`) — a rotation/DoS primitive. The header states plainly that
  `[id]` "is **NOT** used to resolve the account" (line 7-8): the account is the env-pinned
  navigator account, i.e. Loom's own store per the wiring above.
- **`app/api/cosmos/account-management/route.ts:68-69` → `case 'networking'` (`:104-111`)**
  PATCHes `publicNetworkAccess`, `isVirtualNetworkFilterEnabled`, `ipRules[]` and
  `virtualNetworkRules[]` onto that account (`updateAccountNetworking`,
  `cosmos-account-client.ts:1290-1307` → `patchAccount`, `:1194-1200`). Behind a bare
  session, this is a **network-posture write on Loom's control-plane data store**.

Both succeed with the RBAC bicep grants by default: `cosmos.bicep:571-580` assigns the
Console UAMI **DocumentDB Account Contributor** (`5bd9cd88-fe45-4216-938b-f97437e15450`) on
the account, and the param description at `cosmos.bicep:28` says why — *"so the Cosmos DB
control-plane navigator … can CRUD via ARM AND the Connect panel can call listKeys /
listConnectionStrings / regenerateKey."*

**Honest bound on the keys disclosure:** the DLZ account sets `disableLocalAuth=true`
(`cosmos.bicep:28`), so ARM still *returns* the master keys but the data plane rejects them —
the client documents exactly this (`cosmos-account-client.ts:880-882`), and the route even
echoes `disableLocalAuth` back. So on the DLZ account the leaked keys are not directly usable
for data access. They become live credentials the moment an estate attaches a BYO account
without `disableLocalAuth`, and the network PATCH and `regenerateKey` are unconditional
either way. Grade the disclosure Medium on the DLZ account, High on any BYO account; grade
the network PATCH High regardless.

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
own the item's workspace (`lib/azure/kusto-client.ts:2014`). **The route never checks
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
`resolveAuthorizedAdxDatabase(session, itemId, requestedDb)` helper and route **all**
call sites through it — F3's route, **and `guardAdxRequest` (F3b)** — so an unowned item can
only ever produce a 403, never a fallback database.

**Correction:** r1 said the class was "correctly fixed one route over" and left it at two
call sites. There is a **third**, and it is a wrapper covering 27 handlers — see §0.1 / F3b.
The class is *not* two routes wide.

---

### F3b — HIGH: the shared ADX wrapper discards the same ownership check

Fully evidenced in **§0.1**, summarised here so it appears in the isolation section where it
belongs: `guardAdxRequest` (`app/api/adx/_shared.ts:70-80`) calls
`loadKustoItem(itemId, 'kql-database', session.claims.oid)` and never null-checks it.
`loadKustoItem` returns `null` on a tenant mismatch (`lib/azure/kusto-client.ts:1998-2020`,
denials at `:2010`, `:2014`, `:2016`);
`resolveDatabase(null)` returns `DEFAULT_DB` (`lib/azure/kusto-client.ts:2057-2072`). Omitting
`?id=` skips the check outright (`_shared.ts:70-72`).

Consequence: **11 of the 12 `/api/adx/*` route files (27 of 28 handlers) are session-only
over the shared ADX cluster's default database**, as the Console UAMI holding
AllDatabasesAdmin. The mutating primitives reachable include `.add database … admins`
(`principals/route.ts:62,91-93`), RLS disable (`rls/route.ts:44`), `.drop table`
(`tables/route.ts:72`), retention `softdelete = 0d` (`policy-authoring/route.ts:39`), and a
free-form-query continuous export (`continuous-exports/route.ts:52-59`).

One more inconsistency worth fixing in the same edit: the guard resolves the item with
`session.claims.oid` (`_shared.ts:74`) but resolves the cluster with
`session.claims.tid || session.claims.oid` (`_shared.ts:86`). Two different notions of
"tenant" in one function.

---

### What I checked here and found SOUND

> **r1 CLAIM WITHDRAWN — this is the document's worst error.** r1 asserted: *"`tenantId` is
> never taken from the request body. Sweep … → zero hits. This is the single most important
> thing to get right and it is right."* The sweep matched exactly one syntax
> (`tenantId` immediately followed by `:`/`=` and then a literal `body`/`params`/…) and is
> blind to every other spelling. Re-run it against four files that each demonstrably take a
> tenant/scope id from the request and it returns **nothing**:
>
> ```console
> $ grep -rnE "tenantId\s*[:=]\s*(body|payload|json|req\.|params)" \
>     apps/fiab-console/app/api/org-reports/render/route.ts \
>     "apps/fiab-console/app/api/items/azure-sql-database/[id]/aad-admin/route.ts" \
>     apps/fiab-console/app/api/internal/copilot/skills/learn/route.ts \
>     apps/fiab-console/app/api/admin/coe-library/render/route.ts
> $ echo $?
> 1        # 1 = ZERO matches, on four known-positive files
> ```
>
> The corrected finding is **F12** (§2) with the full call-site list; the corrected sweep is
> §7 #3. **The class is open.** A single-syntax grep asserting a negative is not evidence,
> and this one was load-bearing for a multi-tenant federal platform.

The entries below were each re-verified against the call graph in round 2:

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

### F12 — HIGH: a caller-supplied `tenantId` + `sid` + `server` set the Entra admin of an Azure SQL server

**This is the finding that the withdrawn "zero hits" claim was hiding.** It is the
highest-consequence instance of the shape r1 declared closed.

**Evidence.** `apps/fiab-console/app/api/items/azure-sql-database/[id]/aad-admin/route.ts:39-50`

```ts
export async function PUT(req: NextRequest) {
  const session = getSession();
  if (!session) return ... 401 ...;                       // ← the ONLY check
  const body = await req.json().catch(() => ({}));
  const { server, login, sid, tenantId } = body || {};    // ← all four caller-supplied
  if (!server || !login || !sid) return ... 400 ...;
  const admin = await setAadAdmin(server, { login, sid, tenantId });
```

Every input that decides *which server* and *which principal in which tenant* comes from the
request body. The `[id]` path segment — the only thing that could tie the call to an item the
caller owns — is read nowhere in the file; the header says so explicitly (line 8-9: *"the
`[id]` path segment is the originating database for UX continuity only"*).

`setAadAdmin` (`lib/azure/azure-sql-client.ts:953-981`) passes all three straight into an ARM
PUT on `Microsoft.Sql/servers/<server>/administrators/ActiveDirectory` as the **Console
UAMI**, and its scope resolution accepts a **full ARM resource id**:

```ts
// azure-sql-client.ts:960
const scope = serverName.startsWith('/') ? serverName : await defaultServerScope(serverName);
```

So `server` is not even constrained to the deployment's own resource group — a caller may
address any SQL server in any subscription the Console UAMI can reach.

**Real-world impact.** Any authenticated user (or, via F2, anyone on the internet) can
nominate a principal **they control, in an Entra tenant they own**, as the Microsoft Entra
administrator of a Loom-managed Azure SQL server. Entra admin on a SQL server is `sysadmin`-
equivalent over every database on it: full read, full write, and the ability to create further
logins. It is a complete data-plane takeover of that server, and the platform's own Cosmos
isolation model is irrelevant to it.

**Honest bound — read this before scoping.** The ARM verb is
`Microsoft.Sql/servers/administrators/write`, which is **not** in *SQL DB Contributor*
(`9b7fa17d-…`) — the only SQL role bicep grants the Console UAMI
(`platform/fiab/bicep/modules/admin-plane/sql-rbac.bicep:44-52`, opt-in on
`loomAzureSqlServerRg`). There is **no** `SQL Server Contributor` (`6d8ee4ec-…`) assignment
anywhere in `platform/fiab/bicep` (grep → zero). So on a deployment where the operator granted
*only* what bicep asks for, this PUT returns 403 and the route surfaces the ARM error.

That bound is thinner than it looks, for two reasons, and I do not think it downgrades the
finding below High:

1. **The platform is designed for this call to succeed.** `sql-rbac.bicep:15-22` documents
   that the Azure SQL schema browser requires the Console UAMI to *be* the server's Entra
   admin, "settable from the editor's **'AAD admin' ribbon button**" — i.e. this route. Any
   estate where that browser works is an estate where the grant exists.
2. **A sibling shipped feature calls the same function on its happy path.**
   `app/api/dab/deploy-source/route.ts:196-205` (also session-only, `getSession()` at `:108`)
   calls `setAadAdmin` as step 2 of DAB source provisioning. Its `tenantId` *is* correctly
   pinned to `process.env.AZURE_TENANT_ID` (`:197`) — but its `body.adminGroupSid` is
   caller-supplied (GUID-shape-checked only, `:198`), so any signed-in user can make an
   arbitrary Entra **group** the server's admin there. Same primitive, same session-only gate,
   one tenant boundary intact instead of zero.

**Every site the corrected sweep found** (§7 #3b), graded honestly — inflating these would
waste the same attention that missing them did:

| Site | Where the tenant id comes from | Guard | Real consequence |
|---|---|---|---|
| `app/api/items/azure-sql-database/[id]/aad-admin/route.ts:43` | `body.tenantId` (+ `body.server`, `body.sid`) | `getSession()` only | **HIGH — this finding.** Cross-tenant Entra admin on a caller-chosen SQL server |
| `app/api/org-reports/render/route.ts:179` | `body.params.tenantId` | `getSession()` only (`:169`) | **LOW-MEDIUM.** `params.tenantId` is display-only in `live-bindings.ts` (traced: assigned at `:108`, never read by a resolver). But the *sibling* overrides on the same lines are not — see the F11 correction |
| `app/api/admin/coe-library/render/route.ts:126,143` | query string + `body.params.tenantId` | `getSession()` **+ `requireTenantAdmin`** (`:118-119`, `:134-135`) | **NONE — dismissal upheld.** Admin-gated, and admin-supplied scope overrides are the documented feature (`live-bindings.ts:71-72`: *"Overrides an admin can supply to point a render at a different scope"*) |
| `app/api/admin/org-visuals/dashboards/render/route.ts:127,153` | same | `getSession()` **+ `requireTenantAdmin`** (`:117-118`, `:142-143`) | **NONE — dismissal upheld.** Same reason |
| `app/api/internal/copilot/skills/learn/route.ts:54` | `body.tenantId` | internal trust token, fail-closed (`:31-34,89`) | **INFORMATIONAL.** Narrows a scheduled batch to one tenant; writes land in that tenant's own suggested-skill queue. Machine-to-machine, not caller-reachable. Still a counter-example to "zero hits" |
| `app/api/internal/topology/register-domain/route.ts:51` | **`x-loom-caller-oid` request header**, used directly as the Cosmos partition key | internal trust token (`:47-49`) — but **`validateInternalOid` is NOT called** | **LOW.** See the §8 correction: the GUID validation r1 praised is applied at 2 of the 3 header-forwarding routes, not this one |
| `app/api/dab/deploy-source/route.ts:197-200` | `tenantId` correctly pinned to `process.env.AZURE_TENANT_ID`; **`body.adminGroupSid` is not** | `getSession()` only (`:108`) | **HIGH.** Same `setAadAdmin` primitive as this finding, one tenant boundary intact |

Net: the class is **open with one High-severity member and one High-severity near-member**,
two upheld dismissals, and two low/informational counter-examples. It is not "zero."

**The merge-blocker explicitly waved this route through.** `scripts/ci/check-route-guards.mjs:294`
lists `aad-admin/route.ts` in `SHARED_BACKEND_ITEM_ROUTES`, under a rationale block
(`:255-268`) that reads: *"Auth = signed-in + the deployment's Console-UAMI RBAC — there is NO
per-tenant Cosmos ownership to scope, so `getSession()` + a type gate is the intended
authorization."* That rationale is the bug, stated as a policy. "The Console UAMI's RBAC is
the authorization" is only safe when the route cannot be steered — and this one takes its
target *and* its grantee *and* the grantee's tenant from the caller.

**Recommendation — structural, in this order:**

1. **Delete the `tenantId` parameter.** Pin it to `process.env.AZURE_TENANT_ID` inside
   `setAadAdmin`, so a cross-tenant admin is unrepresentable rather than rejected. This also
   fixes `deploy-source` by construction.
2. **Delete the `server` parameter.** Derive the server from the `[id]` item via
   `loadOwnedItem` and fail closed on null. If a caller cannot name the server, they cannot
   redirect the call.
3. Add `requireTenantAdmin` on top — nominating a SQL server's Entra admin is an admin act by
   any reading.
4. Reject `serverName.startsWith('/')` in `defaultServerScope`'s caller, or validate the
   parsed subscription/RG against the deployment's own. A caller-supplied ARM resource id is a
   scope-confusion primitive wherever it appears.
5. Split `SHARED_BACKEND_ITEM_ROUTES` in the ratchet: a *read* over a shared backend is a
   defensible allowlist entry; a **control-plane write whose target is caller-supplied is not**,
   and should be un-allowlistable.

---

### F13 — HIGH: the `0.0.0.0/0` firewall bug, one directory over from where it was fixed

**Evidence.** `apps/fiab-console/app/api/items/azure-sql-database/[id]/firewall/route.ts:43-54`

```ts
export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return ... 401 ...;                                  // ← the ONLY check
  const body = await req.json().catch(() => ({}));
  const { server, name, startIpAddress, endIpAddress } = body || {}; // ← caller-supplied
  ...
  const rule = await upsertFirewallRule(server, { name, startIpAddress, endIpAddress });
```

Same shape as F12: caller-chosen `server`, no read of `[id]`, no ownership check, no admin
gate, executed as the Console UAMI. `DELETE` (`:57-60`) likewise takes `server` + `rule` from
the query string.

**And it is duplicated verbatim for PostgreSQL:**
`app/api/items/postgres-flexible-server/[id]/firewall/route.ts:32-44` (POST) and `:46-56`
(DELETE) are the same handler body against `Microsoft.DBforPostgreSQL`, with the same
`getSession()`-only gate. Two copies of one hole.

**Real-world impact.** Any signed-in user can add
`{startIpAddress: '0.0.0.0', endIpAddress: '255.255.255.255'}` to a Loom-managed Azure SQL
server, or delete the rules that restrict it.

**Why this one matters out of proportion to its size.** r1 listed, under *"found SOUND"*:

> *"**Networking routes are properly gated**, and the comment records the exact bug that
> motivated it — 'a bare authenticated session used to be the ONLY check, which let ANY
> signed-in user POST an Allow 0.0.0.0/0 rule' (`admin/workspaces/[id]/networking/_gate.ts:76-104`).
> **This is the right way to fix a class.**"*

The gate is genuinely good and that quote is genuinely from the code. But it was cited as
evidence the *class* was closed, and the class was not swept: the identical primitive over a
different Azure resource type, four directories away, still has the bare session. Presenting a
well-written single-site fix as class closure is the same error as F3 → F3b, and I made it in
the same document that criticises the pattern.

`firewall/route.ts` is also on the ratchet allowlist (`check-route-guards.mjs:296`).

**Recommendation.** Route it through `authorizeNetworking`
(`app/api/admin/workspaces/[id]/networking/_gate.ts:119-140`) — the guard already exists and
already encodes the right policy. Derive `server` from the owned item; drop the parameter. Then
sweep for the primitive across every Azure resource type Loom exposes a firewall/network-rule
write for (SQL, Synapse, Storage, Cosmos, ADX, Key Vault) and gate them all in one change.

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
- **The `admin/workspaces/[id]/networking/*` routes specifically are properly gated**
  (`authorizeNetworking`, `_gate.ts:119-140`), and the comment records the exact bug that
  motivated it — "*a bare authenticated session used to be the ONLY check, which let ANY
  signed-in user POST an Allow 0.0.0.0/0 rule*" (`_gate.ts:76-104`).
  **r1's follow-on sentence — "This is the right way to fix a class" — is withdrawn.** It
  was a good fix to a *site*; the class was never swept. Sweep for the primitive
  (`grep -rlniE "firewallRule|ipRule|networkAcl|virtualNetworkRule" app/api --include=route.ts`)
  returns **6 files, of which only these 2 are gated**:
  | Route | Guard | Caller controls |
  |---|---|---|
  | `admin/workspaces/[id]/networking/ip-rules/route.ts` | `authorizeNetworking` ✅ | — |
  | `admin/workspaces/[id]/networking/trusted-resources/route.ts` | `authorizeNetworking` ✅ | — |
  | `items/azure-sql-database/[id]/firewall/route.ts:43,57` | `getSession()` only ❌ | `server` + IP range (**F13**) |
  | `items/postgres-flexible-server/[id]/firewall/route.ts:32,46` | `getSession()` only ❌ | `server` + IP range (**F13**, identical code) |
  | `eventhubs/network/route.ts:42-43` | `getSession()` only ❌ | namespace network ruleset |
  | `cosmos/account-management/route.ts:68-69` | `requireSession()` only ❌ | `publicNetworkAccess` / `ipRules[]` on Loom's own store (**F1**) |
  Four of six network-posture writes are session-only. That is the class, and it is open.
- **PAT sessions are correctly subordinate.** SHA-256 hashed secrets with a timing-safe
  compare (`lib/auth/pat.ts:149,162`), expiry + revocation (lines 203, 260), read-only
  scope rejects mutating verbs, and admin scope requires the *creator* to still be a
  tenant admin at use time (`lib/auth/api-session.ts:61-87`). The cookie path strictly
  wins so browser behaviour is unchanged.
- **`/api/notebook/execute` honestly returns 501** rather than pretending
  (`app/api/notebook/execute/route.ts:43`) — a stub that was correctly *not* faked.
- **The internal service-to-service *token* check is textbook**: constant-time compare over
  SHA-256 digests so length does not leak (`lib/auth/internal-token.ts:39-50`),
  **fail-closed** when the secret is unset (`:45`), per-service secret isolation via
  `preferEnv` (`:43-44`). `validateInternalOid` (`:71-84`) is likewise correct in itself —
  GUID-shape enforcement plus an optional `LOOM_INTERNAL_ALLOWED_OIDS` allowlist, with the
  threat written into the comment (`:56-70`: *"the oid is the tenant partition key … a
  garbage value would write into an attacker-chosen partition"*).

  > **r2 correction — r1 over-claimed the second half of this.** r1 wrote *"defence-in-depth
  > GUID validation of **the** forwarded `x-user-oid`"*, phrasing a property of the helper as
  > a property of the surface. `validateInternalOid` is called at **2** sites —
  > `internal/copilot/tools/[name]/invoke/route.ts:46` and `iq/mcp/route.ts:86`. The third
  > route that takes an identity from a request header does **not** call it:
  > `internal/topology/register-domain/route.ts:51` reads `x-loom-caller-oid` raw and uses
  > it directly as the Cosmos partition key (`:51-57`, then `DomainBindingInput`). The
  > protection the comment describes is therefore absent on that route. Severity **Low** —
  > it is behind the fail-closed token gate (`:47-49`), so it is not caller-reachable; and
  > note it is a *different header name*, which is likely how it was missed.
  > **Fix:** route every header-borne identity through `validateInternalOid` and delete the
  > raw `headers.get` path, so the un-validated form is unrepresentable.

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

**A grep across the entire `app/api/marketplace/sharing/` tree returns zero hits for any
audit or event emitter** — no audit row for allows, and none for denials either. *(r1 ran
only `recordAudit|writeAudit|auditLog|appendAudit`, the same single-syntax mistake as the
withdrawn sweep #3. Re-run in r2 as `-iE "audit|emitLoomEvent|emitEvent|trackEvent|logEvent|auditStream"`,
with `lib/auth/pat.ts` as a known-positive control that the pattern matches 8 times. Still
zero. **This claim survives.** §7 #8.)* The `sharingErrorResponse` mapper (`_lib.ts:47-70`) converts a
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

### F11 — LOW-MEDIUM (corrected in r2): `/api/org-reports/render` is session-only *and* takes its query scope from the caller

r1 listed F11 in the summary table but never wrote it up, and described it only as
"exposes estate-wide cost/Defender/inventory to any session." That much is right:
`app/api/org-reports/render/route.ts:158-159` (GET) and `:171-172` (POST) check
`getSession()` and nothing else — no `requireTenantAdmin` — unlike the two sibling render
routes under `/api/admin/`, which do gate (`admin/coe-library/render/route.ts:118-119`,
`admin/org-visuals/dashboards/render/route.ts:117-118`).

**What r1 missed:** the route also accepts four `ReportParamOverrides` from the caller
(`:161-166` query string, `:176-181` request body). Traced through
`lib/coe-library/report-render/live-bindings.ts`:

| Override | Consumed as | Verdict |
|---|---|---|
| `subscriptionId` | `params.subscriptionIds` (`:100-104`) → **the `subscriptions` payload of every Azure Resource Graph query** (`runArg`, `:165-193`, called at `:339,378,438,472,506,540,573`) | **REAL.** Any signed-in user can point the ARG queries at a subscription of their choosing, executed as the Console UAMI. Bounded by the UAMI's Reader scope — which in this estate spans the whole DLZ |
| `tenantId` | assigned at `:108`, then read only by the UI as a placeholder (`report-view.tsx:143-144`) | Display-only |
| `billingScope` | assigned at `:105,111`; no resolver reads `params.billingScope` (the Cost client uses its own `billingScope()`, `lib/azure/cost-management-client.ts:51,499`) | Display-only |
| `managementApiBase` | assigned at `:113`; the ARM host actually used is the module-level `const ARM = armBase()` (`:147`, used at `:177`) | Display-only — **r1's dismissal #2 upheld** |

So the honest shape is: three of the four overrides are inert (r1's instinct was right about
`managementApiBase` and generalises to two more), and the fourth is a live scope-selection
parameter on an ungated route.

**Recommendation.** Add `requireTenantAdmin` to both handlers — matching the two sibling
routes, which already do it — and validate `subscriptionId` against `loomSubscriptions()`
rather than accepting an arbitrary GUID. Then delete `tenantId` and `billingScope` from
`ReportParamOverrides`: a parameter that is accepted, plumbed and never read is a trap for the
next reader (it is what made r1's sweep miss the class), and removing it is the structural fix.

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

2. **`managementApiBase` is not an SSRF sink — DISMISSAL UPHELD in r2, re-argued against the
   call graph.** `/api/org-reports/render` accepts a caller-supplied `managementApiBase`
   (`route.ts:165,180`) which lands in `ReportParams.managementApiBase`
   (`live-bindings.ts:113`). Re-traced: it is **never** a fetch target. The ARM host used for
   the token-bearing call is the module-level `const ARM = armBase()`
   (`live-bindings.ts:147`, used at line 177); the only *reader* of the `ReportParams` field
   is the UI (`report-render/report-view.tsx:51,143-144`, a placeholder + a dirty-check).
   13 `managementApiBase` hits across the app: type declarations, assignment, UI display.
   No managed-identity token is sent anywhere the caller chooses.
   **But the sibling I did not check in r1 fails this test.** `subscriptionId`, plumbed on the
   adjacent line of the same object literal, *is* consumed — as the ARG query scope. Tracing
   one field of a caller-supplied override bag and dismissing the bag is the error; see the
   corrected F11 for the per-field verdicts. The dismissal of this field stands; the implied
   dismissal of its neighbours does not.

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

6. **`/api/internal/*` is *authenticated* — dismissal upheld, but narrowed in r2.** These
   looked unguarded to a naive classifier and do authenticate via `isValidInternalToken`
   (e.g. `internal/scheduler/tick/route.ts:24,44-51`), which is fail-closed and timing-safe.
   **Narrowing:** r1's phrasing "properly gated" over-generalised. `isValidInternalToken`
   authenticates *the service*, not the tenant, so any internal route that takes a tenant
   partition from the request is trusting the caller for scope. Two do —
   `internal/copilot/skills/learn/route.ts:54` (`body.tenantId`) and
   `internal/topology/register-domain/route.ts:51` (`x-loom-caller-oid`, used raw as the
   partition key with **no** `validateInternalOid`). Both are token-gated so neither is
   caller-reachable; the correct grade is Low, not None. See the §8 correction.

7. **The `/admin/workspaces/[id]/networking/*` routes** looked unguarded for the same reason;
   they route through `authorizeNetworking` in `_gate.ts:119-140`, which is correct.
   **r1 then over-read this as class closure — see the §2 correction.** Four of the six
   network-posture write surfaces in the app are session-only (F13, F1).

### 6.1 Dismissals WITHDRAWN in r2

Listed separately so they are not lost in an edit. A dismissal that turns out to be reachable
is the worst outcome an audit can produce — it ships the vulnerability *and* reports success.

| r1 dismissal / claim | Why it was wrong | Now filed as |
|---|---|---|
| *"`tenantId` is never taken from the request body … zero hits … it is right."* (§1 SOUND) | The sweep matched one syntax; four call sites use other spellings. Mutation proof in §7 #3 | **F12** (+ the F12 site table) |
| *"the 11 `/api/adx/*` routes … many are genuinely safe"* (§0) | Never examined. 11 of 12 files enforce only a session; the shared wrapper discards its own ownership check | **F3b** (+ §0.1) |
| *"20 handlers, all 10 `/api/cosmos/*`"* (F1) | 22 handlers / 11 files; the eleventh is outside the prefix and discloses ARM master keys | **F1** (sibling note) |
| *"Networking routes are properly gated … this is the right way to fix a class."* (§2 SOUND) | The site was fixed; the class was not swept | **F13** |
| *"GUID-validated forwarded oid"* as a property of the internal surface (§8) | Property of a helper used at 2 of 3 header-forwarding routes | §8 correction |

---

## 7. Class sweeps run

Reproducible; each is the sweep behind a finding, not a spot check.

```bash
# 1. Every route handler, classified by strongest authorization primitive referenced.
#    Result: 1657 total / 555 strong guard / 958 session-only (649 mutating) / 144 no ref.
node temp/audit-routes.mjs

# 2. Data-plane query/execute/run routes.  Result: 69 total / 20 guarded / 46 SESSION-ONLY.  (F4)
node temp/sweep-query.mjs

# 3. WITHDRAWN — this sweep was wrong, and it was the most load-bearing claim in r1.
#    It matches ONE syntax: the identifier `tenantId` immediately followed by `:`/`=` and
#    then a literal body/payload/json/req./params. r1 read its empty output as
#    "class closed and SOUND". It is blind to at least four other spellings, all present
#    in the tree: destructuring (`const { tenantId } = body`), optional chaining through a
#    renamed local (`const p = body?.params` → `p.tenantId`), a `String(body?.tenantId)`
#    coercion, and the query string (`searchParams.get('tenantId')`).
#
#    MUTATION PROOF that the sweep is blind (run at 45afb58d, four known-positive files):
grep -rnE "tenantId\s*[:=]\s*(body|payload|json|req\.|params)" \
  apps/fiab-console/app/api/org-reports/render/route.ts \
  "apps/fiab-console/app/api/items/azure-sql-database/[id]/aad-admin/route.ts" \
  apps/fiab-console/app/api/internal/copilot/skills/learn/route.ts \
  apps/fiab-console/app/api/admin/coe-library/render/route.ts
# → exit 1, ZERO matches. Every one of those four files takes a tenant id from the request.

# 3b. REPLACEMENT sweep — multi-syntax.  Result: 4 real call sites (F12).  (see below)
grep -rnE "(body|payload|json|b|req|input|args|parsed|p)\s*\??\.\s*tenantId|\
\{[^}]*\btenantId\b[^}]*\}\s*=\s*(body|payload|await req|json|parsed)|\
searchParams\.get\(['\"]tenantId" \
  apps/fiab-console/app apps/fiab-console/lib --include=*.ts --include=*.tsx \
  | grep -v __tests__

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
#    r1 ran only the first line — the SAME single-syntax pattern that made sweep #3 wrong.
#    RE-RUN IN r2, widened, with a known-positive control.  F6's claim SURVIVES.
grep -rn  "recordAudit\|writeAudit\|auditLog\|appendAudit" \
  apps/fiab-console/app/api/marketplace/sharing/                            # → exit 1 (zero)
grep -rniE "audit|emitLoomEvent|emitEvent|trackEvent|logEvent|auditStream" \
  apps/fiab-console/app/api/marketplace/sharing/                            # → exit 1 (zero)
grep -rncE "audit|emitLoomEvent|emitEvent|trackEvent|logEvent|auditStream" \
  apps/fiab-console/lib/auth/pat.ts                    # → 8   KNOWN-POSITIVE CONTROL: the
#    widened pattern DOES match a file that audits, so its empty result on the sharing tree
#    is a fact about the tree, not about the pattern.  This is the control r1's sweep #3 lacked.

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

# ─── r2 additions ────────────────────────────────────────────────────────────

# 15. The /api/adx/* tree, per file (replaces r1's bulk "many are genuinely safe").  (F3b)
#     Result: 12 route files / 28 handlers.  guardAdxRequest is the ONLY authorization in
#     11 files / 27 handlers.  Only anomaly/route.ts adds a real check.  Table in §0.1.
find apps/fiab-console/app/api/adx -name route.ts | sort            # → 12
grep -rn "guardAdxRequest" apps/fiab-console/app/api/adx --include=route.ts   # → 28 call sites
grep -rn "requireTenantAdmin\|loadOwnedItem\|resolveOwnedItemDatabase" \
  apps/fiab-console/app/api/adx --include=route.ts                  # → anomaly/route.ts ONLY
#     MUTATION PROOF that guardAdxRequest does not enforce ownership: the wrapper never
#     null-checks loadKustoItem, and loadKustoItem's ONLY denial signal is `return null`.
sed -n '1998,2020p' apps/fiab-console/lib/azure/kusto-client.ts
#       → :2010 `if (!item) return null`            (not found)
#       → :2014 `if (!resource || resource.tenantId !== tenantId) return null`  (NOT OWNED)
#       → :2016 `if (e?.code === 404) return null`  (workspace not in caller's partition)
grep -cn "if (!item)\|item === null" apps/fiab-console/app/api/adx/_shared.ts   # → 0
#     …so all three denials are consumed by resolveDatabase(null) → DEFAULT_DB
#     (kusto-client.ts:2057-2072). The check runs, returns "denied", and is thrown away.

# 16. Network-posture / firewall writes, ALL resource types.  (F13, F1)
#     Result: 6 files.  2 gated (authorizeNetworking), 4 session-only.  Table in §2 SOUND.
grep -rlniE "firewallRule|ipRule|networkAcl|virtualNetworkRule|ipSecurityRestriction" \
  apps/fiab-console/app/api --include=route.ts

# 17. The cosmos-navigator `requireSession()` surface, by FILE not by prefix.  (F1)
#     Result: 22 handlers / 11 files — one of which is OUTSIDE app/api/cosmos/, so r1's
#     "all 10 /api/cosmos/*" count AND the ratchet's class-prefix allowlist both miss it.
grep -rn  "requireSession()" apps/fiab-console/app/api/cosmos \
                             apps/fiab-console/app/api/items/cosmos-db --include=route.ts | wc -l
grep -rln "requireSession()" apps/fiab-console/app/api/cosmos \
                             apps/fiab-console/app/api/items/cosmos-db --include=route.ts | sort

# 18. Header-borne identity on internal routes — is validateInternalOid actually applied?
#     Result: 3 routes take an identity from a header; 2 validate.  (§8 correction)
grep -rn "validateInternalOid\|x-loom-caller-oid\|INTERNAL_USER_OID_HEADER" \
  apps/fiab-console/app/api --include=route.ts | grep -v __tests__
```

The three `node` scripts above are throwaway analysis helpers under `temp/` (gitignored).
They are reproduced in full in the PR description so the numbers can be re-derived. **Every
`grep`-based sweep in this section is runnable as written against `45afb58d` and its stated
result is the output I got** — that is the standard r1 failed on sweep #3, which was runnable
but whose empty result was not a fact about the codebase.

---

## 8. What I checked and found SOUND — consolidated

Coverage signal, so the absence of a finding in an area means something. **Rewritten in r2**
under a stricter rule, because the r1 version of this section is what produced the audit's two
worst errors: two of its entries were assertions about a *class* backed by a check of a single
*site*.

**The rule this section now follows.** Every claim below (a) is about a **specific artefact at
a specific `file:line`** that I re-opened in round 2, and (b) says nothing about any other
file. Where I originally wrote a class-level claim, it has been either demoted to a site-level
claim or moved to §6.1 as a withdrawn dismissal. **A claim of the form "X never happens in this
codebase" does not belong in this section unless a multi-syntax sweep backs it — and the sweep
must be shown, with a known-positive control.** r1 had exactly one such claim (`tenantId` from
the body) and it was false; the corrected sweeps now carry mutation proofs (§7 #3, #15).

**Cryptography — verified.** AES-256-GCM (`lib/auth/session.ts:32`) with an HKDF-derived key
(`:39`, `info = 'loom-session-v1'`) and an authenticated tag (`:89-99` encode, `:103-115`
decode with `setAuthTag`); a **separate** HKDF `info` label for at-rest encryption
(`:155`, `'loom-at-rest-v1'`) so a leaked at-rest blob cannot be replayed as a session cookie;
cookies are `HttpOnly; Secure; SameSite=Lax` (`:118`, `:141`); expiry checked on decode
(`:110`).

**Sign-in — verified.** PKCE code-verifier threaded into the token exchange
(`app/auth/callback/route.ts:315`) and the OIDC nonce compared with `safeEqual`, restarting
login on mismatch (`:325-329`), against a fixed deployment authority. *Scope note:* this is
the browser callback only. The **CLI** session-minting path is F2 and is not covered by this
entry.

**PII in logs — verified.** The UPN is deliberately **not** logged; a `SESSION_SECRET`-salted
SHA-256 fingerprint is, with the reasoning written out
(`app/auth/callback/route.ts:360-369`).

**Rate limiting — verified at the helper, and the r1 wording narrowed.** `clientIp()` delegates
to `trustedClientIp` (`lib/azure/rate-limiter.ts:263-265`), and the comment records the prior
`x-forwarded-for.split(',')[0]` bug and its consequence (`:253-262`). r1 added *"Applied on the
query routes"* with no citation — **that clause is withdrawn as uncited.** What I can state:
`enforceRateLimit*` is referenced in 38 route files (sweep), and **`/api/auth/cli-session` is
not one of them** (F2 recommendation 5).

**Fail-closed defaults — verified per site:** the feature gate on a Cosmos error
(`lib/auth/feature-gate.ts:133-139`), the internal token when its secret is unset
(`lib/auth/internal-token.ts:45`), the ops-admin group check on a Graph outage
(`app/api/admin/ops-copilot/route.ts:52-56`). r1 also listed *"`resolveAccessMode` degrading to
a working path"* here — **that is moved out**: `lib/azure/sql-access-mode.ts:56-72` degrades to
`'service'`, i.e. to the *platform* identity, which is fail-**open** with respect to
authorization and is the mechanism of F4. Listing it as a fail-closed default was wrong.
F5 remains the flagship default that fails open.

**Denial auditing exists — verified at one site.** `lib/auth/pat.ts:231,286` audits unknown-id,
bad-secret, revoked and expired token uses. The pattern is available; Delta Sharing (F6) does
not call it. No claim here about audit coverage anywhere else.

**Secret derivation — verified.** `main.bicep:1436-1438` derives from `newGuid()` and the
comment names the avoided vector (`guid(resourceGroup().id, <public-const>)`).

**`no-vaporware` honest gates have a real security dividend — verified at the sites cited in
§0.1 and §4** (e.g. `kustoConfigGate` returning a 503 naming `LOOM_KUSTO_CLUSTER_URI`,
`app/api/adx/_shared.ts:60-68`): a misconfiguration surfaces rather than degrading into an
unprotected state. r1's *"throughout"* is **withdrawn** — it was a codebase-wide claim from
spot checks, and F7 plus §0.1 are both counter-examples (in §0.1's case the honest *config*
gate sits next to an absent *authorization* gate, which is precisely how the tree read as safe).

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
8. **The `SHARED_BACKEND_ITEM_ROUTES` allowlist was not audited entry-by-entry.** F12 and
   F13 are both on it (`check-route-guards.mjs:294,296`), found by reading the code rather
   than the allowlist. The list holds **231 route entries** under one shared rationale
   (`:255-268`); two of the first three I opened were holes.
   **Assume the other 229 are unexamined until someone opens them.**
   This is the single most likely place a further finding of F12's severity is sitting.
9. **`no-fabric-dependency` / `no-vaporware` compliance of the F12/F13 fixes** is unverified —
   deriving `server` from the owned item changes the editor's call shape and needs an E2E.

---

## 10. Recommended order of work

1. **F1** — decouple `LOOM_COSMOS_ACCOUNT` from `loomCosmosAccount`; refuse to serve the
   navigator when they match; add `requireTenantAdmin`. *Cross-tenant read, write and
   destructive delete.* **Include the two r2 siblings** in the same change:
   `items/cosmos-db/[id]/keys` (ARM master-key disclosure) and
   `cosmos/account-management` `section:'networking'` (network-posture write) — both are
   session-only on the same account.
2. **F2** — pin the `cli-session` authority to the deployment tenant and allowlist SP oids.
   *Unauthenticated attackers currently inherit every finding below.*
3. **F12 + F13** — new in r2, and cheap: delete the `tenantId` and `server` parameters from
   `aad-admin`, `firewall` (SQL **and** Postgres) and `dab/deploy-source`; derive from the
   owned item; add `requireTenantAdmin`. Four files, and it removes a cross-tenant Entra-admin
   grant and two `0.0.0.0/0` firewall paths. *Do this before F3 — it is smaller and the
   consequence is larger.*
4. **F3 + F3b** — one shared `resolveAuthorizedAdxDatabase`, and fix it **in
   `guardAdxRequest`** so all 27 ADX handlers inherit it. Fail closed on a null item.
5. **F5** — `requireTenantAdmin` on both ops-copilot routes; unset group fails closed.
6. **F7** — land #2638; extend to the Iceberg catalog; `ipSecurityRestrictions` on all 21
   internal apps.
7. **F6** — admin-gate Delta Sharing mutations and wire denial auditing.
8. **F4** — the migration: `withDataPlaneItem` across 46 routes. Largest, and the one that
   permanently closes the class.
9. **F8, F9, F10, F11** — consolidate egress onto `assertEgressAllowed`; IP-restrict DAB;
   sweep sovereign audiences onto the `cloud-endpoints` helpers; admin-gate
   `/api/org-reports/render` and validate its `subscriptionId` against `loomSubscriptions()`.
10. **Audit all 231 `SHARED_BACKEND_ITEM_ROUTES` entries** (§9.8). Reclassify every entry whose
    route performs a *write* with a *caller-supplied target*; those are not allowlistable.
11. Then dismiss the alerts listed in §6 **with the written reasons recorded**, so the next
    audit does not re-litigate them.

Do **F0 first or in parallel** — repairing the ratchet is what stops the next one.

A closing note on process. F3 is the most instructive finding in this document: the class
was correctly identified, correctly fixed, and correctly *documented* in
`app/api/adx/anomaly/route.ts` — and the identical bug survived one directory away because
the fix was applied to the reported call site rather than swept across the shape. The same
is true of F8 (a correct shared SSRF guard that one caller does not use), F10 (correct
sovereign helpers that thirteen call sites bypass), and — added in r2 — F13, where an
excellent networking gate with the threat model written into its comment sits four
directories away from two unguarded copies of the primitive it was built to stop.

The instinct here is consistently good — the guards, the SSRF core, the fail-closed
defaults and the honest gates are the work of people who thought about the adversary. What
is missing is the mechanical step that proves a shape is gone *everywhere*. Loom even built
that step (`check-route-guards.mjs`) and wrote the right rule at the top of it; F0 is the
finding that it silently stopped covering the places the holes moved to. A guardrail that
reports "1469 scanned, 0 violations" while three live cross-tenant paths sit outside its
scan population is more dangerous than no guardrail, because it converts an open question
into a false answer.

### And the same criticism applies to this document

I wrote the paragraph above in r1 and then committed the identical error twice, in the same
file, in the section whose entire purpose is coverage signal:

- I found the `loadKustoItem`-discards-null shape (F3), noted approvingly that a sibling had
  fixed it, and did not sweep the shape — so I missed it in a **wrapper** covering 27 handlers
  (F3b). A one-site fix presented as a class fix is what I criticised; a one-site *finding*
  presented as a class inventory is the same mistake with the sign flipped.
- I asserted a negative — *"`tenantId` is never taken from the request body … zero hits"* —
  from a **single-syntax grep with no known-positive control**. That is structurally identical
  to F0(a): a check whose scan population silently excludes the cases that matter, reporting
  zero and being believed. `check-route-guards.mjs` matched only `getSession(`; my sweep
  matched only `tenantId:` / `tenantId=`. Both returned clean. Both were wrong. Mine was worse,
  because a CI script at least runs on every PR, while a sentence in a security document is
  read once and trusted thereafter.

**The operational lesson, stated so it is reusable:** a sweep that asserts a shape is *absent*
must be run against a **known positive** before its empty output is believed. If you cannot
name a file the sweep *should* match, you have not tested the sweep — you have only run it.
Every negative claim in this revision now ships with that control (§7 #3, #15).

The same test applies to the ratchet. F0's recommendation is to widen the scan population; add
to it: **widen the pattern, or narrow the stated claim.** `check-route-guards.mjs` says at the
top that it enforces caller-authorization for every route reading another tenant's data. It
cannot currently see wrapper-authenticated routes (F0a), accepts an unconsumed guard identifier
(F0b), accepts a signal that defaults to `true` (F0c), and allowlists 231 routes under one
rationale (§9.8). Until those are fixed, the header comment should be edited to describe what
the script actually checks. **A guard's stated claim and its implemented predicate diverging is
itself the defect** — that is true of `check-route-guards.mjs` and it was true of r1 of this
document.
