# LHDS runbook stubs

> **Stubs.** Each lists only steps that exist in code. None has been executed
> against a live stamp. Gaps are called out inline.

## Dispatch `deploy-health.yml`

1. Actions, `deploy-health`, Run workflow. Choose `boundary` (Commercial or
   GCC-High) and `run_mode=whatif-only` first.
2. For `full`: leave `control_plane_audiences` empty. It is resolved for you:
   the input if typed, else repo variable `LOOM_HEALTH_CP_APP_CLIENT_ID`, else
   the Entra app `loom-health-cp` by display name (must be exactly one), giving
   `<appId>,api://<appId>`. A full run that cannot resolve it fails; it never
   deploys without the control plane. After the deploy, the run sets
   `LOOM_HEALTH_CP_URL`, `LOOM_HEALTH_CP_AUDIENCE` and
   `LOOM_HEALTH_DEFAULT_STAMP_ID` on `loom-console` and reads them back. A later
   `deploy-fiab-commercial` used to reset them (#5346). It now carries them:
   `deploy-fiab-commercial`, `-gcc`, `-gcch` and `-il5` run
   `scripts/csa-loom/resolve-health-console-binding.sh` before the what-if, which
   exports the three values from the deployed estate (the one `loom-health-cp`
   app, its stamp resource group, and the Entra app `loom-health-cp`; the Entra
   lookup is the default path, and repo variable `LOOM_HEALTH_CP_APP_CLIENT_ID`
   is an optional override). The script never stops the deploy. If a lookup is
   unknown it keeps the values the live console already carries (a warning); if
   that read also fails the deploy still completes and the run is failed at the
   end naming the reason. Re-run this lane to re-bind. Leave `allow_existing_hub` and
   `override_estate_pause` false unless intended.
3. The post-deploy bootstrap (`bootstrap-health-cp-entra.mjs`) declares Graph
   `User.ReadBasic.All` + `GroupMember.Read.All` (application) on `loom-health-cp-as` and creates its
   service principal, so a Global Administrator can grant consent. It does not
   grant it.
4. A stood-down or what-if run is titled DRY RUN and is not a deployed SHA.
5. IL5 and DoD are not offered. IL5 is `health-params/il5-health.bicepparam`,
   supported-in-code only.

## Tenant create / destroy

- Create: `POST /api/health/tenants` registers the tenant; job `tenant.create`
  (empty input) deploys `tenant.bicep` and reads back resource ids.
- Destroy: job `tenant.destroy` requires `confirmTenantId` equal to the job
  subject. Deleting the health-tenant item in the console submits it.
  - If the tenant deployment `lhds-tenant-<slug>` is still `Running` or
    `Accepted`, destroy waits for it (at most 8 min, kept under the 10 min job lease) before naming or deleting
    anything. If it is still running at the cap, the job fails
    `deployment_in_flight` with nothing deleted. Retry it later.
  - It deletes the database, event hub, both private endpoints
    (`pe-<account>-blob`), the pixel storage account, the capacity alert and
    the tenant identity, and proves each is gone.
  - **The audit storage account is retained, not deleted** (operator decision
    2026-11-20, #5392). It is immutable for its retention period (2190 days),
    and Azure refuses to delete it (`AccountProtectedFromDeletion`). Its
    customer-managed key is crypto-shredded with the tenant's other keys, so
    the retained content is unreadable. The job records this as success, with
    the `storage.audit.retained` and `storage.audit.retention` receipts.
  - Crypto-shred is evidenced by key state: every key reads back
    `live=false` with a deleted date.
  - **A leaked tenant whose item is gone** (#5405): dispatch
    `.github/workflows/lhds-tenant-destroy.yml` with `tenant_id`. It runs on
    the in-VNet `loom-aca` runner as the deploy SP, reads the control plane URL
    and audience from the estate, refuses a tenant that is not registered or
    not on stamp `dev01`, submits `tenant.destroy`, and prints every receipt
    (GUIDs redacted). Green only when the job succeeded. A non-G1 tenant id
    needs `allow_non_synthetic`. Commercial dev01 only; Gov has no in-VNet
    runner for it yet.
- Both kinds are registered when the control plane has a tenant ARM config
  (`compose.ts`). The control-plane identity needs Key Vault Crypto Officer on
  the stamp vault (`control-plane.bicep`) to shred keys.

## Edge probe: per-tenant token mint (#5410, not yet exercised live)

- Dispatch `.github/workflows/lhds-edge-probe.yml` (in-VNet `loom-aca`, Commercial
  dev01). `mode=mint-only` creates two synthetic tenants (`ep-a-<yyyymmddhhmm>`,
  `ep-b-...`), mints one SMART Backend Services token per tenant, checks the claims
  (tenant, iss, exp, scope) and prints only a redacted verdict. `mode=probe` also runs
  `scripts/measure/health/edge-probe.mjs` against `edge_base_url` in the same process,
  so no token or key reaches a log, file or output. Cleanup runs under `always()`.
- The issuer is DISCOVERED from the control plane
  (`/auth/.well-known/openid-configuration`), never typed in; the client assertion
  `aud` is the discovered issuer's token URL.
- Exit 0 pass, 1 defect, 2 UNMEASURED (config, permission, or a transient that outlived
  its 3 attempts). Positive control: tenant A's token on tenant A's path must answer
  other than 401/403. A 404/502/503 is "passed auth; backend not serving" (the FHIR
  backend is not deployed yet) and still counts.
- Minted clients are DISABLED, not deleted: the control plane has PATCH but no DELETE
  for `/api/health/auth/clients/<id>`. A disabled client cannot mint again, and the
  tenant destroy makes the tenant's tokens unmintable anyway; the leftover documents
  are tracked in a follow-up issue.

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
