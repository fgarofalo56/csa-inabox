# Complete Feature Mapping -- VMware to Azure

**Every significant VMware/vSphere feature mapped to its Azure equivalent, with migration complexity ratings and recommended migration path.**

---

## How to read this mapping

Each row maps a VMware feature or capability to its Azure equivalent across two migration paths:

- **AVS path**: Azure VMware Solution (VMware runs natively on Azure)
- **Re-platform path**: Azure IaaS or PaaS services replacing VMware entirely

**Complexity ratings:**

- **XS**: configuration change only, no engineering effort
- **S**: 1--2 days of engineering effort
- **M**: 1--2 weeks of engineering effort
- **L**: 2--6 weeks of engineering effort
- **XL**: 6+ weeks of engineering effort, may require architecture changes

---

## 1. vSphere compute

| VMware feature                           | Description                                     | AVS equivalent                                     | Re-platform equivalent                                              | Complexity (AVS) | Complexity (re-platform) |
| ---------------------------------------- | ----------------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------- | ---------------- | ------------------------ |
| **ESXi hypervisor**                      | Bare-metal hypervisor for VM execution          | ESXi on AVS bare-metal hosts (identical)           | Azure Hypervisor (Hyper-V based)                                    | XS               | M                        |
| **vMotion**                              | Live migration of running VMs between hosts     | vMotion within AVS cluster (native)                | Azure Live Migration (automatic, transparent)                       | XS               | XS                       |
| **Storage vMotion**                      | Live migration of VM storage between datastores | Storage vMotion within AVS (native)                | Managed Disk migration (offline or via Azure Migrate)               | XS               | M                        |
| **DRS (Distributed Resource Scheduler)** | Automatic VM placement and load balancing       | DRS on AVS (native, Microsoft-tuned)               | Azure auto-scaling + VM Scale Sets                                  | XS               | M                        |
| **HA (High Availability)**               | Restart VMs on surviving hosts after failure    | vSphere HA on AVS (native)                         | Azure Availability Sets / Availability Zones                        | XS               | S                        |
| **FT (Fault Tolerance)**                 | Zero-downtime VM protection via shadow VM       | FT on AVS (native, limited use cases)              | No direct equivalent; use Availability Zones + application-level HA | XS               | L                        |
| **VM templates**                         | Golden images for consistent VM deployment      | VM templates on AVS (native)                       | Azure Compute Gallery + Shared Image Gallery                        | XS               | S                        |
| **Content Library**                      | Centralized template and ISO repository         | Content Library on AVS (native)                    | Azure Compute Gallery (global replication, RBAC)                    | XS               | S                        |
| **Snapshots**                            | Point-in-time VM state capture                  | VM snapshots on AVS (native)                       | Azure Managed Disk snapshots + Azure Backup                         | XS               | S                        |
| **Hot-add CPU/memory**                   | Add resources to running VM                     | Hot-add on AVS (native)                            | Azure VM resize (requires reboot for most sizes)                    | XS               | S                        |
| **VM encryption**                        | Encrypt VM disks and configuration              | VM encryption on AVS (native)                      | Azure Disk Encryption (ADE) or Server-Side Encryption (SSE)         | XS               | S                        |
| **UEFI / Secure Boot**                   | Secure boot for VMs                             | UEFI on AVS (native)                               | Azure Trusted Launch VMs                                            | XS               | S                        |
| **vTPM**                                 | Virtual Trusted Platform Module                 | vTPM on AVS (native)                               | Azure Trusted Launch with vTPM                                      | XS               | S                        |
| **Resource pools**                       | Hierarchical resource allocation                | Resource pools on AVS (native)                     | Azure resource groups + VM quotas + reservations                    | XS               | S                        |
| **VM affinity / anti-affinity**          | Control VM placement on hosts                   | Affinity rules on AVS (native)                     | Azure Availability Sets + proximity placement groups                | XS               | M                        |
| **Proactive HA**                         | Migrate VMs before hardware failure             | Proactive HA on AVS (host monitoring by Microsoft) | Azure predictive maintenance (automatic)                            | XS               | XS                       |

---

## 2. vCenter management

