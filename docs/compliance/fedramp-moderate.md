# Compliance — FedRAMP Moderate

> **Status:** Implementation guidance and control crosswalk for **FedRAMP Moderate** baseline. This is **not** a 3PAO assessment package — it is a starting point for an Authorization Boundary Document and SSP that uses CSA-in-a-Box as the platform layer.

## What is FedRAMP Moderate?

FedRAMP (Federal Risk and Authorization Management Program) is the **standardized US federal authorization** for cloud services. The **Moderate** baseline applies to the majority of federal data — including PII, sensitive but unclassified, and most agency operational data. It builds on **NIST SP 800-53 Rev 5** with 325 specific controls.

A FedRAMP authorization (ATO) covers a **specific cloud service offering** in a **specific deployment**. The platform you build on top must inherit controls from the underlying CSP authorization (Azure Commercial / Azure Government), implement the application-layer controls itself, and document everything in a **System Security Plan (SSP)**.

## How CSA-in-a-Box helps

The platform implements **a substantial portion** of the application-layer FedRAMP Moderate controls out-of-box, and provides documentation patterns for the rest. You still need:

- A 3PAO assessment
- An ATO Letter from a sponsoring agency
- Your own SSP, POA&M, contingency plan, and incident response plan
- Continuous monitoring (ConMon) operational

This page is a **starting point**, not a finishing point.

## Inheritance from Azure CSP

Use the appropriate Microsoft authorization package:

| Deployment | CSP Authorization | Where to obtain |
|------------|-------------------|-----------------|
| Azure Commercial | FedRAMP Moderate (Continuous Monitoring) | https://marketplace.fedramp.gov/products |
| Azure Government | FedRAMP **High** | https://marketplace.fedramp.gov/products |
| Azure Gov Secret / TS | DoD IL5 / IL6 | Sponsor agency portal |

**Important:** Azure Government's FedRAMP authorization is *High* (which exceeds Moderate); deploying to Gov gives you broader inheritance. However, several services are not yet GA in Gov — see [Government Service Matrix](../GOV_SERVICE_MATRIX.md).

## Control family crosswalk

Each row links to the relevant **NIST 800-53 Rev 5** controls (already implemented in [`compliance/nist-800-53-rev5.md`](nist-800-53-rev5.md)) and identifies what's platform-implemented vs customer-implemented.

