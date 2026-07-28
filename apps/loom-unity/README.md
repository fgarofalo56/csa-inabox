# CSA Loom — loom-unity (self-hosted OSS Unity Catalog for Azure Government)

`loom-unity` packages the open-source **Unity Catalog** server
([unitycatalog.io](https://www.unitycatalog.io/), LF AI & Data;
[github.com/unitycatalog/unitycatalog](https://github.com/unitycatalog/unitycatalog))
as a CSA Loom Container App so **Azure Government** — where Databricks Unity
Catalog is unavailable/limited — gets a **real Unity Catalog REST backend that
works day one**. It is the Azure-native default Unity Catalog backend; no
Microsoft Fabric / Power BI dependency (`.claude/rules/no-fabric-dependency.md`).

This is **packaging, not a fork**. The image starts `FROM
unitycatalog/unitycatalog:0.5.0` (the official published server image) and
overlays one thin entrypoint that renders config from environment variables.

## What it exposes

The upstream OSS UC REST API on port **8080** —
`/api/2.1/unity-catalog/{catalogs,schemas,tables,volumes,functions}` plus
temporary-credential vending — the **same REST surface** the Loom UC client
already speaks to Databricks UC. Loom's client library switches to it with
`LOOM_UC_BACKEND=oss` (or automatically in Gov when no Databricks workspace is
bound); see `apps/fiab-console/lib/azure/uc-backend.ts`.

## Persistence

| Mode | How | Notes |
|---|---|---|
| **H2 file DB (default)** | `.mv.db` on a mounted Azure Files volume (`LOOM_UNITY_DB_DIR`) | Survives restarts; the bicep module mounts the share. Seeded from the image schema on first boot. |
| **Postgres (opt-in)** | `LOOM_UNITY_DB_URL=jdbc:postgresql://…` + `LOOM_UNITY_DB_USER`/`LOOM_UNITY_DB_PASSWORD` | Requires the Postgres JDBC driver on the server classpath and a one-time UC schema migration — see `docs/fiab/unity-gov.md`. |

## Auth (LU-2 — hardened; Entra by default)

**Microsoft Entra bearer authorization is ON by default.** The entrypoint renders
`server.authorization=enable` whenever an Entra tenant is wired, with the token
**issuer and audience both pinned**. The keys (`server.allowed-issuers` /
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
validates nothing is worse than an honest open door, so it never boots. With nothing
wired at all the server stays open **and says so on every boot** with a SECURITY
WARNING naming the remediation — the Console then reports it through the
`svc-loom-unity-authz` gate and the live `probe-loom-unity-authz` health probe.

The Console presents `LOOM_UNITY_TOKEN` (a pre-shared, server-minted token delivered
as a Key Vault secretref) or an Entra bearer minted by its managed identity for the
audience above. Threat model: `docs/fiab/security/loom-unity-threat-model.md`.

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
| `LOOM_UNITY_DB_DIR` | `etc/db` | Directory for the H2 file DB (mount Azure Files here). |
| `LOOM_UNITY_DB_URL` | *(unset → H2)* | `jdbc:postgresql://…` to use Postgres. |
| `LOOM_UNITY_DB_USER` / `LOOM_UNITY_DB_PASSWORD` | *(unset)* | Postgres credentials. |
| `LOOM_UNITY_AUTH` | *(derived: `enable` when a tenant is wired)* | `enable` / `disable`. `disable` is an audited opt-out that warns on every boot. |
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
docker run -p 8080:8080 loom-unity                    # H2 file DB, authorization off + warned
docker run -p 8080:8080 \
  -e LOOM_UNITY_ENTRA_TENANT_ID=<tenant> \
  -e LOOM_UNITY_ENTRA_CLIENT_ID=<app-client-id> loom-unity   # Entra bearer enforced
```

Deploy to Azure: `platform/fiab/bicep/modules/compute/loom-unity-app.bicep`
(see `docs/fiab/unity-gov.md` for the full `az acr build` + deploy steps).

## Tests

```bash
cd apps/loom-unity && npm test
```

Runs the entrypoint in dry-run mode (10 tests) and asserts the persistence,
Entra-authorization (including both fail-closed boot paths and the sovereign
authority host), and ADLS-vending config-rendering branches.
