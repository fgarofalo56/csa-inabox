# external-engine-federation — parity with Databricks Unity Catalog external data access

**Slug:** `external-engine-federation`
**Loom surfaces:** `/admin/catalog` ("External-engine federation (Iceberg)"), `/catalog/unity?tab=federation`, `/items/sql-lab/<id>` (engine picker), `/items/lakehouse/<id>` (Interop tab), `/admin/policy-code`, `/catalog/permissions`, `/governance/lineage`
**Backing services:** `iceberg-catalog` (Unity Catalog OSS, Iceberg REST surface), `loom-trino` (federated query), `loom-unity` (governance plane) — all internal-ingress Azure Container Apps
**Graded:** 2026-08-07, against the live **Commercial** estate (build `03bab987`)

## Source UI

Databricks Unity Catalog external data access + Lakehouse Federation. Inventory
grounded in current docs, not memory:

- <https://docs.databricks.com/aws/en/external-access/iceberg>
- <https://docs.databricks.com/aws/en/external-access/credential-vending>
- <https://docs.databricks.com/aws/en/external-access/cross-engine-abac>
- <https://docs.databricks.com/aws/en/external-access/admin>
- <https://docs.databricks.com/aws/en/external-access/integrations>
- <https://docs.databricks.com/aws/en/query-federation/>
- <https://docs.databricks.com/aws/en/query-federation/foreign-catalogs>
- <https://docs.databricks.com/aws/en/query-federation/connections>
- <https://docs.databricks.com/aws/en/data-governance/unity-catalog/external-lineage>
- <https://docs.databricks.com/aws/en/opensharing/>

## Verdict

**Grade: D (Stubbed→Functional, data path broken at time of grading).** NOT A+.

Of 58 inventory rows: **18 built ✅**, **14 honest-gate ⚠️**, **26 MISSING ❌**.

*(Re-graded 2026-08-07 after the post-deploy walk. Was 21/12/25. Four rows moved
DOWN — not because anything regressed, but because the walk measured what the
first grade had inferred. See RC-7.)*

The headline is not the row count. It is that **the primary discovery path was
returning HTTP 403 on the live estate** — measured, warm, reproducible — so a
user following the documented flow got nothing. That is fixed in code by the PR
carrying this doc, but **merged is not deployed** (`deploy-integrity.md` R2): the
fix requires a loom-console rebuild + roll before any A-grade claim is possible.

## Measured live behaviour (Commercial, 2026-08-07)

Minted-session probe against the live Commercial console (`<your-console-hostname>`):

| Call | Cold | Warm | Verdict |
|---|---|---|---|
| `GET /api/catalog/unity/capabilities` | — | **200 / 293ms** | ✅ reports `backend:oss`, `mode:entra`, `configured:true` |
| `GET /api/catalog/iceberg/namespaces` | 403 / 23,370ms | **403 / 307ms** | ❌ **`"Iceberg REST Catalog returned HTTP 403"`** |
| `GET /api/catalog/iceberg/config` | **504 / 30,273ms** | — | ❌ Front Door 30s timeout on cold start |
| `GET /api/catalog/unity/foreign-catalogs` | **504 / 30,059ms** | **200 / 219ms** | ⚠️ works warm; `catalogs: []` |
| `GET /api/catalog/iceberg/overview` | — | 403 / 200ms | ⚠️ `admin_only` |
| `GET /api/governance/policy-code/engine-rules` | — | 403 / 342ms | ⚠️ `admin_only` |

## Root causes found

### RC-1 — Iceberg REST proxy sent the raw Entra token (the 403). **Fixed in this PR.**

`lib/azure/iceberg-catalog-client.ts` minted an Entra token and put it straight
on the wire. The catalog is the `loom-unity` image, whose `AuthDecorator` rejects
any bearer whose `iss` is not its own `internal` issuer — so a byte-exact
audience is *still* answered 403. The sibling Unity path has exchanged that token
for a server-minted internal one since #2679 (`uc-token-exchange.ts`); the
Iceberg path never adopted the helper. Guard-adoption gap: the correct helper
existed and one caller never picked it up.