| VMware feature                    | Description                           | AVS equivalent                                             | Re-platform equivalent                              | Complexity (AVS) | Complexity (re-platform) |
| --------------------------------- | ------------------------------------- | ---------------------------------------------------------- | --------------------------------------------------- | ---------------- | ------------------------ |
| **vCenter Server**                | Centralized management for vSphere    | vCenter on AVS (Microsoft-managed)                         | Azure Portal + Azure Resource Manager               | XS               | M                        |
| **vSphere Client (web)**          | Web-based management interface        | vSphere Client on AVS (accessible via jump box or VPN)     | Azure Portal (web-based)                            | XS               | S                        |
| **PowerCLI**                      | PowerShell automation for vSphere     | PowerCLI against AVS vCenter (full compatibility)          | Azure PowerShell (Az module)                        | XS               | M                        |
| **vSphere API**                   | REST/SOAP API for automation          | vSphere API on AVS (full compatibility)                    | Azure REST API + Azure SDKs (Python, .NET, Go)      | XS               | L                        |
| **vCenter roles and permissions** | Role-based access control             | RBAC on AVS vCenter (native)                               | Azure RBAC + Entra ID                               | XS               | M                        |
| **Tags and categories**           | Resource organization and policy      | Tags on AVS (native)                                       | Azure Tags + Azure Policy                           | XS               | S                        |
| **Alarms**                        | Threshold-based alerting              | vCenter alarms on AVS (native)                             | Azure Monitor alerts + Action Groups                | XS               | M                        |
| **Tasks and events**              | Activity logging and tracking         | Tasks/events on AVS vCenter                                | Azure Activity Log + Azure Monitor                  | XS               | S                        |
| **Scheduled tasks**               | Automated recurring operations        | Scheduled tasks on AVS (native)                            | Azure Automation runbooks + Logic Apps              | XS               | M                        |
| **Customization specifications**  | OS customization during VM deployment | Customization specs on AVS (native)                        | Azure VM custom script extensions + cloud-init      | XS               | S                        |
| **Update Manager**                | Patch management for ESXi and VMs     | Microsoft-managed ESXi patching; guest OS via VMware tools | Azure Update Manager (centralized patch management) | XS               | S                        |
| **Performance charts**            | Historical performance monitoring     | Performance charts on AVS vCenter                          | Azure Monitor metrics + workbooks                   | XS               | M                        |
| **Content Library sync**          | Cross-site template synchronization   | Content Library on AVS (native)                            | Azure Compute Gallery with cross-region replication | XS               | S                        |

---

## 3. NSX networking

| VMware feature                 | Description                                 | AVS equivalent                            | Re-platform equivalent                          | Complexity (AVS) | Complexity (re-platform) |
| ------------------------------ | ------------------------------------------- | ----------------------------------------- | ----------------------------------------------- | ---------------- | ------------------------ |
| **NSX-T segments**             | Virtual network segments (overlay)          | NSX-T segments on AVS (native)            | Azure VNet subnets                              | XS               | M                        |
| **NSX-T Tier-0 gateway**       | North-south routing gateway                 | Tier-0 on AVS (Microsoft-managed)         | Azure VNet + Azure Firewall / NVA               | XS               | M                        |
| **NSX-T Tier-1 gateway**       | Tenant routing gateway                      | Tier-1 on AVS (customer-managed)          | Azure VNet peering + UDRs                       | XS               | M                        |
| **Distributed firewall**       | Micro-segmentation firewall                 | DFW on AVS (native NSX-T)                 | Azure NSG + Azure Firewall + ASGs               | XS               | L                        |
| **Gateway firewall**           | Perimeter firewall on gateways              | Gateway FW on AVS (native)                | Azure Firewall (Premium for IDPS)               | XS               | M                        |
| **NSX load balancer**          | Application load balancing                  | NSX LB on AVS (native)                    | Azure Load Balancer + Application Gateway       | XS               | M                        |
| **NSX VPN**                    | Site-to-site and remote access VPN          | NSX VPN on AVS (native)                   | Azure VPN Gateway                               | XS               | S                        |
| **DHCP**                       | Dynamic IP assignment                       | NSX DHCP on AVS (native)                  | Azure VNet DHCP (automatic)                     | XS               | XS                       |
| **DNS**                        | Name resolution                             | NSX DNS on AVS (native)                   | Azure DNS (public + private zones)              | XS               | S                        |
| **Network profiles**           | IP pool management for HCX                  | Network profiles on AVS (native, for HCX) | N/A (no HCX needed)                             | XS               | N/A                      |
| **Distributed switch**         | Virtual switch with central management      | dvSwitch on AVS (native)                  | Azure VNet (managed networking)                 | XS               | S                        |
| **Port groups**                | Network port configuration groups           | Port groups on AVS (native)               | Azure VNet subnets + NSG                        | XS               | S                        |
| **L2 extension (HCX)**         | Layer 2 network stretching during migration | HCX L2 extension on AVS (included free)   | N/A (re-platform uses L3)                       | XS               | N/A                      |
| **Network I/O Control (NIOC)** | Network traffic prioritization              | NIOC on AVS (native)                      | Azure Accelerated Networking + ExpressRoute QoS | XS               | S                        |
| **BGP routing**                | Dynamic routing protocol                    | BGP on AVS NSX-T (native)                 | Azure Route Server + ExpressRoute BGP           | XS               | M                        |

