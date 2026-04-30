# Migration -- Citrix Virtual Apps and Desktops to Azure Virtual Desktop

**Status:** Authored 2026-04-30
**Audience:** Federal CIO / CTO / EUC Architects / VDI Engineers managing Citrix estates and planning cloud-first virtual desktop strategies.
**Scope:** Full migration from Citrix Virtual Apps and Desktops (CVAD), Citrix Cloud, and NetScaler Gateway to Azure Virtual Desktop (AVD), with CSA-in-a-Box as the data and analytics workstation pattern for Fabric, Databricks, and Power BI users.

---

!!! tip "Expanded Migration Center Available"
This playbook is the core migration reference. For the complete Citrix-to-AVD migration package -- including white papers, deep-dive guides, tutorials, benchmarks, and federal-specific guidance -- visit the **[Citrix to AVD Migration Center](citrix-to-avd/index.md)**.

    **Quick links:**

    - [Why AVD over Citrix (Executive Brief)](citrix-to-avd/why-avd-over-citrix.md)
    - [Total Cost of Ownership Analysis](citrix-to-avd/tco-analysis.md)
    - [Complete Feature Mapping (50+ features)](citrix-to-avd/feature-mapping-complete.md)
    - [Federal Migration Guide](citrix-to-avd/federal-migration-guide.md)
    - [Tutorials & Walkthroughs](citrix-to-avd/index.md#tutorials)
    - [Benchmarks & Performance](citrix-to-avd/benchmarks.md)
    - [Best Practices](citrix-to-avd/best-practices.md)

    **Migration guides by domain:** [Session Hosts](citrix-to-avd/session-host-migration.md) | [Profiles](citrix-to-avd/profile-migration.md) | [App Delivery](citrix-to-avd/app-delivery-migration.md) | [Networking](citrix-to-avd/networking-migration.md) | [Monitoring](citrix-to-avd/monitoring-migration.md)

---

## 1. Executive summary

Citrix has been the dominant EUC platform for two decades. With ~100 million users globally, Citrix Virtual Apps and Desktops (CVAD) and Citrix Cloud are deeply embedded in enterprise and federal IT. However, three converging forces are driving a migration to Azure Virtual Desktop:

1. **Citrix licensing changes.** The Cloud Software Group (CSG) acquisition introduced aggressive subscription pricing, eliminated perpetual licenses for new purchases, and bundled capabilities that many customers do not need. Federal and enterprise customers report 2x--5x license cost increases at renewal.

2. **Cloud-first VDI strategy.** Agencies and enterprises are decommissioning on-premises data centers. Running Citrix infrastructure in Azure adds unnecessary cost and complexity when Azure provides a native VDI service.

3. **Windows 10/11 multi-session.** Azure Virtual Desktop is the only platform that supports Windows 10/11 Enterprise multi-session -- a desktop OS experience with server-density economics. This capability is not available on Citrix, VMware Horizon, or any other platform, even when running on Azure.

CSA-in-a-Box integrates with AVD as the **data analyst workstation pattern**. Data engineers, analysts, and data scientists accessing Microsoft Fabric, Databricks, Power BI, and Azure AI Foundry need governed, high-performance desktops with low-latency access to Azure data services. AVD host pools configured through CSA-in-a-Box provide this pattern with Intune management, FSLogix profiles, and pre-configured analytics tooling.

---

## 2. Decide first: AVD vs Windows 365 vs Citrix on Azure

| Your situation                                | Recommended path             | Why                                                           |
| --------------------------------------------- | ---------------------------- | ------------------------------------------------------------- |
| Large Citrix estate, cost pressure at renewal | **AVD**                      | Eliminate Citrix licensing; Windows multi-session density     |
| Small user base, simple desktop needs         | **Windows 365**              | Fixed per-user pricing, zero infrastructure management        |
| Heavy app publishing, HDX protocol dependency | **AVD + MSIX app attach**    | RemoteApp replaces published apps; MSIX replaces App Layering |
| Federal/DoD with IL4/IL5 requirements         | **AVD in Azure Government**  | FedRAMP High, IL4/IL5, smart card (PIV/CAC) support           |
| Citrix must stay for specific apps            | **Citrix on Azure (hybrid)** | Keep Citrix for exceptions; AVD for majority                  |
| Data analysts accessing Fabric/Databricks     | **AVD + CSA-in-a-Box**       | Pre-configured analytics desktops with governed access        |

---

## 3. Phase 1 -- Discovery and assessment (weeks 1--4)

### Inventory your Citrix estate

For each Citrix Site or Citrix Cloud resource location:

- **Delivery Groups and Machine Catalogs:** count, provisioning method (MCS/PVS), desktop type (pooled/persistent)
- **Published Applications:** count, delivery method, user assignments
- **Users:** concurrent peak, named users, geographic distribution
- **StoreFront/Workspace:** access URLs, authentication methods, NetScaler/Gateway config
- **Profiles:** Citrix UPM settings, profile paths, folder redirection, persona management
- **Policies:** Citrix policies for HDX, session limits, bandwidth, printing, USB redirection
- **NetScaler/ADC:** VIPs, SSL certificates, authentication policies (LDAP, RADIUS, SAML, smart card)
- **Licensing:** current license type (CCU, CCS, named user), contract terms, renewal dates, annual cost

### Tools that help

- **Citrix Scout:** diagnostic collection from your Citrix environment
- **Citrix Director:** historical session data, user experience metrics, logon duration breakdown
- **ControlUp:** real-time and historical VDI analytics (if licensed)
- **Lakeside SysTrack / Liquidware Stratusphere:** workspace analytics for migration planning
- **Azure Migrate:** assess on-premises VDI infrastructure for Azure sizing

### Migration tier per workload

| Tier                   | Description                                      | Action                                    |
| ---------------------- | ------------------------------------------------ | ----------------------------------------- |
| **A** Full desktop     | Pooled or personal desktops                      | AVD host pool (multi-session or personal) |
| **B** Published apps   | Citrix published applications                    | AVD RemoteApp application groups          |
| **C** Data workstation | Analyst desktops with Fabric/Databricks/Power BI | AVD + CSA-in-a-Box data analyst pattern   |
| **D** GPU workstation  | CAD, GIS, video editing                          | AVD with NVadsA10_v5 or NCasT4_v3 GPU VMs |
| **E** Decommission     | Unused delivery groups, zombie published apps    | Archive and delete                        |

---

## 4. Phase 2 -- AVD landing zone deployment (weeks 3--6)

### Host pool architecture

```bash
# Create AVD host pool (pooled multi-session)
az desktopvirtualization hostpool create \
  --name hp-analytics-prod \
  --resource-group rg-avd-prod \
  --location eastus2 \
  --host-pool-type Pooled \
  --load-balancer-type BreadthFirst \
  --max-session-limit 12 \
  --preferred-app-group-type Desktop \
  --validation-environment false
```

### Workspace and application groups

```bash
# Create workspace
az desktopvirtualization workspace create \
  --name ws-analytics-prod \
  --resource-group rg-avd-prod \
  --location eastus2 \
  --friendly-name "Analytics Workspace"

# Create desktop application group
az desktopvirtualization applicationgroup create \
  --name dag-analytics-desktop \
  --resource-group rg-avd-prod \
  --location eastus2 \
  --host-pool-id /subscriptions/.../hp-analytics-prod \
  --application-group-type Desktop
```

### CSA-in-a-Box data analyst desktop

For Tier C workloads (data analysts accessing Fabric, Databricks, Power BI), the CSA-in-a-Box pattern provides:

- Pre-configured golden image with Power BI Desktop, Azure Data Studio, Python/R, VS Code, and Azure CLI
- FSLogix profile container on Azure Files (Entra ID joined)
- Conditional Access policies scoping data access to the AVD session
- Private endpoints to Fabric, Databricks, and ADLS Gen2 from the AVD subnet
- Intune device compliance policies

---

## 5. Phase 3 -- Migration execution (weeks 5--16)

### Session host migration

1. **Prepare golden image:** Remove Citrix VDA, install AVD agent + boot loader, configure FSLogix
2. **Create host pool:** configure load balancing, session limits, scaling plan
3. **Deploy session hosts:** from Azure Compute Gallery image, join to Entra ID or AD DS
4. **Configure FSLogix:** profile container on Azure Files or Azure NetApp Files
5. **Assign users:** Entra ID groups mapped to application groups

### Profile migration (Citrix UPM to FSLogix)

1. Export Citrix UPM profile data from existing profile shares
2. Configure FSLogix profile container (VHDx on Azure Files)
3. Migrate user data using `frx copy-profile` or Ciara/ProfileUnity tools
4. Validate profile loading and application settings persistence

### Application delivery migration

| Citrix capability      | AVD equivalent                  |
| ---------------------- | ------------------------------- |
| Published applications | RemoteApp application groups    |
| App Layering           | MSIX app attach                 |
| App-V integration      | MSIX app attach or App-V on AVD |
| Application probing    | Azure Monitor + AVD Insights    |

### Networking migration

| Citrix component  | AVD equivalent                           |
| ----------------- | ---------------------------------------- |
| NetScaler Gateway | AVD reverse connect (no inbound ports)   |
| HDX protocol      | RDP + RDP Shortpath (UDP)                |
| ICA proxy         | Not needed (Azure-managed control plane) |
| SSL VPN           | Conditional Access + Private Link        |

---

## 6. Phase 4 -- Validation and cutover (weeks 14--20)

### Validation checklist

- [ ] Session hosts healthy and accepting connections
- [ ] FSLogix profiles loading within 15 seconds
- [ ] Applications launching correctly via RemoteApp
- [ ] Printing (Universal Print or printer redirection) functional
- [ ] Teams optimization (media offload) working
- [ ] Multi-monitor and display scaling correct
- [ ] Conditional Access policies enforcing MFA and device compliance
- [ ] AVD Insights dashboards showing user experience metrics
- [ ] GPU acceleration validated for Tier D workloads
- [ ] Smart card (PIV/CAC) authentication functional (federal)

### Cutover sequence

1. **Parallel run** (weeks 14--18): both Citrix and AVD active; users migrate in waves
2. **DNS/access cutover:** update Workspace URL or redirect StoreFront to AVD feed
3. **Citrix drain:** verify zero active sessions on Citrix infrastructure
4. **Decommission:** power off Citrix infrastructure after 30-day soak period

---

## 7. Cost comparison summary

For a typical mid-size deployment (2,000 concurrent users):

| Cost category          | Citrix CVAD (on-prem + cloud)                     | AVD                                     |
| ---------------------- | ------------------------------------------------- | --------------------------------------- |
| **Citrix licensing**   | $600K--$1.2M/yr (CVAD + NetScaler + Cloud)        | $0 (included in M365 E3/E5)             |
| **Infrastructure**     | $300K--$600K/yr (servers, storage, NetScaler ADC) | Azure compute only                      |
| **Azure compute**      | N/A or Citrix on Azure ($800K--$1.5M/yr)          | $500K--$900K/yr (multi-session density) |
| **Storage (profiles)** | $50K--$100K/yr (file servers)                     | $30K--$60K/yr (Azure Files)             |
| **Management**         | 3--5 FTEs ($450K--$750K/yr)                       | 1--3 FTEs ($150K--$450K/yr)             |
| **3-year total**       | $4.2M--$9.5M                                      | $2.0M--$4.2M                            |

!!! note "Cost model is illustrative"
Actual costs depend on user density, VM sizing, reserved instance commitments, and Azure Government pricing (~25% premium). Use the [detailed TCO analysis](citrix-to-avd/tco-analysis.md) for a rigorous comparison.

---

## 8. Federal considerations

- **Azure Government:** AVD is available in US Gov Virginia, US Gov Arizona, US Gov Texas, DoD Central, and DoD East
- **IL2--IL5:** AVD on Azure Government supports IL2 through IL5
- **FedRAMP High:** AVD inherits Azure Government FedRAMP High authorization
- **Smart card (PIV/CAC):** AVD supports certificate-based authentication with PIV/CAC smart cards
- **Screen capture protection:** AVD provides built-in screen capture protection for sensitive environments
- **FIPS 140-2:** session hosts can be configured for FIPS 140-2 validated cryptographic modules

For detailed federal guidance, see the [Federal Migration Guide](citrix-to-avd/federal-migration-guide.md).

---

## 9. How CSA-in-a-Box fits

The Citrix-to-AVD migration is an end-user computing migration. CSA-in-a-Box is a data platform. They are complementary:

1. **EUC migration** (this playbook): replaces Citrix VDI with Azure Virtual Desktop
2. **Data analyst workstation** (CSA-in-a-Box pattern): provides governed, pre-configured AVD desktops optimized for data work

CSA-in-a-Box provides the data services that AVD desktops connect to:

- **Microsoft Fabric** for unified data analytics (lakehouse, warehouse, pipelines)
- **Databricks** for advanced analytics, ML, and notebook-based exploration
- **Power BI** for interactive dashboards and self-service analytics
- **Azure AI Foundry** for AI/ML model development and deployment
- **Purview** for data governance, classification, and lineage
- **Azure Monitor** for operational observability across the platform

The AVD data analyst desktop pattern includes:

- Pre-installed analytics tools (Power BI Desktop, Azure Data Studio, Python, VS Code)
- Private Link connectivity to Fabric workspaces and Databricks clusters
- FSLogix profile containers preserving user configurations and cached data
- Conditional Access policies ensuring data stays within governed boundaries
- Intune compliance policies for endpoint security

---

## 10. Related resources

- **Migration index:** [docs/migrations/README.md](README.md)
- **Citrix to AVD Migration Center:** [citrix-to-avd/index.md](citrix-to-avd/index.md)
- **CSA-in-a-Box Architecture:** [docs/ARCHITECTURE.md](../ARCHITECTURE.md)
- **Government Service Matrix:** [docs/GOV_SERVICE_MATRIX.md](../GOV_SERVICE_MATRIX.md)
- **Cost Management:** [docs/COST_MANAGEMENT.md](../COST_MANAGEMENT.md)
- **VMware to Azure Migration:** [vmware-to-azure.md](vmware-to-azure.md) (complementary infrastructure migration)

---

**Maintainers:** CSA-in-a-Box core team
**Last updated:** 2026-04-30
