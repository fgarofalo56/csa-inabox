# Assessment — Migration Readiness

A scored readiness checklist for evaluating an organization's preparedness to migrate workloads to Azure. This assessment covers 8 dimensions, each scored 1-5, producing a total readiness score of 40-200 with interpretation guidance, timeline estimation, and resource mapping to CSA-in-a-Box documentation.

---

## How to use this assessment

1. Assemble a cross-functional team (infrastructure, data, security, finance, leadership)
2. Work through each of the 8 assessment areas below
3. Answer the questionnaire items honestly — score where you are, not where you want to be
4. Calculate the area scores and total score
5. Use the scoring interpretation table to determine your readiness level
6. Review the migration timeline estimator for planning
7. Complete the risk assessment matrix for identified gaps
8. Map gaps to CSA-in-a-Box resources for remediation guidance

---

## Scoring rubric

Each item is scored on a 1-5 scale. Apply these definitions consistently across all areas:

| Score | Level       | Definition                                                                                                                                      |
| ----- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| **1** | Not Ready   | No capability exists. No plans in place. Significant investment needed before migration can begin.                                              |
| **2** | Early Stage | Initial awareness. Some ad-hoc efforts. No formal processes or documentation. Major gaps remain.                                                |
| **3** | Developing  | Formal processes emerging. Partial coverage. Key gaps identified and plans exist to address them. Migration could proceed with risk acceptance. |
| **4** | Capable     | Solid foundation in place. Most requirements met. Minor gaps with clear remediation paths. Ready to proceed with normal risk.                   |
| **5** | Fully Ready | Comprehensive capability. Documented, tested, and mature. Ready to proceed immediately with low risk.                                           |

---

## Assessment areas

### 1. Infrastructure Assessment

Evaluate your current infrastructure state, network readiness, and dependency mapping.

| #   | Question                                                                                          | Scoring guidance                                                                                                           | Score (1-5) |
| --- | ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ----------- |
| 1.1 | Do you have a complete inventory of servers, storage, and network devices?                        | 1 = No inventory; 3 = Partial inventory, some gaps; 5 = Automated CMDB with current data                                   | \_\_\_      |
| 1.2 | Is your network architecture documented with bandwidth, latency, and connectivity details?        | 1 = No documentation; 3 = Basic diagrams exist; 5 = Full topology with performance baselines                               | \_\_\_      |
| 1.3 | Have you mapped dependencies between applications, databases, and infrastructure components?      | 1 = No dependency mapping; 3 = Key systems mapped; 5 = Automated dependency discovery in place                             | \_\_\_      |
| 1.4 | Do you have sufficient network bandwidth for cloud connectivity (ExpressRoute, VPN, or internet)? | 1 = Unknown or insufficient; 3 = Adequate for initial workloads; 5 = ExpressRoute provisioned with redundancy              | \_\_\_      |
| 1.5 | Have you assessed your DNS, Active Directory, and identity infrastructure for cloud readiness?    | 1 = No assessment; 3 = Assessment done, gaps identified; 5 = Identity infrastructure cloud-ready, Entra ID sync configured | \_\_\_      |

**Area 1 Score:** \_\_\_ / 25

!!! tip "Infrastructure discovery tools"
Azure Migrate provides agentless discovery and assessment for on-premises VMs, databases, and web applications. Start with the discovery phase before scoring this area if you lack a current inventory.

---

### 2. Data Assessment

Evaluate data volume, complexity, quality, and sensitivity classification.

