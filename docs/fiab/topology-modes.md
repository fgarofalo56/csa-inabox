# CSA Loom — deployment topology modes (audit-t156)

`platform/fiab/bicep/main.bicep` deploys in one of three **explicit** topologies,
selected by the `topology` parameter. This replaces the old implicit behavior
where the admin plane (console + hub + all shared services) was deployed on
**every** run — which meant onboarding a new domain would create a *second* Loom
console. The legacy `deploymentMode` (`single-sub` / `multi-sub`) is still
honored and maps onto the new modes for back-compat.

## The three modes

| `topology`    | Admin plane (console, Front Door, Cosmos, hub, LAW, shared svcs) | Landing zone(s) | Use |
|---------------|------------------------------------------------------------------|-----------------|-----|
| `single-sub`  | ✅ deployed                                                       | ✅ one, in the same sub | dev / demo (the pre-t156 default, byte-identical) |
| `tenant`      | ✅ deployed (the **DMLZ**)                                        | ❌ none          | the one-console-per-tenant deploy; domains attach later |
| `dlz-attach`  | ❌ **skipped** (must already exist)                              | ✅ into the target sub(s) | onboard a domain landing zone wired to the existing hub |

**Back-compat mapping** (when `topology` is empty):
`deploymentMode='single-sub'` → `single-sub`; `deploymentMode='multi-sub'` →
legacy admin-plane + multi-sub DLZ fan-out (unchanged).

Derived gating booleans in `main.bicep`:
- `deployAdminPlane = effectiveTopology != 'dlz-attach'` — gates the admin-plane
  RG + module **and** every admin-plane-only consumer (the 21 `dp*`
  deploy-planner modules, monitoring/cost reader RBAC, RTI-hub RBAC, setup
  orchestrator hub RBAC, AOAI-spark RBAC).
- `deployLandingZones = effectiveTopology != 'tenant'`.
- `useSingleDlz` / `useMultiDlz` pick the in-sub `singleDlz` module vs the
  cross-sub `dlz[for]` fan-out over `dlzSubscriptionIds` / `dlzDomainNames`.

## Hub coordinates for `dlz-attach`

In `dlz-attach` the admin plane is **not** deployed, so the DLZ + cross-sub RBAC
modules cannot read `adminPlane.outputs.*`. They read from the `hubCoordinates`
object param instead — the tenant (DMLZ) deployment's `topologyManifest.hub`
output. Required keys:

```
adminPlaneRgName, hubVnetId, lawId, appInsightsConnectionString,
privateDnsZoneIds { synapseSql, adf }, adxClusterPrincipalId,
consolePrincipalId, consoleUamiName, consoleUamiAppId, consoleUamiResourceId,
activatorPrincipalId, catalogEndpoint, aiServicesAccountName
```

These come from the cross-subscription `existing`/output flow per
[Bicep deploy-to-subscription scopes](https://learn.microsoft.com/azure/azure-resource-manager/bicep/deploy-to-subscription#deployment-scopes).
The orchestrator (audit-t157) stores them in the Cosmos `tenant-topology` doc at
tenant-deploy time and passes them back as params on each attach.

## `topologyManifest` output

Every deployment emits a `topologyManifest` object output — a faithful record of
what was deployed where (per `no-vaporware.md`), for the console to ingest:

```jsonc
{
  "topology": "tenant",
  "deploymentMode": "single-sub",
  "boundary": "Commercial",
  "location": "eastus2",
  "adminPlaneDeployed": true,
  "adminPlaneSubId": "<guid>",
  "adminPlaneRgName": "rg-csa-loom-admin-eastus2",
  "landingZonesDeployed": false,
  "hub": { "hubVnetId": "...", "lawId": "...", "consolePrincipalId": "...", ... },
  "consoleUrl": "https://loom-console...",
  "dlzs": [ { "domainName": "...", "subscriptionId": "...", "resourceGroup": "..." } ]
}
```

Read it after a tenant deploy:

```bash
az deployment sub show -n <deploy-name> \
  --query properties.outputs.topologyManifest.value
```

## Reference parameter files (FedCiv estate — OPERATOR DECISION D1)

- `platform/fiab/bicep/params/tenant-dmlz.bicepparam` — `topology='tenant'`,
  console + shared services into the DMLZ sub (`e093f4fd-…`).
- `platform/fiab/bicep/params/dlz-attach.bicepparam` — `topology='dlz-attach'`,
  a domain landing zone into a bureau sub (`363ef5d1-…`), wired to the hub via
  `hubCoordinates` (env-backed, populated from the tenant deploy outputs).

## Deploy each mode

```bash
# 1) Tenant (DMLZ): the one console + shared services. NO landing zones.
az deployment sub create --subscription <DMLZ-sub> -l eastus2 \
  -f platform/fiab/bicep/main.bicep \
  -p platform/fiab/bicep/params/tenant-dmlz.bicepparam

# 2) Attach a domain landing zone into a bureau sub. NO second console.
#    Export the LOOM_HUB_* env vars from step 1's topologyManifest.hub first.
az deployment sub create --subscription <DLZ-sub> -l eastus2 \
  -f platform/fiab/bicep/main.bicep \
  -p platform/fiab/bicep/params/dlz-attach.bicepparam

# 3) Single-sub dev/demo (unchanged):
az deployment sub create --subscription <sub> -l eastus2 \
  -f platform/fiab/bicep/main.bicep \
  -p platform/fiab/bicep/params/commercial.bicepparam
```

## Verify (what-if)

- `tenant` → what-if shows **no** landing-zone resources (no `singleDlz`/`dlz[*]`).
- `dlz-attach` → what-if shows **zero** console / Front Door / Cosmos / hub
  resources (the admin plane is skipped); only the landing-zone RG + its
  resources, wired to the existing hub.
- `single-sub` → identical to the pre-t156 deployment.

## Bootstrap + console sync

- `deploy-fiab-commercial.yml` / `deploy-fiab-gcc.yml` / `deploy-fiab-gcch.yml`
  gain a `topology` `workflow_dispatch` input → `CSA_LOOM_TOPOLOGY` → threaded
  into the deploy `--parameters topology=…` (only when non-empty).
- The Setup Wizard deploy route (`app/api/setup/deploy/route.ts`) validates
  `topology` against the enum (`loom-no-freeform-config`) and threads it into the
  GitHub workflow dispatch inputs **and** the honest 503 copy-paste command.

> The wizard first-run = `tenant` (+ optional first DLZ) and subsequent
> "Add landing zone" runs = `dlz-attach` only (no second console from the UI) is
> implemented in audit-t157.