The unit fixture had **encoded the bug**: `iceberg-proxy.test.ts` had a test
named *"sends the server-minted bearer upstream"* whose assertion was
`expect(...).toBe('Bearer tok-api://app-client-id/.default')` — the raw Entra
token from the credential double. It modelled the code, not the server, so it
passed for as long as the bug existed.

Fix: `exchangeForInternalUcToken(subjectToken, baseOverride?)`, with the Iceberg
client passing its **own** base. `iceberg-catalog` and `loom-unity` are separate
Container Apps with separate databases and separate minted-token state, so a
token minted by one is not honoured by the other; the cache key already folds in
the base. The override is validated against the deployment's configured URLs so
this cannot become a credential-exfiltration primitive (the module header had
explicitly warned that day would come).

### RC-2 — the Iceberg catalog is AMNESIAC. **Not fixed; needs a deploy change.**

`iceberg-catalog` runs with `LOOM_UNITY_DB_LOCAL=1` and **no** `LOOM_UNITY_DB_URL`,
so per `apps/loom-unity/bin/loom-entrypoint.sh:66` it uses the *local ephemeral H2
directory* — the entrypoint says so itself: *"catalog NOT persisted across
restarts"*. It is also `ScaledToZero` with 0 replicas. **Every namespace or table
registered through the console is lost the next time the app scales to zero.**
`loom-unity` does not have this problem (it has `LOOM_UNITY_DB_URL` pointing at
`psql-loom-unity`, and `DB_URL` wins over `DB_LOCAL`). The Iceberg catalog needs
the same Postgres store.

### RC-3 — cold start exceeds the Front Door timeout. **Not fixed.**

Both engines are scale-to-zero. A cold `GET /api/catalog/iceberg/config` took
**30,273ms** and the user got a **Front Door "Service unavailable" HTML page** —
not a Loom surface, not an honest gate, no retry affordance. Warm, the same call
is ~200-350ms. A ~100x spread with a hard 30s ceiling above it.

### RC-4 — no human has tenant-admin, so the main federation UI 403s. **Not fixed; deploy param.**

- `LOOM_TENANT_ADMIN_OID` = `<sp-client-id>` = the **deployment service principal** (the `*_deploy` SP), which never signs into the UI.
- `LOOM_TENANT_ADMIN_GROUP_ID` = **empty**.
- The Entra group **`Loom Admins`** (`<admin-group-id>`) exists and the operator **is a member** — but it is not wired into the console.

Net: `/admin/catalog` — the surface literally named "External-engine federation
(Iceberg)" — answers `403 admin_only` for the operator. The remediation text
tells them to set a deploy param, which per `auto-bind-by-default.md` §5 is a
violation: the deploy could have set it.

### RC-5 — Trino runs `file` access control, not the compiled policy. **Not fixed.**

`loom-trino` has `LOOM_TRINO_ACCESS_CONTROL=file` while also carrying
`LOOM_TRINO_POLICY_URL` + `LOOM_TRINO_POLICY_TOKEN` + a 60s refresh. The
policy-as-code compiler (`compilers/trino.ts`) emits OPA rego, but the engine is
not configured to consume it. Console-side `LOOM_TRINO_CATALOG_POLICY` and
`LOOM_TRINO_IMPERSONATION` are both empty strings, so `trino-authz.ts`
deny-by-default per-caller catalog authorization has no policy to enforce. This
is the open LU-7 work in ledger task C5.

### RC-6 — the audience app exposes no scopes or roles.

`api://<app-client-id>` is the console's **own MSAL sign-in app** (`CSA Loom Console
(kv-loom-<suffix>)`), with `appRoles: []` and `oauth2PermissionScopes: []`. The catalog
derives its accepted audiences as `api://<client-id>,<client-id>`, so a **user's
sign-in token for the console is also a valid catalog bearer**. Sign-in identity
and API audience should not be the same app registration.

### RC-7 — the token exchange itself never worked. **Fixed in PR #3116; not deployed.**