---

## 4. vSAN storage

| VMware feature              | Description                           | AVS equivalent                                 | Re-platform equivalent                                                   | Complexity (AVS) | Complexity (re-platform) |
| --------------------------- | ------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------ | ---------------- | ------------------------ |
| **vSAN datastore**          | Distributed storage across host disks | vSAN on AVS (native, NVMe flash)               | Azure Managed Disks (Premium SSD / Ultra)                                | XS               | M                        |
| **vSAN storage policies**   | Per-VM storage performance/resilience | vSAN policies on AVS (native)                  | Managed Disk SKU selection (Standard/Premium/Ultra)                      | XS               | S                        |
| **vSAN deduplication**      | Inline deduplication                  | Dedup on AVS vSAN (native)                     | N/A (Managed Disks handle storage efficiency)                            | XS               | XS                       |
| **vSAN compression**        | Inline compression                    | Compression on AVS vSAN (native)               | N/A (Managed Disks handle storage efficiency)                            | XS               | XS                       |
| **vSAN encryption**         | Data-at-rest encryption               | Encryption on AVS vSAN (native)                | Azure SSE with platform-managed or customer-managed keys                 | XS               | S                        |
| **vSAN stretched cluster**  | Cross-site vSAN for HA/DR             | AVS stretched cluster (across AZs)             | Azure Availability Zones + ASR                                           | S                | M                        |
| **VMDK**                    | Virtual machine disk format           | VMDK on AVS (native)                           | VHD/VHDX (Azure Managed Disks) -- automatic conversion via Azure Migrate | XS               | S                        |
| **Datastore clusters**      | Aggregated storage capacity           | Datastore clusters on AVS (native)             | Storage account + Managed Disk placement groups                          | XS               | S                        |
| **Storage DRS**             | Automatic VM storage placement        | SDRS on AVS (native)                           | Azure auto-placement (managed by platform)                               | XS               | XS                       |
| **SCSI / NVMe controllers** | VM storage controller types           | SCSI/NVMe on AVS (native)                      | Azure VM NVMe support (Ebsv5/Lsv3 series)                                | XS               | S                        |
| **iSCSI / NFS datastores**  | External storage connectivity         | External storage on AVS via Azure NetApp Files | Azure NetApp Files / Azure Files (NFS/SMB)                               | S                | S                        |
| **vSAN HCI Mesh**           | Cross-cluster vSAN capacity sharing   | Not available on AVS                           | N/A (Azure uses centralized storage)                                     | N/A              | N/A                      |

---

## 5. HCX migration

