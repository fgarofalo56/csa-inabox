# ADR-014 — Conversion service: HL7 v2 and C-CDA to FHIR (microsoft/FHIR-Converter), VistA/RPMS adapter specs

Status: Proposed. Date: 2026-10-22. Evidence: `../research/ahds-feature-inventory.md` section 1 (`$convert-data`), `../research/oss-engine-evaluation.md` (FHIR-Converter MIT, active).

## Decision
- Engine: **microsoft/FHIR-Converter** (MIT; Liquid templates for HL7 v2,
  C-CDA, JSON, FHIR STU3->R4), run as the converter Deployment per stamp with
  templates stored in the stamp's ACR as OCI artifacts (the `$convert-data`
  model) and versioned per tenant.
- Surfaces: `POST /{tenant}/fhir/$convert-data` (sync, AHDS parameter shape);
  an MLLP listener (TLS only, inside the customer's private connectivity —
  ExpressRoute/VPN to the stamp VNet) feeding a Service Bus queue; a REST
  ingest for batches; a C-CDA document ingest that also stores the source
  document as a `DocumentReference` (`Binary` in Blob).
- Pipeline: receive -> persist raw (PHI retention class) -> convert -> validate
  (HL7 validator, US Core) -> enrich (terminology `$translate`, patient
  identity resolution via MPI) -> transaction bundle to the FHIR engine ->
  `Provenance` with template version and source message id -> ack. Failures
  dead-letter with the OperationOutcome; a reprocess UI exists (W5).
- **VistA and RPMS adapter specs** (documents only, W5): VistA HL7 v2
  interfaces (ADT, ORU, ORM, MDM, SIU, PPR) and the VistA FHIR/RPC options
  (the public VistA documentation at https://www.va.gov/vdl/ ), RPMS
  (MUMPS-based, VistA-derived) HL7 v2 and its Ensemble interfaces (public IHS
  documentation). Each spec: message types, segment mappings to templates,
  identifier systems (ICN/DFN/HRN), ordering/lab/radiology/pharmacy/ problem
  list coverage, throughput assumptions, security (TLS, AE/facility
  authentication), and what cannot be verified without agency access
  (explicitly listed). No claim that the adapters work until an agency partner
  runs them.

## Options rejected
LinuxForHealth hl7v2-fhir-converter (Apache-2.0) — maintenance health weak
(research); hand-written mappers (unbounded scope).

## Consequences
Template quality drives data quality: the fixture suite (`../TEST-STRATEGY.md`
section 8) is the gate; templates are code with reviews.

## Reversal cost
Low (Liquid templates are portable to any Liquid engine).
