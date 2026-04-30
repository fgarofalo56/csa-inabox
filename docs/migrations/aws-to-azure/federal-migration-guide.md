# Federal Migration Guide: AWS GovCloud to Azure Government

**A comprehensive guide for federal architects, ISSOs, and compliance officers migrating from AWS GovCloud analytics to Microsoft Azure Government using CSA-in-a-Box.**

---

!!! info "Federal Focus"

    This guide addresses the unique regulatory, procurement, and security requirements that federal and DoD agencies face when migrating analytics workloads from AWS GovCloud to Azure Government. It covers FedRAMP inheritance, Impact Level alignment, CMMC, ITAR, procurement vehicles, and agency-specific compliance patterns.

---

## Executive summary

Federal agencies adopted AWS GovCloud analytics (Redshift, EMR, Glue, Athena, S3) for good reasons: GovCloud opened in 2011 with a three-year head start over Azure Government, and the analytics services have deep operational maturity. The decision to migrate is rarely because AWS is inadequate --- it is driven by forcing functions: an Azure-first mandate from the mission owner, tenant consolidation onto a single hyperscaler, IL5 coverage gaps for specific analytics services on GovCloud, a need for services available only in Azure Government at the required compliance tier, or a partner/prime requirement.

This guide is for federal tenants that have decided to move. It provides an honest, side-by-side comparison of AWS GovCloud and Azure Government for analytics workloads, covering compliance coverage, procurement, and agency-specific considerations.

Key differentiators driving federal migration:

- **Platform consolidation:** Most federal agencies run Microsoft 365 on Azure; consolidating analytics on the same tenant eliminates cross-cloud identity, networking, and governance complexity
- **IL5 breadth for analytics:** Azure Government provides IL5-authorized Databricks, ADLS Gen2, Power BI (GCC High), and Purview; AWS GovCloud IL5 coverage for analytics is service-dependent
- **Unified governance:** Purview + Unity Catalog + Entra ID provides a single governance plane; AWS requires stitching Lake Formation + Glue Catalog + IAM + CloudTrail
- **BI integration:** Power BI is the federal BI standard and integrates natively with Teams, SharePoint, and Copilot; QuickSight does not
- **Cost structure:** Fabric capacity-based pricing vs five independent AWS pricing models

---

## AWS GovCloud vs Azure Government comparison

### Cloud environment comparison

| Characteristic | AWS GovCloud | Azure Government |
|---|---|---|
| Launch year | 2011 | 2014 |
| US regions | 2 (US-Gov-West-1, US-Gov-East-1) | 8 (Gov VA, Gov TX, Gov AZ, DoD East, DoD Central, Secret, Top Secret) |
| Operator screening | US persons | US persons with federal background investigations |
| Network isolation | Separate from commercial AWS | Separate backbone from commercial Azure |
| FedRAMP baseline | FedRAMP High P-ATO | FedRAMP High P-ATO |
| Services available | ~180 services | ~180 services |
| Identity | AWS IAM (separate partition: `aws-us-gov`) | Entra ID Government (separate directory) |
| Support | GovCloud-cleared support | Government-cleared support engineers |
| IaC | CloudFormation / CDK / Terraform | Bicep / Terraform / ARM |
| Default encryption | SSE-S3 or SSE-KMS | Microsoft-managed or CMK via Key Vault |

### Analytics service availability comparison

