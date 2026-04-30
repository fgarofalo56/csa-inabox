# Federal Migration Guide: Snowflake to Azure Government

**Status:** Authored 2026-04-30
**Audience:** CISO, AO (Authorizing Official), ISSM, compliance officers, acquisition leads, federal program managers
**Scope:** FedRAMP Moderate-to-High gap analysis, Snowflake Gov region limitations, IL coverage gaps, procurement path, ATO strategy

---

## 1. The compliance forcing function

This document exists because of a specific compliance reality: Snowflake Government holds **FedRAMP Moderate** authorization as of April 2026. For federal systems that require **FedRAMP High**, **DoD IL4/IL5**, or certain **CMMC 2.0 Level 2** controls, Snowflake creates a compliance ceiling that cannot be resolved by customer-side controls alone.

This is not a marketing argument. It is a factual gap in platform authorization that either blocks your ATO or requires compensating controls that are more expensive than migration.

---

## 2. FedRAMP Moderate vs High: what is the actual gap

### Authorization levels

| Level | Snowflake Gov | Azure Government | Gap |
|---|---|---|---|
| FedRAMP Moderate (110 controls) | Authorized | Authorized | None |
| FedRAMP High (421 controls) | **Not authorized** | Authorized | **311 additional controls** |

### What FedRAMP High adds

FedRAMP High includes 311 controls beyond Moderate, covering:

| Control family | Additional controls | What they protect |
|---|---|---|
| AC (Access Control) | +18 controls | Multi-factor, session controls, information flow enforcement |
| AU (Audit) | +14 controls | Audit correlation, tamper resistance, non-repudiation |
| CA (Assessment) | +6 controls | Continuous monitoring, penetration testing |
| CM (Configuration) | +12 controls | Software restriction, component inventory, baseline config |
| CP (Contingency) | +10 controls | Alternate sites, system backup, information system recovery |
| IA (Identification) | +8 controls | PIV authentication, cryptographic authentication |
| IR (Incident Response) | +6 controls | Automated incident handling, supply chain coordination |
| MA (Maintenance) | +4 controls | Non-local maintenance, maintenance personnel |
| MP (Media Protection) | +6 controls | Media sanitization, CUI marking |
| PE (Physical) | +12 controls | Facility access, environmental controls |
| PL (Planning) | +4 controls | Security architecture, rules of behavior |
| PM (Program Management) | +8 controls | Risk management strategy, senior leadership |
| PS (Personnel) | +4 controls | Personnel screening, termination |
| RA (Risk Assessment) | +6 controls | Vulnerability monitoring, threat intelligence |
| SA (System Acquisition) | +16 controls | Supply chain risk, developer security |
| SC (System Communications) | +22 controls | Cryptographic protection, network disconnect, boundary protection |
| SI (System Information) | +16 controls | Flaw remediation, malicious code, input validation |

### What this means for your ATO

If your system's security categorization is **High** (per FIPS 199), your ATO package must demonstrate compliance with all 421 FedRAMP High controls. When Snowflake provides 110 (Moderate), you must either:

1. **Accept risk** -- Your AO accepts a platform that does not meet the required authorization level. Most federal AOs will not sign this.
2. **Implement compensating controls** -- You build and evidence 311 additional controls yourself, on top of Snowflake. This is technically possible but costs more than migration.
3. **Use a different platform** -- Migrate to a FedRAMP High-authorized platform. Azure Government inherits FedRAMP High, and csa-inabox maps controls to implementation.

### csa-inabox control coverage

csa-inabox provides:

- **NIST 800-53 Rev 5 mappings** -- `csa_platform/csa_platform/governance/compliance/nist-800-53-rev5.yaml`
- **Control narratives** -- `docs/compliance/nist-800-53-rev5.md`
- **Bicep modules with control evidence** -- Each infrastructure module references its control IDs
- **Tamper-evident audit chain (CSA-0016)** -- Exceeds AU (Audit) family requirements
- **Purview classification automation** -- Addresses RA (Risk Assessment) and SI (System Information) controls

---

## 3. DoD Impact Level coverage

### IL4 (Controlled Unclassified Information)

