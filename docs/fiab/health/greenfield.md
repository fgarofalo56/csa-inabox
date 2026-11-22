# LHDS greenfield: empty subscription

> **Not executed.** This walkthrough has not been run on a clean subscription.
> It is assembled from the merged bicep and workflow. No receipts exist. Treat
> every step as unverified until a run id is recorded in the
> [per-cloud table](index.md#per-cloud-status).

Prerequisite: a working Loom hub (container registry and Container Apps
environment). `deploy-health.yml` discovers them. The `loom-health-cp` image
must already be in that registry; the workflow has an image preflight step.
Producing that image is not covered here.

## Decision points

1. **Boundary**: Commercial or GCC-High (the only options in the workflow).
2. **Mode**: `whatif-only` (default, applies nothing) or `full`.
3. **Control plane audiences**: comma-separated token audiences for
   `loom-health-cp`. **Empty means the stamp deploys without a control plane**,
   because the service refuses to start without an accepted audience.
4. **Stamp profile**: `healthConfig.profile` is `dev|S|M|L` (default `dev`).
5. **Control plane platform**: `auto` (Container Apps on these boundaries) or `aks`.

## Steps

1. **Preview.** Dispatch `deploy-health` with `run_mode=whatif-only` and read
   the output. A what-if is read-only and is not blocked by an estate pause.
2. **Apply.** Dispatch with `run_mode=full` and the audiences. A full run
   **stands down and applies nothing** if the estate is paused or its state is
   unknown; `override_estate_pause=true` is the explicit way past that. GCC-High
   additionally waits on an environment approval.
3. The workflow compiles `health.bicep`, discovers the hub, refuses to adopt or
   duplicate an existing `rg-csa-loom-health-*` group (unless
   `allow_existing_hub=true`), checks the image tag, runs what-if, then deploys
   into `rg-csa-loom-health-<stamp>-<region>`.
4. **Wire the Console.** Set `healthCpUrl`, `healthCpAudience` and
   `healthDefaultStampId` in the admin-plane `observabilityConfig` so the
   `LOOM_HEALTH_*` env rows resolve. Nothing produces these from the deploy yet.
5. **Register the stamp** with the control plane (`POST /api/health/stamps`),
   then create a `health-tenant` item in the Console.

## Authorization-server issuer: served through Front Door (#5410)

The SMART authorization server runs inside the control plane Container App
(`loom-health-cp`), which lives in the **internal hub** Container Apps
environment (public network access Disabled). The stamp Application Gateway is
in the stamp VNet, which has no peering to the hub, so the old default issuer
`https://<stamp ingress fqdn>/auth` answered 502 on every path (measured
2026-11-21, Commercial dev01).

The issuer is therefore served by the **existing** Front Door Premium profile
(`fd-loom-*`, already Private-Link-connected to the hub environment for the
console):

- `modules/health/afd-issuer.bicep` creates a **dedicated** endpoint
  (`lhds-auth-<stamp>`; the console endpoint and route are untouched), an origin
  group probing `/auth/.well-known/openid-configuration`, an origin that is the
  control plane FQDN with a Private Link connection to the environment, and a
  route whose `patternsToMatch` is exactly `/auth/*`. Every other path,
  including `/api/health/*`, is not served on that host. If the profile has a
  `console-waf-policy`, a **new** security policy attaches the same WAF policy
  to the new endpoint.
- The control plane ingress is `external: true`. In an internal environment with
  public network access Disabled that is still VNet / Private Link only.
- The default issuer is `https://<Front Door endpoint host>/auth`.
  `controlPlaneConfig.authIssuerUrl` still wins.
- `deploy-health.yml` resolves the profile from the hub resource group
  (exactly one; several is an error), passes it as `controlPlaneConfig.frontDoor`,
  **approves** the Pending private-endpoint connection Front Door raises on the
  environment (`scripts/csa-loom/approve-cae-private-endpoints.sh`, fail closed),
  then verifies `/auth/.well-known/openid-configuration` returns 200 with the
  configured issuer and that `/api/health/tenants` is not served on that host.

| Boundary | Issuer path | Status |
|---|---|---|
| Commercial | Front Door | Supported-in-code; not yet deployed or verified live (merged, not deployed) |
| GCC-High | Front Door | Supported-in-code, never exercised for LHDS |
| IL5, DoD | none (Front Door is disabled) | Supported-in-code with a **known gap**: the issuer falls back to the stamp ingress URL, which has no path to the control plane. The workflow emits `::warning::issuer unreachable: no Front Door on this boundary`. An Application Gateway path is a tracked follow-up |
| GCC | Front Door | Supported-in-code, never exercised (no GCC tenant) |

## Ingress TLS: self-signed by default, issued by the control plane

With `healthConfig.tlsCertificateSecretUri` empty (the default on every param
file) the **control plane** (`apps/loom-health-cp`, `src/tls/ingress-cert.ts`)
issues a Key Vault **self-signed** certificate (`lhds-ingress-selfsigned`,
issuer Self, CN and SAN = the ingress public FQDN, 12 months, AutoRenew at 30
days) so the Application Gateway has an HTTPS listener with no operator step.
Key Vault generates the key; the private key never leaves the vault and the
control plane only reads certificate metadata. The control plane ensures the
certificate at startup and every 15 minutes: a no-op when a valid one exists,
re-issued when it is missing, disabled, expired, inside 30 days of expiry, or
for a different FQDN (so deleting it in the vault and restarting the control
plane self-heals). Its identity gets `Key Vault Certificates Officer` on the
stamp vault (`control-plane.bicep`).

This replaced a `deploymentScript` (#5345): on tenants whose policy forces
storage `allowSharedKeyAccess` off, a deploymentScript cannot run at all (ACI
mounts its staging share only by account key), and the stamp no longer has a
script subnet, staging storage account or script identity.

**Two-phase ordering.** The Application Gateway resolves its Key Vault secret
when it is created, so the listener cannot exist before the certificate does.
`deploy-health.yml` (full mode) therefore: (1) deploys `health.bicep` with no
TLS listener (`ingressTlsMode=selfSignedPending`); (2) waits, up to about 20
minutes, for the certificate secret to exist, reading it through the ARM
management plane (`Microsoft.KeyVault/vaults/secrets`, which works on the
private vault); (3) re-deploys with `issuedTlsSecretUri` set to the
**version-less** secret URI (`ingressTlsMode=selfSigned`), so renewals roll
without a redeploy; (4) opens a TLS connection to the public FQDN and fails
unless the served certificate has CN and SAN equal to it. If the secret never
appears the run fails with what was and was not established (the control plane
logs `tls.ingress_cert_error` with the missing role or network cause). The
`loom-health-cp` image must be built from a commit that contains the TLS code
before the first run.

**Vault network path (#5345).** The containerApps control plane runs in the
HUB Container Apps environment, not in the stamp, and the stamp vault is
private-only (its `privatelink.vaultcore` zone is linked to the stamp VNet
only). `health.bicep` therefore adds a second private endpoint on the stamp
vault in the hub `snet-private-endpoints` subnet (`modules/health/hub-vault-pe.bicep`,
deployed into the hub resource group), whose DNS zone group writes the A record
into the HUB's existing `privatelink.vaultcore` zone, the one the hub VNet
resolves through. The stamp zone is not linked to the hub VNet (a VNet cannot
link two zones of the same name). Nothing to supply: the hub resource group
comes from `controlPlaneConfig.environmentId`, the subnet and zone from the hub
naming convention (overridable with `controlPlaneConfig.hubVaultPeSubnetId`,
`hubVaultZoneId`, `hubResourceGroup`); every deploy re-creates the endpoint if
it was deleted. The connection is auto-approved (same tenant, deployer has write
on the vault). The aks control plane sits inside the stamp VNet and gets no hub
endpoint. Not exercised: no deploy has run this path yet.

**Registry Cosmos network path (#5370).** The tenant policy
`CosmosDB_PublicNetwork_Modify` (effect `modify`) forces
`publicNetworkAccess: Disabled` on the control plane's registry Cosmos account
whatever the template asks for, so an account with no private endpoint is
reachable from nowhere (the control plane answered 500 `internal` and its job
sweep failed every 30 s). On the containerApps path `health.bicep` therefore
defaults `controlPlaneConfig.privateEndpointSubnetId` to the hub
`snet-private-endpoints` subnet and `cosmosPrivateDnsZoneId` to the hub
`privatelink.documents.azure.com` zone (`.us` on GCC-High and IL5), reusing the
`cosmosPe` and zone group already in `control-plane.bicep`. Explicit values
(including an explicit empty string) override. A private endpoint must share
its VNet's region and subscription (Microsoft Learn, "What is a private
endpoint"), so the default applies only when the hub subscription is the health
deployment subscription; in a cross-subscription hub it stays empty and you must
supply both values. The `cosmosNetworkPosture` output reports what the template
requested, not what the account reads back. The aks control plane is not
defaulted (follow-up). Not exercised: no deploy has run this path yet; GCC-High
is supported in code only.

Cloud parity: the vault URL comes from the vault's own `vaultUri` output
(`vault.azure.net` or `vault.usgovcloudapi.net`) and the control plane checks
the suffix per cloud, so GCC-High takes the same path. Supported in code on
Commercial and GCC-High; not exercised on either until a `deploy-health` full
run reports it.

- **Override with a real certificate:** set `healthConfig.tlsCertificateSecretUri`
  (brownfield and CA-issued certificates); the self-signed path is then not
  deployed.
- **Opt out:** `healthConfig.selfSignedTls=false` restores "no HTTPS listener".
- **Pinning:** clients and probes must pin the self-signed certificate, not trust
  a CA. The `healthStamp` output carries `ingressTlsMode` (`supplied`,
  `selfSigned`, `selfSignedPending` or `none`), `ingressTlsCertificateName` and
  `ingressTlsExpectedIssuedSecretUri`. The vault is private and the deploy no
  longer returns certificate fingerprints: read the served certificate with
  `openssl s_client -connect <fqdn>:443 -servername <fqdn>`. After an AutoRenew
  the fingerprint changes.
- **Failure:** the control plane never reports success unverified: a 403 names the
  missing `Key Vault Certificates Officer` role and the vault, a firewall refusal
  names the private-endpoint path, an unreachable vault says it was not reached.
  Not exercised: no deploy has run this path yet.
- **Left behind on an existing stamp:** an earlier deploy may have created
  `snet-script`, a staging storage account and a script identity. Incremental
  deploys do not delete them; remove them by hand if unwanted.

## Stamp workloads: the PDP is applied through `az aks command invoke` (#5422)

The stamp cluster is private with local accounts disabled and no network path
from the hub or a runner, so no workload can be applied by `kubectl` from CI and
a `deploymentScripts` resource cannot run (same shared-key policy as the TLS
script). `engines.bicep` therefore deploys only the ARM resources (PDP identity,
federated credential, kubelet `AcrPull`) and **renders the Kubernetes manifest as
the output `healthPdpState.manifest`**: the single source of truth. After the
infrastructure apply, `deploy-health.yml` writes it to a file and runs
`scripts/csa-loom/aks-apply-manifest.sh`, which uses ARM
`managedClusters/runCommand` (`kubectl apply`, then `kubectl rollout status`
bounded to 300 s). Every exit code is read; a permission refusal is retried a
bounded number of times (a new role assignment takes minutes), anything else
fails the run with the cause named (exit 3 permission, 4 kubectl failure, 5 not
Ready, 6 outcome unknown).

- **The bundle signing key is the control plane's, in Key Vault.** `control-plane.bicep` creates an EC-HSM P-256 key
  (`lhds-pdp-bundle-sign`, sign and verify only) through ARM, like the token signing key, and gives the control plane
  `Key Vault Crypto User` on that key alone. A publisher uploads an UNSIGNED `opa build` archive
  (`health-pdp-bundle-publish.yml`, `build-bundle.sh --unsigned`); the control plane adds `.signatures.json` (ES256, key
  id `global`) through the Key Vault sign operation and stores the signed archive; an upload that is already signed is
  refused. The private key never leaves Key Vault and no secret is held in GitHub.
- **The PDP key reaches the template without a human.** `GET /api/health/pdp/stamps/<stamp>/verification-key` returns the
  PEM public key. `deploy-health.yml` fetches it through Front Door as the deploy principal (HealthCP.Admin and a caller
  allowlist entry from `csa-loom-post-deploy-bootstrap`), checks it is EC P-256 with key id `global`, and passes it to the
  phase-2 deployment as `pdpBundleVerificationPublicKeyPem`; the PDP deploys in that same phase. If the control plane or
  the key is not ready the step fails with the status it saw and the likely, unproven, cause.
- **The PDP pulls its bundle through Front Door.** The stamp cannot resolve or reach the internal control plane FQDN
  (load-balancer egress, no peering). The existing issuer endpoint (`afd-issuer.bicep`) now routes `/auth/*` and
  `/api/health/pdp/*` and nothing else; `/api/health/tenants` and the rest of the API still return Front Door's 404. The
  control plane still enforces the Entra token, the HealthCP role and the caller allowlist on that path (an unauthenticated
  request must answer 401; `deploy-health` checks it). The Front Door host is added to the stamp firewall egress
  allow-list (firewall mode; inert on the dev load-balancer profile). Without a Front Door profile and without
  `controlPlaneConfig.pdpControlPlaneBaseUrl` the PDP is not deployed and `healthPdpState.reason` says why.
- **Not Ready until a signed bundle exists.** The PDP pod's readiness is `/health?bundles`, so a first apply with no
  published bundle fails at the rollout step. That is the intended fail-closed signal, not a defect.
- **Roles.** The signed-in deploy principal gets Kubernetes data role `Azure Kubernetes Service RBAC Cluster Admin` on
  the cluster (`controlPlaneConfig.pdpApplyPrincipalId`, resolved by the workflow): the manifest creates a Namespace.
  The control plane gets NO Azure data role on the cluster. Its Kubernetes access is a namespace-scoped `RoleBinding`
  (ClusterRole `edit`, namespace `loom-health`) in the same manifest, bound to its Entra object id, so it cannot read
  Secrets or run pods in other namespaces; per-tenant workloads therefore live in `loom-health` unless a later item adds
  tenant namespaces. Its ARM runCommand rights come from `Contributor` on the stamp resource group. It also gets
  `LOOM_HEALTH_CP_PDP_URL` (the in-cluster decision endpoint) and `LOOM_HEALTH_CP_PDP_SIGNING_KEY_ID`. The PDP's own
  identity needs `HealthCP.Reader` and an allowlist entry: `csa-loom-post-deploy-bootstrap` discovers
  `uami-loom-health-pdp-*` and grants both; run it after `deploy-health` deploys the PDP.
- **The image path: private endpoint plus a digest-pinned import (#5422, decision 8).** The hub registry is
  `publicNetworkAccess: Disabled` with its private endpoints in the hub VNet, and the stamp VNet has no peering, so the
  kubelet's `AcrPull` role alone could not pull (measured on Commercial dev01: `ImagePullBackOff` on `opa:1.9.0-static`,
  "failed to fetch anonymous token"). When the hub registry is known, `stamp.bicep` now adds a private endpoint
  (`pe-lhds-<stamp>-acr`, group `registry`, `acr-pe.bicep`) in the stamp private-endpoint subnet and a stamp-scoped
  `privatelink.<cloud suffix>` zone linked to the stamp VNet only (the suffix comes from
  `environment().suffixes.acrLoginServer`: `azurecr.io` or `azurecr.us`). The zone is deliberately not linked to the hub
  VNet, which already links its own. A same-tenant connection made by a deployer with RBAC on the registry is
  auto-approved ([Learn](https://learn.microsoft.com/azure/container-registry/container-registry-private-link));
  `deploy-health` reads the connection state back and fails with the approve command if it is not `Approved`. With no
  registry known nothing is created and `healthStamp.acrPrivateEndpoint.reason` says so.
  The PDP image is pinned by digest in `platform/fiab/bicep/modules/health/pdp-image.json` (source
  `docker.io/openpolicyagent/opa`, tag `1.9.0-static` for display, digest from the Docker Hub manifest list). One file
  feeds both consumers: `health.bicep` deploys `<acr>/opa@<digest>`, and the `deploy-health` step "Ensure the
  digest-pinned PDP image is in the registry" checks for that digest (data plane, under the shared firewall lease) and runs
  `az acr import --source docker.io/openpolicyagent/opa@<digest> --image opa:1.9.0-static --force` when it is absent,
  then reads it back. Import is an ARM operation, and a network-restricted registry accepts it when "allow trusted
  services" is on, which is the default
  ([Learn](https://learn.microsoft.com/azure/container-registry/container-registry-import-images)). To move to a new OPA
  version, edit that one file (take the digest from the registry manifest, never from a tag).
- **Per-cloud status of the image path.** Commercial: the defect was measured on dev01; the fix is built and tested at
  the template and script level and is **merged-not-deployed until a deploy-health run exercises it**. GCC-High:
  supported in code (the zone suffix resolves to `azurecr.us`), never exercised. IL5 and DoD: supported in code, never
  exercised. GCC: supported in code, never exercised (no GCC tenant exists). Docker Hub as the import source is
  reachable from the ACR import service in Commercial; whether it is reachable from a Gov registry is NOT established,
  and a Gov deployment may need the image mirrored first.
- **Not exercised:** no deploy has run this path. Commercial and GCC-High are
  supported in code only.

## Failure handling

The workflow classifies failures (permission, not found, transient,
quota/capacity, template) and prints a remediation. PostgreSQL Flexible Server
can be offer-restricted per region; Gov defaults to `usgovarizona` paired with
`usgovtexas` (`W0-RECEIPT.md` s4.1b). `healthConfig.postgres` overrides the
availability assumption.

## Not yet implemented

- Stamp registration is a manual API call; the deploy does not register the
  stamp or emit `LOOM_HEALTH_DEFAULT_STAMP_ID`.
- `tenant.create` / `tenant.destroy` handlers exist but `main.ts` does not
  register them or pass an ARM adapter, so a `health-tenant` create cannot run
  the job end to end today.
- The authorization server is not wired into `compose.ts` / `main.ts`.
- The Entra wiring (federated credential on the authorization-server app,
  `HealthCP.Reader` to the APIM gateway, `HealthCP.Admin` to the Console UAMI, both
  ids in `LOOM_HEALTH_CP_ALLOWED_CALLER_APP_IDS`) is done by the post-deploy bootstrap
  step "LHDS control-plane Entra wiring" (`scripts/csa-loom/bootstrap-health-cp-entra.mjs`,
  #5163). Merged, not deployed; offline-tested only, never run against a tenant, Commercial
  or GCC-High. Container Apps control plane only (aks refused). Re-run the bootstrap after
  a deploy-health run: health.bicep re-renders the allowlist env var. The PDP bundle
  endpoint not scoping by stamp is still #5140.
- The same bootstrap seeds one `feature-permissions` grant, `health.tenant-admin`
  Contributor for the loom-ui-verify automation oid (step "Seed automation identity
  feature grant", `scripts/csa-loom/seed-automation-feature-grant.mjs`). It is keyed by
  the oid, not a tid, because the minted session has no tid and grants resolve by
  `tid || oid`; a grant made in the admin UI is invisible to it. Merged, not deployed.
- Per-stamp PDP data (`data.lhds.config` / `data.lhds.stamp`) and a bundle
  publishing pipeline do not exist. The control plane serves a bundle from a
  directory (`pdpBundleDir`); a served bundle denies everything until populated.
- `health-tenant` `autoBindOnCreate` is not wired; no browser walk was done.
- Estate pause: bicep emits no `loom-health-stamp` tag and nothing passes stamp
  activity to the orchestrator, so the pause guard is inactive.
- DoD: no boundary value, no param file.
