# Federal Migration Guide -- SQL Server to Azure SQL

**Audience:** Federal IT leaders, AOs (Authorizing Officials), ISSEs, federal DBAs
**Scope:** Azure SQL in Government regions, FedRAMP, IL4/IL5, DoD, data residency, Defender for SQL in Gov

---

## Overview

Federal agencies operate millions of SQL Server instances across civilian and defense environments. Migrating these workloads to Azure SQL requires navigating FedRAMP authorization, Impact Level (IL) requirements, data residency mandates, and agency-specific security controls. This guide covers the federal-specific considerations for SQL Server-to-Azure SQL migrations, including Azure Government region availability, compliance inheritance, and CSA-in-a-Box integration for governed analytics.

---

## Azure Government regions for SQL Server

### Available Azure SQL services in Gov regions

| Azure SQL service                | Azure Government | Azure Government DoD | IL4 | IL5     | FedRAMP High |
| -------------------------------- | ---------------- | -------------------- | --- | ------- | ------------ |
| Azure SQL Database               | Yes              | Yes                  | Yes | Yes     | Yes          |
| Azure SQL Managed Instance       | Yes              | Yes                  | Yes | Yes     | Yes          |
| SQL Server on Azure VM           | Yes              | Yes                  | Yes | Yes     | Yes          |
| Azure Database Migration Service | Yes              | Partial              | Yes | Yes     | Yes          |
| Elastic Jobs                     | Yes              | Yes                  | Yes | Yes     | Yes          |
| Azure SQL Hyperscale             | Yes              | Partial              | Yes | Partial | Yes          |

### Government region locations

| Region          | Region code   | Availability | DoD support             |
| --------------- | ------------- | ------------ | ----------------------- |
| US Gov Virginia | usgovvirginia | GA           | IL4, IL5                |
| US Gov Texas    | usgovtexas    | GA           | IL4, IL5                |
| US Gov Arizona  | usgovarizona  | GA           | IL4, IL5                |
| US DoD Central  | usdodcentral  | GA           | IL4, IL5, IL6 (limited) |
| US DoD East     | usdodeast     | GA           | IL4, IL5, IL6 (limited) |

---

## FedRAMP and Impact Level mapping

### FedRAMP High inheritance

Azure SQL Database and Managed Instance in Azure Government inherit FedRAMP High authorization. This provides the following control inheritance:

| NIST 800-53 control family        | Azure SQL contribution                 | Agency responsibility             |
| --------------------------------- | -------------------------------------- | --------------------------------- |
| **AC (Access Control)**           | Entra ID authentication, RBAC, RLS     | User provisioning, access reviews |
| **AU (Audit)**                    | Azure SQL Auditing, Defender alerts    | Audit review, retention policies  |
| **SC (System & Comm Protection)** | TDE, Always Encrypted, TLS 1.2+        | Key management policies           |
| **IA (Identification & Auth)**    | Entra ID, MFA, conditional access      | Identity lifecycle management     |
| **CP (Contingency Planning)**     | Geo-replication, failover groups, PITR | DR plan documentation, testing    |
| **IR (Incident Response)**        | Defender for SQL alerts                | IR procedures, notification       |
| **RA (Risk Assessment)**          | Vulnerability assessment               | Risk acceptance decisions         |
| **SA (System Acquisition)**       | SDLC controls, change management       | Agency SA plan                    |
| **CM (Configuration Mgmt)**       | ARM/Bicep deployment, Azure Policy     | CM plan, baseline documentation   |

### Impact Level requirements

| IL level | Data classification           | Azure SQL availability             | Key requirements                |
| -------- | ----------------------------- | ---------------------------------- | ------------------------------- |
| **IL2**  | Public, unclassified          | Azure Commercial + Gov             | Standard FedRAMP Moderate       |
| **IL4**  | CUI (Controlled Unclassified) | Azure Government                   | FedRAMP High, US persons        |
| **IL5**  | CUI + mission-critical        | Azure Government (select services) | Physical separation, US persons |
| **IL6**  | Classified (SECRET)           | Azure Government DoD               | Dedicated infrastructure        |

!!! warning "IL6 limitation"
Azure SQL Database and SQL MI are **not available at IL6**. For classified workloads requiring relational database services, deploy SQL Server on Azure VMs in Azure Government DoD regions, or use isolated DoD tenants with dedicated infrastructure.

---

## Data residency and sovereignty

### Ensuring data stays in US Government regions

