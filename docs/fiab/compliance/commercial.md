# Compliance — Azure Commercial baseline

CSA Loom in Azure Commercial inherits the Azure public-cloud
compliance baseline.

## Attestations (Azure public baseline)

| Authorization | Held |
|---|---|
| FedRAMP High | ✅ (Azure public services baseline) |
| DoD IL2 | ✅ |
| HIPAA BAA | ✅ via Microsoft Product Terms |
| ISO 27001 / 27017 / 27018 | ✅ |
| SOC 1 / 2 / 3 | ✅ |
| PCI DSS Level 1 | ✅ (per-service) |
| GDPR / EU Data Boundary | ✅ |

CSA Loom's specific Azure resource set (Databricks Premium, ADX,
Synapse, Power BI Premium, Purview, AOAI, AI Search, Container Apps,
Key Vault, ADLS Gen2, App Insights, LAW, Sentinel, APIM, Functions)
is all in scope for the above.

## Defender for Cloud coverage (Commercial baseline)

| Plan | Status |
|---|---|
| Defender for Servers | Available |
| Defender for App Service | Available |
| Defender for Storage | Available |
| Defender for SQL (Azure SQL, MySQL, PostgreSQL) | Available |
| Defender for Containers (AKS) | Available |
| Defender for Key Vault | Available |
| Defender for Resource Manager | Available |
| Defender for DNS | Available |
| Defender for APIs | Available |
| Defender for Cloud — DSPM | Available |
| Defender for Cloud — AI Threat Protection | **Available** (Commercial-only) |

CSA Loom enables Defender for Cloud AI Threat Protection by default
in Commercial deployments. Per-workload Defender plans enabled per
customer policy.

## Customer-specific controls to add

| Area | Customer action |
|---|---|
| Data classification | Apply MIP sensitivity labels via Purview |
| Network egress allow-list | Customize Azure Firewall app rules per workload |
| Per-user access reviews | Quarterly via Entra ID Access Reviews |
| Workload incident response | Customer plan + Loom runbooks |
| Backup retention | Customize ADLS lifecycle rules per workload |

## CIS Benchmarks

CSA Loom's Bicep modules align with CIS Microsoft Azure Foundations
Benchmark v2.0 controls. Per-control mapping in
`platform/fiab/bicep/compliance/cis-benchmark-mapping.md`.

## SOC 2 readiness

Customer is responsible for the SOC 2 Type II audit; CSA Loom
contributes:
- Audit logging (App Insights + LAW + Sentinel)
- Access controls (Entra + PIM)
- Change management (Bicep + Git)
- Vulnerability management (Defender for Cloud)
- Vendor management (Microsoft Azure subprocessor)

## HIPAA BAA scope

Microsoft Azure + Microsoft Power BI + Microsoft Purview are all
covered under the Microsoft Product Terms HIPAA BAA. Customer must:
- Sign Azure Enterprise Agreement or equivalent
- Classify PHI columns appropriately (sensitivity labels)
- Apply HIPAA-aligned workload-level controls (Loom does NOT
  auto-classify PHI; customer authors)
- See [HIPAA extension](hipaa-security-rule-fiab.md) for detail

## Related

- [Feature × boundary matrix](feature-boundary-matrix.md)
- [GCC](gcc.md), [GCC-High / IL4](gcc-high.md), [DoD IL5](dod-il5.md)
- Parent: [Compliance index](../../compliance/README.md)