| Analytics service | AWS GovCloud | Azure Government | Notes |
|---|---|---|---|
| Data warehouse | Redshift (RA3, Serverless) | Databricks SQL / Synapse | Both available |
| Spark compute | EMR (EC2, Serverless, EKS) | Databricks (Standard, Serverless) | Both available |
| ETL/orchestration | Glue (Jobs, Crawlers, Catalog) | ADF + Purview + Unity Catalog | Both available |
| Serverless SQL | Athena | Databricks SQL Serverless / Fabric SQL | Both available |
| Object storage | S3 | ADLS Gen2 / OneLake | Both available |
| Streaming | Kinesis (Data Streams, Firehose) | Event Hubs | Both available |
| Managed Kafka | MSK | Event Hubs (Kafka protocol) | Both available |
| BI tool | QuickSight | Power BI (GCC High) | Both available; Power BI has broader federal adoption |
| ML platform | SageMaker | Azure ML / Databricks ML | Both available |
| Foundation models | Bedrock (limited model availability in GovCloud) | Azure OpenAI (GPT-4o, GPT-4.1, o3 in Azure Gov) | Azure OpenAI has broader model access in Gov |
| Data catalog | Glue Data Catalog | Purview Unified Catalog | Purview adds classification, lineage, glossary |
| Data governance | Lake Formation | Purview + Unity Catalog | Unity Catalog adds column masks, row filters |
| SaaS analytics | N/A | Microsoft Fabric (GCC, GCC High roadmap) | No AWS equivalent |

---

## FedRAMP High comparison

### FedRAMP authorization model

Both AWS GovCloud and Azure Government carry FedRAMP High Provisional Authorization to Operate (P-ATO) from the Joint Authorization Board (JAB). The difference is in what the P-ATO covers.

**AWS GovCloud:** The P-ATO covers the GovCloud infrastructure and a list of authorized services. Each service has its own FedRAMP boundary. When you use Redshift + EMR + Glue + Athena + S3, your ATO package inherits controls from five service boundaries.

**Azure Government:** The P-ATO covers the Azure Government infrastructure and 200+ services under a single authorization boundary. When you use Databricks + ADF + ADLS + Purview + Power BI, your ATO package inherits controls from one platform boundary.

### Control inheritance comparison

| Control family | AWS GovCloud inheritance | Azure Government inheritance | CSA-in-a-Box value |
|---|---|---|---|
| AC (Access Control) | IAM policies per service | Entra ID + RBAC (unified) | Pre-mapped in `nist-800-53-rev5.yaml` |
| AU (Audit) | CloudTrail + CloudWatch per service | Azure Monitor (unified) + tamper-evident chain | CSA-0016 tamper-evident audit |
| CM (Configuration Management) | AWS Config per service | Azure Policy (unified) | Bicep modules enforce configuration |
| IA (Identification and Authentication) | IAM per partition | Entra ID (unified, Conditional Access) | Pre-configured in landing zone |
| SC (System and Communications Protection) | VPC + KMS per service | VNet + Key Vault + Private Endpoints | Private Endpoint patterns in Bicep |
| SI (System and Information Integrity) | GuardDuty + Inspector per service | Defender for Cloud (unified) | Diagnostic settings enforced |

**ATO acceleration:** CSA-in-a-Box ships machine-readable control mappings in `csa_platform/csa_platform/governance/compliance/nist-800-53-rev5.yaml` that document exactly how each NIST 800-53 Rev 5 control is met by the platform. This reduces ATO documentation effort from weeks to days for the platform layer.

Cross-reference: `docs/compliance/nist-800-53-rev5.md` for the narrative control mapping.

---

## DoD Impact Level analysis

### IL4 (Controlled Unclassified Information)

| Dimension | AWS GovCloud | Azure Government | Notes |
|---|---|---|---|
| Coverage | Most analytics services | Most analytics services | Parity |
| Data types | CUI, FOUO, SBU | CUI, FOUO, SBU | Same data types |
| Encryption at rest | KMS CMK (AES-256) | Key Vault CMK (AES-256) | Parity |
| Encryption in transit | TLS 1.2+ | TLS 1.2+ | Parity |
| Physical isolation | GovCloud regions (US-only) | Gov regions (US-only) | Parity |

**Assessment:** IL4 is at parity between AWS GovCloud and Azure Government for analytics workloads. The choice should be driven by operational factors, not compliance.

### IL5 (National Security Information)

