# LHDS — AHDS feature inventory mapped to Loom Health Data Services

Azure Health Data Services is the **model**, never a dependency: it is absent
from Azure Government (`AZURE-GOV-AVAILABILITY.md`), and the only Gov-scoped
Microsoft FHIR offering (Azure API for FHIR) was deprecated 2026-09-30. Every
AHDS fact below is cited in `research/ahds-feature-inventory.md` (retrieved
2026-10-22; Learn pages fetched directly). Columns: AHDS capability -> LHDS
equivalent -> decision (**Adopt** the OSS engine's native feature, **Build**
Loom code, **Run** an OSS component as-is, **Defer** with a decision id) ->
wave.

## 1. FHIR service

| AHDS capability (cited) | LHDS equivalent | Decision | Wave |
|---|---|---|---|
| FHIR R4 4.0.1 (+ STU3); no R4B/R5 | R4 4.0.1 only in v1; R5 is an HAPI config option evaluated later (D23) | Adopt | W2 |
| REST: read/vread/update (If-Match 412)/patch (JSON + FHIRPath)/history/create/conditional ops/search (chained, reverse-chained)/batch/transaction/paging | HAPI native; conditional ops guarded per ADR-003 | Adopt | W2 |
| Request body 28 MB; bundle 500 entries; parallel bundle header | Gateway caps: body 32 MB, bundle 500 (tenant-tunable), parallel bundle processing is HAPI config | Build (gateway) + Adopt | W2 |
| Storage 4 TB default / 100 TB max per instance | Per-tenant database up to 20 TB working set; more via partition/stamp split | Build (control plane) | W1/W3 |
| No published RPS; autoscale on resource pressure | KEDA autoscale on concurrency/CPU; per-tenant quotas with 429 + `Retry-After` | Build | W1/W7 |
| Search: types, modifiers, `_include/_revinclude` (1,000 cap), `_count` max 1,000, `_total`, `_sort` single field, `_has`, `_not-referenced` | HAPI search with the curated parameter set (ADR-008); same caps; `_not-referenced` not in v1 (D24) | Adopt + Build (caps) | W2/W7 |
| Custom search parameters + `$reindex` + `$status`; selectable search params; `maximumNumberOfResourcesPerWrite` | HAPI custom `SearchParameter` + `$reindex`; LHDS adds the status/selectable semantics as a control-plane migration with measured cost and Fix-it | Adopt + Build | W7 |
| `$export` (system/patient/group; `_since _till _type _typeFilter`; ~5,000 resources/file; ADLS Gen2 destination; managed identity) | Bulk Data IG `$export` from HAPI plus LHDS parallel export workers reading replicas; destination = tenant Blob/ADLS with managed identity; same parameters | Adopt + Build | W6 |
| De-identified `$export` (Tools-for-Health-Data-Anonymization config in container/ACR) | Same tool, same config shape (`anonymizationConfig.json`), run by the de-id job (ADR-015) | Run + Build | W6 |
| `$import` (InitialLoad/IncrementalLoad; 10,000 files; preserves `lastUpdated/versionId`; soft-delete extension) | Bulk import worker over ndjson in Blob -> HAPI batch API with referential-integrity relaxation and a post-import report; `IncrementalLoad` semantics via `If-Match`/versioned updates; initial-load mode = write-blocking tenant flag | Build | W6 |
| `$convert-data` (HL7 v2, C-CDA, JSON, STU3->R4; Liquid; templates in ACR) | FHIR-Converter container, templates as OCI artifacts in the stamp ACR (ADR-014) | Run + Build | W5 |
| `$validate` + profile validation on write (`x-ms-profile-validation`) | HAPI validation with US Core packages loaded; per-tenant "validate on write" flag | Adopt | W2 |
| `$patient-everything` (100 devices, `seealso` one level, `_type _since start end`) | HAPI `$everything` with LHDS async mode above 10 k resources; `seealso` handling via MPI | Adopt + Build | W2/W6 |
| `$member-match` | HAPI operation via MPI-backed matcher (deterministic) | Build | W11 |
| `$purge-history`, `$bulk-delete`, `$bulk-update` (one job at a time) | HAPI `$expunge` for purge (admin-only, audited); bulk delete/update as LHDS jobs with the AHDS parameter shapes | Adopt + Build | W7 |
| Versioning policy (`versioned`/`version-update`/`no-version`, per-type override; `_meta-history`) | HAPI per-type history config exposed as tenant policy | Adopt | W2 |
| SMART v1/v2; SMART User = read/search; `$export` needs `system/` scopes; Entra needs an orchestration layer | LHDS Authorization Server (ADR-010): v2 scopes (v1 compatibility flag), same role shape | Build | W1 |
| Data-plane RBAC roles (FHIR Data Reader/Writer/Exporter/Contributor/Converter/Importer/Bulk Operator/SMART User/Search Parameter Manager; DICOM Data Owner/Reader) | Same role names as Loom roles mapped to scope bundles in the PDP | Build | W1 |
| Audit logs (`MicrosoftHealthcareApisAuditLogs` fields) | `AuditEvent` per operation + Log Analytics table `LhdsAudit_CL` with the same field set, immutable chain | Build | W2/W8 |
| Event Grid events (6 types, no backfill) | Outbox -> Event Hubs; the same six event names exposed as the change feed and optional Event Grid publish (Event Grid is in Gov scope) | Build | W6 |
| CMK (RSA 2048/3072, Key Vault, purge protection, lost key -> 500) | Per-tenant CMK (ADR-012); lost key -> 503 with truthful reason | Build | W1 |
| Private Link at workspace level; two DNS zones | Private endpoints for every stamp service; private ingress only | Build (bicep) | W1 |
| Managed identity for export/import/ACR/CMK | Stamp UAMI + per-job federated identities | Build | W1 |
| Hostname `<ws>-<svc>.fhir.azurehealthcareapis.com` | `https://<tenant>.health.<loom-domain>/fhir` (per cloud) | Build | W1 |

