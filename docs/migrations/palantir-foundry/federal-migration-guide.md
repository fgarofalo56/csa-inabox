# Federal Migration Guide: Palantir Foundry to Azure Government

**A comprehensive guide for federal architects, ISSOs, and compliance officers migrating from Palantir Foundry to Microsoft Azure Government using CSA-in-a-Box.**

---

!!! info "Federal Focus"

    This guide addresses the unique regulatory, procurement, and security requirements that federal and DoD agencies face when migrating off Palantir Foundry. It covers FedRAMP inheritance, Impact Level alignment, CMMC, ITAR, and agency-specific compliance patterns.

---

## Executive summary

Federal agencies adopted Palantir Foundry for its integrated analytics platform and rapid deployment capabilities. However, as data platform requirements mature, agencies increasingly encounter structural limitations: Foundry's FedRAMP authorization covers a single service boundary, its per-seat pricing penalizes data democratization, and its proprietary stack creates deep vendor lock-in that conflicts with federal open-data mandates and competitive procurement requirements.

Microsoft Azure Government offers a fundamentally different model. With 200+ services carrying FedRAMP High authorization, physical isolation in US-only datacenters operated by screened US persons, and compliance coverage spanning IL4 through IL6, Azure Government provides a broader, more flexible foundation for federal data platforms. Agencies inherit 800+ NIST 800-53 controls from Azure's Platform-as-a-Service authorization, reducing ATO timelines from 12–18 months to as few as 2–4 months for new workloads.

CSA-in-a-Box accelerates this migration by providing pre-built compliance templates, reference architectures, and deployment automation specifically designed for federal environments. The result is a migration path that reduces total cost of ownership by 40–60%, eliminates single-vendor lock-in, expands the available cleared workforce from a narrow Palantir talent pool to the broad Azure ecosystem, and positions agencies for future capabilities like Microsoft Fabric and Azure OpenAI Service in Government regions.

Key differentiators driving federal migration:

- **FedRAMP inheritance breadth:** Azure Government's P-ATO covers 200+ services vs Foundry's single-service authorization
- **Azure Government reach:** Dedicated regions for IL4, IL5, and IL6 (Secret) with physical isolation
- **Cost model:** Consumption-based pricing scales with workload, not headcount
- **Talent pool:** 300,000+ Azure-certified professionals vs a small pool of Foundry-trained engineers
- **Open standards:** Delta Lake, Parquet, dbt, REST APIs --- no proprietary lock-in
- **AI readiness:** Azure OpenAI Service availability in Government regions for responsible AI in federal contexts

---

## Azure Government capabilities

### Azure Government vs Azure Commercial

Azure Government is a physically isolated instance of Microsoft Azure built exclusively for US federal, state, local, and tribal governments and their partners. It is not a "feature flag" on commercial Azure --- it is a separate cloud with dedicated infrastructure, separate identity boundaries, and independent compliance certifications.

| Characteristic | Azure Commercial | Azure Government |
|---|---|---|
| Datacenter locations | 60+ regions globally | 8 US-only regions (Gov, DoD, Secret, Top Secret) |
| Operator screening | Standard background checks | US persons with federal background investigations |
| Network isolation | Shared backbone | Dedicated backbone, no peering with commercial |
| Compliance baseline | SOC 1/2, ISO 27001 | FedRAMP High, DoD IL4/IL5, CJIS, IRS 1075 |
| Identity boundary | Azure AD commercial | Azure AD Government (separate directory) |
| Service availability | Full catalog (200+ services) | ~180 services (growing quarterly) |
| Support | Standard Microsoft support | Government-cleared support engineers |

### Government regions and classification levels

Azure Government operates across four tiers of regions aligned to data classification:

- **Azure Government (Virginia, Texas, Arizona):** FedRAMP High, DoD IL4, suitable for CUI and most civilian agency workloads
- **Azure Government DoD (Virginia, Iowa):** DoD IL5, dedicated to Department of Defense workloads requiring National Security designation
- **Azure Government Secret:** IL6, for classified (Secret) workloads, air-gapped and operated by cleared personnel
- **Azure Government Top Secret:** For Top Secret workloads, fully isolated with SCI-level controls

### GCC, GCC High, and DoD environments

Microsoft 365 and Power Platform use separate environment designations that align with Azure Government regions:

- **GCC (Government Community Cloud):** Hosted in commercial datacenters with logical separation; FedRAMP Moderate; suitable for non-CUI government data
- **GCC High:** Hosted in Azure Government datacenters; FedRAMP High, ITAR-compliant; required for CUI, ITAR, and DoD data
- **DoD:** Hosted in Azure Government DoD regions; IL5 certified; exclusive to Department of Defense

Power BI, Power Apps, and Dynamics 365 availability varies by environment. GCC High is required for any workload processing CUI or operating under DFARS 252.204-7012.

### Physical isolation and compliance boundaries

Azure Government's isolation model provides guarantees that commercial cloud cannot:

- All datacenters are located within the continental United States
- All operations personnel are screened US persons (US citizens or US nationals)
- Network traffic never traverses commercial Azure backbone infrastructure
- Storage replication occurs exclusively between Government regions
- Customer lockbox and customer-managed encryption keys are available for all data-at-rest
- Azure Government holds its own FedRAMP High P-ATO, independent of commercial Azure