| Dimension | AWS GovCloud | Azure Government | Notes |
|---|---|---|---|
| Coverage | **Service-dependent**; check IL5 boundary list per service | DoD regions (East, Central) authorized at IL5 | Azure broader for analytics |
| Redshift / Databricks | Redshift: verify against AWS IL5 list | Databricks: IL5 authorized in Gov DoD regions | Check AWS coverage |
| EMR / Databricks | EMR: verify against AWS IL5 list | Databricks: IL5 authorized | Check AWS coverage |
| Glue / ADF+Purview | Glue: verify against AWS IL5 list | ADF + Purview: IL5 authorized | Check AWS coverage |
| S3 / ADLS Gen2 | S3: IL5 authorized in GovCloud | ADLS Gen2: IL5 authorized | Parity |
| QuickSight / Power BI | QuickSight: verify IL5 coverage | Power BI: GCC High (IL5) | Power BI in GCC High |
| SageMaker / Azure ML | SageMaker: verify IL5 coverage | Azure ML: IL5 authorized | Check AWS coverage |
| Bedrock / Azure OpenAI | Bedrock: limited model availability | Azure OpenAI: available in Gov (check IL5) | Azure broader model access |

**Assessment:** Azure Government provides broader IL5 coverage for analytics services. The critical action for AWS GovCloud agencies is to check every analytics service against the current AWS IL5 service boundary list before assuming coverage. The AWS IL5 list is updated quarterly.

**Cross-reference:** `docs/GOV_SERVICE_MATRIX.md` for the live Azure Government service coverage matrix.

### IL6 (Classified / Secret)

| Dimension | AWS Top Secret Region | Azure Government Secret | Notes |
|---|---|---|---|
| Availability | Production since 2021 | Available (limited service catalog) | AWS more mature |
| Analytics services | Broader analytics service coverage | Narrower analytics service catalog | AWS leads for IL6 analytics |
| Air gap | Full air gap | Full air gap | Parity on isolation |
| Personnel | TS/SCI cleared | TS/SCI cleared | Parity |

**Assessment:** For IL6 analytics workloads, AWS Top Secret Region remains the safer choice. CSA-in-a-Box does not cover IL6. Agencies with IL6 requirements should keep those specific workloads on AWS while moving IL4/IL5 analytics to Azure. This hybrid approach is explicitly supported --- OneLake shortcuts and Delta Sharing enable cross-cloud data access where classification boundaries allow.

---

## CMMC 2.0 implications

### CMMC alignment for analytics migration

The Cybersecurity Maturity Model Certification (CMMC) 2.0 applies to Defense Industrial Base (DIB) organizations handling Controlled Unclassified Information (CUI). Analytics platforms that process CUI must meet CMMC Level 2 requirements (110 NIST SP 800-171 practices).

| CMMC domain | AWS GovCloud approach | Azure Government + CSA-in-a-Box | Notes |
|---|---|---|---|
| Access Control (AC) | IAM + Lake Formation | Entra ID + Unity Catalog + RBAC; mapped in `cmmc-2.0-l2.yaml` | Pre-mapped controls |
| Audit and Accountability (AU) | CloudTrail + CloudWatch | Azure Monitor + tamper-evident audit chain | CSA-0016 |
| Configuration Management (CM) | AWS Config + CloudFormation | Azure Policy + Bicep; enforced at deployment | IaC-driven compliance |
| Identification and Authentication (IA) | IAM + MFA | Entra ID + Conditional Access + MFA | Unified identity |
| Media Protection (MP) | S3 encryption (KMS) | ADLS encryption (Key Vault CMK) | Parity |
| System and Communications Protection (SC) | VPC + TLS + KMS | VNet + Private Endpoints + TLS + Key Vault | Zero-trust networking |

