# ADR-017 — Imaging viewer: OHIF + Cornerstone3D behind the Loom BFF

Status: Proposed. Date: 2026-10-22. Evidence: `../research/oss-engine-evaluation.md` (OHIF, Cornerstone3D MIT).

## Decision
- OHIF Viewer (MIT) built in the image pool with a Loom extension (theme
  tokens, Loom header, patient banner from FHIR, measurement save to FHIR
  `ImagingStudy`/`Observation` later), served by the stamp's viewer BFF; the
  DICOMweb data source points at the tenant's LHDS DICOMweb base via the Loom
  BFF proxy so the SMART token travels in the `Authorization` header (never
  in URLs) and every WADO call is audited.
- Rendering: Cornerstone3D (MIT), progressive loading, HTJ2K decode when the
  stored transfer syntax allows (D16 for ingest transcoding).
- Loom surfaces: a `health-imaging-viewer` item editor (study list via QIDO,
  viewer pane, series browser) meeting `ux-baseline.md` (SplitPane, EmptyState,
  honest archive-rehydration state), and a Copilot read-only tool
  (`health_imaging_study_search`).
- Not in v1: Weasis / desktop DIMSE viewers; AI inference overlays (D22).

## Options rejected
Stone of Orthanc (GPL), commercial viewers.

## Reversal cost
Low.
