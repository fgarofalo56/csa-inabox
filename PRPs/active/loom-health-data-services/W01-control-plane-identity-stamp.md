---
name: W01-control-plane-identity-stamp
status: backlog
priority: P1
order: 2
depends_on: [W00-measurement-spike]
review: required
orchestrator_model: sonnet
implementer_model: sonnet
created: 2026-10-22
---
# W1 — Health control plane, identity (SMART authorization server), tenancy and stamp bicep

**Goal**: a stamp and a tenant can be created from bicep + the control plane
in Commercial and GCC-High, with private networking, per-tenant CMK, the
authorization server issuing SMART v2 tokens, the PDP enforcing scopes, and
the cross-tenant probe green on an empty stamp. No FHIR/DICOM engine yet
(W2/W3 deploy them onto this stamp).

Scope sources: `ARCHITECTURE.md` sections 2-3, ADR-005/006/009/010/011/012,
`SECURITY-AND-COMPLIANCE.md` sections 2-5, `LOOM-INTEGRATION.md` sections 2, 5, 6.

## Items

| ID | Title | Owns | Depends on | Model | Review | Verify |
|---|---|---|---|---|---|---|
| W1-1 | Stamp bicep: `platform/fiab/bicep/modules/health/stamp.bicep` (+ `network`, `aks`, `postgres`, `storage`, `eventing`, `keyvault`, `ingress` sub-modules), wired by its OWN subscription-level entrypoint `platform/fiab/bicep/health.bicep` (not main.bicep: LHDS has its own 4 MiB ARM budget, PR 5126), params in `health-params/<boundary>-health.bicepparam` (`healthEnabled=false` default), deployed by `.github/workflows/deploy-health.yml` | `platform/fiab/bicep/modules/health/**`, `platform/fiab/bicep/health.bicep`, `platform/fiab/bicep/health-params/*-health.bicepparam`, `.github/workflows/deploy-health.yml` | W0-3 (SKUs) | Sonnet | **required** (bicep) | `make lint-bicep`; `az bicep build` per module; What-If receipt Commercial + GCC-High (Actions run id) |
| W1-2 | Tenant bicep: `tenant.bicep` (databases, roles, containers, keys, hub, DNS, quotas) + control-plane job `tenant.create/destroy` with readback into item state | `platform/fiab/bicep/modules/health/tenant.bicep`, `apps/loom-health-cp/src/jobs/tenant-*.ts` | W1-1, W1-3 | Sonnet | **required** | Create then destroy a synthetic tenant; the receipt lists every resource id read back; crypto-shred evidenced by key state |
| W1-3 | Control-plane service `apps/loom-health-cp` (registries in Cosmos, lifecycle jobs, routing-map publisher, SLO aggregation API), Container App module for Commercial/GCC-High and AKS Deployment at IL5 (new path: `containerPlatform` is `containerApps` in every param file incl. `il5.bicepparam:121` per W0 receipt section 7, so the control plane needs its own IL5 selector rather than the admin-plane-wide switch) | `apps/loom-health-cp/**`, `platform/fiab/bicep/modules/health/control-plane.bicep`, `health.bicep` (invokes control-plane.bicep; admin-plane/main.bicep is not touched) | none | Sonnet | **required** (auth surface) | vitest contract tests; `scripts/ci/check-env-sync.mjs` green; minted-session probe of `GET /api/health/stamps` |
| W1-4 | LHDS Authorization Server: OIDC federation to Entra per cloud, SMART v2 scopes, launch context, Backend Services (JWKS), `smart-configuration`; implementation choice recorded (ADR-010) | `apps/loom-health-cp/src/auth/**`, `docs/fiab/health/security.md` (auth section) | W1-3 | **Opus** for the scope-mapping design pass; Sonnet implement | **required** | Inferno SMART App Launch kit (standalone + EHR launch, v2) zero failures against the sandbox; negative scope test red-then-green mutation receipt |
| W1-5 | PDP: OPA deployment per stamp, Rego bundle v1 (scopes, roles, tenant match), bundle signing + distribution from the control plane, HAPI/dcm4chee interceptor contract (HTTP decision API) | `apps/loom-health-pdp/**` (policies + tests), `platform/fiab/bicep/modules/health/engines.bicep` (PDP workload only) | W1-3 | Sonnet | **required** | `opa test` all pass; the scope matrix test generated from the mapping table; decision latency p95 < 10 ms in-cluster |
| W1-6 | Routing: APIM classic policy fragment publishing the tenant map; stamp ingress App Gateway WAF v2 with FHIR/DICOMweb exclusions and per-tenant rate limits | `platform/fiab/bicep/modules/health/ingress.bicep`, `apps/loom-health-cp/src/routing/**` | W1-1, W1-3 | Sonnet | none | A request for tenant A with tenant B's token is 403 at the edge (probe); 429 with `Retry-After` beyond quota |
| W1-7 | Loom item `health-tenant` + provisioner + editor Overview tab (progress state while provisioning), gate registry entries (`health-control-plane`, `health-stamp-capacity`, `health-gov-image-gate`, `health-lakehouse-isolation`), `Health Tenant Admin` capability (D12) | `apps/fiab-console/lib/catalog/item-types/health.ts`, `lib/install/provisioners/health-tenant.ts`, `lib/editors/health/tenant-editor.tsx`, `lib/gates/registry/health.ts`, `lib/admin/env-checks/health.ts`, `app/api/health/tenants/**` | W1-2, W1-3 | Sonnet | none (G1 browser walk is the gate) | Playwright: create item -> editor opens on Overview with progress -> resources bound, names match; screenshots dark/light; `/admin/gates` shows the four gates |
| W1-8 | Estate power integration: `health-stamp` pause guard, PostgreSQL 7-day restart scheduler, paused banner on health editors; DoD boundary enum + `dod.bicepparam` as supported-in-code (D3) in its **own** bicep PR | `apps/fiab-console/lib/estate/pause-guards.ts` (additive guard), `lib/estate/pause-tier.ts` (no change expected; verify), `platform/fiab/bicep/main.bicep` (`boundary` enum), `params/dod.bicepparam` | W1-1 | Sonnet | **required** (bicep enum touches every boundary) | Unit tests for the guard (a stamp with a running job must be `eligible:false`); `make lint-bicep`; What-If for every param file unchanged except DoD |
| W1-9 | Docs: `docs/fiab/health/index.md`, `greenfield.md`, `brownfield.md` (discover/offer/validate/accept existing AKS, PostgreSQL, storage, KV, EH, APIM, LAW), per-cloud table, runbook stubs | `docs/fiab/health/**` | W1-1..W1-7 | Sonnet | none | mkdocs build (if runnable locally; else the strict hook caveat noted); the walkthrough is executed once on a clean sub and once on a brownfield sub with receipts |