| #   | Question                                                                                    | Scoring guidance                                                                                                       | Score (1-5) |
| --- | ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ----------- |
| 2.1 | Do you know the total volume and growth rate of data to be migrated?                        | 1 = Unknown; 3 = Rough estimates; 5 = Precise measurements with growth projections                                     | \_\_\_      |
| 2.2 | Have you classified data by sensitivity level (public, internal, confidential, restricted)? | 1 = No classification; 3 = Some data classified; 5 = Comprehensive classification with automated labeling              | \_\_\_      |
| 2.3 | Is data quality measured and documented (accuracy, completeness, timeliness, consistency)?  | 1 = No measurement; 3 = Ad-hoc quality checks; 5 = Automated quality monitoring with SLAs                              | \_\_\_      |
| 2.4 | Do you understand data residency and sovereignty requirements?                              | 1 = Unknown; 3 = Requirements identified but not fully mapped; 5 = Documented requirements with target region mapping  | \_\_\_      |
| 2.5 | Have you identified database migration paths (schema, stored procedures, ETL dependencies)? | 1 = No assessment; 3 = Key databases assessed; 5 = Complete migration paths documented with compatibility testing done | \_\_\_      |

**Area 2 Score:** \_\_\_ / 25

---

### 3. Application Assessment

Evaluate cloud compatibility, refactoring needs, and application dependencies.

| #   | Question                                                                                                                       | Scoring guidance                                                                                               | Score (1-5) |
| --- | ------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- | ----------- |
| 3.1 | Have you categorized applications using the 6 Rs (Retire, Retain, Rehost, Replatform, Refactor, Replace)?                      | 1 = No categorization; 3 = Major apps categorized; 5 = All apps categorized with migration approach documented | \_\_\_      |
| 3.2 | Do you understand which applications have hard dependencies on on-premises infrastructure?                                     | 1 = Unknown; 3 = Key blockers identified; 5 = All dependencies mapped with remediation plans                   | \_\_\_      |
| 3.3 | Have you identified applications that require refactoring for cloud (e.g., stateful sessions, local file system dependencies)? | 1 = No assessment; 3 = Major apps assessed; 5 = All apps assessed with refactoring effort estimated            | \_\_\_      |
| 3.4 | Do you have testing environments and processes to validate migrated applications?                                              | 1 = No test environment; 3 = Manual testing capability; 5 = Automated CI/CD with cloud-based test environments | \_\_\_      |
| 3.5 | Have you evaluated SaaS alternatives for custom-built applications?                                                            | 1 = Not considered; 3 = Some evaluation; 5 = Systematic evaluation with business case for each candidate       | \_\_\_      |

**Area 3 Score:** \_\_\_ / 25

---

### 4. Skills Assessment

Evaluate team capabilities, training needs, and partner requirements.

| #   | Question                                                                                                                | Scoring guidance                                                                                                        | Score (1-5) |
| --- | ----------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ----------- |
| 4.1 | Does your team have hands-on experience with Azure services (compute, storage, networking, identity)?                   | 1 = No Azure experience; 3 = Some team members certified or experienced; 5 = Deep Azure expertise across the team       | \_\_\_      |
| 4.2 | Do you have Infrastructure-as-Code (IaC) skills (Bicep, Terraform, ARM templates)?                                      | 1 = No IaC experience; 3 = Some experience, mostly manual deployments; 5 = IaC is standard practice for all deployments | \_\_\_      |
| 4.3 | Does your team understand cloud security and identity concepts (Entra ID, RBAC, managed identities, private endpoints)? | 1 = No cloud security skills; 3 = Basic understanding; 5 = Deep expertise, able to architect zero trust environments    | \_\_\_      |
| 4.4 | Have you identified skills gaps and created training plans?                                                             | 1 = No assessment; 3 = Gaps identified, training planned; 5 = Training underway with measurable progress                | \_\_\_      |
| 4.5 | Have you evaluated the need for a migration partner or managed service provider?                                        | 1 = Not considered; 3 = Evaluating options; 5 = Partner selected and engaged (or determined unnecessary)                | \_\_\_      |

**Area 4 Score:** \_\_\_ / 25

!!! tip "CSA-in-a-Box learning paths"
The [Developer Pathways](../DEVELOPER_PATHWAYS.md) guide and [Quickstart guides](../quickstarts/index.md) provide role-based onboarding for platform administrators, data engineers, BI developers, security admins, and data scientists.

---

### 5. Governance & Compliance

