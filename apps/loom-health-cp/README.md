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
| `LOOM_HEALTH_CP_PDP_BUNDLE_DIR` | no | Directory of `<stamp>.tar.gz` bundles signed by `apps/loom-health-pdp/tools/build-bundle.sh`. Unset = bundle route answers 503 |
| `LOOM_HEALTH_CP_ISSUER_URL` | yes | Public issuer URL of the Authorization Server including its path (`https://<host>/auth`). Startup fails if any of the four AS variables is missing |
| `LOOM_HEALTH_CP_FHIR_BASE_URL` | yes | Public FHIR edge base; a tenant's FHIR base (token `aud`) is `<base>/<tenant>/fhir` |
| `LOOM_HEALTH_CP_AS_CLIENT_ID` | yes | App registration GUID of the AS in this cloud's Entra tenant (federated credential, no secret) |
| `LOOM_HEALTH_CP_SIGNING_KEY_ID` | yes | Versioned Key Vault key id (`https://<vault>.<cloud suffix>/keys/<name>/<version>`) that signs LHDS tokens |
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
