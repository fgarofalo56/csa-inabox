---
name: W01b-close-deploy-receipts
status: active
priority: P1
order: 3
depends_on: [W00-measurement-spike]
review: required
orchestrator_model: sonnet
implementer_model: sonnet
created: 2026-11-14
allow_parallel: true
issues: [5151, 5149, 5123, 5161, 5162, 5163, 5217, 4584]
branch: feat/lhds-w1b-close-receipts
---
# W1b — Close W1: wire, deploy, exercise (Commercial + GCC-High)

## Goal
Turn W1 from "merged, not deployed" into deployed-and-verified: the Commercial control plane runs and serves routes, a synthetic tenant
is created and destroyed with ARM readback, the edge probe and Inferno SMART kit run against it, the `health-tenant` editor passes a
G1 browser walk, and GCC-High gets the same through GitHub Actions. Closes #5151, #5149, #5123 (health parts), #5161-#5163.

## Why
`deploy-integrity.md` R2: W1 was reported complete on 9/9 merges and none of it has been exercised. The Commercial control plane
deployed (run 43333990195) but its replica crash-looped on three missing env values and was deactivated. W2/W3 acceptance needs a
working stamp; this wave is the gate for those.

## Scope / Non-goals
In scope (5 items). Non-goals: FHIR/DICOM behaviour (W02/W03), the five `health-tenant` parity rows that need backends
that do not exist yet (child services, per-tenant evacuate) - see Assumptions; GCC (supported-in-code, never exercised); IL5/DoD
(supported-in-code, never exercised); the JWKS private-address check #5217 (own issue, not blocking).

> ASSUMPTION: `LOOM_HEALTH_CP_FHIR_BASE_URL` is a deploy-time value derived from the stamp ingress (App Gateway hostname +
> `/fhir`), not from a running FHIR engine, so W1b does not depend on W02. Today's "no FHIR edge exists until W02" note in `PRP.md`
> means the engine behind it is absent, not the URL.
> ASSUMPTION: the parity rows for `health-tenant` that need engines (child services, per-tenant evacuate/cost/evidence) move to
> W09 (Lane B owns it); W1b builds only rows whose backend exists now (Access, Keys list/rotate if `tenant-jobs.ts` supports it).
> Operator CONFIRMED that descoping on 2026-11-15; the rows are tracked to W09 in #5309.