| Requirement | Snowflake Gov | Azure Government | Notes |
|---|---|---|---|
| FedRAMP High baseline | Not met | Met | Required for IL4 |
| DoD Cloud SRG compliance | Limited (partner-dependent) | Direct compliance | Azure Gov is in DISA SWIP |
| Encryption at rest (FIPS 140-2) | Yes | Yes (HSM via Key Vault Premium) | Both meet this |
| PIV/CAC authentication | Via SAML to agency IdP | Native Entra ID + PIV | Entra natively supports PIV |
| Data residency (CONUS) | Snowflake Gov region | Azure Gov (physically separate) | Both meet this |

### IL5 (Higher sensitivity CUI + mission-critical)

| Requirement | Snowflake Gov | Azure Government | Notes |
|---|---|---|---|
| FedRAMP High baseline | Not met | Met | Required for IL5 |
| Dedicated infrastructure | Shared Gov region | Azure Gov isolated from commercial | Azure Gov is physically separate |
| National security background checks | Unknown for Snowflake ops staff | Microsoft Gov ops staff cleared | Required for IL5 |
| Service-level IL5 authorization | **Gap** | Most services; Fabric per roadmap | See `docs/GOV_SERVICE_MATRIX.md` |

### IL6 (Classified)

Neither Snowflake nor csa-inabox addresses IL6. This requires Top Secret cloud infrastructure (Azure Top Secret or AWS Secret Region).

---

## 4. Snowflake Gov region limitations

As of April 2026, Snowflake Government operates in a single region (`us-gov-west-1`) with these limitations:

| Capability | Commercial Snowflake | Snowflake Gov | Gap |
|---|---|---|---|
| Core SQL warehousing | GA | GA | None |
| Snowpark Python | GA | GA | None |
| Snowpark Java/Scala | GA | GA | None |
| Cortex LLM functions | GA (multiple models) | **Limited** (subset of models) | Reduced model selection |
| Cortex Search | GA | **Not available** | Full gap |
| Cortex Analyst | GA | **Not available** | Full gap |
| Cortex Guard | GA | **Not available** | Full gap |
| Cortex Fine-tuning | GA | **Not available** | Full gap |
| Snowpark Container Services | GA | **Limited** | Partial availability |
| Snowpipe Streaming | GA | **Partial** | Not all features |
| Data Clean Rooms | GA | **Not available** | Full gap |
| Marketplace | GA (full catalog) | Available (reduced catalog) | Reduced listings |
| Notebooks | GA | **Limited** | Partial availability |
| Replication (cross-region) | Multi-region | Single Gov region | No Gov-to-Gov DR |

**Key observation:** Many of the capabilities Snowflake markets (AI, streaming, containers, clean rooms) are either not available or limited in the Gov region. You are paying for a commercial feature set but receiving a subset.

---

## 5. CMMC 2.0 Level 2 considerations

### For DIB primes and subcontractors

CMMC 2.0 Level 2 requires compliance with all 110 practices in NIST SP 800-171 Rev 2. The data platform must support these practices.

| CMMC domain | Snowflake support | csa-inabox support | Advantage |
|---|---|---|---|
| Access Control (AC) | RBAC, MFA, network policies | Entra RBAC, MFA, Conditional Access, Private Endpoints | Azure (identity-centric) |
| Audit & Accountability (AU) | Query history, access history | Azure Monitor + Purview audit + tamper-evident chain | Azure (tamper-evident) |
| Configuration Management (CM) | Snowflake-managed infra | Bicep IaC with drift detection | Azure (IaC-managed) |
| Identification & Authentication (IA) | Username/password, key pair, SSO | Entra ID with PIV/CAC, managed identities | Azure (PIV-native) |
| Incident Response (IR) | No built-in IR tooling | Azure Sentinel integration | Azure (SIEM-integrated) |
| Media Protection (MP) | Encryption at rest | Encryption + FIPS 140-2 L3 HSM + soft delete | Azure (HSM-backed) |
| Physical Protection (PE) | Snowflake-managed datacenters | Azure Gov datacenters (cleared ops) | Azure (dedicated Gov) |
| Risk Assessment (RA) | Manual assessment | Purview auto-classification + vulnerability scanning | Azure (automated) |
| System & Communications Protection (SC) | TLS, encryption | Private Endpoints + TLS + customer-managed keys | Azure (network isolation) |
| System & Information Integrity (SI) | Limited | Azure Defender + Purview + Content Safety | Azure (defense-in-depth) |

csa-inabox documents CMMC mappings in `csa_platform/csa_platform/governance/compliance/cmmc-2.0-l2.yaml` with narratives in `docs/compliance/cmmc-2.0-l2.md`.

