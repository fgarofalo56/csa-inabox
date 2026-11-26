# loom-health-cp - LHDS health control plane (W1-3)

Regional control-plane service for Loom Health Data Services (ADR-005, ADR-006).
It holds identities, pointers, policy and telemetry only - never clinical data.

| Area | What it does |
|---|---|
| Registries | Stamp and tenant registries in Cosmos, with lifecycle-status transitions and etag-guarded updates |
| Jobs | Lifecycle-job framework: audited, idempotent jobs with receipts (`queued -> running -> succeeded/failed`, retry, cancel, lease-expiry recovery). Tenant jobs (W1-2) register handlers against it; this service ships `routing.publish` |
| Routing | Builds the `tenant -> stamp` map from the registries and publishes it as one document for the edge (W1-6) |
| SLO | Stamps report counts and capacity; the API aggregates availability, error budget and state per stamp and fleet-wide |

Not in this service yet: the authorization server (W1-4, `src/auth/**`), tenant
jobs (W1-2) and the MPI.

Deployment: `platform/fiab/bicep/modules/health/control-plane.bicep`, invoked by
`platform/fiab/bicep/health.bicep`, LHDS's own subscription-level deployment unit
with its own 4 MiB ARM budget (embedding it in `main.bicep` pushed
`deploy-templates/main.json` over the inline limit). It is deployed by
`.github/workflows/deploy-health.yml` (dispatch-only; Commercial and GCC-High;
`whatif-only` by default; `healthEnabled` is false in every `*-health.bicepparam`).
It creates the Cosmos account with the five containers, the identity and its Data
Contributor role, and the workload: a Container App (Commercial, GCC, GCC-High) or
a Deployment on the stamp AKS cluster (IL5, supported in code, not offered by the
workflow), chosen by `controlPlaneConfig.controlPlane`, which is independent of the
admin-plane `containerPlatform`. The stamp is created in the same deployment; the
control plane is skipped, with the reason in the `healthControlPlaneState` output,
unless `controlPlaneConfig.audiences` is set. On AKS the Service is ClusterIP only: no route
from outside the cluster exists until the stamp ingress (W1-6) publishes one.
Neither path has produced a deploy receipt (supported-in-code, never exercised).

## API

All routes except `GET /healthz` require `Authorization: Bearer <Entra token>`.
Responses are `{ok:true,data}` or `{ok:false,error:{code,message}}`.

| Route | Role |
|---|---|
| `GET /healthz` | none (liveness) |
| `GET /api/health/stamps`, `/stamps/{id}`; `GET /tenants`, `/tenants/{id}`; `GET /routing-map`; `GET /slo`; `GET /jobs`, `/jobs/{id}` | `HealthCP.Reader` or `HealthCP.Admin` |
| `POST /stamps`, `PATCH /stamps/{id}`, `POST /tenants`, `PATCH /tenants/{id}`, `POST /routing-map/publish`, `POST /jobs`, `POST /jobs/{id}/retry`, `/cancel` | `HealthCP.Admin` |
| `GET /pdp/stamps/{id}/bundle.tar.gz` (signed OPA bundle, raw gzip, ETag / 304; 404 unknown stamp or unpublished bundle, 503 store unconfigured) | `HealthCP.Reader` or `HealthCP.Admin` |
| `PUT /pdp/stamps/{id}/bundle` body `{revision, sha256, bundleBase64}` (publish a pipeline-built bundle into the `health-pdp-bundles` container; 400 on a sha256 mismatch, non-gzip or oversize (40 KiB) bundle, 404 unknown stamp, 503 when `LOOM_HEALTH_CP_PDP_BUNDLE_DIR` selects the read-only file source) | `HealthCP.Admin` |
| `PUT /stamps/{id}/slo` | `HealthCP.StampReporter` or `HealthCP.Admin` |

(All `/api/health/...` paths.) 401 = token cannot be verified (signature,
issuer, audience, expiry); 403 = verified but missing the role or not an
allowed caller app.

## Environment

