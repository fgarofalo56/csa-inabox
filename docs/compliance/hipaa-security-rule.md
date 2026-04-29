# HIPAA Security Rule — CSA-in-a-Box Safeguard Coverage

**Manifest:** [`governance/compliance/hipaa-security-rule.yaml`](../../csa_platform/governance/compliance/hipaa-security-rule.yaml)
**Scope:** 45 CFR Part 164 Subpart C — §164.308 / 310 / 312 / 314 / 316
**Last reviewed:** 2026-04-18
**Source of truth:** https://www.hhs.gov/hipaa/for-professionals/security/index.html

---

## Summary

The HIPAA Security Rule organizes safeguards into four categories plus
a documentation section. CSA-in-a-Box, as a **data platform**, is
naturally strong on **Technical Safeguards (§164.312)** — encryption,
access control, transmission security — which are the highest-value
controls for a covered entity or business associate subject to HIPAA.

Administrative and Physical safeguards largely live at the customer
organization or Azure platform layers respectively.

Each standard is tagged `(R)` = Required or `(A)` = Addressable per
HIPAA's implementation-specification model.

| Safeguard category        | Standards | CSA-in-a-Box role                                                               |
| ------------------------- | --------- | ------------------------------------------------------------------------------- |
| Administrative (§164.308) | 20        | Partially — workforce / training inherited; access-control + backup implemented |
| Physical (§164.310)       | 12        | Almost entirely inherited from Azure datacenter                                 |
| Technical (§164.312)      | 11        | Primary strength — most controls IMPLEMENTED                                    |
| Organizational (§164.314) | 5         | BAA inherited from Microsoft Azure                                              |
| Documentation (§164.316)  | 5         | Partially — manifest + this file satisfy several                                |

---

## Stats (approximate)

| Status                | Count                                   |
| --------------------- | --------------------------------------- |
| IMPLEMENTED           | ~17                                     |
| PARTIALLY_IMPLEMENTED | ~15                                     |
| INHERITED             | ~22                                     |
| NOT_APPLICABLE        | ~3                                      |
| PLANNED               | ~6                                      |
| **Total**             | **63 standards + implementation specs** |

---

## Top-5 strengths for healthcare customer conversations

1. **§164.312(a)(1) / (a)(2)(iv) Access Control + Encryption/Decryption** —
   Microsoft Entra ID RBAC enforced (`enableRbacAuthorization=true` on Key Vault),
   `allowSharedKeyAccess=false` on storage (AAD-only ePHI access),
   AES-256 at rest with optional CMK, FIPS 140-2 L2 HSM Key Vault.
   This is the **strongest Technical Safeguard posture** a typical
   business associate can demonstrate.

2. **§164.312(e)(1) Transmission Security** —
   TLS 1.2 minimum enforced by Azure Policy, HTTPS-only, HSTS on portal,
   private endpoints for all PaaS services. ePHI never transits public
   internet once inside the boundary.

3. **§164.308(a)(7)(ii)(A) Data Backup Plan** —
   Blob versioning + 30-day soft-delete + change feed on governance
   storage, Key Vault 90-day soft-delete + purge protection. Concrete
   Required-spec evidence.

4. **§164.312(a)(2)(iii) Automatic Logoff** —
   JWT `exp` verified on every request with 30-second leeway. A small
   control but frequently missed in homegrown HIPAA implementations.

5. **§164.312(a)(2)(i) Unique User Identification** —
   Every authenticated request carries Entra ID `oid` + `sub` + `tid`
   claims, extracted and available to every route.

---

## Top-5 gaps (tracked for future CSA findings)

1. **§164.312(b) Audit Controls — application layer** (CSA-0016) —
   The single highest-value gap for a HIPAA audit. Infrastructure-layer
   diagnostic logs go to Log Analytics, but application-layer PHI-access
   audit records (who read/modified which patient record, when) are not
   captured in a tamper-evident form.

2. **§164.308(a)(6)(i) / (ii) Security Incident Procedures** —
   No IR runbook, no HHS breach-notification workflow. A covered
   entity would need to build this on top of the platform; the platform
   should ship opinionated templates.

3. **§164.308(a)(7)(ii)(B) / (C) / (D) / (E) Disaster Recovery + Emergency
   Mode + Testing + Criticality** —
   Data backup is solid; formal DR plan, emergency-mode runbook,
   test cadence, and BIA are all absent.

4. **§164.312(c)(1) / (c)(2) Integrity mechanisms for ePHI** —
   Infrastructure double-encryption + blob versioning provide some
   integrity assurance. A dedicated hashing / digital-signature
   workflow for PHI records is not shipped.

5. **§164.316(b)(2)(i) 6-year retention** —
   Default blob lifecycle is 90-day tier-to-Cool. HIPAA requires
   retention of documentation for 6 years from creation/last-effective.
   Customer must configure workspace retention explicitly; platform
   should ship a HIPAA-preset retention policy.

---

## Relationship to the Microsoft Azure BAA

- Microsoft provides a **Business Associate Agreement** covering Azure
  services in scope. This agreement is executed at the tenant level
  and is out of scope for the platform codebase.
- CSA-in-a-Box does NOT automatically make the deploying organization
  a HIPAA-compliant entity. The platform provides **technical safeguards
  that support HIPAA compliance**; administrative and organizational
  safeguards remain the customer's responsibility.
- `§164.314(a)(1) Business Associate Contracts` is intentionally marked
  `INHERITED` — the BAA lives between the customer and Microsoft, not
  in this codebase.

---

## How to use this manifest

1. **Map to your Security Risk Analysis** — each entry satisfies part of
   a 164.308(a)(1)(ii)(A) assessment. Use the `evidence:` paths as
   reference artifacts in your SRA document.

2. **Find gaps to remediate** — any entry where `status:
PARTIALLY_IMPLEMENTED` or `PLANNED` is your backlog. Most include
   a `gaps:` description.

3. **Identify inherited controls** — any entry where `status: INHERITED`
   lists the upstream provider (Microsoft for Azure-layer,
   Customer for org-layer). Your SRA narrative should explicitly
   reference the corresponding Microsoft ATO / BAA / cloud-service ATO
   letter.

---

## HITRUST / HITECH

This manifest is structured around the HIPAA Security Rule directly.
For HITRUST CSF / HITECH-enhanced ATOs:

- Phase 2 will add a HITRUST CSF v11+ cross-map.
- HITECH breach-notification rule integration depends on the
  incident-response runbook (currently `PLANNED`).

---

**Last updated:** 2026-04-18
**Next review:** 2027-04-18
