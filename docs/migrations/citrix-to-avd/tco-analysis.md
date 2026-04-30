# Total Cost of Ownership: Citrix vs AVD vs Windows 365

**Audience:** CFO, CIO, Procurement, IT Finance
**Reading time:** 20 minutes
**Last updated:** 2026-04-30

---

## Methodology

This analysis compares the 5-year total cost of ownership for three virtual desktop platforms across three deployment sizes. All costs are based on published list pricing as of April 2026 and verified customer benchmarks. Azure Government pricing carries an approximately 25% premium over commercial Azure; federal-specific costs are called out where material.

### Deployment sizes

| Tier       | Named users | Peak concurrent | Profile                                                                  |
| ---------- | ----------- | --------------- | ------------------------------------------------------------------------ |
| **Small**  | 500         | 350             | General knowledge workers, Office-based                                  |
| **Medium** | 2,000       | 1,400           | Mixed: knowledge workers + data analysts + developers                    |
| **Large**  | 10,000      | 7,000           | Enterprise: knowledge workers + data analysts + GPU users + task workers |

### Assumptions

- All scenarios assume Microsoft 365 E3 licensing is already in place (most federal and enterprise customers)
- Azure compute uses 1-year Reserved Instances for steady-state and pay-as-you-go for burst
- Business hours: 10 hours/day, 5 days/week (autoscale/scaling plans power down off-hours)
- User density: AVD multi-session = 14 users/VM (D8s_v5); Citrix SBC = 10 users/VM (D8s_v5); Windows 365 = 1 user/Cloud PC
- Profile storage: 15 GB average profile size
- FSLogix on Azure Files (Premium, LRS) for AVD; Citrix UPM on Azure Files for Citrix; built-in for Windows 365
- Networking: Azure-native connectivity (no ExpressRoute in base model; add $12K--$36K/yr per circuit if required)

---

## 1. Citrix cost model

### 1.1 Citrix licensing

Citrix licensing has shifted entirely to subscription. The relevant SKUs:

| SKU                         | Per-user/month            | Includes                                                 |
| --------------------------- | ------------------------- | -------------------------------------------------------- |
| **Citrix DaaS Standard**    | $11--$14                  | CVAD equivalent, StoreFront, Citrix Workspace            |
| **Citrix DaaS Advanced**    | $16--$20                  | Standard + App Protection, Citrix Analytics for Security |
| **Citrix DaaS Premium**     | $22--$28                  | Advanced + NetScaler Gateway Service, full analytics     |
| **Citrix Universal Hybrid** | $18--$25                  | DaaS + on-prem rights (perpetual upgrade path)           |
| **NetScaler VPX (Azure)**   | $3K--$15K/yr per instance | Load balancing, SSL offload, gateway (if self-managed)   |

!!! warning "Price variability"
Citrix pricing is heavily negotiated. Published list prices are significantly higher than large-enterprise contracted rates. However, post-acquisition renewal pricing has moved closer to list for many customers. Request a current renewal quote from your Citrix account team for accurate comparison.

### 1.2 Citrix infrastructure on Azure

Running Citrix on Azure requires deploying and managing:

| Component                                             | Azure resources                               | Monthly cost estimate    |
| ----------------------------------------------------- | --------------------------------------------- | ------------------------ |
| Citrix Cloud Connectors (2 per resource location, HA) | 2x D4s_v5 VMs                                 | $500                     |
| StoreFront servers (if not using Workspace)           | 2x D4s_v5 VMs                                 | $500                     |
| NetScaler VPX (HA pair)                               | 2x D8s_v5 VMs + NetScaler license             | $800 + license           |
| SQL Server (Site, Monitoring, Logging DBs)            | Azure SQL Managed Instance or 2x D4s_v5 + SQL | $800--$2,000             |
| Citrix Director                                       | 1x D4s_v5 VM                                  | $250                     |
| Licensing Server                                      | 1x D2s_v5 VM                                  | $100                     |
| FAS Server (if using cert-based auth)                 | 1x D4s_v5 VM                                  | $250                     |
| WEM Server (if using Workspace Environment Mgmt)      | 1x D4s_v5 VM                                  | $250                     |
| **Subtotal: Citrix infrastructure**                   |                                               | **$3,450--$4,650/month** |

These costs exist **in addition** to session host compute and Citrix licensing. With Citrix Cloud, some components (Director, Licensing, StoreFront) are SaaS-managed, but Cloud Connectors, NetScaler (if self-managed), and SQL databases remain customer-deployed.

### 1.3 Session host compute (Citrix)

