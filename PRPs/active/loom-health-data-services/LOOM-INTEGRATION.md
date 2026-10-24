# LHDS — Loom product integration: item types, editors, Copilot, gates, bicep, docs, parity

Measured against `origin/main` at `2f7694b0e` (2026-10-22). Paths under
`apps/fiab-console/` unless stated. Line numbers drift; re-verify before editing.

## 1. Item types (catalog entries in `lib/catalog/item-types/*`, registered through `FABRIC_ITEM_TYPES` in `lib/catalog/fabric-item-types.ts:65`)

| Slug | Category (new: `Health data`) | Backing resources provisioned on create (auto-bind) | Editor surface | Parity reference |
|---|---|---|---|---|
| `health-tenant` | Health data | Tenant on a stamp: PostgreSQL databases (FHIR, DICOM meta, audit index), Blob containers, per-tenant keys, Event Hubs hub, DNS names, quotas, PDP bundle, role assignments; stamp created if none fits (class from a picker with a recommended default) | Overview (stamp, region, status, pause state), Services tab, Access (roles -> scopes), Keys, Quotas, Consent policy, Feeds, Cost, Evidence | AHDS workspace blade |
| `health-fhir-service` | Health data | Child of a tenant: engine configuration (versioning policy, validation on write, search parameter set), base URL, SMART configuration | Overview, Capability statement, Search parameters (with Fix-it reindex), Versioning policy, Operations (export/import/bulk jobs), Audit, Metrics | AHDS FHIR service blade; Fabric healthcare data solutions (UX reference only) |
| `health-dicom-service` | Health data | Child: partitions, extended query tags, storage tiering policy, export destination | Overview, Partitions, Extended query tags, Change feed, Export jobs, Storage tiers, Audit, Metrics | AHDS DICOM service blade |
| `health-terminology` | Health data | Child: bundled package versions pinned; customer package loader (licence-gated) | Packages, Loader, `$expand`/`$validate-code` tester, Notices | HAPI terminology / AHDS n/a |
| `health-conversion-pipeline` | Health data | Child: template set version, MLLP endpoint (private), queue, dead-letter | Templates (versioned editor), Endpoints, Monitor (lag, errors, reprocess), Fixtures tester | AHDS `$convert-data` + Fabric pipeline-style monitor |
| `health-deid-job` | Health data | Job definition: profile, source, destination, schedule | Profile editor (Safe Harbor / Expert Determination), Runs, Reports (k-anonymity) | AHDS de-identification |
| `health-lakehouse-sink` | Health data | Sink binding to a Loom `lakehouse` item in the same workspace; registers Silver tables in Loom Unity | Mapping (resource types -> tables), Watermark/lag, Backfill, Policy (labeled data) | AHDS analytics connector / Fabric HDS |
| `health-imaging-viewer` | Health data | Viewer config bound to a DICOM service | Study list (QIDO), Viewer (OHIF), Series browser | OHIF |

All eight are first-class in the catalog with `backingStore` populated once the
governance-autopilot W2 field lands (that PRP adds `backingStore`; LHDS adds
rows, it does not redefine the field). Provisioners live in
`lib/install/provisioners/health-*.ts` following `types.ts` (structured
result: live resource ids or a remediation envelope with a `gateId`).

Provision-and-bind flow for `health-tenant` (the acceptance receipt per
`auto-bind-by-default.md`): create item -> control-plane job `tenant.create`
-> bicep `tenant.bicep` deployment on the chosen stamp (or `stamp.bicep` first)
-> readback of every resource id into `state.binding` with the sanitized-name
map -> editor opens on the real Overview with a progress state while the job
runs; never a "bind me first" form.

## 2. BFF routes (`app/api/health/**`, built with `lib/api/route-toolkit.ts` HOFs: `withCapability`, `withWorkspaceOwner`)

