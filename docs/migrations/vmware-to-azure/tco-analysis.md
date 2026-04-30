# Total Cost of Ownership -- VMware On-Premises vs Azure

**A detailed TCO comparison of on-premises VMware (pre- and post-Broadcom acquisition), Azure VMware Solution (AVS), and Azure IaaS re-platform for enterprise workloads.**

---

## Executive summary

The Broadcom acquisition has transformed VMware from a predictable, moderately priced virtualization platform into one of the most expensive infrastructure components in the enterprise stack. This analysis compares four scenarios across 3-year and 5-year horizons:

1. **On-prem VMware (pre-Broadcom)**: the baseline most organizations are migrating from
2. **On-prem VMware (post-Broadcom)**: the new reality after license conversion
3. **Azure VMware Solution (AVS)**: VMware on Azure dedicated infrastructure
4. **Azure IaaS re-platform**: native Azure VMs replacing VMware entirely

The analysis uses a reference environment of 100 ESXi hosts running 1,500 VMs as the baseline. All figures are illustrative and should be adjusted for your specific environment.

---

## Reference environment

| Parameter                       | Value            |
| ------------------------------- | ---------------- |
| ESXi hosts                      | 100              |
| Total VMs                       | 1,500            |
| Average vCPU per VM             | 4                |
| Average RAM per VM              | 16 GB            |
| Total storage (usable)          | 500 TB           |
| Average VM utilization (CPU)    | 25--35%          |
| Average VM utilization (memory) | 45--60%          |
| Network bandwidth               | 10 Gbps per host |
| Datacenter locations            | 2 (primary + DR) |
| VMware admin FTEs               | 6                |
| Infrastructure admin FTEs       | 4                |

---

## 1. On-premises VMware costs -- pre-Broadcom baseline

This represents the cost structure most organizations had before November 2023.

### Licensing (perpetual + SnS)

| Component                              | Per-unit cost                           | Quantity    | Annual cost  |
| -------------------------------------- | --------------------------------------- | ----------- | ------------ |
| vSphere Enterprise Plus (per CPU)      | $1,175 SnS/yr (perpetual already owned) | 200 CPUs    | $235,000     |
| vCenter Standard (per instance)        | $1,500 SnS/yr                           | 4 instances | $6,000       |
| NSX Advanced (per CPU) -- if licensed  | $1,400 SnS/yr                           | 200 CPUs    | $280,000     |
| vSAN Advanced (per CPU) -- if licensed | $1,100 SnS/yr                           | 200 CPUs    | $220,000     |
| SRM Standard (per VM, 75 protected)    | $475 SnS/yr                             | 75 VMs      | $35,625      |
| Aria Operations Advanced (per CPU)     | $350 SnS/yr                             | 200 CPUs    | $70,000      |
| **Total annual VMware licensing**      |                                         |             | **$846,625** |

!!! note "Perpetual license assumption"
Many organizations purchased perpetual licenses for vSphere and vCenter years ago. The annual cost shown is Support and Subscription (SnS) renewal only. Organizations that purchased NSX, vSAN, and Aria separately paid additional perpetual license fees that are now sunk costs.

### Infrastructure costs

| Component                                                     | Annual cost    |
| ------------------------------------------------------------- | -------------- |
| Hardware depreciation (100 hosts, 5-year cycle, $15K/host/yr) | $1,500,000     |
| Datacenter colocation / facilities (2 sites)                  | $600,000       |
| Network equipment (switches, firewalls, load balancers)       | $200,000       |
| Storage (SAN/NAS if not vSAN, depreciation)                   | $400,000       |
| Power and cooling                                             | $300,000       |
| Hardware maintenance contracts                                | $250,000       |
| **Total annual infrastructure**                               | **$3,250,000** |

### Operations costs

