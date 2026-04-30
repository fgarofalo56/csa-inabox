# Total Cost of Ownership: Self-Managed Kubernetes / OpenShift vs AKS

**Status:** Authored 2026-04-30
**Audience:** Federal CFOs, CIOs, and procurement officers evaluating the financial case for migrating from self-managed Kubernetes or Red Hat OpenShift to Azure Kubernetes Service (AKS).
**Methodology:** Costs are based on published Azure pricing (commercial and Azure Government), Red Hat OpenShift subscription pricing, representative hardware costs for federal data centers, and industry benchmarks for platform engineering FTE costs. All numbers are illustrative and should be validated against your specific deployment.

---

## How to read this document

This analysis compares three deployment models across three federal deployment sizes:

- **Self-managed Kubernetes** on bare-metal servers or VMs (kubeadm, Rancher, k3s)
- **Red Hat OpenShift 4.x** on bare-metal or VMs with Standard or Premium subscription
- **Azure Kubernetes Service (AKS)** on Azure Government (Standard tier)

Each scenario includes direct costs (infrastructure, licensing, tooling) and indirect costs (personnel, opportunity cost, risk). Federal agencies should apply their own labor rates, data center costs, and Azure Government pricing adjustments.

---

## 1. Deployment scenarios

### Small: development team (10 nodes, 150 pods)

A single cluster running internal applications, CI/CD workloads, and basic data services. Typical for a program office or small agency division.

### Medium: platform team (50 nodes, 800 pods)

Three clusters (dev, staging, production) running mission-critical applications with persistent storage, GPU workloads for ML inference, and containerized data pipelines. Typical for a mid-size agency or DoD program.

### Large: enterprise platform (200 nodes, 3,000+ pods)

Six or more clusters across multiple environments and regions, running hundreds of microservices, stateful databases, ML training and inference, event-driven architectures, and containerized Spark/dbt/Airflow workloads. Typical for a large cabinet agency or combatant command.

---

## 2. Small deployment: 10 nodes, 150 pods

### Infrastructure costs (annual)

| Component                      | Self-managed K8s                       | OpenShift 4.x           | AKS (Azure Gov)                           |
| ------------------------------ | -------------------------------------- | ----------------------- | ----------------------------------------- |
| **Control plane servers** (3x) | $18,000 (3x Dell R750, amortized 5yr)  | $18,000 (same hardware) | $0 (free tier) or $876 (standard)         |
| **Worker node servers** (10x)  | $60,000 (10x Dell R750, amortized 5yr) | $60,000 (same hardware) | $48,000 (10x D8s_v5, 1yr RI, Gov pricing) |
| **Data center hosting**        | $24,000 (power, cooling, rack space)   | $24,000                 | $0 (included in VM pricing)               |
| **Networking hardware**        | $8,000 (switches, firewall, amortized) | $8,000                  | $4,800 (ExpressRoute 50 Mbps)             |
| **Storage**                    | $12,000 (SAN/NAS, amortized)           | $12,000                 | $6,000 (Azure Managed Disks)              |
| **Container registry**         | $5,000 (Harbor on VM)                  | $0 (Quay included)      | $610 (ACR Standard)                       |
| **Infrastructure subtotal**    | **$127,000**                           | **$122,000**            | **$60,286**                               |

### Software and licensing (annual)

| Component                   | Self-managed K8s                    | OpenShift 4.x                            | AKS                              |
| --------------------------- | ----------------------------------- | ---------------------------------------- | -------------------------------- |
| **Kubernetes distribution** | $0 (open-source)                    | N/A                                      | $0 (included)                    |
| **OpenShift subscription**  | N/A                                 | $55,000 (Standard, 2 sockets x 10 nodes) | N/A                              |
| **OS licenses**             | $5,000 (Ubuntu/RHEL)                | $0 (RHCOS included)                      | $0 (Ubuntu/Mariner included)     |
| **Monitoring stack**        | $8,000 (Prometheus/Grafana hosting) | $5,000 (included + customization)        | $3,600 (Container Insights)      |
| **Security tooling**        | $10,000 (Trivy, Falco, OPA)         | $5,000 (built-in SCC + ACS)              | $2,400 (Defender for Containers) |
| **Backup tooling**          | $3,000 (Velero + storage)           | $3,000                                   | $1,200 (Velero + Blob)           |
| **Software subtotal**       | **$26,000**                         | **$68,000**                              | **$7,200**                       |

### Personnel costs (annual)