RC-1 was real and its fix is LIVE (`loom-console:249669de`). Taking the receipt
it enabled immediately exposed the layer underneath. Measured warm, minted
session, 2026-08-07:

```
GET /api/catalog/iceberg/namespaces  ->  502 in 440ms
"Loom Unity rejected the token exchange (HTTP 400).
 {"error_code":"INVALID_ARGUMENT","message":"Unsupported requested token type: null"}"
```

The client sent THREE form params where the server requires FOUR — it omitted
`requested_token_type`. This was never Iceberg-specific; the same client backs
the Unity path, which fails identically:

```
GET /api/catalog/metastores  ->  200, but:
"workspace loom-unity...unreachable: 400 ... Unsupported requested token type: null"
unity: []
```

So **#2679's exchange had not once completed against a live catalog, for either
path.** Every capability whose backend is the OSS-UC server — catalog browse,
grants, securables, foreign catalogs, Iceberg discovery — has been non-functional
live for as long as `authMode=entra` has been on, while the surfaces above them
rendered cleanly with empty results.

That last clause is the important one, and it is why four rows moved down in this
re-grade. `/api/catalog/metastores` answers **200**. A grader reading status codes
sees health; only reading the body shows `unity: []` beside an error array. This
is `ux-baseline.md` G1's stated failure mode word for word — "Browse pages
rendered fine with 0-counts because the data path was dead."

Nothing caught it because every unit test doubled the exchange endpoint with a
stub that returned an `access_token` for ANY request body. The fixtures modelled
the code, not the server. `scripts/ci/check-uc-token-exchange-params.mjs` now
diffs the client against `apps/loom-unity/tests/authz/authz-e2e.sh` — the only
artifact in the repo that has actually run against the real image.

### RC-8 — the exchange timeout is shorter than the cold start it must survive.

`TIMEOUT_MS = 10_000` in `uc-token-exchange.ts`, against Container Apps that
scale to zero and take ~23s to become `Running`. Measured, first call after
scale-down:

```
GET /api/catalog/iceberg/namespaces  ->  502 in 10,865ms
"token exchange could not reach ...:  timed out after 10000ms"
```

So the FIRST authenticated call after any idle period fails, with an error that
reads like a network fault rather than a cold start. Two consecutive attempts
failed this way before the app finished activating. Fixing RC-7 alone leaves this
in place. Either raise the exchange timeout above the cold-start budget, or hold
`minReplicas: 1` (RC-3), or both — but a 10s ceiling in front of a 23s cold start
is a guaranteed first-call failure.

## What the live walk can and cannot demonstrate

Stated plainly, because RC-2 (the amnesiac catalog) bounds it:

**Meaningful today.** Auth posture end-to-end (401 unauthenticated / exchange /
audience / audit rows); every read path's real status and body; cold-vs-warm
timings; the browser surfaces, their empty and error states, narrow-width
behaviour and first-open cleanliness; and the negative results above, which are
the most valuable output of this pass.

**NOT meaningful until RC-2 is fixed.** Any assertion that a registered namespace
or table PERSISTS. `iceberg-catalog` runs on an ephemeral H2 dir and scales to
zero, so a register-then-browse walk only proves anything *within a single warm
window* — and the moment it scales down the catalog is empty again. A green
"registered a catalog and browsed it" receipt would therefore be true and
misleading at the same time. The spec deliberately does not claim it.

**NOT reachable at all today.** A federated query returning REAL ROWS, and the
cross-engine zero-copy read of a Loom Delta table. Both require the exchange
(RC-7, fix merged not deployed) AND a mounted catalog (`catalogs: []`, row 3.2)
AND storage credentials (`LOOM_LAKE_ACCOUNT` empty, §4). Three independent
blockers, none of them in the console code this lane can fix. Claiming a row
receipt before those land would be fabrication.

## Feature inventory vs Loom coverage

Legend: ✅ built · ⚠️ honest gate / partial · ❌ missing

### 1. Iceberg REST Catalog

