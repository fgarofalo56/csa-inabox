# Federal Migration Guide: GCP Assured Workloads to Azure Government

**A comprehensive guide for federal architects, ISSOs, and compliance officers migrating from GCP Assured Workloads to Microsoft Azure Government using CSA-in-a-Box.**

---

!!! info "Federal Focus"

    This guide addresses the unique regulatory, procurement, and security requirements that federal and DoD agencies face when migrating from GCP analytics to Azure Government. It covers the Assured Workloads vs Azure Government comparison in detail, FedRAMP High coverage gaps, Impact Level alignment, CMMC, ITAR, and agency-specific patterns.

---

## Executive summary

The single strongest forcing function for federal agencies migrating from GCP to Azure is **compliance coverage breadth**. GCP's Assured Workloads for Government provides a logical boundary within GCP's commercial infrastructure with FedRAMP authorization for a limited subset of services. Azure Government is a **physically isolated cloud** with its own datacenters, its own network backbone, and FedRAMP High authorization covering 100+ services.

For federal analytics workloads, this gap is material. A typical GCP analytics estate uses BigQuery, Dataproc, GCS, Looker, Cloud Composer, Dataflow, Pub/Sub, Data Catalog, Cloud DLP, and Vertex AI. Not all of these services carry FedRAMP High authorization through Assured Workloads, and IL5 coverage is especially narrow. On Azure Government, the equivalent services (Databricks, Fabric, ADLS, Power BI, ADF, Event Hubs, Purview, Azure OpenAI) have broad FedRAMP High and IL4/IL5 coverage.

This guide provides the detailed comparison, control mapping, and agency-specific patterns needed to build the compliance case for migration.

---

## Assured Workloads vs Azure Government -- detailed comparison

### Architectural model

| Characteristic | GCP Assured Workloads | Azure Government |
|---|---|---|
| **Isolation model** | Logical boundary within commercial GCP | Physically isolated cloud |
| **Datacenter locations** | Commercial GCP regions (US) with organizational policy enforcement | Dedicated US-only government datacenters |
| **Network backbone** | Shared with commercial GCP | Dedicated government backbone (no commercial peering) |
| **Operator screening** | Google employees with US person attestation for Assured Workloads | Screened US persons with federal background investigations |
| **Identity boundary** | Google Cloud Identity (same as commercial) | Entra ID Government (separate from commercial) |
| **Compliance responsibility** | Customer configures Assured Workloads; Google provides controls | Azure Government inherits controls; customer documents inheritance |
| **Service catalog** | Subset of GCP services (limited) | 100+ services (broad, growing quarterly) |

### What "logical isolation" vs "physical isolation" means in practice

**GCP Assured Workloads:** Your analytics workloads run in the same physical datacenters as commercial GCP workloads. Assured Workloads enforces:

- Data residency (US-only regions)
- Organization policy constraints
- Key management requirements
- Personnel access controls (US persons)

The enforcement is through software controls, not physical separation. The underlying infrastructure is shared.

**Azure Government:** Your analytics workloads run in datacenters that **only serve government customers**. The network, the storage, the compute, and the operations personnel are physically separated from commercial Azure. This is not a policy overlay -- it is a different cloud.

For agencies with stringent data handling requirements (CUI, ITAR, controlled technical information), physical isolation provides a stronger compliance posture than logical isolation.

---

## FedRAMP High coverage comparison

### GCP Assured Workloads -- FedRAMP High services (analytics-relevant)

The following GCP services carry FedRAMP High authorization through Assured Workloads (as of early 2026):

| GCP service | FedRAMP High | Notes |
|---|---|---|
| BigQuery | Yes | Core warehouse -- covered |
| GCS | Yes | Object storage -- covered |
| GKE | Yes | Container orchestration -- covered |
| Compute Engine | Yes | VM compute -- covered |
| Cloud SQL | Yes | Managed SQL -- covered |
| Cloud KMS | Yes | Key management -- covered |
| Cloud IAM | Yes | Identity -- covered |
| Cloud Logging | Yes | Logging -- covered |
| Cloud Monitoring | Yes | Monitoring -- covered |
| Dataproc | Check | Verify current status |
| Cloud Composer | Check | Verify current status |
| Dataflow | Check | Verify current status |
| Pub/Sub | Check | Verify current status |
| Looker | Check | Verify current status -- may require separate authorization |
| Data Catalog | Check | Verify current status |
| Cloud DLP | Check | Verify current status |
| Vertex AI | Limited | Some services covered; check specific endpoints |
| Vertex AI Search | Check | Verify current status |
| Cloud Functions | Check | Verify current status |

