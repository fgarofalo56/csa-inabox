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
- FHIR engine (#5442, auto-bind): once the tenant is `active`, `tenant.create` submits
  `fhir-tenant.create` under the key `engine-<its own key>` (receipt `engine.chained`; the JobRunner
  dedups a repeat, and each daily `verify-<day>` re-submits so an engine deleted out of band is rebuilt).
  When the control plane has no engine host and PDP url the fhir-tenant kinds are not registered:
  the tenant still goes `active` and the receipt `engine.not_chained` says why. A failed submit is
  `engine.chain_failed` and never fails the tenant. The Console ensure re-submits the same job when
  the item's binding has no `engine: ready` (older tenants, a failed engine job, a host configured
  later) and the editor follows the engine job's receipts while it rolls out.
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

## FHIR create/read receipt (W2-2b B3, #5422 decision 12, not yet exercised live)

Commercial dev01 only (no Gov in-VNet runner: a disclosed gap). Dispatch
`.github/workflows/lhds-fhir-crud-probe.yml`; nothing is typed in except an optional
`retry_window_s`.

1. `create` makes two synthetic tenants (`fc-a-<yyyymmddhhmm>`, `fc-b-...`), runs
   `tenant.create` then `fhir-tenant.create` (partition `probe-site`) and prints each job's
   receipts. Its outputs are non-secret: owned slugs, control plane URL/audience, issuer.
2. `publish` calls `health-pdp-bundle-publish.yml` (mode=publish) inside the same run.
   **The run pauses here for the operator's approval of the `health-pdp-publish`
   environment.** Until a bundle homes the tenants the PDP denies everything.
3. `probe` mints a writer token (tenant A, `system/*.cruds`) and a reader token (tenant B,
   `system/*.rs`), hands them to ONE `az aks command invoke` as `--file` header files (never
   on a command line) and curls each engine's ClusterIP Service from the aks-command pod.
   Expected: a metadata 200 (no token), a tokenless create 401, a writer create 201, a read
   200 with the same id, a cross-tenant read 403, a reader create 403 (with a reader read
   200 as its positive control). A 403 counts only when its positive control passed. Step c
   retries only a 403/503 for up to `retry_window_s`: the response cannot tell a PDP that has
   not loaded the new bundle from a real deny; the reason is in the engine audit log.
4. `cleanup` (always) disables the minted clients, runs `tenant.destroy` for the tenants
   `create` recorded as owned, then `fhir-tenant.teardown`. Since #5442 `tenant.destroy` itself
   runs the engine teardown first (receipt `engine.removed`, or `engine.teardown_skipped` when no
   engine host is configured), so the probe's explicit teardown is a no-op re-run; it works because
   the tenant stays `destroying`. Read the `role.skipped` receipt if shown.

Exit codes: 0 pass, 1 defect, 2 UNMEASURED (az or the pod gave no answer; nothing here is a
claim the engine is broken).

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

## Engine jobs are serialised per tenant (#5442)

`tenant.create`, `tenant.destroy` and every `fhir-tenant.*` job share the exclusive group `tenant-engine`
(`JobHandler.exclusiveGroup`). For one tenant at most one of them runs; the others stay `queued` and start when
the running one ends (or its 10 min lease expires). So a destroy waits for an in-flight engine rollout instead of
racing it, and a second `fhir-tenant.create` ends `config.unchanged`. The check and the claim are one step per
subject inside a control-plane process; two replicas could still claim in the same window (the store has no
per-subject claim), which is a disclosed residual, not a closed gap. The CRUD probe no longer submits its own
`fhir-tenant.create`: it waits on the job `tenant.create` chained (`engine.chained job=`) and then adds its
partition with `fhir-tenant.configure`.