```bicep
// Bicep: Enforce Gov region deployment
resource sqlServer 'Microsoft.Sql/servers@2023-08-01-preview' = {
  name: sqlServerName
  location: 'usgovvirginia'  // Force Gov region
  properties: {
    administratorLogin: adminLogin
    administratorLoginPassword: adminPassword
    minimalTlsVersion: '1.2'
    publicNetworkAccess: 'Disabled'
    restrictOutboundNetworkAccess: 'Enabled'  // Prevent data exfiltration
  }
}
```

### Azure Policy for data residency

```json
{
    "if": {
        "allOf": [
            {
                "field": "type",
                "equals": "Microsoft.Sql/servers"
            },
            {
                "field": "location",
                "notIn": ["usgovvirginia", "usgovtexas", "usgovarizona"]
            }
        ]
    },
    "then": {
        "effect": "deny"
    }
}
```

### Data replication considerations

When configuring geo-replication or failover groups, both primary and secondary must reside in Azure Government regions:

```bash
# Geo-replication within Gov regions
az sql db replica create \
  --resource-group prod-rg \
  --server sql-gov-virginia \
  --name FederalDB \
  --partner-server sql-gov-texas \
  --partner-resource-group dr-rg
```

---

## Microsoft Defender for SQL in Government

Defender for SQL is available in Azure Government and provides:

- **Advanced Threat Protection:** SQL injection detection, anomalous access patterns, brute-force attacks
- **Vulnerability Assessment:** Configuration scanning against CIS benchmarks and STIG baselines
- **Security alerts:** Integration with Azure Sentinel and SIEM systems

```bash
# Enable Defender for SQL in Gov
az sql server advanced-threat-protection-setting update \
  --resource-group prod-rg \
  --name sql-gov-virginia \
  --state Enabled

# Enable vulnerability assessment
az sql server va-setting update \
  --resource-group prod-rg \
  --name sql-gov-virginia \
  --storage-account govstorageaccount \
  --storage-container-path "https://govstorageaccount.blob.core.usgovcloudapi.net/va-scans"
```

!!! info "Gov endpoint differences"
Azure Government uses different endpoint suffixes:

    - SQL Server: `*.database.usgovcloudapi.net` (not `.windows.net`)
    - Blob Storage: `*.blob.core.usgovcloudapi.net`
    - Key Vault: `*.vault.usgovcloudapi.net`
    - Entra ID: `login.microsoftonline.us`

---

## STIG compliance for SQL Server on Azure VMs

For SQL Server on Azure VMs in DoD environments, apply DISA STIGs:

### SQL Server STIG baseline

| STIG requirement                       | Azure SQL implementation                    |
| -------------------------------------- | ------------------------------------------- |
| V-213927: Audit DOD events             | Azure SQL Auditing to Log Analytics         |
| V-213928: Encrypt data at rest         | TDE (enabled by default on Azure SQL DB/MI) |
| V-213930: Audit privileged actions     | Extended Events or Azure audit              |
| V-213931: Enforce password complexity  | Entra ID with conditional access            |
| V-213932: Limit failed login attempts  | Entra ID lockout policies                   |
| V-213933: TLS 1.2 minimum              | `minimalTlsVersion: '1.2'` on server        |
| V-213935: Disable unnecessary features | Review and disable unused services          |

```powershell
# Apply SQL Server STIG on Azure VM using PowerShell DSC
# or the Azure Automanage Machine Configuration

# Example: Enforce TLS 1.2
Set-ItemProperty -Path 'HKLM:\SYSTEM\CurrentControlSet\Control\SecurityProviders\SCHANNEL\Protocols\TLS 1.0\Server' `
  -Name 'Enabled' -Value 0 -Type DWord
Set-ItemProperty -Path 'HKLM:\SYSTEM\CurrentControlSet\Control\SecurityProviders\SCHANNEL\Protocols\TLS 1.1\Server' `
  -Name 'Enabled' -Value 0 -Type DWord
```

---

## Federal migration scenarios

### Scenario 1: Civilian agency (IL4)

**Context:** HHS agency migrating 50 SQL Server databases from on-premises data center to Azure Government.

**Approach:**

1. Deploy CSA-in-a-Box landing zone in `usgovvirginia`
2. Provision Azure SQL Managed Instance (General Purpose, 16 vCores)
3. Configure ExpressRoute from agency data center to Azure Gov
4. Migrate using DMS online mode for minimal downtime
5. Enable Defender for SQL and configure Log Analytics auditing
6. Register databases in Purview for data classification (PII/PHI)
7. Configure ADF pipelines to mirror data to Fabric for analytics

**Timeline:** 16-20 weeks including ATO update documentation

### Scenario 2: DoD component (IL5)