| Component                                                 | Annual cost    |
| --------------------------------------------------------- | -------------- |
| VMware administrators (6 FTEs at $130K avg fully loaded)  | $780,000       |
| Infrastructure/datacenter engineers (4 FTEs at $120K avg) | $480,000       |
| Third-party tools (backup, monitoring, ITSM)              | $200,000       |
| Training and certification                                | $30,000        |
| **Total annual operations**                               | **$1,490,000** |

### Pre-Broadcom annual total: $5,586,625

---

## 2. On-premises VMware costs -- post-Broadcom

Broadcom's changes affect this baseline dramatically.

### New licensing model

| Scenario                             | Bundle required               | Per-CPU subscription cost | Annual licensing cost (200 CPUs) |
| ------------------------------------ | ----------------------------- | ------------------------- | -------------------------------- |
| **vSphere + vCenter only**           | vSphere Standard              | ~$2,125/CPU/yr            | $425,000                         |
| **vSphere + NSX**                    | vSphere Foundation (VVF)      | ~$4,250/CPU/yr            | $850,000                         |
| **Full SDDC (vSphere + NSX + vSAN)** | VMware Cloud Foundation (VCF) | ~$7,000--$8,500/CPU/yr    | $1,400,000--$1,700,000           |

### Cost impact analysis

| Component        | Pre-Broadcom   | Post-Broadcom (VVF) | Post-Broadcom (VCF) | Change              |
| ---------------- | -------------- | ------------------- | ------------------- | ------------------- |
| VMware licensing | $846,625       | $850,000            | $1,700,000          | 0% to +101%         |
| Infrastructure   | $3,250,000     | $3,250,000          | $3,250,000          | No change           |
| Operations       | $1,490,000     | $1,490,000          | $1,490,000          | No change           |
| **Annual total** | **$5,586,625** | **$5,590,000**      | **$6,440,000**      | **+0.1% to +15.3%** |

!!! warning "The real impact is at renewal"
The table above understates the impact for many organizations. The most affected customers are those who:

    - Previously licensed only vSphere and vCenter (low SnS) but now must buy VVF or VCF bundles
    - Had per-incident or basic support and now face mandatory premium support tiers
    - Used perpetual licenses with low SnS rates that are being forcibly converted to subscription
    - Negotiated special pricing that Broadcom is not honoring at renewal

    For these customers, the licensing line item alone can increase 3x--12x.

### Hidden costs in the post-Broadcom era

| Hidden cost                 | Description                                                        | Annual impact                             |
| --------------------------- | ------------------------------------------------------------------ | ----------------------------------------- |
| **Forced bundle adoption**  | Paying for NSX, vSAN, Aria features not used                       | $200K--$800K depending on bundle          |
| **Support quality decline** | Longer resolution times, more reliance on internal staff           | $50K--$200K in additional FTE time        |
| **Partner disruption**      | Loss of preferred partners, higher professional services rates     | $50K--$150K in services cost increases    |
| **Contract uncertainty**    | Inability to predict renewal pricing, shorter term options         | Risk premium / accelerated migration cost |
| **Procurement overhead**    | New licensing model requires re-evaluation of all VMware contracts | $25K--$75K in procurement/legal time      |

---

## 3. Azure VMware Solution (AVS) costs

AVS provides VMware vSphere, vCenter, NSX, vSAN, and HCX on dedicated Azure bare-metal infrastructure. All VMware licenses are included.

### AVS host pricing

| Host SKU | vCPUs                      | RAM      | Storage       | Azure Commercial ($/hr) | Azure Government ($/hr) | Monthly (730 hrs)   |
| -------- | -------------------------- | -------- | ------------- | ----------------------- | ----------------------- | ------------------- |
| AV36     | 36 cores (HT: 72 threads)  | 576 GB   | 15.36 TB NVMe | ~$9.37                  | ~$11.71                 | ~$6,840 / ~$8,548   |
| AV36P    | 36 cores (HT: 72 threads)  | 768 GB   | 19.2 TB NVMe  | ~$10.52                 | ~$13.15                 | ~$7,680 / ~$9,600   |
| AV52     | 52 cores (HT: 104 threads) | 1,536 GB | 38.4 TB NVMe  | ~$16.58                 | ~$20.73                 | ~$12,100 / ~$15,130 |
| AV64     | 64 cores (HT: 128 threads) | 1,024 GB | 15.36 TB NVMe | ~$13.70                 | ~$17.12                 | ~$10,000 / ~$12,500 |