## 2. DICOM service

| AHDS capability (cited) | LHDS equivalent | Decision | Wave |
|---|---|---|---|
| URL-versioned API (v1, v2), OpenAPI | dcm4chee DICOMweb behind an LHDS gateway that exposes `/v1` paths with the AHDS shape where they differ | Adopt + Build | W3 |
| STOW-RS (explicit VR only; 4 GB/request; PUT upsert) | dcm4chee STOW; gateway cap 4 GB, streaming | Adopt | W3 |
| WADO-RS incl. `/metadata`, `/rendered`, frames, transcoding list | dcm4chee WADO (transcoding via dcm4che codecs); supported syntaxes recorded in the conformance doc | Adopt | W3 |
| QIDO-RS (`limit` 1-200, fuzzy PatientName, `includefield`) | dcm4chee QIDO; gateway enforces the same caps | Adopt | W3 |
| UPS-RS worklist (limit 1-4,000) | dcm4chee UPS-RS | Adopt | W3 |
| Delete (non-standard, not recoverable) | Soft delete + 30-day retention + purge job (safer than the model) | Build | W3 |
| Change feed (`/changefeed`, `/latest`, v2 time window, limit 1-200) | LHDS change-feed endpoint over the outbox with the same parameters | Build | W3/W6 |
| Extended query tags (128 max; VR list; async reindex) | dcm4chee custom query attributes + LHDS registration API with the same lifecycle statuses | Adopt + Build | W3 |
| Export (`POST /export`, blob destination, managed identity) | LHDS export job to tenant Blob with the same output layout | Build | W6 |
| Data partitions (creation-time, `/partitions/{name}`) | Partition = facility within a tenant (dcm4chee archive AE / institution); same URI segment | Adopt + Build | W3 |
| Bulk update (50 studies/op, originals retained) | dcm4chee patient/study update + LHDS job wrapper | Adopt + Build | W7 |
| BYO ADLS layout `AHDS/{ws}/dicom/{svc}/{partition}` | Tenant Blob container layout (ADR-004) — flat namespace, not ADLS HNS (object replication) | Build | W3 |
| "Petabytes / thousands of studies daily" | Capacity model: ~1 PB/yr stored for all VA; per-stamp 300 GB/day class M | Build | W11 |
| DICOMcast (DICOM -> FHIR `ImagingStudy`) | LHDS consumer of the outbox writes `ImagingStudy` (+ `Endpoint`) per study | Build | W6 |
| RBAC DICOM Data Owner / Reader | Same roles in the PDP | Build | W1 |

