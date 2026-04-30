# Best Practices -- VMware to Azure Migration

**Assessment methodology, phased migration waves, parallel-run validation, application dependency mapping, network cutover planning, decommission timeline, and Broadcom contract negotiation strategies.**

---

## 1. Assessment methodology

### Start with data, not opinions

The most common migration failure is migrating based on assumptions rather than data. Use Azure Migrate to collect actual utilization data for a minimum of 2 weeks (4 weeks preferred) before making sizing or migration path decisions.

| Assessment step                | Tool                                      | Duration                | Output                              |
| ------------------------------ | ----------------------------------------- | ----------------------- | ----------------------------------- |
| VMware inventory               | RVTools + Azure Migrate                   | 1 day setup, continuous | VM inventory spreadsheet            |
| Performance data collection    | Azure Migrate appliance                   | 2--4 weeks minimum      | CPU/memory/disk/network utilization |
| Application dependency mapping | Azure Migrate dependency analysis         | 1--2 weeks              | Dependency graph, migration groups  |
| Workload categorization        | Manual + assessment data                  | 1 week                  | Tier A/B/C/D classification         |
| TCO modeling                   | Azure Pricing Calculator + TCO Calculator | 1--2 weeks              | Cost comparison document            |
| Migration path selection       | Architecture review                       | 1 week                  | AVS vs IaaS vs PaaS per workload    |

### Workload categorization

Classify every VM into one of four tiers:

| Tier                         | Criteria                                                         | Migration path                                   | Typical percentage |
| ---------------------------- | ---------------------------------------------------------------- | ------------------------------------------------ | ------------------ |
| **A -- AVS lift-and-shift**  | VMware-dependent (vSphere APIs, NSX rules, VMware-certified ISV) | HCX to AVS                                       | 20--40%            |
| **B -- Re-platform to IaaS** | Standard OS, no VMware dependency, stable workload               | Azure Migrate to Azure VM                        | 25--40%            |
| **C -- Modernize to PaaS**   | Database, ETL, reporting, analytics workload                     | CSA-in-a-Box (Fabric, Databricks, ADF, Power BI) | 10--25%            |
| **D -- Decommission**        | Zombie VM, no active consumers, deprecated                       | Archive and delete                               | 15--30%            |

!!! tip "Decommission aggressively"
Most VMware estates have 15--30% zombie VMs. Every zombie VM you decommission instead of migrating saves $1,500--$3,000/year in Azure costs. Invest time in identifying these VMs early.

### Right-sizing opportunity

Azure Migrate assessment data typically reveals that VMs are significantly over-provisioned:

| Resource | Typical over-provisioning                    | Right-sizing savings                |
| -------- | -------------------------------------------- | ----------------------------------- |
| CPU      | 60--70% of VMs use < 25% of allocated CPU    | Downsize by 1--2 VM sizes           |
| Memory   | 40--50% of VMs use < 50% of allocated memory | Downsize or use burstable B-series  |
| Storage  | 50--60% of disks are < 30% utilized          | Use Standard SSD instead of Premium |

---

## 2. Phased migration waves

### Wave planning principles

1. **Start with low-risk workloads**: dev/test environments, non-production systems
2. **Validate with pilot production**: select 5--10 production VMs for the first wave
3. **Scale with confidence**: increase wave size after each successful wave
4. **Group by application**: migrate entire application stacks together, not individual VMs
5. **Respect dependencies**: use dependency mapping to avoid breaking application chains

### Recommended wave structure

| Wave                           | Timing       | Scope                             | Purpose                                              |
| ------------------------------ | ------------ | --------------------------------- | ---------------------------------------------------- |
| **Wave 0 -- Proof of concept** | Weeks 1--4   | 5--10 dev/test VMs                | Validate migration tools, networking, and procedures |
| **Wave 1 -- Pilot production** | Weeks 5--8   | 20--50 VMs (1--2 applications)    | Validate production migration with real applications |
| **Wave 2 -- Expansion**        | Weeks 9--14  | 100--200 VMs (5--10 applications) | Scale migration procedures, train additional staff   |
| **Wave 3 -- Main migration**   | Weeks 15--24 | 500--1,000 VMs (bulk of estate)   | Execute primary migration using proven procedures    |
| **Wave 4 -- Tail and cleanup** | Weeks 25--30 | Remaining VMs                     | Migrate stragglers, decommission zombies             |
| **Wave 5 -- Optimization**     | Weeks 30--36 | All migrated workloads            | Right-size, enable RI, optimize costs                |