| Family | FedRAMP Mod controls | Where in CSA-in-a-Box | Inherit / Implement |
|--------|---------------------|----------------------|---------------------|
| **AC** Access Control | AC-2, AC-3, AC-4, AC-5, AC-6, AC-7, AC-8, AC-11, AC-12, AC-14, AC-17, AC-18, AC-19, AC-20, AC-22 | [Identity & Secrets Flow](../reference-architecture/identity-secrets-flow.md), [ADR 0014](../adr/0014-msal-bff-auth-pattern.md), Entra ID + PIM + Conditional Access, Bicep RBAC modules | Mostly customer-implement; platform provides patterns |
| **AT** Awareness & Training | AT-1, AT-2, AT-3, AT-4 | Out of scope — your training program | Customer-implement |
| **AU** Audit & Accountability | AU-2, AU-3, AU-4, AU-5, AU-6, AU-8, AU-9, AU-11, AU-12 | Log Analytics + Activity Log + Diagnostic Settings, [LOG_SCHEMA.md](../LOG_SCHEMA.md), [Best Practices — Monitoring](../best-practices/monitoring-observability.md) | Inherit (Azure logging) + customer-implement (retention, review) |
| **CA** Assessment & Authorization | CA-1 through CA-9 | Out of scope — your ATO process | Customer-implement |
| **CM** Configuration Management | CM-2, CM-3, CM-4, CM-5, CM-6, CM-7, CM-8, CM-10, CM-11 | Bicep IaC + GitHub Actions + branch protection + Defender for Cloud baselines | Platform implements (IaC); customer enforces (CCB, CMP) |
| **CP** Contingency Planning | CP-1 through CP-10 | [DR.md](../DR.md), [Runbook — DR Drill](../runbooks/dr-drill.md), Geo-redundant storage, Bicep multi-region module | Platform provides patterns; customer documents BIA + recovery |
| **IA** Identification & Auth | IA-2, IA-3, IA-4, IA-5, IA-6, IA-7, IA-8, IA-11 | Entra ID + MFA + PIM + federated SP for CI/CD; **no static credentials** | Mostly platform-implement |
| **IR** Incident Response | IR-1 through IR-9 | [Runbook — Security Incident](../runbooks/security-incident.md), Defender for Cloud, Sentinel optional | Platform provides patterns; customer staffs IR team |
| **MA** Maintenance | MA-2, MA-3, MA-4, MA-5, MA-6 | Mostly inherited from Azure CSP | Inherit |
| **MP** Media Protection | MP-1 through MP-7 | Inherited from Azure CSP for cloud media; customer for any local copies | Inherit + customer |
| **PE** Physical & Environmental | PE-1 through PE-17 | Fully inherited from Azure CSP (datacenter physical) | Inherit |
| **PL** Planning | PL-1, PL-2, PL-4, PL-8 | Out of scope — your SSP/SDP | Customer-implement |
| **PS** Personnel Security | PS-1 through PS-8 | Out of scope — your HR | Customer-implement |
| **RA** Risk Assessment | RA-1, RA-2, RA-3, RA-5 | Defender for Cloud + Defender Vulnerability Management + Microsoft Sentinel | Inherit (scanning) + customer (RA report) |
| **SA** System & Services Acquisition | SA-1 through SA-22 | [SUPPLY_CHAIN.md](../SUPPLY_CHAIN.md) (SBOM + signing + dependency scanning) | Platform implements supply chain; customer SA-9 third-party services |
| **SC** System & Comm Protection | SC-2, SC-4, SC-5, SC-7, SC-8, SC-12, SC-13, SC-15, SC-17, SC-18, SC-19, SC-20, SC-21, SC-22, SC-23, SC-28, SC-39 | [Hub-Spoke Topology](../reference-architecture/hub-spoke-topology.md), Private Endpoints, Azure Firewall Premium, TLS 1.2+, CMK Key Vault, Private DNS | Platform-implement (with customer config) |
| **SI** System & Information Integrity | SI-2, SI-3, SI-4, SI-5, SI-7, SI-8, SI-10, SI-11, SI-12, SI-16 | Defender for Cloud, Defender for Storage, Defender for SQL, Microsoft Update, integrity monitoring | Inherit (Defender) + platform (Bicep) |
| **SR** Supply Chain Risk Mgmt | SR-1 through SR-12 | [SUPPLY_CHAIN.md](../SUPPLY_CHAIN.md), pinned dependencies, SBOM, signed artifacts, dependabot + trivy | Platform implements |

## Specific controls worth highlighting

### AC-2 Account Management
- **Implemented**: Entra ID groups + PIM-eligible roles + Conditional Access (see [Identity & Secrets Flow](../reference-architecture/identity-secrets-flow.md))
- **Evidence**: Entra Audit Logs, role assignment exports, PIM activation logs

### AU-2 Auditable Events
- **Implemented**: Diagnostic Settings on every resource → Log Analytics, [LOG_SCHEMA.md](../LOG_SCHEMA.md) defines auditable events
- **Evidence**: KQL queries against Log Analytics, archive in long-term Storage

### CM-2 Baseline Configuration
- **Implemented**: Every resource defined in Bicep, version-controlled in git, deployed via GitHub Actions with required reviewers
- **Evidence**: Git history, GitHub Actions workflow runs, `az deployment what-if` outputs

### CP-9 System Backup
- **Implemented**: Geo-redundant storage (GRS/RA-GRS), Azure Backup for VMs, Cosmos PITR, Synapse SQL pool restore points, Databricks Unity Catalog backups
- **Evidence**: Azure Backup vault, CP-9 runbook, [DR.md](../DR.md)

