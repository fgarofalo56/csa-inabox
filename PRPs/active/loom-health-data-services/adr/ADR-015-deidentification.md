# ADR-015 — De-identification service

Status: Proposed. Date: 2026-10-22. Evidence: `../research/ahds-feature-inventory.md` section 4, `../research/oss-engine-evaluation.md` (anonymisation tools), HHS de-identification guidance (`../SECURITY-AND-COMPLIANCE.md` section 9).

## Decision
- Model: the AHDS de-identification service's operations (`tag`, `redact`,
  `surrogate`), batch jobs over Blob, consistent surrogation, and the
  `$export` de-identified mode (anonymisation config) — all re-implemented on
  OSS inside the stamp.
- Components: **microsoft/Tools-for-Health-Data-Anonymization** (MIT) for FHIR
  resource rules (redact, date-shift, crypto-hash, encrypt, substitute,
  perturb, generalize) and DICOM tag rules (PS3.15 Basic Profile + options);
  **Presidio** (MIT) for free-text PHI detection in narrative fields, notes and
  OCR'd burned-in text; a Loom job runner (Kubernetes Jobs, Service Bus queue)
  with per-job managed identity and output manifests with hashes.
- Config: per-tenant de-id profiles (HIPAA Safe Harbor default; Expert
  Determination profile = Safe Harbor + k-anonymity report + quasi-identifier
  generalisation); date shift per patient with a tenant salt kept in Key Vault
  (consistent across jobs); surrogate dictionaries deterministic per salt.
- Surfaces: `POST /{tenant}/deid/jobs` (FHIR ndjson or DICOM study sets in
  Blob -> de-identified output container), sync `tag`/`redact` for text up to
  the AHDS-shaped size caps (model: 50 KB sync), and `$export?_deid=profile`.
- Claims: Safe Harbor coverage is tested against the 18-identifier golden set;
  Expert Determination is a hook (report), never a certification; burned-in
  pixel text is best-effort and flagged.

## Consequences
Presidio's NLP models are mirrored into the stamp's ACR (no model download at
runtime); CPU-heavy jobs scale on queue length.

## Reversal cost
Low.