### Application dependency mapping

Before each wave, validate application dependencies:

```bash
# Export Azure Migrate dependency data
# Azure Portal > Azure Migrate > Dependency analysis > Export
```

Critical dependencies to map:

- [ ] Database connections (which app VMs connect to which DB VMs)
- [ ] File share dependencies (which VMs mount which NFS/SMB shares)
- [ ] Service-to-service calls (API calls between application tiers)
- [ ] External integrations (connections to SaaS, partner systems, internet)
- [ ] Authentication dependencies (AD domain controllers, LDAP servers)
- [ ] DNS dependencies (internal DNS resolution requirements)
- [ ] Load balancer configurations (VIPs, backend pools, health probes)
- [ ] Monitoring dependencies (which agents report to which collectors)

---

## 3. Parallel-run validation

### Parallel-run strategy

Run migrated workloads in parallel with on-premises for a defined period:

| Parallel-run phase    | Duration   | Activity                                              |
| --------------------- | ---------- | ----------------------------------------------------- |
| **Smoke test**        | 1--2 days  | Basic functionality validation                        |
| **Active monitoring** | 1--2 weeks | Monitor performance, errors, and data consistency     |
| **User acceptance**   | 1 week     | End users validate workflows on Azure                 |
| **Cutover decision**  | 1 day      | Go/no-go decision based on parallel-run results       |
| **Post-cutover soak** | 2--4 weeks | Monitor production on Azure, keep on-prem as rollback |

### Validation checklist

For each migrated application:

**Functional validation:**

- [ ] Application starts and responds to requests
- [ ] All API endpoints return expected responses
- [ ] Authentication and authorization work correctly
- [ ] Database queries return correct results
- [ ] Batch jobs complete successfully
- [ ] Scheduled tasks execute on schedule
- [ ] Email/notification integrations work

**Performance validation:**

- [ ] Response time within acceptable range (compare to on-prem baseline)
- [ ] CPU utilization is healthy (< 80% sustained)
- [ ] Memory utilization is healthy (< 85% sustained)
- [ ] Disk IOPS meets workload requirements
- [ ] Network throughput is sufficient
- [ ] No packet loss or high latency

**Operational validation:**

- [ ] Azure Monitor collecting metrics and logs
- [ ] Alerts configured and tested
- [ ] Azure Backup running and verified
- [ ] DR replication (ASR) enabled and healthy
- [ ] NSG rules validated (no unexpected blocks)
- [ ] DNS resolution working for all names

---

## 4. Network cutover planning

### DNS-based cutover (recommended)

The safest cutover approach uses DNS changes:

1. **Before migration**: VM is at IP 10.100.1.50 (on-prem), DNS TTL set to 300 seconds
2. **During parallel run**: both on-prem (10.100.1.50) and Azure (10.20.1.50) are active
3. **Cutover**: update DNS A record from 10.100.1.50 to 10.20.1.50
4. **Rollback**: if issues, revert DNS A record to 10.100.1.50

```bash
# Pre-cutover: reduce DNS TTL to 60 seconds (24 hours before cutover)
# This ensures clients will pick up the change quickly

# Cutover: update DNS record
az network private-dns record-set a update \
  --resource-group rg-dns \
  --zone-name contoso.internal \
  --name app-server-01 \
  --set "aRecords[0].ipv4Address=10.20.1.50"

# Verify DNS propagation
nslookup app-server-01.contoso.internal

# Post-cutover: restore DNS TTL to normal (3600 seconds) after 48 hours stable
```

### Load balancer cutover

For applications behind load balancers:

1. **Before**: traffic flows through on-prem load balancer (NSX LB or F5)
2. **During parallel**: Azure Load Balancer is configured and health-checked
3. **Cutover**: update external DNS to point to Azure LB VIP (or update Global Traffic Manager weights)
4. **Rollback**: revert DNS to on-prem LB VIP

### Network cutover risks and mitigations

| Risk                                          | Mitigation                                                    |
| --------------------------------------------- | ------------------------------------------------------------- |
| DNS caching causes stale resolution           | Reduce TTL 24 hours before cutover; verify propagation        |
| Firewall rules block Azure-to-on-prem traffic | Pre-configure firewall rules for hybrid period                |
| Application hardcoded IPs (not DNS)           | Identify and update before cutover; consider HCX L2 extension |
| Certificate hostname mismatch                 | Verify certificates include both on-prem and Azure FQDNs      |
| BGP route convergence delay                   | Pre-advertise Azure routes; verify BGP session health         |