| # | UC capability (doc) | Loom | Backend / note |
|---|---|---|---|
| 1.1 | IRC endpoint exposed for external clients | ✅ | `iceberg-catalog` ACA at `/api/2.1/unity-catalog/iceberg`; proxied by `/api/catalog/iceberg/*` |
| 1.2 | OAuth auth to IRC | ⚠️ | Entra bearer → internal-token exchange (RC-1, fix unrolled) |
| 1.3 | PAT auth to IRC | ✅ | Loom scoped API tokens accepted by the BFF proxy |
| 1.4 | Get catalog URI + auth config in UI | ⚠️ | `/admin/catalog` "Connect an external engine" snippets — but the page is admin-gated and 403s (RC-4) |
| 1.5 | Snowflake catalog-linked database | ❌ | snippet only; no linked-DB flow |
| 1.6 | Snowflake external tables (manual) | ✅ | `iceberg-metadata.ts` snowflake snippet |
| 1.7 | Trino/Presto via IRC | ⚠️ | `loom-trino` wired to `LOOM_ICEBERG_CATALOG_URL`; unverified end-to-end (403 upstream) |
| 1.8 | PyIceberg via IRC | ❌ | no PyIceberg snippet |
| 1.9 | DuckDB access | ✅ | duckdb snippet + `loom-duckdb` |
| 1.10 | Flink via IRC | ❌ | not offered |
| 1.11 | Automatic credential vending to IRC clients | ❌ | **no vending** — `LOOM_LAKE_ACCOUNT` is EMPTY on both `iceberg-catalog` and `loom-trino`, so no ADLS credential can be vended |
| 1.12 | REST call returns metadata + temp creds | ❌ | consequence of 1.11 |

### 2. Managed vs foreign Iceberg

| # | UC capability | Loom | Note |
|---|---|---|---|
| 2.1 | Create managed Iceberg table | ⚠️ | `uc-table-format-builders.ts` emits Iceberg DDL; not driven end-to-end |
| 2.2 | External client READS managed Iceberg | ⚠️ | blocked by RC-1 at grading time |
| 2.3 | External client WRITES managed Iceberg | ❌ | no external-commit path |
| 2.4 | Foreign catalog mirroring an external Iceberg catalog | ❌ | `foreign-catalogs` returned `catalogs: []`; LU-11 open |
| 2.5 | `REFRESH FOREIGN TABLE` | ❌ | no refresh control |
| 2.6 | Foreign-Iceberg vending limitation surfaced | ❌ | n/a — no vending at all |
| 2.7 | Managed Delta with Iceberg reads enabled | ✅ | lakehouse **Interop** tab, per-table "Expose as Iceberg" (real Synapse Spark job) |
| 2.8 | External Delta with Iceberg reads | ✅ | same surface |
| 2.9 | Duplicate-data-file detection on external commit | ❌ | no external commit path |
| 2.10 | DEEP CLONE foreign → managed | ❌ | absent |

### 3. Lakehouse Federation / foreign catalogs

| # | UC capability | Loom | Note |
|---|---|---|---|
| 3.1 | Create connection UI (JDBC + creds) | ⚠️ | `/connections` registers Linked Services, but they are not foreign catalogs |
| 3.2 | Auto-create foreign catalog from connection | ❌ | **the Federation pane tells the user to "Add to `loomBackends.trinoCatalogs`"** — i.e. hand-edit bicep. Direct `auto-bind-by-default.md` §5 violation |
| 3.3 | JDBC query pushdown | ⚠️ | Trino connectors can push down; no catalog is mounted to prove it |
| 3.4 | 11 supported federation sources | ❌ | zero mounted (`catalogs: []`) |
| 3.5 | Catalog federation (Hive/Glue/Snowflake catalogs) | ❌ | absent |
| 3.6 | Query directly against object storage | ✅ | Trino Iceberg/Delta over ADLS is the design |
| 3.7 | Foreign catalog appears in Catalog Explorer | ⚠️ | Federation pane lists *candidates*, not mounted catalogs |
| 3.8 | Browse foreign schemas/tables | ❌ | nothing mounted to browse |
| 3.9 | Grant privileges on foreign tables | ❌ | No foreign catalogs exist AND the UC grant fan-out is non-functional live (RC-7). Was ⚠️ on an untested assumption |
| 3.10 | Foreign tables read-only | ✅ | inherent |
| 3.11 | Materialized views over foreign tables | ❌ | absent |