| Route | Purpose | Auth |
|---|---|---|
| `GET/POST /api/health/tenants`, `/[id]` | Tenant registry CRUD (control plane proxy) | `health.tenant-admin` capability |
| `POST /api/health/tenants/[id]/actions/{pause,resume,evacuate,rotate-keys}` | Lifecycle jobs | tenant admin + confirm |
| `GET /api/health/stamps`, `/[id]` | Stamp registry, SLO state, capacity | Loom admin |
| `ANY /api/health/[tenant]/fhir/*`, `/dicomweb/*`, `/terminology/*` | BFF proxy to the stamp (session cookie -> SMART token via the authorization server; used by editors and the viewer) | session + PDP |
| `GET /api/health/[tenant]/jobs`, `POST .../jobs` | Export, import, de-id, backfill, reindex jobs | roles per job |
| `GET /api/health/[tenant]/audit` | AuditEvent search (patient accounting of disclosures) | audit reader |
| `GET /api/health/gates` | Health gate evaluation (registry) | admin |

Every route: validates session, returns `{ok, data, error}` with proper status,
is covered by `scripts/ci/check-route-guards.mjs` and the route inventory;
credentials never in routes (`check-credential-route-authz.mjs`).

## 3. Copilot tools (`lib/copilot/health-tools.ts`, registered in `LoomToolRegistry`, `lib/azure/copilot-orchestrator.ts:409`)

