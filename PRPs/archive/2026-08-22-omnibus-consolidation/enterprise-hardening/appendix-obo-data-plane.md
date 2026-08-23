# Appendix — OBO per-user data-plane identity (`obo-data-plane`)

**Domain owner:** Enterprise-Hardening PRP (task #45)
**Scope:** Replace/augment the shared Console-UAMI data-plane access (~233 files) with
On-Behalf-Of (per-user Entra token exchange) for Synapse SQL / ADLS / ADX / Cosmos / AAS
reads, so native Azure RBAC + RLS/CLS enforce **per user at the source**. UAMI remains the
default for service/admin/provisioning operations. Per-domain managed identity is the
service-to-service option within a domain.

**Scale target:** 100 → 60,000 users. Every design sized for the 60k upper bound.
**Dual cloud:** Commercial + Azure Government (GCC / GCC-High / DoD IL4-5).
**Governing rules:** `no-vaporware.md`, `ui-parity.md`, `web3-ui.md`,
`no-freeform-config` (memory), `no-fabric-dependency.md`. Every refactor is incremental +
reversible behind a feature flag.

---

## 0. TL;DR readiness — this is an AUGMENT, not a greenfield build

The OBO machinery is **already built and live for SQL**. The gap is consumption breadth +
two missing audiences (storage, Kusto) + the report read path + a per-domain MI option +
a governed rollout across the ~233 UAMI call sites. Readiness = **partial (strong on SQL,
absent on ADLS/ADX/Cosmos reads and the report path)**.

What already exists (verified in code):

| Capability | File | State |
|---|---|---|
| OBO token exchange (`acquireTokenOnBehalfOf`) | `lib/auth/msal.ts` → `acquireOboToken()` | ✅ built |
| Silent per-user delegated capture (login-time) | `lib/auth/msal.ts` → `acquireUserDelegatedToken()`, `captureUserMcpOboTokens()` | ✅ built |
| Encrypted per-user token cache (AES-256-GCM at rest, Cosmos) | `user-token-store.ts` (ARM), `sql-user-token-store.ts` (SQL), `pbi-user-token-store.ts` (PBI), `mcp-obo-token-store.ts` (generalized `(oid,resource)`) | ✅ built |
| F10 "user's identity" SQL mode end-to-end | `sql-access-mode.ts` (`resolveAccessMode`), `synapse-sql-client.ts` (`executeQueryAsUser` + isolated per-user TDS pools), `synapse-serverless-sql-pool/[id]/query/route.ts` | ✅ built |
| Sovereign-cloud audience resolution | `cloud-endpoints.ts` (`getSqlSuffix`, `getKustoSuffix`, `getBlobSuffix`, `dfs.core.usgovcloudapi.net`, etc.) | ✅ built |
| Multi-domain identity model | `lib/auth/domain-role.ts` (tenant-admin/domain-admin/domain-contributor via Entra groups), `domain-registry.ts`, `workspace-roles-client.ts` | ✅ built |
| SQL delegated-consent runbook | `scripts/csa-loom/grant-sql-delegated-permission.sh` | ✅ exists |
| Storage RBAC grant scripts | `grant-adx-storage-rbac.sh`, `grant-shortcut-storage-rbac.sh` | ✅ exist |

What is **missing** (the build-out this appendix specifies):

1. **Report read path** (`app/api/items/report/[id]/query/route.ts`) always calls
   `executeQuery` (service/UAMI). No `accessMode==='user'` branch. **P0 migration target.**
2. **ADLS user-delegation path** — `adls-client.ts` has a single shared UAMI
   `ChainedTokenCredential`; no per-user `DataLakeServiceClient`. No storage audience in
   the login capture (`OBO_RESOURCE` has no `storage`).
3. **ADX (Kusto) user-token path** — `kusto-client.ts` only has UAMI `getToken()`; no
   `executeAsUser`. No kusto audience captured at login. (RLS predicate helper
   `kusto-rls-predicate.ts` exists but enforcement today rides app-layer + UAMI.)
4. **Cosmos data-plane per-user** — `cosmos-client.ts` is UAMI-only (this is correct for
   metadata; see §6 — Cosmos stays UAMI, isolation stays app-layer + partition-key).
5. **AAS (XMLA) EffectiveUserName / OBO** — `aas-client.ts` runs as service; RLS roles
   are not bound to the caller.
6. **Per-domain managed identity** for service-to-service inside a domain (§7).
7. **A single feature-flag + resolver** generalizing F10 beyond SQL (`data-access-mode.ts`).
8. **Storage + Kusto login captures** + their consent/RBAC runbooks (§8).

---

## 1. Architecture in words

### 1.1 The two identities, and when each is used

Loom's BFF holds a **confidential client** (`LOOM_MSAL_CLIENT_ID` + the
`loom-msal-client-secret` Key Vault secret) and a **User-Assigned Managed Identity**
(`LOOM_UAMI_CLIENT_ID`, `uami-loom-console-*`). Today nearly all data-plane work runs as
the UAMI. The hardening introduces a strict split:

- **USER identity (OBO / delegated)** — every **read of business data a user requests**:
  report visual queries, lakehouse/warehouse SELECTs, ADX/KQL queries, ADLS Delta/file
  reads, AAS DAX. The token carries the *user's* oid/UPN/groups, so Synapse RLS,
  SQL CLS, Storage RBAC+ACL, ADX `current_principal()` RLS, and the audit log all
  resolve to the real person. **This is the defensible boundary.**
- **SERVICE identity (UAMI)** — provisioning, admin/ops, deployment, metadata
  (Cosmos workspace/item/state), background refresh/materialization, Purview scans,
  cross-subscription Resource Graph enumeration, and the *default* SQL `service` mode for
  brand-new endpoints that have no per-user grants yet. Always-works fallback.

### 1.2 OBO flow (grounded in MS Learn)

1. Browser → BFF with the httpOnly session cookie (claims only — oid/UPN/groups, **never a
   raw token**).
2. At **login** (`app/auth/callback/route.ts`), immediately after `acquireTokenByCode`, the
   account is in the confidential client's cache. The callback mints per-audience tokens via
   `acquireTokenSilent({ account, scopes })` (already done for ARM/SQL/PBI/Graph/Foundry)
   and writes each **encrypted** to its Cosmos store. **Add storage + kusto captures here.**
3. On a data read, the route reads the cached, still-valid token via
   `getUserSqlToken(oid)` / `getUserOboToken(oid, resource)` and hands it straight to the
   data-plane connection (TDS `azure-active-directory-access-token`, `Authorization: Bearer`,
   or a per-user `DataLakeServiceClient`). Decryption is server-side only.
4. On cache miss/expiry (~60-90 min, 60s safety margin), the route returns an **honest 403
   gate** ("sign out/in; if it persists, admin must grant consent …") — never a silent
   service-identity fallback for a `user`-mode item (that would defeat the boundary).

Why silent-capture-then-cache (not live `acquireTokenOnBehalfOf` per call): the session
cookie deliberately holds **claims, not a raw user assertion**, so there is no assertion to
exchange on the hot path. `acquireOboToken(userAssertion, scopes)` is retained for the one
path that *does* have a raw assertion (the internal-token MAF callback). MS Learn confirms
both are valid confidential-client patterns; Loom uses the cache-per-session pattern Learn
recommends for web APIs ("Tokens should be cached on a session basis").

References: *Acquire tokens in MSAL Node — On-Behalf-Of*; *A web API that calls web APIs:
OBO code config*; *MSAL token cache serialization (distributed persisted cache)*;
*Microsoft Entra auth for Azure SQL — access token*; *ADLS access control model (RBAC+ABAC+ACL)*;
*Storage Get User Delegation Key*; *Kusto row_level_security / current_principal*.

### 1.3 Token cache at 60k users