!!! note "Pricing is approximate"
Azure pricing varies by region, reservation commitment, and enterprise agreement. Use the [Azure Pricing Calculator](https://azure.microsoft.com/pricing/calculator/) for current pricing.

### AVS sizing for reference environment

The reference environment (100 on-prem hosts, 1,500 VMs) typically consolidates to fewer AVS hosts due to higher per-host density and elimination of spare capacity requirements:

| Sizing approach                                         | AVS hosts needed | Host SKU | Monthly cost (Commercial) | Monthly cost (Gov) |
| ------------------------------------------------------- | ---------------- | -------- | ------------------------- | ------------------ |
| Conservative (1:1 host mapping)                         | 100              | AV36P    | $768,000                  | $960,000           |
| Right-sized (30% utilization gain)                      | 70               | AV36P    | $537,600                  | $672,000           |
| Optimized (40% utilization gain + decommission zombies) | 55               | AV36P    | $422,400                  | $528,000           |

### AVS included services (no additional VMware license cost)

- vSphere Enterprise Plus
- vCenter Server
- NSX-T Advanced (Data Center)
- vSAN Enterprise
- HCX Enterprise (migration tool)
- VMware lifecycle management (Microsoft-managed patching)

### AVS additional Azure costs

| Component                                            | Monthly cost                             |
| ---------------------------------------------------- | ---------------------------------------- |
| ExpressRoute circuit (1 Gbps, metered)               | $1,000--$3,000                           |
| ExpressRoute Global Reach (for on-prem connectivity) | $500--$1,500                             |
| Azure Monitor (log ingestion, ~500 GB/month)         | $1,250                                   |
| Azure Backup for AVS VMs                             | $2,000--$5,000                           |
| Azure Site Recovery for DR                           | $3,750 (at $25/VM for 150 protected VMs) |
| Azure Firewall (if used for internet egress)         | $1,500--$3,000                           |
| **Total additional Azure costs**                     | **$10,000--$15,750/month**               |

### AVS total annual cost (optimized sizing)

| Component                            | Annual cost (Commercial) | Annual cost (Gov) |
| ------------------------------------ | ------------------------ | ----------------- |
| AVS hosts (55 x AV36P)               | $5,068,800               | $6,336,000        |
| Additional Azure services            | $150,000                 | $150,000          |
| Operations (4 FTEs, reduced from 10) | $520,000                 | $520,000          |
| **Annual total**                     | **$5,738,800**           | **$7,006,000**    |

---

## 4. Azure IaaS re-platform costs

Re-platforming eliminates VMware entirely. VMs are converted to Azure-native VMs via Azure Migrate.

### Azure VM sizing for reference environment

| VM tier                | Count     | Azure VM size | Monthly cost per VM | Monthly total      |
| ---------------------- | --------- | ------------- | ------------------- | ------------------ |
| Small (2 vCPU, 8 GB)   | 600       | D2s_v5        | $70                 | $42,000            |
| Medium (4 vCPU, 16 GB) | 500       | D4s_v5        | $140                | $70,000            |
| Large (8 vCPU, 32 GB)  | 250       | D8s_v5        | $281                | $70,250            |
| XL (16 vCPU, 64 GB)    | 100       | D16s_v5       | $562                | $56,200            |
| Database (high-memory) | 50        | E8s_v5        | $365                | $18,250            |
| **Total VM compute**   | **1,500** |               |                     | **$256,700/month** |

### Savings with Reserved Instances

| Commitment      | Discount | Monthly compute cost | Annual compute cost |
| --------------- | -------- | -------------------- | ------------------- |
| Pay-as-you-go   | 0%       | $256,700             | $3,080,400          |
| 1-year reserved | ~35%     | $166,855             | $2,002,260          |
| 3-year reserved | ~55%     | $115,515             | $1,386,180          |

### Storage costs

| Storage type                           | Capacity | Monthly cost      |
| -------------------------------------- | -------- | ----------------- |
| Premium SSD v2 (P30, 1 TB per disk)    | 500 TB   | $65,000           |
| Standard SSD (archive/cold VMs)        | 200 TB   | $8,000            |
| Azure Backup (daily, 30-day retention) | 700 TB   | $14,000           |
| **Total storage**                      |          | **$87,000/month** |

### Networking costs

| Component                         | Monthly cost     |
| --------------------------------- | ---------------- |
| ExpressRoute (1 Gbps, metered)    | $2,000           |
| Azure Firewall                    | $1,500           |
| Load balancers (5 x Standard)     | $750             |
| VPN Gateway (backup connectivity) | $400             |
| Bandwidth (5 TB egress/month)     | $435             |
| **Total networking**              | **$5,085/month** |

### Azure IaaS total annual cost (3-year reserved)

| Component                           | Annual cost (Commercial) | Annual cost (Gov, +25%) |
| ----------------------------------- | ------------------------ | ----------------------- |
| VM compute (3-year RI)              | $1,386,180               | $1,732,725              |
| Storage                             | $1,044,000               | $1,305,000              |
| Networking                          | $61,020                  | $76,275                 |
| Azure Monitor + Defender            | $60,000                  | $75,000                 |
| Operations (4 FTEs)                 | $520,000                 | $520,000                |
| Azure Migrate (one-time, amortized) | $50,000                  | $50,000                 |
| **Annual total**                    | **$3,121,200**           | **$3,759,000**          |

---

## 5. Three-year TCO comparison

| Cost category                       | On-prem (pre-Broadcom) | On-prem (post-Broadcom VCF) | AVS (optimized)     | Azure IaaS (3-yr RI)  |
| ----------------------------------- | ---------------------- | --------------------------- | ------------------- | --------------------- |
| Year 1 licensing/compute            | $846,625               | $1,700,000                  | $5,068,800          | $1,386,180            |
| Year 1 infrastructure               | $3,250,000             | $3,250,000                  | Included            | Included              |
| Year 1 operations                   | $1,490,000             | $1,490,000                  | $670,000            | $630,000              |
| Year 1 migration cost               | $0                     | $0                          | $500,000            | $750,000              |
| **Year 1 total**                    | **$5,586,625**         | **$6,440,000**              | **$6,238,800**      | **$2,766,180**        |
| Year 2 total                        | $5,586,625             | $6,440,000                  | $5,738,800          | $2,016,180            |
| Year 3 total                        | $5,586,625             | $6,440,000                  | $5,738,800          | $2,016,180            |
| **3-year total**                    | **$16,759,875**        | **$19,320,000**             | **$17,716,400**     | **$6,798,540**        |
| **3-year savings vs post-Broadcom** | Baseline               | --                          | **$1,603,600 (8%)** | **$12,521,460 (65%)** |

---

## 6. Five-year TCO comparison

| Metric                              | On-prem (pre-Broadcom) | On-prem (post-Broadcom VCF) | AVS (optimized)      | Azure IaaS (3-yr RI)  |
| ----------------------------------- | ---------------------- | --------------------------- | -------------------- | --------------------- |
| **5-year total**                    | **$28,433,125**        | **$33,200,000**             | **$29,194,000**      | **$11,831,440**       |
| **5-year savings vs post-Broadcom** | Baseline               | --                          | **$4,006,000 (12%)** | **$21,368,560 (64%)** |

!!! tip "Hardware refresh included"
The 5-year on-prem projections include a hardware refresh in year 4 ($1.5M capital). AVS and Azure IaaS have no hardware refresh costs.

### Cumulative cost chart

```
Year    On-prem(pre)   On-prem(post)   AVS          Azure IaaS
  1     $5,586,625     $6,440,000      $6,238,800   $2,766,180
  2     $11,173,250    $12,880,000     $11,977,600  $4,782,360
  3     $16,759,875    $19,320,000     $17,716,400  $6,798,540
  4     $23,846,500    $26,760,000     $23,455,200  $9,314,720
  5     $28,433,125    $33,200,000     $29,194,000  $11,831,440
```

---

## 7. Hidden costs comparison

Costs frequently missed in TCO analyses:

| Hidden cost                        | On-prem VMware                              | AVS                                       | Azure IaaS                                |
| ---------------------------------- | ------------------------------------------- | ----------------------------------------- | ----------------------------------------- |
| **HCX Enterprise license**         | $5,000+/site (paid)                         | Included free                             | N/A                                       |
| **NSX licensing**                  | $1,400/CPU/yr (or forced VCF bundle)        | Included                                  | N/A (use NSG/Azure Firewall)              |
| **vSAN licensing**                 | $1,100/CPU/yr (or forced VCF bundle)        | Included                                  | N/A (use Managed Disks)                   |
| **Hardware procurement lead time** | 3--12 months for new servers                | Minutes to add hosts                      | Minutes to deploy VMs                     |
| **Capacity headroom**              | 20--30% reserved for failover               | Azure manages failover capacity           | Azure manages via Availability Zones      |
| **DR infrastructure**              | Duplicate datacenter, SRM licenses          | Azure Site Recovery ($25/VM/month)        | Azure Site Recovery ($25/VM/month)        |
| **Compliance auditing**            | Physical datacenter audits, manual evidence | Azure compliance certifications inherited | Azure compliance certifications inherited |
| **Power and cooling**              | $200--$500/kW/month                         | Included                                  | Included                                  |
| **Physical security**              | Cameras, card access, guards                | Azure datacenter security                 | Azure datacenter security                 |
| **End-of-life hardware disposal**  | NIST 800-88 media sanitization costs        | N/A                                       | N/A                                       |
| **VMware admin talent premium**    | Increasing as VMware skills become niche    | Reduced (Microsoft manages VMware layer)  | Eliminated (Azure-native skills)          |
| **Broadcom contract negotiation**  | Legal/procurement cycles per renewal        | N/A (Azure billing)                       | N/A (Azure billing)                       |

---

## 8. Cost optimization strategies

### AVS cost optimization

- **Right-size clusters**: start with minimum nodes, scale based on actual utilization
- **Stretch clusters**: use AVS stretch clusters for HA instead of duplicate clusters
- **Reserved instances**: 1-year and 3-year reservations for AVS hosts reduce costs 20--40%
- **Azure Hybrid Benefit**: apply existing Windows Server and SQL Server licenses to reduce costs
- **Auto-scale**: scale AVS clusters up during business hours, down overnight (where workloads allow)

### Azure IaaS cost optimization

- **Reserved Instances**: 3-year RIs save up to 55% on compute
- **Azure Savings Plan**: flexible commitment across VM families, 1-year or 3-year
- **Spot VMs**: up to 90% savings for fault-tolerant, batch, and dev/test workloads
- **Auto-scaling**: scale VM Scale Sets based on demand
- **Right-sizing**: use Azure Advisor to identify oversized VMs
- **Dev/test pricing**: reduced rates for dev/test subscriptions
- **Azure Hybrid Benefit**: bring Windows Server and SQL Server licenses (saves up to 40%)
- **Burstable VMs (B-series)**: up to 60% cheaper for low-utilization VMs

### CSA-in-a-Box data workload optimization

For data workloads modernized via CSA-in-a-Box:

- **Fabric capacity autoscale**: right-size F-SKU based on actual demand
- **Databricks auto-termination**: shut down idle clusters automatically
- **Direct Lake**: zero-copy Power BI analytics eliminates data movement costs
- **ADF pipeline optimization**: use Mapping Data Flows only for complex transforms; dbt for SQL transforms
- **OneLake tiering**: hot/cool storage tiers based on access patterns

---

## 9. Migration cost considerations

| Cost element                  | AVS migration                          | Azure IaaS migration                  |
| ----------------------------- | -------------------------------------- | ------------------------------------- |
| **Assessment tooling**        | Azure Migrate (free) + RVTools (free)  | Azure Migrate (free) + RVTools (free) |
| **Professional services**     | $200K--$500K (depending on complexity) | $300K--$750K (more re-engineering)    |
| **Dual-run period**           | 2--3 months (on-prem + AVS)            | 3--6 months (on-prem + Azure)         |
| **ExpressRoute provisioning** | $5K--$15K one-time                     | $5K--$15K one-time                    |
| **Training**                  | Minimal (same VMware tools)            | $50K--$100K (Azure skills)            |
| **Application testing**       | $50K--$150K                            | $100K--$250K (more changes)           |
| **Total migration cost**      | **$300K--$750K**                       | **$500K--$1.2M**                      |

---

## 10. Federal pricing considerations

### Azure Government premium

Azure Government pricing carries approximately 25% premium over Azure Commercial for most services. This premium covers:

- Dedicated government-only infrastructure
- US-person-only operations staff
- FedRAMP High authorization maintenance
- Additional compliance and audit costs

### Broadcom federal pricing

Federal VMware pricing under Broadcom is negotiated per-agency through federal enterprise agreements. Reported impacts:

- DoD-wide VMware enterprise agreements are under renegotiation with significant increases
- Civilian agencies report 2x--4x increases at renewal
- Some agencies are exploring inter-agency purchasing vehicles to leverage collective bargaining

### Cost comparison for federal (Azure Government pricing)

| Scenario                                 | 3-year TCO  | 5-year TCO  |
| ---------------------------------------- | ----------- | ----------- |
| On-prem VMware (post-Broadcom)           | $19,320,000 | $33,200,000 |
| AVS in Azure Government                  | $21,018,000 | $35,242,500 |
| Azure IaaS in Azure Government (3-yr RI) | $8,277,000  | $14,572,200 |

!!! warning "AVS in Gov is more expensive"
AVS in Azure Government is more expensive than on-prem VMware when the on-prem hardware is already paid for. The value proposition for AVS in Gov is **elimination of datacenter costs, operational burden reduction, and compliance simplification** -- not raw compute cost savings. For pure cost savings in Gov, Azure IaaS re-platform is the stronger option.

---

## 11. Broadcom contract negotiation during migration

If you are in the process of migrating but your Broadcom contract is up for renewal:

1. **Negotiate short-term extensions** (6--12 months) rather than multi-year renewals
2. **Request per-CPU pricing** rather than bundled pricing if you only need vSphere
3. **Leverage Azure migration commitment** as negotiating leverage -- Broadcom is more flexible when they know you are leaving
4. **Document all pricing changes** for internal budget justification and audit trail
5. **Engage procurement early** -- Broadcom negotiations are slower post-acquisition
6. **Consider interim AVS** -- move critical workloads to AVS immediately to reduce on-prem license footprint

---

## Related

- [Why Azure over VMware](why-azure-over-vmware.md)
- [Complete Feature Mapping](feature-mapping-complete.md)
- [AVS Migration Guide](avs-migration.md)
- [Azure IaaS Migration Guide](azure-iaas-migration.md)
- [Migration Playbook](../vmware-to-azure.md)
- [CSA-in-a-Box Cost Management](../../COST_MANAGEMENT.md)

---

**Last updated:** 2026-04-30
**Maintainers:** CSA-in-a-Box core team