---

## FedRAMP inheritance model

### How FedRAMP works

The Federal Risk and Authorization Management Program (FedRAMP) standardizes security assessment for cloud services. Two authorization paths exist:

- **JAB P-ATO (Provisional Authority to Operate):** Issued by the Joint Authorization Board (DoD, DHS, GSA). Indicates the CSP meets FedRAMP High, Moderate, or Low baseline. Agencies can inherit this authorization rather than starting from scratch.
- **Agency ATO:** Issued by an individual agency's Authorizing Official. Can leverage a P-ATO as foundation, adding agency-specific controls on top.

The critical difference for migration planning: inheriting a P-ATO dramatically reduces the number of controls an agency must independently assess and authorize.

### Azure Government's FedRAMP High baseline

Azure Government holds a FedRAMP High P-ATO covering 200+ services. At the FedRAMP High baseline (NIST 800-53 Rev 5), this means:

- **800+ controls inherited:** Azure's P-ATO addresses the vast majority of FedRAMP High controls at the platform level
- **Physical and environmental controls (PE family):** Fully inherited --- agencies do not need to assess datacenter physical security
- **System and communications protection (SC family):** Encryption in transit (TLS 1.2+), encryption at rest (AES-256), key management --- all inherited
- **Audit and accountability (AU family):** Azure Monitor, Activity Logs, and Diagnostic Logs provide inherited audit capabilities
- **Incident response (IR family):** Microsoft's Security Response Center provides inherited incident detection and response
- **Contingency planning (CP family):** Azure's geo-redundant infrastructure provides inherited disaster recovery and continuity

### Foundry FedRAMP vs Azure FedRAMP: scope comparison

| Dimension | Palantir Foundry FedRAMP | Azure Government FedRAMP |
|---|---|---|
| Authorization scope | Single platform (Foundry) | 200+ individual services |
| Baseline | FedRAMP Moderate (IL4 varies by deployment) | FedRAMP High |
| Controls inherited | ~300 controls for Foundry only | 800+ controls across all authorized services |
| Additional services | Each requires separate assessment | Pre-authorized within the P-ATO boundary |
| Adding new capabilities | May require ATO amendment | Already covered if service is in P-ATO scope |
| Assessment frequency | Annual (3PAO assessment) | Continuous monitoring + annual assessment |
| Transparency | Limited to Foundry's package | Full SSP, CRM, and control documentation available |

When agencies build data platforms on Foundry, their ATO covers Foundry alone. Adding Azure Cognitive Services, Power BI, or a separate database requires additional ATO work. On Azure Government, all 200+ services under the P-ATO are pre-authorized --- agencies can adopt new services without ATO amendments, provided the services remain within the P-ATO boundary.

### Inherited vs shared vs customer responsibility

FedRAMP uses a shared responsibility model with three categories:

- **Fully inherited:** The CSP is entirely responsible. Agencies document the inheritance and move on. Examples: physical security, hypervisor patching, network backbone encryption.
- **Shared:** Both CSP and agency have responsibilities. Examples: identity management (Azure provides Entra ID; agency configures policies), logging (Azure provides the platform; agency defines retention and alerting).
- **Customer responsibility:** The agency is fully responsible. Examples: application-level access control, data classification, user training.

Azure Government publishes a detailed Customer Responsibility Matrix (CRM) for every service. CSA-in-a-Box provides pre-populated CRM templates that map Azure's inheritance to NIST 800-53 controls, reducing documentation effort by 60–80%.

### ATO acceleration with CSA-in-a-Box

CSA-in-a-Box includes compliance YAML definitions that map directly to NIST 800-53 control families. These templates:

1. Pre-populate System Security Plans (SSPs) with Azure's inherited control implementations
2. Generate control implementation statements for shared-responsibility controls
3. Produce evidence artifacts from Azure Policy compliance reports
4. Map Azure Defender for Cloud recommendations to specific NIST controls
5. Automate continuous monitoring dashboards aligned to FedRAMP ConMon requirements

### Practical steps to leverage Azure's FedRAMP inheritance

1. **Obtain Azure's FedRAMP package** from the FedRAMP Marketplace or your Microsoft Government account team
2. **Map your system boundary** to Azure Government services, identifying which services are within P-ATO scope
3. **Use CSA-in-a-Box compliance templates** to pre-populate your SSP with inherited control implementations
4. **Focus assessment effort** on customer-responsible and shared controls only
5. **Implement Azure Policy** to enforce FedRAMP High baseline configurations automatically
6. **Configure Defender for Cloud** regulatory compliance dashboard for FedRAMP High
7. **Engage your 3PAO** with pre-built evidence packages, reducing assessment duration from months to weeks

---

## Impact Level coverage (IL4/IL5/IL6)

### DoD IL4 --- Controlled Unclassified Information (CUI)

DoD Impact Level 4 covers Controlled Unclassified Information (CUI) and is the baseline for most DoD unclassified workloads.