Evaluate regulatory requirements, data sovereignty, and audit readiness.

| #   | Question                                                                                                                 | Scoring guidance                                                                                                          | Score (1-5) |
| --- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- | ----------- |
| 5.1 | Have you identified all regulatory frameworks that apply to your workloads (FedRAMP, HIPAA, PCI-DSS, CMMC, SOC 2, etc.)? | 1 = Unknown; 3 = Major frameworks identified; 5 = Complete framework inventory with applicability analysis                | \_\_\_      |
| 5.2 | Do you understand the shared responsibility model for cloud compliance?                                                  | 1 = No understanding; 3 = Basic awareness; 5 = Documented shared responsibility matrix for each framework                 | \_\_\_      |
| 5.3 | Do you have existing compliance documentation (policies, procedures, evidence) that can be adapted for cloud?            | 1 = No documentation; 3 = Some policies exist; 5 = Comprehensive compliance documentation, actively maintained            | \_\_\_      |
| 5.4 | Have you mapped data sovereignty requirements to Azure regions (commercial vs. government)?                              | 1 = Not assessed; 3 = Requirements known, regions not selected; 5 = Region strategy documented with compliance validation | \_\_\_      |
| 5.5 | Do you have an audit trail capability that meets your compliance requirements?                                           | 1 = No audit capability; 3 = Basic logging; 5 = Comprehensive, tamper-resistant audit trail with retention policies       | \_\_\_      |

**Area 5 Score:** \_\_\_ / 25

!!! tip "Compliance assessment"
Use the [Compliance Gap Analysis](compliance-gap-analysis.md) assessment for a detailed control-by-control analysis. The [Compliance Documentation](../compliance/README.md) maps CSA-in-a-Box controls to NIST 800-53, FedRAMP, CMMC, HIPAA, SOC 2, and PCI-DSS.

---

### 6. Security Readiness

Evaluate identity management, encryption, and monitoring capabilities.

| #   | Question                                                                         | Scoring guidance                                                                                                             | Score (1-5) |
| --- | -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ----------- |
| 6.1 | Do you have a centralized identity provider capable of federation with Entra ID? | 1 = No centralized IdP; 3 = IdP exists but federation not configured; 5 = Federation configured and tested with MFA enforced | \_\_\_      |
| 6.2 | Do you have encryption standards for data at rest and in transit?                | 1 = No encryption standards; 3 = Some encryption in place; 5 = Comprehensive encryption with key management (HSM/KMS)        | \_\_\_      |
| 6.3 | Do you have security monitoring and incident response capabilities?              | 1 = No monitoring; 3 = Basic alerting; 5 = SIEM/SOAR deployed with documented incident response procedures                   | \_\_\_      |
| 6.4 | Do you have vulnerability management and patch management processes?             | 1 = No process; 3 = Manual, periodic scanning; 5 = Automated scanning with SLA-driven remediation                            | \_\_\_      |
| 6.5 | Have you conducted a security assessment of your cloud migration plan?           | 1 = No assessment; 3 = Assessment planned; 5 = Threat modeling complete with mitigations documented                          | \_\_\_      |

**Area 6 Score:** \_\_\_ / 25

---

### 7. Financial Planning

Evaluate TCO analysis, budget approval, and ROI model.

| #   | Question                                                                                                | Scoring guidance                                                                                                        | Score (1-5) |
| --- | ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ----------- |
| 7.1 | Have you completed a Total Cost of Ownership (TCO) analysis comparing on-premises to cloud?             | 1 = Not started; 3 = Rough estimates; 5 = Detailed TCO with Azure Pricing Calculator validated estimates                | \_\_\_      |
| 7.2 | Do you have budget approval for the migration project (including dual-running costs during transition)? | 1 = No budget; 3 = Budget requested; 5 = Budget approved with contingency                                               | \_\_\_      |
| 7.3 | Have you established a FinOps practice for ongoing cloud cost management?                               | 1 = No FinOps awareness; 3 = Basic cost monitoring; 5 = FinOps team with cost allocation, optimization, and forecasting | \_\_\_      |
| 7.4 | Do you have a cost allocation model for cloud resources (tagging strategy, chargeback/showback)?        | 1 = No model; 3 = Tagging strategy defined; 5 = Automated tagging, cost allocation, and reporting in place              | \_\_\_      |
| 7.5 | Have you modeled the ROI or business case for migration?                                                | 1 = No business case; 3 = Qualitative benefits identified; 5 = Quantified ROI model approved by leadership              | \_\_\_      |

