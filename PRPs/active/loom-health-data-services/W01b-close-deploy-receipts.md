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

## W1b-3a spec: SMART AS features Inferno needs (#5454)

Measured 2026-11-24 against the Inferno SMART App Launch kit `1.0.3` (HEAD `980e54e4`, suite `smart_stu2_2`) and `apps/loom-health-cp/src/auth/` at `0a855fd79`.
`review: required` (auth surface). Owns: `apps/loom-health-cp/src/auth/**` (server.ts has no other owner; W01 is frozen), `src/auth/wire.ts`,
`apps/fiab-console/lib/editors/health/**`, the health-tenant BFF routes under `apps/fiab-console/app/api/health/tenants/**`, `docs/fiab/health/**`,
`docs/fiab/parity/health-tenant.md`. Must NOT touch `apps/loom-health-fhir/**` (W02a), bicep (the edge is queued behind apim-WA).

**Gaps, each with the kit test that fails** (kit file in `lib/smart_app_launch/`):

| # | Gap | Fails | Item |
|---|---|---|---|
| G1 | No FHIR edge: `{stamp ingress}/{tenant}/fhir/*` reaches an empty ILB (`fhir-engine-host.ts:105-107`) | `well_known_endpoint`, `openid_fhir_user_claim` read | NOT in W1b-3a: the edge waits behind apim-WA (operator 2026-11-24). Blocks W1b-3 |
| G2 | id_token is ES384; JWKS has no RSA key; openid-configuration has 2 of 7 required fields | `openid_required_configuration_fields` (RS256 at :48), `openid_retrieve_jwks` (:32), `openid_token_header` (:24), `openid_token_payload` (:44) | A2 (fields) now; RSA key **ON HOLD** (operator 2026-11-24) |
| G3 | `resolveFhirUser` unwired (`wire.ts:20-42`), so `fhirUser` is dropped (`grant.ts:47`) | `openid_fhir_user_claim` | A4 |
| G4 | No standalone patient picker (`server.ts:387`); kit default scopes collapse to `openid` | standalone patient context; both refresh tests skip | A5 |
| G5 | Asymmetric token exchange sends no `client_id` (`token_exchange_stu2_test.rb:17-27`); we look up by `client_id` (`server.ts:595`) | `token_exchange_stu2_2` (asymmetric) | A1 |
| G6 | No CORS headers | `cors_token_exchange` (required, public clients); discovery/fhirUser CORS (optional) | A1 |
| G7 | Launch `fhirContext` stored as strings; STU2.2 requires objects (`server.ts:188`) | `token_response_body_stu2_2` if emitted | A1 |
| G8 | No EHR redirector; `ClientDoc` has no launch URI (`types.ts:51`) | none (a pasted launch URL passes); ADR-010 line 20 + `ui-parity.md` require it | A6 |
| G9 | `none` not in `token_endpoint_auth_methods_supported` (`server.ts:253`) | none asserted | A1 |