**Critical note:** "Check" means the service's FedRAMP High status through Assured Workloads should be verified against Google's current authorization boundary. This list changes; check the GCP Assured Workloads documentation for the authoritative current list.

### Azure Government -- FedRAMP High services (analytics-relevant)

| Azure service | FedRAMP High | Notes |
|---|---|---|
| Databricks | Yes | Spark analytics and ML |
| Microsoft Fabric | Preview/GA in Gov | Check current availability |
| ADLS Gen2 | Yes | Data lake storage |
| Power BI | Yes (GCC High) | Business intelligence |
| Azure Data Factory | Yes | ETL orchestration |
| Event Hubs | Yes | Event streaming |
| Azure Functions | Yes | Serverless compute |
| Azure ML | Yes | Machine learning |
| Azure OpenAI | Yes (Gov preview/GA) | LLM services |
| Azure AI Search | Yes | Enterprise search |
| Purview | Yes | Data governance |
| Key Vault | Yes | Key management |
| Azure Monitor | Yes | Monitoring and logging |
| Entra ID | Yes | Identity |
| Defender for Cloud | Yes | Security posture |
| Container Apps | Yes | Serverless containers |
| AKS | Yes | Container orchestration |
| Azure SQL | Yes | Managed SQL |

**Key difference:** The analytics-relevant service list on Azure Government is broader. Services that are "Check" status on GCP Assured Workloads are generally GA with FedRAMP High on Azure Government.

---

## Impact Level comparison

### IL4 (Controlled Unclassified Information)

| Dimension | GCP Assured Workloads | Azure Government |
|---|---|---|
| Coverage | Narrow service list at IL4 | Broad coverage in Azure Government regions |
| Data types | CUI | CUI |
| Analytics services | BigQuery, GCS covered; others may not be | Databricks, ADLS, Power BI, ADF, Purview covered |
| AI services | Limited Vertex AI coverage | Azure ML, Azure OpenAI covered |

### IL5 (Higher-sensitivity CUI / National Security)

| Dimension | GCP Assured Workloads | Azure Government DoD |
|---|---|---|
| Coverage | **Very limited** -- narrow service list | Broad coverage in Azure Government DoD regions |
| Data types | Higher-sensitivity CUI, National Security | Higher-sensitivity CUI, National Security |
| Analytics services | **Gap** -- verify each service individually | Databricks, ADLS covered |
| AI services | **Significant gap** | Azure ML, Azure OpenAI available |
| Physical isolation | Logical isolation (same commercial infra) | Dedicated DoD regions (Virginia, Iowa) |

**IL5 is the starkest compliance gap.** For DoD agencies processing National Security data through analytics pipelines, GCP's IL5 coverage is too narrow for most real-world workloads. Azure Government DoD provides the breadth needed.

### IL6 (Classified -- Secret)

| Dimension | GCP | Azure Government Secret |
|---|---|---|
| Coverage | **Not available** | Available -- air-gapped classified cloud |
| Data types | N/A | Secret / classified data |
| Analytics services | N/A | Limited but available |

GCP has no IL6 offering. If any analytics workload processes classified data, Azure Government Secret is the only hyperscaler path. (CSA-in-a-Box is out of scope for IL6; a bespoke tenant is required.)

---

## ITAR comparison

| Dimension | GCP Assured Workloads ITAR | Azure Government ITAR |
|---|---|---|
| Configuration | Assured Workloads ITAR environment | Azure Government tenant (inherits ITAR) |
| Data residency | US-only regions enforced by policy | US-only government datacenters (physical) |
| Personnel | US persons (Google-attested) | US persons (background-investigated) |
| Service coverage | Subset of GCP services | Broad Azure Government catalog |
| Export control | Customer responsibility to configure correctly | Tenant-level binding -- all data in US sovereign |

**Key distinction:** Azure Government's ITAR compliance is **tenant-level** -- once you are in Azure Government, all data is automatically within the ITAR boundary. GCP's ITAR compliance requires correct Assured Workloads configuration per project, creating operational risk if misconfigured.

---

## CMMC 2.0 mapping

For Defense Industrial Base (DIB) organizations subject to CMMC, CSA-in-a-Box provides machine-readable control mappings:

