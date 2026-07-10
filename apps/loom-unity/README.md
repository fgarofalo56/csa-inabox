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

## Auth

Defaults to **`server.authorization=disable`** and relies on **internal-ingress
network isolation** (reachable from the Console over the Container Apps VNet,
never public) as the security boundary — identical to the sibling `loom-onelake`
internal service. The upstream OAuth/OIDC authorization server is **opt-in** via
`LOOM_UNITY_AUTH=enable` + `LOOM_UNITY_AUTHORIZATION_URL` / `LOOM_UNITY_TOKEN_URL`.
When the client is given `LOOM_UNITY_TOKEN` it sends it as a bearer token.

## ADLS credential vending (optional)

Set `LOOM_UNITY_ADLS_ACCOUNT` (+ `_TENANT` / `_CLIENT_ID` / `_CLIENT_SECRET`) to
let UC vend short-lived Azure delegation-SAS credentials for external
tables/volumes. **Unset** (the default), loom-unity is a metadata catalog +
table registry and data access stays on Loom's existing managed-identity / ACL
paths. See the honest capability matrix in `docs/fiab/unity-gov.md`.

## Environment variables

| Var | Default | Purpose |
|---|---|---|
| `LOOM_UNITY_PORT` | `8080` | Listen port. |
| `LOOM_UNITY_DB_DIR` | `etc/db` | Directory for the H2 file DB (mount Azure Files here). |
| `LOOM_UNITY_DB_URL` | *(unset → H2)* | `jdbc:postgresql://…` to use Postgres. |
| `LOOM_UNITY_DB_USER` / `LOOM_UNITY_DB_PASSWORD` | *(unset)* | Postgres credentials. |
| `LOOM_UNITY_AUTH` | `disable` | `enable` to turn on OAuth/OIDC. |
| `LOOM_UNITY_AUTHORIZATION_URL` / `LOOM_UNITY_TOKEN_URL` | *(unset)* | OIDC endpoints when auth enabled. |
| `LOOM_UNITY_ADLS_ACCOUNT` / `_TENANT` / `_CLIENT_ID` / `_CLIENT_SECRET` | *(unset)* | ADLS credential-vending service principal. |

## Build / run

```bash
docker build -t loom-unity apps/loom-unity
docker run -p 8080:8080 loom-unity                    # H2 file DB, auth disabled
```

Deploy to Azure: `platform/fiab/bicep/modules/compute/loom-unity-app.bicep`
(see `docs/fiab/unity-gov.md` for the full `az acr build` + deploy steps).

## Tests

```bash
cd apps/loom-unity && npm test
```

Runs the entrypoint in dry-run mode and asserts the persistence / auth /
ADLS-vending config-rendering branches.
