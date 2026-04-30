# SAP on Azure Government: Federal Migration Guide

**Deploying SAP workloads on Azure Government for DoD financial systems (DFAS, GFEBS), civilian ERP, FedRAMP compliance, IL4/IL5, and ITAR considerations.**

---

!!! danger "2027 Deadline Affects Federal SAP Systems"
Federal agencies running SAP ECC for financial management, HR, logistics, and supply chain face the same December 2027 end-of-mainstream-maintenance deadline as commercial customers. Federal procurement timelines (Authority to Operate, FedRAMP authorization, appropriations cycles) add 6--12 months to migration planning. Federal organizations should begin planning immediately.

## Overview

SAP runs mission-critical systems across the federal government. The Department of Defense uses SAP for DFAS (Defense Finance and Accounting Service) and GFEBS (General Fund Enterprise Business System). Civilian agencies use SAP for HR, finance, grants management, and procurement. This guide covers the specific considerations for deploying SAP on Azure Government, including compliance frameworks, VM availability, network architecture, and CSA-in-a-Box integration for federal analytics.

---

## 1. Federal SAP systems landscape

### Department of Defense

| System   | Agency         | SAP modules          | Classification | Notes                                      |
| -------- | -------------- | -------------------- | -------------- | ------------------------------------------ |
| GFEBS    | U.S. Army      | FI/CO, MM, PM, RE-FX | CUI / IL4      | General fund accounting, budget execution  |
| DEAMS    | U.S. Air Force | FI/CO, MM, FM        | CUI / IL4      | Defense Enterprise Accounting & Management |
| Navy ERP | U.S. Navy      | FI/CO, MM, PP, WM    | CUI / IL4      | Financial and supply chain management      |
| DCPS     | DFAS           | HR/Payroll           | CUI / IL4      | Defense Civilian Pay System                |
| LMP      | U.S. Army      | MM, WM, PM           | CUI / IL4      | Logistics Modernization Program            |

### Civilian agencies

| System               | Agency   | SAP modules   | Classification | Notes                                    |
| -------------------- | -------- | ------------- | -------------- | ---------------------------------------- |
| Financial management | Multiple | FI/CO, FM, GM | CUI            | Grants, appropriations, funds management |
| HR management        | Multiple | HCM, OM, PA   | PII            | Personnel administration                 |
| Procurement          | Multiple | MM, SRM       | CUI            | Federal acquisition, contracting         |
| Supply chain         | DLA, GSA | MM, WM, LE    | CUI            | Defense logistics, supply management     |

---

## 2. Azure Government compliance for SAP

### Compliance framework coverage

| Framework              | Azure Government                                 | Relevance to SAP                          | CSA-in-a-Box support                                 |
| ---------------------- | ------------------------------------------------ | ----------------------------------------- | ---------------------------------------------------- |
| **FedRAMP High**       | P-ATO (Provisional Authority to Operate)         | Required for federal SAP systems          | Compliance YAML mappings in `governance/compliance/` |
| **DoD IL2**            | Authorized                                       | Public/non-sensitive DoD data             | Standard Azure Government                            |
| **DoD IL4**            | Authorized                                       | CUI (Controlled Unclassified Information) | SAP financial/logistics data typically IL4           |
| **DoD IL5**            | Authorized (select regions)                      | Higher-sensitivity CUI, national security | SAP systems with FOUO/NOFORN data                    |
| **DoD IL6**            | Azure Government Secret regions                  | Classified SECRET                         | Out of scope for CSA-in-a-Box; bespoke deployment    |
| **ITAR**               | Azure Government (data residency)                | SAP data with ITAR-controlled content     | Tenant-binding prevents data egress to commercial    |
| **FISMA**              | Inherited from Azure Gov P-ATO                   | Federal information system authorization  | Continuous monitoring via Azure Monitor              |
| **CMMC 2.0 Level 2**   | Supported with customer configuration            | DIB (Defense Industrial Base) SAP systems | CMMC control mappings in CSA-in-a-Box                |
| **DFARS 252.204-7012** | Azure Government meets safeguarding requirements | CUI protection for defense contractors    | Encryption, access control, audit logging            |
| **Section 508**        | Power BI accessibility compliance                | SAP reporting and analytics               | Accessible analytics layer                           |

