---
name: W02a-fhir-core-build
status: active
priority: P1
order: 4
depends_on: [W01b-close-deploy-receipts]
review: required
orchestrator_model: sonnet
implementer_model: sonnet
created: 2026-11-14
started: 2026-11-14
issues: [5233, 5241]
pr: 5290
branch: feat/lhds-w2a-fhir-build
allow_parallel: true
---
# W2a — FHIR core, build half: engine image, per-tenant config, PDP + audit interceptors, log scrubber

## Goal
HAPI FHIR JPA runs per tenant on a stamp with partition mode, the PDP interceptor (calls the W1-5 decision API) and the audit interceptor in the request path, and a
log scrubber proving no PHI reaches any sink. Operations half (outbox, curated search, item/editor, conformance) is `W02b-fhir-core-ops.md`. FHIR is first-to-ship (operator decision 3).

## Why
Everything FHIR-shaped (W4 terminology, W5 conversion, W6 export, W7 search) needs a running, authorized, audited engine. Authorization and PHI-free logs are the two
parts that cannot be retrofitted. Split from the old W02 because 8 items exceeded one session.

## Scope / Non-goals
Items W2-1 (image; merged, follow-ups only), W2-2, W2-3, W2-5. Non-goals: outbox/relay, search parameter set, item/editor, Inferno (all W02b); terminology (W04); DICOM.
GCC: supported-in-code, never exercised. IL5/DoD: params only. FHIR stays Azure-native, no Fabric/Power BI dependency (`no-fabric-dependency.md`).

## Acceptance criteria
- [ ] W2-1: image `loom-health-fhir` in the Commercial ACR with a cosign signature verifiable by digest, Trivy CRITICAL = 0; fails if `cosign verify` returns non-zero or Trivy reports one CRITICAL.
- [ ] W2-1 SBOM: either an SBOM artifact exists for the image digest, or `apps/loom-health-fhir/README.md` no longer claims one. Measured 2026-11-14: `build-fiab-images-acr-tasks.yml` has 0 SBOM steps while the README says "SBOM" (README line ~27), so today the claim fails.
- [ ] W2-2: 50 parallel conditional creates produce exactly 1 resource (fails at 2); RI fixtures reject a dangling reference both on create and on delete of a referenced target; a history read of N versions issues a bounded number of SQL statements (the N+1 test fails if statements scale with N).
- [ ] W2-3: scope-matrix test generated from `apps/loom-health-cp/src/auth/role-scope-map.v1.json`; N requests produce exactly N `AuditEvent`s; with the interceptor removed the cross-tenant probe returns 200 (the red arm) and with it present 403; a PDP timeout returns 503, never 200.
- [ ] W2-5: sentinel surname `ZZ-SENTINEL-LHDS` appears in no log line, trace attribute or metric label after create/read/search/delete/`$everything`; a positive control proves the sentinel IS visible when the scrubber is bypassed.
- [ ] On-stamp rows are claimed only with W01b's receipt; otherwise "merged, not deployed".

## Read first
`apps/loom-health-fhir/{Dockerfile,README.md,scripts/verify-image.sh,check/check-validator.sh,tests/image-contract.test.mjs,plugin/pom.xml,plugin/src/main/java/ai/loom/health/fhir/LoomPlugin.java}`;
`apps/loom-health-pdp/README.md` + `input-contract.json`; `CONTRACT-FREEZE-W2.md` (sections 1, 3); `adr/ADR-001`, `ADR-003`; `W0-RECEIPT.md` (HAPI pins); `scripts/measure/health/fhir-engine-*.sh` (W0 harness to reuse); `TEST-STRATEGY.md` section 3.

## Owns
`apps/loom-health-fhir/**`; `apps/loom-health-cp/src/jobs/fhir-tenant-*.ts` (new); `platform/fiab/bicep/modules/health/engines.bicep` (HAPI workload only); `apps/loom-health-scrubber/**`; `tests/health/log-scrub.test.ts`;
`apps/loom-health-pdp/input-contract.json` + Rego (W2-3 only, to confirm the PROVISIONAL fields; same PR as the interceptor).

## Must NOT touch
`apps/loom-health-cp/src/auth/**`, `src/routing/**`; `lib/copilot/health-tools.ts`, `lib/gates/registry/health.ts`, `lib/catalog/item-types/health.ts` (W02b); `apps/loom-health-dicom*`; `tenant.bicep` (W03a); `main.bicep`; other `.github/workflows` matrix rows.