| VMware feature                             | Description                                | AVS equivalent                              | Re-platform equivalent               | Complexity (AVS) | Complexity (re-platform) |
| ------------------------------------------ | ------------------------------------------ | ------------------------------------------- | ------------------------------------ | ---------------- | ------------------------ |
| **HCX Manager**                            | Migration management appliance             | HCX Manager on AVS (deployed automatically) | N/A (use Azure Migrate)              | XS               | N/A                      |
| **HCX site pairing**                       | Connect on-prem and AVS vCenters           | Full support on AVS                         | N/A                                  | S                | N/A                      |
| **HCX vMotion migration**                  | Live migration, zero downtime              | Full support on AVS (included free)         | N/A (Azure Migrate uses replication) | S                | N/A                      |
| **HCX Bulk Migration**                     | Parallel VM migration with reboot          | Full support on AVS                         | N/A                                  | S                | N/A                      |
| **HCX RAV (Replication Assisted vMotion)** | Bulk + vMotion cutover                     | Full support on AVS                         | N/A                                  | S                | N/A                      |
| **HCX Cold Migration**                     | Offline VM migration                       | Full support on AVS                         | N/A                                  | XS               | N/A                      |
| **HCX L2 Extension**                       | Layer 2 network stretching                 | Full support on AVS                         | N/A                                  | M                | N/A                      |
| **HCX Network Extension HA**               | Redundant L2 extension                     | Full support on AVS                         | N/A                                  | M                | N/A                      |
| **HCX Service Mesh**                       | Connectivity infrastructure                | Full support on AVS                         | N/A                                  | M                | N/A                      |
| **HCX Mobility Optimized Networking**      | Routing optimization for extended networks | Full support on AVS                         | N/A                                  | M                | N/A                      |

---

## 6. Disaster recovery and business continuity

| VMware feature                  | Description                          | AVS equivalent                                 | Re-platform equivalent                       | Complexity (AVS) | Complexity (re-platform) |
| ------------------------------- | ------------------------------------ | ---------------------------------------------- | -------------------------------------------- | ---------------- | ------------------------ |
| **SRM (Site Recovery Manager)** | Orchestrated DR failover             | Azure Site Recovery (ASR) or VMware SRM on AVS | Azure Site Recovery                          | M                | M                        |
| **vSphere Replication**         | Asynchronous VM replication          | vSphere Replication on AVS or ASR              | Azure Site Recovery (continuous replication) | S                | S                        |
| **SRM recovery plans**          | Automated failover runbooks          | ASR recovery plans                             | ASR recovery plans                           | M                | M                        |
| **SRM DR testing**              | Non-disruptive DR tests              | ASR test failover                              | ASR test failover                            | S                | S                        |
| **vSAN stretched cluster**      | Synchronous replication across sites | AVS stretched cluster                          | Availability Zones + ASR                     | S                | M                        |
| **Zerto**                       | Third-party CDP replication          | Zerto on AVS (supported)                       | Zerto for Azure (supported)                  | M                | M                        |
| **Veeam**                       | Backup and replication               | Veeam for AVS (supported)                      | Veeam for Azure (supported)                  | S                | S                        |
| **JetStream DR**                | Cloud DR for AVS                     | JetStream DR for AVS (supported)               | N/A                                          | M                | N/A                      |

---

## 7. Monitoring and operations

| VMware feature                             | Description                             | AVS equivalent                                    | Re-platform equivalent                    | Complexity (AVS) | Complexity (re-platform) |
| ------------------------------------------ | --------------------------------------- | ------------------------------------------------- | ----------------------------------------- | ---------------- | ------------------------ |
| **Aria Operations (vROps)**                | Infrastructure monitoring and analytics | Azure Monitor + AVS monitoring workbook           | Azure Monitor + Log Analytics             | M                | M                        |
| **Aria Operations for Logs (Log Insight)** | Log aggregation and analysis            | Azure Monitor Logs (Log Analytics)                | Azure Monitor Logs (Log Analytics)        | M                | M                        |
| **Aria Automation (vRA)**                  | Infrastructure-as-code and self-service | Azure Resource Manager + Bicep + Azure Automation | Azure Resource Manager + Bicep            | L                | L                        |
| **Aria Operations for Networks (vRNI)**    | Network visibility and analytics        | Azure Network Watcher + NSG Flow Logs             | Azure Network Watcher + Traffic Analytics | M                | M                        |
| **Aria Lifecycle Manager**                 | VMware product lifecycle                | Microsoft-managed (AVS host/vCenter patching)     | Azure Update Manager                      | XS               | S                        |
| **SDDC Manager**                           | VCF SDDC deployment and lifecycle       | N/A (AVS is managed SDDC)                         | N/A                                       | N/A              | N/A                      |
| **Skyline Health**                         | Proactive health and support            | Azure Service Health + Resource Health            | Azure Service Health + Resource Health    | S                | S                        |
| **vCenter performance charts**             | Real-time and historical metrics        | vCenter charts on AVS + Azure Monitor             | Azure Monitor metrics + dashboards        | XS               | M                        |

---

## 8. Security