**CSA-in-a-Box advantage:** CMMC control mappings ship as machine-readable YAML (`csa_platform/csa_platform/governance/compliance/cmmc-2.0-l2.yaml`) with narrative documentation (`docs/compliance/cmmc-2.0-l2.md`). DIB primes building on CSA-in-a-Box inherit these mappings directly, reducing CMMC assessment preparation effort.

---

## ITAR considerations

International Traffic in Arms Regulations (ITAR) require that controlled technical data be stored and processed in the United States by US persons.

| ITAR requirement | AWS GovCloud | Azure Government | Notes |
|---|---|---|---|
| US-only data residency | GovCloud regions (US-only) | Gov regions (US-only) | Parity |
| US persons operations | GovCloud operated by US persons | Gov operated by US persons with background checks | Parity |
| Tenant isolation | Separate AWS partition | Separate Azure tenant (GCC High) | Both provide isolation |
| ITAR-compliant storage | S3 in GovCloud | ADLS Gen2 in Azure Government | Parity |
| ITAR-compliant compute | Redshift/EMR in GovCloud | Databricks in Azure Government | Parity |

**Migration note:** ITAR data must remain in US-sovereign infrastructure throughout the migration. Use ExpressRoute (not public internet) for data transfer from AWS GovCloud to Azure Government. Azure Data Box is an alternative for large volumes that avoids network transfer entirely.

---

## Procurement comparison

### Contract vehicles

| Vehicle | AWS GovCloud | Azure Government | Notes |
|---|---|---|---|
| SEWP V | Available | Available | NASA GWAC; popular for cloud procurement |
| 2GIT | Available (resellers) | Available (resellers) | GSA GWAC for IT products |
| GSA MAS | Available (resellers) | Available (resellers) | Multiple Award Schedule |
| Enterprise Agreement | No AWS EA equivalent; Enterprise Discount Program (EDP) | Microsoft EA (annual commitment, true-up) | EA provides predictable pricing |
| CSP | AWS Marketplace resellers | Azure CSP (managed billing) | CSP provides partner management |
| Direct | AWS direct contract | Microsoft direct contract | Large agency engagements |
| DEOS | N/A | Available (DoD Enterprise Office Solution) | DoD-specific for Microsoft services |

### Pricing model comparison for procurement

| Factor | AWS GovCloud | Azure Government | Notes |
|---|---|---|---|
| Commitment model | EDP (1-3 year, % discount) | EA (1-3 year, commitment + consumption) | EA more flexible |
| Reserved pricing | RIs per service (Redshift, EC2, etc.) | Azure Reservations (VMs, Databricks, Cosmos) | Azure reservations simpler |
| Savings Plans | Compute Savings Plans (cross-instance-family) | No direct equivalent; EA commitment discount | Different approach |
| On-demand pricing | Higher per-service rates | Consumption-based; single bill | Fewer pricing dimensions |
| Spot/preemptible | Spot Instances (EMR) | Azure Spot VMs (Databricks) | Both available |
| Free tier | Limited in GovCloud | Limited in Azure Government | Both minimal |
| FinOps tooling | AWS Cost Explorer + Budgets | Azure Cost Management + Advisor | Both included |

### Budget planning for migration

```
┌─────────────────────────────────────────────────────────┐
│ AWS GovCloud analytics spend (current)                  │
│ ├── Redshift: $XXX,XXX/year                             │
│ ├── EMR: $XXX,XXX/year                                  │
│ ├── Glue: $XXX,XXX/year                                 │
│ ├── Athena: $XX,XXX/year                                │
│ ├── S3: $XX,XXX/year                                    │
│ ├── QuickSight: $XX,XXX/year                            │
│ └── Total: $X,XXX,XXX/year                              │
├─────────────────────────────────────────────────────────┤
│ Azure Government analytics spend (target)               │
│ ├── Databricks: $XXX,XXX/year                           │
│ ├── Fabric / Power BI: $XXX,XXX/year                    │
│ ├── ADF: $XX,XXX/year                                   │
│ ├── ADLS Gen2: $XX,XXX/year                             │
│ ├── Purview + monitoring: $XX,XXX/year                  │
│ └── Target: $X,XXX,XXX/year (25-50% reduction)         │
├─────────────────────────────────────────────────────────┤
│ Migration investment (one-time)                         │
│ ├── Planning + architecture: $XXX,XXX                   │
│ ├── Migration execution: $XXX,XXX                       │
│ ├── Cross-cloud egress: $XX,XXX                         │
│ └── Total: $XXX,XXX (recoverable in 6-12 months)       │
└─────────────────────────────────────────────────────────┘
```