## 3. MedTech (deprecated in AHDS; model only)

| AHDS capability | LHDS equivalent | Decision | Wave |
|---|---|---|---|
| Event Hubs / IoT Hub ingest -> normalize (device mapping) -> group (period 0/60/1440) -> transform (FHIR destination mapping) -> `Observation` | LHDS device mapper with the same template grammar (ADR-018) | Build | W10 |

## 4. De-identification service

| AHDS capability | LHDS equivalent | Decision | Wave |
|---|---|---|---|
| `Tag` / `Redact` / `Surrogate`; sync 50 KB; batch jobs over Blob; 27 entity types incl. the 18 HIPAA identifiers; consistent surrogation | Presidio + Tools-for-Health-Data-Anonymization jobs (ADR-015); same operation names, same entity taxonomy, same caps as defaults | Run + Build | W6 |
| Per-MB pricing | Loom cost attribution per job (tags) | Build | W6 |

## 5. Analytics

| AHDS capability | LHDS equivalent | Decision | Wave |
|---|---|---|---|
| FHIR -> Synapse sync agent / Parquet (archived OSS) | Outbox-driven sink to Loom Delta lakehouse (ADR-016), FHIR-to-Parquet schema conventions as the model | Build | W6 |
| DICOM metadata -> Delta via change feed (ADF template) | Same sink writes `dicom_*` tables | Build | W6 |
| Fabric healthcare data solutions (bronze/silver/gold, OMOP, export) | Loom lakehouse medallion + OMOP as a later wave (D25); UX reference only; no Fabric dependency | Defer | — |

## 6. Platform / portal

| AHDS capability | LHDS equivalent | Decision | Wave |
|---|---|---|---|
| Workspace (3-24 chars) holding services; cannot move region | `health-tenant` item (workspace-scoped) holding `health-fhir-service`, `health-dicom-service`, `health-terminology` children; region fixed by stamp | Build | W9 |
| Portal blades: Networking, IAM, Versioning policy, Encryption (CMK), Identity, Artifacts (ACR templates), Diagnostics, Metrics; DICOM partitions at create | Loom editors with the same tab set + Loom-native extras (stamp, quotas, consent policy, pause state) — parity docs per `ui-parity.md` | Build | W9 |
| Pricing dimensions (storage, API calls per 100 k, transformations, de-id, transcode, export, events) | Cost attribution tags per dimension; admin cost view | Build | W11 |
| SLA (UNVERIFIED at primary source) | `OPERATIONS-AND-BCDR.md` TARGET SLOs, measured in W11 | Build | W11 |
| Regions: Commercial only | Commercial + GCC-High (receipts), IL5/DoD config | Build | all |

## 7. What LHDS adds beyond the model

Stamps and a control plane; MPI; consent/segmentation PDP; terminology service
with bundled vocabularies; immutable audit chain; viewer; conversion MLLP path
and agency adapter specs; Loom lakehouse sink with Copilot; estate pause
integration; per-cloud parity receipts.

## Related
`research/ahds-feature-inventory.md`, `ARCHITECTURE.md`, `adr/`, `PRD.md`.
