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
- Console UAMI client id is not in `allowedCallerAppIds`, and the `HealthCP.Admin`
  app role is a manual Entra step. `HealthCP.Reader` (PDP bundle fetch) is also a
  manual Entra step; see #5140 for the endpoint not scoping by stamp.
- Per-stamp PDP data (`data.lhds.config` / `data.lhds.stamp`) and a bundle
  publishing pipeline do not exist. The control plane serves a bundle from a
  directory (`pdpBundleDir`); a served bundle denies everything until populated.
- `health-tenant` `autoBindOnCreate` is not wired; no browser walk was done.
- Estate pause: bicep emits no `loom-health-stamp` tag and nothing passes stamp
  activity to the orchestrator, so the pause guard is inactive.
- DoD: no boundary value, no param file.