## Acceptance criteria
- [ ] `GET <cp>/api/health/stamps` through the console BFF returns `{ok:true,...}` with the dev01 stamp; fails (503/`authServerMissing`) if any of the three env values is unset.
- [ ] `tenant.create` then `tenant.destroy` for a synthetic tenant lists every resource id read back from ARM (> 0 ids) and key state shows disabled after destroy; fails if readback is empty or any id is missing.
- [ ] Edge probe: tenant A path + tenant B token = 403; requests beyond quota = 429 with `Retry-After`; fails on any 200 for the cross-tenant case.
- [ ] Inferno SMART App Launch kit (standalone + EHR launch, v2) against the deployed AS: 0 failures; the report is attached.
- [ ] `health-tenant` G1 walk: create item -> editor opens on the real surface, names match, no error banner on first open, paused banner shown when the stamp is paused; screenshots dark + light + narrow.
- [ ] GCC-High: a `deploy-health.yml` Actions run whose deploy job executed steps (> 0), run id recorded; or, per `cloud-parity.md`, an explicit "blocked, supported-in-code" line naming the blocker (#5123). Q8: the Gov image lane has a Trivy + cosign gate (#4584) before any Gov stamp image ships.
- [ ] Every receipt states its cloud. Anything unexercised is listed as such.

## Read first
`W01-control-plane-identity-stamp.md` (built record), `apps/loom-health-cp/src/{main,compose,config}.ts` and `src/auth/wire.ts` (env contract),
`platform/fiab/bicep/health.bicep`, `modules/health/{control-plane,ingress,apim-fragment,apim-access}.bicep`, `.github/workflows/deploy-health.yml`,
`.github/workflows/health-pdp-bundle-publish.yml`, `scripts/measure/health/edge-probe.mjs`, `apps/fiab-console/lib/install/provisioners/health-tenant.ts`,
`healthTenantAutoBindOnCreate` in `apps/fiab-console/lib/azure/auto-bind.ts`, `docs/fiab/health/`, issue #5151 comment trail, `OPERATOR-DECISIONS-2026-10-22.md` (Q1, Q8).

## Owns
`apps/loom-health-cp/src/{main,config}.ts`, `src/auth/wire.ts`; `platform/fiab/bicep/modules/health/control-plane.bicep`, `health.bicep`,
`health-params/*-health.bicepparam`; `.github/workflows/deploy-health.yml`; `scripts/measure/health/**`; `apps/fiab-console/lib/editors/health/**`,
`lib/gates/registry/health.ts`, `docs/fiab/parity/health-tenant.md`, `docs/fiab/health/**`; `.github/workflows/build-fiab-images-acr-tasks.yml` ONLY the
Gov gate step for #4584 (one PR, W1b-5).

## Must NOT touch
`apps/loom-health-pdp/policies/**` and `input-contract.json` (frozen, `CONTRACT-FREEZE-W2.md` section 1); `main.bicep` and the `boundary` enum (merged #5146);
`apps/loom-health-fhir/**`; any file under W02/W03 ownership; `lib/copilot/health-tools.ts`; do not invent placeholder env values or fake issuer URLs.

## Consumes
Deployed stamp dev01 (`rg-csa-loom-health-dev01-centralus`, DMLZ); Entra apps `loom-health-cp` (94269270-7428-4ea7-a177-8cfcd8208c67) and `loom-health-cp-as`
(fbce6421-6302-4b4d-b4fc-6bc4f47dc341); `health-pdp-publish` environment; `CONTRACT-FREEZE-W2.md`.

## Provides
A functioning control plane + AS + PDP bundle on a live stamp (Commercial), the receipts above on #5151, and the go signal for W02a/W03a live verification.

## Steps
1. W1b-1 Auto-bind the three missing env values (issuer, FHIR base URL, AS client id) in bicep from ingress + Entra bootstrap output; run the #5223 bootstrap
   (federated credential, app roles, caller allowlist); re-run after each `deploy-health` (it re-renders the allowlist var); activate a revision.
2. W1b-2 Commercial exercise: PDP bundle publish on the live stamp; synthetic tenant create+destroy; edge probe; p95 PDP decision latency measured.
3. W1b-3 Inferno SMART kit run; fix defects found (review lane: required, auth surface).
4. W1b-4 `health-tenant` editor to baseline: paused banner, Fix-it on the four gates, `autoBindOnCreate` clean-create receipt (#5161), G1 browser walk.
5. W1b-5 GCC-High: Gov image-lane Trivy+cosign gate (#4584, Q8), then `deploy-health.yml` through Actions, then the same exercise as 2-3 where the estate is up.
   > Blocked-on: #5123 (Gov admin plane red, ADX off in usgovarizona). If still blocked at start, mark the item `blocked` with the issue and stop; do not claim parity.

## Validation
Done = every box in Acceptance is checked with a run id or a captured response. Commands:
```bash
cd apps/loom-health-cp && npm ci && npm test && npm run typecheck          # fails on any regression before deploy
az bicep build --file platform/fiab/bicep/health.bicep --stdout >/dev/null  # compile gate
node scripts/ci/check-env-sync.mjs                                           # fails if an env row is missing in admin-plane/main.bicep
gh workflow run deploy-health.yml -f boundary=Commercial -f run_mode=whatif-only   # then run_mode=full only with operator go (stamp is billing)
node scripts/measure/health/edge-probe.mjs --help                            # then run live per its header; 403/429 are the assertions
gh run view <id> --json jobs --jq '.jobs[]|"\(.name) \(.conclusion) steps=\(.steps|length)"'   # deploy job must show steps > 0
curl -s https://csa-loom.limitlessdata.ai/build-marker.txt                  # estate SHA, report vs main
cd apps/fiab-console && npx vitest run lib/install lib/gates                 # health-tenant provisioner + gate tests
```
Gov receipts come from Actions only (workstation `az` is Commercial). Merged is reported as "merged, not deployed". What-if does not expand nested modules: an
apply, not a what-if, is the receipt. Positive control for the probe: a request with tenant A token on tenant A path must return 200 (a probe that only ever sees 403 proves nothing).

## Rollback
`az containerapp revision deactivate` on the new revision (reversible); `healthEnabled=false`; destroy the synthetic tenant with the job; stamp teardown is an operator action
(stamp is billing, DEV profile). The old `rg-csa-loom-health-dev01-eastus2` WORM storage account is a known leftover (CMK identity removed); needs a support case, not part of this wave.

## Docs to update
`docs/fiab/health/index.md`, `greenfield.md`, `brownfield.md` (execute and correct them; shrink "Not yet implemented"), per-cloud table in `ARCHITECTURE.md` section 6 with run ids, `docs/fiab/parity/health-tenant.md`.

## Wave / Blocked-by / Branch / Worktree
Wave: 1 · Blocked-by: W00-measurement-spike (also: operator go for billing stamp; #5123 for Gov) · Branch: feat/lhds-w1b-close-receipts · Worktree: E:/Repos/_lhds-w1b

## Hot files
`health.bicep`, `control-plane.bicep`, `health-params/*`, `deploy-health.yml`, `gates/registry/health.ts` (W1b owns first in the freeze order), `build-fiab-images-acr-tasks.yml` (Gov gate only). `touches_bicep: yes` (W1b-1, W1b-5 are small separate PRs, one in flight).
Bicep queue: see PRPs/reference/GLOBAL-SCHEDULE.md

## Kickoff prompt
Fresh session, Sonnet. Read in order: `PRPs/active/loom-health-data-services/W01b-close-deploy-receipts.md`, then `W01-control-plane-identity-stamp.md` (execution state),
`CONTRACT-FREEZE-W2.md`, issue #5151, and `apps/loom-health-cp/src/auth/wire.ts` (which env values it requires). Work W1b-1 first in `E:/Repos/_lhds-w1b`. Do not invent env
values; derive them in bicep. Ask the operator before any `run_mode=full` (billing). Never run Gov from the workstation; use Actions. Proof of done: the Acceptance
checklist, each with a run id or response body, posted on #5151. Report merged/deployed/verified separately.

## Execution state

| Item | Status | Branch | Model | Evidence | Updated |
|---|---|---|---|---|---|
| W1b-1 wire env values + Entra bootstrap, activate revision | verifying | feat/lhds-w1b-1-env | sonnet | #5304 merged (`cbd434703`). Commercial: deploy-health full run 43726729661 (deploy job 17 steps); bootstrap run 43727458723 (`OK: 6 write(s); federated credential created`, allowlist = 2 app ids). Revision `loom-health-cp--0000002` Running with ISSUER/FHIR_BASE/AS_CLIENT set. OWED: BFF `GET /api/health/stamps` = `{ok:true}` receipt. Note: FHIR_BASE_URL is the ingress host with no `/fhir` suffix; confirm against the Assumption above. The BFF has no `/api/health/stamps` route: the receipt is `GET /api/health/tenants` = `{ok:true}`, step 1 of the `health-tenant-g1` Playwright project (#5323). **RECEIPT 2026-11-19:** G1 run 44468120431 step 1 PASSED (`GET /api/health/tenants` 200 through BFF → CP → Cosmos), after #5372/#5375 deployed (#5370). | 2026-11-19 |
| W1b-2 Commercial exercise: bundle publish, synthetic tenant, edge probe | in-progress | | sonnet | **Merged, not deployed:** #5320 (`4d131b104`) gives the CI deploy SP HealthCP.Admin + caller-allowlist (operator decision 2026-11-15) · #5321 (`d22735f69`, DEPLOYED with console `2d3966a00`) makes item DELETE submit `tenant.destroy`, gated on health.tenant-admin Contributor · #5327 (`e93d65361`) bootstrap seeds the automation identity's health.tenant-admin grant (a minted session has no tid, so it reads grants under its own oid; operator decision 2026-11-16) · stamp TLS: KV self-signed cert by default #5322 (`0edc18128`) + staging-storage RBAC fix #5326 (`0afcbaca8`). The first apply (run 43794877307) FAILED on DeploymentScriptStorageAccountWithServiceEndpointEnabled. #5326's fix was then shown not to be enough: the re-applies (runs 44022839168, 44025966231) failed `DeploymentScriptACIProvisioningTimeout`, because MCAPSGovDeployPolicies forces storage shared-key off and a deploymentScript can only mount its share by key. **#5355 (`99da651a9`, 2026-11-17) replaces it (#5345):** the control plane issues the cert in Key Vault; deploy-health runs two phases with a fail-closed secret wait and an openssl CN/SAN check; tls-cert.bicep, staging storage, script identity and snet-script are deleted. Merged, not deployed; follow-ups #5356 (top: an HTTPS gap on redeploy). Edge probe needs https + per-tenant tokens (#5320). **2026-11-18/19 LIVE (Commercial dev01):** #5361 (`1cc95bfbd`, hub-side PE for the stamp vault) fixed the CP's `fetch failed`; deploy-health full run 44254176000 green, KV cert present at attempt 1, ingress presents CN/SAN `lhds-dev01-xpmsalxj5i7bs.centralus.cloudapp.azure.com` (TLS **deployed + verified**; #5345). #5363 (`634c1200b`) moved the grant seed to the in-VNet runner (firewall 403 gone, run 44256284701); #5367 (`ff4ba703b`, deploy-SP Data Contributor on `feature-permissions` only, operator decision) was applied by a TARGETED operator script (not a full admin-plane deploy, which carried 65 unrelated drift deltas incl. creating `vgw-loom-centralus`); bootstrap 44428712082 then logged `seeded health.tenant-admin::user::***` (#5360 live). Edge probe NOT run yet. | 2026-11-19 |
| W1b-3 Inferno SMART kit | todo | | sonnet | #5151. No kit exists in the repo. Unblocked 2026-11-19: the HTTPS issuer is deployed and verified (deploy-health 44254176000). | 2026-11-19 |
| W1b-4 health-tenant editor: paused banner, Fix-it, G1 walk | verifying | feat/lhds-w1b-4-tenant-editor | sonnet | #5311 DEPLOYED (`2ac32a01c`). `loom-ui-verify` FIXED and green on main (run 43788346102: verify 3 + publish-version 7 passed) via #5318/#5319 (Playwright drift + non-root runner). G1 spec `health-tenant-g1` (#5323, DEPLOYED with console `2d3966a00`): first live run 43800748474 stopped at step 1 with a 403 (automation lacks health.tenant-admin, nothing created). The #5327 grant lands with the next bootstrap. 2026-11-19 G1 runs: 44433846508 stopped at step 1 with 503 `not_configured` (the SCHEDULED deploy-fiab-commercial re-rendered loom-console from bicep and blanked `LOOM_HEALTH_CP_*`; durable fix #5369 `d5fd4cf11`, merged, first scheduled run not yet observed); after a re-bind (deploy-health 44434706701, ARM read-back on `--0001217`) run 44436794149 stopped at step 1 with **502 `internal` (ref fb5a691e)** - cause NOT established, tracked in #5370 (read the logs from an Actions runner). No tenant was created in either run.

**2026-11-19 later: #5370 FIXED live; G1 steps 1-2 PASS.** The 502 was the CP's own `internal` envelope, and it had three stacked causes:
1. MCAPSGovDeployPolicies `CosmosDB_PublicNetwork_Modify` forces the CP registry Cosmos to PNA Disabled, and there was no PE. Fixed by #5372 (`f7d379fec`): hub PE default, same-subscription. Deployed by deploy-health 44451270732.
2. The running CP kept the public path after the PE appeared. A revision restart cleared it; #5375 makes the app dependsOn the PE.
3. `CosmosCollection.list` did a single `fetchNext` + `.slice` on undefined. Fixed by #5375 (`379dc6484`); image `sha256:1fe5ec99` was rolled by a revision restart, and the 30 s sweep has been clean since.

G1 run 44468120431: step 1 (`GET /api/health/tenants` 200) PASS; step 2 (the item is created and the editor opens clean) PASS; step 3 timed out with NO ARM create (proven with Resource Graph `resourcechanges`, positive-controlled).

**BLOCKED on #5377:** nothing registers stamp `dev01` in the CP, so the provisioner returns `no-stamp` and never POSTs the tenant (live log capture during run 44574850807). OPERATOR DECISION: the CP self-registers its stamp on start, to be built in a FRESH session.

Cleanup: G1's afterAll DELETEd the item (200); nothing was provisioned in ARM.

**NEXT:** #5377, then re-run G1. Follow-ups #5314, #5324, #5328, #5373. | 2026-11-19 |
| W1b-5 GCC-High: Trivy+cosign gate then deploy-health via Actions | todo | | sonnet | #4584, #5123 | 2026-11-14 |