| CMMC domain | GCP approach | CSA-in-a-Box approach |
|---|---|---|
| Access Control (AC) | GCP IAM + Assured Workloads | Entra ID + Azure RBAC + Unity Catalog; mapped in `cmmc-2.0-l2.yaml` |
| Audit & Accountability (AU) | Cloud Audit Logs | Azure Monitor + tamper-evident chain (CSA-0016); mapped in `cmmc-2.0-l2.yaml` |
| Configuration Management (CM) | GCP Organization Policy | Azure Policy + Bicep IaC; mapped in `cmmc-2.0-l2.yaml` |
| Identification & Authentication (IA) | Google Cloud Identity | Entra ID + MFA + Conditional Access; mapped in `cmmc-2.0-l2.yaml` |
| Media Protection (MP) | Customer-managed | Key Vault encryption + ADLS immutability; mapped in `cmmc-2.0-l2.yaml` |
| System & Communications Protection (SC) | VPC SC + Cloud KMS | Private Endpoints + NSGs + Key Vault; mapped in `cmmc-2.0-l2.yaml` |
| System & Information Integrity (SI) | Security Command Center | Defender for Cloud + Azure Monitor; mapped in `cmmc-2.0-l2.yaml` |

**Key advantage:** CSA-in-a-Box ships the CMMC control mapping as a YAML file (`csa_platform/csa_platform/governance/compliance/cmmc-2.0-l2.yaml`) and a narrative document (`docs/compliance/cmmc-2.0-l2.md`). DIB primes inherit directly without building their own mapping.

---

## HIPAA comparison

For agencies processing Protected Health Information (IHS, VA, tribal health):

| Dimension | GCP | CSA-in-a-Box on Azure |
|---|---|---|
| BAA | Available with Google | Available with Microsoft (Azure, M365) |
| PHI classifications | Cloud DLP custom InfoTypes | Purview PHI classifications (`phi_classifications.yaml`) |
| Access controls | GCP IAM | Entra ID + Unity Catalog row filters + column masks |
| Audit logging | Cloud Audit Logs | Azure Monitor + tamper-evident audit (CSA-0016) |
| Encryption | Cloud KMS (CMEK) | Key Vault (CMEK) with HSM option |
| Reference implementation | Customer builds from scratch | `examples/tribal-health/` -- IHS worked example |

---

## FedRAMP inheritance model

### How control inheritance works on Azure Government

Azure Government holds a **FedRAMP High Provisional Authority to Operate (P-ATO)** from the Joint Authorization Board (JAB). This P-ATO covers the underlying infrastructure, identity, networking, physical security, and platform services.

When an agency deploys on Azure Government:

1. **Azure provides:** Physical security, hypervisor, network backbone, identity infrastructure, platform service controls (800+ controls inherited)
2. **CSA-in-a-Box configures:** Application-layer controls, RBAC policies, encryption settings, monitoring, data classification
3. **Agency documents:** Control inheritance in their System Security Plan (SSP), plus any customer-responsible controls

### How control inheritance works on GCP Assured Workloads

1. **Google provides:** Infrastructure controls, Assured Workloads environment controls
2. **Customer configures:** Assured Workloads environment per project, IAM, encryption, logging
3. **Customer documents:** Full control mapping including Assured Workloads configuration evidence

**Key difference:** Azure Government's inheritance model is broader because the P-ATO covers more services. The agency's ATO documentation is simpler because more controls are inherited rather than customer-configured.

### ATO timeline impact

| Phase | GCP (Assured Workloads) | Azure Government |
|---|---|---|
| Inheritable controls | Moderate (~60% of controls) | High (~80% of controls) |
| Customer-responsible controls | Higher count | Lower count |
| Evidence generation | Manual documentation | CSA-in-a-Box machine-readable compliance files |
| Typical ATO timeline | 8-14 months | 4-8 months (with CSA-in-a-Box templates) |

---

## Agency-specific patterns

### Department of Defense (DoD)

- **IL4/IL5 requirement:** Azure Government DoD provides the broadest coverage
- **CMMC requirement:** CSA-in-a-Box ships pre-built CMMC 2.0 Level 2 mapping
- **SIPRNet integration:** Azure Government Secret for classified analytics (out of CSA-in-a-Box scope)
- **DISA STIG compliance:** Azure Government resources support STIG-compliant configurations

### Intelligence Community (IC)

- **IL6 requirement:** Azure Government Secret -- no GCP equivalent
- **C2S migration:** Azure Government Top Secret
- **GCP has no equivalent** to Azure Government Secret or Top Secret

