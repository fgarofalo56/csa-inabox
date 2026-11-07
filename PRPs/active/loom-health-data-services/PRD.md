# LHDS — Product Requirements Document

| Field | Value |
|---|---|
| Product | Loom Health Data Services (LHDS), a capability of CSA Loom |
| Status | DRAFT, design complete; W0 may start (`W00-measurement-spike.md`) |
| Created | 2026-10-22 |
| Decision source | Operator mandate 2026-10-22 (verbatim in `README.md`); operator decisions 1-8 (engines, boundaries, sequencing, stamps, legacy ingest, analytics, terminology, compliance) are fixed inputs |
| Boundaries | Commercial and GCC-High with receipts; IL5 and DoD supported-in-code via configuration; GCC supported-in-code only, never exercised (`cloud-parity.md`) |
| Related rules | all of `.claude/rules/*.md`; how each is met: `PRP.md` section 8 |

## 1. Problem

Health organisations in Azure Government have no managed FHIR/DICOM platform:
Azure Health Data Services is Commercial-only and the Gov-scoped Azure API for
FHIR was deprecated 2026-09-30 (`AZURE-GOV-AVAILABILITY.md`). The largest
candidates — all of VA (7.7 M patients treated/yr, ~1 B images/yr) and all of
IHS (2.8 M population, ~430 RPMS sites) — are mid-modernisation and need a
standards-based data platform (FHIR R4, DICOMweb, Bulk Data, SMART) that also
feeds analytics. Commercial regulated customers want the same platform without
a Fabric or AHDS dependency. Loom already has the surrounding platform
(identity, lakehouse, catalog, Copilot, governance, estate operations); the
missing piece is the clinical data services layer, built to scale by stamps.

## 2. Personas and scenarios

| Persona | Scenario (what "working" looks like) | Primary surfaces |
|---|---|---|
| VA clinician (via a SMART app or the Loom viewer) | Opens a patient from a SMART app launched in context; sees problems, meds, labs, imaging studies across the VISN's facilities in under a second; break-glass available with a reason when consent blocks a record | SMART App Launch, FHIR search, viewer |
| Radiologist | Worklist from UPS-RS; opens a CT in OHIF, scrolls 1,000 slices smoothly; prior studies from another VISN found via MPI; archived priors show an honest rehydration ETA | DICOMweb, viewer, MPI |
| IHS facility administrator | Creates a `health-tenant` for the Area in Loom; the stamp resources, keys, DNS and quotas are provisioned automatically; connects the RPMS HL7 v2 feed; watches ingest lag and conversion errors in the editor; loads SNOMED under the Area's licence | Loom editors, converter, terminology loader |
| Researcher / analyst | Requests a de-identified group export; queries Silver Delta tables in Loom (SQL, semantic model, Copilot) with Part 2 data excluded by policy; receives a k-anonymity report for Expert Determination | `$export`, de-id, lakehouse sink, Copilot |
| Integrator / app developer | Registers a backend-services client (JWKS), runs Inferno against the tenant's base URL, uses the AHDS-shaped change feed and `$convert-data` | Authorization server, docs, conformance |
| Security officer / ISSO | Pulls the evidence pack: role/scope inventory, isolation probe, audit-chain report, CMK inventory, network scan, SBOMs, DR drill; reviews break-glass events; verifies the Part 2 redisclosure path | Admin surfaces, evidence pack |
| Loom operator (platform) | Adds a stamp, moves a tenant, pauses a sandbox stamp, upgrades an engine blue/green, reads the per-cloud status table | Control plane, estate power, admin |

## 3. Capability inventory (v1 unless marked)

| Area | Capabilities | Source of truth |
|---|---|---|
| FHIR | R4 US Core; full REST incl. transactions, conditional ops, history, versioning policy; curated search + custom params with Fix-it reindex; `$everything`, `$validate`, `$export`, `$import`, `$convert-data`, bulk delete/update; subscriptions (topic-based, later wave D27) | `AHDS-MODEL-MAP.md` section 1 |
| DICOM | DICOMweb STOW/QIDO/WADO-RS, UPS-RS, change feed, extended query tags, partitions, export, bulk update, DICOM->FHIR `ImagingStudy`; DIMSE off by default | section 2 |
| Terminology | CodeSystem/ValueSet/ConceptMap, `$lookup`, `$validate-code`, `$expand`, `$translate`; bundled free vocabularies; customer-loaded SNOMED/full RxNorm/CPT | ADR-013 |
| Conversion | HL7 v2 (MLLP/REST), C-CDA, JSON templates; template versioning; VistA and RPMS adapter specs (documents) | ADR-014 |
| Analytics | Bulk Data export, de-identification (FHIR, DICOM, text), continuous Delta sink, Copilot read-only tools | ADR-015, ADR-016 |
| Identity & access | Entra per cloud, SMART v2 scopes, backend services, role model mirroring AHDS, break-glass, consent/labels PDP, audit | ADR-010, ADR-011 |
| Platform | Stamps, control plane, MPI, per-tenant CMK, private network, pause/resume, blue/green upgrades, BCDR, quotas | ADR-005..009, ADR-012 |
| Product | `health-tenant`, `health-fhir-service`, `health-dicom-service`, `health-terminology`, `health-conversion-pipeline`, `health-deid-job`, `health-lakehouse-sink`, `health-imaging-viewer` item types with editors; gates; Copilot; parity docs; greenfield + brownfield docs | `LOOM-INTEGRATION.md` |
| Device ingest | MedTech-model mapper (later wave) | ADR-018 |

