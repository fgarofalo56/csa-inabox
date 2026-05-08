# Compliance — StateRAMP

--8<-- "_includes/compliance-disclaimer.md"

> **Scope:** StateRAMP security assessment framework for state and local government cloud adoption. This document maps CSA-in-a-Box platform controls to StateRAMP requirements and provides guidance for organizations pursuing StateRAMP authorization.

## What is StateRAMP?

StateRAMP (State Risk and Authorization Management Program) is a **nonprofit membership organization** that provides a standardized approach to security assessment for cloud services used by state and local governments. Modeled after FedRAMP, StateRAMP establishes a common set of security requirements so that cloud service providers (CSPs) can demonstrate compliance once and sell to many state and local agencies.

StateRAMP defines three impact levels — **Low**, **Moderate**, and **High** — aligned with NIST SP 800-53 Rev 5 baselines. The Moderate baseline is the most common target, covering the majority of state agency workloads including PII, tax data, and operational systems.

Key distinctions from FedRAMP:

- StateRAMP is operated by a **nonprofit** governed by a board of state CISOs, not a federal body.
- Authorization is granted by the **StateRAMP Program Management Office (PMO)**, not an individual agency.
- StateRAMP explicitly enables **reciprocity** — a FedRAMP authorized product can achieve StateRAMP status through an accelerated review.
- Costs and timelines are substantially lower than FedRAMP, making it accessible to smaller CSPs.

## Why StateRAMP matters

State and local governments collectively spend billions annually on cloud services, and procurement officers increasingly **require StateRAMP authorization** as a condition of contract award. Twelve or more states have adopted or are adopting StateRAMP as mandatory policy.

**Reciprocity with FedRAMP:** If your offering already holds a FedRAMP ATO, the StateRAMP Fast Track process accepts the existing 3PAO assessment package and typically completes review in 60–90 days rather than the full 6–12 month cycle.

**Procurement advantage:** A StateRAMP Authorized status on the StateRAMP Marketplace is a direct differentiator in competitive procurements. Many state RFPs now list StateRAMP as a mandatory requirement alongside SOC 2.

## StateRAMP authorization levels

StateRAMP defines three authorization statuses that reflect increasing levels of assurance:

| Status                    | Meaning                                                                                          | Use Case                                    |
| ------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------- |
| **StateRAMP Ready**       | 3PAO assessment complete; PMO verified controls meet baseline. Valid for procurement listings.   | Initial market entry; RFP eligibility       |
| **StateRAMP Provisional** | Authorized with conditions; minor findings documented in POA&M. Time-limited remediation period. | Agencies that need near-term deployment     |
| **StateRAMP Authorized**  | Full authorization; all controls satisfied or accepted with documented risk. Annual renewal.     | Production deployments; long-term contracts |

Most state procurement offices accept **StateRAMP Ready** or higher as meeting their security requirements. Some agencies with elevated risk tolerance may accept a current POA&M at the Provisional level, while others require full Authorized status.

!!! tip
Aim for **StateRAMP Authorized** from the start if your timeline permits. Provisional status creates remediation pressure and may complicate renewals if POA&M items slip.

## Control families crosswalk

StateRAMP controls are drawn directly from NIST 800-53 Rev 5. The table below maps the most critical families to CSA-in-a-Box implementation.

