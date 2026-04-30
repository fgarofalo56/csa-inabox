# Federal Migration Guide -- IBM Db2 to Azure SQL

**Audience:** Federal CIOs, Program Managers, AOs (Authorizing Officials), ISSOs, Contracting Officers
**Purpose:** Government-specific guidance for migrating IBM Db2 databases to Azure SQL in federal environments, covering compliance, acquisition, and agency-specific considerations.

---

## The federal Db2 landscape

IBM Db2 is deeply embedded in the federal government. Major agencies running Db2 on z/OS mainframes include:

| Agency            | Db2 usage                                                       | Scale                                      |
| ----------------- | --------------------------------------------------------------- | ------------------------------------------ |
| **IRS**           | Individual Master File, Business Master File processing         | Largest z/OS Db2 installation in the world |
| **SSA**           | Benefits processing, earnings records, disability determination | Multiple z/OS LPARs, billions of records   |
| **DoD**           | Logistics, personnel, financial systems (DFAS)                  | Multiple z/OS and LUW installations        |
| **VA**            | VistA components, benefits administration                       | z/OS and LUW across multiple facilities    |
| **Treasury**      | Financial management, debt collection                           | z/OS production systems                    |
| **DHS/CBP**       | Border security systems, traveler processing                    | z/OS and LUW                               |
| **USPS**          | Mail processing, financial systems                              | Large z/OS Db2 estate                      |
| **Census Bureau** | Decennial census processing, American Community Survey          | LUW and z/OS                               |

These agencies collectively spend billions of dollars annually on IBM mainframe hardware, software licensing, and specialized labor.

---

## 1. Compliance framework

### FedRAMP High

Azure SQL Managed Instance and Azure SQL Database are **FedRAMP High authorized** in Azure Government regions. This provides inheritance for:

- **Access Control (AC):** Azure AD (Entra ID) authentication, RBAC, conditional access policies
- **Audit and Accountability (AU):** Azure SQL Auditing, Defender for SQL, Azure Monitor
- **System and Communications Protection (SC):** TDE (encryption at rest), Always Encrypted, TLS 1.2+ in transit
- **Identification and Authentication (IA):** Entra ID, multi-factor authentication, managed identities

CSA-in-a-Box extends FedRAMP High inheritance through Bicep-deployed infrastructure with controls mapped in `csa_platform/csa_platform/governance/compliance/nist-800-53-rev5.yaml`.

### FISMA

