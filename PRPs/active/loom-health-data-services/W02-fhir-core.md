---
name: W02-fhir-core
status: backlog
priority: P1
order: 3
depends_on: [W01-control-plane-identity-stamp]
review: required
orchestrator_model: sonnet
implementer_model: sonnet
created: 2026-10-22
---
# W2 — FHIR core (first-to-ship)

**Goal**: FHIR R4 US Core service on a stamp: HAPI FHIR JPA per tenant with
partition mode, PDP interceptor, audit interceptor, outbox, log scrubber,
curated search set, Inferno US Core green, the `health-fhir-service` item and
editor, Commercial + GCC-High receipts. Operator decision 3: this is the
first-to-ship capability.

## Items

| ID | Title | Owns | Depends on | Model | Review | Verify |
|---|---|---|---|---|---|---|
| W2-1 | HAPI image build in the pool (pinned version from W0, Loom interceptors as a plugin jar, US Core packages baked, no runtime downloads), SBOM + cosign | `apps/loom-health-fhir/**` (Dockerfile, plugin), `.github/workflows/build-fiab-images-acr-tasks.yml` (matrix row only) | W0-7 | Sonnet | none | Image in ACR with signature; Trivy CRITICAL = 0; `java -jar validator_cli.jar` baked check |
| W2-2 | Engine config per tenant: partition mode at DB creation, per-tenant datasource/pool, read-replica routing (or documented limitation), versioning policy, validation-on-write flag, referential-integrity settings (ADR-003), `_count`/include caps, async `$everything` threshold | `apps/loom-health-fhir/config/**`, `apps/loom-health-cp/src/jobs/fhir-tenant-*.ts` | W2-1, W1-2 | Sonnet | **required** (data model: partition + RI settings are hard to reverse) | Concurrency test (50 parallel conditional creates -> 1 resource); RI both-ways fixtures; history N+1 test |
| W2-3 | PDP interceptor (HAPI `IAuthorizationInterceptor`-style hook calling the W1-5 decision API, response filtering, obligations) + audit interceptor (`AuditEvent` per interaction to the audit store + `LhdsAudit_CL`) | `apps/loom-health-fhir/plugin/src/**` | W2-1, W1-5 | Sonnet | **required** (authorization) | Scope matrix test; audit completeness test (N requests -> N events); mutation receipt: removing the interceptor turns the cross-tenant probe red |
| W2-4 | Outbox table + relay worker + Event Hubs publish (ADR-007); FHIR change feed endpoint (`_lastUpdated` + `seq`) | `apps/loom-health-fhir/plugin/src/outbox/**`, `apps/loom-health-cp/src/relay/**` | W2-2 | Sonnet | none | Gap-detection test (delete a row -> alert); N writes -> N events in order |
| W2-5 | Log scrubber sidecar + sentinel test; OTel traces without bodies | `apps/loom-health-scrubber/**`, `tests/health/log-scrub.test.ts` | W2-1 | Sonnet | none | Sentinel surname absent from every sink after every operation class |
| W2-6 | Curated search parameter set (ADR-008 v1) and index migrations; the honest "enable parameter" gate with Fix-it reindex | `apps/loom-health-fhir/config/search-params.json`, `apps/loom-health-cp/src/jobs/reindex-*.ts`, `apps/fiab-console/lib/gates/registry/health.ts` (one entry) | W2-2 | Sonnet | none | Advertised-vs-working test (every CapabilityStatement param changes a result set); reindex duration measured on the 100 k cohort |
| W2-7 | Loom item `health-fhir-service` + provisioner + editor (Overview, Capability statement, Search parameters, Versioning policy, Operations, Audit, Metrics), BFF proxy route, read-only Copilot tools `health_fhir_search_count`, `health_patient_summary_codes` | `apps/fiab-console/lib/install/provisioners/health-fhir-service.ts`, `lib/editors/health/fhir-service-editor.tsx`, `app/api/health/[tenant]/fhir/**`, `lib/copilot/health-tools.ts` (read tools), `docs/fiab/parity/health-fhir-service.md` | W2-2, W2-3 | Sonnet | none (G1 walk) | Playwright walk + screenshots + narrow-width + first-open; parity doc zero missing; minted-session probe shows `{ok:true,...}` from a real search |
| W2-8 | Conformance: Inferno US Core + SMART (with W1-4) + HL7 validator over the Synthea cohort; nightly `health-conformance.yml` (Commercial pool job + GCC-High Actions job) | `.github/workflows/health-conformance.yml`, `tests/health/conformance/**` | W2-2..W2-7 | Sonnet | **required** (new Gov job) | Inferno JSON reports with 0 fail attached; Gov run id |

Lanes: L1 = W2-1 -> W2-2 -> W2-6; L2 = W2-3 -> W2-4; L3 = W2-5 then W2-8;
L4 = W2-7 after W2-2's contract. Bicep: only `engines.bicep` (HAPI workload)
— one bicep PR, queued per the collision rule.

## Done receipt (per cloud)
Commercial: Inferno US Core + SMART 0 failures; L1 at the 100 k cohort within
targets on class S; sentinel 0; probe 0; editor G1 walk. GCC-High: the same
suite through Actions (run ids). Reported as "merged, not deployed" until the
stamp roll is verified from the control plane's deploy SHA.

## Rollback
Engine Deployment scaled to 0; tenant databases retained; item type hidden by
feature flag `LOOM_HEALTH_FHIR_ENABLED`.

## Cost / credit estimate
~14 Sonnet sessions; Azure: the R1 stamps.

## Execution state

| Item | Status | Branch | Model | Evidence | Updated |
|---|---|---|---|---|---|
| W2-1 | todo | | sonnet | | 2026-10-22 |
| W2-2 | todo | | sonnet | | 2026-10-22 |
| W2-3 | todo | | sonnet | | 2026-10-22 |
| W2-4 | todo | | sonnet | | 2026-10-22 |
| W2-5 | todo | | sonnet | | 2026-10-22 |
| W2-6 | todo | | sonnet | | 2026-10-22 |
| W2-7 | todo | | sonnet | | 2026-10-22 |
| W2-8 | todo | | sonnet | | 2026-10-22 |
