# LHDS runbook stubs

> **Stubs.** Each lists only steps that exist in code. None has been executed
> against a live stamp. Gaps are called out inline.

## Dispatch `deploy-health.yml`

1. Actions, `deploy-health`, Run workflow. Choose `boundary` (Commercial or
   GCC-High) and `run_mode=whatif-only` first.
2. For `full`: set `control_plane_audiences`; leave `allow_existing_hub` and
   `override_estate_pause` false unless intended.
3. A stood-down or what-if run is titled DRY RUN and is not a deployed SHA.
4. IL5 and DoD are not offered. IL5 is `health-params/il5-health.bicepparam`,
   supported-in-code only.

## Tenant create / destroy

- Create: `POST /api/health/tenants` registers the tenant; job `tenant.create`
  (empty input) deploys `tenant.bicep` and reads back resource ids.
- Destroy: job `tenant.destroy` requires `confirmTenantId` equal to the job
  subject. Crypto-shred is evidenced by key state.
- **Not wired**: `main.ts` does not register these handlers or an ARM adapter,
  so submitting these kinds via `POST /api/health/jobs` is not expected to work
  today. Key Vault data-plane disable/delete also needs a Crypto Officer grant
  (W1-2 execution state).

## PDP bundle publish

- The control plane serves `GET /api/health/pdp/stamps/<id>/bundle.tar.gz`
  (ETag, 304) from the directory in `pdpBundleDir`; the stamp's OPA fetches it.
- **Not implemented**: a pipeline that builds, signs and places the bundle, and
  the per-stamp `data.lhds.config/stamp` document. A served bundle denies
  everything until then. #5140 covers the endpoint's missing per-stamp scoping.
- Routing map: `POST /api/health/routing-map/publish` (job `routing.publish`).

## Pause / resume

- Estate pause is the Loom Estate Power lane; the `health-stamp` guard in
  `lib/estate/pause-guards.ts` refuses a stamp with running jobs or active feeds.
- PostgreSQL Flexible Server auto-restarts after 7 days stopped; the control
  plane has a job and scheduler that restarts a `paused` stamp's server once per
  6-day window.
- **Not active**: bicep emits no `loom-health-stamp` tag, nothing passes stamp
  activity to the orchestrator, and `main.ts` does not run the restart scheduler.