---

## 5. Decommission timeline

### On-premises decommission sequence

| Phase                      | Timing (after cutover) | Action                                                       |
| -------------------------- | ---------------------- | ------------------------------------------------------------ |
| **Soak period**            | Days 1--30             | Monitor Azure workloads; keep on-prem powered on as rollback |
| **Drain period**           | Days 30--60            | Verify zero traffic to on-prem; disable on-prem services     |
| **Power off**              | Day 60                 | Power off on-prem VMs (keep storage for 30 more days)        |
| **Archive**                | Days 60--90            | Export critical on-prem VM data to Azure Blob Storage        |
| **Decommission**           | Day 90                 | Delete on-prem VMs, reclaim storage, remove from vCenter     |
| **Hardware disposal**      | Days 90--180           | NIST 800-88 media sanitization; hardware recycling/resale    |
| **Lease/colo termination** | Days 180+              | Terminate datacenter leases, reduce colocation contracts     |

### Data retention considerations

Before decommissioning on-prem storage:

- [ ] Verify all data is accessible on Azure
- [ ] Confirm regulatory retention requirements are met
- [ ] Archive data that is not migrated but must be retained
- [ ] Document data lineage for audit trail
- [ ] Sanitize media per NIST 800-88 guidelines (Purge or Destroy)

---

## 6. Broadcom contract negotiation during migration

### Negotiation strategies

If your Broadcom VMware contract is up for renewal while you are migrating:

| Strategy                        | When to use                                 | Expected outcome                                             |
| ------------------------------- | ------------------------------------------- | ------------------------------------------------------------ |
| **Short-term extension**        | Migration will complete within 6--12 months | 6--12 month extension at current rates                       |
| **Usage-based reduction**       | Already migrated some workloads             | Reduce CPU count to match remaining on-prem                  |
| **Bundle downgrade**            | Using VCF but only need vSphere             | Negotiate VVF or vSphere Standard                            |
| **Competitive leverage**        | Azure migration is funded and approved      | Significant discount (Broadcom prefers some revenue to zero) |
| **Multi-year with exit clause** | Migration timeline is uncertain             | 2-year deal with early termination right                     |

### Negotiation timing

```
12 months before expiry: Begin migration planning and Azure POC
 9 months before expiry: Inform Broadcom of Azure migration plans
 6 months before expiry: Request short-term extension proposal
 3 months before expiry: Execute extension (or let expire if migration is complete)
```

!!! tip "Document everything"
Document all Broadcom pricing changes for internal budget justification. If you are a federal agency, this documentation supports competitive analysis requirements under FAR and may support TMF (Technology Modernization Fund) applications.

---

## 7. CSA-in-a-Box integration for data workloads

### Identifying data workloads for modernization

During assessment, identify VMs running data workloads that are candidates for PaaS modernization:

| VM workload indicator     | CSA-in-a-Box target               | Priority |
| ------------------------- | --------------------------------- | -------- |
| SQL Server installed      | Fabric Warehouse / Azure SQL MI   | High     |
| Oracle installed          | Databricks Lakehouse / Fabric     | High     |
| SSIS packages running     | Azure Data Factory + dbt          | High     |
| SSRS reports deployed     | Power BI Service                  | Medium   |
| Tableau Server installed  | Power BI Service                  | Medium   |
| Hadoop/Spark services     | Databricks + ADLS Gen2            | High     |
| ETL scripts (Python/bash) | ADF + dbt + Azure Functions       | Medium   |
| MongoDB/Redis/NoSQL       | Cosmos DB / Azure Cache for Redis | Medium   |
| Data catalog              | Microsoft Purview                 | Low      |

### Data workload migration sequencing

1. **Phase 1** (during infrastructure migration): migrate data VMs to Azure IaaS via Azure Migrate
2. **Phase 2** (post-infrastructure migration): modernize from Azure IaaS to PaaS via CSA-in-a-Box
3. **Phase 3** (optimization): optimize Fabric capacity, Direct Lake, dbt contracts

This two-phase approach gets you off VMware quickly (Phase 1) and then modernizes at Azure speed (Phase 2).

### CSA-in-a-Box deployment alongside AVS/IaaS

Deploy CSA-in-a-Box's data landing zone in parallel with AVS/IaaS landing zones:

```bash
# Deploy CSA-in-a-Box foundation
az deployment sub create \
  --location eastus2 \
  --template-file infra/main.bicep \
  --parameters infra/parameters/prod.bicepparam

# Verify data platform services
az resource list \
  --resource-group rg-data-platform \
  --query "[].{Name:name, Type:type, Location:location}" \
  --output table
```

---

## 8. Change management

### Stakeholder communication

| Stakeholder        | Communication                             | Frequency                     |
| ------------------ | ----------------------------------------- | ----------------------------- |
| Executive sponsor  | Migration progress dashboard              | Weekly                        |
| Application owners | Migration schedule for their applications | 2 weeks before each wave      |
| End users          | Service impact notifications              | Before and after each cutover |
| Help desk          | Known issues and workarounds              | Before each wave              |
| Security team      | Compliance validation results             | After each wave               |
| Finance            | Cost tracking vs budget                   | Monthly                       |

### Training plan

| Audience          | Training topic                                       | Duration  |
| ----------------- | ---------------------------------------------------- | --------- |
| VMware admins     | Azure fundamentals + AVS operations                  | 3--5 days |
| Network engineers | Azure networking (VNet, NSG, Firewall, ExpressRoute) | 2--3 days |
| Storage engineers | Azure storage (Managed Disks, ANF, Blob)             | 1--2 days |
| Security team     | Defender for Cloud, Sentinel, Azure Policy           | 2--3 days |
| Operations team   | Azure Monitor, Log Analytics, Automation             | 2--3 days |
| Data engineers    | CSA-in-a-Box, Fabric, Databricks, ADF, dbt           | 3--5 days |

---

## 9. Common pitfalls and avoidance

| Pitfall                               | Impact                                    | Avoidance                                        |
| ------------------------------------- | ----------------------------------------- | ------------------------------------------------ |
| **Migrating without assessment data** | Wrong VM sizes, unexpected costs          | Run Azure Migrate for 2--4 weeks before sizing   |
| **Migrating VMs individually**        | Broken application dependencies           | Group by application, migrate together           |
| **Skipping test migration**           | Production issues discovered at cutover   | Test every application before production cutover |
| **Insufficient network bandwidth**    | Slow migration, missed timelines          | Size ExpressRoute for migration throughput       |
| **Ignoring zombie VMs**               | Paying to run unused VMs on Azure         | Decommission zombie VMs before migration         |
| **No parallel-run period**            | No rollback option if issues found        | Minimum 2-week parallel run for production       |
| **Hardcoded IP addresses**            | Applications break after migration        | Audit for hardcoded IPs; use DNS names           |
| **Ignoring license optimization**     | Overpaying for Azure compute              | Apply Azure Hybrid Benefit, Reserved Instances   |
| **Late security review**              | Compliance gaps discovered post-migration | Include security team from assessment phase      |
| **No training**                       | Operational team unable to support Azure  | Train before migration, not after                |

---

## 10. Migration readiness checklist

Before starting migration execution:

**Technical readiness:**

- [ ] Azure Migrate assessment complete with 2+ weeks of performance data
- [ ] AVS private cloud deployed and HCX enabled (if using AVS path)
- [ ] Azure IaaS landing zone deployed (VNet, NSG, Firewall, Bastion)
- [ ] ExpressRoute or VPN connectivity verified
- [ ] DNS resolution working between on-premises and Azure
- [ ] Azure Backup and DR configured
- [ ] Monitoring (Azure Monitor, Defender for Cloud) enabled

**Organizational readiness:**

- [ ] Workload categorization complete (Tier A/B/C/D)
- [ ] Application dependency mapping complete
- [ ] Migration wave plan approved by stakeholders
- [ ] Rollback plan documented for each wave
- [ ] Training completed for operations team
- [ ] Change management process established
- [ ] Broadcom contract situation addressed (extension or expiry plan)

**Compliance readiness (federal):**

- [ ] ATO package updated to include Azure environment
- [ ] STIG hardening applied to Azure VMs
- [ ] Azure Policy assignments aligned with compliance framework
- [ ] Defender for Cloud compliance dashboard configured
- [ ] CSA-in-a-Box compliance mappings reviewed (for data workloads)

---

## Related

- [AVS Migration Guide](avs-migration.md)
- [Azure IaaS Migration Guide](azure-iaas-migration.md)
- [TCO Analysis](tco-analysis.md)
- [Federal Migration Guide](federal-migration-guide.md)
- [Benchmarks](benchmarks.md)
- [Migration Playbook](../vmware-to-azure.md)

---

**Last updated:** 2026-04-30
**Maintainers:** CSA-in-a-Box core team