Citrix multi-session uses Windows Server OS. Typical density is 10 users per D8s_v5 VM.

| Deployment                | Peak concurrent | VMs needed | Monthly compute (1yr RI) |
| ------------------------- | --------------- | ---------- | ------------------------ |
| Small (350 concurrent)    | 350             | 35         | $9,800                   |
| Medium (1,400 concurrent) | 1,400           | 140        | $39,200                  |
| Large (7,000 concurrent)  | 7,000           | 700        | $196,000                 |

With autoscale powering down off-hours, effective monthly costs reduce by approximately 40%:

| Deployment | Effective monthly compute |
| ---------- | ------------------------- |
| Small      | $5,900                    |
| Medium     | $23,500                   |
| Large      | $117,600                  |

### 1.4 Total Citrix cost (5-year)

**Medium deployment (2,000 users):**

| Cost line                         | Monthly                | Annual                     | 5-year                     |
| --------------------------------- | ---------------------- | -------------------------- | -------------------------- |
| Citrix DaaS Premium (2,000 users) | $44,000--$56,000       | $528,000--$672,000         | $2,640,000--$3,360,000     |
| Citrix infrastructure VMs         | $3,500                 | $42,000                    | $210,000                   |
| Session host compute (autoscale)  | $23,500                | $282,000                   | $1,410,000                 |
| Profile storage (Azure Files)     | $2,500                 | $30,000                    | $150,000                   |
| Networking + egress               | $1,000                 | $12,000                    | $60,000                    |
| Admin FTEs (4 @ $150K loaded)     | $50,000                | $600,000                   | $3,000,000                 |
| **Total**                         | **$124,500--$136,500** | **$1,494,000--$1,638,000** | **$7,470,000--$8,190,000** |

---

## 2. AVD cost model

### 2.1 AVD licensing

| Component                              | Cost                  | Notes                                                    |
| -------------------------------------- | --------------------- | -------------------------------------------------------- |
| AVD control plane                      | **$0**                | Azure-managed (broker, gateway, diagnostics, web client) |
| Windows 10/11 Enterprise multi-session | **$0**                | Included in M365 E3/E5                                   |
| FSLogix                                | **$0**                | Included in M365 E3/E5, RDS CAL, or AVD per-user access  |
| Azure Monitor + AVD Insights           | **~$200--$500/month** | Log Analytics workspace ingestion                        |
| Intune management                      | **$0**                | Included in M365 E3/E5                                   |
| Conditional Access                     | **$0**                | Included in Entra ID P1 (M365 E3/E5)                     |
| Screen capture protection              | **$0**                | Built-in AVD feature                                     |
| **Total AVD platform licensing**       | **~$200--$500/month** |                                                          |

### 2.2 Session host compute (AVD)

AVD Windows 10/11 multi-session provides higher density than Citrix SBC on Windows Server: typically 14 users per D8s_v5 VM.

| Deployment                | Peak concurrent | VMs needed | Monthly compute (1yr RI) |
| ------------------------- | --------------- | ---------- | ------------------------ |
| Small (350 concurrent)    | 350             | 25         | $7,000                   |
| Medium (1,400 concurrent) | 1,400           | 100        | $28,000                  |
| Large (7,000 concurrent)  | 7,000           | 500        | $140,000                 |

With scaling plans (autoscale) powering down off-hours:

| Deployment | Effective monthly compute |
| ---------- | ------------------------- |
| Small      | $4,200                    |
| Medium     | $16,800                   |
| Large      | $84,000                   |

### 2.3 Total AVD cost (5-year)

**Medium deployment (2,000 users):**

| Cost line                             | Monthly     | Annual       | 5-year         |
| ------------------------------------- | ----------- | ------------ | -------------- |
| AVD platform licensing                | $300        | $3,600       | $18,000        |
| Session host compute (autoscale)      | $16,800     | $201,600     | $1,008,000     |
| FSLogix storage (Azure Files Premium) | $2,500      | $30,000      | $150,000       |
| Networking + egress                   | $800        | $9,600       | $48,000        |
| Azure Monitor (Log Analytics)         | $300        | $3,600       | $18,000        |
| Admin FTEs (2 @ $150K loaded)         | $25,000     | $300,000     | $1,500,000     |
| **Total**                             | **$45,700** | **$548,400** | **$2,742,000** |

### 2.4 AVD savings vs Citrix