## 4. Non-goals (v1)

- Being an EHR: no order entry, no clinical decision support, no scheduling UI.
- Replacing VistA/RPMS/Oracle Health: LHDS ingests from and serves alongside them.
- Probabilistic patient matching (deterministic MPI only until evidenced, D11).
- Full-text search inside the FHIR store (D20); OMOP (D25); AI inference on
  images (D22); DIMSE PACS roles (modality worklist over DIMSE, C-FIND to
  external PACS) — DICOMweb only in v1, DIMSE gateway later.
- Any claim of authorization, certification or HIPAA "compliance".
- Fabric or AHDS dependency, anywhere.

## 5. Requirements (binding)

R1. Every capability ships in Commercial and GCC-High with a receipt; IL5/DoD
are param sets (`cloud-parity.md`).
R2. Creating a Loom health item provisions and binds its backing resources with
no user plumbing (`auto-bind-by-default.md`); names match the item.
R3. No surface ships that is not functional end-to-end against real Azure
(`no-vaporware.md`); honest gates only where the platform genuinely cannot act,
each with Fix-it and a registry entry (`ux-baseline.md` G2).
R4. Tenant isolation is provable by the probe suite on every release.
R5. PHI never appears in logs, traces, prompts or events (sentinel test).
R6. SLO targets in `OPERATIONS-AND-BCDR.md` section 1 are measured in W11 and
published per stamp.
R7. Scale to all VA / all IHS is demonstrated by arithmetic in
`CAPACITY-MODEL.md` and by the 1-to-3-stamp scale-out test (W11), with the
first VA-scale stamp class M proven at the 1 M-patient cohort (W7).
R8. Every deploy path (stamp create, tenant create, upgrade, evacuation) has
greenfield and brownfield walkthroughs that agree with the wizard
(`deploy-integrity.md` R4/R5/R8).
R9. The evidence pack in `SECURITY-AND-COMPLIANCE.md` section 16 is
generatable from the platform.

## 6. Success metrics

| Metric | Target | Measured by |
|---|---|---|
| Inferno US Core + SMART + Bulk Data | 0 failures on the pinned kit versions | W2/W6 receipts |
| DICOMweb suite + viewer smoke | 0 failures; pixel hash parity 100 % | W3 receipt |
| L1 load at 1 M patients on class M | p95 within targets; error rate < 0.1 % | W7 receipt |
| Scale-out linearity (1 -> 3 stamps) | aggregate within 10 % of linear | W11 receipt |
| Isolation probe | 0 cross-tenant bytes | every release |
| Log-scrub sentinel | 0 hits | every release |
| Time from `health-tenant` create to first successful FHIR write | <= 30 min (stamp exists) / <= 3 h (new stamp) | W1/W9 receipt |
| HL7 v2 ingest lag p95 | <= 5 s | W5 receipt |
| Per-cloud parity table | every row Commercial + GCC-High with run ids | `ARCHITECTURE.md` section 6 |
| Evidence pack | generated in < 1 h, reviewed by one ISSO persona walk | W12 receipt |

## 7. Release plan

| Release | Waves | What a customer can do |
|---|---|---|
| R0 Spike (no product code) | W0 | Engine decision receipts, Gov availability closed |
| R1 Foundations | W1, W2, W3 (parallel tracks) | Create a tenant; FHIR R4 with SMART; DICOMweb store/query/retrieve; Commercial + GCC-High |
| R2 Clinical data in | W4, W5 | Terminology; HL7 v2 / C-CDA feeds; VistA/RPMS specs |
| R3 Data out | W6, W7 | Bulk export, de-id, lakehouse + Copilot; VA-class performance proven |
| R4 Governed | W8, W9 | Consent/segmentation, audit surfaces, editors, viewer, parity docs |
| R5 Scale & assurance | W10, W11, W12 | Device ingest; DR, evacuation, N stamps; evidence pack |

Sequencing honours operator decision 3: FHIR core (W2) is first-to-ship and
DICOM (W3) runs as a parallel track from wave 1.

## 8. Open decisions

`RISKS-AND-OPEN-DECISIONS.md` (D1-D27 with recommended defaults; execution
proceeds on the defaults).
