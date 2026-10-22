# ADR-018 — Device ingest (MedTech model) and engine upgrade policy

Status: Proposed. Date: 2026-10-22. Evidence: `../research/ahds-feature-inventory.md` section 3 (MedTech deprecated 2025-05-03, support ends 2028-05-03; `iomt-fhir` archived, MIT), `../OPERATIONS-AND-BCDR.md` section 7.

## Device ingest (W10, later wave)
- Model: the AHDS MedTech grammar (device mapping template: JSON path
  expressions extracting `deviceId`, `patientId`, `timestamp`, values; FHIR
  destination mapping: `Observation` code, components, period grouping) is
  re-implemented by an LHDS mapper worker consuming Event Hubs / IoT Hub
  (IoT Hub Gov availability per `../AZURE-GOV-AVAILABILITY.md`; if absent,
  Event Hubs direct).
- Reference code: `microsoft/iomt-fhir` (MIT, archived) as the design source
  for the normalisation/grouping stages; re-implemented in the converter
  codebase rather than forked wholesale (archived .NET service, no upkeep).
- Output: `Device`, `Patient` link resolution via MPI, `Observation` with
  `device` reference; dedupe by (device, timestamp, code).

## Engine upgrade policy
- Pinned versions per stamp; weekly upstream watch job files an issue with the
  changelog and CVE delta (dcm4chee's 2026-10 CISA advisory is the model).
- Blue/green per stamp with canary tenants where the schema migration is
  backward-compatible (HAPI documents its migrations; dcm4chee publishes
  per-version DB update scripts); otherwise a maintenance window with a PITR
  restore point and a rehearsal on a restored copy.
- Gate to promote: SLO canaries green for 30 min, conformance smoke green,
  log-scrub sentinel green.
- Contributions upstream: fixes to engines are submitted upstream (both
  projects accept contributions) and carried as patches in the image build
  until merged; the patch list is part of the image SBOM.

## Reversal cost
Low.