### 4. Credential vending

| # | UC capability | Loom | Note |
|---|---|---|---|
| 4.1 | `temporary-table-credentials` | ❌ | not implemented |
| 4.2 | `temporary-path-credentials` | ❌ | not implemented |
| 4.3 | Volume credential vending | ❌ | not implemented |
| 4.4 | Auto-vending in IRC responses | ❌ | `LOOM_LAKE_ACCOUNT` empty (RC-1 note) |
| 4.5-4.8 | Vending per table type | ❌ | consequence of 4.1 |
| 4.9 | "External data access" metastore toggle | ❌ | no equivalent switch |
| 4.10 | `EXTERNAL USE SCHEMA` privilege | ❌ | no equivalent privilege |
| 4.11 | `EXTERNAL USE LOCATION` privilege | ❌ | no equivalent |
| 4.12 | Vending limitations documented in-product | ❌ | n/a |

> Credential vending is the single largest gap: **11 consecutive ❌**. Today an
> external engine must be granted storage access out-of-band, which is exactly
> the "user does the plumbing" state `auto-bind-by-default.md` forbids.

### 5. Governance over externally-accessed objects

| # | UC capability | Loom | Note |
|---|---|---|---|
| 5.1 | Cross-engine ABAC (row filters + masks) for external engines | ❌ | UC ships this Beta; Loom has no equivalent |
| 5.2 | Managed Delta with catalog commits | ❌ | absent |
| 5.3 | Row filter applied to external reads | ⚠️ | compiler emits Trino rules, engine runs `file` ACL (RC-5) |
| 5.4 | Column mask applied to external reads | ⚠️ | same |
| 5.5 | Read-only when FGAC applied | ❌ | n/a |
| 5.6 | Serverless enforcement cost attribution | ✅ | **Loom EXCEEDS**: `finops/query-run.ts` + FOCUS mart attribute per-engine cost incl. Trino |
| 5.7 | Table-level ACLs on foreign tables | ⚠️ | `trino-authz.ts` deny-by-default exists; `LOOM_TRINO_CATALOG_POLICY` empty |
| 5.8 | No filters/masks on foreign tables | ✅ | same limitation, honestly |
| 5.9 | Audit logging of external access | ✅ | **Loom EXCEEDS**: every IRC read/write writes a Cosmos `_auditLog` row with principal + namespace/table scope; LIST aggregated. Enforced by a CI chokepoint guard |
| 5.10 | OAuth M2M for external clients | ⚠️ | console UAMI only; no third-party service principal onboarding |

### 6. Lineage

