# Compliance and standards — source list used by SECURITY-AND-COMPLIANCE.md

Compiled 2026-10-22. These are the canonical public URLs for the standards
cited in the design mapping. **Not fetched in this planning session** (the
session's fetch budget went to the Azure Government, AHDS, engine, scale and
terminology research); each is a well-known canonical location and must be
re-verified by W12 when the per-control mapping is produced. Nothing in this
file is a claim of certification or authorization.

| Standard / document | URL | Used for |
|---|---|---|
| HIPAA Security Rule, 45 CFR Part 164 Subpart C (164.308-164.316) | https://www.ecfr.gov/current/title-45/subtitle-A/subchapter-C/part-164/subpart-C | Section 11 mapping; 164.316(b)(2) six-year documentation retention |
| HIPAA Privacy Rule accounting of disclosures, 45 CFR 164.528 | https://www.ecfr.gov/current/title-45/section-164.528 | Audit-by-patient surface |
| HHS de-identification guidance (Safe Harbor 18 identifiers, Expert Determination) | https://www.hhs.gov/hipaa/for-professionals/special-topics/de-identification/index.html | ADR-015, section 9 |
| 42 CFR Part 2 (current text) | https://www.ecfr.gov/current/title-42/chapter-I/subchapter-A/part-2 | Section 7, 13 |
| HHS fact sheet, 42 CFR Part 2 final rule (2024) | https://www.hhs.gov/hipaa/for-professionals/regulatory-initiatives/fact-sheet-42-cfr-part-2-final-rule/index.html | Consent alignment, redisclosure notice |
| NIST SP 800-53 Rev. 5 (update 1) | https://csrc.nist.gov/pubs/sp/800/53/r5/upd1/final | Section 12 families |
| FedRAMP baselines | https://www.fedramp.gov/ | High baseline reference |
| HITRUST CSF | https://hitrustalliance.net/ | Section 14 (control ids require the licensed CSF text — UNVERIFIED) |
| VA publications (Handbook 6500 and related directives) | https://www.va.gov/vapubs/ | Section 15 (current edition UNVERIFIED) |
| HL7 FHIR R4 security labels | https://hl7.org/fhir/security-labels.html | Labels, PDP |
| HL7 FHIR R4 Consent | https://hl7.org/fhir/consent.html | Consent model |
| HL7 FHIR R4 AuditEvent | https://hl7.org/fhir/auditevent.html | Audit |
| IHE Basic Audit Log Patterns (BALP) | https://profiles.ihe.net/ITI/BALP/ | AuditEvent profile (adoption decision in W8) |
| SMART App Launch (STU 2.2) and Backend Services | https://hl7.org/fhir/smart-app-launch/ , https://hl7.org/fhir/smart-app-launch/backend-services.html | ADR-010 |
| HL7 Bulk Data Access IG | https://hl7.org/fhir/uv/bulkdata/ | `$export` |
| US Core IG | https://hl7.org/fhir/us/core/ | Profiles, Inferno |
| HL7 v3 ActReason (purpose of use incl. BTG) | http://terminology.hl7.org/CodeSystem/v3-ActReason | Break-glass purpose code |
| RFC 8693 OAuth 2.0 Token Exchange | https://www.rfc-editor.org/rfc/rfc8693 | Delegation semantics |
| DICOM PS3.15 Annex E (de-identification profiles) | https://dicom.nema.org/medical/dicom/current/output/chtml/part15/chapter_E.html | DICOM de-id |
| DICOM PS3.18 (web services) | https://dicom.nema.org/medical/dicom/current/output/chtml/part18/PS3.18.html | DICOMweb conformance |
| Azure Storage CMK, infrastructure encryption, immutable storage; PostgreSQL data encryption | https://learn.microsoft.com/en-us/azure/storage/common/customer-managed-keys-overview , https://learn.microsoft.com/en-us/azure/storage/common/infrastructure-encryption-enable , https://learn.microsoft.com/en-us/azure/storage/blobs/immutable-storage-overview , https://learn.microsoft.com/en-us/azure/postgresql/flexible-server/concepts-data-encryption | Section 4, 6 (the immutable-storage and PostgreSQL pages were fetched in `terminology-conformance-ops-facts.md` section C) |
| Azure Government identity planning | https://learn.microsoft.com/en-us/azure/azure-government/documentation-government-plan-identity | Section 2 |
