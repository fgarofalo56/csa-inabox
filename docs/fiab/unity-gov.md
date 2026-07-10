# Unity Catalog for Azure Government — loom-unity (self-hosted OSS Unity Catalog)

**Status:** opt-in, Azure-native, default backend in Azure Government.
**Scope:** `apps/loom-unity`, `platform/fiab/bicep/modules/compute/loom-unity-app.bicep`,
`apps/fiab-console/lib/azure/uc-backend.ts` (+ `unity-catalog-client.ts`).

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
**v0.5.0**, 2026-06-18) as a Loom Container App. It exposes the **same REST API**
the Loom client already speaks, so the switch is a base-URL + auth change — not a
new client.

## Architecture

```
Console (fiab-console)                         loom-unity Container App (internal ingress)
  lib/azure/unity-catalog-client.ts  ──HTTP──▶   OSS Unity Catalog server (:8080)
    ucFetch() ──▶ uc-backend.ts                    /api/2.1/unity-catalog/{catalogs,
      resolveUcBackend():                            schemas,tables,volumes,functions}
        'databricks' | 'oss'                       persistence:
      isOssUc() → LOOM_UNITY_URL                     H2 file DB on Azure Files (default)
                                                     Postgres via LOOM_UNITY_DB_URL (opt-in)
```

- **Backend switch** (`uc-backend.ts`): `LOOM_UC_BACKEND` = `databricks` (Commercial
  default) | `oss`. When unset, Loom **auto-selects `oss` in Azure Government**
  (`isGovCloud()` from `cloud-endpoints.ts`) when no Databricks workspace is bound
  and `LOOM_UNITY_URL` is set. Commercial is unchanged.
- **Same REST surface**: `ucFetch()` routes catalogs / schemas / tables / volumes /
  functions to `LOOM_UNITY_URL` — the OSS server returns the same JSON shapes, so
  the existing catalog browse, CRUD, and search work unchanged.
- **Persistence**: default **H2 file DB** on a mounted **Azure Files** share (the
  bicep module creates the share + storage link; the entrypoint seeds the schema
  on first boot and it survives restarts). **Postgres** is opt-in via
  `LOOM_UNITY_DB_URL`.
- **Auth**: `server.authorization=disable` by default — the app is **internal
  ingress only** (reachable from the Console over the Container Apps VNet, never
  public), so the VNet is the security boundary, identical to the sibling
  `loom-onelake` service. Upstream OAuth/OIDC is opt-in (`LOOM_UNITY_AUTH=enable`);
  when the client is given `LOOM_UNITY_TOKEN` it sends it as a bearer token.
- **Honest gate**: `LOOM_UC_BACKEND=oss` with `LOOM_UNITY_URL` unset throws a
  structured `OssUcNotConfiguredError` naming the env var + this bicep module — the
  BFF surfaces it as a MessageBar rather than failing opaquely.

## Honest capability matrix — OSS Unity Catalog vs Databricks Unity Catalog

| Capability | Databricks UC | OSS UC (loom-unity) | Loom on the OSS backend |
|---|---|---|---|
| Catalogs / schemas / tables / volumes / functions (list, get, create, delete) | ✅ | ✅ | ✅ Routed to `LOOM_UNITY_URL` |
| Metadata catalog + table registry | ✅ | ✅ | ✅ |
| Temporary credential vending — **AWS S3 / GCS** | ✅ | ✅ (0.2+) | n/a (Azure deploy) |
| Temporary credential vending — **Azure ADLS** (delegation SAS) | ✅ | ⚠️ Supported via `adls.*` server config, evolving | ⚠️ Opt-in (`LOOM_UNITY_ADLS_*`). **Default OFF** — data access stays on Loom's existing managed-identity / ACL paths |
| Grants — REST permission graph (`/permissions/*`) | ✅ | ❌ Different/evolving RBAC model | **Gated (501)** — use the Databricks backend, or manage RBAC on the underlying Azure services |
| Delta Sharing (shares / recipients / providers) | ✅ | ❌ Not in the server | **Gated (501)** |
| Table / column lineage (system tables + lineage-tracking) | ✅ | ❌ | **Gated (501)** — Loom's unified lineage uses Purview + ADLS on this backend |
| Governed tags / policies / metric views (SQL-warehouse features) | ✅ | ❌ | Naturally gated (no SQL warehouse on OSS) |
| API stability | GA | **Evolving** ("APIs should not be assumed stable" — upstream) | Pin the image tag; bump deliberately |