For detailed cost analysis, see [TCO Analysis](tco-analysis.md).

---

## Agency-specific considerations

### Department of Defense (DoD)

- **IL5 requirement:** Most DoD analytics workloads require IL5 or higher. Azure Government DoD regions provide IL5 authorization for Databricks, ADLS Gen2, and Power BI (GCC High).
- **DEOS contract:** DoD agencies can procure Azure Government and Microsoft 365 GCC High through the DEOS contract vehicle, simplifying procurement.
- **JWCC:** Joint Warfighting Cloud Capability provides access to all major cloud providers including Azure at IL2-IL6.
- **IL6 hybrid:** Keep classified workloads on AWS Top Secret Region; move IL4/IL5 analytics to Azure Government. OneLake shortcuts support cross-cloud reads where classification allows.

### Intelligence Community (IC)

- **CSA-in-a-Box scope:** CSA-in-a-Box does not cover IC-specific requirements (ICD 503, Top Secret/SCI). IC workloads requiring Top Secret cloud should remain on AWS C2S/Secret Region or Azure Government Top Secret.
- **Unclassified analytics:** IC agencies with unclassified or CUI analytics workloads can use Azure Government with CSA-in-a-Box at IL4/IL5.

### Civilian agencies (CFO Act agencies)

- **Microsoft 365 consolidation:** Most civilian agencies run Microsoft 365 on Azure. Consolidating analytics on Azure eliminates cross-cloud identity management and networking.
- **FedRAMP High sufficiency:** Most civilian analytics workloads require FedRAMP High, not IL5. Both AWS GovCloud and Azure Government meet this requirement. The differentiator is operational simplification and Microsoft ecosystem integration.
- **FinOps simplification:** Civilian agencies with 5-10 person data teams benefit most from Azure's simpler pricing model (fewer billing dimensions to manage).
- **Power BI mandate:** Many civilian agencies have standardized on Power BI through their M365 EA. Migrating analytics to Azure enables Direct Lake mode, eliminating the import/refresh cycle.

### Tribal and territorial governments

- **Sovereignty considerations:** Tribal data sovereignty requires that data remain under tribal control. Both AWS GovCloud and Azure Government provide US-only data residency.
- **CSA-in-a-Box reference:** `examples/tribal-health/` provides a worked implementation for HHS/IHS scenarios.
- **HIPAA:** Healthcare analytics for tribal health requires HIPAA Security Rule compliance. CSA-in-a-Box maps HIPAA controls in `csa_platform/csa_platform/governance/compliance/hipaa-security-rule.yaml`.

---

## ATO transition strategies

### Approach 1: New system ATO (cleanest)

1. Create a new ATO package for the Azure Government analytics platform.
2. Inherit 800+ controls from Azure Government P-ATO.
3. Use CSA-in-a-Box control mappings (NIST 800-53, CMMC, HIPAA) as evidence.
4. Platform ATO covers Databricks, ADF, ADLS, Purview, Power BI.
5. Application-level controls documented per mission system.
6. **Timeline:** 2-4 months for platform ATO (with CSA-in-a-Box accelerators).

### Approach 2: ATO amendment (preserves existing)