| # | UC capability | Loom | Note |
|---|---|---|---|
| 6.1 | Lineage for foreign catalog tables | ❌ | nothing mounted |
| 6.2 | External-engine reads not auto-lineaged | ✅ | same limitation |
| 6.3 | Register external assets for lineage | ✅ | `/governance/interop` OpenLineage/DataHub/OpenMetadata export |
| 6.4 | Add external→UC lineage edges | ✅ | OpenLineage emitters (#2626) |
| 6.5 | Managed-ingestion automatic lineage | ✅ | pipeline emitters |
| 6.6 | Query federation lineage limitation | ✅ | same |
| 6.7 | Lineage system tables | ⚠️ | `uc-system-tables.ts` is Databricks-backed; no OSS-UC equivalent |

### 7. Delta Sharing

| # | UC capability | Loom | Note |
|---|---|---|---|
| 7.1 | Open sharing protocol endpoint | ✅ | `/api/delta-sharing/<path>` |
| 7.2 | Create share via UI | ✅ | `/marketplace?tab=shares`, `/catalog/unity?tab=sharing` |
| 7.3 | Recipient reads with bearer token | ✅ | protocol route + E2E (#2619) |
| 7.4 | OIDC U2M | ⚠️ | bearer-token path is primary |
| 7.5 | OAuth M2M | ⚠️ | as above |
| 7.6 | Cloud token access | ❌ | absent |
| 7.7 | Share managed Iceberg tables | ❌ | absent |
| 7.8 | Delta Sharing on federated tables | ❌ | absent |
| 7.9 | Delta Sharing to external Iceberg clients | ❌ | absent |
| 7.10 | Audit on shared-table access | ✅ | audit trail |
| 7.11 | Revoke share/recipient | ✅ | control plane |

### 8. Catalog Explorer surfaces

| # | UC capability | Loom | Note |
|---|---|---|---|
| 8.1 | Catalog Explorer | ⚠️ | Surface renders, but `/api/catalog/metastores` returns `unity: []` with `unityWorkspaceErrors` — the OSS-UC data path is dead (RC-7). This is the ux-baseline G1 failure mode verbatim: a page that renders fine with 0-counts |
| 8.2 | Catalog Details tab | ⚠️ | Same: renders over an empty result set while the exchange fails (RC-7) |
| 8.3 | Foreign catalog shows its Connection | ⚠️ | Federation pane shows candidate sources |
| 8.4 | Schema Overview | ✅ | |
| 8.5 | Sample data tab | ✅ | type-badged previews |
| 8.6 | Table Details | ✅ | |
| 8.7 | Permissions tab | ⚠️ | Design still **exceeds** UC (one Loom role fans out to UC GRANTs + OneLake roles), but every UC-side GRANT rides the broken exchange, so the fan-out cannot complete live (RC-7) |
| 8.8 | Lineage tab | ✅ | `/catalog/lineage` |
| 8.9 | Insights (usage trends) | ❌ | absent |
| 8.10 | Connections management | ✅ | `/connections` |
| 8.11 | External locations UI | ⚠️ | `/catalog/unity?tab=storage` |
| 8.12 | Storage credentials UI | ⚠️ | same |
| 8.13 | ERD | ❌ | absent |
| 8.14 | Shares tab | ✅ | |

## Where Loom can EXCEED Unity Catalog

1. **Sovereign / air-gapped by construction.** The catalog is an OSS container on
   the deployment's own Container Apps environment reading the deployment's own
   ADLS over its own VNet. There is no SaaS control plane, so a disconnected IL5
   enclave can still hand Trino a working Iceberg catalog. Databricks cannot.
2. **Per-engine cost attribution as a first-class surface.** FOCUS-shaped cost
   records per federated query run (`finops/focus-mart.ts`). UC bills external
   ABAC enforcement as an opaque `EXTERNAL_COMPATIBILITY` SKU.
3. **One governance action fanning out across engines.** `/admin/policy-code`
   compiles a single policy set to Synapse DENY/RLS, UC grants, ADX RLS, Purview
   markings *and* Trino rules. UC governs UC.
4. **Audit chokepoint enforced in CI.** A guard fails the build when a new exit
   reaches the catalog outside the audited transport, with declared gaps printed
   on every passing run. That is stronger than a documented audit table.

## What needs UPDATE / REFACTOR / OPTIMIZE

Ordered by operator-visible impact.

1. **Deploy the RC-7 fix** (PR #3116 — the missing `requested_token_type`).
   RC-1 is now LIVE and did its job; RC-7 is the blocker underneath it, and it
   gates EVERY OSS-UC capability, not just Iceberg. *Merged, not deployed.*
1b. **Raise the exchange timeout above the cold-start budget** (RC-8) — 10s in
   front of a ~23s cold start fails the first call after every idle period.
2. **Give `iceberg-catalog` the Postgres store** (RC-2). Pass `unityPostgresFqdn`
   to the iceberg-catalog module exactly as `loom-unity-app.bicep` does. Until
   then the catalog silently forgets everything on scale-to-zero — the worst
   class of bug, because it looks like it worked.
3. **Set `LOOM_TENANT_ADMIN_GROUP_ID` to the `Loom Admins` group** (RC-4).
   One deploy param stands between the operator and the federation admin UI.
4. **Kill the 30s cold-start cliff** (RC-3). Either `minReplicas: 1` on the two
   engines, or a warm-up ping on the federation surfaces plus an in-product
   "engine is starting" state. Today the user gets a Front Door HTML 504 with no
   Loom chrome at all. Measured: 30,273ms cold vs 307ms warm.
5. **Make "federate this source" a button** (row 3.2). The Federation pane's
   remediation is *"Add to `loomBackends.trinoCatalogs`"* — hand-edit bicep.
   It should register the catalog from an existing `/connections` entry in-product.
6. **Implement credential vending** (§4, 11 ❌). The largest single parity gap and
   the one that most blocks real external-engine use.
7. **Switch Trino to the compiled policy** (RC-5): `LOOM_TRINO_ACCESS_CONTROL=opa`,
   populate `LOOM_TRINO_CATALOG_POLICY`. The compiler already emits rego.
8. **Split the API audience from the sign-in app** (RC-6). A separate app
   registration with a real exposed scope, so a console sign-in token is not
   also a catalog credential.
9. **Add PyIceberg and Flink connect snippets** (rows 1.8, 1.10) — cheap, and
   they are two of the most common IRC clients.
10. **`LOOM_LAKE_ACCOUNT` is empty** on both `loom-trino` and `iceberg-catalog`.
    Nothing can vend or resolve storage without it.

## Per-cloud status

| | Commercial | Azure Government |
|---|---|---|
| `iceberg-catalog` | ✅ deployed (`loom-unity:089fb622`), Healthy, **ScaledToZero**, ephemeral H2 | ❌ **not deployed** |
| `loom-trino` | ✅ deployed (`loom-trino:v0.1`), Healthy, ScaledToZero | ❌ **not deployed** |
| `loom-unity` | ✅ deployed, Healthy, Running, **Postgres + Entra** | ⚠️ deployed on `h2-ephemeral`, no auth env vars, internal-only |
| Console federation env | ✅ all 13 vars wired | ❌ absent |

**Provenance.** The Commercial column is measured directly (`az containerapp
show` / `revision list`, 2026-08-07). The Gov column is NOT: this lane holds no
Gov credential and Gov receipts must come from GitHub Actions, never local az.
What this lane independently corroborated through Actions is the *cause*:

- `gov-build-images.yml` — **never run** (zero runs in the API).
- `deploy-gov.yml` — **failed** its last two runs, most recent **2026-07-21**.

So the Gov image producer has never executed and the Gov deploy path has been
red for over two weeks. The per-app Gov states above are carried from the
L-GOV lane's reading and are marked as such rather than restated as this lane's
own measurement.

**Gov has no external-engine federation.** Per `deploy-integrity.md` R4 a
Commercial-only result is not a completed result. Gov additionally carries the
`#3060` exposure (v0.5.1 classpath override inert in the Gov image) and #2643
(auth disabled live). Closing this needs L-GOV (ledger G2/G3), not this lane.

## Verification receipt

- **Spec:** `apps/fiab-console/e2e/external-engine-federation.spec.ts`
- **Project:** `external-engine-federation` (`dependencies: ['mint']`, `retries: 2`)
- **Dispatch:** `gh workflow run loom-ui-verify.yml --ref main -f extra_projects=external-engine-federation`
- **Artifacts:** dark+light screenshots of the Federation tab and the SQL Lab
  engine picker, narrow-width (900px) captures, and measured timings at
  `test-results/receipts/external-engine-federation-timings.json`.

The spec reports a deliberate three-way verdict on the data path — `working` /
`pre-fix-403` / `regressed` — so a run against a console image that predates the
RC-1 fix is recorded honestly instead of being smoothed into a pass or thrown as
a false regression.

**This surface is NOT A+ and this doc does not claim it is.** 26 ❌ is the real
count, and the re-grade moved rows DOWN, not up. A+ requires, at minimum: RC-7 deployed (RC-1 already is), RC-8 raised, RC-2
durable, RC-4 unblocked, credential vending built, and Gov at parity. No
authenticated catalog read has yet succeeded on this estate — until one does,
no grade above D is defensible.
