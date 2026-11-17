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
