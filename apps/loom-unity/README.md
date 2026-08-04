# CSA Loom — loom-unity (self-hosted OSS Unity Catalog for Azure Government)

`loom-unity` packages the open-source **Unity Catalog** server
([unitycatalog.io](https://www.unitycatalog.io/), LF AI & Data;
[github.com/unitycatalog/unitycatalog](https://github.com/unitycatalog/unitycatalog))
as a CSA Loom Container App so **Azure Government** — where Databricks Unity
Catalog is unavailable/limited — gets a **real Unity Catalog REST backend that
works day one**. It is the Azure-native default Unity Catalog backend; no
Microsoft Fabric / Power BI dependency (`.claude/rules/no-fabric-dependency.md`).

This is **packaging, not a fork**. The image starts `FROM
unitycatalog/unitycatalog:v0.5.0` (the official published server image) and
overlays one thin entrypoint that renders config from environment variables, the
Postgres JDBC driver and a small Entra authentication plugin (LU-1), and — since
the #1603 fix — the upstream **v0.5.1 `unitycatalog-server`** artifact from Maven
Central (see below). Every overlay consumes an upstream-released binary verbatim.

> **Base pin v0.5.0 + v0.5.1 server overlay (2026-08-04).** Upstream released
> **v0.5.1** on 2026-07-18 but **has not published a v0.5.1 container image** —
> Docker Hub returns `404 tag 'v0.5.1' not found`, and v0.5.0 is still the newest
> published tag. v0.5.1 fixes permission **GET** routes returning HTTP 500 when
> server-side authorization is enabled (upstream
> [#1603](https://github.com/unitycatalog/unitycatalog/issues/1603)) — precisely
> the LU-2 posture. Rather than wait for the image, the Dockerfile OVERLAYS the
> v0.5.1 **server module**, which *is* published on Maven Central
> (`io.unitycatalog:unitycatalog-server:0.5.1`, checksum-pinned). The thin jar
> (only `io.unitycatalog.*` classes + the jCasbin auth-model resource; it bundles
> the server + control models) is **prepended** to the server classpath so its
> fixed `PermissionService` / `UnityAccessDecorator` shadow the v0.5.0 base copies
> as a self-consistent set, while every third-party dependency stays as the base
> ships it (the v0.5.0 and v0.5.1 server POMs are byte-identical except their own
> version strings — zero third-party dependency changes). This is packaging, not a
> fork or a from-source build.
>
> **The bug is not latent — enabling authorization is what triggers it.**
> Measured on the BARE v0.5.0 image (`apps/loom-unity/tests/authz/authz-e2e.sh`,
> transcript in `docs/fiab/security/loom-unity-authz-proof.md`):
> `GET /api/2.1/unity-catalog/permissions/{securable}/{name}` returned **500**
> `"No authorization expression found."` while `server.authorization=enable`, and
> **200** while disabled (`PATCH` 200 in both) — so grant/revoke worked but reads
> did not, taking out the Console's Grants pane and the LU-4 effective-permissions
> resolver. **With the v0.5.1 overlay that GET returns 200 with authorization
> enabled** — `authz-e2e.sh` case 9 now asserts 200. Confirm live with an image
> rebuild + the harness run; a catalog on an image built before the overlay still
> 500s until redeployed.

## What it exposes

The upstream OSS UC REST API on port **8080** —
`/api/2.1/unity-catalog/{catalogs,schemas,tables,volumes,functions}` plus
temporary-credential vending — the **same REST surface** the Loom UC client
already speaks to Databricks UC. Loom's client library switches to it with
`LOOM_UC_BACKEND=oss` (or automatically in Gov when no Databricks workspace is
bound); see `apps/fiab-console/lib/azure/uc-backend.ts`.

## Persistence

**LU-1: PostgreSQL is the default.** The catalog lives on an Azure Database for
PostgreSQL Flexible Server created **Entra-only** (`authConfig.passwordAuth=Disabled`)
and **private-endpoint-only** (`publicNetworkAccess=Disabled`) by
`platform/fiab/bicep/modules/data-plane/loom-unity-postgres.bicep`.

| Mode | How | Notes |
|---|---|---|
| **Postgres + Entra (DEFAULT)** | `LOOM_UNITY_DB_URL=jdbc:postgresql://…` + `LOOM_UNITY_DB_USER=<uami-name>` + `LOOM_UNITY_DB_AUTH=entra` (+ `AZURE_CLIENT_ID`) | **No password exists anywhere.** pgjdbc mints a fresh Entra token per physical connection through the plugin below. Durable, PITR-backed, multi-writer — so the Container App can run more than one replica. Hibernate creates/updates the UC schema on first boot (`hibernate.hbm2ddl.auto=update`). |
| **Postgres + password (BYO opt-out)** | `LOOM_UNITY_DB_AUTH=password` + `LOOM_UNITY_DB_PASSWORD` (Key Vault secretref) | For a bring-your-own server that still uses password auth. Warns on every boot; fails closed if the password is missing. |
| **H2 file DB (legacy fallback)** | `.mv.db` in `LOOM_UNITY_DB_DIR` (Azure Files) or `LOOM_UNITY_DB_LOCAL=1` (ephemeral) | Only when no `LOOM_UNITY_DB_URL` is wired. **Single-writer** (the app is forced to exactly one replica), **no backup/PITR**, and known to **CrashLoopBackOff on Azure Government's SMB mount**. The entrypoint prints a NOTICE naming the remediation on every boot. |

### Passwordless Postgres — how it actually works

Azure Database for PostgreSQL with Entra-only auth expects a short-lived access
token *as the password*. Rendering one into `hibernate.properties` at container
start does **not** work: the token expires within the hour while Hibernate keeps
opening new physical connections, so the catalog would start healthy and then
hard-fail authentication later.

The image therefore installs two jars next to the server (see the Dockerfile):

* `postgresql-42.7.7.jar` — the JDBC driver (upstream v0.5.0 ships only H2), pulled
  from Maven Central and **SHA-256-verified at build time**.
* `loom-unity-entra-auth.jar` — `ai.limitlessdata.loom.unity.EntraPostgresAuthPlugin`
  (source: `apps/loom-unity/java`), a **dependency-free** implementation of pgjdbc's
  `org.postgresql.plugin.AuthenticationPlugin`. pgjdbc calls it for every physical
  connection, so the token is always fresh. It reads the Container Apps managed-identity
  endpoint (`IDENTITY_ENDPOINT` / `IDENTITY_HEADER`, App-Service protocol — **not**
  classic IMDS, which ACA does not serve) with an IMDS fallback, never logs the token,
  and caches for 60 s purely to stop pool warm-up from stampeding the endpoint.

  *Why not Microsoft's `azure-identity-extensions` plugin?* It is the same seam, but it
  drags azure-identity + msal4j + reactor + netty + jackson onto the classpath of a
  netty/jackson application. One ~200-line dependency-free class cannot conflict with
  the server it is hosted in.

### Migrating an existing H2 catalog

`scripts/csa-loom/loom-unity-migrate-catalog.py` copies catalogs → schemas →
tables/volumes/functions/models from a still-running H2-backed instance into the
Postgres-backed one **over the UC REST API** (idempotent, `--dry-run` first).
Metadata only — storage locations and grants are covered in
`docs/fiab/unity-gov.md`. `scripts/csa-loom/loom-unity-postgres-bootstrap.sh`
does the PostgreSQL-side principal registration and grants.

## Auth (LU-2 — hardened; Entra by default)

**Microsoft Entra bearer authorization is ON by default, and there is no anonymous
fallback.** The entrypoint renders `server.authorization=enable` unless the operator
explicitly sets `LOOM_UNITY_AUTH=disable`, with the token **issuer and audience both
pinned**. (Until the `svc-loom-unity-authz` fix it inferred `disable` whenever no
tenant happened to be wired — so any caller that omitted one variable got a catalog
that anything on the VNet could read AND mutate. That inference is gone.) The keys (`server.allowed-issuers` /
`server.audiences`) are verified verbatim against upstream
`etc/conf/server.properties` at both `v0.5.0` — the tag the Dockerfile pins — and
`v0.5.1`:

| Derived value | From |
|---|---|
| `server.authorization-url` | `https://<authority>/<tenant>/oauth2/v2.0/authorize` |
| `server.token-url` | `https://<authority>/<tenant>/oauth2/v2.0/token` |
| `server.allowed-issuers` | `https://<authority>/<tenant>/v2.0` (the form upstream documents for Entra ID) |
| `server.audiences` | `api://<client-id>,<client-id>` |

`<authority>` is `LOOM_UNITY_AUTHORITY_HOST` — Commercial `login.microsoftonline.com`,
Azure Government `login.microsoftonline.us` — which the bicep module derives from the
active cloud. Any of the four can be overridden explicitly.

**It fails closed.** `LOOM_UNITY_AUTH=enable` with no pinned issuer *or* no pinned
audience exits 1 with a FATAL naming the exact variable: an authorization server that
validates nothing is worse than an honest open door, so it never boots. **With
nothing wired at all it does the same** — a bare `docker run` aborts with that FATAL
rather than coming up anonymous. The Console reports the state through the
`svc-loom-unity-authz` gate and the live `probe-loom-unity-authz` health probe.

**The bicep modules never hand it that state.** An Entra app registration is a
Microsoft Graph object ARM cannot create, so when none exists yet
(`compute/loom-unity-app.bicep`, `data-plane/iceberg-catalog-aca.bicep`) the deploy
pins a per-deployment **sentinel** audience in the RFC 2606 reserved `.invalid` TLD
— `api://loom-unity-sealed-<uniqueString>.invalid` — that no Entra tenant can ever
issue a token for, and sets `minReplicas: 0`. The container comes **up** with
authorization enforced and rejects 100% of callers (the *SEALED* state) instead of
CrashLoopBackOff-ing. Deploy phase 3 (`scripts/csa-loom/bootstrap-msal-app-reg.sh`)
stamps the real client id and unseals it. See
`docs/fiab/unity-gov.md` § "The SEALED state".

### How a client authenticates — it is an EXCHANGE, not a bearer pass-through

**A Microsoft Entra access token is not accepted on `/api/2.1/unity-catalog/*`,
however correctly it is audienced.** Upstream `AuthDecorator` — line 79, identical
in `v0.5.0` and `v0.5.1` — rejects any token whose `iss` is not the server's own
`internal` issuer:

```java
if (!issuer.equals(INTERNAL)) {
  throw new AuthorizationException(ErrorCode.PERMISSION_DENIED, "Invalid access token.");
}
```

Measured: a valid RS256 token from the pinned issuer with an exact
`server.audiences` match is answered **403 PERMISSION_DENIED**
(`docs/fiab/security/loom-unity-authz-proof.md`, case 4). `server.allowed-issuers`
and `server.audiences` govern the **token-exchange endpoint**, not the data API:

```
POST /api/1.0/unity-control/auth/tokens
  grant_type=urn:ietf:params:oauth:grant-type:token-exchange
  requested_token_type=urn:ietf:params:oauth:token-type:access_token
  subject_token_type=urn:ietf:params:oauth:token-type:id_token
  subject_token=<the Entra token>
->  { "access_token": "<internal token>", "tokenType": "BEARER" }
```

…and the `internal` token that comes back is what the catalog API accepts.
`AuthService.verifyPrincipal` additionally requires the subject (`email`, else
`sub`) to be `admin` or an **enabled Unity Catalog user**, so a managed-identity
token also needs its principal registered in the catalog.

| Credential | Result on the catalog API |
| --- | --- |
| none / malformed | 401 ✅ rejected |
| Entra bearer, exact audience, presented directly | **403 ✗ rejected** |
| internal token from the exchange above | 200 ✅ |
| `LOOM_UNITY_TOKEN` — the server-minted token in `etc/conf/token.txt`, delivered as a Key Vault secretref | 200 ✅ |

**So `LOOM_UNITY_TOKEN` is currently the only working Console credential.**
`apps/fiab-console/lib/azure/uc-backend.ts` `ossUcAuthHeader()` sends the Entra
token directly and therefore does not authenticate; `unityAuthorizationPosture()`
reports `entra` as **not hardened** for that reason. The durable fix is a
token-exchange client in the BFF plus registration of the Console principal as a
Unity Catalog user — tracked as a follow-up, and the prerequisite for turning
`authMode=entra` on for a live estate.

Threat model: `docs/fiab/security/loom-unity-threat-model.md`.

## ADLS credential vending (optional)

Set `LOOM_UNITY_ADLS_ACCOUNT` (+ `_TENANT` / `_CLIENT_ID` / `_CLIENT_SECRET`) to
let the server vend short-lived Azure delegation-SAS credentials for external
tables/volumes. **`_CLIENT_SECRET` arrives as a Container Apps secret reference
backed by Key Vault (`adlsClientSecretUri` on the bicep module) — never an inline
literal.** **Unset** (the default), loom-unity is a metadata catalog + table
registry and data access stays on Loom's existing managed-identity / ACL
paths. See the honest capability matrix in `docs/fiab/unity-gov.md`.

## Environment variables

| Var | Default | Purpose |
|---|---|---|
| `LOOM_UNITY_PORT` | `8080` | Listen port. |
| `LOOM_UNITY_DB_URL` | *(unset → H2 fallback)* | `jdbc:postgresql://host:5432/db`. The entrypoint appends `sslmode=require` and (in entra mode) the authentication plugin, preserving any query string you already set. |
| `LOOM_UNITY_DB_USER` | *(unset)* | PostgreSQL role = the Entra principal name of the loom-unity identity. **Required** whenever `LOOM_UNITY_DB_URL` is set — missing it fails the boot closed. |
| `LOOM_UNITY_DB_AUTH` | `entra` | `entra` (passwordless, the default) or `password` (audited BYO opt-out). |
| `AZURE_CLIENT_ID` | *(unset)* | Client id of the user-assigned identity the Entra plugin mints tokens for. Unset → boot WARNS (a UAMI-bearing container cannot infer it). |
| `LOOM_UNITY_DB_AAD_RESOURCE` | `https://ossrdbms-aad.database.windows.net` | Sovereign OSS-RDBMS resource (`…usgovcloudapi.net` in Gov); bicep derives it per cloud. |
| `LOOM_UNITY_DB_PASSWORD` | *(unset)* | Only for `LOOM_UNITY_DB_AUTH=password` — **Key Vault secretref only**. |
| `LOOM_UNITY_DB_DDL` | `update` | `hibernate.hbm2ddl.auto`. Set `none` to manage the schema with your own migrations. |
| `LOOM_UNITY_DB_DIR` | `etc/db` | Directory for the H2 fallback file DB (Azure Files mount point). |
| `LOOM_UNITY_DB_LOCAL` | *(unset)* | `1` forces the H2 fallback onto a local ephemeral dir (no SMB mount). |
| `LOOM_UNITY_AUTH` | `enable` | `enable` / `disable`. `disable` is the ONLY route to an anonymous catalog and is an audited opt-out that warns on every boot. Unset means `enable`, so an unpinnable issuer/audience fails the boot. |
| `LOOM_UNITY_ENTRA_TENANT_ID` | *(unset)* | Entra tenant whose tokens are accepted; drives the derived issuer + endpoints. |
| `LOOM_UNITY_ENTRA_CLIENT_ID` | *(unset)* | App registration fronting Loom Unity; drives the derived audiences. |
| `LOOM_UNITY_ENTRA_CLIENT_SECRET` | *(unset)* | Client secret — **Key Vault secretref only**. |
| `LOOM_UNITY_AUTHORITY_HOST` | `login.microsoftonline.com` | Sovereign authority host (`login.microsoftonline.us` in Gov). |
| `LOOM_UNITY_ALLOWED_ISSUERS` / `LOOM_UNITY_AUDIENCES` | *(derived)* | Explicit overrides for the pinned issuer / audience lists. |
| `LOOM_UNITY_AUTHORIZATION_URL` / `LOOM_UNITY_TOKEN_URL` | *(derived)* | Explicit IdP endpoint overrides (any OIDC provider). |
| `LOOM_UNITY_REDIRECT_PORT` | *(unset)* | Upstream `server.redirect-port`. |
| `LOOM_UNITY_ADLS_ACCOUNT` / `_TENANT` / `_CLIENT_ID` / `_CLIENT_SECRET` | *(unset)* | ADLS credential-vending service principal (secret via Key Vault secretref). |

## Build / run

```bash
docker build -t loom-unity apps/loom-unity

# BEHAVIOUR CHANGE (svc-loom-unity-authz): a bare run now EXITS 1. The bare
# invocation used to come up anonymous, which is the finding this fixed.
docker run -p 8080:8080 loom-unity                    # FAILS CLOSED: no issuer/audience pinned

# Local dev / the audited open posture — ask for it explicitly:
docker run -p 8080:8080 -e LOOM_UNITY_AUTH=disable loom-unity

# Authorization enforced:
docker run -p 8080:8080 \
  -e LOOM_UNITY_ENTRA_TENANT_ID=<tenant> \
  -e LOOM_UNITY_ENTRA_CLIENT_ID=<app-client-id> loom-unity
```

Deploy to Azure: `platform/fiab/bicep/modules/compute/loom-unity-app.bicep`
(see `docs/fiab/unity-gov.md` for the full `az acr build` + deploy steps).

## Supply chain (SC1 Trivy CRITICAL gate)

The image is scanned by the blocking `Trivy gate` step in
`build-fiab-images-acr-tasks.yml` (`--severity CRITICAL --ignore-unfixed
--scanners vuln`). Two hardening steps in the Dockerfile keep it at **0
CRITICAL**; neither touches auth, network posture, config or the entrypoint:

| Layer | Finding | Fix |
| --- | --- | --- |
| alpine 3.20.9 | `CVE-2026-31789` — `libcrypto3` + `libssl3` 3.3.6-r0 | `apk upgrade --no-cache` pulls the already-published 3.3.7-r0 ahead of the pinned base tag (the alpine analogue of the `apt-get dist-upgrade` in `fiab-mcp-bridge` / `loom-transform-runner`) |
| jar | `CVE-2025-14813` — `bcprov-jdk18on` 1.80 | `scripts/sc1-prune-cache.sh` removes it with the other 553 coursier-cached jars that no classpath file references |

The upstream image bakes its whole sbt build cache (864 jars, 1.3 GB) into the
runtime layer, but the launch scripts only load the 310 of them named by the
image's eight `classpath` files. `sc1-prune-cache.sh` derives the keep-set **from
those files at build time** — never a hand-written list — deletes the 554
unreferenced jars, and then asserts that every classpath entry which existed
beforehand still exists. A single missing entry fails the build. The Loom-added
Postgres driver and Entra auth plugin (`lib-loom/`) are covered by the same
assertion because the prune runs after the classpath rewrite.

Verify locally with `docker build` — the prune prints its own arithmetic
(`classpath files: 8` / `jars in the coursier cache: 864` / `unreferenced jars to
remove: 554` / `assertions passed`).

## Tests

```bash
cd apps/loom-unity && npm test
```

Runs the entrypoint in dry-run mode (15 tests) and asserts the persistence
(Postgres passwordless / password opt-out / H2 fallback, incl. three fail-closed
boot paths),
Entra-authorization (including both fail-closed boot paths and the sovereign
authority host), and ADLS-vending config-rendering branches.

Those are config-rendering tests — they prove what the entrypoint *writes*, not
what the server *does* with it. For that:

```bash
bash apps/loom-unity/tests/authz/authz-e2e.sh
```

12 assertions against the real image, in Docker, with a throwaway OIDC issuer and
no Azure dependency: the fail-closed boot, anonymous/malformed/wrong-issuer
rejection, the token exchange, an **authenticated 200 with real catalog JSON**,
the sealed posture, and the permission-GET route returning **200 with
authorization enabled** (the #1603 fix from the v0.5.1 server overlay, with its
authorization-disabled control). Receipt:
`docs/fiab/security/loom-unity-authz-proof.md`.