- **Azure region:** Azure Government (Virginia, Texas, Arizona)
- **Authorization:** FedRAMP High + DoD SRG IL4
- **Services available:** 180+ services including Synapse Analytics, Data Factory, Power BI, Azure SQL, Cosmos DB, Azure Kubernetes Service, and Azure Machine Learning
- **Network requirements:** ExpressRoute with Microsoft peering or site-to-site VPN; no internet-facing data endpoints required
- **Encryption:** AES-256 at rest, TLS 1.2+ in transit, customer-managed keys available via Azure Key Vault

IL4 is where most Foundry-to-Azure migrations begin. The service catalog is broad enough to replicate the full Foundry data platform with native Azure services.

### DoD IL5 --- CUI and National Security Information

IL5 adds National Security Information (NSI) to the CUI baseline, requiring additional isolation guarantees.

- **Azure region:** Azure Government DoD (Virginia, Iowa) or Azure Government with dedicated infrastructure
- **Authorization:** FedRAMP High + DoD SRG IL5
- **Services available:** ~150 services; some services available in IL4 may not yet be certified at IL5
- **Key difference from IL4:** Logical or physical separation from non-DoD tenants; storage and compute isolation
- **Network requirements:** ExpressRoute with private peering; NIPRNet connectivity supported
- **Use cases:** DoD mission applications, defense logistics, personnel systems, National Security Systems (NSS)

Foundry deployments operating at IL5 typically run on dedicated Palantir infrastructure managed by Forward Deployed Engineers. Azure Government DoD provides equivalent isolation without requiring vendor-embedded engineers, shifting operational control to the agency.

### DoD IL6 --- Classified (Secret)

IL6 covers classified information up to the Secret level.

- **Azure region:** Azure Government Secret
- **Authorization:** DoD SRG IL6, operated under ICD 503 and CNSSI 1253
- **Services available:** Core IaaS and PaaS services; catalog is smaller than IL4/IL5 but expanding
- **Physical isolation:** Air-gapped datacenter regions with no connectivity to unclassified networks
- **Operator clearance:** All operations personnel hold Secret clearance or higher
- **Network:** SIPRNet connectivity; classified cross-domain solutions available

### How Palantir handles IL levels vs Azure

| Aspect | Palantir Foundry | Azure Government |
|---|---|---|
| IL4 deployment | Foundry on AWS GovCloud or Azure Gov (managed by Palantir) | Native Azure Government services |
| IL5 deployment | Dedicated Foundry instance, FDE-managed | Azure Government DoD regions, agency-managed |
| IL6 deployment | Foundry on classified networks (limited availability) | Azure Government Secret (growing service catalog) |
| Operational model | Palantir-managed (FDEs required) | Agency-managed or partner-managed (no vendor lock-in) |
| Service expansion | Limited to Foundry capabilities | 150–200 services per IL level |
| Multi-IL architecture | Separate Foundry instances per IL | Cross-IL patterns with Azure Arc and cross-domain solutions |

### Network isolation patterns per Impact Level

```
                    ┌─────────────────────────────┐
  Internet ────────►│  Azure Government (IL4)     │
  ExpressRoute ────►│  FedRAMP High + DoD SRG     │
                    └──────────┬──────────────────┘
                               │ Cross-region replication
                    ┌──────────▼──────────────────┐
  NIPRNet ─────────►│  Azure Gov DoD (IL5)        │
  ExpressRoute ────►│  Dedicated compute/storage  │
                    └──────────┬──────────────────┘
                               │ Cross-domain solution
                    ┌──────────▼──────────────────┐
  SIPRNet ─────────►│  Azure Gov Secret (IL6)     │
                    │  Air-gapped, cleared ops    │
                    └─────────────────────────────┘
```

---

## CMMC 2.0 compliance

### CMMC levels and requirements

The Cybersecurity Maturity Model Certification (CMMC) 2.0 streamlines the original five-level model into three levels aligned with existing NIST standards:

| CMMC Level | Practices | Assessment | Applicable standard |
|---|---|---|---|
| Level 1 (Foundational) | 17 practices | Annual self-assessment | FAR 52.204-21 |
| Level 2 (Advanced) | 110 practices | Triennial C3PAO assessment | NIST SP 800-171 Rev 2 |
| Level 3 (Expert) | 110+ practices + enhanced | Government-led assessment | NIST SP 800-172 |

CMMC Level 2 is the threshold for any contractor handling CUI and is the most common certification target in the Defense Industrial Base (DIB).

### How Azure and CSA-in-a-Box accelerate CMMC certification

Azure Government and Microsoft 365 GCC High provide built-in capabilities that address a significant portion of CMMC Level 2 practices:

- **Access Control (AC):** Entra ID Conditional Access, MFA, Privileged Identity Management map directly to AC practices
- **Audit and Accountability (AU):** Azure Monitor, Log Analytics, and Sentinel address AU practices for event logging and analysis
- **Configuration Management (CM):** Azure Policy, Azure Automation, and Desired State Configuration enforce CM practices
- **Identification and Authentication (IA):** Entra ID with FIDO2, certificate-based auth, and CAC/PIV support covers IA practices
- **System and Communications Protection (SC):** Azure Firewall, NSGs, Private Link, and encryption services address SC practices

CSA-in-a-Box adds CMMC-specific value through:

1. Pre-built Azure Policy initiatives mapped to each CMMC Level 2 practice
2. Compliance workbooks in Sentinel that track CMMC practice implementation status
3. Evidence collection automation for C3PAO assessments
4. Gap analysis templates that compare current Azure configuration against CMMC requirements