### Azure Government vs commercial regions

| Capability                     | Azure Government                          | Azure Commercial             | Impact on SAP                                       |
| ------------------------------ | ----------------------------------------- | ---------------------------- | --------------------------------------------------- |
| Physical separation            | Separate data centers, separate network   | Standard Azure data centers  | Federal data never traverses commercial Azure       |
| Personnel screening            | US citizens with background investigation | Standard Microsoft employees | Meets ITAR and DoD personnel requirements           |
| SAP-certified VMs              | M-series, Mv2, E-series available         | Full VM catalog              | Verify specific VM SKUs in target Gov region        |
| Azure NetApp Files             | Available in select Gov regions           | Broadly available            | Check ANF availability for HANA storage             |
| Azure Center for SAP Solutions | Available in Gov regions                  | Fully available              | ACSS deployment automation in Gov                   |
| Microsoft Fabric               | Available in Gov regions (check features) | Fully available              | Fabric Mirroring availability in Gov may be limited |
| Power BI                       | Power BI for Government                   | Power BI commercial          | Separate Gov tenant for Power BI                    |
| Azure OpenAI                   | Available in Gov regions (limited models) | Full model catalog           | Check model availability for SAP AI scenarios       |

---

## 3. SAP-certified VM availability in Azure Government

!!! warning "Verify VM SKUs before planning"
Not all SAP-certified VM sizes are available in every Azure Government region. Verify availability using `az vm list-skus --location usgovvirginia --size Standard_M --output table` before finalizing your deployment architecture.

### Certified VM availability (check at deployment time)

| VM size           | US Gov Virginia | US Gov Texas | US Gov Arizona | SAP workload             |
| ----------------- | --------------- | ------------ | -------------- | ------------------------ |
| Standard_M128s    | Available       | Available    | Check          | HANA production (2 TB)   |
| Standard_M64s     | Available       | Available    | Available      | HANA production (1 TB)   |
| Standard_M32ts    | Available       | Available    | Available      | HANA non-production      |
| Standard_E32ds_v5 | Available       | Available    | Available      | SAP application servers  |
| Standard_E16ds_v5 | Available       | Available    | Available      | Small SAP app servers    |
| Standard_M208s_v2 | Check           | Check        | Check          | Large HANA (2.8 TB)      |
| Standard_M416s_v2 | Check           | Check        | Check          | Very large HANA (5.7 TB) |

```bash
# Check VM availability in Azure Government
az vm list-skus \
  --location usgovvirginia \
  --size Standard_M \
  --resource-type virtualMachines \
  --output table
```

---

## 4. Network architecture for federal SAP

### Hub-spoke topology for federal SAP

```
Azure Government Region (US Gov Virginia)
┌──────────────────────────────────────────────────────────┐
│  Hub VNet (10.0.0.0/16)                                 │
│  ├── Azure Firewall (10.0.1.0/24)                       │
│  ├── Azure Bastion (10.0.2.0/26)                        │
│  ├── VPN Gateway / ExpressRoute (10.0.3.0/24)           │
│  └── DNS Resolver (10.0.4.0/24)                         │
│                                                          │
│  ┌─────────────────────────────────────────────────┐    │
│  │  SAP Spoke VNet (10.1.0.0/16) ── peered to hub │    │
│  │  ├── sap-db-subnet (10.1.1.0/24) → HANA VMs   │    │
│  │  ├── sap-app-subnet (10.1.2.0/24) → App srvrs │    │
│  │  ├── sap-web-subnet (10.1.3.0/24) → Web Disp  │    │
│  │  └── anf-subnet (10.1.4.0/24) → ANF delegate  │    │
│  └─────────────────────────────────────────────────┘    │
│                                                          │
│  ┌─────────────────────────────────────────────────┐    │
│  │  CSA-in-a-Box Spoke (10.2.0.0/16) ── peered    │    │
│  │  ├── data-subnet (10.2.1.0/24) → ADF, Purview  │    │
│  │  ├── analytics-subnet (10.2.2.0/24) → Fabric   │    │
│  │  └── ai-subnet (10.2.3.0/24) → Azure AI        │    │
│  └─────────────────────────────────────────────────┘    │
│                                                          │
│  ExpressRoute → DoD/Agency on-premises network          │
└──────────────────────────────────────────────────────────┘
```