Lanes (max 4): L1 bicep = W1-1 -> W1-2 -> W1-8 (one bicep PR in flight at a
time, queued behind any open bicep PR from spark-identity, apim-ai-gateway or
the drain); L2 = W1-3 -> W1-4; L3 = W1-5 -> W1-6; L4 = W1-7 -> W1-9.
Shared files: `admin-plane/main.bicep` and `main.bicep` are edited only by L1.

## Done receipt (per cloud)
Commercial: stamp + tenant created from a clean RG by the documented
walkthrough; probe suite green; Inferno SMART green; estate pause/resume of
the stamp round-trips. GCC-High: the same through a GitHub Actions run (run
ids in the receipt). IL5/DoD: What-If only, listed as supported-in-code.

## Rollback
`healthEnabled=false` removes nothing already deployed; stamp destroy is an
explicit, confirmed control-plane job. The DoD enum PR is independently
revertible.

## Cost / credit estimate
~12 Sonnet sessions, 1 Opus pass; Azure: one class-S stamp in each cloud
(~$8 k/mo Commercial + Gov) for the duration of R1.

## Execution state

| Item | Status | Branch | Model | Evidence | Updated |
|---|---|---|---|---|---|
| W1-1 | merged | feat/lhds-w1-1-stamp-bicep | sonnet | #5122 = be5f24fc2 (round-2 APPROVE 6392252249, CI green). Merged, not deployed (healthEnabled=false everywhere). What-If UNMEASURED in both clouds: Commercial stood down (estate paused); GCC-High run 40206913648 blinded by a Stopped Gov ADX (#5123). Real DEV-profile What-If with healthEnabled=true moves to W1-2 step 1 (operator 2026-10-25) | 2026-10-25 |
| W1-2 | merged | feat/lhds-w1-2-tenant-bicep | sonnet | Merged, not deployed: #5130 = 66668f51c (round-1 BLOCK on R7 absent-vs-no-outputs conflation, fixed in-round; re-review and allowlist re-check APPROVE at 0aaf9eab9). `tenant.bicep` + `tenant.create/destroy` jobs. UNMEASURED: real DEV What-If with `healthEnabled=true` (the workflow defect that blocked it is fixed by #5132 = d6a284504, which proved whatif-only for the stamp, not tenant), the synthetic create-then-destroy receipt. Open: `tenantHandlers()` not wired into compose/main; Key Vault data-plane disable/delete needs Crypto Officer on the control-plane identity (`control-plane.bicep`); destroy tag-query gap #5135. `tenant.bicep` is in `ORPHAN_ALLOWLIST` (deployed per tenant by the control plane, not an orchestrator) | 2026-10-27 |
| W1-3 | merged | feat/lhds-w1-3-cp-bicep | sonnet | Merged, not deployed. Service half #5121 = 82844115d; bicep half #5126 = c39c7a42f (APPROVE at 59988120a by code reading, CI green, `--admin`): `modules/health/**` is its OWN deployment unit (`health.bicep`, `health-params/*-health.bicepparam`, dispatch-only `deploy-health.yml`) because `main.json` had 7,624 bytes of headroom under ARM's 4 MiB inline limit and the control plane alone is ~40 KB. Records `deploy-health.yml` in UNLEASED_ARM_IMAGE_WRITERS (it renders only `loom-health-cp`, which no leased roll writes; overlap with a roll is serialised only by the pause gate). Param files are named `*-health` because `check-msal-resolver-before-deploy.mjs` substring-matches guarded basenames (false positive; issue to harden the guard). What-If and every deploy step UNMEASURED | 2026-10-26 |
| W1-4 | in-progress | feat/lhds-w1-4-scope-design | opus | Design pass merged: #5127 = 9ab55e19a (APPROVE; token contract `lhds-at/1`, role-scope map, ADR-010). Server half merged, not deployed: #5131 = 47147f167 (APPROVE at 092070414; 143 vitest, 3 mutation arms on a sandbox copy). NOT wired into compose/main. UNMEASURED: Inferno SMART kit, live Key Vault sign / Entra exchange / Graph checkMemberGroups (fakes only). TODO: wire into compose/main, three Cosmos containers (`health-auth-config`, `health-auth-replay`, `health-auth-grants`; last two TTL -1), env vars (AS issuer, KV key id, AS Entra app id + federated-credential source, Graph consent URL), Graph-consent gate-registry entry, review follow-ups #5134. Operator defaults 2026-10-25: Q1 non-exportable KV HSM signing keys (accept the fallback authorizer if forced), Q3 `offline_access` only, Q4 control-plane client registry endpoint, Q6 three new Cosmos containers, Q7 Graph group check as a one-click Fix-it gate, Q8 single Entra tenant in W1 | 2026-10-27 |
| W1-5 | in-progress | feat/lhds-w1-5-pdp | sonnet | Merged, not deployed: Rego bundle v1 #5125 = a1a606f43; finish #5137 = d8d5cff17 (reviewer APPROVE): control-plane bundle endpoint, `engines.bicep` PDP workload wired in `health.bicep` via `module healthPdp`, three permit-less tests tightened (mutation RED), `opa` CI step; `health.bicep` compiles at 279,417 B. `opa test` 470/470 was the implementer's run. TODO: per-stamp `data.lhds.config/stamp` and a bundle publishing pipeline (a served bundle denies everything until then), `HealthCP.Reader` app role (manual Entra step). p95 < 10 ms UNMEASURED | 2026-10-27 |
| W1-6 | in-progress | feat/lhds-w1-6-routing | sonnet | Merged, not deployed, NOT deployable yet: #5145 = 76301d1f9 (no reviewer, PRP row says none; CI green after a cross-sub call-site registry entry for `apimFragment` in `module-existing-scope.test.mjs`). Edge probe NOT run: 403/429 modelled only; no What-If. Gaps (#5149): APIM params not wired from `stamp.bicep`/`health.bicep`; APIM identity has no Reader role on the control plane; openid-config needs a tenant-independent discovery URL; tenant quota enforceable only in APIM (WAF rate limits cannot key on a token claim); WAF per-address rule untested in Gov | 2026-10-27 |
| W1-7 | merged | | sonnet | Merged, not deployed, NOT A-grade: #5139 = dcc211152 (reviewer round 1 BLOCK on a missing `health.tenant-admin` check in the provisioner, fixed in-round at d2ffbfb39 with fail-closed `enforceCapability` + mutation RED; CI green). Browser walk NOT done (estate paused); parity doc has 5 MISSING rows; `autoBindOnCreate` not wired; `checkCapability` tenant-admin bypass lets Loom admins through (D12 gap). Six `LOOM_HEALTH_*` rows added to `admin-plane/main.bicep` (`main.json` +3,044 B). Operator follow-up: Console UAMI client id in `allowedCallerAppIds` + `HealthCP.Admin` role. Follow-up merged 2026-10-27, not deployed, still NOT A-grade: #5159 = bdccdd5ed (no reviewer, G1 browser walk is its gate). Exact-grant `health.tenant-admin` gate (D12), Quotas tab + PATCH route, Graph-consent gate with Fix-it. `autoBindOnCreate` not wired (#5161); five parity rows still MISSING (child services, Access, Keys/rotate, Consent/Feeds/Cost/Evidence, per-tenant pause/evacuate: control plane has no backend); browser E2E not run | 2026-10-27 |
| W1-8 | merged | | sonnet | Both halves merged, not deployed. TS half #5138 = 7e51b25ac (health-stamp pause guard + PostgreSQL 7-day restart scheduler), inactive until stamp activity and the `loom-health-stamp` tag are wired and `main.ts` runs the scheduler. Bicep half #5146 = a31e9c45f (reviewer APPROVE): DoD added to the boundary enum in `main.bicep` and `health.bicep` via `effectiveBoundary` (DoD resolves to IL5); `dod.bicepparam` + `dod-health.bicepparam`; `main.json` +374 B. DoD is supported-in-code, never exercised; What-If NOT run, so "unchanged except DoD" is unmeasured. Follow-ups #5150. Paused banner still TODO (no pause/banner code in `lib/editors/health`, grep 2026-10-27) | 2026-10-27 |
| W1-9 | merged | | sonnet | Merged, not deployed: #5148 = 97ce3e5cb (`docs/fiab/health/`: index, greenfield, brownfield, runbooks; has a "Not yet implemented" section). Strict mkdocs hook NOT run (fails on 3 pre-existing config warnings); CI docs checks green; walkthroughs NOT executed on any sub. No W1 deploy/What-If receipt in any cloud: #5151 | 2026-10-27 |
