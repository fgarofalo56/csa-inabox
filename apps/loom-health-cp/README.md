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
jobs (W1-2), the MPI, the bicep module (`control-plane.bicep`) and the
admin-plane env rows. Until that bicep follow-up lands the service is not
deployable; merging this code does not deploy it.

## API

All routes except `GET /healthz` require `Authorization: Bearer <Entra token>`.
Responses are `{ok:true,data}` or `{ok:false,error:{code,message}}`.

| Route | Role |
|---|---|
| `GET /healthz` | none (liveness) |
| `GET /api/health/stamps`, `/stamps/{id}`; `GET /tenants`, `/tenants/{id}`; `GET /routing-map`; `GET /slo`; `GET /jobs`, `/jobs/{id}` | `HealthCP.Reader` or `HealthCP.Admin` |
| `POST /stamps`, `PATCH /stamps/{id}`, `POST /tenants`, `PATCH /tenants/{id}`, `POST /routing-map/publish`, `POST /jobs`, `POST /jobs/{id}/retry`, `/cancel` | `HealthCP.Admin` |
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