### Civilian agencies (DHS, DOJ, HHS, etc.)

- **FedRAMP High:** Azure Government covers the full analytics stack
- **FISMA:** NIST 800-53 Rev 5 controls mapped in CSA-in-a-Box
- **Privacy (SORN, PIA):** Purview classifications support PII discovery and labeling
- **Section 508:** Power BI accessibility features comply with Section 508

### Tribal governments and IHS

- **HIPAA:** CSA-in-a-Box ships PHI classifications and tribal health reference implementation
- **Tribal sovereignty:** Azure Government data residency guarantees
- **IHS worked example:** `examples/tribal-health/` demonstrates the pattern

### State and local

- **CJIS:** Azure Government holds CJIS Security Addendum
- **IRS 1075:** Azure Government is IRS 1075 compliant
- **State data residency:** Azure Government US-only datacenter guarantee

---

## Procurement considerations

### GCP procurement for federal

- Direct contract with Google Cloud
- Available on GSA Schedule
- Looker requires separate licensing (may be separate contract vehicle)
- Assured Workloads configuration is customer responsibility (risk if misconfigured)
- FDE-equivalent support: Google Cloud consulting (smaller federal practice than Microsoft)

### Azure procurement for federal

- Microsoft Enterprise Agreement (EA) through federal enrollment
- Azure Government through separate enrollment
- CSA-in-a-Box is MIT-licensed open source -- no software cost
- Partner ecosystem for implementation (broad federal SI community)
- Unified procurement: Azure + M365 + Dynamics + Power Platform on one EA

### Cost comparison note

Azure Government pricing is typically 30-40% higher than commercial Azure pricing. GCP Assured Workloads may or may not carry a premium over commercial GCP (varies by contract). Compare Azure Government prices to GCP Assured Workloads prices, not commercial prices for either.

---

## Migration compliance checklist

Before, during, and after migration, validate:

### Pre-migration

- [ ] Current GCP compliance posture documented (which controls are met, which are gaps)
- [ ] Azure Government enrollment active
- [ ] GCC High environment active (for Power BI, Power Apps, M365 integration)
- [ ] CSA-in-a-Box compliance files reviewed (`nist-800-53-rev5.yaml`, `cmmc-2.0-l2.yaml`, `hipaa-security-rule.yaml`)
- [ ] ATO sponsor identified and migration approach approved
- [ ] Data classification inventory complete (CUI, PII, PHI, ITAR, classified)

### During migration

- [ ] GCP audit logs being archived for post-migration evidence
- [ ] Azure Monitor diagnostic settings enabled for all migrated services
- [ ] Purview scans running on migrated data
- [ ] Sensitivity labels applied to CUI/PII/PHI data
- [ ] Key Vault encryption configured (CMEK)
- [ ] Private Endpoints enabled for all data services
- [ ] Unity Catalog grants match original BigQuery access patterns
- [ ] Dual-run compliance monitoring (both GCP and Azure)

### Post-migration

- [ ] SSP updated to reflect Azure Government control inheritance
- [ ] GCP Assured Workloads decommission plan approved
- [ ] GCP audit log archive retained per retention policy
- [ ] Continuous monitoring operational on Azure (Defender + Monitor)
- [ ] ATO reauthorization (if required) completed
- [ ] POA&M updated for any migration-related findings

---

## Compliance evidence files in CSA-in-a-Box

| Compliance framework | YAML mapping | Narrative document |
|---|---|---|
| NIST 800-53 Rev 5 | `csa_platform/csa_platform/governance/compliance/nist-800-53-rev5.yaml` | `docs/compliance/nist-800-53-rev5.md` |
| CMMC 2.0 Level 2 | `csa_platform/csa_platform/governance/compliance/cmmc-2.0-l2.yaml` | `docs/compliance/cmmc-2.0-l2.md` |
| HIPAA Security Rule | `csa_platform/csa_platform/governance/compliance/hipaa-security-rule.yaml` | `docs/compliance/hipaa-security-rule.md` |

These files provide machine-readable control mappings that accelerate ATO documentation. Each control references the Azure service and CSA-in-a-Box configuration that satisfies the requirement.

---

**Last updated:** 2026-04-30
**Maintainers:** CSA-in-a-Box core team
**Related:** [Why Azure over GCP](why-azure-over-gcp.md) | [Security Migration](security-migration.md) | [Migration Playbook](../gcp-to-azure.md)
