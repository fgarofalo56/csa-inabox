# Unity Catalog for Azure Government — loom-unity (self-hosted OSS Unity Catalog)

**Status:** Azure-native, default catalog backend in Azure Government.
**Scope:** `apps/loom-unity`,
`platform/fiab/bicep/modules/compute/loom-unity-app.bicep`,
`platform/fiab/bicep/modules/data-plane/loom-unity-postgres.bicep`,
`apps/fiab-console/lib/azure/uc-backend.ts` (+ `unity-catalog-client.ts`).

> **Naming.** The platform is **Loom Unity** — Loom's Unity-Catalog-**compatible**
> metastore. It is not a Databricks product and is never presented as one.

## Per-cloud status (measured 2026-08-06)

`.claude/rules/cloud-parity.md`: a capability that works in Commercial and not in
Gov is **incomplete**, not "Commercial-first". This table is the honest state of
that parity for Loom Unity and the two surfaces that federate against it. Every
non-parity row names its fix and where it sits in the sequence — none is left as
"Gov lags".

| Capability | Commercial | Azure Government (GCC-High / IL5) | Fix + sequence |
|---|---|---|---|
| Catalog deployed by the orchestrator | ✅ `admin-plane/main.bicep` (default-ON) | ✅ same module, same default — bicep is correct on the Gov path | — |
| Catalog **image** in the registry | ✅ `full-app-deploy-commercial.yml` | ⚠️ only `gov-build-images.yml` (**never run**) or `gov-uc-purview-wire.yml` | dispatch `gov-build-images` (boundary=gcc-high) |
| **Persistence** | ✅ `postgres` — durable, backed up, Entra-only (no DB credential anywhere), multi-writer | ❌ `h2-ephemeral` — an EmptyDir that **loses every catalog object on container restart**, forced `maxReplicas: 1` | `loomBackends.postgresStores = 'enabled'` once PG flexible-server quota is confirmed in usgovvirginia. Postgres **is** available in US Gov Virginia / Arizona / Texas per Learn — this is a subscription quota question, not a service gap. Note (#3754) that this same lever now also gates the **Weave / pgvector** server, which until then ignored the quota flag entirely and failed the whole GCC-High subscription deployment with `ParameterOutOfRange: The value of the 'Version' should be in: []` — so flipping it lights the Ontology + pgvector surfaces alongside the durable metastore |
| **Authorization** | ✅ enforced (Entra, sealed when no audience is pinnable) | ❌ **DISABLED live since the 07-15 image** — anonymous read + mutate + SAS (#2643). Code fixed in #2974 / #3002 | dispatch `gov-uc-purview-wire.yml` (attended, 3.5–4.5 h) |
| v0.5.1 `#1603` permission-GET fix | ✅ shipped | ⚠️ present in the Dockerfile but **INERT in every shipped Gov image** (#3060) — the classpath patch hit the wrong module | the Dockerfile is fixed at HEAD; a Gov **rebuild** applies it. The build-time assertion fails closed if the override is not first on `server/target/classpath` |
| Iceberg REST Catalog (`LOOM_ICEBERG_CATALOG_URL`) | ✅ deployed + wired by `admin-plane/main.bicep` | ❌ **no out-of-band Gov workflow deploys it or wires the URL** | only the orchestrated `deploy-fiab-gcch` covers it — that lane has been RED for 16 days and must go green |
| Federated SQL engine (`LOOM_TRINO_URL`) | ✅ deployed by `admin-plane/main.bicep` | ⚠️ module + params correct; the only out-of-band producer `gov-provision-trino.yml` has **never run**, and its image comes from `gov-provision-dataplane-images.yml` (**never run**) | dispatch the image lane, then Trino or the orchestrated deploy |

**Why this matters more in Gov than in Commercial.** Databricks Unity Catalog has
no Azure Government endpoint, so a Commercial customer who finds Loom Unity
degraded still has the managed service to fall back on and a Gov customer does
not. Loom Unity plus Iceberg/Trino federation **is** the catalog and
external-engine-federation product for that boundary. Shipping it Commercial-first
inverts the priority: the boundary with the greatest need would get the least
product.

**The store cutover, stated precisely.** Because Gov has always run
`h2-ephemeral`, there is **no durable Gov catalog store to migrate from** — the
metadata already does not survive a restart. Flipping `postgresStores` therefore
stands up a **fresh, empty** Postgres; that is correct behaviour, not data loss,
but any catalog objects created since the last restart are gone and must be
re-registered. Plan the flip as a cutover with re-registration, not as a migration.

### Gov deploy-lane run history (measured 2026-08-07)

Every lane that could produce or deploy the components above. "NEVER RUN" is the
loudest form of `deploy-integrity.md` R3, not a silent pass.

| Workflow | History | Why it matters here |
|---|---|---|
| `gov-build-images` | **NEVER RUN** | the only from-scratch producer of `loom-unity` (its app list defaults to `loom-console,loom-uat,loom-unity`) |
| `gov-provision-dataplane-images` | **NEVER RUN** | produces `loom-duckdb` **and** `loom-trino` |
| `gov-provision-trino` | **NEVER RUN** | the only out-of-band producer of the Trino Container App |
| `gov-provision-streaming-migrate` | **NEVER RUN** | loom-migrate / loom-risingwave |
| `gov-workspace-identity` | **NEVER RUN** | — |
| `deploy-fiab-il5` | **NEVER RUN** | the IL5 boundary has no observed deploy at all, so its param-bag defect (fixed 2026-08-07) was never empirically hit |
| `deploy-fiab-gcch` | failing daily → 2026-08-03 | root cause was the **missing brownfield path**, not a broken deploy — fixed by `allow_existing_hub` |
| `gov-uc-purview-wire` | last success 2026-07-15; failed 2026-08-06 | owns the #2643 auth fix; needs an attended window |
| `deploy-gov` | failure 2026-07-21 (last run) | — |

**GCC (as distinct from GCC-High)** is a separate, tracked gap: `gcc.bicepparam`
never sets `deployAppsEnabled`, which defaults false, so that boundary deploys
zero Container Apps — no catalog, no Trino, no Iceberg. Tracked with an owner in
**#3078**; not flipped blind because there is no GCC image producer yet.

## Why this exists — the Gov gap

CSA Loom's Unified Catalog talks to **Databricks Unity Catalog** over the
`/api/2.1/unity-catalog/*` REST surface for catalog/schema/table/volume browse,
CRUD, and grants. **Databricks Unity Catalog has no Azure Government endpoint** —
in GCC-High / IL5 / DoD the Databricks control plane and the UC REST surface Loom
depends on are unavailable or limited. A Gov customer who clones this repo and
deploys must still get a working Unity Catalog day one, without a Fabric or
Databricks dependency (`.claude/rules/no-fabric-dependency.md`,
`.claude/rules/no-vaporware.md`).

`loom-unity` closes that gap by packaging the **open-source Unity Catalog server**
([unitycatalog.io](https://www.unitycatalog.io/), LF AI & Data;
[github.com/unitycatalog/unitycatalog](https://github.com/unitycatalog/unitycatalog),
**v0.5.0**) as a Loom Container App. It exposes the **same REST API** the Loom
client already speaks, so the switch is a base-URL + auth change — not a new client.

**Image pin — SUPERSEDED 2026-08-04; see `apps/loom-unity/Dockerfile` for the
current contract.** The paragraph below described the state before the v0.5.1
overlay existed and is kept only so the reasoning trail is legible. What ships
now: the base image is still pinned at **v0.5.0** (Docker Hub genuinely never
published a v0.5.1 image), but stage 2 **overlays the upstream v0.5.1
`unitycatalog-server` artifact from Maven Central** — upstream's own released
binary, prepended to the server classpath so its `#1603`-fixed classes win the
first-match scan. That is the same "packaging, not a fork" seam the Postgres JDBC
driver already uses. Two consequences worth carrying: (1) the earlier "there is
nothing to bump to" conclusion checked **only** Docker Hub and was incomplete;
(2) as of #3060 the overlay was **INERT in every shipped image** — the patch
targeted the wrong classpath file — so a rebuild is required per cloud, and the
Dockerfile now asserts the override is first on `server/target/classpath` and
fails the build if it is not.

**Historical note (pre-overlay), 2026-07-28 (LU-1).** Upstream cut
GitHub release **v0.5.1** on 2026-07-18 (credential-cache scoping, plus a fix for
permission **GET** routes returning HTTP 500 when server-side authorization is
enabled — exactly the LU-2 posture). There is nothing to bump to: Docker Hub
publishes **no v0.5.1 image** —
`GET https://hub.docker.com/v2/repositories/unitycatalog/unitycatalog/tags/v0.5.1`
returns `404 {"message":"httperror 404: tag 'v0.5.1' not found"}`, and the only
released tags there are `v0.5.0` (last pushed 2026-07-03), `v0.4.0`, `v0.3.1`,
`v0.3.0`, `v0.2.1`. We do **not** switch to `latest` to chase it and we do not fork
the server to build it. Re-check on each release; the permissions-GET fix is the
reason to move promptly once the image exists.

## Architecture

```
Console (fiab-console)                         loom-unity Container App (internal ingress
  lib/azure/unity-catalog-client.ts  ──HTTPS─▶   + optional Console-subnet IP pin)
    ucFetch() ──▶ uc-backend.ts        Bearer     "Loom Unity" — Unity-Catalog-compatible
      resolveUcBackend():                          OSS server (:8080)
        'databricks' | 'oss'                     /api/2.1/unity-catalog/{catalogs,
      isOssUc() → LOOM_UNITY_URL                   schemas,tables,volumes,functions}
      ossUcAuthHeader():                         authorization (LU-2, default ON):
        LOOM_UNITY_TOKEN (KV secretref)            server.authorization=enable
        | UAMI ⇒ api://<client-id>/.default        server.allowed-issuers  (pinned)
        | anonymous (reported, never silent)       server.audiences        (pinned)
                                                 persistence (LU-1, default):
                                                   PostgreSQL Flexible Server
                                                     Entra-only  (no password)
                                                     private endpoint, no public net
                                                   (legacy fallback: H2 file DB)
```

**The BFF is the only caller.** No engine, notebook, or user talks to Loom Unity
directly — its ingress is internal and can be pinned to the Console subnet, and the
credential is injected in `ucFetch`. That single choke point is what makes every
catalog access attributable (and is what LU-3 hangs the audit rows on).

- **Backend switch** (`uc-backend.ts`): `LOOM_UC_BACKEND` = `databricks` (Commercial
  default) | `oss`. When unset, Loom **auto-selects `oss` in Azure Government**
  (`isGovCloud()` from `cloud-endpoints.ts`) when no Databricks workspace is bound
  and `LOOM_UNITY_URL` is set. Commercial is unchanged.
- **Same REST surface**: `ucFetch()` routes catalogs / schemas / tables / volumes /
  functions to `LOOM_UNITY_URL` — the OSS server returns the same JSON shapes, so
  the existing catalog browse, CRUD, and search work unchanged. `ossUcAuthHeader()`
  attaches the Console's credential to every one of those calls (LU-2).
- **Persistence (LU-1 — Postgres by default)**: an **Azure Database for PostgreSQL
  Flexible Server**, created **Entra-only** (`passwordAuth=Disabled`) and
  **private-endpoint-only** (`publicNetworkAccess=Disabled`). See
  [Persistence](#persistence-lu-1) — including why the old H2-on-Azure-Files
  default was wrong, and how to migrate an existing deployment.
- **Auth (LU-2 — hardened)**: the server enforces **Microsoft Entra bearer
  authorization by default** (`authMode='entra'`), with the token **issuer and
  audience both pinned**; the Console BFF injects the credential on every call and
  is the only caller. Ingress stays internal-only and can be narrowed further to
  the Console's subnet. See [Authorization](#authorization-lu-2) below and the
  threat model at `docs/fiab/security/loom-unity-threat-model.md`.
- **Honest gate**: `LOOM_UC_BACKEND=oss` with `LOOM_UNITY_URL` unset throws a
  structured `OssUcNotConfiguredError` naming the env var + this bicep module — the
  BFF surfaces it as a MessageBar rather than failing opaquely.

## Authorization (LU-2) — and what `svc-loom-unity-authz` changed

> **Naming.** The platform is **Loom Unity** — Loom's Unity-Catalog-**compatible**
> catalog. It is not a Databricks product and is never presented as one.

> ### READ THIS FIRST — three measured facts
>
> All three come from running the image, not from reading it. Harness:
> `apps/loom-unity/tests/authz/authz-e2e.sh` (Docker only, no Azure). Transcript:
> [`security/loom-unity-authz-proof.md`](security/loom-unity-authz-proof.md).
>
> **1. No more silent downgrade.** `authMode == 'entra'` alone now decides, and
> `LOOM_UNITY_AUTH` defaults to `enable` in the container. Previously *both* layers
> inferred `disable` when no audience/tenant happened to be wired — and **no real
> caller wired one** — so the module documented as "Entra ON by default" shipped an
> anonymous, VNet-readable-**and-writable** catalog. An unpinnable audience now
> produces the **SEALED** state (below) or a refused boot, never an open door.
>
> **2. The Console's credential does not work against this server, and won't until
> it exchanges tokens.** Upstream `AuthDecorator` (identical in v0.5.0 and v0.5.1)
> rejects any bearer whose `iss` is not the server's own `internal` issuer, so a
> Microsoft Entra access token presented directly on `/api/2.1/unity-catalog/*` is
> answered **403** even with an exact `server.audiences` match. A client must
> `POST` it to `/api/1.0/unity-control/auth/tokens` and use the returned internal
> token (and its principal must be an enabled Unity Catalog user).
> `LOOM_UNITY_TOKEN` — the server-minted token, delivered as a Key Vault
> secretref — is currently the **only** working Console credential.
>
> **3. On v0.5.0, enabling authorization breaks grants READS.**
> `GET /api/2.1/unity-catalog/permissions/{securable}/{name}` returns **500** with
> `server.authorization=enable` and **200** with it disabled; `PATCH` works in both
> (upstream #1603, fixed in a v0.5.1 image Docker Hub has not published). That takes
> out the Grants pane and the LU-4 effective-permissions resolver on the OSS
> backend.
>
> **Therefore:** every *new* deployment of `loom-unity-app.bicep` defaults to
> `authMode=entra` and comes up **SEALED** — up, authorization enforced, zero
> replicas, every caller rejected — which is safe and free. But the **live Gov
> catalog** is deliberately left on the explicit, audited `authMode=disabled`
> opt-out by `gov-uc-purview-wire.yml`, with ACA ingress IP-pinned to the Container
> Apps infrastructure subnet and its probe reporting the finding as **OPEN**.
> Flipping it to `entra` today would not secure it; per fact 2 it would take it
> down. That flip belongs in the same change as the token-exchange client.
>
> Deploying `loom-unity` from `admin-plane/main.bicep` (the push-button path) is
> likewise deferred to a follow-up: the orchestrator would adopt the live Gov app
> and change its authorization mode. `loom-unity-app.bicep` remains a standalone
> entrypoint, orphan-allowlisted in `scripts/ci/check-bicep-sync.mjs`.

**Superseded 2026-08-11 (#3162).** The paragraph directly above is no longer true
and is kept only so the blockquote reads as the record it is. Since #3013,
`admin-plane/main.bicep` invokes
`module loomUnity '../compute/loom-unity-app.bicep'` gated on `loomUnityActive`
(default-ON via the `loomBackends` bag) and `loomUnityPostgres` gated on
`loomUnityPostgresActive`, and emits `LOOM_UNITY_URL` / `_CLIENT_ID` /
`_AUDIENCE` / `_AUTH_MODE` onto the Console. The orphan-allowlist entries for
BOTH modules were removed from `scripts/ci/check-bicep-sync.mjs` in finishline D2
(2026-08-06); the comment left in their place says so.

The orchestrator therefore OWNS the app. `gov-uc-purview-wire.yml` still publishes
the `:v0.1` tag the Gov bicepparams pull — so an orchestrator deploy cannot repoint
the app at a missing image — and still wires `LOOM_UC_BACKEND=oss` +
`LOOM_UNITY_URL` for the OSS Unity path. What it is NOT is the sole owner.

### Status 2026-08-05 — the blockers above are cleared; the deploy path is now gated

Everything the blockquote defers to "the same change as the token-exchange client"
has landed: `lib/azure/uc-token-exchange.ts` (#2679), the `unitycatalog-server:0.5.1`
overlay that fixes the permissions-GET 500 (fact 3), and the entrypoint AUTO-BIND that
registers the Console principal as an enabled UC user (#2974). The live Gov catalog is
still on the audited `authMode=disabled` opt-out — the flip is one dispatch of
`gov-uc-purview-wire.yml` at `main`, and that job does **not** touch the ACR agent
pools, build a console image, or run `main.bicep`.

Before dispatching, note the requirement §5.1 of the threat model now records: with
authorization on, the container fetches OIDC discovery **and** JWKS from
`login.microsoftonline.us` itself. Blocked egress there does not fail loudly — the
catalog answers 401 to everyone, which looks exactly like correct enforcement. On this
estate the egress is permitted (no route tables anywhere in the bicep tree, no outbound
NSG deny, and the Console already reaches that host server-side from the same CAE for
every sign-in), but the workflow no longer relies on that:

1. The entrypoint measures it at boot and prints
   `IDP-REACHABILITY: ok|FAILED host=… discovery=… jwks=…`, plus
   `ANON-READ: <code>` from a loopback unauthenticated read.
2. A new step reads those markers from the **loom-unity container's own logs**, pinned
   to the revision this run deployed, and must see all three of: IdP reachable,
   anonymous read refused, Console principal bound. Anything else — including a
   **missing** marker — refuses to wire the Console and leaves the estate on its
   previous posture.
3. Rollback is symmetric and equally cheap: re-dispatch with
   `unity_auth_mode=disabled`.

Reading the logs rather than `az containerapp exec` is not a style choice. Gov does not
return the exec'd command's stdout, so the previous probe's captured output on
2026-07-15 was one connection banner and nothing else — every branch that could have
failed the run was unreachable. See threat model §6.1.

After the flip, dispatch `gov-bff-verify.yml` for the positive end-to-end receipt: it
exercises `/api/catalog/metastores`, an **authenticated** read through the token
exchange. The pre-wire gate proves the door is locked and that we hold a key; that
dispatch proves the key turns.

### The SEALED state

An Entra app registration is a Microsoft Graph object ARM/bicep cannot create, and
a managed identity cannot *be* an audience — Microsoft's guidance is to register a
service principal to represent the target. So on a fresh estate there is no
audience to pin at template time. Rather than crash-loop (round 1) or open the
door (the original bug), `loom-unity-app.bicep` pins a per-deployment sentinel:

```
server.authorization = enable
server.allowed-issuers = https://<authority>/<tenant>/v2.0
server.audiences       = api://loom-unity-sealed-<uniqueString>.invalid
scale.minReplicas      = 0
```

`.invalid` is an RFC 2606 reserved TLD, and an `api://` identifier URI containing a
dot is treated as a host requiring domain verification — so **no** Entra tenant can
ever mint a token with that `aud`. Measured (case 8b): a token valid in every other
respect is rejected `The Claim 'aud' value doesn't contain the required audience`.
The app is up, answers its TCP probes, serves nobody, and bills nothing.
`authorizationSealed` / `authorizationMisconfigured` / `acceptedAudiences` report
the state in the deployment output. `scripts/csa-loom/bootstrap-msal-app-reg.sh`
(deploy phase 3) stamps the real client id and records it in Key Vault, and
`scripts/csa-loom/resolve-msal-client-id.sh` reads it back before a later template
run so a reconcile deploy cannot re-seal a working catalog.

### Image preflight — never point a live app at a tag nobody built

`scripts/csa-loom/preflight-image-tags.sh` resolves the manifest for the tag a
deploy is about to reference and **fails** if the Container App is live and the tag
is missing (an ARM PUT with a bad image succeeds and then the revision cannot
pull — the app goes down). Greenfield states pass, because a missing tag is the
expected state of the two-phase image path.

| State | Behaviour |
|---|---|
| Resource group absent, or the Container App not deployed yet | **pass** — greenfield |
| App LIVE + tag resolves | **pass**, manifest digest logged |
| App LIVE + tag missing | **FAIL** — names the tag, lists the tags that do exist, prints the exact `gov-build-images.yml` dispatch |
| App LIVE + registry unreadable | **FAIL** — never deploy blind onto a running federal app |

`LOOM_SKIP_IMAGE_PREFLIGHT=true` is a loud emergency valve. The ACR is
`publicNetworkAccess=Disabled`, so the check takes the same owned firewall lease
every push path uses and always releases it via a trap. Behaviour tests (with `az`
stubbed, zero Azure calls): `scripts/csa-loom/tests/preflight-image-tags.test.mjs`.

`.github/workflows/gov-build-images.yml` is the Gov twin of
`build-fiab-images-acr-tasks.yml` — Gov previously had **no** from-scratch image
producer for these nine images. It publishes `:v0.1` (the tag every Gov
`.bicepparam` pulls) plus `:<sha>` and `:latest`, per-image tag overrides,
post-build manifest assertions, and a Trivy CRITICAL gate on the tag that actually
shipped. **It has never been executed** — that is stated in the workflow header
too, and nothing depends on it having run.

**The finding.** Before LU-2 the server ran `server.authorization=disable` and the
Container Apps VNet was the *only* control: any workload that could reach the
environment could read **and modify** catalog metadata anonymously — and mint ADLS
delegation SAS wherever credential vending was wired. The vending service-principal
secret was also documented as an inline `--set-env-vars` value, which lands a live
secret in ARM deployment history.

**What LU-2 changed.**

| Layer | Control |
|---|---|
| Server | `server.authorization=enable` with `server.allowed-issuers` pinned to `https://<authority>/<tenant>/v2.0` and `server.audiences` pinned to `api://<client-id>,<client-id>`. Config keys verified verbatim against upstream `etc/conf/server.properties` at **v0.5.0** (the pinned image tag) **and v0.5.1**. |
| Server boot | **Fails closed.** `LOOM_UNITY_AUTH=enable` without a pinned issuer *or* a pinned audience exits 1 with a FATAL naming the exact variable — a half-secured server never runs. |
| Network | Internal ingress **plus** an optional `ipSecurityRestrictions` Allow-list (`consoleAllowedCidrs`) pinning ingress to the Console's subnet. |
| Console | The BFF is the single credentialed choke point: `ossUcAuthHeader()` presents a pre-shared server token (Key Vault secretref) or an Entra bearer minted by the Console UAMI for the Loom Unity audience — and **fails closed** rather than silently retrying anonymously. |
| Secrets | The Entra client secret and the ADLS vending secret are **Key Vault secretrefs** resolved by the app UAMI (`Key Vault Secrets User` on the vault). No inline literals anywhere. |
| Reporting | `svc-loom-unity-authz` gate (registry + two-half Fix-it wizard), the `authorization` block on `GET /api/catalog/unity/capabilities`, and the live `probe-loom-unity-authz` health probe, which sends a **deliberately unauthenticated** request: `401/403` → pass, `2xx` → **fail with the status as evidence**. Config drift cannot fake it. |

**Sovereign-safe by construction.** The authority host is derived from
`environment().authentication.loginEndpoint`, so Azure Government pins the issuer to
`https://login.microsoftonline.us/<tenant>/v2.0`. Nothing is hard-coded on a code path.

**Wiring it (both halves are required).**

```bash
# 1. SERVER — redeploy with the audience pinned (normally the Console app registration)
az deployment group create -g <admin-rg> \
  -f platform/fiab/bicep/modules/compute/loom-unity-app.bicep \
  -p ... authMode=entra entraClientId=<LOOM_MSAL_CLIENT_ID> \
     consoleAllowedCidrs='["<cae-infrastructure-subnet-cidr>"]'

# 2. CONSOLE — mint a matching bearer on every catalog call
az containerapp update -n <console-app> -g <admin-rg> \
  --set-env-vars LOOM_UNITY_CLIENT_ID=<same-app-registration-client-id>
```

Then confirm on `/admin/health`: **`probe-loom-unity-authz` must report that an
unauthenticated read was rejected.** Leaving `entraClientId` empty is an honest,
loudly-reported gate — the container logs a SECURITY WARNING on every boot and the
gate + probe both go red with this exact remediation — not a silent open door.

## Audit (LU-3) — the BFF choke point

Databricks Unity Catalog answers "who touched which securable, and were they
allowed to" from `system.access.audit`. OSS Unity Catalog has no system schemas,
so in Gov that question had no data source at all.

LU-3 builds one: the **write** half of a Loom-native access trail. Every Unity
Catalog REST call the Console makes is recorded, in both clouds, and a
merge-blocking CI guard keeps it that way.

> **Scope of this section.** The trail is **written**; the in-product **reader**
> (`readUnitySystemTable`) and the `/catalog/unity → System tables` pane are a
> follow-up PR, held because they have no in-browser E2E receipt and
> `ux-baseline.md` **G1** makes that blocking. Until they land, read the trail
> with the KQL below (Log Analytics / Sentinel) or a direct Cosmos query, and the
> Gov gate on `/api/databricks/unity-catalog/system-tables` still stands.

**Where the trail comes from.** `loom-unity` has internal ingress and (post-LU-2)
rejects anonymous callers, so the Console BFF is its only credentialed client.
Loom leans on that: every Unity Catalog call goes through one of **four**
audited transports, each recording from a `finally` block:

| Transport | File | Covers |
|---|---|---|
| `ucFetch` | `lib/azure/unity-catalog-client.ts` | the backend-agnostic UC REST client — Loom Unity in Gov, Databricks UC in Commercial. Holds that file's only outbound fetch. |
| `dbxFetch` | `lib/azure/databricks-client.ts` | the Databricks workspace client. The Commercial default routes call it **directly** for catalog owner change (`patchUcCatalog`), catalog delete (`deleteUcCatalog`) and grant mutation (`updateUcPermissions` → `PATCH /api/2.1/unity-catalog/permissions/…`). Only `/api/2.x/unity-catalog/**` paths are recorded; jobs/warehouses/SQL/Files are not catalog access. |
| `ucSql` | `lib/azure/uc-sql.ts` | **(#2622)** the Databricks **SQL Statement Execution** transport — the governance DDL: `GRANT`/`REVOKE`, ABAC `CREATE POLICY` / `DROP POLICY`, `ALTER … SET MASK` / `SET ROW FILTER` (column masks + row filters), governed tags, `SET TAGS`, `CREATE CONNECTION` / `CREATE FOREIGN CATALOG`. Records via `recordUnitySqlAccess`. |
| `acctFetch` | `lib/azure/unity-catalog-account-client.ts` | **(#2622)** the Databricks **account plane** — metastore assignment (`PUT /api/2.0/accounts/{id}/workspaces/{wsId}/metastore`), an account-admin mutation deciding which metastore a whole workspace sees. Records via `recordUnityAccountAccess`. |

> **The SQL row never carries the statement.** `buildCreateConnection` emits
> `CREATE CONNECTION … OPTIONS (host '…', password '…')`, and a MUTATION row is
> fanned out to tenant-registered outbound webhooks. So `recordUnitySqlAccess`
> classifies the statement into a **closed vocabulary** (`policy.create`,
> `row-filter.set`, `grant.revoke`, …) and stamps `detail` from a validated
> Databricks `error_code` token — never from the SQL and never from the error
> message, which echoes the failing statement. An unrecognised statement records
> as `sql.statement` and, per the affirmative-egress rule, does not leave the
> estate.

Two further modules keep their own transport for a real reason and record their
own rows: `dq-monitor-client.ts` (Lakehouse Monitoring resolves a monitored table
over UC REST) and `iceberg-catalog-client.ts` (`listNamespaceGrants` reads UC
schema permissions with the Iceberg auth header). Both are allowlisted **with**
an asserted audit call.

`recordUnityAccess()` (`lib/azure/unity-audit.ts`) writes:

| Field | Source |
|---|---|
| **WHO** | `actorOid` / `actorUpn` from the request-scoped session (`system` when there is no request scope — never a borrowed identity) |
| **WHAT** | `operation` + `securableType` + `securableFqn`, parsed from the REST path (`catalog.list`, `grant.update`, `temporary-credential.vend`, …) |
| **WHEN** | ISO `at` + `durationMs` |
| **OUTCOME** | `success` · `failure` · **`denied`** |

`denied` is deliberately narrow — an upstream **401/403**, or the LU-2
fail-closed refusal when the Console cannot mint a credential. A 501 honest gate
or a timeout records as `failure`, so the denial signal stays clean. Recording
happens in `finally` rather than on the success path precisely so a refused call
— the row an auditor actually hunts for — cannot be dropped.

**Two sinks, and a boundary.** Cosmos `_auditLog` (`itemType: 'loom-unity'`, the
authoritative trail) and, through `emitAuditEvent`, the `LoomAudit_CL` custom
table via the Azure Monitor Logs-Ingestion DCR that Microsoft Sentinel reads.
Both are **inside** the estate. `emitAuditEvent` also fans events out to any
tenant-registered **outbound webhook** (a third-party URL), so the egress
decision (`isUnityMutation`) is stated in the **affirmative** and defaults to
"read": a row leaves the boundary only when the HTTP method is state-changing,
or a safe method carries an explicit mutation verb (create / update / delete /
grant change / enable / disable / credential vend). Everything else — including
an un-modelled operation on a GET — stays in. An un-provisioned DCR is a silent
no-op, so there is no day-one gate here. Writes are fire-and-forget: an
audit-store hiccup never fails a catalog read.

> **Corrected 2026-07-28 (round-3 review).** The first version of this decision
> inferred "read" from the operation's last dotted segment being `get|list|read`
> and treated everything else as a mutation. That leaked: the LU-2
> `probe.anonymous-read` health-probe row (written on every `/admin/health`,
> `/admin/readiness`, self-audit and copilot-orchestrator run) and the
> `unity.request` catch-all on a GET were both classified as mutations and
> fanned out — actor UPN, actor OID and path — to every registered third-party
> URL, while this document said reads stopped at the boundary. A missed egress
> costs a SOC one notification of a change still visible in `_auditLog` and
> `LoomAudit_CL`; a wrong egress cannot be recalled. That asymmetry sets the
> default.

**The choke point is enforced, not just documented.**
`scripts/ci/check-unity-audit-chokepoint.mjs` is a merge-blocking guardrail that
fails the build when:

1. any file outside the allowlist combines a Loom Unity address **or a Unity
   Catalog REST path** with outbound-request code (only a `'use client'`
   component is exempt from the REST-path arm — an App Router **server**
   component is not, regardless of extension);
2. **any** exempted file — allowlisted or declared-gap — exceeds its frozen count
   of outbound **transport sites** (`OUTBOUND_BASELINE`), or is exempted without
   one. "Transport" means the whole `TRANSPORTS` vocabulary — `fetch`,
   `fetchWithTimeout`, `new Request`, XHR, axios, node `http(s).request`, undici
   dispatchers, a bare `request(`, or an `import`/`require`/`import()` of any HTTP
   client — **the same vocabulary check 1 uses.** Round 3 shipped two separate
   vocabularies here: check 1 knew nine shapes and this ratchet knew two
   (`fetch` and `fetchWithTimeout`). Because check 1 *skips* every exempted file,
   the ratchet was the only control on the allowlist and on the declared gaps, and
   undici `request`, node `https.request` and `axios.post` each walked past it with
   zero failures. Both consumers now derive from one exported list, and the spec
   asserts per entry that both see it, so they cannot diverge again;
3. a recorder call leaves the `finally` of **any** of the five audited
   transports (`ucFetch`, `dbxFetch`, `ucSql`, `acctFetch`, `ucSecurable`) — the
   check brace-matches the real function body and the real `finally` block, with
   comments and string literals masked, so a decoy call elsewhere in the file
   does not satisfy it. All five are driven off one `AUDITED_TRANSPORTS` table,
   so a sixth cannot be added with a weaker assertion than its siblings;
4. `unity-audit.ts` stops writing either sink or stops classifying denials;
5. any file pinned in `SQL_EXIT_BASELINES` grows a new `executeStatement(` exit,
   or a pinned file disappears. The pin is per FILE because a *refactor* can
   narrow a ratchet: LU-3's audit `try/finally` pushed `unity-catalog-client.ts`
   over its `check-file-size` ceiling, so the 165-line Databricks system-table
   block moved to `lib/azure/uc-system-tables.ts` — carrying one
   `executeStatement(` out of view of a single-file ratchet. Since #2622 every
   UC-governance file is pinned at **0** — `unity-catalog-client.ts`,
   `uc-system-tables.ts` and `app/api/items/[type]/[id]/security/route.ts` — and
   the only permitted raw exit in the repo is `ucSql`'s own. A vanished pin
   fails.
6. any module other than `lib/azure/uc-securable.ts` imports a **UC-mutating**
   symbol from `lib/azure/shortcut-credentials.ts` (check 8). That module holds
   an un-audited transport that cannot be instrumented in place, so the facade is
   the audited door to it and this check is what obliges callers through it. The
   rule is an **allowlist** of the two non-catalog exports, so a new un-audited
   export added to that (unreadable) file is denied by default; namespace and
   dynamic imports count as `*` and are never allowlistable.

The guard's own bypasses are covered by negative tests in
`apps/fiab-console/lib/azure/__tests__/unity-audit-guard.test.ts`, which replay
each demonstrated attack against the analysis over the **whole** scanned tree and
assert it now fails.

**What the guard is NOT.** It is a lexical scan. It turns an *accidental* bypass
into a red build and makes a deliberate one leave a visible diff. It does not
survive a UC path assembled from enough pieces, or a transport reached through an
indirection it does not name (a hand-rolled `net.Socket` speaking HTTP; a helper
in a third module that itself carries no catalog address); and it proves the
recorder is *called*, never that the row is correct or that it reached Cosmos. The
`## LIMITS` block at the top of the guard is the normative statement. Do not cite
the guard as proof that the Databricks path is fully covered — cite the five
transports plus the gap list below.

### Audit (LU-3) — known gaps

The trail is **not** complete, and this section is the honest inventory. Trusting
a trail with an undisclosed hole is worse than having none.

- ~~**SQL-DDL governance mutations are not in this trail.**~~ **CLOSED (#2622,
  2026-08-02).** All 25 `executeStatement(...)` calls now route through `ucSql`,
  and so do the **ten** in `app/api/items/[type]/[id]/security/route.ts` — the
  ABAC column-mask + row-filter wizard, which was the same governance class and
  had never been ratcheted at all. `SQL_EXIT_BASELINES` pins every one of those
  files at **0** raw exits; the only permitted raw exit in the repo is `ucSql`'s
  own, and the guard brace-matches its `finally`.
  *Residual caveat, stated plainly:* the guard proves the recorder is called
  **inside** the `finally`, not that the call is **unconditional** —
  `finally { if (ok) record(…) }` still passes it. That property is held by
  `lib/azure/__tests__/unity-audit-sql.test.ts`, not by the guard.
- ~~**`lib/azure/shortcut-credentials.ts` is un-audited.**~~ **CLOSED (#2622,
  2026-08-04) — with a residual worth reading.** Its own private `ucFetch` issues
  storage-credential and external-location CREATE/DELETE; a storage credential is
  a live cloud identity, which made this the most privilege-relevant un-audited
  surface in the list. Rounds 2–5 left it open twice for the same reason: the file
  is covered by a **repo-level credential-path read/write deny**, so the
  `try/finally` every other transport received could not be added inside it.
  That reasoning assumed the only place to audit a call is at its transport. It is
  not. Those five exports had exactly **one** production consumer
  (`lib/azure/shortcut-engines.ts`), so an audited **facade** —
  `lib/azure/uc-securable.ts` — now wraps every one of them and records via
  `recordUnitySecurableAccess` from a `finally`. It is the guard's **fifth**
  `AUDITED_TRANSPORTS` entry, so its `finally` is brace-matched exactly like
  `ucFetch`'s.
  A facade nobody is obliged to use would be a comment, so the load-bearing half
  is the guard's new **check 8**: only `uc-securable.ts` may import a UC-mutating
  symbol from `shortcut-credentials.ts`. It is stated as an **allowlist** of the
  two non-catalog exports (`getKeyVaultSecret`, `keyVaultConfigGate`) rather than
  a denylist of today's five — this is the one file in the tree the guard's author
  cannot **read**, so a new un-audited export added to it must be denied by
  *default* rather than by having been anticipated. Namespace and dynamic imports
  count as `*` and can never be allowlisted.
  *Residual, stated plainly:* no un-audited **call path** to those securables
  remains, but the **transport itself** is still un-instrumented, so the file
  stays in `KNOWN_UNAUDITED` and the guard still prints it on every passing run.
  What is genuinely left of gap 1 is moving the `try/finally` inside the file,
  which needs write access to a credential-path-denied path. The outbound-call
  ratchet (pinned at 2) still stops the un-audited surface GROWING meanwhile.
  Emission is proved — not merely declared — by
  `lib/azure/__tests__/unity-audit-securable.test.ts`, which stubs only the raw
  transport and the two sinks and asserts on the bytes that reached Cosmos and
  `LoomAudit_CL`, including the **denied** row on a 403 and the fact that the
  upstream error message (which can echo a GCP service-account `private_key`)
  never lands on a row.
- **Iceberg REST catalog writes land in a DIFFERENT trail.**
  `lib/azure/iceberg-catalog-client.ts`'s `ircFetch` issues namespace CREATE
  (`POST /v1/namespaces`), table register (`POST`) and table-registration DROP
  (`DELETE`) against the **same** OSS Unity Catalog server, from live routes
  under `app/api/catalog/iceberg/*`. Those calls **are** audited — but via
  `logIcebergAccess` into `_auditLog` with `itemType: 'iceberg-catalog'`, so they
  do **not** appear in the System tables pane an auditor is told to read here.
  Query them with the KQL/Cosmos filter `itemType == 'iceberg-catalog'` until the
  two trails are unified (issue #2622). (`listNamespaceGrants` in the same file
  is the one call that DOES record into this trail.)
- ~~**`unity-catalog-account-client.ts`** account-admin mutations are
  unaudited.~~ **CLOSED (#2622, 2026-08-02).** `acctFetch` now records from a
  `finally` via `recordUnityAccountAccess`; a metastore assignment lands as
  `unity.metastore-assignment.assign` on `workspace:<id>`, and the 403 "caller
  is not an account admin" lands as `denied`.
  *Why it was invisible:* its paths are `/api/2.0/accounts/{id}/…`, which match
  neither of the guard's address regexes, so check 4 could never have reported
  it and it was not even in `KNOWN_UNAUDITED`. "The scan found nothing" was not
  "there is nothing" — the scan's vocabulary could not express the surface.
- **There is no in-product reader yet.** The `/catalog/unity → System tables`
  pane and `readUnitySystemTable()` are split out of this change: they had no
  in-browser E2E receipt, and `ux-baseline.md` **G1** makes that blocking.
  Consequence today: the trail exists and is queryable (below), but an operator
  cannot read it from inside Loom, and the Gov gate on
  `/api/databricks/unity-catalog/system-tables` is unchanged.

### Audit (LU-3) — how you read the trail today

**Sentinel / Log Analytics** — `unityAuditKql()` in `lib/azure/unity-audit.ts`
generates exactly this (window and limit clamped to integers, so a caller-supplied
value cannot reach the query text):

```kusto
LoomAudit_CL
| where TimeGenerated > ago(168h)
| where Action startswith "unity."
| project TimeGenerated, ActorUpn, ActorOid, Action, TargetType, TargetId, Outcome, Detail
| order by TimeGenerated desc
| take 200
```

Add `| where Outcome == "denied"` for the refusals — the highest-value rows.

**Cosmos `_auditLog`** — the authoritative copy, independent of whether the DCR
is provisioned:

```sql
SELECT TOP 200 * FROM c
WHERE c.itemType = 'loom-unity' AND c.at >= '<iso>'
ORDER BY c.at DESC
```

Note that `/admin/audit-logs` will NOT show these: it scopes its read to
`c.tenantId = <session oid>` while these rows carry the Entra **tenant** id. The
reader that closes that gap is the follow-up.

**Authorization, for when the reader lands.** Any in-product surface over this
trail must be `withTenantAdmin`, not a bare session check: neither backend scopes
its rows to the caller — `system.access.audit` is the whole metastore's activity,
and the Loom rows cover every user, including the denial rows, which are a map of
what other people tried to reach and were refused. That gate is already applied
to `/api/databricks/unity-catalog/system-tables` in this change (it previously
served the Databricks `system.access.audit` to any signed-in user), and is
attack-tested.

## Honest capability matrix — OSS Unity Catalog vs Databricks Unity Catalog

> **The complete, per-capability matrix now lives at
> `docs/fiab/unity-catalog-capability-matrix.md`** (and live per-deployment at
> `GET /api/catalog/unity/capabilities`, rendered on `/catalog/unity →
> Capabilities`). Summary below.

| Capability | Databricks UC | OSS UC (loom-unity, v0.5) | Loom on the OSS backend |
|---|---|---|---|
| Catalogs / schemas / tables / volumes / functions / **registered models** (list, get, create, delete; update where the spec has PATCH) | ✅ | ✅ | ✅ Routed to `LOOM_UNITY_URL` — full CRUD from `/catalog/unity` |
| Metadata catalog + table registry | ✅ | ✅ | ✅ |
| **Grants — permissions API (`GET/PATCH /permissions/{securable}/{name}`)** | ✅ | ✅ (spec-confirmed; securables incl. `registered_model`, `credential`) | ✅ **Wired** — `/catalog/unity → Grants`; per-backend privilege spelling handled. Effective (inherited) expansion is Databricks-only (honest note). |
| **External locations + credentials (storage credentials)** | ✅ | ✅ (`/credentials`; Loom rewrites the path) | ✅ **Wired** — `/catalog/unity → Storage` |
| Temporary credential vending — **Azure ADLS** (delegation SAS) | ✅ | ✅ via `adls.*` server config | ⚠️ Opt-in (`LOOM_UNITY_ADLS_*`). **Default OFF** — data access stays on Loom's existing managed-identity / ACL paths |
| Delta Sharing (shares / recipients / providers) | ✅ | ❌ Not in the server | **Gated (501)** with the Loom-native fallback named: Loom Marketplace shares |
| Table / column lineage (system tables + lineage-tracking) | ✅ | ❌ | **Gated (501)** — Loom unified lineage (Purview + ADX + item edges) is the equivalent |
| **Access audit (“system tables”)** | ✅ `system.access.audit` | ❌ No system schemas in the server | ⚠️ **Trail WRITTEN Loom-native (LU-3)** — every catalog call funnels through the BFF audit choke point (`ucFetch` / `dbxFetch` → `recordUnityAccess`) into Cosmos `_auditLog` + the `LoomAudit_CL` SIEM stream. **Read it with `unityAuditKql()` in Sentinel / Log Analytics**; the in-product reader + `/catalog/unity → System tables` pane are a follow-up (no G1 E2E receipt yet). Billing / warehouse query history have no equivalent at all. |
| Connections (Lakehouse Federation) / workspace bindings / system schemas | ✅ | ❌ | **Gated (501)** with Loom-native fallbacks named |
| Governed tags / policies / metric views (SQL-warehouse features) | ✅ | ❌ | Naturally gated (no SQL warehouse on OSS) |
| API stability | GA | **Evolving** ("APIs should not be assumed stable" — upstream) | Pin the image tag; bump deliberately |

**Bottom line (honest scope):** on the OSS backend, `loom-unity` is a **real,
functional Unity Catalog** — the full object surface (catalogs → models),
**grants**, external locations, storage credentials, and temporary-credential
vending all work against the real server. Delta Sharing, lineage, federation,
and the SQL-warehouse families are Databricks-UC features OSS UC does not (yet)
provide; Loom **gates them honestly** and routes each through its named
Azure-native equivalent instead.

## Persistence (LU-1)

> **This section corrects the pre-LU-1 documentation, which recommended
> H2-on-Azure-Files as "the recommended day-one path". That was wrong, and it was
> contradicted by the repo itself** — `loom-unity-app.bicep`'s own `dbEphemeral`
> parameter documents that the CIFS mount blocks container start with
> CrashLoopBackOff on Azure Government, and the live Gov deployment has been
> running Postgres since 2026-07-14.

### The finding

| Problem with the old H2-on-Azure-Files default | Consequence |
|---|---|
| The SMB/CIFS mount blocks container start on Azure Government (observed live 2026-07-14; not reproducible in local Docker) | The catalog **CrashLoopBackOffs before the JVM runs** — the workaround was an *ephemeral* EmptyDir, i.e. a catalog that silently loses every object on restart |
| H2's file DB is **single-writer**, and its file-lock protocol has no reliable CIFS semantics (we had to set `FILE_LOCK=NO`) | The Container App was pinned to `minReplicas: 1, maxReplicas: 1` — no horizontal headroom and **no rolling restart without a catalog outage** |
| No backup, no point-in-time restore, no server-side encryption story | A deleted share is an unrecoverable metastore |

### The default now

`platform/fiab/bicep/modules/data-plane/loom-unity-postgres.bicep` provisions an
**Azure Database for PostgreSQL Flexible Server**:

| Control | Setting |
|---|---|
| Authentication | `activeDirectoryAuth: Enabled`, **`passwordAuth: Disabled`** — there is **no database credential** to rotate, leak, or land in ARM deployment history. The loom-unity UAMI is the server's Entra administrator. |
| Network | **`publicNetworkAccess: Disabled`** + an in-module **private endpoint** (`groupIds: ['postgresqlServer']`) and a `privatelink.postgres.<sovereign-suffix>` private DNS zone linked to the VNet. There is no public endpoint at all; firewall rules are not even evaluated. |
| Durability | PITR with a configurable retention window (default 14 days), optional `SameZone` / `ZoneRedundant` HA. |
| Observability | `PostgreSQLLogs` + `PostgreSQLFlexSessions` + metrics to the Loom Log Analytics workspace. |

Because Postgres is multi-writer, `loom-unity-app.bicep` now lifts the replica cap
(`maxReplicas`, default 3, with an HTTP-concurrency scale rule) **only on the
Postgres path** — the module still **forces `maxReplicas: 1` whenever the H2
fallback is in use**, whatever you pass, because a second writer would corrupt the
`.mv.db`.

### How passwordless actually works (and why the obvious approach doesn't)

Entra-only PostgreSQL expects a short-lived access token *as the password*.
Rendering one into `hibernate.properties` at container start **does not work**: the
token expires within the hour while Hibernate keeps opening new physical
connections, so the catalog starts healthy and then hard-fails authentication long
after anyone is watching.

The token has to be minted **per physical connection**, which is exactly what
pgjdbc's `authenticationPluginClassName` hook is for — the same seam Microsoft's
own `AzurePostgresqlAuthenticationPlugin` uses ([Learn: passwordless JDBC
connections](https://learn.microsoft.com/azure/postgresql/connectivity/connect-java)).
The image installs two jars beside the server:

* **`postgresql-42.7.7.jar`** — upstream UC v0.5.0's `build.sbt` ships only H2, so
  the driver is added by us. Pulled from Maven Central and **SHA-256-verified in
  the build** (a tampered or truncated download fails the image build).
* **`loom-unity-entra-auth.jar`** — `ai.limitlessdata.loom.unity.EntraPostgresAuthPlugin`
  (`apps/loom-unity/java`), a **dependency-free** `AuthenticationPlugin`. It calls the
  Container Apps managed-identity endpoint (`IDENTITY_ENDPOINT` / `IDENTITY_HEADER`
  — the App Service protocol, **not** classic IMDS, which ACA does not serve; the
  same gotcha as `lib/azure/aca-managed-identity.ts`) with an IMDS fallback, never
  logs or persists the token, and caches 60 s purely to stop pool warm-up from
  stampeding the endpoint.

  We deliberately did **not** take `com.azure:azure-identity-extensions`: it drags
  azure-identity + msal4j + reactor + netty + jackson onto the classpath of a
  netty/jackson application, which is an untestable version-conflict risk for
  "GET one URL, read one field".

The Dockerfile **fails the build** if it cannot find and rewrite the server's
classpath file — an image that quietly lacks the Postgres driver would boot on H2
while the deployment reports Postgres.

`LOOM_UNITY_DB_AUTH=password` remains as an explicit, warned opt-out for a BYO
server that still uses password auth; the password then arrives as
`dbPasswordSecretUri` (a Key Vault secretref), never inline.

### Migrating an existing H2 deployment

There is no honest offline path: the H2 file is a JVM-specific binary written by
Hibernate, and hand-translating its dialect is the kind of "probably works"
migration that silently drops objects. Migrate through the **server's own REST
API** instead.

```bash
# 0. Deploy the Postgres store + apply the data-plane grants (run IN-VNET —
#    the server has no public endpoint).
az deployment group create -g <admin-rg> \
  -f platform/fiab/bicep/modules/data-plane/loom-unity-postgres.bicep \
  -p location=<region> privateEndpointSubnetId=<pe-subnet-id> \
     unityPrincipalId=<loom-unity-UAMI-principalId> \
     unityPrincipalName=<loom-unity-UAMI-name> \
     additionalAdministrators='[{"principalId":"<deploy-sp-oid>","principalName":"<deploy-sp>","principalType":"ServicePrincipal"}]' \
     workspaceId=<law-id> complianceTags='{ "env": "gov" }'

SUB=<sub> UNITY_RG=<admin-rg> UNITY_PG_SERVER=<server-name> \
UNITY_UAMI_NAME=<loom-unity-UAMI-name> \
PG_HOST_SUFFIX=postgres.database.usgovcloudapi.net \
PG_AAD_RESOURCE=https://ossrdbms-aad.database.usgovcloudapi.net \
  bash scripts/csa-loom/loom-unity-postgres-bootstrap.sh

# 1. Deploy a SECOND loom-unity app (different name) pointed at Postgres, so the
#    old H2-backed app and the new one are reachable at the same time.
# 2. Copy the catalog (idempotent; dry-run first). Also runs in-VNet.
LOOM_UNITY_SOURCE_URL=https://<old-fqdn> \
LOOM_UNITY_TARGET_URL=https://<new-fqdn> \
  python3 scripts/csa-loom/loom-unity-migrate-catalog.py --dry-run
LOOM_UNITY_SOURCE_URL=... LOOM_UNITY_TARGET_URL=... \
  python3 scripts/csa-loom/loom-unity-migrate-catalog.py

# 3. Repoint the Console and retire the old app.
az containerapp update -n <console-app> -g <admin-rg> \
  --set-env-vars LOOM_UNITY_URL=https://<new-fqdn>
```

**What the copy moves:** catalogs → schemas → tables, volumes, functions,
registered models (parent-before-child, existing objects left alone).
**What it does not:** table/volume **data** (storage locations are unchanged — the
same ADLS paths are simply re-registered), metastore-level external locations and
storage credentials (re-create them on the target), and **grants** — the OSS
permissions **GET** routes return HTTP 500 with authorization enabled on v0.5.0
(fixed in v0.5.1, which has no published image yet), so re-apply grants from
`/catalog/unity → Grants` after the cutover. The script prints that reminder.

A greenfield deployment needs none of this: deploy the Postgres module first and
the catalog is created directly on it (Hibernate builds the UC schema on first
boot, `hibernate.hbm2ddl.auto=update`; set `LOOM_UNITY_DB_DDL=none` to own the
schema yourself).

## Deploy

**Since #2681 you do not deploy Loom Unity — the platform does.**
`admin-plane/main.bicep` invokes both modules DEFAULT-ON on every boundary:

| what | how |
|---|---|
| toggle | `loomBackends.unity` (unset ⇒ `enabled`). Opt out with `observabilityConfig.backendOverrides = { unity: 'disabled' }`. No new top-level param — the ARM 256-parameter ceiling is untouched. |
| identity | a dedicated `uami-loom-unity-<region>` holding AcrPull on the admin ACR and Entra administrator on its own Postgres. |
| metastore | `data-plane/loom-unity-postgres.bicep`, consuming the `privatelink.postgres.*` zone the DuckLake store created on the hub VNet. Skipped where `postgresQuotaAvailable=false` (the gcc-high / il5 default) — the catalog then runs the EmptyDir H2 store (`dbEphemeral`), functional but not durable. |
| authorization | `authMode: 'entra'` as a LITERAL at the module call, `consolePrincipalId` for the #2974 SCIM auto-bind, `consoleAllowedCidrs` pinned to the Container Apps infrastructure subnet read from `network.outputs.containerPlatformSubnetPrefix`. |
| image | `appImageTags.unity` (`LOOM_UNITY_TAG`, default `v0.1`). It is now a HARD prerequisite of the apps phase and is asserted by the image preflight in all three deploy lanes. |
| console wiring | `LOOM_UNITY_URL` / `_CLIENT_ID` / `_AUDIENCE` / `_AUTH_MODE` emitted by the same template; `LOOM_UC_BACKEND=oss` pinned on GCC-High / IL5. |

**First deploy caveat.** The Entra app registration the catalog pins as its
audience is a Microsoft Graph object ARM cannot create. On a genuinely fresh
estate `entraClientId` is therefore empty at ARM time and the module deploys
**SEALED** — up, `minReplicas 0`, an unroutable `api://loom-unity-sealed-*.invalid`
audience, every caller refused. That is deliberate (the alternative, and the
actual #2643 finding, was an anonymous catalog anything on the VNet could
mutate). `csa-loom-post-deploy-bootstrap.yml` unseals it in the step *"Unseal
Loom Unity + wire the Console (LU / #2681)"* once `bootstrap-msal-app-reg.sh`
has created the registration — by updating three env vars and the replica floor,
never by re-running the module (a partial-param redeploy would silently migrate
the catalog off Postgres onto an Azure Files H2 store, which does not start on
Gov).

Steady state is protected by the deploy lanes resolving the estate's existing
registration into `LOOM_MSAL_CLIENT_ID` before applying
(`scripts/csa-loom/resolve-msal-client-id.sh`) — without that, every reconcile
would blank sign-in and re-seal a working catalog.

### Manual / out-of-band deploy (still supported)

Both modules remain directly invocable — useful for a targeted change, and the
path `.github/workflows/gov-uc-purview-wire.yml` still uses:

1. **Provision the catalog store** — Entra-only, private-endpoint-only Postgres:

   ```bash
   az deployment group create -g <admin-resource-group> \
     -f platform/fiab/bicep/modules/data-plane/loom-unity-postgres.bicep \
     -p location=<region> \
        privateEndpointSubnetId=<private-endpoint-subnet-resource-id> \
        unityPrincipalId=<principal-id-of-the-loom-unity-UAMI> \
        unityPrincipalName=<name-of-the-loom-unity-UAMI> \
        workspaceId=<log-analytics-workspace-resource-id> \
        complianceTags='{ "env": "gov" }'
   ```

   Outputs to carry forward: `fqdn`, `databaseName`, `aadUser`. Then run
   `scripts/csa-loom/loom-unity-postgres-bootstrap.sh` **from inside the VNet** —
   it proves the token-only login works before anything depends on it.

2. **Build + push the image** into the deployment's ACR (server-side, no local
   Docker needed). This is also what compiles the Entra auth plugin and installs
   the Postgres driver:

   ```bash
   az acr build -r <acr-name> -t loom-unity:<tag> apps/loom-unity
   ```

   > The build pulls `postgresql-42.7.7.jar` from Maven Central. In an
   > egress-restricted ACR, pre-seed that artifact (or mirror Maven Central) —
   > the checksum is pinned in the Dockerfile, so a substituted jar fails the build.

3. **Deploy the Container App** (wires Postgres and enforces Entra authorization —
   see [Authorization](#authorization-lu-2)):

   ```bash
   az deployment group create -g <admin-resource-group> \
     -f platform/fiab/bicep/modules/compute/loom-unity-app.bicep \
     -p location=<region> \
        environmentId=<container-apps-env-resource-id> \
        acrLoginServer=<acr-name>.azurecr.io \
        image=<acr-name>.azurecr.io/loom-unity:<tag> \
        unityUamiId=<uami-resource-id-with-AcrPull-and-KeyVaultSecretsUser> \
        unityUamiClientId=<client-id-of-that-same-UAMI> \
        unityPostgresFqdn=<fqdn-output-from-step-1> \
        unityPostgresDatabase=<databaseName-output-from-step-1> \
        unityDbAadUser=<aadUser-output-from-step-1> \
        workspaceId=<log-analytics-workspace-resource-id> \
        authMode=entra \
        entraClientId=<entra-app-registration-client-id> \
        consoleAllowedCidrs='["<cae-infrastructure-subnet-cidr>"]' \
        complianceTags='{ "env": "gov" }'
   ```

   Useful outputs: `persistenceBackend` (must be `postgres`), `dbEntraTokenAuth`
   (must be `true`), `effectiveMaxReplicas`, `authorizationEnforced` (must be
   `true`), `ingressIpRestricted`, and `acceptedAudiences` (set
   `LOOM_UNITY_CLIENT_ID` on the Console to match).

   Omitting `unityPostgresFqdn` is legal but lands on the legacy H2 fallback: the
   deployment reports `persistenceBackend: h2-azure-files` (or `h2-ephemeral`),
   the replica ceiling is forced back to 1, and the container prints a NOTICE
   naming the remediation on every boot.

4. **Point the Console at it** (default-ON, no approval gate):

   ```bash
   az containerapp update -n <console-app> -g <admin-resource-group> \
     --set-env-vars LOOM_UC_BACKEND=oss LOOM_UNITY_URL=https://<loom-unity-fqdn> \
                    LOOM_UNITY_CLIENT_ID=<entra-app-registration-client-id>
   ```

   (In Azure Government with no Databricks workspace bound, `LOOM_UC_BACKEND` may be
   left unset — Loom auto-selects `oss` once `LOOM_UNITY_URL` is set.
   `LOOM_UNITY_CLIENT_ID` is what makes the BFF present a bearer on every call; without
   it the `svc-loom-unity-authz` gate and the `probe-loom-unity-authz` probe both report
   the unauthenticated posture.)

### Optional: ADLS credential vending

Pass `adlsAccount` (+ `adlsTenantId` / `adlsClientId`) to the bicep module to let
Loom Unity vend delegation-SAS credentials for external tables/volumes. **The
service-principal secret goes in as `adlsClientSecretUri` — a Key Vault secret URI
resolved at revision start by the app UAMI (`Key Vault Secrets User` on the vault).
Never pass it inline on an `az containerapp update --set-env-vars` line: that lands
a live secret in ARM deployment history and shell history (LU-2, finding F-4).**
Unset, data access stays on Loom's managed-identity / ACL paths.

## Government endpoint notes

- Azure Container Apps, **Azure Database for PostgreSQL Flexible Server**, Azure
  Private Link / private DNS, user-assigned managed identities, Log Analytics, and
  ACR are all GA in GCC-High / IL5 / DoD — Loom Unity needs no managed-service
  substitution to run in Government. (Azure Files is no longer on the default path
  at all: with Postgres there is no share, no storage account, and no account key.)
- The Postgres store is created **Entra-only and private-endpoint-only**, so the
  FedRAMP posture holds with no compensating control: no credential exists, and
  the server has no internet-reachable endpoint.
- The service reaches **no** `api.fabric.microsoft.com` / `api.powerbi.com` /
  `*.azuredatabricks.net` host — it IS the Azure-native Unity Catalog backend.
- Sovereign host suffixes (Storage, ARM, Log Analytics) are resolved by the Console
  through `lib/azure/cloud-endpoints.ts`. Loom Unity itself only talks to its own
  Postgres store over the private endpoint, the sovereign Entra endpoint for token
  validation *and* for minting its DB token (issuer host derived from
  `environment().authentication.loginEndpoint`; DB resource derived from
  `environment().suffixes.sqlServerHostname` →
  `https://ossrdbms-aad.database.usgovcloudapi.net` in Gov), and — if enabled — the
  ADLS SP you wire. Nothing sovereign is hard-coded on a code path.

## Verification

- `resolveUcBackend()` / `ucFetch()` routing, the Gov auto-select, the honest gate,
  and the grants-gated-on-OSS behaviour are covered by
  `apps/fiab-console/lib/azure/__tests__/uc-backend-switch.test.ts` (real fetch
  capture — no client stubs).
- **LU-2 authorization**: `apps/fiab-console/lib/azure/__tests__/uc-authz.test.ts`
  (17 tests — bearer injection reaches the real REST call, fail-closed on an
  unmintable token, no hardening inferred from `LOOM_MSAL_CLIENT_ID`).
- The entrypoint config rendering is covered by
  `apps/loom-unity/tests/entrypoint.test.mjs` (dry-run, **15 tests**):
  **LU-1** — the passwordless Postgres default (plugin + `sslmode`, and the
  assertion that **no** `hibernate.connection.password` line is ever rendered), an
  operator-supplied JDBC query string surviving intact, the password-mode opt-out,
  the `AZURE_CLIENT_ID` warning, and two fail-closed boot paths (missing DB user,
  password mode with no password); **LU-2** — Entra authorization, the sovereign
  authority host, and both of its fail-closed boot paths; plus ADLS vending and
  the H2 fallback.
- Live posture: `probe-loom-unity-authz` on `/admin/health` — the G1 receipt.
- `az bicep build` is clean on both `compute/loom-unity-app.bicep` and
  `data-plane/loom-unity-postgres.bicep`; `check-bicep-sync`,
  `check-bicep-param-cap`, `check-env-sync`, `check-duplicate-env`,
  `check-health-coverage`, and `tsc --noEmit` pass.
- **Still owed (G1 / no-vaporware):** a live receipt from a Gov deployment showing
  `persistenceBackend: postgres`, the container logging
  `rendering config (db=postgres/entra …)`, and a catalog CRUD round-trip
  surviving a revision restart. The image layer that installs the Postgres driver
  and compiles the Entra plugin is built by `az acr build` and has not been built
  in CI here — that build **is** the compile-time verification of both.

## Cross-references

- `apps/loom-unity/README.md` — the packaged server + env-var reference.
- `platform/fiab/bicep/modules/data-plane/loom-unity-postgres.bicep` — the
  Entra-only, private-endpoint-only catalog store (LU-1).
- `scripts/csa-loom/loom-unity-postgres-bootstrap.sh` — PostgreSQL principals +
  grants, and the token-only connectivity proof (run in-VNet).
- `scripts/csa-loom/loom-unity-migrate-catalog.py` — H2 → Postgres catalog copy
  over the UC REST API.
- `docs/fiab/security/loom-unity-threat-model.md` — the LU-2 STRIDE threat model.
- `.claude/rules/no-fabric-dependency.md` — why every item works Azure-native.
- `docs/fiab/hyperscale.md` — the sibling out-of-band ACA-app deploy pattern.