**Items** (CP items serialize on `server.ts`; A6 console work runs beside them once A3's contract is merged):
- **A1 protocol fixes.** Fall back to the assertion `iss` when `client_id` is absent (RFC 7523 section 3). Add CORS: `*` on discovery, jwks and openid-configuration; on token, only for public clients. Accept `fhirContext` objects. Advertise `none`. Breaking values: a token POST with no `client_id` and a valid assertion must return 200; a response without `access-control-allow-origin` fails the token-CORS assertion.
- **A2 discovery.** The CP serves `/{tenant}/fhir/.well-known/smart-configuration` (the path the edge will route to the CP), and the full openid-configuration, minus RS256 while G2 is on hold. The live receipt waits for the edge (G1); unit tests pin the document now.
- **A3 contract.** `ClientDoc.launchUri` (https or loopback, validated like `redirectUri`), and the fhirUser mapping admin API `PUT/GET /api/health/auth/tenants/{t}/fhir-users/{oid}` holding `Practitioner|Patient|RelatedPerson|Person/<id>`.
- **A4 fhirUser.** Wire `resolveFhirUser` to the A3 mapping. Breaking value: an oid with a mapping must yield `fhirUser` in the id_token; an oid without one must not.
- **A5 patient picker.** Built on the AS. After the Entra callback, when `launch/patient` is requested without a launch handle, the AS renders a Loom-token-styled page bound to the same `lhds_ar_*` cookie and the authreq. It searches `Patient` at the tenant FHIR base with a 60 s token minted for that user, intersected with their roles. The choice is a POST carrying a per-request CSRF value, and the code is issued only after a valid pick. The live picker needs the edge (G1). Tests run with a fake FHIR client.
- **A6 EHR launcher + SMART apps tab.** Add an "Apps" tab on the health-tenant editor: list, register (public or asymmetric) and disable clients through the A3 contract, and a **Launch** button. The BFF mints a launch handle for the session's own oid and navigates to `launchUri?iss={FHIR base}&launch={handle}`. This needs a G1 browser walk, a parity-doc row and a Fix-it for any gate.
- **A7 (held) RS256 id_token key.** The CP creates an RSA-HSM key in its vault if it is missing (no bicep), signs id_tokens with RS256, and publishes both keys in the JWKS. Access tokens stay ES384.

**Operator decisions, 2026-11-24 late (these supersede the holds above):**
1. **The FHIR edge JUMPS the bicep queue.** A minimal edge goes ahead of apim-WA: the ingress behind the existing App Gateway ILB, plus an engine NetworkPolicy peer (`edgePeers`, #5410). It unblocks Inferno, real patient search and W2's 2xx positive control.
   - It must also route `/{tenant}/fhir/.well-known/smart-configuration` to the CP (#5461 serves it).
   - Before taking the slot, confirm no other bicep-touching PR is in flight across all programs. One bicep PR at a time.
   - Do it in a fresh session.
2. **A7, the RS256 id_token key, is a GO.** The CP creates an RSA-HSM key in its own vault if it is missing, and signs id_tokens RS256. The JWKS publishes both keys; access tokens stay ES384.
   - First measure whether the CP identity can create keys in that vault. If a role is needed, that piece is bicep and queues behind the edge.
   - Receipt: a headless check that verifies a real id_token against the public JWKS.
3. **Inferno runs on a Proxmox VM, headed:** a pinned Docker Compose setup driven from the operator's browser on the LAN. There is no CI headless lane, and no Conditional Access change.

**After W1b-3a, W1b-3 (Inferno)** still needs G1 (edge) and A7. Run location (operator 2026-11-24): a Proxmox-hosted Inferno (pinned compose) driven headed from the operator's browser, or a CI headless lane, or both. The CI lane needs an Entra test user that can sign in without MFA, which is a Conditional Access decision to take when the edge lands. Inferno's redirect URIs must be reachable from the browser. Loopback and https redirect URIs are already accepted (`server.ts:133-144`). UNVERIFIED risk: the 300 s access-token TTL against Inferno's automatic refresh could trip reuse detection (`server.ts:639`). Check this on the first live run.

## Execution state

| Item | Status | Branch | Model | Evidence | Updated |
|---|---|---|---|---|---|
| W1b-1 wire env values + Entra bootstrap, activate revision | merged | feat/lhds-w1b-1-env | sonnet | #5304 merged (`cbd434703`). Commercial: deploy-health full run 43726729661 (deploy job 17 steps); bootstrap run 43727458723 (`OK: 6 write(s); federated credential created`, allowlist = 2 app ids). Revision `loom-health-cp--0000002` Running with ISSUER/FHIR_BASE/AS_CLIENT set. OWED: BFF `GET /api/health/stamps` = `{ok:true}` receipt. Note: FHIR_BASE_URL is the ingress host with no `/fhir` suffix; confirm against the Assumption above. The BFF has no `/api/health/stamps` route: the receipt is `GET /api/health/tenants` = `{ok:true}`, step 1 of the `health-tenant-g1` Playwright project (#5323). **RECEIPT 2026-11-19:** G1 run 44468120431 step 1 PASSED (`GET /api/health/tenants` 200 through BFF → CP → Cosmos), after #5372/#5375 deployed (#5370). Deployed and verified on Commercial; #5370 closed 2026-11-20. GCC-High not exercised (W1b-5). | 2026-11-20 |
| W1b-2 Commercial exercise: bundle publish, synthetic tenant, edge probe | in-progress | | sonnet | **Merged, not deployed:** #5320 (`4d131b104`) gives the CI deploy SP HealthCP.Admin + caller-allowlist (operator decision 2026-11-15) · #5321 (`d22735f69`, DEPLOYED with console `2d3966a00`) makes item DELETE submit `tenant.destroy`, gated on health.tenant-admin Contributor · #5327 (`e93d65361`) bootstrap seeds the automation identity's health.tenant-admin grant (a minted session has no tid, so it reads grants under its own oid; operator decision 2026-11-16) · stamp TLS: KV self-signed cert by default #5322 (`0edc18128`) + staging-storage RBAC fix #5326 (`0afcbaca8`). The first apply (run 43794877307) FAILED on DeploymentScriptStorageAccountWithServiceEndpointEnabled. #5326's fix was then shown not to be enough: the re-applies (runs 44022839168, 44025966231) failed `DeploymentScriptACIProvisioningTimeout`, because MCAPSGovDeployPolicies forces storage shared-key off and a deploymentScript can only mount its share by key. **#5355 (`99da651a9`, 2026-11-17) replaces it (#5345):** the control plane issues the cert in Key Vault; deploy-health runs two phases with a fail-closed secret wait and an openssl CN/SAN check; tls-cert.bicep, staging storage, script identity and snet-script are deleted. Merged, not deployed; follow-ups #5356 (top: an HTTPS gap on redeploy). Edge probe needs https + per-tenant tokens (#5320). **2026-11-18/19 LIVE (Commercial dev01):** #5361 (`1cc95bfbd`, hub-side PE for the stamp vault) fixed the CP's `fetch failed`; deploy-health full run 44254176000 green, KV cert present at attempt 1, ingress presents CN/SAN `lhds-dev01-xpmsalxj5i7bs.centralus.cloudapp.azure.com` (TLS **deployed + verified**; #5345). #5363 (`634c1200b`) moved the grant seed to the in-VNet runner (firewall 403 gone, run 44256284701); #5367 (`ff4ba703b`, deploy-SP Data Contributor on `feature-permissions` only, operator decision) was applied by a TARGETED operator script (not a full admin-plane deploy, which carried 65 unrelated drift deltas incl. creating `vgw-loom-centralus`); bootstrap 44428712082 then logged `seeded health.tenant-admin::user::***` (#5360 live). **2026-11-21 (#5410): the edge never existed.** Measured: the APIM edge was never deployed (health.bicep:329, no `apim` key in cp.json; no API includes the fragment), and the stamp-FQDN issuer answered 502 on every path (stamp VNet has 0 peerings; the CP is in the internal hub CAE). OPERATOR DECISIONS 2026-11-21: build the edge, then probe; serve the issuer through the EXISTING Front Door on an `/auth/*`-only route; L1 jumps the bicep queue, L3 (APIM wiring) waits behind apim-WA. Merged + DEPLOYED + VERIFIED on Commercial dev01: #5412 (token mint + `lhds-edge-probe.yml`), #5413 (AFD issuer, CP `external:true`), #5419 (a dedicated WAF policy: Front Door allows one WAF policy per security policy per profile), #5416 (fresh assertion per retry; `auth.internal_error` names its step; the token 500 root cause: the HSM signing key reports `kty EC-HSM` and the signer accepted only `EC`). Receipts: deploy-health 44947837477 (the shared Front Door PE has 1 connection, none pending; openid-configuration via Front Door returns 200 with the issuer; `/api/health/tenants` returns 404 there); mint-only 44946666808 PASS (two synthetic tenants, both tokens with the correct `tenant` claim and discovered `iss`, then clients disabled and tenants destroyed); public JWKS = one EC P-384 ES384 key. OWED: L3 APIM edge wiring (after apim-WA), then the full 403/429 probe; the 2xx positive control needs W2-2b (FHIR) deployed. GCC-High not exercised. | 2026-11-21 |
| W1b-3 Inferno SMART kit | blocked | | sonnet | **2026-11-26: #5489 is FIXED and closed (DEPLOYED and VERIFIED on Commercial dev01).**<br>- Operator decision 2026-11-25: the bare tenant base serves HAPI's DEFAULT partition. #5496 (`c056bdf7f`) adds a plugin tenant strategy; ADR-003 is amended.<br>- #5498 (`73b2eeb68`) digest-pins the FHIR engine image, so a build rolls every engine through the #5486 reconciler. deploy-health 45826171054 (operator dispatch) resolved and cosign-verified `loom-health-fhir@sha256:189afb9e…`.<br>- CRUD probe 45831245533: VERDICT PASS. `engine_image` matches the pin; bare base g 201 / h 200 / i 404.<br>- The demo engine was re-applied (reconcile job succeeded 13:29:45Z). Tokenless through the edge: `/fhir/Patient?_count=1` went 400 -> 401.<br>- **Next: TLS trust, then the headed sign-in, then Inferno.** Operator decision 2026-11-25: the Inferno VM trusts the public stamp certificate (test-only). The product path is #5495 (route `/{tenant}/fhir/*` through Front Door + Private Link; needs the bicep slot).<br>- Follow-ups: #5497 (bundle entries can address another facility; W08a, before multi-facility PHI) and #5499 (cosign signer ref pin). GCC-High not exercised (#5123).<br>**2026-11-25 late: the edge is VERIFIED on existing and fresh engines; Inferno is now blocked by #5489.**<br>- #5486 (`3878aa279`, the engine drift reconciler) is DEPLOYED. The demo tenant was re-applied at CP startup, and its `/fhir/metadata` through the edge went 504 -> 200 (receipt #5410 comment 7170088339).<br>- Fresh tenants `fc-a`/`fc-b-202611251808` through the edge: metadata 200, discovery 200, `Patient` without a token 401. CRUD probe 45574659735 `success` (#5410 comment 7171019149).<br>- **Blocker #5489:** the advertised base `/{tenant}/fhir` cannot serve resources (HAPI URL partitioning needs a partition segment), so Inferno's fhirUser read and Patient search fail.<br>- Still owed after #5489: a TLS certificate Inferno trusts (the stamp certificate is self-signed from Key Vault), and the headed sign-in. An authenticated request THROUGH the edge is not measured yet.<br>**2026-11-25: the FHIR edge (G1) is DEPLOYED on Commercial dev01; its engine positive control is still owed (since closed: see above).** Operator decision 2026-11-25: a Loom-owned OSS nginx router (pinned digest) behind the App Gateway ILB address. The AKS app-routing Gateway API add-on was rejected (AKS API bump, Gov availability undocumented, per-tenant HTTPRoutes); managed NGINX loses Azure support Nov 2026. #5481 `261d3f3cd`: one fresh review, APPROVE; follow-ups #5482. Deploy: deploy-health 45567856388 (operator dispatch, `override_estate_pause=true`): `Deploy health.bicep` and the edge-router apply ran. The default dispatch 45567283955 was a green no-op on a stale PAUSED record (#5484). Public stamp ingress, before 07:20Z / after 08:14Z: `/{t}/fhir/.well-known/smart-configuration` 502 / **200**, byte-identical to the issuer copy (sha256 `dd395a58`, 1116 B), CORS `*`. Unknown tenant 502 / **404** OperationOutcome. `/` 502 / **404**. Demo tenant `/fhir/metadata` 502 / **504** after 5 s. The 504 is consistent with its pre-#5481 NetworkPolicy dropping the router (no re-apply trigger exists: #5482 item 6, PR in flight), but it is NOT proven until a fresh engine answers 200 through the edge. That control is the CRUD probe 45574659735, queued behind the runner outage #5483. Still owed before Inferno: that control; the demo-engine re-apply; a TLS certificate Inferno can trust (the stamp certificate is self-signed from Key Vault); the headed sign-in. GCC-High not exercised (#5123). **2026-11-24 later: BLOCKED on three things, not one.** W1b-3a (#5454, the AS items), the FHIR edge (G1 in the W1b-3a spec; behind apim-WA by operator decision), and the RS256 id_token key (A7, on hold). The kit mapping found 5 gaps beyond #5454's list. **BLOCKED 2026-11-24 on #5454.** A Phase-1 gap measurement shows the AS cannot pass SMART STU2 with 0 failures. It has no standalone patient picker (`server.ts:387`), no EHR-launch redirector, no discovery at the FHIR base, and does not advertise public-client `none`. Operator decision: spec and build those first (W1b-3a, fresh session, review required), then the Inferno workflow with a headed operator sign-in. #5151. No kit exists in the repo. CORRECTED 2026-11-21: the 2026-11-19 "HTTPS issuer is deployed and verified" line was false. Only the stamp TLS certificate was verified; `/auth` behind it answered 502. The issuer is now reachable through Front Door (`https://lhds-auth-dev01-h0fjfmcpayefhdgn.b02.azurefd.net/auth`, deploy-health 44947837477), so Inferno can target it. | 2026-11-25 |
| W1b-3a SMART AS features (#5454) | in-progress | (4 PRs) | sonnet | Spec above. The operator approved the plan on 2026-11-24. **All four PRs are merged.** 2026-11-24 late, operator: A7 (RS256 key) is now a GO. **2026-11-25: A7 is DEPLOYED on Commercial dev01** (#5478 `3dcd21f0f`). Review: APPROVE. CI caught a prefix origin check on the Key Vault `nextLink`, fixed in the PR. The live JWKS holds EC/ES384 plus RSA/RS256 3072. `lhds-as-idtoken-rs256` is RSA-HSM and non-exportable; the CP created it at runtime. The real-id_token receipt waits for the headed sign-in. Follow-ups: #5479. The FHIR edge (G1) now JUMPS the bicep queue (todo, fresh session). Inferno runs on a Proxmox VM, headed. See "Operator decisions, 2026-11-24 late" in the spec.<br>**Deployed and verified on Commercial dev01:**<br>- #5461 PR1 (A1+A2).<br>- #5462 PR2 (A3+A4, plus review fixes).<br>- #5464 PR3 (A5 picker; search is a POST so names stay out of logs; "continue without a patient" by operator decision).<br>Receipt: probe `lhds-edge-probe.yml mode=admin-contract` (#5466), run 45484434459, VERDICT PASS 23/23. It covers fhirUser CRUD with a cross-tenant 404 pair, `Patient/..` returning 400, launchUri accept and refuse, per-tenant OIDC/SMART discovery on a real tenant, and an unknown tenant returning 400. Before and after through Front Door for #5461: OPTIONS on token went from 405 to 204, and per-tenant OIDC on an unknown tenant went from 404 to 400. Synthetic tenants destroyed (audit retained, key shredded).<br>**#5469 PR4 (A6 console Apps tab + EHR launch; patient optional on launch; generated client ids):** merged. The CP was rolled at 22:06Z (image `sha256:1086e270…`, run 45495650358). The console roll and the G1 browser walk are PENDING.<br>**Not exercised live:** an interactive Entra sign-in (fhirUser in an id_token, the picker page, a launch); FHIR-base discovery and a real patient search (both need the edge); GCC-High (#5123).<br>Follow-ups: #5463 (mappings survive destroy), #5470 (gate registry for the edge), #5472 (mapping UI). Pre-existing: #5341 (release-please). | 2026-11-24 |
| W1b-4 health-tenant editor: paused banner, Fix-it, G1 walk | merged | feat/lhds-w1b-4-tenant-editor | sonnet | #5311 DEPLOYED (`2ac32a01c`). `loom-ui-verify` FIXED and green on main (run 43788346102: verify 3 + publish-version 7 passed) via #5318/#5319 (Playwright drift + non-root runner). G1 spec `health-tenant-g1` (#5323, DEPLOYED with console `2d3966a00`): first live run 43800748474 stopped at step 1 with a 403 (automation lacks health.tenant-admin, nothing created). The #5327 grant lands with the next bootstrap. 2026-11-19 G1 runs: 44433846508 stopped at step 1 with 503 `not_configured` (the SCHEDULED deploy-fiab-commercial re-rendered loom-console from bicep and blanked `LOOM_HEALTH_CP_*`; durable fix #5369 `d5fd4cf11`, merged, first scheduled run not yet observed); after a re-bind (deploy-health 44434706701, ARM read-back on `--0001217`) run 44436794149 stopped at step 1 with **502 `internal` (ref fb5a691e)** - cause NOT established, tracked in #5370 (read the logs from an Actions runner). No tenant was created in either run.

**2026-11-19 later: #5370 FIXED live; G1 steps 1-2 PASS.** The 502 was the CP's own `internal` envelope, and it had three stacked causes:
1. MCAPSGovDeployPolicies `CosmosDB_PublicNetwork_Modify` forces the CP registry Cosmos to PNA Disabled, and there was no PE. Fixed by #5372 (`f7d379fec`): hub PE default, same-subscription. Deployed by deploy-health 44451270732.
2. The running CP kept the public path after the PE appeared. A revision restart cleared it; #5375 makes the app dependsOn the PE.
3. `CosmosCollection.list` did a single `fetchNext` + `.slice` on undefined. Fixed by #5375 (`379dc6484`); image `sha256:1fe5ec99` was rolled by a revision restart, and the 30 s sweep has been clean since.

G1 run 44468120431: step 1 (`GET /api/health/tenants` 200) PASS; step 2 (the item is created and the editor opens clean) PASS; step 3 timed out with NO ARM create (proven with Resource Graph `resourcechanges`, positive-controlled).

**2026-11-19/20: #5377 FIXED live (closed).**
- #5379 (`a3b6dd256`): the CP self-registers its stamp (`stamp.self_register outcome=healthy`).
- #5381 (`844274754`): Contributor plus a conditioned RBAC Admin on the stamp RG, read back from ARM.
- #5383 (`97969de0f`): one tenant-slug cap of 20.
- #5384 (`d37065aa3`) and #5386 (`cdee15a7`): the CP names the shape of a refused ARM response.

All are deployed on Commercial dev01. The ACR build of `loom-health-cp` succeeded in 44659268695, and revision `--0000010` was restarted at 02:33Z.

**2026-11-20 later: create path deployed and verified on Commercial dev01; G1 steps 1-3 PASS.**
- #5395 (`3555396d7`): `tenant.bicep` dependsOn edges (role grants + capacity alert waited on nothing, so every create failed ResourceNotFound). LIVE: tenant deployment `lhds-tenant-g1-202611200813` Succeeded.
- #5394 (`73e26d5ed`): bounded retry + fingerprint for a non-ARM 403. LIVE: three poll 403s each recovered, `tenant.create` job.succeeded. #5380's 403 is a Microsoft edge page (title `Microsoft`, `x-msedge-ref` Ref A/B/C), not ARM authz and not the CP identity.
- #5397 (`5aac755d4`): G1 step 3 finalises the binding the way the editor does.
- #5398 (`fe0d0d2bf`): destroy retains the immutable audit account and crypto-shreds its key (OPERATOR DECISION 2026-11-20 on #5392), deletes both PEs, waits (8 min, under the job lease) for an in-flight create.
- Rolled by ACR build 44750962061 + restart of `--0000010` at 14:21Z. G1 run 44753035218: steps 1-3 PASS (create + bind in 2.2 min; the editor shows bound/active, 10 resources read back). Destroy LIVE: only the retained audit account remains for `g1-202611201425`.

**2026-11-20 evening: G1 PASSES ALL 5 STEPS live (run 44834983661, Commercial dev01).** Deployed and verified: #5403 (`9e89ccb88`, bounded shred read-back poll; ACR build 44824452462 + restart of `--0000010` at 22:07Z; #5392 closed) and #5402 (`000b2f294`, the dead html/body 768px gutter deleted, G1 step 4 measures page + `<main>` overflow with real-shell controls; console marker `000b2f294`; #5399 closed). Operator decision on #5399 (re-asked after a review disproved my first premise): delete the floor, 768px stays the smallest supported width. GCC-High not exercised (W1b-5).

**2026-11-21: #5405 FIXED, deployed and verified (closed).** #5408 (`fc879a6de`) added `lhds-tenant-destroy.yml`, which is dispatch-only, runs on the in-VNet `loom-aca` runner as the deploy SP, and takes the control plane URL and audience from the estate. Runs:
- `g1-202611200813`: 44864121793 succeeded.
- `g1-202611201425`: 44864602393 succeeded.
- `g1-202611200452` (the #5392 leak): 44864829582 failed closed with `destroy_incomplete`, because no pixel account remained. 44865134938 then succeeded with `allow_missing_storage`, after ARM showed 0 `sthpx*` accounts.

Every key reads `live=false` with a deletedDate. An independent ARM read-back shows only the retained audit accounts. I removed the #5379 orphan Reader (CP UAMI on the stamp RG) and read it back: Contributor plus the conditioned RBAC Admin remain. Left alone: `id-lhds-tls-script-xpmsal`, a #5355 leftover outside the operator's release.

**Owed, in order (W1b-2/-3), updated 2026-11-21 (#5410):** the issuer and token minting are live (see the W1b-2 row). Next: Inferno (W1b-3) against the Front Door issuer; L3 APIM edge wiring after apim-WA (cp.json `apim` key, an empty-path `lhds-edge` API that includes the fragment, the APIM identity HealthCP.Reader + allowlist), then `gh workflow run lhds-edge-probe.yml -f mode=probe -f edge_base_url=<apim gateway>`.

Follow-ups: #5314, #5324, #5328, #5373, #5396, #5401, #5404, #5406. | 2026-11-20 |
| W1b-5 GCC-High: Trivy+cosign gate then deploy-health via Actions | todo | | sonnet | #4584, #5123 | 2026-11-14 |