### IA-2(1) Multi-Factor Authentication
- **Implemented**: Conditional Access policy requires MFA for all users, all admin actions
- **Evidence**: Entra Sign-in logs filtered by MFA result

### SC-7 Boundary Protection
- **Implemented**: [Hub-Spoke Topology](../reference-architecture/hub-spoke-topology.md), Azure Firewall Premium with IDPS, Private Endpoints, no public IPs on data plane
- **Evidence**: Network topology diagram, NSG rules export, AzFW policy export

### SC-13 Cryptographic Protection
- **Implemented**: TLS 1.2+ enforced, CMK on Storage / SQL / Cosmos, FIPS 140-2 / 140-3 validated modules in Gov
- **Evidence**: Resource configurations, Key Vault key version exports

### SI-4 System Monitoring
- **Implemented**: Defender for Cloud + Microsoft Sentinel + Log Analytics + custom Workbooks
- **Evidence**: Defender posture score, Sentinel incident exports, Workbook screenshots

## Documentation deliverables checklist

For your FedRAMP authorization package you'll need:

- [ ] System Security Plan (SSP) — use Microsoft's [FedRAMP SSP template](https://www.fedramp.gov/documents-templates/) and reference this docs site for control implementations
- [ ] Information System Boundary Diagram — start from [Hub-Spoke Topology](../reference-architecture/hub-spoke-topology.md)
- [ ] Data Flow Diagram — start from [Data Flow (Medallion)](../reference-architecture/data-flow-medallion.md)
- [ ] Control Implementation Summary — use the table above as a starting point
- [ ] Configuration Management Plan — reference [IaC & CI/CD](../IaC-CICD-Best-Practices.md)
- [ ] Incident Response Plan — start from [Runbook — Security Incident](../runbooks/security-incident.md)
- [ ] Contingency Plan — start from [DR.md](../DR.md)
- [ ] Plan of Action & Milestones (POA&M)
- [ ] Continuous Monitoring Plan — reference [Best Practices — Monitoring](../best-practices/monitoring-observability.md)
- [ ] Privacy Impact Assessment (if PII)
- [ ] Rules of Behavior

## Continuous Monitoring (ConMon) operational

Monthly ConMon obligations include:

| Monthly | Tool / Source |
|---------|---------------|
| Vulnerability scans | Defender Vulnerability Management + Trivy in CI |
| POA&M update | Issue tracker or GRC tool |
| Configuration baseline review | `az deployment what-if` against current vs baseline |
| Inventory update | Azure Resource Graph queries |
| Account audit | Entra audit logs + PIM activation review |
| Patch compliance | Defender for Cloud recommendations + Update Management |

## Trade-offs

✅ **Why this is a strong starting point**
- Most SC and AU controls are platform-implemented out-of-box
- IaC + git history = automated CM evidence
- Defender for Cloud = automated SI/RA evidence
- Patterns documented = consistent control implementation

⚠️ **What this does not give you**
- An actual ATO (you must work with a sponsoring agency + 3PAO)
- POA&M management (your GRC tool)
- Personnel and physical controls (your HR + facilities)
- Continuous monitoring operations (your SOC)

## Related

- [Compliance — NIST 800-53 Rev 5](nist-800-53-rev5.md) — the underlying control set
- [Compliance — CMMC 2.0 Level 2](cmmc-2.0-l2.md) — DoD contractor variant
- [Compliance — HIPAA Security Rule](hipaa-security-rule.md) — for PHI workloads
- [Best Practices — Security & Compliance](../best-practices/security-compliance.md)
- [Government Service Matrix](../GOV_SERVICE_MATRIX.md) — service availability per cloud
- FedRAMP official: https://www.fedramp.gov/
- Microsoft FedRAMP: https://learn.microsoft.com/azure/compliance/offerings/offering-fedramp