FISMA requires each federal information system to have an Authority to Operate (ATO). Migrating from Db2 on z/OS (in a federal data center with its own ATO) to Azure SQL MI (under Azure Government's FedRAMP authorization) requires:

1. **System boundary update:** Redefine the system boundary to include Azure Government services.
2. **Control inheritance documentation:** Document which NIST 800-53 controls are inherited from Azure Government vs. customer-managed.
3. **Interconnection Security Agreement (ISA):** If maintaining connectivity between the mainframe and Azure during migration, an ISA may be required.
4. **ATO amendment or reauthorization:** Coordinate with the AO to amend the existing ATO or initiate a new authorization.

### DoD IL4 / IL5

| Impact Level | Azure SQL MI availability                | Notes                                                       |
| ------------ | ---------------------------------------- | ----------------------------------------------------------- |
| **IL2**      | GA (commercial Azure)                    | Non-CUI workloads                                           |
| **IL4**      | GA (Azure Government)                    | CUI workloads                                               |
| **IL5**      | GA (Azure Government, dedicated regions) | Controlled Unclassified Information with higher sensitivity |
| **IL6**      | Not available                            | Classified workloads must remain on cleared facilities      |

Check `docs/GOV_SERVICE_MATRIX.md` for current service-level IL5 availability.

### CMMC 2.0

Defense Industrial Base (DIB) contractors migrating from Db2 to Azure SQL must ensure the target environment meets CMMC 2.0 Level 2 requirements. CSA-in-a-Box provides control mappings in `csa_platform/csa_platform/governance/compliance/cmmc-2.0-l2.yaml`.

### Data residency and CUI

**Controlled Unclassified Information (CUI)** stored in Db2 must remain in authorized Azure Government regions after migration:

- **Azure Government regions:** US Gov Virginia, US Gov Texas, US Gov Arizona, US DoD Central, US DoD East
- **Data must not traverse commercial Azure regions** during migration
- **Backup and DR replicas** must also reside in Azure Government regions

Configure Azure SQL MI with geo-redundant backup in Azure Government:

```bash
az sql mi create \
    --backup-storage-redundancy Geo \
    --location usgovvirginia
    # Geo-redundant backup replicates within Azure Government regions
```

---

## 2. Audit trail preservation

### Preserving Db2 audit evidence during migration

Federal systems are subject to audit at any time. Before decommissioning Db2, preserve:

1. **Db2 audit logs:** Extract db2audit output (LUW) or SMF Type 101/102 records (z/OS) for the retention period required by the system's records schedule.
2. **RACF/ACF2/Top Secret security logs:** Access control evidence from the mainframe security subsystem.
3. **Batch job execution history:** JES2/JES3 spool output and job scheduling system logs.
4. **Change management records:** All schema changes, DDL execution history, and database configuration changes.

```bash
# Db2 LUW: extract audit logs
db2audit extract file audit_extract.txt from path /db2/audit/
# Archive to Azure Blob Storage
azcopy copy "audit_extract.txt" \
    "https://auditvault.blob.core.usgovcloudapi.net/db2-audit/audit_extract.txt"
```

### Establishing Azure SQL audit trail

Configure Azure SQL MI auditing to maintain continuous audit coverage:

```sql
-- Enable server-level auditing
CREATE SERVER AUDIT Db2MigrationAudit
TO URL = 'https://auditvault.blob.core.usgovcloudapi.net/sqlmi-audit/'
WITH (QUEUE_DELAY = 1000, ON_FAILURE = CONTINUE);

ALTER SERVER AUDIT Db2MigrationAudit WITH (STATE = ON);

-- Create database audit specification
USE FinanceDB;
CREATE DATABASE AUDIT SPECIFICATION FinanceAuditSpec
FOR SERVER AUDIT Db2MigrationAudit
ADD (SELECT, INSERT, UPDATE, DELETE ON SCHEMA::FINANCE BY [public]),
ADD (EXECUTE ON SCHEMA::FINANCE BY [public])
WITH (STATE = ON);
```

---

## 3. Acquisition strategy

### IBM contract considerations

Federal agencies typically have IBM software licenses through one of these vehicles:

1. **Enterprise License Agreement (ELA):** Bundled licensing across multiple IBM products. Migrating Db2 off the ELA may trigger repricing of remaining products (CICS, MQ, z/OS).
2. **General Services Administration (GSA) schedule:** Standard federal pricing for IBM products.
3. **Blanket Purchase Agreement (BPA):** Agency-specific terms negotiated with IBM.

**Key considerations when planning Db2 migration:**

- Review ELA exit clauses and repricing triggers before announcing the migration.
- Negotiate maintenance reduction schedules aligned with migration waves.
- Factor in IBM audit risk during the transition period (IBM LMS audits often increase when customers announce migration plans).

### Azure acquisition vehicles

| Vehicle                                           | Description                                                            | Best for                                               |
| ------------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------ |
| **MACC** (Microsoft Azure Consumption Commitment) | Pre-committed Azure spend; all Azure services count against commitment | Large agencies with predictable Azure consumption      |
| **CSP** (Cloud Solution Provider)                 | Through a Microsoft partner/reseller                                   | Agencies preferring managed services through a partner |
| **GSA MAS** (Multiple Award Schedule)             | Standard federal pricing on GSA                                        | Standard procurement                                   |
| **SEWP V**                                        | NASA SEWP contract vehicle                                             | Fast procurement (2-3 weeks)                           |
| **ESI** (Enterprise Software Initiative)          | DoD enterprise software agreements                                     | DoD organizations                                      |

**MACC alignment:** If the agency has an existing MACC, Azure SQL MI consumption counts against the commitment. This can be a compelling financial argument: migrating from IBM licensing (separate budget line) to Azure consumption (already committed spend) improves budget utilization.

---

## 4. Mainframe modernization funding

### IT Modernization mandates

Several OMB and congressional directives support federal mainframe modernization:

- **FITARA (Federal IT Acquisition Reform Act):** Empowers agency CIOs to manage IT spending including legacy modernization.
- **21st Century IDEA Act:** Requires digital modernization of government services.
- **TMF (Technology Modernization Fund):** Provides funding for modernization projects. Mainframe migration is an eligible use case.
- **Working Capital Fund (WCF):** Some agencies fund modernization through WCF mechanisms.
- **Cloud Smart policy:** OMB's cloud adoption strategy explicitly targets legacy mainframe modernization.

### Building the business case

Federal business cases for Db2 migration should include:

1. **Cost avoidance:** IBM license renewal costs avoided over 5 years.
2. **Hardware refresh avoidance:** Mainframe hardware refresh cycles ($8-15M per refresh for large agencies).
3. **Workforce risk mitigation:** Document the age demographics of mainframe staff and the cost differential between mainframe and cloud talent.
4. **Mission improvement:** Faster analytics (Power BI, Fabric), AI capabilities (Azure OpenAI), and real-time data access that batch-oriented mainframe processing cannot provide.
5. **Compliance improvement:** Control inheritance from Azure Government reduces customer-managed compliance burden.

---

## 5. Migration in Azure Government regions

### Azure SQL MI in Gov regions

Azure SQL MI is available in all Azure Government regions:

| Region          | Name          | IL level | Notes                            |
| --------------- | ------------- | -------- | -------------------------------- |
| US Gov Virginia | usgovvirginia | IL4, IL5 | Primary region for most agencies |
| US Gov Texas    | usgovtexas    | IL4, IL5 | Secondary region for geo-DR      |
| US Gov Arizona  | usgovarizona  | IL4, IL5 | Additional option                |
| US DoD Central  | usdodcentral  | IL5      | DoD-specific                     |
| US DoD East     | usdodeast     | IL5      | DoD-specific                     |

### Gov-specific connection strings

Azure Government uses different domain suffixes:

```
# Azure Government SQL MI endpoint
sqlmi-instance.database.usgovcloudapi.net

# Azure Government Blob Storage (for data staging)
https://storageaccount.blob.core.usgovcloudapi.net

# Azure Government Key Vault
https://keyvault.vault.usgovcloudapi.net
```

### Gov cloud limitations

Some Azure SQL features may have delayed availability in Azure Government compared to commercial Azure. Check the Azure Government services availability page for current status. Features that are typically available:

- SQL Agent
- Linked servers
- TDE and Always Encrypted
- SQL Auditing
- Automatic backups and PITR
- Geo-replication and auto-failover groups
- Fabric Mirroring (verify current availability)

---

## 6. Security classification considerations

### Unclassified (public or CUI)

Standard Azure SQL MI deployment in Azure Government. Follow the guidance in this migration center.

### CUI (Controlled Unclassified Information)

CUI requires:

- Azure Government regions only
- Data encryption at rest (TDE, enabled by default) and in transit (TLS 1.2+)
- Access logging and audit (Azure SQL Auditing)
- Network isolation (private endpoints, VNet integration)
- Marking and handling per NARA CUI Registry categories

### Classified (IL6+)

**Out of scope for CSA-in-a-Box.** Classified Db2 workloads must remain in classified environments. If the classified data can be sanitized or downgraded, migrate the sanitized version to Azure Government.

---

## 7. Agency-specific patterns

### DoD agencies

- Deploy Azure SQL MI in DoD-specific regions (US DoD Central, US DoD East) for IL5.
- Use CAC/PIV authentication via Entra ID integration.
- Follow DISA STIGs for SQL Server as applicable to Azure SQL MI.
- Coordinate with DISA for network connectivity (DREN, NIPRNet connectivity to Azure).

### Civilian agencies (CFO Act agencies)

- Deploy in US Gov Virginia (primary) + US Gov Texas (DR).
- Coordinate ATO amendment with agency CISO/ISSO.
- Budget for migration through agency IT modernization fund or TMF.
- Plan for Continuous ATO (cATO) alignment with Azure's continuous compliance monitoring.

### Intelligence community

Azure SQL MI is available in Azure Government Secret regions for IC workloads at the SECRET level. Coordinate with Microsoft's classified cloud team for access and provisioning.

---

## 8. Federal migration timeline

Federal migrations take longer than commercial due to compliance, acquisition, and governance processes.

| Phase                      | Duration                | Key federal activities                                                       |
| -------------------------- | ----------------------- | ---------------------------------------------------------------------------- |
| Planning and acquisition   | 3-6 months              | Business case, ATO planning, MACC/contract vehicle selection, IBM ELA review |
| Landing zone deployment    | 1-2 months              | Azure Government subscription, VNet, ExpressRoute, Azure SQL MI provisioning |
| ATO amendment              | 2-4 months (concurrent) | System boundary update, control documentation, ISSO review, AO approval      |
| Pilot migration            | 2-3 months              | Low-risk database migration, application testing, dual-run validation        |
| Production migration waves | 6-12 months             | Phased database migrations by complexity tier                                |
| Mainframe decommission     | 3-6 months              | LPAR capacity reduction, IBM contract modification, hardware return          |

**Total realistic timeline: 18-30 months** for a mid-size federal Db2 estate.

---

## 9. Post-migration compliance

After migration, maintain compliance through:

1. **Continuous monitoring:** Azure Monitor + Defender for SQL + Purview.
2. **Regular access reviews:** Entra ID access reviews for Azure SQL MI permissions.
3. **Vulnerability management:** Microsoft Defender for SQL vulnerability assessments.
4. **Audit log retention:** Configure Azure SQL Auditing with retention meeting NARA records schedule requirements.
5. **Compliance reporting:** CSA-in-a-Box compliance dashboards via Power BI.

---

## Related resources

- [Migration Playbook](../db2-to-azure-sql.md) -- end-to-end migration plan
- [TCO Analysis](tco-analysis.md) -- financial justification for federal leadership
- [Mainframe Considerations](mainframe-considerations.md) -- z/OS-specific migration guidance
- [Best Practices](best-practices.md) -- assessment methodology
- `docs/compliance/nist-800-53-rev5.md` -- NIST control mappings
- `docs/compliance/cmmc-2.0-l2.md` -- CMMC control mappings
- `docs/GOV_SERVICE_MATRIX.md` -- Azure Government service availability

---

**Maintainers:** csa-inabox core team
**Last updated:** 2026-04-30