**Context:** Army installation migrating mission-critical SQL Server databases to Azure Government DoD.

**Approach:**

1. Deploy in `usdodcentral` or `usdodeast` region
2. Use SQL Server on Azure VMs for full compatibility and STIG compliance
3. Configure Always On AG across DoD regions for DR
4. Apply SQL Server and Windows Server STIG baselines
5. Implement Entra ID with CAC/PIV authentication
6. Deploy IDS/IPS with network virtual appliances
7. Configure Azure Sentinel for security monitoring

**Timeline:** 20-28 weeks including full ATO process

### Scenario 3: End-of-support migration (SQL Server 2016)

**Context:** Federal agency running SQL Server 2016 needs to migrate before extended support ends July 2026.

**Approach:**

1. Assess all SQL Server 2016 instances with Azure Migrate
2. For each database, determine target: SQL DB, MI, or VM
3. For SQL on VM targets, leverage free Extended Security Updates on Azure
4. Prioritize databases by criticality and compliance impact
5. Execute migration waves over 12-16 weeks
6. Update SSP documentation for ATO

**Timeline:** 12-16 weeks (urgent timeline)

---

## ATO documentation impact

Migrating to Azure SQL changes the system boundary and requires ATO documentation updates:

| Document                                | Required updates                                               |
| --------------------------------------- | -------------------------------------------------------------- |
| **System Security Plan (SSP)**          | Update system boundary, data flow diagrams, inherited controls |
| **Security Assessment Report (SAR)**    | New assessment of cloud-hosted components                      |
| **Plan of Action & Milestones (POA&M)** | Track any migration-related findings                           |
| **Continuous Monitoring Plan**          | Add Azure Monitor, Defender, and audit log review procedures   |
| **Incident Response Plan**              | Update IR procedures for cloud-hosted databases                |
| **Contingency Plan**                    | Update DR procedures with failover group details               |

### CSA-in-a-Box compliance integration

CSA-in-a-Box provides compliance documentation that maps to federal requirements:

- **NIST 800-53 Rev 5:** `csa_platform/governance/compliance/nist-800-53-rev5.yaml`
- **CMMC 2.0 Level 2:** `csa_platform/governance/compliance/cmmc-2.0-l2.yaml`
- **HIPAA Security Rule:** `csa_platform/governance/compliance/hipaa-security-rule.yaml`

These mappings document which CSA-in-a-Box controls satisfy federal requirements, accelerating the ATO update process.

---

## Federal pricing and acquisition

### Azure Government pricing

Azure Government typically carries a 20-30% premium over commercial Azure. However, the TCO comparison still strongly favors Azure SQL over on-premises:

| Item                             | On-premises (annual) | Azure Government (annual) |
| -------------------------------- | -------------------- | ------------------------- |
| SQL Enterprise license (16 core) | $80,000+             | $0 (AHB)                  |
| Hardware amortization            | $25,000              | $0                        |
| DBA labor (infrastructure)       | $90,000              | $30,000                   |
| DR infrastructure                | $30,000              | $15,000                   |
| Facility/power                   | $12,000              | $0                        |
| Azure SQL MI GP 16 vCore         | $0                   | $84,000                   |
| **Total**                        | **$237,000**         | **$129,000**              |
| **Savings**                      | Baseline             | **46%**                   |

### Acquisition vehicles

- **Azure Government EA:** Enterprise Agreement for government
- **CSP Government:** Cloud Solution Provider program
- **GSA Schedule 70:** IT services and products
- **SEWP V:** NASA SEWP contract vehicle
- **DoD ESI:** Enterprise Software Initiative

---

## Related

- [Migration Playbook](../sql-server-to-azure.md)
- [Security Migration](security-migration.md)
- [HA/DR Migration](ha-dr-migration.md)
- [TCO Analysis](tco-analysis.md)
- [Best Practices](best-practices.md)

---

## References

- [Azure Government SQL documentation](https://learn.microsoft.com/azure/azure-government/documentation-government-services-database)
- [Azure Government compliance](https://learn.microsoft.com/azure/azure-government/compliance/azure-services-in-fedramp-auditscope)
- [DoD IL overview](https://learn.microsoft.com/azure/compliance/offerings/offering-dod-il2)
- [Azure Government endpoints](https://learn.microsoft.com/azure/azure-government/compare-azure-government-global-azure)
- [DISA STIGs for SQL Server](https://public.cyber.mil/stigs/downloads/)
- [Azure SQL FedRAMP documentation](https://learn.microsoft.com/azure/azure-sql/database/security-overview)