Read-only first, governance-aware (every call runs through the PDP with the
user's own scopes; results carry counts, ids and codes, never narrative PHI):

| Tool | Returns | Guard |
|---|---|---|
| `health_tenant_status` | stamp, status, lag, SLO state, quotas | tenant visibility |
| `health_fhir_search_count` | `_total` for a bounded search (no bodies) | PDP + scope |
| `health_patient_summary_codes` | coded problem/med/allergy lists (codes + display), no free text | PDP + consent |
| `health_imaging_study_search` | QIDO study list (UIDs, modality, dates) | PDP |
| `health_export_status`, `health_job_status` | job states | role |
| `health_terminology_lookup` | `$lookup`/`$validate-code` | none (no PHI) |
| `health_lakehouse_query` | delegates to the existing lakehouse SQL tool against Silver tables, policy-filtered | existing lakehouse guard |
| `health_list_gates` | health gates | admin |

Write tools (`health_create_tenant`, `health_start_export`) come after W9 with
the `confirm:false` first-call pattern, `emitAuditEvent` on every call, and
rate limits — the same contract the governance-autopilot PRP section 5.8 sets.

## 4. Gates (G2) — `lib/gates/registry/health.ts` + `lib/admin/env-checks/health.ts`

| Gate id | Required | Fix-it | Auto |
|---|---|---|---|
| `health-control-plane` | `LOOM_HEALTH_CP_URL` | resource-picker (deployed by bicep) | deploy |
| `health-stamp-capacity` | a stamp with headroom for the tenant class | wizard: create stamp (bicep) | platform action, never a message |
| `health-terminology-licensed` | customer package for SNOMED/CPT/full RxNorm | wizard: upload package + licence attestation | genuine licence gate (allowed, disclosed) |
| `health-lakehouse-isolation` | Private lakehouse-isolation advisory fix deployed on the estate | n/a — blocks sink enablement until the fix is live (truthful) | platform |
| `health-gov-image-gate` | Trivy + cosign on the Gov image lane (#4584) | n/a — blocks Gov stamp rollout until present | platform |
| `health-entra-patient-access` | External ID / B2B configuration for patient apps | wizard (tenant consent flow) | tenant-level consent (allowed) |

Gates follow `docs/fiab/gate-registry.md` (ENV_CHECKS-derived, GATE_META,
`/admin/gates`, `loom_list_gates`). Zero day-one gates for the clinician,
radiologist and researcher personas: only the admin sees the two genuine ones.

## 5. Bicep (`platform/fiab/bicep/modules/health/**`, new; wiring in `admin-plane/main.bicep` env list)

| Module | Deploys |
|---|---|
| `stamp.bicep` | RG, VNet/subnets (or spoke to the hub), private DNS, AKS (private, zones, KEDA, workload identity, Defender), PostgreSQL Flexible Server (HA, replicas, CMK), Blob accounts (audit immutable, export staging), Event Hubs namespace, Service Bus, Key Vault, Log Analytics, App Gateway WAF v2, Azure Firewall rules, identities, diagnostic settings, tags |
| `tenant.bicep` | Databases, roles, Blob containers (pixel, per tenant), keys, hub, quotas record, DNS names, role assignments |
| `engines.bicep` (+ Helm values as artifacts) | AKS workloads via the existing GitOps/Helm path used by `loom-trino-aks.bicep` |
| `control-plane.bicep` | `loom-health-cp` Container App (Commercial/GCC-High) or AKS Deployment (IL5), Cosmos containers, MPI PostgreSQL |
| `params/*.bicepparam` additions | `healthEnabled`, `healthStampClass`, `healthPrimaryRegion`, `healthAlternateRegion`, `healthManagedHsm`, `healthIsolatedNodes` (IL5) — every boundary file, including `il5.bicepparam`; DoD once the enum exists (D3) |

Bicep rules: one bicep PR in flight at a time across programs (MASTER-INDEX
collision rule); every new env var is in the `apps[]` env list and passes
`scripts/ci/check-env-sync.mjs` and `check-bicepparam-env-reaches-deploy.mjs`;
every role assignment is in the resource's module; no `|| true`,
`continue-on-error` or `2>/dev/null` in deploy steps (`deploy-integrity.md`).

## 6. Estate power

Stamps register with the pause framework: AKS clusters are already in
`ESTATE_PAUSE_TIER` (`lib/estate/pause-tier.ts`); LHDS adds a `health-stamp`
guard analogous to `containerAppPauseGuard` (`pause-guards.ts:76`) that refuses
to pause a stamp with running jobs or active feeds and that schedules the
PostgreSQL restart before the 7-day auto-restart (`OPERATIONS-AND-BCDR.md`
section 10). Production stamps are tagged `loom-health-tier=production` and
excluded from auto-pause by default (D18).

## 7. Docs (`docs/fiab/health/**`, mkdocs nav added only when the docs build runs locally)

`index.md` (what it is, per-cloud status table copied from `ARCHITECTURE.md`
section 6), `greenfield.md` and `brownfield.md` (separate complete
walkthroughs; brownfield discovers and offers existing AKS, PostgreSQL,
storage accounts, Key Vault, Event Hubs, APIM, Log Analytics per
`deploy-integrity.md` R5, validates SKU/region/network/RBAC, accepts supplied
values), `tenant-onboarding.md`, `feeds-hl7v2.md`, `terminology.md`,
`export-and-deid.md`, `viewer.md`, `security.md` (links the evidence pack),
`runbooks/*.md`, `parity/health-*.md` (one per item type, `ui-parity.md`
format: inventory, coverage built/gate/missing, backend per control).

## 8. UX requirements (ux-baseline §7, web3-ui)

Every editor: PageShell, Fluent v9 + Loom tokens, SplitPane with `sizingKey`
for the viewer and query panes (G3), EmptyState launchers, badges with
`flexWrap`, clean first-open, LearnPopovers on every tab, a Copilot entry,
screenshots dark/light, narrow-width pass, Playwright `pnpm uat` spec, parity
doc with zero missing rows before "A".

## 9. CI additions

`tests/health/**` (contract + isolation probe + log-scrub sentinel) in the fast
suite; conformance and load are nightly workflows (`health-conformance.yml`,
`health-load.yml`) with Commercial jobs on the pool and a GCC-High job via the
existing Gov workflow identity (receipts by run id). The 45-min CI budget is
respected by keeping engine tests out of PR CI.