| Role                                       | Self-managed K8s           | OpenShift 4.x              | AKS                       |
| ------------------------------------------ | -------------------------- | -------------------------- | ------------------------- |
| **Platform engineer** (K8s admin)          | 1.5 FTE @ $160K = $240,000 | 1.0 FTE @ $160K = $160,000 | 0.5 FTE @ $160K = $80,000 |
| **Security engineer** (container security) | 0.5 FTE @ $170K = $85,000  | 0.3 FTE @ $170K = $51,000  | 0.2 FTE @ $170K = $34,000 |
| **Network engineer** (CNI, ingress, mesh)  | 0.3 FTE @ $155K = $46,500  | 0.2 FTE @ $155K = $31,000  | 0.1 FTE @ $155K = $15,500 |
| **Personnel subtotal**                     | **$371,500**               | **$242,000**               | **$129,500**              |

### Annual and 5-year TCO: small deployment

|                                    | Self-managed K8s | OpenShift 4.x  | AKS                  |
| ---------------------------------- | ---------------- | -------------- | -------------------- |
| **Annual TCO**                     | $524,500         | $432,000       | $196,986             |
| **5-year TCO**                     | $2,622,500       | $2,160,000     | $984,930             |
| **5-year savings vs self-managed** | --               | $462,500 (18%) | **$1,637,570 (62%)** |
| **5-year savings vs OpenShift**    | --               | --             | **$1,175,070 (54%)** |

---

## 3. Medium deployment: 50 nodes, 800 pods

### Infrastructure costs (annual)

| Component                                              | Self-managed K8s                       | OpenShift 4.x      | AKS (Azure Gov)                      |
| ------------------------------------------------------ | -------------------------------------- | ------------------ | ------------------------------------ |
| **Control plane servers** (3x per cluster, 3 clusters) | $54,000                                | $54,000            | $2,628 (standard tier x3)            |
| **Worker nodes** (50x total)                           | $300,000 (50x server, amortized 5yr)   | $300,000           | $240,000 (50x D8s_v5, 1yr RI, Gov)   |
| **GPU nodes** (4x for ML inference)                    | $80,000 (4x GPU server, amortized 5yr) | $80,000            | $96,000 (4x NC24ads_A100_v4, 1yr RI) |
| **Data center hosting**                                | $72,000                                | $72,000            | $0                                   |
| **Networking hardware**                                | $30,000                                | $30,000            | $14,400 (ExpressRoute 200 Mbps)      |
| **Storage**                                            | $60,000 (SAN/NAS)                      | $60,000            | $36,000 (Azure Disk + Files)         |
| **Container registry**                                 | $15,000 (Harbor HA)                    | $0 (Quay included) | $1,220 (ACR Premium)                 |
| **DR / backup infrastructure**                         | $40,000                                | $40,000            | $12,000 (Velero + Blob + ASR)        |
| **Infrastructure subtotal**                            | **$651,000**                           | **$636,000**       | **$402,248**                         |

### Software and licensing (annual)

| Component                  | Self-managed K8s                              | OpenShift 4.x                | AKS                                               |
| -------------------------- | --------------------------------------------- | ---------------------------- | ------------------------------------------------- |
| **OpenShift subscription** | N/A                                           | $275,000 (Premium, 50 nodes) | N/A                                               |
| **OS licenses**            | $25,000                                       | $0 (RHCOS)                   | $0                                                |
| **Monitoring**             | $30,000 (Prometheus HA + Thanos + Grafana)    | $20,000                      | $18,000 (Container Insights + Managed Prometheus) |
| **Security tooling**       | $40,000 (Trivy, Falco, OPA, SIEM integration) | $25,000 (ACS + built-in)     | $14,400 (Defender for Containers)                 |
| **Service mesh**           | $15,000 (Istio management)                    | $10,000 (OCP Service Mesh)   | $6,000 (AKS Istio addon)                          |
| **Backup tooling**         | $10,000                                       | $10,000                      | $4,000                                            |
| **Software subtotal**      | **$120,000**                                  | **$340,000**                 | **$42,400**                                       |

### Personnel costs (annual)

