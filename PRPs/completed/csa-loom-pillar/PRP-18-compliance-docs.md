# PRP-18 — Compliance Documentation

## Context

Per-boundary compliance documentation + the per-feature × per-boundary
matrix + the Defender for Cloud AI Threat Protection workaround
(deployed by PRP-13).

PRD ref: `temp/fiab-prd/08-observability-security.md` §8.4-8.7.

## Goal

Customer audit / security teams can verify CSA Loom's compliance
posture per boundary. Auditor-friendly NIST 800-53 + CMMC + HIPAA
+ ITAR control mappings.

## Acceptance criteria

- [ ] `docs/fiab/compliance/index.md` — landing page
- [ ] `docs/fiab/compliance/commercial.md` — FedRAMP High + IL2 baseline
- [ ] `docs/fiab/compliance/gcc.md` — GCC specifics (M365 identity;
  F-SKU prohibition)
- [ ] `docs/fiab/compliance/gcc-high.md` — IL4 + GCC-High; ITAR
  considerations
- [ ] `docs/fiab/compliance/dod-il5.md` — IL5 mandates (HSM-CMK;
  CNSSI 1253); placeholder for v1.1 (per AMENDMENTS A2)
- [ ] `docs/fiab/compliance/feature-boundary-matrix.md` — per-feature
  × per-boundary master table (from `research/02-gov-boundary-
  availability.md §1`)
- [ ] `docs/fiab/compliance/defender-ai-workaround.md` — Sentinel
  pipeline detail (paired with PRP-13)
- [ ] `docs/fiab/compliance/nist-800-53-rev5-fiab.md` — control-by-
  control mapping (extends existing `docs/compliance/nist-800-53-rev5.md`)
- [ ] `docs/fiab/compliance/cmmc-2.0-l2-fiab.md` — extends existing
- [ ] `docs/fiab/compliance/hipaa-security-rule-fiab.md` — extends
- [ ] `docs/fiab/compliance/itar-fiab.md` — ITAR-specific guidance for
  GCC-H deploys
- [ ] All pages use CSA Loom brand
- [ ] Boundary-matrix table sources from PRP-02 `.bicepparam` files

## Validation gates

- `mkdocs build --strict` clean
- Each per-boundary page asserts what features apply / don't apply
- NIST + CMMC + HIPAA pages map every applicable control

## File changes

10 compliance pages.

## References

- `temp/fiab-prd/08-observability-security.md` §8.4-8.7
- `temp/fiab-research/02-gov-boundary-availability.md`
- Existing `docs/compliance/*.md` (extension templates)
