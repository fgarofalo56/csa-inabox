# LHDS brownfield: existing Azure estate

> **Not executed, and mostly not implemented.** `deploy-integrity.md` R5 requires
> discover, offer, validate and accept for every backing service. LHDS code does
> **not** do that today. This page states what an operator can do with the merged
> code and lists the gaps exactly. No brownfield subscription has been used.

## What the code does today

| Service | R5 step | Reality in merged code |
|---|---|---|
| Loom hub registry / Container Apps environment | discover, accept | `deploy-health.yml` discovers them and passes them as `controlPlaneConfig`. The only automated discovery |
| Existing LHDS stamp | refuse duplicates | Workflow refuses if an `rg-csa-loom-health-*` group exists unless `allow_existing_hub=true` |
| ACR | accept supplied | `healthConfig.acrLoginServer`; `controlPlaneConfig.acrName/acrResourceGroup/acrLoginServer` |
| DNS / networking | accept supplied | `healthConfig.extraDnsLinkVnetIds`, `vnetAddressPrefix`; the stamp creates its own VNet |
| TLS certificate | accept supplied | `healthConfig.tlsCertificateSecretUri` |
| APIM | accept supplied | `modules/health/ingress.bicep` takes `apimServiceName`, `apimResourceGroupName`, `apimSubscriptionId` and publishes a policy fragment to an existing service. Not reachable from `stamp.bicep` / `health.bicep` (gap 3) |
| AKS, PostgreSQL, Blob, Key Vault, Event Hubs, Log Analytics | discover / offer / validate / accept | **None.** `stamp.bicep` always creates its own. The `existing` references in `tenant.bicep` and `engines.bicep` point at the stamp's own resources, not customer ones |

## Not yet implemented (exact gaps)

1. **No multi-subscription analysis** of existing AKS, PostgreSQL, storage, Key
   Vault, Event Hubs, APIM or Log Analytics, and no per-service
   use-existing-or-deploy-new choice.
2. **No existing-resource parameters** in `stamp.bicep` for those services (none
   of its params accepts a resource id for them), so there is nothing to
   validate SKU, region, network reach or RBAC against.
3. **APIM params not wired**: `ingress.bicep` accepts the `apim*` params but
   `stamp.bicep` and `health.bicep` do not pass them through, so the policy
   fragment can only be published by invoking the module directly.
4. **APIM identity Reader role** is not granted by any bicep.
5. **OpenID configuration discovery**: there is no tenant-independent discovery
   URL for the LHDS authorization server, which the APIM fragment requires.
6. **Per-stamp PDP data and bundle publishing pipeline** (see
   [greenfield](greenfield.md#not-yet-implemented)).
7. **`HealthCP.Reader` app role**, **Console UAMI in `allowedCallerAppIds`** and
   **`HealthCP.Admin`** are manual Entra steps.

## Interim operator path (unverified)

Until the above exists, a brownfield subscription can only supply registry/ACR
values, extra DNS link VNets and a TLS secret URI, and let LHDS deploy its own
stamp resource group alongside the existing estate. That is "deploy new
alongside", which R5 forbids as the default. It is documented as the current
limitation, not as a supported brownfield path.