| VMware feature                       | Description                    | AVS equivalent                                       | Re-platform equivalent                               | Complexity (AVS) | Complexity (re-platform) |
| ------------------------------------ | ------------------------------ | ---------------------------------------------------- | ---------------------------------------------------- | ---------------- | ------------------------ |
| **vSphere SSO**                      | Identity and authentication    | vSphere SSO on AVS + Entra ID integration            | Entra ID (Azure AD)                                  | S                | S                        |
| **vCenter RBAC**                     | Role-based access control      | vCenter RBAC on AVS + Azure RBAC                     | Azure RBAC + Entra ID PIM                            | XS               | M                        |
| **VM encryption**                    | Encrypt VM files and disks     | VM encryption on AVS (native)                        | Azure Disk Encryption / SSE                          | XS               | S                        |
| **vSGX (Software Guard Extensions)** | Confidential computing         | Not available on AVS                                 | Azure Confidential VMs (DCsv3/DCdsv3)                | N/A              | M                        |
| **NSX micro-segmentation**           | Zero-trust network security    | NSX DFW on AVS (native)                              | Azure NSG + ASG + Azure Firewall                     | XS               | L                        |
| **Carbon Black (AppDefense)**        | Endpoint protection            | Microsoft Defender for Endpoint + Defender for Cloud | Microsoft Defender for Endpoint + Defender for Cloud | M                | M                        |
| **Certificate management**           | TLS/SSL certificate lifecycle  | AVS certificates (Microsoft-managed) + Key Vault     | Azure Key Vault                                      | S                | S                        |
| **Audit logging**                    | Security event logging         | vCenter logs + Azure Monitor                         | Azure Monitor + Microsoft Sentinel                   | S                | M                        |
| **Compliance dashboards**            | Regulatory compliance tracking | Azure Policy + Defender for Cloud compliance         | Azure Policy + Defender for Cloud compliance         | M                | M                        |

---

## 9. Containers and Kubernetes

| VMware feature                  | Description                         | AVS equivalent                                     | Re-platform equivalent                             | Complexity (AVS) | Complexity (re-platform) |
| ------------------------------- | ----------------------------------- | -------------------------------------------------- | -------------------------------------------------- | ---------------- | ------------------------ |
| **Tanzu Kubernetes Grid (TKG)** | Kubernetes on vSphere               | TKG on AVS (supported) or migrate to AKS           | Azure Kubernetes Service (AKS)                     | S                | L                        |
| **vSphere with Tanzu**          | Supervisor cluster + namespaces     | Run on AVS or migrate to AKS                       | AKS with namespaces + Entra ID                     | S                | L                        |
| **Tanzu Mission Control**       | Multi-cluster Kubernetes management | Azure Arc-enabled Kubernetes                       | Azure Arc-enabled Kubernetes                       | M                | M                        |
| **Tanzu Application Catalog**   | Curated container images            | Azure Container Registry + Defender for Containers | Azure Container Registry + Defender for Containers | M                | M                        |
| **Harbor Registry**             | Container image registry on VMware  | Azure Container Registry (ACR)                     | Azure Container Registry (ACR)                     | S                | S                        |
| **Tanzu Observability**         | Kubernetes monitoring               | Azure Monitor Container Insights                   | Azure Monitor Container Insights                   | M                | M                        |

---

## 10. VMware Cloud Foundation (VCF)

| VMware feature                             | Description                      | AVS equivalent                              | Re-platform equivalent                 | Complexity (AVS) | Complexity (re-platform) |
| ------------------------------------------ | -------------------------------- | ------------------------------------------- | -------------------------------------- | ---------------- | ------------------------ |
| **VCF SDDC Manager**                       | Automated SDDC lifecycle         | AVS is a managed SDDC (Microsoft lifecycle) | N/A (no SDDC concept)                  | XS               | N/A                      |
| **VCF Workload Domains**                   | Isolated compute/storage domains | AVS private clouds + clusters               | Azure subscriptions + resource groups  | S                | M                        |
| **VCF AVN (Application Virtual Networks)** | Tenant networking                | NSX-T segments on AVS                       | Azure VNet + subnet design             | S                | M                        |
| **VCF vRealize Suite**                     | Full Aria suite deployment       | Azure Monitor + Azure Automation + Defender | Azure Monitor + Automation + Defender  | L                | L                        |
| **VCF vSAN integration**                   | Storage integrated with VCF      | vSAN on AVS (integrated)                    | Azure Managed Disks + Storage Accounts | XS               | M                        |
| **VCF Certificate Authority**              | PKI management                   | Azure Key Vault + App Service Certificates  | Azure Key Vault                        | M                | M                        |
| **VCF multi-instance**                     | Multi-site VCF deployment        | Multiple AVS private clouds + Global Reach  | Azure multi-region deployment          | M                | M                        |