| Role                   | Self-managed K8s           | OpenShift 4.x              | AKS                        |
| ---------------------- | -------------------------- | -------------------------- | -------------------------- |
| **Platform engineers** | 4.0 FTE @ $165K = $660,000 | 3.0 FTE @ $165K = $495,000 | 1.5 FTE @ $165K = $247,500 |
| **Security engineers** | 1.5 FTE @ $175K = $262,500 | 1.0 FTE @ $175K = $175,000 | 0.5 FTE @ $175K = $87,500  |
| **Network engineers**  | 1.0 FTE @ $160K = $160,000 | 0.5 FTE @ $160K = $80,000  | 0.3 FTE @ $160K = $48,000  |
| **SRE / on-call**      | 1.0 FTE @ $170K = $170,000 | 0.5 FTE @ $170K = $85,000  | 0.3 FTE @ $170K = $51,000  |
| **Personnel subtotal** | **$1,252,500**             | **$835,000**               | **$434,000**               |

### Annual and 5-year TCO: medium deployment

|                                    | Self-managed K8s | OpenShift 4.x    | AKS                  |
| ---------------------------------- | ---------------- | ---------------- | -------------------- |
| **Annual TCO**                     | $2,023,500       | $1,811,000       | $878,648             |
| **5-year TCO**                     | $10,117,500      | $9,055,000       | $4,393,240           |
| **5-year savings vs self-managed** | --               | $1,062,500 (11%) | **$5,724,260 (57%)** |
| **5-year savings vs OpenShift**    | --               | --               | **$4,661,760 (51%)** |

---

## 4. Large deployment: 200 nodes, 3,000+ pods

### Infrastructure costs (annual)

| Component                                              | Self-managed K8s                        | OpenShift 4.x  | AKS (Azure Gov)                        |
| ------------------------------------------------------ | --------------------------------------- | -------------- | -------------------------------------- |
| **Control plane servers** (3x per cluster, 6 clusters) | $108,000                                | $108,000       | $5,256 (standard tier x6)              |
| **Worker nodes** (200x total)                          | $1,200,000 (200x server, amortized 5yr) | $1,200,000     | $840,000 (200x D8s_v5, 3yr RI, Gov)    |
| **GPU nodes** (16x for ML)                             | $320,000                                | $320,000       | $288,000 (16x NC24ads_A100_v4, 3yr RI) |
| **Data center hosting**                                | $240,000                                | $240,000       | $0                                     |
| **Networking**                                         | $100,000                                | $100,000       | $36,000 (ExpressRoute 1 Gbps)          |
| **Storage**                                            | $200,000                                | $200,000       | $120,000 (Azure Disk + Files + NetApp) |
| **Container registry**                                 | $40,000 (Harbor geo-replicated)         | $0 (Quay)      | $3,660 (ACR Premium, geo-rep)          |
| **DR / backup**                                        | $100,000                                | $100,000       | $36,000                                |
| **Infrastructure subtotal**                            | **$2,308,000**                          | **$2,268,000** | **$1,328,916**                         |

### Software and licensing (annual)

| Component                  | Self-managed K8s                            | OpenShift 4.x                 | AKS                                                                 |
| -------------------------- | ------------------------------------------- | ----------------------------- | ------------------------------------------------------------------- |
| **OpenShift subscription** | N/A                                         | $800,000 (Premium, 200 nodes) | N/A                                                                 |
| **OS licenses**            | $80,000                                     | $0                            | $0                                                                  |
| **Monitoring**             | $100,000 (Prometheus + Thanos + Grafana HA) | $60,000                       | $48,000 (Container Insights + Managed Prometheus + Managed Grafana) |
| **Security**               | $120,000                                    | $80,000                       | $48,000 (Defender)                                                  |
| **Service mesh**           | $40,000                                     | $30,000                       | $18,000                                                             |
| **Backup**                 | $30,000                                     | $30,000                       | $12,000                                                             |
| **Software subtotal**      | **$370,000**                                | **$1,000,000**                | **$126,000**                                                        |

### Personnel costs (annual)

| Role                   | Self-managed K8s             | OpenShift 4.x              | AKS                        |
| ---------------------- | ---------------------------- | -------------------------- | -------------------------- |
| **Platform engineers** | 8.0 FTE @ $170K = $1,360,000 | 5.0 FTE @ $170K = $850,000 | 3.0 FTE @ $170K = $510,000 |
| **Security engineers** | 2.0 FTE @ $180K = $360,000   | 1.5 FTE @ $180K = $270,000 | 1.0 FTE @ $180K = $180,000 |
| **Network engineers**  | 1.5 FTE @ $165K = $247,500   | 1.0 FTE @ $165K = $165,000 | 0.5 FTE @ $165K = $82,500  |
| **SRE / on-call**      | 2.0 FTE @ $175K = $350,000   | 1.5 FTE @ $175K = $262,500 | 1.0 FTE @ $175K = $175,000 |
| **Platform architect** | 1.0 FTE @ $200K = $200,000   | 1.0 FTE @ $200K = $200,000 | 0.5 FTE @ $200K = $100,000 |
| **Personnel subtotal** | **$2,517,500**               | **$1,747,500**             | **$1,047,500**             |

