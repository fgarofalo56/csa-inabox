# Loom Health Data Services (LHDS) — PRD + PRP set

**Status (2026-10-22): DRAFT, design complete, docs only.** No product code
exists. W0 (measurement spike) may start in a fresh session; every later wave
waits for W0's receipt or runs on the recommended defaults.

**Public repo rules**: no PHI, no secrets, no real patient data, synthetic data
only (Synthea, public CC-BY DICOM sets, synthetic DICOM), never a credential
anywhere.

## Operator mandate (verbatim intent)

Build "Loom Health Data Services" from scratch on standard Azure services. It
must not rely on or be tied to Azure Health Data Services (AHDS), because AHDS
is not available in Azure Government. It runs in Azure Government for Loom Gov
(GCC-High, designed for IL5) and in Azure Commercial for Loom Commercial, with
the same capabilities in both. AHDS documentation is a model only; standards
are HL7 FHIR and DICOM. Open source may be used where it helps. It must scale
to the largest imaginable customer: all of VA or all of IHS facilities.

Operator decisions already made (fixed inputs, not re-litigated): engines are
proven OSS chosen by evidence with an ADR and a fallback; Commercial and
GCC-High ship with per-cloud receipts and IL5/DoD are configuration; FHIR
core first-to-ship with DICOM as a parallel track; cell-based stamps with a
shared control plane; HL7 v2 + C-CDA conversion with VistA/RPMS adapter specs;
Bulk Data + de-identification + lakehouse sink in v1; bundled free
vocabularies with customer-loaded SNOMED/UMLS content; compliance mapped
(HIPAA, NIST 800-53 High, 42 CFR Part 2, HITRUST, VA 6500/IHS) and never
claimed as certification.

## Reading order

1. `PRD.md` — problem, personas, capabilities, non-goals, metrics, releases.
2. `ARCHITECTURE.md` — the map; then `adr/ADR-001` .. `ADR-018`.
3. `AHDS-MODEL-MAP.md` — every AHDS capability -> LHDS equivalent -> wave.
4. `AZURE-GOV-AVAILABILITY.md` — service matrix, gaps, substitutes.
5. `CAPACITY-MODEL.md` — all-VA / all-IHS arithmetic, stamp sizing, cost OOM.
6. `SECURITY-AND-COMPLIANCE.md` — threat model, control mappings, evidence list.
7. `OPERATIONS-AND-BCDR.md`, `TEST-STRATEGY.md`, `LOOM-INTEGRATION.md`.
8. `RISKS-AND-OPEN-DECISIONS.md` — D1-D27 with defaults, Q1-Q10 for the operator.
9. `PRP.md` — master PRP; then the wave files `W00-*.md` .. `W12-*.md`.
10. `research/` — cited source notes per topic (URLs, retrieval dates, UNVERIFIED tags).

## Headline decisions

| Topic | Decision | Where |
|---|---|---|
| FHIR engine | HAPI FHIR JPA (Apache-2.0); fallback Medplum (Apache-2.0); Microsoft fhir-server rejected (no PostgreSQL) | ADR-001 |
| DICOM engine | dcm4chee-arc-light (MPL-1.1 / LGPL-2.1 use); fallback Orthanc isolated (GPLv3 + AGPLv3 plugins) or a Loom DICOMweb-on-Blob service modelled on the archived MIT microsoft/dicom-server | ADR-002 |
| Persistence | PostgreSQL Flexible Server, one database per tenant, HAPI partition mode from creation; Blob (flat namespace) per tenant for pixels | ADR-003, ADR-004 |
| Compute | AKS in every cloud (Container Apps has no IL4/IL5 scope in Gov) | ADR-009 |
| Scale | Stamps per VISN / IHS Area group; control plane with MPI and routing; all VA ~18 class-M stamps, all IHS ~4 | ADR-005, `CAPACITY-MODEL.md` |
| Identity | Entra per cloud + LHDS SMART v2 authorization server; OPA PDP per stamp | ADR-010, ADR-011 |
| Gov gaps | AHDS absent; Citus absent; managed Redis retiring; APIM v2 absent; Front Door partial; Chaos Studio absent -> substitutes in `AZURE-GOV-AVAILABILITY.md` section 2 | — |

## How to run a wave

1. Fresh session, Sonnet (`MASTER-INDEX.md` cost rules). Read this README,
   `PRP.md`, the wave file, and the ADRs the wave names.
2. `python -S -E C:/Users/fgaro/.claude/kits/orchestrated-prp/prp_index.py status W0x-... --root .`
   for the item board; `next` picks the eligible wave.
3. Work items inside their declared file ownership; lanes <= 4; one bicep PR
   in flight across programs.
4. Done = the verify command's receipt per cloud (Gov via GitHub Actions run
   id, never local `az`), mutation evidence where a test claims to catch a
   defect, Execution state table updated, PR open, CI green; report anything
   merged but not rolled as "merged, not deployed".
5. End the session per `session-end.md`; leftovers become issues.

## Index tooling note

`prp_index.py` reads PRP directories exactly one level deep, so the wave files
sit beside `PRP.md` (named `W00-` .. `W12-`) rather than in a `waves/`
subfolder, which the tool would silently ignore. `PRPs/INDEX.md` is generated
by `prp_index.py build` and checked by `check`; this README carries no
frontmatter on purpose (a `README.md` with frontmatter would be read as a
second PRP named after the directory).

## What this pass could not verify

`RISKS-AND-OPEN-DECISIONS.md` section 4 (Gov regional GA per service, Gov
region pairing, PostgreSQL SSD v2/v5 SKUs in Gov, Event Hubs Premium in Gov,
Managed HSM Gov audit row, AHDS SLA at primary source, several VA/IHS volume
figures, two licence texts, "no calls home" beyond documentation). W0 closes
them with receipts.