---

## 11. Data platform (VMware to CSA-in-a-Box)

For database, analytics, and ETL workloads running on VMware VMs, CSA-in-a-Box provides the modernization target:

| VMware-hosted workload | CSA-in-a-Box target                     | Migration approach                                      | Complexity |
| ---------------------- | --------------------------------------- | ------------------------------------------------------- | ---------- |
| **SQL Server VM**      | Fabric Warehouse / Azure SQL MI         | Azure Database Migration Service                        | M          |
| **Oracle VM**          | Databricks Lakehouse / Fabric Lakehouse | Data export + ADF ingestion                             | L          |
| **PostgreSQL VM**      | Azure Database for PostgreSQL Flexible  | Azure DMS / pg_dump + restore                           | M          |
| **MySQL VM**           | Azure Database for MySQL Flexible       | Azure DMS / mysqldump + restore                         | M          |
| **MongoDB VM**         | Azure Cosmos DB (MongoDB API)           | Azure DMS / mongodump + restore                         | M          |
| **SSIS VM**            | Azure Data Factory                      | Pipeline-by-pipeline migration                          | L          |
| **Informatica VM**     | Azure Data Factory + dbt                | See [Informatica migration](../informatica/index.md)    | L          |
| **SSRS VM**            | Power BI Service                        | Report-by-report conversion                             | M          |
| **Tableau Server VM**  | Power BI Service                        | See [Tableau migration](../tableau-to-powerbi/index.md) | L          |
| **Hadoop cluster VMs** | Databricks + ADLS Gen2                  | See [Hadoop migration](../hadoop-hive/index.md)         | XL         |
| **Spark cluster VMs**  | Databricks                              | Notebook migration                                      | L          |
| **ETL cron job VMs**   | ADF + dbt + Azure Functions             | Pipeline redesign                                       | M          |
| **Data catalog VM**    | Microsoft Purview                       | Automated migration via Purview APIs                    | M          |
| **ML training VMs**    | Azure AI Foundry + Azure ML             | Model re-training on Azure compute                      | L          |

---

## 12. Feature mapping summary

| VMware domain                   | Total features mapped | AVS complexity (median) | Re-platform complexity (median) |
| ------------------------------- | --------------------- | ----------------------- | ------------------------------- |
| vSphere compute                 | 16                    | XS                      | S                               |
| vCenter management              | 13                    | XS                      | S--M                            |
| NSX networking                  | 15                    | XS                      | M                               |
| vSAN storage                    | 12                    | XS                      | S                               |
| HCX migration                   | 10                    | S                       | N/A                             |
| Disaster recovery               | 8                     | S--M                    | S--M                            |
| Monitoring and operations       | 8                     | XS--M                   | M                               |
| Security                        | 9                     | XS--S                   | S--M                            |
| Containers / Kubernetes         | 6                     | S--M                    | M--L                            |
| VMware Cloud Foundation         | 7                     | XS--M                   | M                               |
| Data platform (to CSA-in-a-Box) | 14                    | N/A                     | M--L                            |
| **Total**                       | **118**               | **XS**                  | **M**                           |

**Key takeaway:** AVS migration preserves full VMware feature compatibility with minimal effort (median XS). Re-platform to Azure IaaS requires more engineering (median M) but eliminates the VMware dependency entirely. Data workload modernization via CSA-in-a-Box requires the most effort (median M--L) but delivers the highest long-term value.

---

## Related

- [AVS Migration Guide](avs-migration.md)
- [Azure IaaS Migration Guide](azure-iaas-migration.md)
- [Networking Migration](networking-migration.md)
- [Storage Migration](storage-migration.md)
- [Security Migration](security-migration.md)
- [TCO Analysis](tco-analysis.md)
- [Migration Playbook](../vmware-to-azure.md)

---

**Last updated:** 2026-04-30
**Maintainers:** CSA-in-a-Box core team