### Annual and 5-year TCO: large deployment

|                                    | Self-managed K8s | OpenShift 4.x | AKS                   |
| ---------------------------------- | ---------------- | ------------- | --------------------- |
| **Annual TCO**                     | $5,195,500       | $5,015,500    | $2,502,416            |
| **5-year TCO**                     | $25,977,500      | $25,077,500   | $12,512,080           |
| **5-year savings vs self-managed** | --               | $900,000 (3%) | **$13,465,420 (52%)** |
| **5-year savings vs OpenShift**    | --               | --            | **$12,565,420 (50%)** |

---

## 5. Hidden costs often missed in TCO analysis

### Self-managed Kubernetes hidden costs

| Hidden cost                      | Annual estimate (medium deployment)                              | Why it is missed                                               |
| -------------------------------- | ---------------------------------------------------------------- | -------------------------------------------------------------- |
| **Upgrade labor**                | $80,000--$120,000 (2--4 weeks per cluster, 3x/year)              | Treated as "BAU" rather than costed explicitly                 |
| **Incident response**            | $50,000--$100,000 (etcd corruption, cert expiry, CNI failures)   | Unpredictable; averaged over years                             |
| **Knowledge concentration risk** | $100,000--$200,000 (single-point-of-failure experts)             | Not costed until the expert leaves                             |
| **Security patch lag**           | Compliance risk (not $ directly)                                 | CVE patches delayed 2--6 weeks in self-managed vs hours in AKS |
| **Opportunity cost**             | $200,000--$400,000 (platform team doing ops instead of features) | Most important; hardest to quantify                            |

### OpenShift hidden costs

| Hidden cost                      | Annual estimate (medium deployment)                         | Why it is missed                                                  |
| -------------------------------- | ----------------------------------------------------------- | ----------------------------------------------------------------- |
| **Subscription true-up**         | $50,000--$100,000 (node count growth)                       | Subscription is per-core or per-node; growth causes true-up       |
| **OCP version lock-in**          | $30,000--$60,000 (testing OCP-specific features on upgrade) | DeploymentConfig, Routes, SCC migration costs on each OCP upgrade |
| **Red Hat ecosystem dependency** | Vendor lock-in risk                                         | Operators built on OCP SDK do not port to standard K8s            |

### AKS hidden costs

| Hidden cost                  | Annual estimate (medium deployment)              | Why it is missed                                            |
| ---------------------------- | ------------------------------------------------ | ----------------------------------------------------------- |
| **Egress charges**           | $12,000--$36,000 (cross-region, internet egress) | Often underestimated in initial sizing                      |
| **Azure Government premium** | 25% markup on commercial pricing                 | Gov pricing is published but not always used in initial TCO |
| **Training investment**      | $15,000--$30,000 (one-time, amortized)           | Team ramp-up from self-managed to AKS patterns              |
| **ExpressRoute**             | $4,800--$36,000 (depending on bandwidth)         | Required for hybrid connectivity                            |

---

## 6. Cost optimization strategies for AKS

### Reserved Instances

| Commitment                   | Discount (commercial)        | Discount (Azure Gov)             |
| ---------------------------- | ---------------------------- | -------------------------------- |
| Pay-as-you-go                | Baseline                     | Baseline + 25% Gov premium       |
| 1-year Reserved Instance     | Up to 38% savings            | Up to 38% savings on Gov pricing |
| 3-year Reserved Instance     | Up to 56% savings            | Up to 56% savings on Gov pricing |
| Azure Savings Plan (compute) | Up to 45% savings (flexible) | Up to 45% savings on Gov pricing |

### Spot VMs for batch workloads

AKS supports Spot VM node pools for fault-tolerant workloads:

- **Spark batch jobs**: Spark executors on Spot nodes (driver on regular nodes)
- **CI/CD builds**: build agents on Spot nodes (80--90% discount)
- **ML training**: training jobs with checkpointing on Spot nodes
- **Batch processing**: data pipeline batch jobs with retry logic

Spot discount: up to 90% compared to pay-as-you-go pricing.

### Cluster autoscaler + node auto-provisioning

