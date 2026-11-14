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

## Edge probe (tenant 403 and quota 429 + Retry-After)

Until this has been run against a deployed gateway, the cross-tenant 403 and the
per-tenant 429 are **modelled only** (`routing-edge.test.ts`). The quota is
enforced in APIM (`rate-limit-by-key` keyed on the URL tenant); a WAF rate-limit
rule cannot key on a token claim, so the WAF rule is only a per-client-address
volumetric backstop.

```bash
LHDS_EDGE_BASE_URL=https://<gateway> LHDS_TENANT_A=<slug> LHDS_TENANT_B=<slug> \
LHDS_QUOTA_RPM=<tenant A effective requests per minute> \
LHDS_TOKEN_A=<token with tenant claim A> LHDS_TOKEN_B=<token with tenant claim B> \
node scripts/measure/health/edge-probe.mjs
```

Exit 0 = every check passed, 1 = the gateway answered wrongly (defect),
2 = unmeasured (bad config, no response, or the positive control failed; this is
not a claim the edge is broken). Run it per cloud: Commercial and GCC-High each
need their own receipt. The WAF per-address rule is untested in Azure Government;
if the rule type is rejected there, set `healthConfig.wafClientRateLimitPerMinute` to 0 in
the boundary's `health-params/*-health.bicepparam` (health.bicep passes it to the stamp
ingress; 0 drops the rule). The default is 6000 on every boundary, so Gov is not given a
lesser product by default; the 0 is an escape taken only on a recorded rejection.
Status: the 429 + `Retry-After` and the Gov WAF rule are compiled and structurally
tested (`scripts/ci/__tests__/lhds-edge-policy.test.mjs`) but never exercised.
