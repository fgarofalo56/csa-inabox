# Loom Health Data Services (LHDS)

> **Status: merged, not deployed. Nothing on this page has been executed
> against a live subscription.** `healthEnabled` is `false` in every param file.
> No LHDS resource exists in any cloud, and the walkthroughs in
> [greenfield](greenfield.md) and [brownfield](brownfield.md) have **not** been
> run on a clean or a brownfield subscription. There are no deploy receipts.
> Every step is described from the merged code only. Where the wizard or the
> plan promises something the code does not do yet, it is listed under
> "Not yet implemented" on the relevant page.

LHDS is the Azure-native, Fabric-free health data layer for CSA Loom (FHIR,
DICOM, terminology, conversion, de-identification, lakehouse sink). Wave W1
delivers only the control plane, identity, tenancy and the stamp: no FHIR or
DICOM engine is deployed yet (W2/W3 add them).

Design sources: `PRPs/active/loom-health-data-services/` (`ARCHITECTURE.md`,
`LOOM-INTEGRATION.md`, `W01-control-plane-identity-stamp.md`).

## What exists in code today

| Piece | Where | State |
|---|---|---|
| Stamp bicep (private AKS, PostgreSQL Flexible Server, Blob, Event Hubs, Key Vault, WAF v2 ingress) | `platform/fiab/bicep/modules/health/stamp.bicep` + sub-modules | Merged (#5122), not deployed |
| Own deployment unit | `platform/fiab/bicep/health.bicep`, `health-params/{commercial,gcc-high,il5}-health.bicepparam` | Merged (#5126), not deployed. Separate from `main.bicep` because of the ARM 4 MiB budget |
| Deploy workflow | `.github/workflows/deploy-health.yml` (dispatch-only; Commercial and GCC-High) | Merged. `whatif-only` is the default |
| Control plane | `apps/loom-health-cp` (registries, jobs, routing map, SLO, PDP bundle endpoint) | Merged (#5121), not deployed |
| Tenant bicep + jobs | `modules/health/tenant.bicep`, `tenant.create` / `tenant.destroy` | Merged (#5130); handlers not registered in `main.ts` |
| Authorization server (SMART v2) | `apps/loom-health-cp/src/auth/` | Merged (#5131); not wired into `compose.ts` / `main.ts`. See [security](security.md) |
| PDP (OPA) | `apps/loom-health-pdp`, `modules/health/engines.bicep` | Merged (#5125, #5137) |
| Edge routing | `modules/health/ingress.bicep`, `apim-fragment.bicep` | Merged (#5145); APIM fragment + Reader grant wired from `health.bicep` via `controlPlaneConfig.apim` (merged, not deployed). The Reader grant is management-plane only and does NOT authorize the routing-map call: that still needs the `HealthCP.Reader` app role on the APIM identity and its application id in `allowedCallerAppIds` (not wired). The authorization server serves no root `/.well-known/openid-configuration` yet, so a deploy of this wiring 401s every token until it does. The APIM service needs a system-assigned identity. |
| Loom item `health-tenant` | `apps/fiab-console/lib/catalog/item-types/health.ts`, provisioner, editor | Merged (#5139); no browser walk, not A-grade |
| Estate power | `lib/estate/pause-guards.ts`, `src/jobs/stamp-power.ts` | Merged (#5138); not active |

## Per-cloud status

The truth for every cell: **nothing in LHDS has been deployed or exercised in
any cloud.** "Supported-in-code" means the bicep and params compile; it proves
nothing about whether they deploy (`cloud-parity.md`).

| Capability | Commercial | GCC-High | IL5 | DoD | GCC |
|---|---|---|---|---|---|
| `health.bicep` + param file | Supported-in-code, **never exercised** | Supported-in-code, **never exercised** | Supported-in-code (`il5-health.bicepparam`), **never exercised** | **Not deployable**: `boundary` allows only `Commercial, GCC, GCC-High, IL5`; no DoD param file (W1-8 bicep PR not landed) | `boundary` value accepted, **never exercised**; no GCC tenant exists |
| `deploy-health.yml` | Offered; no apply run recorded | Offered; no apply run recorded | **Not offered** | Not offered | Not offered |
| What-if | **Unmeasured**: estate was paused | **Unmeasured**: run 40206913648 blinded by a Stopped Gov ADX (#5123) | None | None | None |
| Control plane hosting | Container Apps | Container Apps | AKS Deployment (own selector in `health.bicep`) | n/a | Container Apps (unexercised) |
| Tenant create/destroy | Code + unit tests only | Code + unit tests only | Code only | n/a | Code only |
| Gov image gate (`health-gov-image-gate`) | n/a | Blocks Gov stamp rollout until Trivy + cosign exist (#4584) | Same | Same | n/a |

Rows are updated with workflow run ids only. A boundary is called exercised
only with a deploy receipt.

## Pages

- [Greenfield walkthrough](greenfield.md)
- [Brownfield walkthrough](brownfield.md)
- [Runbook stubs](runbooks.md)
- [Security](security.md) (authorization section)

## Related issues

- [#5140](https://github.com/fgarofalo56/csa-inabox/issues/5140) PDP bundle endpoint serves any stamp bundle to any Reader token
- [#5141](https://github.com/fgarofalo56/csa-inabox/issues/5141) `engines.bicep` header says not wired into `health.bicep`, but it is
- [#5142](https://github.com/fgarofalo56/csa-inabox/issues/5142) `persist:true` on emptyDir survives container restarts only, not pod reschedules
- [#5143](https://github.com/fgarofalo56/csa-inabox/issues/5143) reconcile `main.json` 4 MiB ARM headroom figures