- **Cluster autoscaler**: scales node count based on pending pod requests (prevents over-provisioning)
- **Node auto-provisioning (NAP)**: automatically selects optimal VM sizes based on workload requirements (prevents wrong-sizing)
- **KEDA**: scales pod count based on external metrics (Event Hubs queue depth, HTTP request rate, custom metrics)

Typical savings from autoscaling: 30--50% compared to static node pool sizing.

### Namespace-level cost allocation

AKS + Container Insights + Azure Cost Management provides per-namespace cost allocation:

- Attribute compute costs to teams, applications, or business units
- Identify over-provisioned namespaces (requests >> usage)
- Set budgets and alerts per namespace
- Chargeback or showback reporting

---

## 7. Migration cost: one-time investment

| Phase                            | Duration  | Cost estimate (medium deployment) |
| -------------------------------- | --------- | --------------------------------- |
| **Discovery and assessment**     | 2 weeks   | $40,000 (2 FTEs + tooling)        |
| **Landing zone deployment**      | 3 weeks   | $60,000 (2 FTEs + Azure setup)    |
| **Pilot migration**              | 3 weeks   | $50,000 (2 FTEs)                  |
| **Stateless workload migration** | 6 weeks   | $120,000 (3 FTEs)                 |
| **Stateful workload migration**  | 6 weeks   | $150,000 (3 FTEs + validation)    |
| **CI/CD pipeline migration**     | 4 weeks   | $80,000 (2 FTEs)                  |
| **Cutover and decommission**     | 4 weeks   | $60,000 (2 FTEs)                  |
| **Training**                     | 2 weeks   | $30,000 (team training)           |
| **Total migration cost**         | ~24 weeks | **$590,000**                      |

### Payback period

- **vs self-managed K8s**: annual savings of ~$1.14M. Payback in **6.2 months**.
- **vs OpenShift**: annual savings of ~$932K. Payback in **7.6 months**.

---

## 8. Federal-specific cost considerations

### Azure Government pricing

Azure Government pricing is typically 25% higher than commercial Azure. All AKS cost estimates in this document use Azure Government pricing for the AKS scenarios. Key premium areas:

- VM pricing: 20--30% premium
- Storage: 15--25% premium
- Networking: 15--25% premium
- PaaS services (Container Insights, Defender): 20--30% premium

### Procurement vehicles

- **GSA MAS (Multiple Award Schedule)**: Azure Government available through GSA Schedule 70 (IT)
- **DOD ESI**: Azure available through Enterprise Software Initiative
- **NASA SEWP**: Azure available through SEWP V
- **ITES-3S**: Azure available through ITES contracts
- **Agency-specific BPAs**: Many agencies have Azure BPAs with negotiated pricing

### FITARA and cloud-smart considerations

OMB M-19-26 (Cloud Smart) encourages agencies to adopt cloud services where appropriate. AKS adoption aligns with:

- **Security**: managed control plane with automated patching reduces attack surface
- **Procurement**: consumption-based pricing aligns with FITARA reporting
- **Workforce**: reduced operations burden allows reallocation of platform engineers to mission-focused work

---

## 9. Summary: TCO comparison across deployment sizes

| Deployment            | Self-managed K8s (5yr) | OpenShift (5yr) | AKS (5yr) | AKS savings vs cheapest alternative |
| --------------------- | ---------------------- | --------------- | --------- | ----------------------------------- |
| **Small** (10 nodes)  | $2.6M                  | $2.2M           | $985K     | **55% vs OpenShift**                |
| **Medium** (50 nodes) | $10.1M                 | $9.1M           | $4.4M     | **52% vs OpenShift**                |
| **Large** (200 nodes) | $26.0M                 | $25.1M          | $12.5M    | **50% vs OpenShift**                |

The savings percentage is remarkably consistent across deployment sizes: **50--55% cost reduction** versus the cheapest alternative (typically OpenShift for small, self-managed for large). The absolute dollar savings scale linearly with deployment size.

The single largest savings driver is personnel: AKS reduces platform engineering headcount by 50--65% compared to self-managed Kubernetes because the managed control plane, automated upgrades, integrated monitoring, and Azure-native security tools eliminate the majority of day-2 operations work.

---

**Maintainers:** CSA-in-a-Box core team
**Last updated:** 2026-04-30
**Related:** [Why AKS](why-aks.md) | [Migration Playbook](../kubernetes-to-aks.md) | [Best Practices](best-practices.md)