Each user holds ≤6 small encrypted token docs (ARM, SQL, storage, kusto, PBI-opt-in,
graph-opt-in) in the Cosmos `tenant-settings` container, partitioned by `oid`. 60k users ×
6 ≈ 360k docs, each <2 KB → ~0.7 GB, well within a single physical partition's reach per
oid (one logical partition per user, perfectly distributed). Reads are point-reads (~1 RU).
This store is **already the design**; we add two doc kinds. No new container.

---

## 2. Connection-pooling & perf at 60k (the hard part)

The shared-UAMI model uses **one** TDS pool (`max:10`). Per-user identity means **one TDS
connection carries one user's identity** — pools cannot be shared across users (sharing is a
privilege-escalation; the code already enforces this: `getUserPool` keys by
`${cacheKey}:user:${oid}`, `max:2`, 5-min idle). At 60k this is the scaling risk:

- **TDS / Synapse:** Synapse Serverless and Dedicated have bounded concurrency
  (Serverless ~ pooled; Dedicated has fixed concurrency slots by SKU). 60k users each with a
  2-connection pool is **not** viable as live connections — but it does not need to be:
  pools are **lazy + idle-evicted (5 min)**. Concurrency is bounded by *active* users, not
  registered users. Mitigations to ship:
  - **Global per-user-pool cap with LRU eviction** (new: `user-pool-registry.ts`) — hard
    ceiling (e.g. `LOOM_MAX_USER_POOLS=2000`) across all targets; evict least-recently-used
    pool on overflow. Prevents a replica from holding tens of thousands of pools.
  - **Per-user pool `max:1`** for serverless (a user rarely runs concurrent visuals; the
    report renderer batches). Keep `max:2` for interactive SQL editor.
  - **Statement timeout + queue** already present (60s race). Add a lightweight per-replica
    semaphore (`LOOM_MAX_CONCURRENT_USER_QUERIES`) to shed load with an honest 429 rather
    than exhausting Synapse slots.
  - **ACA scale-out** multiplies pools (each replica has its own Map). The cap is
    per-replica; set it as `ceiling / expected_replicas`.
- **ADLS:** `DataLakeServiceClient` is HTTP/REST (no long-lived sockets); per-user clients
  are cheap. Cache per-oid clients in an LRU with idle eviction; token refresh is the only
  cost. No connection-pool pressure.
- **ADX:** Kusto REST with `Authorization: Bearer <user token>` — stateless per request, no
  pooling concern; the cluster's own concurrency/throttling governs (size the cluster SKU,
  enable `Request rate limit` policy per principal).
- **AAS:** XMLA over HTTP; EffectiveUserName or per-user token per request — stateless.

**Net:** SQL is the only pooled resource and the only one needing the LRU cap + semaphore.
Everything else is stateless-per-request and scales with the backing service's own SKU.

---

## 3. Feature-flag rollout (incremental, reversible)

Generalize the proven SQL F10 mode into one resolver so every item type opts in identically.

**New:** `lib/azure/data-access-mode.ts` (generalizes `sql-access-mode.ts`):

```ts
export type DataAccessMode = 'service' | 'user';
// item.state.accessMode, default 'service'. Honors a GLOBAL kill-switch +
// a per-DOMAIN default + a per-ITEM override.
export async function resolveDataAccessMode(
  itemId: string, itemType: string, domainId?: string,
): Promise<DataAccessMode>;
```

Flags (env, all default OFF → byte-identical to today):
- `LOOM_OBO_DATA_PLANE=off|shadow|on` — master switch. `shadow` = run user-mode but
  fall back to service on any user-token miss AND log a structured "would-have-403" event
  (lets ops measure consent coverage before enforcing).
- `LOOM_OBO_ITEMS=report,synapse-serverless-sql-pool,…` — per-item-type allowlist; start
  with `report` + the two SQL pools + `kql-database`/`eventhouse` + `lakehouse`/`warehouse`.
