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
| W1-1 | todo | | sonnet | | 2026-10-22 |
| W1-2 | todo | | sonnet | | 2026-10-22 |
| W1-3 | todo | | sonnet | | 2026-10-22 |
| W1-4 | todo | | opus | | 2026-10-22 |
| W1-5 | todo | | sonnet | | 2026-10-22 |
| W1-6 | todo | | sonnet | | 2026-10-22 |
| W1-7 | todo | | sonnet | | 2026-10-22 |
| W1-8 | todo | | sonnet | | 2026-10-22 |
| W1-9 | todo | | sonnet | | 2026-10-22 |