**Area 7 Score:** \_\_\_ / 25

!!! tip "Cost management resources"
See [Cost Management](../COST_MANAGEMENT.md) for Azure cost optimization strategies, reserved instance guidance, and FinOps patterns. The [Cost Optimization Best Practices](../best-practices/cost-optimization.md) guide covers tagging, rightsizing, and budget alerting.

---

### 8. Organizational Change

Evaluate executive sponsorship, change management plan, and communication strategy.

| #   | Question                                                                                            | Scoring guidance                                                                                                     | Score (1-5) |
| --- | --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ----------- |
| 8.1 | Do you have executive sponsorship for the cloud migration with clear authority and accountability?  | 1 = No sponsor; 3 = Sponsor identified but not engaged; 5 = Active executive sponsor with regular involvement        | \_\_\_      |
| 8.2 | Have you developed a change management plan that addresses people, process, and technology impacts? | 1 = No plan; 3 = Basic plan exists; 5 = Comprehensive change plan with stakeholder analysis and timeline             | \_\_\_      |
| 8.3 | Is there a communication strategy for informing stakeholders about migration impacts and timelines? | 1 = No strategy; 3 = Ad-hoc communication; 5 = Structured communication plan with regular updates and feedback loops | \_\_\_      |
| 8.4 | Have you identified and engaged champions or early adopters within the organization?                | 1 = Not considered; 3 = Some champions identified; 5 = Champions engaged with defined roles in migration support     | \_\_\_      |
| 8.5 | Do you have a rollback or continuity plan if migration encounters critical issues?                  | 1 = No plan; 3 = Basic rollback approach; 5 = Documented rollback with tested procedures and decision criteria       | \_\_\_      |

**Area 8 Score:** \_\_\_ / 25

---

## Scoring summary

Transfer your area scores to calculate the total:

| Area                         | Max Score | Your Score |
| ---------------------------- | --------- | ---------- |
| 1. Infrastructure Assessment | 25        | \_\_\_     |
| 2. Data Assessment           | 25        | \_\_\_     |
| 3. Application Assessment    | 25        | \_\_\_     |
| 4. Skills Assessment         | 25        | \_\_\_     |
| 5. Governance & Compliance   | 25        | \_\_\_     |
| 6. Security Readiness        | 25        | \_\_\_     |
| 7. Financial Planning        | 25        | \_\_\_     |
| 8. Organizational Change     | 25        | \_\_\_     |
| **Total**                    | **200**   | **\_\_\_** |

---

## Scoring interpretation

| Total Score | Readiness Level                                                                                                       | Recommended Actions                                                                                                                                                                                |
| ----------- | --------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **160-200** | **Ready** — Proceed with migration planning. Minor gaps exist but are manageable within a normal project timeline.    | Begin migration project. Address remaining gaps in parallel. Focus on execution planning, wave grouping, and timeline finalization.                                                                |
| **120-159** | **Mostly Ready** — Foundation is solid but notable gaps need attention before full-scale migration.                   | Address gaps scoring 1-2 before launching migration waves. Consider a pilot migration of non-critical workloads while remediating. Target 4-8 weeks of preparation.                                |
| **80-119**  | **Developing** — Several significant gaps exist. Migration is possible but carries elevated risk without remediation. | Develop formal remediation plan for all areas scoring below 3. Invest in skills development and compliance documentation. Target 2-4 months of preparation before first migration wave.            |
| **40-79**   | **Not Ready** — Foundational work is needed across multiple dimensions before migration should begin.                 | Focus on building fundamentals: inventory, skills, governance, security, and financial planning. Consider engaging a migration partner. Target 4-6 months of foundational work before reassessing. |

