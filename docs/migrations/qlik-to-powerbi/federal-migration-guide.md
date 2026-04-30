---
title: "Qlik to Power BI Federal Migration Guide"
description: "Power BI GCC/GCC-High/DoD deployment, Fabric government availability, Purview for BI governance, sensitivity labels, data residency, and federal procurement guidance."
---

# Qlik to Power BI: Federal Migration Guide

**Audience:** Federal CIOs, CDOs, BI leads, ATO coordinators, compliance officers
**Purpose:** Government-specific guidance for migrating from Qlik Sense to Power BI in federal and DoD environments
**Reading time:** 12-15 minutes

---

## 1. Power BI government cloud options

Microsoft offers three government-specific Power BI environments, each designed for progressively higher compliance requirements.

### 1.1 Cloud comparison

| Feature                         | Power BI Commercial | Power BI GCC      | Power BI GCC-High      | Power BI DoD          |
| ------------------------------- | ------------------- | ----------------- | ---------------------- | --------------------- |
| **FedRAMP authorization**       | Moderate            | High              | High                   | High (DoD SRG IL5)    |
| **Data residency**              | Global (US regions) | US only           | US only                | US only (DoD regions) |
| **Personnel screening**         | Standard            | Background check  | NACI minimum           | NACI + adjudication   |
| **Tenant isolation**            | Shared commercial   | US Gov tenant     | Isolated gov tenant    | Isolated DoD tenant   |
| **ITAR compliant**              | No                  | Conditional       | Yes                    | Yes                   |
| **CJIS compliant**              | No                  | Yes               | Yes                    | Yes                   |
| **DoD IL2**                     | Yes                 | Yes               | Yes                    | Yes                   |
| **DoD IL4**                     | No                  | No                | Yes                    | Yes                   |
| **DoD IL5**                     | No                  | No                | Yes (subset)           | Yes                   |
| **Power BI Pro included in E5** | Yes (E5)            | Yes (G5)          | Yes (G5)               | Yes (G5)              |
| **Paginated reports**           | Premium/Fabric      | Premium/Fabric    | Premium/Fabric         | Premium/Fabric        |
| **Copilot availability**        | GA                  | GA (rolling)      | Planned                | Planned               |
| **Fabric availability**         | GA                  | GA                | GA (limited services)  | Planned               |
| **URL**                         | app.powerbi.com     | app.powerbigov.us | app.high.powerbigov.us | app.mil.powerbigov.us |

### 1.2 Which cloud to choose

| Scenario                                                   | Recommended cloud                                     |
| ---------------------------------------------------------- | ----------------------------------------------------- |
| Civilian agency, no CUI/ITAR data, FedRAMP High sufficient | GCC                                                   |
| Civilian agency with CUI or ITAR data                      | GCC-High                                              |
| DoD component, IL4 data                                    | GCC-High                                              |
| DoD component, IL5 data                                    | DoD                                                   |
| Intelligence community, IL6+                               | Not applicable (use separate classified environments) |
| State/local government                                     | GCC or Commercial                                     |

### 1.3 Qlik government posture comparison

Qlik does not offer government-specific cloud environments. Qlik Cloud operates in a single commercial tenant. For federal deployments:

- **Qlik Sense Enterprise on Windows** can be deployed on-premises in government data centers, but the organization bears the full FedRAMP authorization burden
- **Qlik Cloud** does not have FedRAMP authorization as of early 2026
- **Qlik does not offer GCC-High or DoD equivalents**

This is a significant advantage for Power BI in federal migrations: the compliance authorization is inherited from Microsoft's government cloud infrastructure rather than requiring the agency to build and maintain the authorization boundary.

---

## 2. Fabric in government clouds

### 2.1 Fabric GCC availability (as of early 2026)

| Fabric workload                   | GCC | GCC-High | DoD     |
| --------------------------------- | --- | -------- | ------- |
| Power BI reports and dashboards   | GA  | GA       | GA      |
| Power BI paginated reports        | GA  | GA       | GA      |
| Lakehouse (Delta Lake on OneLake) | GA  | GA       | Planned |
| Data Factory pipelines            | GA  | GA       | Planned |
| Notebooks (Spark)                 | GA  | Preview  | Planned |
| Data Warehouse                    | GA  | GA       | Planned |
| Real-Time Intelligence            | GA  | Planned  | Planned |
| ML experiments and models         | GA  | Planned  | Planned |
| Copilot in Power BI               | GA  | Planned  | Planned |