| StateRAMP Control Family               | CSA-in-a-Box Implementation                                                                                                                                              | Key Azure Services                                |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------- |
| **AC** Access Control                  | Entra ID RBAC + PIM + Conditional Access; Bicep modules enforce `enableRbacAuthorization`; [Identity & Secrets Flow](../reference-architecture/identity-secrets-flow.md) | Entra ID, PIM, Conditional Access                 |
| **AU** Audit & Accountability          | Diagnostic Settings on all resources → Log Analytics; [LOG_SCHEMA.md](../LOG_SCHEMA.md); immutable storage for log archives                                              | Log Analytics, Azure Monitor, Storage (immutable) |
| **CM** Configuration Management        | Full IaC in `deploy/bicep/`; GitHub Actions CI/CD with what-if previews; Azure Policy baselines                                                                          | Azure Policy, GitHub Actions, Bicep               |
| **CP** Contingency Planning            | Geo-redundant storage, Azure Backup, Cosmos PITR; [DR.md](../DR.md) and [DR Drill runbook](../runbooks/dr-drill.md)                                                      | Azure Backup, GRS Storage, Cosmos DB              |
| **IA** Identification & Authentication | Entra ID + MFA enforced; RS256 JWT validation with tenant pinning ([`auth.py`](../../csa_platform/common/auth.py)); no static credentials                                | Entra ID, Key Vault                               |
| **IR** Incident Response               | [Security Incident runbook](../runbooks/security-incident.md); Defender for Cloud alerts; optional Sentinel integration                                                  | Defender for Cloud, Microsoft Sentinel            |
| **SC** System & Comm Protection        | [Hub-Spoke Topology](../reference-architecture/hub-spoke-topology.md); Private Endpoints on all PaaS; Azure Firewall Premium; TLS 1.2+; CMK via Key Vault                | Azure Firewall, Private Link, Key Vault           |
| **RA** Risk Assessment                 | Defender for Cloud secure score + recommendations; Defender Vulnerability Management; Trivy in CI                                                                        | Defender for Cloud, Defender Vulnerability Mgmt   |

For full NIST 800-53 Rev 5 control coverage details, see [Compliance — NIST 800-53 Rev 5](nist-800-53-rev5.md).

## Azure compliance status

Microsoft Azure maintains StateRAMP authorization for core services across both Commercial and Government clouds.

| Azure Environment | StateRAMP Status                          | Recommended For                                |
| ----------------- | ----------------------------------------- | ---------------------------------------------- |
| Azure Commercial  | Authorized (Moderate) for many services   | Most state/local workloads                     |
| Azure Government  | Authorized (High) — inherits FedRAMP High | Agencies requiring data sovereignty guarantees |

!!! tip
Azure Government's FedRAMP High authorization **exceeds** StateRAMP Moderate requirements. Deploying to Azure Government gives you broader inherited controls, though some services may not be GA — see [Government Service Matrix](../GOV_SERVICE_MATRIX.md).

## CSA-in-a-Box alignment

### Bicep modules enforcing StateRAMP controls

The platform's IaC modules implement StateRAMP-relevant controls by default:

- **`deploy/bicep/DMLZ/modules/KeyVault/`** — Purge protection enabled, soft delete 90 days, HSM-backed keys (FIPS 140-2 Level 2), RBAC authorization enforced. Satisfies SC-12, SC-13.
- **`deploy/bicep/DMLZ/modules/Storage/`** — `defaultAction: Deny` on network ACLs, infrastructure double encryption, optional CMK, HTTPS-only. Satisfies SC-28, AC-4.
- **`deploy/bicep/DMLZ/modules/Network/`** — Private endpoints, NSG rules, deny-by-default posture. Satisfies SC-7.
- **`deploy/bicep/shared/policies/policyAssignments.bicep`** — Azure Policy assignments enforcing private endpoints, denied public access, and allowed locations organization-wide. Satisfies CM-6, CM-7.

### Data lineage and audit trail

dbt transformations produce a documented lineage graph across the medallion architecture, providing evidence for AU-3 (audit record content) and AU-12 (audit generation). Combined with Log Analytics diagnostic settings, this creates a continuous audit trail from raw ingestion through curated analytics.

### Data classification with Purview

Microsoft Purview ([`deploy/bicep/DMLZ/modules/Purview/`](../../deploy/bicep/DMLZ/modules/Purview/)) provides automated data classification and sensitivity labeling. For StateRAMP, this supports RA-2 (security categorization) by identifying PII, financial data, and other sensitive data types across the data estate.

### Continuous monitoring with Defender for Cloud

Defender for Cloud provides the continuous monitoring posture required by StateRAMP's CA-7 (continuous monitoring) control. The platform's Bicep deployments enable Defender plans for Storage, SQL, Key Vault, and App Service, feeding findings into a centralized compliance dashboard.

## Gap analysis

Common gaps state and local organizations encounter when pursuing StateRAMP authorization, and how CSA-in-a-Box addresses them:

| Common Gap                         | Risk                                           | CSA-in-a-Box Mitigation                                                          |
| ---------------------------------- | ---------------------------------------------- | -------------------------------------------------------------------------------- |
| No centralized logging             | AU controls fail assessment                    | All resources emit to Log Analytics via Diagnostic Settings                      |
| Static credentials in code         | IA-5 violation                                 | Managed Identity + Key Vault; `allowSharedKeyAccess: false` on Storage           |
| Public-facing PaaS services        | SC-7 boundary protection gaps                  | Private Endpoints + `publicNetworkAccess: Disabled` on all data services         |
| No IaC — manual portal deployments | CM-2/CM-3 baseline and change control failures | Full Bicep IaC with git history and CI/CD what-if gates                          |
| Missing contingency plan           | CP-2 is a hard fail                            | [DR.md](../DR.md) + geo-redundant architecture provides the technical foundation |
| No vulnerability scanning          | RA-5 gap                                       | Defender Vulnerability Management + Trivy in CI pipeline                         |

!!! danger
StateRAMP requires a formal **Plan of Action and Milestones (POA&M)** for any control gaps. Do not submit for assessment with untracked gaps — the PMO will reject the package.

## Continuous monitoring obligations

After achieving StateRAMP authorization, CSPs must maintain their security posture through ongoing monitoring activities:

| Cadence   | Activity                             | Tool / Source                                  |
| --------- | ------------------------------------ | ---------------------------------------------- |
| Monthly   | Vulnerability scans (infrastructure) | Defender Vulnerability Management              |
| Monthly   | Vulnerability scans (application)    | Trivy in CI + Defender for Containers          |
| Monthly   | POA&M status update                  | GRC tool or issue tracker                      |
| Quarterly | Configuration baseline review        | `az deployment what-if` against current vs IaC |
| Quarterly | Account and access review            | Entra ID Access Reviews + PIM activation logs  |
| Annually  | Full 3PAO re-assessment              | StateRAMP-recognized 3PAO                      |
| Annually  | Contingency plan test                | [DR Drill runbook](../runbooks/dr-drill.md)    |

!!! danger
Failure to submit monthly ConMon deliverables can result in **suspension** of your StateRAMP authorization. Build these activities into your operational calendar from day one.

## Getting authorized

### Assessment process overview

1. **Preparation (2–4 months):** Engage a StateRAMP-recognized 3PAO, prepare SSP and supporting documentation, remediate gaps identified in readiness assessment.
2. **3PAO Assessment (1–3 months):** The assessor performs the security assessment against the selected baseline (Low, Moderate, or High). This includes documentation review, interviews, and technical testing.
3. **PMO Review (1–2 months):** The StateRAMP PMO reviews the 3PAO assessment package, issues findings, and requests clarification as needed.
4. **Authorization Decision:** The PMO issues a StateRAMP Ready, Provisional, or Authorized status.
5. **Continuous Monitoring:** Annual assessments and monthly vulnerability scans maintain authorization.

### Fast Track for FedRAMP holders

If your offering holds a current FedRAMP ATO, StateRAMP's **Fast Track** process allows you to submit the existing 3PAO package directly. The PMO reviews for StateRAMP-specific delta requirements — typically completed in 60–90 days.

### Estimated costs

- **3PAO assessment:** $50,000–$150,000 (Moderate baseline; significantly less than FedRAMP)
- **StateRAMP membership:** Tiered based on CSP revenue
- **Ongoing ConMon:** Annual re-assessment + monthly scan evidence

!!! tip
Start with the **StateRAMP Security Snapshot** — a lightweight self-assessment that identifies gaps before you engage a 3PAO. This can save significant assessment costs by remediating issues upfront.

## Related

- [Compliance — NIST 800-53 Rev 5](nist-800-53-rev5.md) — the underlying control set for StateRAMP
- [Compliance — FedRAMP Moderate](fedramp-moderate.md) — federal variant; reciprocity pathway
- [Compliance — SOC 2 Type II](soc2-type2.md) — often required alongside StateRAMP
- [Best Practices — Security & Compliance](../best-practices/security-compliance.md)
- [Government Service Matrix](../GOV_SERVICE_MATRIX.md) — Azure service availability per cloud
- StateRAMP official: https://stateramp.org/
- Microsoft StateRAMP: https://learn.microsoft.com/azure/compliance/offerings/offering-stateramp
