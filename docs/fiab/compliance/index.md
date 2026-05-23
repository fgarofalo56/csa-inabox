# CSA Loom — Compliance

Per-boundary compliance documentation. Customer audit / security
teams use this section to verify CSA Loom's posture per audit
boundary and to drive their own ATO documentation.

## Per-boundary attestations

<div class="grid cards" markdown>

-   :material-cloud: [**Commercial baseline**](commercial.md)

    FedRAMP High + DoD IL2 (Azure public baseline)

-   :material-government: [**GCC**](gcc.md)

    FedRAMP High + DoD IL2 (Azure Commercial under M365 GCC)

-   :material-shield-account: [**GCC-High / IL4**](gcc-high.md)

    FedRAMP High + DoD IL4 + ITAR-eligible (Azure Government)

-   :material-shield-star: [**DoD IL5 (v1.1)**](dod-il5.md)

    FedRAMP High + DoD IL5 + CNSSI 1253 (Azure Government IL5
    isolation)

</div>

## Reference matrix

<div class="grid cards" markdown>

-   :material-table: [**Feature × boundary matrix**](feature-boundary-matrix.md)

    Per-CSA-Loom-feature × per-Azure-boundary availability +
    substitutions

-   :material-shield-search: [**Defender for Cloud AI Threat Protection workaround**](defender-ai-workaround.md)

    The Sentinel + Content Safety + Presidio pipeline that replaces
    Defender for Cloud AI Threat Protection in Gov boundaries

</div>

## Control mapping extensions

CSA Loom inherits the parent csa-inabox compliance pages and extends
them with Loom-specific control mappings:

<div class="grid cards" markdown>

-   [**NIST 800-53 Rev 5 (Loom extension)**](nist-800-53-rev5-fiab.md)

    Control-by-control mapping of how CSA Loom implements NIST
    800-53 r5 controls (extends parent `docs/compliance/nist-800-53-rev5.md`)

-   [**CMMC 2.0 L2 (Loom extension)**](cmmc-2.0-l2-fiab.md)

    Loom's contribution to a customer's CMMC L2 / L3 audit posture

-   [**HIPAA Security Rule (Loom extension)**](hipaa-security-rule-fiab.md)

    HIPAA BAA scope + workload-level Security Rule implementation
    guidance

-   [**ITAR (Loom extension)**](itar-fiab.md)

    ITAR-specific guidance for GCC-High deploys

</div>

## Cross-cutting compliance topics

- **Encryption-at-rest**: Microsoft-managed everywhere; HSM-CMK +
  double-encryption required at IL5
- **Encryption-in-transit**: TLS 1.2+ everywhere; egress restricted
  via Azure Firewall app rules
- **Identity**: Entra ID with Conditional Access + MFA + PIM
- **Audit logging**: Activity Log + per-engine audit logs → LAW →
  Sentinel (Gov)
- **Network**: Hub-spoke with Private Endpoints; `publicNetworkAccess
  = disabled` on every PaaS resource
- **Backup + DR**: ADLS GRS / RA-GRS; Git-state for compute
- **Vulnerability**: Defender for Cloud all plans; AI Threat
  Protection Commercial-only with [Sentinel workaround](defender-ai-workaround.md) in Gov

## Customer responsibilities

Even with CSA Loom's deployed controls, the customer remains
responsible for:
- Workload-level data classification (which tables are CUI, which are
  PII-restricted, etc.)
- User access reviews (quarterly PIM reviews; access certification)
- Per-domain governance overrides (each Domain Steward owns their
  DLZ's data governance)
- Incident response (Loom provides runbooks; customer operates the
  response)
- Compliance attestation (Loom enables; customer documents)

## Related

- Parent compliance: [Compliance index](../../compliance/README.md)
- Parent ADR: [ADR-0010 Fabric strategic target](../../adr/0010-fabric-strategic-target.md)
- Reference: [Azure Government product GA roadmap](https://learn.microsoft.com/azure/azure-government/documentation-government-product-roadmap)