!!! warning "Check the latest government service matrix"
Fabric service availability in government clouds changes frequently. Always verify against `docs/GOV_SERVICE_MATRIX.md` and the [Microsoft government services availability page](https://learn.microsoft.com/en-us/power-bi/enterprise/service-govus-overview) before making architecture decisions.

### 2.2 Direct Lake in government

Direct Lake is available in GCC and GCC-High for Fabric capacities. This means the full CSA-in-a-Box architecture (Bronze/Silver/Gold -> Direct Lake -> Power BI) works in federal environments:

- Gold layer tables stored in OneLake within the government tenant boundary
- Direct Lake semantic models read Delta files within the same boundary
- All data remains in the government cloud; no cross-boundary data movement

---

## 3. Purview for BI governance in government

### 3.1 Sensitivity labels on Power BI content

Microsoft Purview sensitivity labels can be applied to Power BI reports, dashboards, and semantic models:

| Label                   | Purpose                                 | Data handling rule                          |
| ----------------------- | --------------------------------------- | ------------------------------------------- |
| **Public**              | Unrestricted distribution               | No restrictions                             |
| **General / Internal**  | Internal use only                       | No external sharing                         |
| **Confidential**        | Sensitive business data                 | Encryption at rest, restricted sharing      |
| **Highly Confidential** | CUI, PII, PHI, or mission-critical data | Encryption, no export, restricted workspace |
| **Classified**          | Not applicable in Power BI GCC/GCC-High | Use classified environments, not Power BI   |

Labels flow downstream: if a semantic model is labeled "Confidential," any report built on it inherits that label by default (unless explicitly upgraded).

### 3.2 Lineage across the BI stack

Purview provides automated lineage from data source through the CSA-in-a-Box pipeline to the Power BI report:

```
Source Database
  → ADF Pipeline (ingestion)
    → Bronze Table (ADLS Gen2)
      → dbt Model (Silver transformation)
        → Gold Table (OneLake)
          → Power BI Semantic Model
            → Power BI Report
              → Power BI Dashboard
```

This lineage is critical for federal compliance:

- **NIST 800-53 AU-6** (Audit Review) -- trace data access from report to source
- **NIST 800-53 AC-3** (Access Enforcement) -- verify that access controls are applied at every layer
- **CMMC 2.0 Level 2** -- demonstrate data flow controls for CUI

### 3.3 Data classification in BI models

Purview auto-classifies PII, PHI, and CUI across all data assets, including Power BI semantic models:

- Social Security Numbers detected in semantic model columns
- Email addresses, phone numbers, names flagged
- Custom classification rules for agency-specific data (e.g., case numbers, investigation IDs)

---

## 4. Data residency and sovereignty

### 4.1 Data residency guarantees

| Requirement                | Power BI GCC/GCC-High          | Qlik Cloud                    |
| -------------------------- | ------------------------------ | ----------------------------- |
| Data at rest in US         | Guaranteed (Azure Gov regions) | Not guaranteed (multi-region) |
| Data in transit encrypted  | Yes (TLS 1.2+)                 | Yes (TLS 1.2+)                |
| Processing in US           | Guaranteed (Azure Gov compute) | Not guaranteed                |
| Metadata in US             | Guaranteed                     | Not guaranteed                |
| Backup storage in US       | Guaranteed                     | Not guaranteed                |
| Export controls (ITAR/EAR) | Supported (GCC-High/DoD)       | Customer-managed              |

### 4.2 Tenant binding

Power BI GCC-High and DoD environments are tenant-bound to Azure Government:

- The Power BI tenant is created within the Azure Government directory
- Data cannot leave the Azure Government boundary
- Cross-tenant sharing is restricted (no sharing with commercial tenants)
- External guest access is disabled by default (can be enabled for .gov/.mil domains)

---

## 5. Federal compliance mapping

### 5.1 NIST 800-53 Rev 5 controls

| Control family            | How Power BI + CSA-in-a-Box addresses it                                              |
| ------------------------- | ------------------------------------------------------------------------------------- |
| **AC (Access Control)**   | Entra ID + workspace roles + RLS + sensitivity labels + Conditional Access policies   |
| **AU (Audit)**            | Activity Log + Azure Monitor + Log Analytics; tamper-evident audit chain (CSA-0016)   |
| **CM (Configuration)**    | Tenant settings locked via admin portal; Fabric capacity settings versioned in Bicep  |
| **IA (Identification)**   | Entra ID (MFA, passwordless, FIDO2); no local accounts in Power BI Service            |
| **SC (System/Comm)**      | TLS 1.2+ in transit; encryption at rest (Microsoft-managed or CMK); private endpoints |
| **SI (System Integrity)** | Defender for Cloud integration; vulnerability scanning on gateway VMs                 |

### 5.2 CMMC 2.0 Level 2

The CSA-in-a-Box compliance mappings in `csa_platform/csa_platform/governance/compliance/cmmc-2.0-l2.yaml` extend to the Power BI layer:

- **AC.L2-3.1.1** (Authorized Access) -- workspace roles and RLS
- **AC.L2-3.1.3** (CUI Flow Control) -- sensitivity labels prevent unauthorized export
- **AU.L2-3.3.1** (System Auditing) -- Power BI activity logs
- **SC.L2-3.13.1** (Boundary Protection) -- private endpoints, no public access
- **SC.L2-3.13.8** (CUI in Transit) -- TLS 1.2+ enforced

### 5.3 HIPAA Security Rule

For HHS, IHS, and tribal health organizations:

- PHI in Power BI semantic models is protected by RLS and sensitivity labels
- Purview auto-classification detects PHI columns
- Export controls prevent PHI from being downloaded to non-compliant devices
- Audit logs provide access evidence for HIPAA breach notification requirements

---

## 6. Agency-specific patterns

### 6.1 DoD components

- Deploy Power BI in GCC-High or DoD cloud
- Use CAC (Common Access Card) authentication via Entra ID certificate-based auth
- Apply DoD-specific sensitivity labels (CUI, CUI//SP-DoD, FOUO)
- Integrate with DISA SCCA (Secure Cloud Computing Architecture) via Azure Government

### 6.2 Civilian agencies (CFO Act agencies)

- Deploy Power BI in GCC
- Leverage G5 licensing for Pro at no incremental cost
- Integrate with agency Entra ID directory (most CFO Act agencies are on Entra ID)
- Use Purview for Records Management compliance (NARA requirements)

### 6.3 IC (Intelligence Community)

- Power BI GCC-High/DoD does **not** cover IL6+ requirements
- For classified analytics, use separate classified environments (Azure Government Secret/Top Secret or on-premises)
- Power BI GCC-High can serve as the unclassified analytics platform for the same agency

---

## 7. Procurement guidance for federal Qlik-to-Power BI

### 7.1 Contract vehicles

| Vehicle            | Applicability                   | Notes                                |
| ------------------ | ------------------------------- | ------------------------------------ |
| Microsoft EA / EAS | Available through GSA or direct | Best pricing for large organizations |
| Microsoft CSP      | Available through resellers     | Monthly flexibility, good for pilots |
| SEWP V             | All federal agencies            | NASA-managed; competitive pricing    |
| GSA MAS (Schedule) | All federal agencies            | SIN 54151S for cloud services        |
| CIO-SP3 / CIO-SP4  | All federal agencies            | NITAAC-managed                       |
| Army ITES-3S       | Army and other DoD              | DoD-specific contract vehicle        |
| DIA SITE III       | Intelligence community          | IC-specific procurement              |

### 7.2 Transition timeline with Qlik contract

1. **12 months before Qlik renewal:** Begin Power BI pilot; evaluate GCC/GCC-High
2. **9 months before renewal:** Complete POC with 3-5 production reports in Power BI
3. **6 months before renewal:** Submit business case with TCO analysis
4. **3 months before renewal:** Negotiate Qlik short-term extension (6-12 months) or reduced license count
5. **Renewal date:** Begin parallel run; migrate wave 1 apps
6. **6-12 months post-renewal:** Complete migration; decommission Qlik

---

## 8. Migration security considerations

### 8.1 Data handling during migration

- Never extract Qlik data to intermediate uncontrolled locations
- Use CSA-in-a-Box pipelines (ADF + dbt) to ingest source data into the government Gold layer
- QVD files may contain sensitive data -- treat them as controlled data during archival
- Validate RLS in Power BI before granting user access

### 8.2 ATO (Authority to Operate) impact

- Power BI GCC/GCC-High inherits Azure Government FedRAMP High authorization
- The agency ATO boundary may need to be updated to include Power BI Service
- If Qlik was on-premises within the agency boundary, the migration to SaaS changes the boundary definition
- Coordinate with the ISSM/ISSO for boundary update and security control assessment

---

## Cross-references

| Topic                      | Document                                 |
| -------------------------- | ---------------------------------------- |
| Government service matrix  | `docs/GOV_SERVICE_MATRIX.md`             |
| FedRAMP compliance mapping | `docs/compliance/fedramp-moderate.md`    |
| NIST 800-53 controls       | `docs/compliance/nist-800-53-rev5.md`    |
| CMMC 2.0 mapping           | `docs/compliance/cmmc-2.0-l2.md`         |
| HIPAA security rule        | `docs/compliance/hipaa-security-rule.md` |
| TCO analysis               | [TCO Analysis](tco-analysis.md)          |

---

**Maintainers:** CSA-in-a-Box core team
**Last updated:** 2026-04-30
