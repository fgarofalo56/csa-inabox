# NIST SP 800-53 Rev 5 — CSA-in-a-Box Control Coverage

**Manifest:** [`governance/compliance/nist-800-53-rev5.yaml`](../../csa_platform/governance/compliance/nist-800-53-rev5.yaml)
**Baseline target:** Moderate (with High-baseline controls enumerated)
**Last reviewed:** 2026-04-18
**Source of truth:** https://csrc.nist.gov/publications/detail/sp/800-53/rev-5/final

---

## Summary

This manifest maps CSA-in-a-Box implementation artifacts to NIST SP 800-53
Rev 5 security and privacy controls across the **Moderate** baseline, with
High-baseline enhancements noted where relevant to federal ATO conversations
(FedRAMP High, FISMA High, DoD IL4 overlays that pull from 800-53).

Coverage is intentionally honest: roughly 25 % of Moderate controls are
fully `IMPLEMENTED` in code, another ~25 % are `PARTIALLY_IMPLEMENTED`
(evidence exists but rough edges remain), ~30 % are correctly `INHERITED`
from Azure / Microsoft shared responsibility, and the balance are either
`NOT_APPLICABLE` to a PaaS data platform or explicitly `PLANNED` for
Phase 2 remediation.

## Stats (approximate — authoritative source is the YAML)

| Status | Count |
|---|---|
| IMPLEMENTED | ~26 |
| PARTIALLY_IMPLEMENTED | ~29 |
| INHERITED | ~38 |
| NOT_APPLICABLE | ~8 |
| PLANNED | ~16 |
| **Total** | **~117 controls** |

Run the validator for live counts:

```bash
python governance/compliance/validate.py
```

---

## Top-5 strengths (genuinely strong implementation in the repo)

1. **SC-7 / SC-7(5) Boundary protection + deny-by-default** —
   Every Bicep module in `deploy/bicep/DMLZ/modules/` sets
   `networkAcls.defaultAction: 'Deny'` and `publicNetworkAccess: 'Disabled'`.
   Azure Policy assignments in
   [`deploy/bicep/shared/policies/policyAssignments.bicep`](../../deploy/bicep/shared/policies/policyAssignments.bicep)
   enforce "deny public storage" and "require private endpoints"
   organization-wide. This is stronger than most customer baselines.

2. **IA-2 / IA-7 Identification + cryptographic authentication** —
   [`csa_platform/common/auth.py`](../../csa_platform/common/auth.py)
   implements RS256-pinned JWT validation against Entra ID JWKS, with
   tenant-pinning that blocks cross-tenant token swap attacks
   (CSA-0018 fix). `enforce_auth_safety_gate` refuses to start a
   non-local deployment without tenant configuration — a genuine
   fail-secure posture (SC-7(18) High-baseline control).

3. **SC-13 / SC-28 / SC-28(1) Cryptographic protection at rest** —
   Storage accounts enable `requireInfrastructureEncryption: true`
   (double encryption) with optional CMK via Key Vault. Key Vault
   itself enforces purge protection + 90-day soft delete + HSM-backed
   (FIPS 140-2 L2) keys. See
   [`deploy/bicep/DMLZ/modules/Storage/storage.bicep`](../../deploy/bicep/DMLZ/modules/Storage/storage.bicep)
   and
   [`deploy/bicep/DMLZ/modules/KeyVault/keyvault.bicep`](../../deploy/bicep/DMLZ/modules/KeyVault/keyvault.bicep).

4. **SC-18 Mobile code / portal security headers** —
   The portal API sets a strict CSP (`script-src 'self'`,
   `frame-ancestors 'none'`), HSTS, and the full complement of
   modern security headers. See the `SecurityHeadersMiddleware` in
   [`portal/shared/api/main.py`](../../portal/shared/api/main.py).

5. **CM-2 / CM-3 / CM-4 Baseline + change control** —
   The entire platform is IaC under `deploy/bicep/`, with GitHub
   Actions what-if previews on every PR
   ([`bicep-whatif.yml`](../../.github/workflows/bicep-whatif.yml))
   and pre-merge validation gates
   ([`validate.yml`](../../.github/workflows/validate.yml)). CodeQL
   SAST runs weekly + on push.

---

## Top-5 gaps (tracked for future CSA findings)

1. **AU-2 / AU-3 / AU-9 Application-layer tamper-evident audit log**
   (see `CSA-0016`) —
   Infrastructure-layer diagnostic logging into Log Analytics is robust;
   application-layer security-event logging (auth success/failure,
   role escalation, data-export events) is absent. No immutable-tier
   or hash-chained evidence for audit records. Feeds the follow-up
   ticket to ship structured `audit.event` emitters with correlation IDs.

2. **IA-2(1) / IA-2(2) Conditional Access baseline templates** —
   MFA is `INHERITED` from Entra ID but the platform ships zero
   Conditional Access policy templates. A customer with a brand-new
   tenant gets no "turn on MFA for Contributor role" guidance. Phase 2
   should ship opinionated CA baselines.

3. **CP-2 / CP-7 / CP-10 Formal contingency planning** —
   Backups and teardown/rollback workflows exist. A formal Contingency
   Plan document, BIA, RTO/RPO targets, paired-region failover module,
   and DR-test-cadence artifact do not. Hard blocker for FedRAMP
   Moderate ATO.

4. **SI-4 / SI-5 Active security monitoring** —
   Diagnostic settings produce logs; policies audit missing diagnostics.
   However, no Sentinel analytic rules, alert templates, or MSRC-feed
   subscription are shipped with the platform. Customer has to BYO
   SOC integration.

5. **PL-2 / CA-2 System Security Plan + assessment artifact** —
   No SSP template is generated from these manifests yet. The whole
   point of CSA-0012 Phase 2 is to close this loop: ship an OSCAL SSP
   generator that consumes the YAML and emits a 3PAO-ready package.

---

## How to consume this manifest

### For auditors / 3PAO

Read [`nist-800-53-rev5.yaml`](../../csa_platform/governance/compliance/nist-800-53-rev5.yaml)
directly. Every control entry is self-contained: status, evidence paths
(with line numbers), inheritance, gaps, and responsible party. Evidence
paths are relative to repo root and verified by
[`validate.py`](../../csa_platform/governance/compliance/validate.py).

### For engineers implementing remediation

1. Find the control ID (e.g. `AU-2`) in the YAML.
2. Note the `status` and `gaps[]` entries.
3. Search `temp/audit/FINDINGS_REGISTRY.md` for the paired `CSA-XXXX`
   finding if one exists.
4. Add evidence entries when you ship new implementation artifacts —
   the validator will block merges that claim `IMPLEMENTED` without
   evidence.

### For program management

Run the validator and grep the status breakdown. A week-over-week trend
on `PLANNED → PARTIALLY_IMPLEMENTED → IMPLEMENTED` is your compliance
velocity metric.

---

## Relationship to FedRAMP / IL4 / IL5

- **FedRAMP Moderate** — this manifest's primary target. Phase 2 adds the
  missing PLANNED controls.
- **FedRAMP High** — High-only controls (AC-2(12), AU-9(4), CP-2(5), etc.)
  are enumerated and marked `PLANNED`. The Gov Bicep variant at
  `deploy/bicep/gov/` is the deployment path for FedRAMP High workloads.
- **DoD IL4 / IL5** — see
  [README.md](./README.md) and [`cmmc-2.0-l2.md`](./cmmc-2.0-l2.md).
  IL5 delta is explicitly Phase 2.

---

**Last updated:** 2026-04-18
**Next review:** 2027-04-18