## Consumes
PDP decision API (frozen, `CONTRACT-FREEZE-W2.md` section 1); `tenant.create` job + tenant Postgres DB from W1-2; deployed stamp from W01b (for on-stamp acceptance only); W0 pins for HAPI and `org.hl7.fhir.core`.

## Provides
A signed engine image, per-tenant engine config + `fhir-tenant.*` jobs, the interceptor pair, the scrubber, and the confirmed PDP input fields that W03a/W3-3 consume.

## Steps
1. W2-1 follow-ups (merged as #5290): add or remove the SBOM claim; confirm the image has been built and signed by a real workflow run (the matrix row exists, no run is recorded here); add a scrubber-free baseline.
2. W2-2 engine config + `engines.bicep` HAPI workload (one bicep PR, queued per INTERLOCK): partition mode, datasource/pool per tenant, versioning, validation-on-write, RI, caps.
3. W2-3 interceptors (Java plugin): PDP call, response filtering from the decision + scopes, `AuditEvent` per interaction to audit store and `LhdsAudit_CL`. Fail closed.
4. W2-5 scrubber sidecar + sentinel test; OTel without bodies; matrix row last.
Order: W2-1 follow-ups -> W2-2 and W2-5 in parallel (W2-5 only needs the image) -> W2-3 (needs the W2-2 config shape).

### Integration step (serialized)
- `.github/workflows/build-fiab-images-acr-tasks.yml`: add the `loom-health-scrubber` matrix row only, as the last commit of W2-5 (freeze order). Owner: `W01b-close-deploy-receipts` (in the `depends_on` chain).

## Validation
```bash
node --test apps/loom-health-fhir/tests/                                   # W2-1 static contract; fails if base digest and fhir-engine-deploy.sh disagree
sh apps/loom-health-fhir/scripts/verify-image.sh <acr>/loom-health-fhir:<sha>   # plugin load probe + validator with --network none
cosign verify --certificate-identity-regexp 'https://github.com/fgarofalo56/csa-inabox/.*' --certificate-oidc-issuer https://token.actions.githubusercontent.com <acr>/loom-health-fhir@<digest>
mvn -f apps/loom-health-fhir/plugin/pom.xml -q test                         # interceptor unit tests (scope matrix, audit count)
cd apps/loom-health-cp && npm test -- fhir-tenant                            # W2-2 job tests
az bicep build --file platform/fiab/bicep/health.bicep --stdout >/dev/null
node --test tests/health/log-scrub.test.ts   # or the vitest equivalent once the runner is chosen in W2-5; the choice is recorded in the PR
```
Mutation receipts on a sandbox copy (not the tracked tree): delete the PDP interceptor registration (probe must go red), delete the scrubber filter (sentinel test must go red); show both RED, then clean. Per-cloud: Commercial on-stamp receipt after W01b; GCC-High via Actions only, listed "not exercised" until a run exists. A merge is "merged, not deployed".

## Rollback
Scale the engine Deployment to 0; tenant databases retained; `LOOM_HEALTH_FHIR_ENABLED=false`. Scrubber and interceptors are image-level: revert the image tag.

## Docs to update
`apps/loom-health-fhir/README.md`, `docs/fiab/health/index.md` (per-cloud table), `ARCHITECTURE.md` section 6 run ids, `adr/ADR-001`, `ADR-003` status lines on measured values.

## Wave / Blocked-by / Branch / Worktree
Wave: 2 · Blocked-by: W01b-close-deploy-receipts (live verification; code work may start earlier) · Branch: feat/lhds-w2a-fhir-build · Worktree: E:/Repos/_lhds-w2a

## Hot files
`engines.bicep`, `health.bicep` (module wiring), `build-fiab-images-acr-tasks.yml` matrix (`DEFAULT_APPS` is one long line; row added last and rebased), `apps/loom-health-pdp/input-contract.json`. `touches_bicep: yes` (W2-2 only).
Bicep queue: see PRPs/reference/GLOBAL-SCHEDULE.md

## Kickoff prompt
Fresh session, Sonnet. Read `PRPs/active/loom-health-data-services/W02a-fhir-core-build.md`, `CONTRACT-FREEZE-W2.md`, `apps/loom-health-fhir/README.md` and `apps/loom-health-pdp/README.md`. W2-1 is merged (#5290; docs PR #5292).
Start with the SBOM claim vs `build-fiab-images-acr-tasks.yml`, then W2-2 and W2-5 in parallel worktrees (max 4 lanes). Review required on W2-2 and W2-3. Every test names the value that breaks it
(assertion-design). Proof of done: the Validation block, mutation receipts RED then green, and the W01b stamp receipt for on-stamp rows. Report merged vs deployed separately.

## Execution state

| Item | Status | Branch | Model | Evidence | Updated |
|---|---|---|---|---|---|
| W2-1 HAPI image + plugin skeleton + baked US Core | merged | feat/lhds-w2-1-hapi-image | sonnet | #5290 = ea1a38d72, merged, not deployed; docs #5292 open; SBOM + cosign UNVERIFIED | 2026-11-14 |
| W2-2 engine config per tenant | in-progress | feat/lhds-w2-2a-engine-config | sonnet | Split 2026-11-16. **W2-2a** (config + `fhir-tenant.*` jobs, no bicep) #5338 = `e80d46342`, merged, not deployed: 38 job tests; a local HAPI 8.12 + PG16 probe passed (50 parallel conditional creates gave 1, RI rejects 400/409, history SELECTs bounded); 7 job mutations RED; C6 is a disclosed blind arm for `conditional_create_duplicate_identifiers_enabled`. CodeQL #1436 dismissed by the operator as a false positive (sha256 over config naming a KV secret). **W2-2b re-planned 2026-11-21 (#5422; operator decisions there): it jumped the bicep slot ahead of apim-WA.**
- The CP drives the private stamp AKS through ARM runCommand. That runs kubectl as the CALLER (measured), so the CP holds an `edit` RoleBinding in `loom-health`.
- PostgreSQL is Entra-only, so HAPI uses per-tenant workload identity. The KV secret `t-<slug>-fhir-db` and the password role are DROPPED.
- The PDP comes first; the CP signs bundles with a non-exportable KV key; the PDP pulls through Front Door on `/api/health/pdp/*`.
- The stamp pulls images through a stamp private endpoint to the hub ACR.

**B1 (PDP delivery) is DEPLOYED and VERIFIED on Commercial dev01:**
- deploy-health run 45071967067 is green: `deployment "loom-health-pdp" successfully rolled out` (the deploy SP reads it through runCommand), with the CP-signed bundle from publish run 45048937825.
- PRs: #5423, #5425 (+ empty #5426), #5427, #5428, #5429, #5430, #5431, #5432. Follow-ups: #5424.
- The pdpUrl source is done (`LOOM_HEALTH_CP_PDP_URL`).

**B2 is merged, not deployed (2026-11-22).** Operator decisions 9-11 are on #5422. Each lane had one independent review, with should-fixes taken in the same round:
- **B2a** #5434 `f779423d0`: a dedicated per-tenant UAMI `id-lhds-<stamp>-<slug>-fhir` with a federated credential for `loom-health:fhir-<slug>` and no role assignment (decision 9). A stamp UAMI `id-lhds-<stamp>-pgadmin` is added as a PG Entra admin, plus the SA `lhds-pg-admin`. `tenant.destroy` deletes the fhir identity.
- **B2b** #5436 `70e0a92fd`: `application.yaml` COPY, plus azure-identity-extensions 1.3.1 (34 sha256-pinned jars). Link-probed offline against the war's reactor-core 3.7.19.
- **B2c** #5435 `48dcf74e0`: a runCommand client and the production `FhirEngineHost`. A PG principal Job runs `pgaadauth_create_principal_with_oid` (decision 10). The password role and KV secret are gone.
- **B2e** #5438 `070a6a3e0` (decision 11): the engine reconciles its own partitions in-process. HAPI's PDP interceptor 401s tokenless partition calls. The engine grants SELECT on `hfj_partition` only; the CP reads it back through the PG Job, and DB rows are authoritative for ids. Real HAPI 8.12 + PG16 probe passed.
- **B2d** #5437 `bdae9e020`: `LOOM_HEALTH_CP_FHIR_IMAGE` (tag) and `_PG_CLIENT_IMAGE` (digest) are set from bicep. deploy-health imports the PG client image and asserts `loom-health-fhir:<tag>` exists.

The loom-health-cp vitest suite is green locally (579). It runs in no CI (#5396). Follow-ups: #5439.

**B3 (live receipt) is DEPLOYED and VERIFIED on Commercial dev01 (2026-11-23).**
- Final chain: deploy-health 45253239164 (operator-dispatched with `override_estate_pause=true`; the estate has been paused since 2026-11-21), then bootstrap 45257740619, then CRUD probe 45264235830 with the operator's publish approval.
- **All 7 probe steps PASS:**
  - a: metadata 200;
  - b: no-token 401;
  - c: writer create 201;
  - d: read 200;
  - e: cross-tenant 403;
  - f_ctrl: reader search 200;
  - f: reader write 403 (scope).
- Cleanup: both synthetic tenants were destroyed and their keys crypto-shredded and read back; both engines and their roles were removed.
- Live-only defects fixed on the way, all deployed:
  - #5444: the engine pins its public base (decision 13);
  - #5445: the manifest reads the top-level `pgAdminIdentity`;
  - #5446: the AKS `clusterToken` is sent on runCommand;
  - #5447: no `sed` in the command pod;
  - #5448: poll a runCommand that az stopped waiting for;
  - #5449: the PDP url was the full decision endpoint and the plugin appended the path again, so every token-bearing request got a 503.
  - Together they are the lane-contract class: each side's stubs were green.
- The reactor-netty watch item (#5439) is answered live: the engine served the full CRUD path.
- GCC-High is NOT exercised (#5123). IL5 and DoD are supported-in-code only.

**2026-11-24: auto-bind and the engine NetworkPolicy are DEPLOYED and VERIFIED on Commercial dev01.**
- #5453 `1fca52d49` + #5457 `48ca82d65` (#5442): a new health tenant chains `fhir-tenant.create`, the console ensure self-heals a missing engine, and `tenant.destroy` tears the engine down first, with an `allowMissingEngine` escape hatch. Engine-affecting jobs are serialized per tenant.
- #5452 `5581e3348` (#5441): a NetworkPolicy beside each engine admits ingress on 8080 only from `aks-command` and kube-system `konnectivity-agent`. Egress is open (disclosed).
- The first live run found two lane-contract defects, both fixed by #5457:
  - the probe's own create raced the chained job, giving `readback_mismatch`;
  - an unpolled G1 destroy during an engine create leaked `g1-202611240229` (cleaned by run 45314307119; root cause unproven).
- Receipts:
  - CRUD probe 45319268679 7/7;
  - G1 45319272128 6/6;
  - `engine.probe ready=true` through the API-server proxy under the policy;
  - ARM read-back: 0 leftover tenant resources.
- NOT done: the negative cross-namespace NetworkPolicy check. #5458: the exclusion is in-process only and maxReplicas is 2.

Follow-ups: a reserved partition-name deny list; an ensureRole interruption test. | 2026-11-24 |
| W2-3 PDP + audit interceptors | merged | feat/lhds-w2-3-interceptors | sonnet | #5310 = `da67b2691`, merged, not deployed (wired into an engine only by W2-2). Two review rounds: an update-over-existing bypass was found and fixed, and the plugin CI lane `health-fhir-plugin-test.yml` was added (125 mvn tests). Built against the frozen contract ahead of W2-2; the assumptions are in the PR body. Follow-ups #5316, including the real-JPA hook receipt. 2026-11-16: #5337 = `ecc04ce52` merged, not deployed. Bundle.total is kept only for unconstrained wildcard read scopes. Audit gets a sink-failure counter + an alert, DSYNC, returned/hidden patient ids, and an XFF trusted only from `LOOM_HEALTH_TRUSTED_PROXIES`. The image-contract test is fixed. 138 mvn tests; 8 mutations RED. Remainders: typed `_getpages` is still denied; no real-OPA test yet (#5340). **Operator decision 2026-11-16: audit FAILS CLOSED before real PHI** (#5339); today it is fail-open + alerted, shipped in #5310. | 2026-11-17 |
| W2-5 log scrubber + sentinel | merged | feat/lhds-w2-5-scrubber | sonnet | #5312 = `ea0098278`, merged, not deployed. Real-HAPI capture fixture; the sentinel is visible unscrubbed in 4 channels and absent after scrubbing (22 tests). Image producer row added. The sidecar wiring beside the engine is NOT built (README). | 2026-11-15 |