- Per-domain default: `DomainItem.dataAccessModeDefault` (Cosmos) so a regulated domain can
  force `user` while others stay `service`.

Reversibility: setting `LOOM_OBO_DATA_PLANE=off` instantly reverts every route to the UAMI
path. Each route keeps its existing service branch unchanged; the user branch is purely
additive (exactly how `synapse-serverless-sql-pool/[id]/query/route.ts` is structured today).

---

## 4. File-level build spec

### P0 — Report read path → user identity (the brief's first target)

**Edit** `app/api/items/report/[id]/query/route.ts`:
- Import `resolveDataAccessMode`, `getUserSqlToken`, `executeQueryAsUser`,
  `getUserOboToken`.
- In Path 3 (loom-native Synapse) and Path 4 (connection executor), after resolving
  `runTarget`/executor, branch on `resolveDataAccessMode(id,'report',domainId)`:
  - `user`: `const tok = await getUserSqlToken(oid)`; if null → honest 403
    `code:'NO_USER_SQL_TOKEN'` (reuse the serverless route's message verbatim). Else
    `executeQueryAsUser(runTarget, compiled.sql, tok, oid, 30_000, compiled.parameters)`.
  - `service` (default): unchanged `executeQuery(...)`.
- For the ADX connection executor arm, thread the user kusto token (see ADX below).
- Echo `accessMode` + `executedBy: session.claims.upn` in the receipt (no-vaporware proof).

**Edit** `lib/azure/report-model-resolver.ts` — `ConnectionExecutor.runVisual` gains an
optional `identity?: { sqlToken?; kustoToken?; oid }` so the executor opens the per-user
connection instead of the shared one. Pure addition; absent ⇒ service path.

### P1 — ADLS user-delegation reads

**New** `lib/azure/adls-user-client.ts`: `getUserServiceClient(account, userStorageToken)`
returning a `DataLakeServiceClient` built from a `TokenCredential` wrapper over the cached
**storage-audience** user token (`https://storage.azure.com/.default`, gov:
`https://storage.azure.us/.default`). LRU-cache per `(account,oid)`. Used by the
lakehouse/file read paths when `accessMode==='user'`. Storage RBAC (Storage Blob Data
Reader) + ACLs then enforce per user; Loom never sees account keys.

**Edit** `lib/azure/mcp-obo-token-store.ts`: add `storage` to `OBO_RESOURCE` and a
`classify()` arm (host stem `storage_azure_com`/`storage_azure_us` → new
`storage-user-token-store.ts`, same shape as `sql-user-token-store.ts`).

**Edit** `lib/auth/msal.ts` → `captureUserMcpOboTokens` already iterates the catalog; add a
storage audience to the login capture list (or a dedicated `captureUserStorageToken` mirror
of the SQL capture in the callback).

### P1 — ADX (Kusto) user-token reads

**Edit** `lib/azure/kusto-client.ts`: add `executeQueryAsUser(clusterUri, db, kql, userKustoToken)`
that issues the REST `v2/rest/query` call with `Authorization: Bearer <userKustoToken>`
(audience `https://<cluster>.<kusto-suffix>` per `getKustoSuffix()`), mirroring
`executeQuery` but with the user token. ADX `current_principal()` RLS then filters rows at
the engine. Add `kusto` to `OBO_RESOURCE` + a `kusto-user-token-store.ts`.

### P1 — AAS DAX as the user

**Edit** `lib/azure/aas-client.ts` / `aas-xmla.ts`: when `accessMode==='user'`, either (a)
send the user's AAS-audience token on the XMLA call, or (b) keep the service token but add
the `EffectiveUserName=<upn>` XMLA property so AAS evaluates the user's RLS role. Prefer (a)
where the user holds an AAS data-reader role; (b) is the fallback when only the service
principal is an AAS admin. Honest gate when neither is configured.

### P0 plumbing — the resolver + stores

**New** `lib/azure/data-access-mode.ts` (§3). **New** `storage-user-token-store.ts`,
`kusto-user-token-store.ts` (copies of `sql-user-token-store.ts` with different doc-id
prefix + `kind`). **New** `lib/azure/user-pool-registry.ts` (LRU cap for per-user TDS pools,
§2). **Edit** `synapse-sql-client.ts` `getUserPool` to register/evict via the registry.

---

## 5. Bicep / deploy

- **App registration (`LOOM_MSAL_CLIENT_ID`)** — add **delegated** API permissions:
  `Azure SQL Database/user_impersonation` (already needed for F10),
  `Azure Storage/user_impersonation`, `Azure Data Explorer/user_impersonation`,
  `SQL Server Analysis Services/user_impersonation` (AAS), `Azure Service Management/user_impersonation`
  (ARM, already). This is an **app-registration manifest change**, expressed as a
  deploymentScript (Graph `az ad app permission add`) wired into
  `platform/fiab/bicep/modules/admin-plane/main.bicep`, OR documented as a tenant-admin
  runbook (see §8) since adding delegated perms + admin-consent often must be operator-run.
- **No new Azure resource** is strictly required for OBO itself. The per-domain MI (§7) adds
  one UAMI per domain.
- **Env wiring** — add to the `apps[].env` list in `admin-plane/main.bicep`:
  `LOOM_OBO_DATA_PLANE`, `LOOM_OBO_ITEMS`, `LOOM_MAX_USER_POOLS`,
  `LOOM_MAX_CONCURRENT_USER_QUERIES`, `LOOM_STORAGE_TOKEN_SCOPE`, `LOOM_KUSTO_TOKEN_SCOPE`
  (gov-overridable, defaulting via `cloud-endpoints.ts`).
- **Gov:** authority `login.microsoftonline.us` (already in `msal.ts`); audiences resolve via
  `cloud-endpoints.ts` (`database.usgovcloudapi.net`, `dfs.core.usgovcloudapi.net`,
  `kusto.usgovcloudapi.net`, `storage.azure.us`). IL4/5: private-endpoint-only + CMK already
  the deployment posture; OBO changes nothing network-wise (same private endpoints, the only
  difference is which principal's token rides the TDS/HTTPS call).

---

## 6. Cosmos stays UAMI (deliberate)

Cosmos holds **Loom metadata** (workspace/item/state, token cache, domain registry), not
user business data. Per-user data isolation there is already enforced by **app-layer
owner-checks + partition-key-by-oid** (`loadModelItem(id,type,oid)` owner-scopes every
read). Cosmos data-plane RBAC is coarse (account-level roles), so per-user OBO buys little
and costs a token per user per call. **Decision: Cosmos remains UAMI**; the defensible
boundary for *metadata* is the existing owner-check + the domain-tier authorization in
`domain-role.ts`. Document this explicitly so it is not mistaken for a gap. (Cosmos
autoscale/partition sizing for 60k is covered in the scale appendix, not here.)

---

## 7. Per-domain managed identity (service-to-service within a domain)

For background/service operations **scoped to one domain** (a domain's refresh job writing
its own Delta, a domain pipeline reading its own lake), a single global UAMI over-privileges
across domains. Option: **one UAMI per domain** (`uami-loom-domain-<slug>`), RBAC-granted
only to that domain's resources (its ADLS containers, its Synapse DB, its ADX db). The
domain registry (`domain-registry.ts`) gains `serviceIdentityClientId`. A new
`lib/azure/domain-credential.ts` returns the domain's UAMI credential (falling back to the
global Console UAMI when a domain has none — back-compat). Bicep: a per-domain UAMI module
invoked by the landing-zone orchestrator with scoped role assignments. This is the
service-side analog of OBO's user-side isolation: **least privilege at both layers**.

---

## 8. CODE vs TENANT-ADMIN action (runbooks)

| Action | Type | How |
|---|---|---|
| Add delegated API perms (SQL/Storage/ADX/AAS user_impersonation) on the Loom app reg | **Tenant-admin** | runbook: `az ad app permission add` per resource; honest in-product gate names it |
| **Admin consent** for those delegated scopes | **Tenant-admin** | `az ad app permission admin-consent --id $LOOM_MSAL_CLIENT_ID` (reuse `grant-sql-delegated-permission.sh`; add storage/adx siblings) |
| Map end-user **Entra groups** to Synapse contained DB users + GRANT (RLS/CLS) | **Tenant-admin / DBA** | `CREATE USER [grp] FROM EXTERNAL PROVIDER`; security policies (Learn: RLS on Synapse) |
| Grant end-user groups **Storage Blob Data Reader** + ACLs on ADLS containers | **Tenant-admin** | extend `grant-adls-*` scripts to take a group arg |
| Grant end-user groups **ADX database viewer** + author `.alter table policy row_level_security` | **Tenant-admin** | KQL mgmt commands; Loom surfaces the predicate from `kusto-rls-predicate.ts` |
| Everything else (resolver, stores, route branches, pools, flags, captures) | **CODE** | this appendix |

In-product honesty (no-vaporware): when `accessMode==='user'` and a user token is missing,
the route returns the existing 403 with the exact remediation + the script path. The admin
panel surfaces a "consent coverage" tile (fed by `shadow`-mode logs) so the operator sees how
many users would 403 before flipping to `on`.

---

## 9. Web-5.0 UI

- **Item editors** (lakehouse/warehouse/report/kql) gain an **"Access mode" segmented
  control** (Service identity ↔ User's identity) in a Fluent v9 `Card` with a `Tooltip`
  explaining RLS/CLS enforcement — reuse the existing F10 control pattern; never a freeform
  field.
- **Honest-gate MessageBar** (`intent="warning"`) with the exact consent script when a user
  lands a 403.
- **Admin → Security → Per-user data access** page: a wizard (domain default toggle, item-type
  allowlist, consent-coverage tile, "test as me" button that runs a probe query under the
  caller's token and shows the rows their RLS returns). All Loom tokens + cards.
- **Copilot**: an ops-copilot intent "why can't user X see these rows?" that explains
  RLS/consent state from the structured logs.

---

## 10. Acceptance criteria

1. With `LOOM_OBO_DATA_PLANE=off` → every route byte-identical to today (regression gate).
2. With `=on` + a report set to `user` mode: the `/query` receipt shows `accessMode:'user'`,
   `executedBy:<real upn>`, and **fewer rows for a low-privilege user than an admin** against
   the same RLS-protected Synapse table (proves source-side enforcement, not app-layer).
3. ADLS/ADX user reads return a **403 from the storage/Kusto engine** (not an app check) when
   the user's group lacks RBAC — proving the boundary is native.
4. Per-user TDS pool count never exceeds `LOOM_MAX_USER_POOLS` under a 60k soak; excess users
   get an honest 429, not a Synapse slot exhaustion.
5. Gov: same flow against `database.usgovcloudapi.net` / `kusto.usgovcloudapi.net` /
   `storage.azure.us` with `login.microsoftonline.us` authority.
6. `shadow` mode emits a consent-coverage metric and never breaks a query.
7. No `api.fabric` / `api.powerbi` / `onelake` host on any default path (no-fabric-dependency).

---

## 11. Migration order (behind the flag)

1. Ship the resolver + stores + flags + UI control (no behavior change; default off).
2. Enable `report` + the two SQL pools in `shadow` for one regulated domain; measure consent.
3. Run the consent + group-RBAC runbooks for that domain.
4. Flip that domain to `on`; validate acceptance #2-3.
5. Add ADLS, then ADX, then AAS audiences (each its own `shadow`→`on` step).
6. Expand item-type allowlist; roll per-domain. The other ~225 UAMI sites (provisioning,
   admin, metadata, Resource Graph, Purview) **stay UAMI by design** — only *user data reads*
   migrate. Final state ≈ 15-25 read routes on OBO, the rest correctly on the service identity.
