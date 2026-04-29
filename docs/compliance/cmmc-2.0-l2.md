# CMMC 2.0 Level 2 — CSA-in-a-Box Practice Coverage

**Manifest:** [`governance/compliance/cmmc-2.0-l2.yaml`](../../csa_platform/governance/compliance/cmmc-2.0-l2.yaml)
**Baseline target:** CMMC 2.0 Level 2 (110 practices, NIST 800-171 r2 lineage)
**Last reviewed:** 2026-04-18
**Source of truth:** https://dodcio.defense.gov/CMMC/Model/

---

## Summary

CMMC 2.0 Level 2 is a 1:1 mapping of NIST SP 800-171 Revision 2, which
itself is a subset of NIST 800-53. Our manifest covers **all 110 practices**
and includes a `cross_reference:` field on each entry showing the NIST
800-171 r2 control and the corresponding NIST 800-53 control for quick
pivot.

Phase 1 coverage status:

| Status                | Approx count |
| --------------------- | ------------ |
| IMPLEMENTED           | ~41          |
| PARTIALLY_IMPLEMENTED | ~15          |
| INHERITED             | ~36          |
| NOT_APPLICABLE        | ~9           |
| PLANNED               | ~9           |
| **Total**             | **110**      |

Run the validator for live counts:

```bash
python governance/compliance/validate.py
```

---

## Top-5 strengths for DoD contractor conversations

1. **3.1.1 / 3.1.2 / 3.1.20 Access control + external system connections** —
   The entire access plane is JWT-validated Entra ID with tenant pinning
   ([`csa_platform/common/auth.py`](../../csa_platform/common/auth.py)),
   private endpoints on every data service, and allowed-locations policy
   restricting egress
   ([`policyAssignments.bicep`](../../deploy/bicep/shared/policies/policyAssignments.bicep)).

2. **3.4.1 / 3.4.2 / 3.4.3 Configuration baseline + change control** —
   IaC baseline (`deploy/bicep/DMLZ/main.bicep`), Azure Policy enforcement,
   Bicep what-if previews in CI
   ([`bicep-whatif.yml`](../../.github/workflows/bicep-whatif.yml)).
   This is strong evidence for a CMMC 2.0 L2 assessment.

3. **3.5.2 / 3.5.4 / 3.5.11 Authentication hardening** —
   RS256 algorithm pinning, nbf/exp/iat verification, tenant pin against
   token-swap, generic error messages. These are the practice-level items
   assessors routinely find gaps on; the csa_platform `auth.py` covers
   each explicitly.

4. **3.13.1 / 3.13.5 / 3.13.6 / 3.13.8 Boundary + transmission protection** —
   `defaultAction: Deny` baked into every Bicep module, TLS 1.2 minimum
   enforced by policy, private DNS zones for every PaaS type. Full
   deny-by-exception posture.

5. **3.13.11 FIPS-validated cryptography** —
   Key Vault HSM (FIPS 140-2 L2), storage double encryption, RS256-only
   JWT signing. A rare FIPS-evidenced-in-code baseline.

---

## Top-5 gaps (tracked for future CSA findings)

1. **3.3.1 / 3.3.2 Application-layer audit records** (CSA-0016) —
   Infrastructure diagnostic logging is present; application-layer
   user-action audit trail (who accessed what PHI/CUI record, when) is
   the single highest-value missing control.

2. **3.6.1 / 3.6.2 / 3.6.3 Incident response capability** —
   No runbook, no tabletop exercises, no on-call rotation shipped. An
   assessor will flag this immediately.

3. **3.5.3 MFA** (INHERITED) —
   Authentication is delegated to Entra ID; MFA is assumed enabled but
   the platform ships no CA-policy baseline nor a runtime enforcement
   hook. Adding an opinionated Conditional Access template would close
   this gap.

4. **3.14.6 / 3.14.7 Attack detection** —
   Diagnostic sinks exist; Sentinel analytic rules / alert templates do
   not. An assessor will ask "how do you know when you're under attack?"
   — today the answer is "customer brings SIEM."

5. **3.12.4 System Security Plan** —
   Phase 2 deliverable. Required artifact for CMMC 2.0 L2 certification.

---

## Cross-reference to NIST 800-53 / 800-171

Each CMMC 2.0 L2 practice in the YAML includes a `cross_reference` field
like:

```yaml
- id: "AC.L2-3.1.3"
  cross_reference: "NIST 800-171 3.1.3 / NIST 800-53 AC-4"
```

If your customer operates under DFARS 252.204-7012 (which references
NIST 800-171), the CMMC manifest **is** your NIST 800-171 manifest with
an additional CMMC-assessment-friendly ID scheme.

---

## How to use this manifest in a CMMC assessment

1. Generate assessment-objective evidence bundle from the YAML:
    ```bash
    python governance/compliance/validate.py
    ```
2. For each practice, the YAML lists evidence paths with optional line
   ranges — these become your assessment objective evidence references.
3. Practices marked `INHERITED` are accompanied by the upstream provider
   (e.g. "Microsoft (Entra ID)"). Pair these with the relevant
   FedRAMP-authorized service ATO letter.
4. Practices marked `PLANNED` are the remediation backlog — track via
   `CSA-XXXX` finding IDs or open Archon tickets.

---

## IL4 / IL5 positioning

CMMC 2.0 L2 + Azure Government = DoD IL4 (CUI) viable deployment path.

- The Gov Bicep variant at [`deploy/bicep/gov/`](../../deploy/bicep/gov/)
  is the IL4 deployment target.
- Azure Commercial is CMMC 2.0 L1 only.
- IL5 (NSS CUI) requires a dedicated IL5 Azure Government enclave and
  additional DISA SRG overlay controls not enumerated in this manifest —
  explicitly a Phase 2 deliverable.

---

**Last updated:** 2026-04-18
**Next review:** 2027-04-18