1. Keep existing AWS GovCloud ATO active during migration.
2. Submit an ATO amendment to add Azure Government as an authorized environment.
3. During dual-run period, both ATOs are active.
4. After full migration, retire the AWS GovCloud ATO.
5. **Timeline:** 4-6 months (amendment process varies by agency).

### Approach 3: Reciprocity-based (fastest)

1. Leverage FedRAMP reciprocity: Azure Government's P-ATO is accepted by the agency.
2. Focus ATO effort on agency-specific controls and application-layer security.
3. CSA-in-a-Box YAML mappings serve as pre-built evidence for inherited controls.
4. **Timeline:** 1-2 months for agencies that accept FedRAMP reciprocity.

### Preserving AWS audit evidence during migration

Critical for post-migration audits:

1. **Archive CloudTrail logs** to S3 with lifecycle policy (retain 7+ years for federal records).
2. **Export Redshift query history** (`STL_QUERYTEXT`, `STL_QUERY`) before cluster decommission.
3. **Export S3 access logs** before bucket deletion.
4. **Export Lake Formation audit logs** for data access history.
5. **Export IAM credential reports** for identity baseline documentation.
6. **Store all exports** in a dedicated archive S3 bucket with Glacier Deep Archive and Object Lock (WORM) for compliance retention.

---

## Migration sequence for federal

| Phase | Duration | Federal-specific activities |
|---|---|---|
| 0. Compliance review | 2-3 weeks | Map compliance requirements to Azure Gov; verify IL5 coverage; identify IL6 workloads |
| 1. ATO preparation | 2-4 weeks | Choose ATO strategy; prepare SSP amendment or new package; engage ISSO |
| 2. Landing zone deployment | 4-6 weeks | Deploy CSA-in-a-Box DMLZ/DLZ in Azure Gov; configure Private Endpoints; STIG hardening |
| 3. Identity migration | 2-3 weeks | Configure Entra ID groups; map IAM roles to RBAC; deploy managed identities |
| 4. Data migration | 8-16 weeks | S3 to ADLS via ExpressRoute or Data Box; OneLake shortcuts for bridge |
| 5. Compute migration | 8-16 weeks | Redshift/EMR/Glue/Athena to Databricks/ADF/dbt |
| 6. BI migration | 4-6 weeks | QuickSight to Power BI GCC High |
| 7. Validation | 2-4 weeks | Dual-run; data parity; security scan; penetration test |
| 8. ATO authorization | 2-6 weeks | Final ATO review; authorization to operate on Azure Gov |
| 9. Decommission | 2-4 weeks | Archive AWS audit logs; decommission resources; final cost reconciliation |

---

## Compliance documentation provided by CSA-in-a-Box

| Document | Path | Description |
|---|---|---|
| NIST 800-53 Rev 5 YAML | `csa_platform/csa_platform/governance/compliance/nist-800-53-rev5.yaml` | Machine-readable control mapping |
| NIST 800-53 Rev 5 narrative | `docs/compliance/nist-800-53-rev5.md` | Human-readable control evidence |
| CMMC 2.0 Level 2 YAML | `csa_platform/csa_platform/governance/compliance/cmmc-2.0-l2.yaml` | DIB-specific control mapping |
| CMMC 2.0 Level 2 narrative | `docs/compliance/cmmc-2.0-l2.md` | DIB-specific evidence |
| HIPAA Security Rule YAML | `csa_platform/csa_platform/governance/compliance/hipaa-security-rule.yaml` | Healthcare control mapping |
| HIPAA Security Rule narrative | `docs/compliance/hipaa-security-rule.md` | Healthcare evidence |
| Government Service Matrix | `docs/GOV_SERVICE_MATRIX.md` | Azure Government service-level IL coverage |

---

**Last updated:** 2026-04-30
**Maintainers:** CSA-in-a-Box core team
**Related:** [Migration Center](index.md) | [Security Migration](security-migration.md) | [Why Azure over AWS](why-azure-over-aws.md) | [Migration Playbook](../aws-to-azure.md)