| Metric               | Citrix (5-year)  | AVD (5-year) | Savings                    |
| -------------------- | ---------------- | ------------ | -------------------------- |
| Platform licensing   | $2,640K--$3,360K | $18K         | **$2.6M--$3.3M (99%)**     |
| Infrastructure VMs   | $210K            | $0           | **$210K (100%)**           |
| Session host compute | $1,410K          | $1,008K      | **$402K (29%)**            |
| Storage              | $150K            | $150K        | $0                         |
| Admin FTEs           | $3,000K          | $1,500K      | **$1,500K (50%)**          |
| **Total**            | **$7.5M--$8.2M** | **$2.7M**    | **$4.8M--$5.5M (63--67%)** |

---

## 3. Windows 365 cost model

### 3.1 Windows 365 pricing

Windows 365 provides fixed per-user/month pricing with no infrastructure management:

| SKU                                     | vCPUs | RAM   | Storage | Monthly (commercial) | Monthly (GCC)                 |
| --------------------------------------- | ----- | ----- | ------- | -------------------- | ----------------------------- |
| Windows 365 Business 2vCPU/4GB/128GB    | 2     | 4 GB  | 128 GB  | $32                  | N/A (Enterprise only for GCC) |
| Windows 365 Enterprise 2vCPU/8GB/128GB  | 2     | 8 GB  | 128 GB  | $41                  | $51                           |
| Windows 365 Enterprise 4vCPU/16GB/128GB | 4     | 16 GB | 128 GB  | $58                  | $73                           |
| Windows 365 Enterprise 8vCPU/32GB/128GB | 8     | 32 GB | 128 GB  | $83                  | $104                          |
| Windows 365 Enterprise 8vCPU/32GB/256GB | 8     | 32 GB | 256 GB  | $99                  | $124                          |
| Windows 365 GPU 4vCPU/16GB/128GB        | 4     | 16 GB | 128 GB  | $75                  | $94                           |

### 3.2 Total Windows 365 cost (5-year)

**Medium deployment (2,000 users, mix of 4vCPU and 8vCPU):**

| Cost line                                      | Monthly      | Annual         | 5-year         |
| ---------------------------------------------- | ------------ | -------------- | -------------- |
| Windows 365 licenses (1,400 x $58 + 600 x $83) | $131,000     | $1,572,000     | $7,860,000     |
| Admin FTEs (1 @ $150K loaded)                  | $12,500      | $150,000       | $750,000       |
| **Total**                                      | **$143,500** | **$1,722,000** | **$8,610,000** |

!!! note "Windows 365 pricing premium"
Windows 365 provides simplicity -- zero infrastructure management, predictable pricing, always-on Cloud PCs. The premium over AVD reflects the operational simplicity. For organizations that value zero-ops VDI, this premium may be justified. However, at scale (1,000+ users), AVD is significantly more cost-effective because multi-session density shares compute across users.

---

## 4. Comparative summary

### 5-year TCO comparison (medium deployment, 2,000 users)

| Platform                   | 5-year TCO   | Per-user/year | vs AVD       |
| -------------------------- | ------------ | ------------- | ------------ |
| **Citrix DaaS Premium**    | $7.5M--$8.2M | $750--$820    | +173%--199%  |
| **Azure Virtual Desktop**  | **$2.7M**    | **$274**      | **Baseline** |
| **Windows 365 Enterprise** | $8.6M        | $861          | +214%        |

### 5-year TCO by deployment size

| Platform               | Small (500 users) | Medium (2,000 users) | Large (10,000 users) |
| ---------------------- | ----------------- | -------------------- | -------------------- |
| Citrix DaaS Premium    | $2.1M--$2.4M      | $7.5M--$8.2M         | $35M--$40M           |
| **AVD**                | **$0.9M**         | **$2.7M**            | **$12.5M**           |
| Windows 365 Enterprise | $2.3M             | $8.6M                | $42M                 |

### Cost per user per month (fully loaded)

| Platform               | Small    | Medium   | Large    |
| ---------------------- | -------- | -------- | -------- |
| Citrix DaaS Premium    | $70--$80 | $63--$68 | $58--$67 |
| **AVD**                | **$30**  | **$23**  | **$21**  |
| Windows 365 Enterprise | $77      | $72      | $70      |

---

## 5. Hidden costs frequently missed

### 5.1 Citrix hidden costs

| Hidden cost                      | Description                                           | Annual impact            |
| -------------------------------- | ----------------------------------------------------- | ------------------------ |
| **NetScaler support renewals**   | Separate from CVAD license; often forgotten in TCO    | $15K--$75K/yr            |
| **SQL Server licensing**         | Site, Monitoring, and Logging databases require SQL   | $10K--$50K/yr            |
| **Citrix Workspace app updates** | Testing and deploying client updates across endpoints | 40--80 FTE hours/quarter |
| **Certificate management**       | NetScaler SSL certs, StoreFront certs, FAS certs      | 20--40 FTE hours/quarter |
| **Upgrade downtime**             | CVAD version upgrades require maintenance windows     | 2--4 weekends/year       |
| **Training**                     | Citrix certifications, renewal training               | $5K--$15K/yr             |
| **Consulting**                   | Citrix partner services for complex configurations    | $20K--$100K/yr           |

