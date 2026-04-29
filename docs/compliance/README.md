# CSA-in-a-Box Compliance Documentation

> Phase 1 compliance control mappings: **federal + healthcare + commercial**
> foundation for customer ATO / audit / procurement conversations.

This directory is the human-readable companion to the machine-readable
manifests in [`governance/compliance/`](../../csa_platform/governance/compliance/).

---

## Scope — Phase 1

Per the CSA-0012 Phase 1 approval ballot (B3 / AQ-0007), we cover the three
frameworks that answer ~80 % of federal, healthcare, and commercial customer
questions:

| Framework            | Manifest                                                                                        | Narrative                                            | Scope                                   |
| -------------------- | ----------------------------------------------------------------------------------------------- | ---------------------------------------------------- | --------------------------------------- |
| NIST SP 800-53 Rev 5 | [`nist-800-53-rev5.yaml`](../../csa_platform/governance/compliance/nist-800-53-rev5.yaml)       | [`nist-800-53-rev5.md`](./nist-800-53-rev5.md)       | Moderate + High baselines (federal ATO) |
| CMMC 2.0 Level 2     | [`cmmc-2.0-l2.yaml`](../../csa_platform/governance/compliance/cmmc-2.0-l2.yaml)                 | [`cmmc-2.0-l2.md`](./cmmc-2.0-l2.md)                 | 110 practices (DoD contractors)         |
| HIPAA Security Rule  | [`hipaa-security-rule.yaml`](../../csa_platform/governance/compliance/hipaa-security-rule.yaml) | [`hipaa-security-rule.md`](./hipaa-security-rule.md) | §164.308 / 310 / 312 / 314 / 316        |

---

## How this maps to common audit asks

| If a customer asks us about... | We point at...                              |
| ------------------------------ | ------------------------------------------- |
| FedRAMP Moderate or High       | NIST 800-53 Rev 5 manifest                  |
| FISMA                          | NIST 800-53 Rev 5 manifest                  |
| DoD IL4 (CUI)                  | NIST 800-53 Rev 5 + CMMC 2.0 L2             |
| DoD IL5 (NSS CUI)              | Phase 2 — IL4→IL5 delta YAML                |
| DFARS 252.204-7012             | CMMC 2.0 L2 manifest (NIST 800-171 lineage) |
| HIPAA / HITRUST                | HIPAA Security Rule manifest                |
| NIST CSF 2.0                   | Cross-map via NIST 800-53 (Phase 2)         |
| PCI-DSS v4                     | Phase 2                                     |
| SOC 2 Type II                  | Phase 2                                     |
| GDPR / CCPA / GLBA             | Phase 2                                     |
| ITAR / CJIS / IRS 1075         | Phase 2                                     |

---

## How to use the manifests

**Auditors / compliance engineers** — consume the YAML directly:

```bash
# Validate all manifests and produce aggregate stats
python governance/compliance/validate.py

# Count implemented controls per framework
python -c "
import yaml, sys
for f in ('governance/compliance/nist-800-53-rev5.yaml',
          'governance/compliance/cmmc-2.0-l2.yaml',
          'governance/compliance/hipaa-security-rule.yaml'):
    m = yaml.safe_load(open(f))
    impl = sum(1 for c in m['controls'] if c['status'] == 'IMPLEMENTED')
    print(f\"{m['framework']}: {impl}/{len(m['controls'])} IMPLEMENTED\")
"
```

**Engineers** — read the narrative `.md` for each framework, then drill
into evidence paths quoted in the manifest.

**3PAOs / external assessors** — the YAML is canonical. Each control entry
includes:

- `status` (IMPLEMENTED / PARTIALLY_IMPLEMENTED / PLANNED / NOT_APPLICABLE / INHERITED)
- `evidence[]` — one or more pointers to code, Bicep, CI, or policy
- `inheritance[]` — upstream shared-responsibility owner (when applicable)
- `gaps[]` — tracked follow-up work (often linked to a `CSA-XXXX` finding)
- `responsible_party` — who owns implementation

---

## Status-code conventions

| Status                  | Meaning                                                                                    |
| ----------------------- | ------------------------------------------------------------------------------------------ |
| `IMPLEMENTED`           | Evidence exists in repo and materially satisfies the control. Must have ≥1 evidence entry. |
| `PARTIALLY_IMPLEMENTED` | Some evidence; enhancements or follow-up still outstanding.                                |
| `PLANNED`               | Tracked gap; no evidence yet. See `gaps:` and linked `CSA-XXXX` finding.                   |
| `NOT_APPLICABLE`        | Control does not apply to this system's scope / role.                                      |
| `INHERITED`             | Satisfied by an underlying layer (Azure shared responsibility, customer tenant, etc.).     |

The validator in `governance/compliance/validate.py` enforces:

1. No `IMPLEMENTED` control with zero evidence (a cardinal false-claim guard).
2. Every evidence path actually exists on disk.
3. `status` is in the allow-list.
4. `kind` is in the evidence-type allow-list.
5. `INHERITED` controls declare an `inheritance:` block (warning).

---

## FedRAMP / IL4 / IL5 posture

Phase 1 targets the **FedRAMP Moderate baseline** directly. FedRAMP High
controls are enumerated but most are marked `PLANNED` — Phase 2 work.

DoD Impact Level posture:

- **IL2 (Public/Non-CUI)** — current posture satisfies this by default.
- **IL4 (CUI)** — requires Azure Government + CMMC 2.0 L2 coverage.
  Gov Bicep variant at `deploy/bicep/gov/` + CMMC manifest together
  cover the control surface. Still needs formal SSP (Phase 2).
- **IL5 (NSS CUI)** — requires dedicated Azure Government IL5 enclave.
  The delta (key separation, FedRAMP High + DISA SRG IL5 overlay) is
  explicitly a Phase 2 deliverable.

---

## Phase 2 roadmap (CSA-0012 follow-up)

Phase 2 is out of scope for this ticket. Planned scope:

- PCI-DSS v4.0 manifest
- SOC 2 Type II (TSC) manifest
- GDPR + CCPA privacy-control manifest
- IL4 → IL5 delta manifest
- NIST CSF 2.0 cross-map
- SSP generator (OSCAL output)
- ITAR / CJIS / IRS-1075 narrative additions
- 3PAO-ready control-narrative generator
- Customer-facing compliance dashboard (Archon document + portal surface)

---

## Relationship to existing docs

| File                                                                                                                  | Purpose                                                                                     |
| --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| [`governance/compliance/compliance-overview.md`](../../csa_platform/governance/compliance/compliance-overview.md)     | Prose overview — data residency, encryption, audit trail. Edited separately under CSA-0064. |
| [`governance/compliance/nist-800-53-rev5.yaml`](../../csa_platform/governance/compliance/nist-800-53-rev5.yaml)       | Machine-readable NIST 800-53 Rev 5 control map.                                             |
| [`governance/compliance/cmmc-2.0-l2.yaml`](../../csa_platform/governance/compliance/cmmc-2.0-l2.yaml)                 | Machine-readable CMMC 2.0 L2 practice map.                                                  |
| [`governance/compliance/hipaa-security-rule.yaml`](../../csa_platform/governance/compliance/hipaa-security-rule.yaml) | Machine-readable HIPAA Security Rule map.                                                   |
| [`governance/compliance/validate.py`](../../csa_platform/governance/compliance/validate.py)                           | Schema + evidence-path validator.                                                           |
| This directory                                                                                                        | Narrative companions + index.                                                               |

---

**Last updated:** 2026-04-18
**Review cadence:** Annual (target date: 2027-04-18)
**Owner:** csa-inabox platform team