---

## 6. HIPAA considerations

For HHS, IHS, tribal health, and healthcare-adjacent agencies:

| HIPAA safeguard | Snowflake | csa-inabox |
|---|---|---|
| BAA available | Yes | Yes (Microsoft BAA) |
| PHI encryption at rest | Yes | Yes (FIPS 140-2 L3 HSM) |
| Access controls on PHI | RBAC + masking policies | Purview PHI classification + UC masking |
| Audit trail for PHI access | Access history | Tamper-evident audit + Purview audit |
| PHI de-identification | Manual | Purview auto-classification + masking automation |
| Minimum necessary standard | Manual role design | Classification-driven access (automated) |

See `examples/tribal-health/` for the IHS / tribal health worked implementation and `csa_platform/csa_platform/governance/compliance/hipaa-security-rule.yaml` for the control mapping.

---

## 7. Procurement path

### Federal acquisition vehicles

| Vehicle | Snowflake availability | Azure availability |
|---|---|---|
| GSA Schedule (IT 70) | Yes | Yes |
| GSA MAS (Multiple Award Schedule) | Yes | Yes |
| BPA (Blanket Purchase Agreement) | Agency-specific | Agency-specific |
| Azure Enterprise Agreement (ELA) | N/A | Yes (many agencies have existing ELAs) |
| SEWP V | Yes | Yes |
| NASA GWAC | Yes | Yes |
| DISA milCloud | No | Yes (Azure Gov is in milCloud catalog) |

### Cost comparison for procurement

| Factor | Snowflake Gov | Azure Gov |
|---|---|---|
| Initial contract | Credit commit (typically annual) | Consumption-based or reserved capacity |
| Pricing model | Credits per hour per warehouse | Per-service consumption |
| Contract flexibility | Credit commits lock in spend | Consumption adjusts to usage |
| Existing entitlements | Unlikely | Many agencies have Azure ELA credits |
| Migration funding | N/A | Microsoft may fund migration professional services |

### Procurement timeline

| Phase | Duration | Actions |
|---|---|---|
| Market research | 2-4 weeks | Compare Snowflake Gov vs Azure Gov for your requirements |
| Requirements definition | 2-4 weeks | Document FedRAMP High need; map to PWS/SOO |
| Solicitation | 4-8 weeks | RFQ or task order under existing vehicle |
| Evaluation | 2-4 weeks | Technical evaluation + cost comparison |
| Award | 1-2 weeks | Contract award |
| Migration | 24-32 weeks | See [master playbook](../snowflake.md) Phase 0-7 |

**Tip:** If your agency has an existing Azure ELA, procurement is often a task order modification rather than a new solicitation.

---

## 8. ATO strategy

### Approach A: Inherit Azure Gov authorization

The fastest path to ATO:

1. **Inherit** Azure Government's FedRAMP High authorization as the cloud service provider (CSP) authorization
2. **Document** customer-responsible controls in your System Security Plan (SSP)
3. **Implement** csa-inabox control mappings (NIST 800-53 YAML + Bicep modules)
4. **Evidence** controls using Azure Monitor, Purview audit, tamper-evident chain
5. **Assess** with your 3PAO or agency security team

**Timeline:** 8-16 weeks for the ATO documentation (can run in parallel with migration Phases 1-3)

### Approach B: Reciprocity from existing Azure ATO

If your agency already has an ATO for an Azure Government system:

1. **Leverage** the existing Azure ATO as a reciprocal authorization
2. **Document** the data platform as an extension of the existing system
3. **Evidence** the additional controls specific to the data platform
4. **Brief** the AO on the incremental risk

**Timeline:** 4-8 weeks (reduced scope because Azure is already authorized)

### Approach C: Continuous ATO (cATO)

For agencies with a continuous ATO program:

1. **Add** the data platform to the continuous monitoring scope
2. **Configure** automated control testing (Azure Policy, Purview scans)
3. **Feed** results into your cATO dashboard
4. **Maintain** ongoing authorization through automated evidence

csa-inabox's compliance-as-code approach (YAML + Bicep + automated scanning) is well-suited to cATO programs.

### ATO documentation deliverables