### Microsoft's CMMC posture

Microsoft is pursuing its own CMMC Level 3 certification for Azure Government and Microsoft 365 GCC High. This means:

- Microsoft's cloud services will carry their own CMMC certification, allowing inheritance
- Agencies and DIB contractors can inherit cloud-layer CMMC practices from Microsoft
- CSA-in-a-Box compliance templates will map inherited practices vs customer practices once CMMC certifications are issued

### Comparison to Palantir's CMMC capabilities

Palantir has not publicly disclosed CMMC certification timelines for Foundry. Organizations using Foundry for CUI workloads must independently demonstrate CMMC compliance for the Foundry platform layer --- a significant assessment burden. Azure Government's CMMC certification path provides a clearer inheritance model, reducing the scope of what organizations must independently certify.

---

## HIPAA considerations

### BAA coverage in Azure Government

Microsoft provides a HIPAA Business Associate Agreement (BAA) covering Azure Government services. Key points for agencies handling Protected Health Information (PHI):

- The BAA covers 80+ Azure Government services, including Azure SQL Database, Azure Storage, Azure Kubernetes Service, Azure Data Factory, and Power BI
- Azure Government meets HIPAA Security Rule requirements for administrative, physical, and technical safeguards
- Encryption at rest (AES-256) and in transit (TLS 1.2+) satisfies the encryption addressable specification
- Azure Monitor and Defender for Cloud provide audit trail capabilities required by the HIPAA Security Rule
- Microsoft will sign the BAA at no additional cost as part of standard Government licensing

### PHI handling patterns on Azure Government

For agencies migrating Foundry workloads that process PHI (HHS, CDC, VA, CMS):

- **Data classification:** Use Microsoft Purview sensitivity labels to tag PHI data automatically
- **Access control:** Implement attribute-based access control (ABAC) with Entra ID for PHI-scoped permissions
- **Encryption:** Deploy customer-managed keys in Azure Key Vault (FIPS 140-2 Level 3 validated HSMs)
- **Audit logging:** Route all PHI access events through Azure Monitor to Log Analytics with 7-year retention
- **Data residency:** Azure Government guarantees all PHI remains within US boundaries
- **Breach notification:** Integrate Defender for Cloud alerts with agency incident response workflows

### Comparison to Foundry HIPAA capabilities

Foundry's HIPAA compliance depends on the specific deployment model (Palantir-hosted vs agency-hosted) and requires a separate BAA with Palantir. Foundry's audit capabilities are limited to the Foundry platform; there is no native PHI classification engine or sensitivity labeling system. Azure provides end-to-end PHI lifecycle management through integrated services (Purview, Defender, Monitor) that extend beyond the data platform to cover the entire organizational data estate.

---

## ITAR/EAR compliance

### Export control requirements

The International Traffic in Arms Regulations (ITAR) and Export Administration Regulations (EAR) restrict access to defense-related technical data and dual-use technologies. Cloud platforms handling ITAR/EAR data must guarantee:

- Data is stored exclusively within the United States
- Access is limited to US persons (US citizens, permanent residents, or protected individuals)
- No foreign national access to ITAR-controlled data, including cloud operator access
- Technical data does not traverse networks outside US jurisdiction

### Azure Government ITAR boundary

Azure Government and Microsoft 365 GCC High are specifically designed for ITAR compliance:

- **Data residency:** All data at rest and in transit remains within continental US datacenters
- **Personnel screening:** All operations and support personnel are screened US persons
- **Access controls:** Azure Government's identity boundary is separate from commercial Azure --- no foreign subsidiary employees have access to Government tenant infrastructure
- **Customer lockbox:** Any Microsoft support access to customer data requires explicit approval from US-person support engineers
- **Contractual guarantees:** Microsoft provides ITAR compliance commitments in the Azure Government Online Services Terms

### Data residency guarantees

Azure Government provides contractual and technical data residency guarantees:

- Storage replication occurs exclusively between US Government regions
- Backup and disaster recovery data remains within Government regions
- Azure ExpressRoute for Government uses dedicated circuits that do not traverse international networks
- Geo-redundant storage (GRS) replicates only to paired Government regions within the US

### Comparison to Foundry ITAR handling

Palantir Foundry's ITAR compliance depends on the deployment model. On Palantir-managed infrastructure, ITAR compliance is contingent on Palantir's own personnel screening and data residency practices. On agency-hosted infrastructure, ITAR controls are the agency's responsibility. Azure Government provides a standardized, contractually guaranteed ITAR boundary that applies uniformly to all services, eliminating the need to negotiate ITAR-specific terms or validate vendor personnel screening per engagement.

---

## Government service availability matrix

### Key services for data platform migration

The following table compares service availability across Azure Commercial and Azure Government regions, focusing on services relevant to Foundry-to-Azure data platform migrations:

| Service | Azure Commercial | Azure Government (IL4) | Azure Gov DoD (IL5) | Notes |
|---|---|---|---|---|
| Azure Data Factory | GA | GA | GA | Full feature parity |
| Azure Synapse Analytics | GA | GA | GA | Dedicated and serverless SQL pools |
| Azure Databricks | GA | GA | GA | Unity Catalog available in Gov |
| Azure SQL Database | GA | GA | GA | Full feature parity |
| Azure Cosmos DB | GA | GA | GA | All APIs available |
| Azure Kubernetes Service | GA | GA | GA | Full feature parity |
| Power BI | GA | GA (GCC, GCC High) | GA (DoD) | See Power BI section below |
| Microsoft Purview | GA | GA | GA | Data governance and classification |
| Azure Machine Learning | GA | GA | GA | Including managed endpoints |
| Azure OpenAI Service | GA | GA | Limited | GPT-4, GPT-4o in Gov Virginia |
| Microsoft Fabric | GA | Preview/GA (phased) | Planned | See Fabric section below |
| Azure Event Hubs | GA | GA | GA | Full feature parity |
| Azure Functions | GA | GA | GA | All triggers and bindings |
| Azure Key Vault | GA | GA | GA | FIPS 140-2 Level 3 HSM |
| Azure Monitor | GA | GA | GA | Including Log Analytics |
| Microsoft Sentinel | GA | GA | GA | Full SIEM/SOAR capabilities |
| Azure API Management | GA | GA | GA | Full feature parity |

### Power BI in Government

Power BI is the most widely used business intelligence tool in the federal government, deployed across hundreds of agencies. Its Government availability is mature:

- **GCC:** Full Power BI Pro and Premium capabilities, logical separation from commercial
- **GCC High:** Full Power BI Pro and Premium; ITAR-compliant; required for CUI workloads
- **DoD:** Available for IL5 workloads within DoD tenants
- **Key capabilities:** DirectQuery, Import, Composite models, Paginated Reports, Dataflows Gen2, embedded analytics, row-level security, and sensitivity labeling
- **Migration advantage:** Foundry Workshop and Contour users transition naturally to Power BI, which has a vastly larger user community and training ecosystem

### Microsoft Fabric in Government

Microsoft Fabric represents the next generation of Azure's analytics platform, unifying Data Factory, Synapse, Power BI, and Real-Time Analytics under a single SaaS experience:

- **Current status in Azure Government:** Phased rollout; check the [Azure Government services availability page](https://azure.microsoft.com/en-us/explore/global-infrastructure/government/) for current status
- **Expected capabilities:** OneLake, Lakehouse, Warehouse, Data Factory pipelines, Notebooks, Semantic Models
- **Migration implication:** Agencies migrating from Foundry today should architect on Synapse/Databricks/Data Factory with a forward path to Fabric as it achieves GA in Government regions
- **CSA-in-a-Box alignment:** Reference architectures are designed to be Fabric-forward, supporting seamless transition when Fabric reaches full Government availability

### Current gaps and workarounds

Some services may have delayed availability in Government regions. Common workarounds:

- **Service not yet in Gov:** Deploy in a hub-spoke model where non-sensitive processing occurs in Commercial (with appropriate data classification controls) and sensitive data remains in Government
- **Feature gap in Gov:** Use Azure support to request feature prioritization; Microsoft actively tracks Government feature parity through the Azure Government feedback program
- **Preview services:** Evaluate preview services in non-production Government environments; many preview services reach GA within 3–6 months of commercial GA

---

## Agency-specific migration patterns

### Department of Defense (DoD)

DoD agencies face the most stringent compliance requirements and have the deepest investment in Foundry through programs like Project Maven and CDAO (Chief Digital and Artificial Intelligence Office).

- **IL5 mandate:** Most DoD data platforms require IL5 or higher; migrate to Azure Government DoD regions with dedicated compute isolation
- **JWCC alignment:** Azure Government is one of four JWCC (Joint Warfighting Cloud Capability) contract awardees, providing a direct procurement vehicle for DoD cloud migration
- **Classified data handling:** Foundry deployments processing classified data (IL6) require migration to Azure Government Secret; plan for reduced service catalog and air-gapped deployment patterns
- **CDAO integration:** Align migration with CDAO data mesh strategy; CSA-in-a-Box data product patterns map to CDAO's data product specifications
- **Interoperability:** Design for data sharing across classification levels using cross-domain solutions and Azure Arc-enabled data services

### Health and Human Services (HHS) / CDC

HHS and CDC agencies operate large-scale public health data platforms with strict HIPAA requirements and unique epidemiological analytics needs.

- **HIPAA baseline:** All migrated workloads must operate within Azure Government's BAA boundary; configure Purview sensitivity labels for PHI detection and classification
- **Public health data:** Epidemiological datasets (surveillance, outbreak tracking, vaccine distribution) require high-throughput streaming pipelines --- replace Foundry streaming with Azure Event Hubs and Stream Analytics
- **CDC data modernization:** Align migration with CDC's Data Modernization Initiative; CSA-in-a-Box reference architectures support FHIR-based data exchange and public health data standards
- **Interagency sharing:** Design for data sharing with state and local health departments using Azure Data Share and API Management in Government regions
- **Research workloads:** Migrate Foundry-based research analytics to Azure Machine Learning with Responsible AI dashboards for bias detection and model transparency

### Department of Homeland Security (DHS)

DHS agencies (CBP, ICE, TSA, CISA) operate sensitive law enforcement and border security data platforms with unique identity resolution and real-time analytics requirements.

- **Identity resolution:** Migrate Foundry's Ontology-based identity resolution to Azure-native identity graphs using Cosmos DB (Gremlin API) or Azure SQL with graph extensions
- **Real-time border analytics:** Replace Foundry streaming pipelines with Azure Event Hubs, Stream Analytics, and Azure Digital Twins for geospatial situational awareness
- **CJIS compliance:** Law enforcement data requires CJIS (Criminal Justice Information Services) compliance; Azure Government holds CJIS certification at the state level
- **Sensitive PII handling:** DHS handles massive PII datasets; deploy Purview with automated PII detection and Microsoft Information Protection for data loss prevention
- **Cross-agency sharing:** Design federated data products using CSA-in-a-Box patterns that allow CBP, ICE, and TSA to share data under controlled governance without centralizing all data in a single platform

### Treasury / IRS

Treasury and IRS operate financial data platforms with tax data protections and anti-fraud analytics at massive scale.

- **IRS Publication 1075:** Tax return data (Federal Tax Information, FTI) requires IRS 1075 compliance; Azure Government holds IRS 1075 certification, and Defender for Cloud provides continuous compliance monitoring
- **Anti-fraud analytics:** Migrate Foundry-based fraud detection models to Azure Machine Learning with real-time scoring via managed online endpoints; integrate with Sentinel for fraud alert triage
- **Financial data sensitivity:** Apply Purview sensitivity labels for FTI, PII, and financial data classification with automated policy enforcement
- **Scale requirements:** Treasury processes billions of transactions; leverage Synapse dedicated SQL pools or Databricks Delta Lake for petabyte-scale analytical workloads
- **Procurement complexity:** Treasury operates under unique procurement authorities; leverage BPA vehicles and Treasury-specific enterprise agreements for Azure Government access

### Intelligence Community (IC)

IC agencies operating at the Top Secret level face the most restrictive requirements.

- **IC GovCloud:** Azure Government Top Secret provides the foundation for IC workloads; service catalog is limited but covers core IaaS and emerging PaaS services
- **Classified workloads:** All data processing must occur within air-gapped regions with no connectivity to lower classification networks
- **Cross-domain solutions:** Design data flows between classification levels using approved cross-domain solutions; Azure Arc provides management plane consistency across IL boundaries
- **Cleared workforce:** All personnel supporting IC migrations must hold TS/SCI clearances; engage cleared Azure partner firms (see Security Clearance Considerations below)
- **Mission application migration:** IC Foundry applications often have bespoke mission-specific logic; plan for extended application reengineering timelines (12–18 months for complex mission applications)

---

## ATO acceleration strategies

### Leveraging Azure's P-ATO

Azure Government's existing FedRAMP High P-ATO is the single most powerful accelerator for federal ATO timelines. By deploying exclusively on pre-authorized Azure services, agencies can:

- **Eliminate 60–70% of control assessment scope** by inheriting Azure's control implementations
- **Reduce 3PAO assessment duration** from 4–6 months to 4–8 weeks for systems built entirely on PaaS services
- **Avoid duplicative testing** of physical, environmental, and infrastructure controls that Azure has already demonstrated
- **Simplify POA&M management** by inheriting Azure's continuous monitoring for infrastructure-level controls

### CSA-in-a-Box compliance templates

CSA-in-a-Box provides machine-readable compliance artifacts that integrate directly into the RMF process:

- **NIST 800-53 Rev 5 control mappings** in YAML format, identifying inherited, shared, and customer-responsible controls for each Azure service
- **SSP template generator** that produces FedRAMP-formatted System Security Plan sections from deployed Azure resource configurations
- **Evidence automation** using Azure Policy, Defender for Cloud, and Azure Resource Graph queries to produce compliance evidence on demand
- **Control implementation statements** pre-written for common Azure service configurations (Entra ID MFA, Key Vault encryption, NSG configurations, diagnostic logging)

### Common ATO timelines

| Scenario | Traditional timeline | With Azure P-ATO + CSA-in-a-Box |
|---|---|---|
| New system, no prior ATO | 12–18 months | 4–6 months |
| Major change to existing ATO | 6–12 months | 2–4 months |
| Adding services within existing boundary | 3–6 months | 2–6 weeks |
| Annual reauthorization | 2–4 months | 2–4 weeks (automated evidence) |

### ISSO engagement best practices

Successful ATO acceleration requires early and continuous ISSO engagement:

1. **Engage the ISSO during migration planning**, not after deployment. ISSOs who understand the Azure inheritance model can streamline the authorization process.
2. **Provide ISSOs with Azure's CRM** (Customer Responsibility Matrix) at project kickoff so they can focus assessment planning on customer-responsible controls
3. **Establish a shared compliance dashboard** in Defender for Cloud that gives the ISSO real-time visibility into control implementation status
4. **Map Foundry's existing ATO controls** to Azure equivalents early, identifying which controls transfer directly and which require new implementations
5. **Schedule 3PAO coordination calls** early to align assessment methodology with Azure's inheritance model

### RMF (Risk Management Framework) integration

Azure Government and CSA-in-a-Box align with all six steps of the NIST Risk Management Framework:

- **Step 1 (Categorize):** Use Azure tags and Purview classifications to document system categorization
- **Step 2 (Select):** CSA-in-a-Box compliance YAMLs map selected baselines (FedRAMP High, IL4, IL5) to Azure service configurations
- **Step 3 (Implement):** Deploy Azure Policy initiatives that enforce selected control baselines; CSA-in-a-Box provides Bicep/Terraform templates for compliant configurations
- **Step 4 (Assess):** Generate automated evidence packages from Azure Policy compliance reports and Defender for Cloud assessments
- **Step 5 (Authorize):** Present inheritance documentation, automated evidence, and continuous monitoring capabilities to the Authorizing Official
- **Step 6 (Monitor):** Azure Policy, Defender for Cloud, and Sentinel provide continuous monitoring with automated alerting on control drift

### Continuous ATO patterns

The traditional ATO model (point-in-time assessment, annual reauthorization) is being replaced by Continuous ATO (cATO) patterns that leverage automation:

- **Azure Policy** continuously evaluates resource configurations against compliance baselines and flags drift within minutes
- **Defender for Cloud** provides a regulatory compliance dashboard that maps Azure resource state to FedRAMP, NIST, CMMC, and DoD SRG controls in real time
- **Microsoft Sentinel** automates security event detection and incident response, providing continuous monitoring evidence
- **CSA-in-a-Box compliance pipelines** run nightly compliance scans and generate trend reports for ISSO review, enabling the shift from annual snapshots to continuous assurance

---

## Security clearance considerations

### Cleared workforce requirements

Classified deployments (IL6 and above) require all personnel with access to production systems to hold appropriate security clearances:

- **IL6 (Secret):** Secret clearance minimum for all operations, engineering, and support personnel
- **Top Secret / SCI:** Required for IC workloads; additional polygraph requirements may apply depending on the agency
- **Background investigations:** Even unclassified Government projects may require Public Trust (Tier 2) or Secret (Tier 3) investigations for personnel with privileged access

### Azure managed service provider clearance posture

Microsoft maintains a large cleared workforce for Azure Government operations:

- Azure Government Secret and Top Secret regions are operated exclusively by cleared US persons
- Microsoft Federal support teams include cleared engineers who can assist with classified deployment issues
- Azure partner ecosystem includes dozens of firms with cleared personnel (Booz Allen, Deloitte, Accenture Federal, SAIC, Leidos, and others)

### Palantir FDE model vs Azure SI partner model

| Aspect | Palantir FDE model | Azure SI partner model |
|---|---|---|
| Staffing model | Palantir-employed FDEs embedded at agency | Agency selects from multiple cleared SI partners |
| Clearance management | Palantir manages clearances for FDEs | SI partner manages clearances; broader cleared talent pool |
| Knowledge transfer | FDE departure creates knowledge risk | Larger partner ecosystem reduces single-point-of-failure risk |
| Vendor diversity | Single vendor for platform + services | Separate vendors for cloud (Microsoft) and services (SI partners) |
| Cost | $300K–$600K/FDE/year (Palantir pricing) | Competitive SI rates; multiple vendors drive cost competition |

### Training cleared staff on Azure

Agencies should invest in upskilling existing cleared staff on Azure to reduce dependency on external partners:

- Microsoft offers Government-specific Azure training through the Enterprise Skills Initiative (ESI)
- Azure certifications (AZ-900, AZ-104, AZ-305, DP-203) are available for Government customers at no additional cost through ESI
- CSA-in-a-Box includes onboarding guides and hands-on labs designed for federal data engineers and analysts

---

## Procurement guidance

### Azure Government procurement vehicles

Federal agencies have multiple procurement pathways for Azure Government services:

| Vehicle | Type | Applicable agencies | Notes |
|---|---|---|---|
| **JWCC** | IDIQ (multi-award) | DoD | Joint Warfighting Cloud Capability; Microsoft is one of four awardees |
| **CSP program** | Direct/reseller | All federal | Cloud Solution Provider; available through authorized resellers |
| **Enterprise Agreement (EA)** | Direct | Large agencies | Volume licensing with committed spend; best for predictable workloads |
| **ITES-SW2** | BPA | Army | Army-specific software procurement; includes Azure Government |
| **NASA SEWP V/VI** | GWAC | All federal | Government-wide acquisition contract; competitive pricing |
| **GSA Schedule 70 / MAS** | Schedule | All federal | Multiple Award Schedule; broad access to Microsoft and partner services |
| **2GIT** | BPA | All federal | GSA's blanket purchase agreement for IT; streamlined procurement |

### BPA and IDIQ considerations

When structuring Foundry-to-Azure migration procurements:

- **Separate cloud from services:** Procure Azure Government licenses separately from migration services to avoid bundling lock-in and ensure competitive pricing for each component
- **Include data portability requirements:** Contract clauses should require export of all data in open formats (Parquet, CSV, JSON) at no additional cost upon contract termination
- **Require open standards:** Specify that all deployed solutions must use open data formats and standard APIs, preventing re-creation of proprietary lock-in on the new platform
- **Plan for multi-year ramp:** Migration occurs in phases; procurement should allow for consumption growth over 2–3 years rather than requiring full commitment upfront

### Fair opportunity and vendor diversity

Federal migration procurements must comply with fair opportunity requirements:

- **Small business set-asides:** Identify migration work packages suitable for small business prime or subcontractor roles (data engineering, training, testing)
- **Multiple SI partners:** Use task order structures that allow different SI partners for different migration work streams (infrastructure, data engineering, application development, training)
- **Avoid sole-source traps:** Structure requirements around capabilities (e.g., "cloud-native data platform with FedRAMP High authorization") rather than specific products to maintain competitive procurement options

### Contract requirements for data portability and exit

Include the following in migration contracts to prevent future lock-in:

- **Data export rights:** The agency retains the right to export all data, metadata, and configuration in machine-readable open formats at any time
- **API documentation:** All custom integrations must use documented, standards-based APIs (REST, GraphQL) with published OpenAPI specifications
- **No proprietary formats:** Data storage must use open formats (Delta Lake, Parquet, JSON, CSV); no proprietary binary formats
- **Knowledge transfer:** Vendor must provide complete documentation, runbooks, and training sufficient for agency staff or a new vendor to operate the platform independently
- **Transition assistance period:** Contract must include a 90–180 day transition assistance period at the end of the performance period

---

## Federal case study (composite)

### Current state: mid-sized federal agency on Foundry

**Agency profile:** A mid-sized civilian federal agency with 500 data analysts, operating at IL4, running 50 Foundry applications across three mission areas (program integrity, grants management, and regulatory enforcement).

**Current Foundry deployment:**

- 500 named-user licenses (mix of builder and viewer): $8.5M/year
- 5 Forward Deployed Engineers: $2.0M/year
- Compute commitment: $1.5M/year
- AIP add-on: $500K/year
- **Total annual Foundry spend: $12.5M/year**

**Pain points:**

- Analyst growth capped at 500 due to per-seat licensing costs; 200 additional analysts identified but unfunded
- 3 Foundry builder experts on staff; loss of any one creates critical knowledge gap
- ATO renewal requires re-assessing Foundry as a single opaque system; no component-level inheritance
- No path to agency-wide data mesh; Foundry's centralized model conflicts with the agency's data decentralization initiative
- Export of data for congressional reporting requires manual CSV extracts from Foundry UI

### Migration approach using CSA-in-a-Box

**Phase 1 (Months 1–3): Foundation and compliance**

- Deploy CSA-in-a-Box landing zone in Azure Government with FedRAMP High baseline
- Establish Azure AD Government tenant with CAC/PIV authentication
- Configure Purview for data governance and sensitivity labeling
- Begin ATO documentation using CSA-in-a-Box compliance templates
- Migrate 5 low-risk applications as proof of concept

**Phase 2 (Months 4–8): Core platform migration**

- Migrate Foundry Ontology to Purview Business Glossary and dbt semantic models
- Convert Pipeline Builder pipelines to Azure Data Factory and Databricks notebooks
- Rebuild Workshop applications as Power BI dashboards and Power Apps
- Migrate 30 applications across two mission areas
- Achieve ATO for the Azure Government data platform (4-month timeline using P-ATO inheritance)

**Phase 3 (Months 9–12): Completion and optimization**

- Migrate remaining 15 applications including complex regulatory enforcement workflows
- Deploy Azure OpenAI Service for AI-assisted regulatory analysis (replacing AIP)
- Onboard 200 additional analysts at no incremental licensing cost
- Decommission Foundry environment
- Transition to continuous ATO monitoring with Defender for Cloud and Sentinel

### Timeline and cost outcomes

| Metric | Foundry (before) | Azure Government (after) |
|---|---|---|
| Annual platform cost | $12.5M | $5.2M (58% reduction) |
| Analyst capacity | 500 (capped by licensing) | 700+ (no per-seat limit) |
| ATO renewal effort | 4 months, manual evidence | 2 weeks, automated evidence |
| Certified data engineers | 3 (Foundry-specific) | 12 (Azure-certified, growing) |
| Data export capability | Manual CSV from UI | Programmatic via REST APIs and Power BI |
| AI/ML capabilities | AIP (Foundry-only) | Azure OpenAI, Azure ML, Cognitive Services |
| Vendor lock-in risk | Critical (proprietary everything) | Low (open standards, multi-vendor ecosystem) |

### Lessons learned

1. **Start with compliance, not data.** Establishing the ATO foundation first (Phase 1) prevented compliance from becoming a blocker during data migration.
2. **Invest in Purview early.** Data governance gaps in Foundry became visible during migration; Purview provided a governance layer that Foundry lacked.
3. **Expect application redesign, not just migration.** Workshop-to-Power BI conversion was an opportunity to improve UX and add capabilities, not just replicate.
4. **Train analysts in parallel.** Power BI training started in Month 2, so analysts were proficient by the time their applications migrated.
5. **Negotiate Foundry exit terms early.** The agency negotiated a 6-month wind-down period with Palantir before starting migration, avoiding overlap costs.

---

*Last updated: 2026-04-30*

---

**Related documentation:**

- [Migration Playbook](../palantir-foundry.md)
- [TCO Analysis](tco-analysis.md)
- [Vendor Lock-In Analysis](vendor-lock-in-analysis.md)
- [Security & Governance Migration](security-governance-migration.md)
- [Best Practices](best-practices.md)
