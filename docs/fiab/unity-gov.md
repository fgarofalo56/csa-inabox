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
                                                 persistence:
                                                   H2 file DB on Azure Files (default)
                                                   Postgres via LOOM_UNITY_DB_URL (opt-in)
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
- **Persistence**: default **H2 file DB** on a mounted **Azure Files** share (the
  bicep module creates the share + storage link; the entrypoint seeds the schema
  on first boot and it survives restarts). **Postgres** is opt-in via
  `LOOM_UNITY_DB_URL`.
- **Auth (LU-2 — hardened)**: the server enforces **Microsoft Entra bearer
  authorization by default** (`authMode='entra'`), with the token **issuer and
  audience both pinned**; the Console BFF injects the credential on every call and
  is the only caller. Ingress stays internal-only and can be narrowed further to
  the Console's subnet. See [Authorization](#authorization-lu-2) below and the
  threat model at `docs/fiab/security/loom-unity-threat-model.md`.
- **Honest gate**: `LOOM_UC_BACKEND=oss` with `LOOM_UNITY_URL` unset throws a
  structured `OssUcNotConfiguredError` naming the env var + this bicep module — the
  BFF surfaces it as a MessageBar rather than failing opaquely.

## Authorization (LU-2)

> **Naming.** The platform is **Loom Unity** — Loom's Unity-Catalog-**compatible**
> catalog. It is not a Databricks product and is never presented as one.

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

## Deploy

`admin-plane/main.bicep` is at the ARM 256-parameter ceiling, so `loom-unity` is a
**standalone out-of-band entrypoint** (orphan-allowlisted in
`scripts/ci/check-bicep-sync.mjs`), the same pattern the Hyperscale-band apps use.

1. **Build + push the image** into the deployment's ACR (server-side, no local
   Docker needed):

   ```bash
   az acr build -r <acr-name> -t loom-unity:<tag> apps/loom-unity
   ```

2. **Deploy the Container App** (creates the persistent Azure Files share + mount,
   and enforces Entra authorization — see [Authorization](#authorization-lu-2)):

   ```bash
   az deployment group create -g <admin-resource-group> \
     -f platform/fiab/bicep/modules/compute/loom-unity-app.bicep \
     -p location=<region> \
        environmentId=<container-apps-env-resource-id> \
        acrLoginServer=<acr-name>.azurecr.io \
        image=<acr-name>.azurecr.io/loom-unity:<tag> \
        unityUamiId=<uami-resource-id-with-AcrPull-and-KeyVaultSecretsUser> \
        workspaceId=<log-analytics-workspace-resource-id> \
        authMode=entra \
        entraClientId=<entra-app-registration-client-id> \
        consoleAllowedCidrs='["<cae-infrastructure-subnet-cidr>"]' \
        complianceTags='{ "env": "gov" }'
   ```

   Useful outputs: `authorizationEnforced` (must be `true`), `ingressIpRestricted`,
   and `acceptedAudiences` (set `LOOM_UNITY_CLIENT_ID` on the Console to match).

3. **Point the Console at it** (default-ON, no approval gate):

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

### Optional: Postgres persistence

Pass `unityDbUrl=jdbc:postgresql://<host>:5432/unitycatalog` to the bicep module (and
set `LOOM_UNITY_DB_USER` / `LOOM_UNITY_DB_PASSWORD` on the app). Postgres requires
the Postgres JDBC driver on the server classpath and a one-time UC schema migration
— verify against the upstream release before relying on it. The **H2-on-Azure-Files
default needs none of this** and is the recommended day-one path.

### Optional: ADLS credential vending

Pass `adlsAccount` (+ `adlsTenantId` / `adlsClientId`) to the bicep module to let
Loom Unity vend delegation-SAS credentials for external tables/volumes. **The
service-principal secret goes in as `adlsClientSecretUri` — a Key Vault secret URI
resolved at revision start by the app UAMI (`Key Vault Secrets User` on the vault).
Never pass it inline on an `az containerapp update --set-env-vars` line: that lands
a live secret in ARM deployment history and shell history (LU-2, finding F-4).**
Unset, data access stays on Loom's managed-identity / ACL paths.

## Government endpoint notes

- Azure Container Apps, Azure Files, user-assigned managed identities, Log Analytics,
  and ACR are all GA in GCC-High / IL5 / DoD — `loom-unity` needs no managed-service
  substitution to run in Government.
- The service reaches **no** `api.fabric.microsoft.com` / `api.powerbi.com` /
  `*.azuredatabricks.net` host — it IS the Azure-native Unity Catalog backend.
- Sovereign host suffixes (Storage, ARM, Log Analytics) are resolved by the Console
  through `lib/azure/cloud-endpoints.ts`. `loom-unity` itself only talks to its own
  H2/Postgres store, the sovereign Entra endpoint for token validation (issuer host
  derived from `environment().authentication.loginEndpoint`), and — if enabled — the
  ADLS SP you wire.

## Verification

- `resolveUcBackend()` / `ucFetch()` routing, the Gov auto-select, the honest gate,
  and the grants-gated-on-OSS behaviour are covered by
  `apps/fiab-console/lib/azure/__tests__/uc-backend-switch.test.ts` (real fetch
  capture — no client stubs).
- **LU-2 authorization**: `apps/fiab-console/lib/azure/__tests__/uc-authz.test.ts`
  (17 tests — bearer injection reaches the real REST call, fail-closed on an
  unmintable token, no hardening inferred from `LOOM_MSAL_CLIENT_ID`).
- The entrypoint config rendering (H2 default / Postgres / **Entra authorization,
  including both fail-closed boot paths** / ADLS vending) is covered by
  `apps/loom-unity/tests/entrypoint.test.mjs` (dry-run, 10 tests).
- Live posture: `probe-loom-unity-authz` on `/admin/health` — the G1 receipt.
- `check-bicep-sync`, `check-bicep-param-cap`, `check-env-sync`,
  `check-duplicate-env`, `check-health-coverage`, and `tsc --noEmit` pass.

## Cross-references

- `apps/loom-unity/README.md` — the packaged server + env-var reference.
- `docs/fiab/security/loom-unity-threat-model.md` — the LU-2 STRIDE threat model.
- `.claude/rules/no-fabric-dependency.md` — why every item works Azure-native.
- `docs/fiab/hyperscale.md` — the sibling out-of-band ACA-app deploy pattern.