| Deliverable | Source |
|---|---|
| System Security Plan (SSP) | Template + csa-inabox control narratives |
| Control Implementation Summary (CIS) | `csa_platform/csa_platform/governance/compliance/nist-800-53-rev5.yaml` |
| POA&M (Plan of Action and Milestones) | Generated from gap analysis |
| Continuous Monitoring Plan | Azure Monitor + Purview + tamper-evident audit |
| Incident Response Plan | Azure Sentinel integration + agency IR procedures |
| Contingency Plan | ADLS GRS + Databricks DR + backup procedures |
| Privacy Impact Assessment (PIA) | Purview auto-classification findings |

---

## 9. Data residency and sovereignty

### Snowflake Gov data residency

- Data resides in Snowflake's Gov region (`us-gov-west-1`, typically hosted on AWS GovCloud)
- Snowflake manages the infrastructure; customer has limited visibility into physical location
- Cross-region replication within Gov is not available (single region)

### Azure Gov data residency

- Data resides in Azure Government datacenters (physically separate from commercial Azure)
- Azure Government is a separate cloud instance, not a logical partition
- Multiple Azure Gov regions available (US Gov Virginia, US Gov Texas, US Gov Arizona, etc.)
- Cross-region replication available for disaster recovery
- Tenant-binding ensures data cannot leave the Azure Gov boundary

### ITAR compliance

Both Snowflake Gov and Azure Gov support ITAR data residency. Azure Gov's advantage is:

- Physically separate infrastructure (not shared with commercial)
- Cleared operations personnel in Azure Gov datacenters
- Multiple regions for DR without leaving the ITAR boundary

---

## 10. Risk register

Document these risks in your migration risk register:

| Risk ID | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| R-001 | Snowflake contract lock-in prevents timely migration | Medium | High | Review contract terms; negotiate exit clause; begin migration before renewal |
| R-002 | Partner agencies cannot consume Delta Sharing | Low | Medium | Delta Sharing is open protocol; provide pandas/DuckDB client guide |
| R-003 | FedRAMP High evidence gaps during ATO | Medium | High | Use csa-inabox compliance YAML mappings; engage 3PAO early |
| R-004 | Snowflake Gov features used that are not in Azure Gov | Low | Medium | Feature mapping identifies all gaps; only Clean Rooms is material |
| R-005 | Data loss during migration | Low | Critical | Run parallel for 2+ weeks; reconcile row counts and aggregates |
| R-006 | Performance regression after migration | Medium | Medium | Benchmark top 20 queries; right-size warehouses; apply Z-ORDER |
| R-007 | Staff retraining delay | Medium | Medium | Start training in Phase 0; Databricks Academy and Microsoft Learn available |
| R-008 | Procurement delay blocks Azure deployment | Medium | High | Use existing Azure ELA if available; start procurement in parallel with Phase 0 |
| R-009 | Cortex features needed in Gov that Azure has | Low | Low | Azure OpenAI in Gov exceeds Cortex; AI Search replaces Cortex Search |
| R-010 | Snowflake releases FedRAMP High during migration | Low | Medium | Continue migration -- Azure advantages extend beyond FedRAMP authorization |

---

## 11. Migration-specific compliance steps

### During migration (parallel-run phase)

- Maintain Snowflake ATO documentation until decommission
- Add Azure Gov to your system boundary in the SSP
- Document dual-platform architecture as a transition state
- Ensure audit logging is active on both platforms
- Verify data classifications are consistent across platforms

### Post-migration

- Update SSP to remove Snowflake from system boundary
- Archive Snowflake audit logs (retain per your retention policy)
- Update POA&M to close Snowflake-related findings
- Update continuous monitoring plan to reference Azure-only controls
- Brief the AO on the completed migration and reduced risk posture

---

## Related documents

- [Why Azure over Snowflake](why-azure-over-snowflake.md) -- executive white paper
- [Security Migration](security-migration.md) -- technical security controls migration
- [TCO Analysis](tco-analysis.md) -- cost justification for procurement
- [Master playbook](../snowflake.md) -- Section 6 for compliance considerations
- `docs/compliance/nist-800-53-rev5.md` -- NIST 800-53 control narratives
- `docs/compliance/cmmc-2.0-l2.md` -- CMMC Level 2 practice mappings
- `docs/compliance/hipaa-security-rule.md` -- HIPAA safeguard mappings
- `docs/GOV_SERVICE_MATRIX.md` -- Azure Gov service availability matrix

---

**Last updated:** 2026-04-30
**Maintainers:** CSA-in-a-Box core team