---

## Migration timeline estimator

Use your total score and the number of workloads to estimate a migration timeline. These are rough estimates — adjust based on complexity, compliance requirements, and team capacity.

| Total Score | Small (1-10 workloads) | Medium (10-50 workloads) | Large (50+ workloads) |
| ----------- | ---------------------- | ------------------------ | --------------------- |
| 160-200     | 2-4 months             | 4-8 months               | 8-14 months           |
| 120-159     | 4-7 months             | 7-12 months              | 12-20 months          |
| 80-119      | 7-10 months            | 10-16 months             | 16-28 months          |
| 40-79       | 10-14 months           | 14-24 months             | 24-36 months          |

!!! tip "Federal timelines"
For federal agencies requiring FedRAMP or DoD IL4/IL5 authorization, add 6-12 months for ATO activities. See [Federal Cloud Adoption Trends](../research/federal-cloud-adoption-trends.md) for current ATO timeline analysis.

---

## Risk assessment matrix

For any area scoring 1 or 2, document the risk and mitigation plan:

| Risk Area         | Specific Risk               | Impact (H/M/L) | Likelihood (H/M/L) | Risk Level | Mitigation Strategy                         | Owner              | Target Date |
| ----------------- | --------------------------- | -------------- | ------------------ | ---------- | ------------------------------------------- | ------------------ | ----------- |
| _Example: Skills_ | _Team lacks IaC experience_ | _H_            | _H_                | _Critical_ | _Bicep training + CSA-in-a-Box quickstarts_ | _Engineering Lead_ | _[Date]_    |
|                   |                             |                |                    |            |                                             |                    |             |
|                   |                             |                |                    |            |                                             |                    |             |
|                   |                             |                |                    |            |                                             |                    |             |
|                   |                             |                |                    |            |                                             |                    |             |

**Risk level matrix:**

|                   | **High Likelihood** | **Medium Likelihood** | **Low Likelihood** |
| ----------------- | ------------------- | --------------------- | ------------------ |
| **High Impact**   | Critical            | High                  | Medium             |
| **Medium Impact** | High                | Medium                | Low                |
| **Low Impact**    | Medium              | Low                   | Low                |

---

## Area-specific recommendations

### Low-scoring areas — quick wins

If specific areas score significantly lower than others, consider these targeted quick wins before launching a full migration:

| Area Scoring 1-2   | Quick Win Actions                                                                                            | Timeframe |
| ------------------ | ------------------------------------------------------------------------------------------------------------ | --------- |
| **Infrastructure** | Run Azure Migrate discovery; document network topology; assess ExpressRoute needs                            | 2-4 weeks |
| **Data**           | Conduct data inventory with sensitivity classification; identify top 10 largest data stores                  | 2-3 weeks |
| **Applications**   | Categorize top 20 applications using the 6 Rs; identify quick-win rehost candidates                          | 1-2 weeks |
| **Skills**         | Enroll team in Azure Fundamentals (AZ-900) and role-specific certifications; assign CSA-in-a-Box quickstarts | 4-8 weeks |
| **Governance**     | Identify applicable frameworks; review Azure shared responsibility model; begin policy documentation         | 2-4 weeks |
| **Security**       | Deploy Entra ID with MFA; conduct basic threat assessment; identify monitoring gaps                          | 3-6 weeks |
| **Financial**      | Complete Azure Pricing Calculator estimate; model 12-month TCO; present business case to leadership          | 2-4 weeks |
| **Organizational** | Identify executive sponsor; draft communication plan; recruit 2-3 champions from key business units          | 2-3 weeks |

### Federal-specific considerations

For federal agencies, the following additional factors should be evaluated alongside each area:

- **Infrastructure (Area 1):** Verify that target Azure region supports required impact level (IL4/IL5). See [Government Service Matrix](../GOV_SERVICE_MATRIX.md).
- **Data (Area 2):** CUI, FTI, PII, and PHI classifications drive region selection and encryption requirements.
- **Governance (Area 5):** FedRAMP ATO timeline should be included in migration planning. Add 6-12 months for initial authorization.
- **Security (Area 6):** CISA BOD compliance, zero trust requirements (M-22-09), and continuous monitoring obligations apply.
- **Financial (Area 7):** Federal procurement timelines (GWAC, BPA, task orders) add lead time. Factor in ATO costs.
- **Organizational (Area 8):** FITARA compliance requires CIO involvement in all IT investment decisions.

---

## CSA-in-a-Box resource mapping

For each assessment area, the following CSA-in-a-Box resources provide guidance and implementation support:

| Assessment Area                | CSA-in-a-Box Resources                                                                                                                                                                                                  |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **1. Infrastructure**          | [Architecture Overview](../ARCHITECTURE.md), [Hub-Spoke Topology](../reference-architecture/hub-spoke-topology.md), [Getting Started](../GETTING_STARTED.md)                                                            |
| **2. Data**                    | [Data Governance](../governance/DATA_CATALOGING.md), [Data Quality](../governance/DATA_QUALITY.md), [Medallion Architecture](../best-practices/medallion-architecture.md), [Purview Guide](../guides/purview.md)        |
| **3. Applications**            | [Platform Services](../PLATFORM_SERVICES.md), [Migration Guides](../migrations/README.md), [Decision Guides](../decisions/fabric-vs-databricks-vs-synapse.md)                                                           |
| **4. Skills**                  | [Developer Pathways](../DEVELOPER_PATHWAYS.md), [Quickstarts](../quickstarts/index.md), [Tutorials](../tutorials/README.md)                                                                                             |
| **5. Governance & Compliance** | [Compliance Documentation](../compliance/README.md), [Compliance Gap Analysis](compliance-gap-analysis.md), [FedRAMP Guide](../compliance/fedramp-moderate.md)                                                          |
| **6. Security**                | [Security & Compliance Best Practices](../best-practices/security-compliance.md), [Identity & Secrets Flow](../reference-architecture/identity-secrets-flow.md), [Environment Protection](../ENVIRONMENT_PROTECTION.md) |
| **7. Financial Planning**      | [Cost Management](../COST_MANAGEMENT.md), [Cost Optimization Best Practices](../best-practices/cost-optimization.md)                                                                                                    |
| **8. Organizational Change**   | [Production Checklist](../PRODUCTION_CHECKLIST.md), [Rollback Procedures](../ROLLBACK.md), [DR Planning](../DR.md)                                                                                                      |

---

## Next steps

After completing this assessment:

- [ ] Calculate total score and identify readiness level
- [ ] Document all items scoring 1 or 2 in the risk assessment matrix
- [ ] Create remediation plans for critical and high risks
- [ ] If score is 120+, begin migration planning with the [Getting Started](../GETTING_STARTED.md) guide
- [ ] If score is below 120, focus on foundational work and reassess in 30-60 days
- [ ] For compliance-sensitive workloads, complete the [Compliance Gap Analysis](compliance-gap-analysis.md)
- [ ] For ongoing improvement tracking, establish baseline with the [Platform Maturity Model](platform-maturity.md)

---

## Related

- [Platform Maturity Model](platform-maturity.md) — Ongoing maturity assessment after migration
- [Compliance Gap Analysis](compliance-gap-analysis.md) — Detailed compliance control gap identification
- [Assessment Templates Index](index.md) — Overview of all assessment tools
- [Federal Cloud Adoption Trends](../research/federal-cloud-adoption-trends.md) — Federal market context and compliance landscape
- [Migration Guides](../migrations/README.md) — Platform-specific migration playbooks
- [Getting Started](../GETTING_STARTED.md) — Deployment quickstart

---

**Last updated:** 2026-04-30
**Review cadence:** Annual
**Owner:** CSA-in-a-Box platform team