### 5.2 AVD hidden costs

| Hidden cost                     | Description                                                  | Annual impact               |
| ------------------------------- | ------------------------------------------------------------ | --------------------------- |
| **Log Analytics ingestion**     | AVD Insights requires Log Analytics workspace                | $2K--$10K/yr                |
| **Azure Files Premium**         | FSLogix profile shares need Premium tier for IOPS            | $15K--$60K/yr               |
| **Image management**            | Building and updating golden images, Compute Gallery storage | $2K--$5K/yr                 |
| **Conditional Access planning** | Designing and testing CA policies                            | 20--40 FTE hours (one-time) |
| **Migration project**           | One-time cost to migrate from Citrix to AVD                  | $50K--$200K (one-time)      |

### 5.3 Windows 365 hidden costs

| Hidden cost           | Description                                                | Annual impact                              |
| --------------------- | ---------------------------------------------------------- | ------------------------------------------ |
| **Always-on compute** | Cloud PCs run 24/7; no autoscale/shutdown                  | Built into per-user price                  |
| **Over-provisioning** | Fixed SKU sizes may not match actual needs                 | 10--30% waste vs right-sized AVD           |
| **Storage upgrades**  | Default storage may be insufficient; upgrades are per-user | $5--$20/user/month                         |
| **GPU limitations**   | Limited GPU Cloud PC options vs full Azure GPU VM catalog  | May require supplemental AVD for GPU users |

---

## 6. Cost optimization strategies for AVD

### 6.1 Reserved Instances

| RI term   | Savings vs pay-as-you-go |
| --------- | ------------------------ |
| 1-year RI | 30--40%                  |
| 3-year RI | 50--60%                  |

Apply Reserved Instances to the minimum number of VMs needed during business hours. Use pay-as-you-go for burst capacity.

### 6.2 Scaling plans (autoscale)

AVD scaling plans automatically manage session host capacity:

- **Ramp-up:** gradually power on VMs before business hours
- **Peak:** maintain full capacity with load balancing
- **Ramp-down:** drain sessions and power off excess VMs
- **Off-peak:** maintain minimum VMs for after-hours users

Typical savings: **35--50%** of compute costs vs always-on.

### 6.3 Spot VMs for non-critical workloads

AVD supports Azure Spot VMs for personal desktops in development/test scenarios:

- Up to **90% savings** vs pay-as-you-go
- Suitable for: development environments, training labs, POC/pilot
- Not suitable for: production multi-session pools (eviction disrupts multiple users)

### 6.4 Right-sizing

Monitor actual CPU, memory, and session density with AVD Insights. Common right-sizing opportunities:

| Observation                        | Action                                                | Savings            |
| ---------------------------------- | ----------------------------------------------------- | ------------------ |
| Average CPU < 30% across host pool | Reduce VM size (D8s_v5 to D4s_v5) or increase density | 20--40%            |
| Low concurrent usage off-peak      | Reduce minimum VMs in scaling plan                    | 10--20%            |
| Large profiles (>30 GB)            | Clean up FSLogix containers, configure exclusions     | 15--25% on storage |

### 6.5 Dev/test pricing

Azure Dev/Test subscriptions provide discounts on Windows VMs:

- No Windows OS charge on session host VMs
- Reduced rates on Azure services
- Applicable for non-production AVD environments (UAT, staging, training)

---

## 7. Federal-specific cost considerations

### Azure Government pricing

Azure Government carries a premium over commercial Azure:

| Service                          | Commercial | Azure Government | Premium |
| -------------------------------- | ---------- | ---------------- | ------- |
| D8s_v5 VM (pay-as-you-go)        | $0.384/hr  | $0.480/hr        | ~25%    |
| Azure Files Premium (100 GB)     | $17/month  | $21/month        | ~25%    |
| Log Analytics (per GB ingestion) | $2.76      | $3.45            | ~25%    |

### Windows 365 GCC pricing

Windows 365 GCC/GCC-High carries a higher premium:

| SKU              | Commercial     | GCC             | Premium |
| ---------------- | -------------- | --------------- | ------- |
| 4vCPU/16GB/128GB | $58/user/month | $73/user/month  | ~26%    |
| 8vCPU/32GB/128GB | $83/user/month | $104/user/month | ~25%    |