### ExpressRoute for federal connectivity

```bash
# Create ExpressRoute circuit for DoD network connectivity
az network express-route create \
  --resource-group rg-hub-network-gov \
  --name er-dod-network \
  --provider "Megaport" \
  --peering-location "Washington DC" \
  --bandwidth 1000 \
  --sku-tier Premium \
  --sku-family MeteredData \
  --location usgovvirginia
```

---

## 5. Federal SAP deployment on Azure Government

### 5.1 ACSS deployment in Azure Government

```bash
# Set Azure Government cloud
az cloud set --name AzureUSGovernment
az login

# Register provider in Gov subscription
az provider register --namespace Microsoft.Workloads

# Deploy SAP Virtual Instance in Gov region
az workloads sap-virtual-instance create \
  --resource-group rg-sap-gov \
  --name GFEBS-PRD \
  --environment Production \
  --sap-product S4HANA \
  --location usgovvirginia \
  --configuration @sap-gov-deployment-config.json
```

### 5.2 Federal security controls for SAP

| NIST 800-53 control family           | SAP on Azure Government implementation                    |
| ------------------------------------ | --------------------------------------------------------- |
| AC (Access Control)                  | Entra ID Conditional Access + SAP authorization objects   |
| AU (Audit)                           | Azure Monitor for SAP + SAP Security Audit Log → Sentinel |
| CM (Configuration Management)        | Azure Policy + ACSS quality checks                        |
| IA (Identification & Authentication) | Entra ID SAML SSO + CAC/PIV authentication                |
| IR (Incident Response)               | Defender for Cloud + Sentinel SAP connector               |
| MP (Media Protection)                | Azure Disk Encryption + ANF encryption + HANA TDE         |
| PE (Physical & Environmental)        | Azure Government data center controls (inherited)         |
| SC (System & Communications)         | NSG + Azure Firewall + Private Link + TLS                 |
| SI (System & Information Integrity)  | Azure Update Manager + Defender for Cloud                 |

### 5.3 CAC/PIV authentication for SAP

```
CAC/PIV Card → Azure AD Certificate-Based Auth → Entra ID
    → SAML Assertion → SAP NetWeaver → SAP Fiori
```

```bash
# Configure Entra ID for certificate-based authentication (CAC/PIV)
az rest --method PATCH \
  --url "https://graph.microsoft.us/v1.0/organization/<tenant-id>" \
  --body '{
    "certificateBasedAuthConfiguration": [{
      "certificateAuthorities": [{
        "certificate": "<DoD-Root-CA-cert-base64>",
        "isRootAuthority": true
      }]
    }]
  }'
```

---

## 6. IL4 and IL5 considerations for SAP

### IL4 (CUI)

IL4 is the most common classification for federal SAP data. Most SAP financial, logistics, and procurement data is Controlled Unclassified Information (CUI).

| Requirement           | Azure Government implementation                 |
| --------------------- | ----------------------------------------------- |
| Data residency        | US-only data centers (Azure Government regions) |
| Personnel screening   | US citizens with background investigation       |
| Encryption at rest    | FIPS 140-2 validated (Azure Government default) |
| Encryption in transit | TLS 1.2+ (Azure Government enforced)            |
| Access control        | RBAC + Conditional Access + MFA                 |
| Audit logging         | Azure Monitor + Sentinel (Gov instance)         |
| Boundary protection   | Azure Firewall + NSG + no public IPs            |