| Variable | Required | Meaning |
|---|---|---|
| `LOOM_HEALTH_CP_CLOUD` | yes | `commercial`, `gcc`, `gcc-high`, `il5` or `dod`. Selects the Entra authority host |
| `LOOM_HEALTH_CP_TENANT_ID` | yes | Entra tenant GUID whose tokens are accepted (pins the issuer) |
| `LOOM_HEALTH_CP_AUDIENCE` | yes | Comma list of accepted token audiences (app id URI and/or client id) |
| `LOOM_HEALTH_CP_COSMOS_ENDPOINT` | yes | `https://<account>.documents.azure.<com or us>:443/` |
| `LOOM_HEALTH_CP_COSMOS_DATABASE` | no | Database name, default `loom-health-cp` |
| `LOOM_HEALTH_CP_ALLOWED_CALLER_APP_IDS` | no | Comma list; when set, the token `azp`/`appid` must be in it |
| `LOOM_HEALTH_CP_AUTHORITY_HOST` | no | Bare-hostname override of the per-cloud authority |
| `LOOM_HEALTH_CP_SLO_AVAILABILITY_TARGET` | no | Fraction in (0,1), default `0.999` |
| `LOOM_HEALTH_CP_PDP_BUNDLE_DIR` | no | Directory of `<stamp>.tar.gz` bundles signed by `apps/loom-health-pdp/tools/build-bundle.sh`. Set = read-only file source (dev), publishing answers 503. Unset (the deployed default) = bundles live in the `health-pdp-bundles` Cosmos container and are published with `PUT .../bundle` |
| `LOOM_HEALTH_CP_SUBSCRIPTION_ID` | yes | Subscription GUID holding the stamp resource groups; `tenant.create` / `tenant.destroy` deploy there. Startup fails naming it if unset |
| `LOOM_HEALTH_CP_TENANT_TEMPLATE_PATH` | yes | Path of the compiled `tenant.bicep` (the image carries it at `/app/templates/tenant.json`). Startup fails naming it if unset or not an ARM template |
| `LOOM_HEALTH_CP_ISSUER_URL` | yes | Public issuer URL of the Authorization Server including its path (`https://<host>/auth`). Startup fails if any of the four AS variables is missing |
| `LOOM_HEALTH_CP_FHIR_BASE_URL` | yes | Public FHIR edge base; a tenant's FHIR base (token `aud`) is `<base>/<tenant>/fhir` |
| `LOOM_HEALTH_CP_AS_CLIENT_ID` | yes | App registration GUID of the AS in this cloud's Entra tenant (federated credential, no secret) |
| `LOOM_HEALTH_CP_SIGNING_KEY_ID` | yes | Versioned Key Vault key id (`https://<vault>.<cloud suffix>/keys/<name>/<version>`) that signs LHDS tokens |
| `LOOM_HEALTH_CP_PDP_URL` | no | In-cluster PDP BASE url with no path (the engine appends `/v1/data/lhds/authz/decision`; a path fails startup), written into each tenant engine's config. Empty = the `fhir-tenant.*` kinds are NOT registered (an engine without a PDP answers 503, so it fails closed) |
| `LOOM_HEALTH_CP_FHIR_IMAGE` | no | HAPI engine image reference in the hub ACR (`loom-health-fhir`). deploy-health sets it DIGEST-pinned, `<acr>/loom-health-fhir@sha256:<64 hex>`, resolved from `loom-health-fhir:<imageTag>` before the deploy and pinned only after its cosign signature from build-fiab-images-acr-tasks.yml verifies (#5439); a tag reference is still accepted (other callers), `:latest`, an untagged reference and a malformed digest are refused. The reference is hashed into every engine's rendered revision, so a new build plus deploy-health makes every engine stale and the drift reconciler re-applies it; the engine container pulls `IfNotPresent`, which is deterministic for a digest. With `LOOM_HEALTH_CP_PG_CLIENT_IMAGE` and the PDP url, registers `fhir-tenant.create` / `.configure` / `.teardown` (W2-2b B2c). The engine is delivered through ARM `managedClusters/runCommand` as the control plane identity (ClusterRole `edit` in `loom-health` only). Neither image set = off; one without the other fails startup. Partitions (#5422 decision 11): the job assigns ids and renders the list into the engine env (`LOOM_HEALTH_PARTITIONS`, `LOOM_HEALTH_PG_ADMIN_ROLE`); the engine creates them itself at startup and grants SELECT on `hfj_partition` to the stamp PG admin. The CP makes no `$partition-management-*` call: it waits for the rollout, reads `hfj_partition` back through the PG admin Job and fails `readback_mismatch` on any missing or disagreeing partition |
| `LOOM_HEALTH_CP_PG_CLIENT_IMAGE` | no | psql image pinned BY DIGEST (`name@sha256:<64 hex>`; the pin is `platform/fiab/bicep/modules/health/pg-client-image.json`). Used by the Job that creates the tenant's Entra PostgreSQL principal as ServiceAccount `lhds-pg-admin` |
| `LOOM_HEALTH_CP_TLS_VAULT_URL` | no | Stamp Key Vault URI (`https://<vault>.<cloud suffix>/`). With `LOOM_HEALTH_CP_TLS_FQDN`, turns on ingress certificate issuance (#5345): at startup and every 15 minutes the control plane ensures a Key Vault certificate (issuer Self, subject and SAN = the FQDN), re-issuing it when missing, disabled, expired, inside the renewal window or for another FQDN. Needs `Key Vault Certificates Officer` on the vault; a 403 names it. Both unset = off; one without the other fails startup |
| `LOOM_HEALTH_CP_TLS_FQDN` | no | Ingress public FQDN (certificate CN and only DNS SAN) |
| `LOOM_HEALTH_CP_TLS_CERT_NAME` | no | Certificate name, default `lhds-ingress-selfsigned` |
| `LOOM_HEALTH_CP_TLS_RENEW_BEFORE_DAYS` | no | Integer 1-300, default `30` |
| `LOOM_HEALTH_CP_STAMP_ID` | no | Stamp self-registration (#5377). Set = at startup and every 30 s until settled, the control plane creates this stamp in its own registry if absent, then moves `creating` to `healthy` once it reads the `lhds-stamp-<id>` deployment (with its `stamp` outputs) in `rg-csa-loom-health-<id>-<region>` through ARM (needs Reader on that resource group). `healthy` therefore means "the stamp deployed and this identity can read it", not an engine or ingress probe. An existing stamp is never rewritten and a `paused`, `draining` or `evacuated` one is never moved back. Failures log status and code only and retry; the server still starts. Unset = off (logged). With it set the three below are required, else startup fails naming them |
| `LOOM_HEALTH_CP_STAMP_REGION` | with STAMP_ID | Stamp region, 3-30 chars of a-z0-9 (the resource group suffix) |
| `LOOM_HEALTH_CP_STAMP_CLASS` | with STAMP_ID | `S`, `M` or `L` (the `dev` profile registers as `S`) |
| `LOOM_HEALTH_CP_STAMP_BASE_URL` | with STAMP_ID | Stamp ingress base URL, `https://` with no credentials, query or fragment |
| `LOOM_HEALTH_CP_GRAPH_CONSENT_URL` | no | Admin-consent URL shown by the readiness gate's Fix-it |
| `PORT` | no | Listen port, default `8080` |
| `AZURE_CLIENT_ID` | no | Client id of a user-assigned managed identity (read by `DefaultAzureCredential`) |

Authority host: `commercial` and `gcc` use `login.microsoftonline.com`;
`gcc-high`, `il5` and `dod` use `login.microsoftonline.us`. JWKS is fetched from
`https://<authority>/<tenant>/discovery/v2.0/keys`.

## Cosmos containers (all partition key `/id`)

`health-stamps`, `health-tenants`, `health-routing`, `health-jobs`,
`health-slo`. They must exist before start (data-plane RBAC cannot create
them); the managed identity needs the Cosmos DB Built-in Data Contributor role
on the database.

## Develop

```bash
npm ci
npx tsc --noEmit -p tsconfig.test.json
npx vitest run
```

Tests inject fakes at two named seams: `Collection` (Cosmos; `MemoryCollection`
in `test/helpers.ts`) and `keyResolver` (JWKS; a local key pair).

Boundaries: Commercial/GCC/GCC-High/IL5/DoD are supported in code (authority
resolution is unit-tested); none has been exercised against a live deployment.