### E-Rate and volume licensing

Federal agencies often have Microsoft Enterprise Agreement (EA) pricing that reduces M365 E3/E5 costs. Since AVD licensing is included in M365 E3/E5, the effective AVD licensing cost for federal agencies is genuinely zero -- no additional procurement action required.

---

## 8. Migration cost (one-time)

### 8.1 Migration project investment

| Activity                      | Small (500 users) | Medium (2,000 users) | Large (10,000 users) |
| ----------------------------- | ----------------- | -------------------- | -------------------- |
| Assessment and planning       | $15K--$25K        | $30K--$60K           | $75K--$150K          |
| Image preparation and testing | $10K--$20K        | $15K--$30K           | $30K--$60K           |
| FSLogix storage setup         | $5K--$10K         | $10K--$20K           | $20K--$40K           |
| Profile migration             | $5K--$15K         | $15K--$40K           | $40K--$100K          |
| Application testing           | $10K--$20K        | $20K--$50K           | $50K--$150K          |
| Pilot and UAT                 | $5K--$10K         | $10K--$25K           | $25K--$50K           |
| Wave migration execution      | $10K--$20K        | $25K--$60K           | $75K--$200K          |
| Training (IT and end-users)   | $5K--$10K         | $10K--$25K           | $25K--$75K           |
| **Total migration cost**      | **$65K--$130K**   | **$135K--$310K**     | **$340K--$825K**     |

### 8.2 Payback period

| Deployment           | Annual savings (AVD vs Citrix) | Migration cost | Payback period  |
| -------------------- | ------------------------------ | -------------- | --------------- |
| Small (500 users)    | $200K--$300K                   | $65K--$130K    | **3--8 months** |
| Medium (2,000 users) | $950K--$1.1M                   | $135K--$310K   | **2--4 months** |
| Large (10,000 users) | $4.5M--$5.5M                   | $340K--$825K   | **1--2 months** |

The migration investment pays for itself within the first year in virtually every scenario. For large deployments, the payback period can be measured in weeks.

---

## 9. Sensitivity analysis

### 9.1 What-if scenarios

| Scenario                                       | Impact on AVD savings                                                   |
| ---------------------------------------------- | ----------------------------------------------------------------------- |
| Organization does NOT have M365 E3/E5          | AVD per-user access pricing adds ~$4/user/month; savings reduce by ~15% |
| 3-year Reserved Instances (instead of 1-year)  | AVD savings increase by additional 10--15%                              |
| Azure Government premium (+25%)                | All Azure costs increase; AVD still saves 55--60% vs Citrix             |
| Higher user density (18 users/VM on AVD)       | AVD savings increase by additional 5--10%                               |
| Lower user density (10 users/VM on AVD)        | AVD savings decrease; still 45--55% cheaper than Citrix                 |
| Citrix negotiated deep discount (50% off list) | AVD savings reduce to 40--50% (still significant)                       |

### 9.2 Break-even analysis

**At what Citrix discount does AVD stop being cheaper?**

For a 2,000-user deployment, Citrix licensing would need to be **free** (100% discount) for the total Citrix TCO to match AVD TCO. Even with zero Citrix licensing cost, AVD wins on:

- Fewer infrastructure VMs (no Cloud Connectors, NetScaler, SQL databases)
- Higher user density (multi-session vs SBC)
- Fewer admin FTEs (Azure-native management)

This means there is no realistic Citrix discount that closes the gap entirely.

---

## 10. Recommendation

| Deployment size                  | Recommended platform        | Rationale                                                      |
| -------------------------------- | --------------------------- | -------------------------------------------------------------- |
| **< 200 users, simple desktops** | Windows 365                 | Zero-ops simplicity justifies premium                          |
| **200--500 users**               | AVD or Windows 365          | AVD if cost-sensitive or RemoteApp needed; W365 if ops-minimal |
| **500--2,000 users**             | **AVD**                     | Multi-session density savings dominate                         |
| **2,000--10,000+ users**         | **AVD**                     | 63--67% savings vs Citrix at scale                             |
| **GPU workloads**                | **AVD**                     | Full Azure GPU VM catalog                                      |
| **Federal IL4/IL5**              | **AVD on Azure Government** | Cost + compliance + PIV/CAC                                    |
| **Data analysts (CSA-in-a-Box)** | **AVD**                     | Pre-configured desktops with Private Link to Fabric/Databricks |

---

**Maintainers:** CSA-in-a-Box core team
**Last updated:** 2026-04-30