**Bottom line (honest scope):** on the OSS backend, `loom-unity` is a **real,
functional metadata catalog + table registry** with the full catalog/schema/table/
volume/function REST surface. Grants, Delta Sharing, and lineage are Databricks-UC
features that OSS UC does not (yet) provide; Loom **gates them honestly** on this
backend and routes governance/lineage through Purview + Azure-native paths instead.

## Deploy

`admin-plane/main.bicep` is at the ARM 256-parameter ceiling, so `loom-unity` is a
**standalone out-of-band entrypoint** (orphan-allowlisted in
`scripts/ci/check-bicep-sync.mjs`), the same pattern the Hyperscale-band apps use.

1. **Build + push the image** into the deployment's ACR (server-side, no local
   Docker needed):

   ```bash
   az acr build -r <acr-name> -t loom-unity:<tag> apps/loom-unity
   ```

2. **Deploy the Container App** (creates the persistent Azure Files share + mount):

   ```bash
   az deployment group create -g <admin-resource-group> \
     -f platform/fiab/bicep/modules/compute/loom-unity-app.bicep \
     -p location=<region> \
        environmentId=<container-apps-env-resource-id> \
        acrLoginServer=<acr-name>.azurecr.io \
        image=<acr-name>.azurecr.io/loom-unity:<tag> \
        unityUamiId=<uami-resource-id-with-AcrPull> \
        workspaceId=<log-analytics-workspace-resource-id> \
        complianceTags='{ "env": "gov" }'
   ```

3. **Point the Console at it** (default-ON, no approval gate):

   ```bash
   az containerapp update -n <console-app> -g <admin-resource-group> \
     --set-env-vars LOOM_UC_BACKEND=oss LOOM_UNITY_URL=https://<loom-unity-fqdn>
   ```

   (In Azure Government with no Databricks workspace bound, `LOOM_UC_BACKEND` may be
   left unset — Loom auto-selects `oss` once `LOOM_UNITY_URL` is set.)

### Optional: Postgres persistence

Pass `unityDbUrl=jdbc:postgresql://<host>:5432/unitycatalog` to the bicep module (and
set `LOOM_UNITY_DB_USER` / `LOOM_UNITY_DB_PASSWORD` on the app). Postgres requires
the Postgres JDBC driver on the server classpath and a one-time UC schema migration
— verify against the upstream release before relying on it. The **H2-on-Azure-Files
default needs none of this** and is the recommended day-one path.

### Optional: ADLS credential vending

Set `LOOM_UNITY_ADLS_ACCOUNT` / `_TENANT` / `_CLIENT_ID` / `_CLIENT_SECRET` on the
app to let UC vend delegation-SAS credentials for external tables/volumes. Unset,
data access stays on Loom's managed-identity / ACL paths.

## Government endpoint notes

- Azure Container Apps, Azure Files, user-assigned managed identities, Log Analytics,
  and ACR are all GA in GCC-High / IL5 / DoD — `loom-unity` needs no managed-service
  substitution to run in Government.
- The service reaches **no** `api.fabric.microsoft.com` / `api.powerbi.com` /
  `*.azuredatabricks.net` host — it IS the Azure-native Unity Catalog backend.
- Sovereign host suffixes (Storage, ARM, Log Analytics) are resolved by the Console
  through `lib/azure/cloud-endpoints.ts`; `loom-unity` itself is cloud-agnostic (it
  only talks to its own H2/Postgres store and, if enabled, the ADLS SP you wire).

## Verification (this PR)

- `resolveUcBackend()` / `ucFetch()` routing, the Gov auto-select, the honest gate,
  and the grants-gated-on-OSS behaviour are covered by
  `apps/fiab-console/lib/azure/__tests__/uc-backend-switch.test.ts` (12 tests, real
  fetch capture — no client stubs).
- The entrypoint config rendering (H2 default / Postgres / auth / ADLS vending) is
  covered by `apps/loom-unity/tests/entrypoint.test.mjs` (dry-run, 4 tests).
- `check-bicep-sync`, `check-env-sync`, and `tsc --noEmit` (zero new errors) pass.

## Cross-references

- `apps/loom-unity/README.md` — the packaged server + env-var reference.
- `.claude/rules/no-fabric-dependency.md` — why every item works Azure-native.
- `docs/fiab/hyperscale.md` — the sibling out-of-band ACA-app deploy pattern.