### IL5 (higher-sensitivity CUI, national security)

IL5 is required for SAP systems handling higher-sensitivity CUI or data with national security implications.

| Additional IL5 requirement   | Azure Government implementation                          |
| ---------------------------- | -------------------------------------------------------- |
| Isolated infrastructure      | Azure Government IL5 regions                             |
| Increased personnel controls | Additional background investigation for operations staff |
| Logical separation           | Dedicated network segments, additional encryption        |
| Continuous monitoring        | Enhanced Defender for Cloud + Sentinel correlation       |

```bash
# Verify IL5-capable regions
az account list-locations \
  --query "[?metadata.regionCategory=='USGov'].{name:name, displayName:displayName}" \
  --output table
```

---

## 7. ITAR considerations

SAP systems in defense and aerospace may contain ITAR-controlled technical data. Azure Government provides ITAR compliance through:

| ITAR requirement          | Azure Government capability                        |
| ------------------------- | -------------------------------------------------- |
| Data residency (US-only)  | Azure Government data centers in US only           |
| Access by US persons only | Microsoft operations staff are screened US persons |
| Export control            | No data egress to non-US Azure regions             |
| Tenant isolation          | Azure Government is a separate Azure instance      |
| Audit trail               | Full audit logging for compliance demonstration    |

---

## 8. CSA-in-a-Box for federal SAP analytics

### Federal analytics architecture

```
SAP on Azure Government
    │
    ├── Fabric (Gov instance) → OneLake (CUI data)
    │       │
    │       ├── Power BI (Gov) → Financial reports, audit dashboards
    │       ├── Databricks (Gov) → ML for fraud detection
    │       └── Purview (Gov) → CUI classification, data governance
    │
    ├── Azure AI (Gov) → Process intelligence (check model availability)
    │
    └── Sentinel (Gov) → SAP security monitoring + SIEM
```

### Federal compliance mappings in CSA-in-a-Box

CSA-in-a-Box provides machine-readable compliance control mappings that can be applied to SAP workloads:

| Compliance framework  | CSA-in-a-Box artifact                            | SAP applicability          |
| --------------------- | ------------------------------------------------ | -------------------------- |
| NIST 800-53 Rev 5     | `governance/compliance/nist-800-53-rev5.yaml`    | All SAP control families   |
| FedRAMP Moderate/High | `governance/compliance/fedramp-moderate.yaml`    | SAP system authorization   |
| CMMC 2.0 Level 2      | `governance/compliance/cmmc-2.0-l2.yaml`         | DIB contractor SAP systems |
| HIPAA Security Rule   | `governance/compliance/hipaa-security-rule.yaml` | SAP HCM with health data   |

---

## 9. Procurement guidance

### Ordering vehicles for SAP on Azure Government

| Procurement vehicle                      | Use case                    | Notes                                   |
| ---------------------------------------- | --------------------------- | --------------------------------------- |
| Azure Government EA                      | Direct Azure consumption    | Enterprise Agreement with Gov pricing   |
| RISE with SAP (Gov)                      | SAP-managed infrastructure  | Verify RISE availability in Gov regions |
| GSA Schedule 70                          | IT services and software    | SAP and Microsoft licenses              |
| DoD ESI (Enterprise Software Initiative) | DoD-wide software licensing | SAP enterprise license agreements       |
| BPA (Blanket Purchase Agreement)         | Recurring SAP services      | Implementation and managed services     |

---

**Last updated:** 2026-04-30
**Maintainers:** CSA-in-a-Box core team
**Related:** [Security Migration](security-migration.md) | [Infrastructure Migration](infrastructure-migration.md) | [Best Practices](best-practices.md)
