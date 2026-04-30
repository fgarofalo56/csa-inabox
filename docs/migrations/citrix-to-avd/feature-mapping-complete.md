# Complete Feature Mapping: Citrix to Azure Virtual Desktop

**Audience:** CTO, EUC Architecture, VDI Engineering, Desktop Administration
**Purpose:** Map every significant Citrix capability to its AVD equivalent with migration complexity and gap analysis
**Last updated:** 2026-04-30

---

## How to read this document

Each table maps Citrix features to their AVD equivalents. Columns:

- **Citrix feature:** the Citrix capability as named in Citrix documentation
- **AVD equivalent:** the corresponding Azure/Microsoft capability
- **Parity:** Full (feature-complete replacement), Partial (covers primary use cases with gaps), Gap (no direct equivalent), or Superior (AVD exceeds Citrix)
- **Migration effort:** XS (configuration only), S (hours), M (days), L (weeks), XL (months)
- **Notes:** migration-relevant details and caveats

---

## 1. Architecture and management

| Citrix feature                                   | AVD equivalent                           | Parity   | Effort | Notes                                                                   |
| ------------------------------------------------ | ---------------------------------------- | -------- | ------ | ----------------------------------------------------------------------- |
| **FlexCast Management Architecture (FMA)**       | AVD ARM resource model                   | Full     | M      | FMA Sites become AVD host pools; Delivery Controllers are Azure-managed |
| **Citrix Studio / Web Studio**                   | Azure Portal + Bicep + PowerShell        | Full     | S      | All AVD configuration through Azure Resource Manager                    |
| **Citrix Director**                              | AVD Insights + Azure Monitor workbooks   | Full     | M      | See [Monitoring Migration](monitoring-migration.md)                     |
| **Citrix Cloud**                                 | AVD control plane (Azure-managed)        | Full     | M      | Broker, gateway, diagnostics are all Azure-managed SaaS                 |
| **Citrix Cloud Connectors**                      | Not needed                               | Superior | XS     | AVD has no on-prem connector requirement; agents connect outbound       |
| **Citrix Licensing Server**                      | M365 E3/E5 license (no server)           | Superior | XS     | No infrastructure to manage                                             |
| **Site database (SQL Server)**                   | Not needed (Azure-managed state)         | Superior | XS     | AVD stores state in ARM; no SQL database to manage                      |
| **Monitoring database**                          | Log Analytics workspace                  | Full     | S      | Diagnostic settings route to Log Analytics                              |
| **Configuration Logging database**               | Azure Activity Log + Resource Graph      | Full     | XS     | ARM audit trail replaces Citrix config logging                          |
| **Citrix ADM / Application Delivery Management** | Azure Monitor + Network Watcher          | Partial  | M      | ADM network analytics partially covered by Azure networking tools       |
| **Citrix Optimizer**                             | Windows OS optimization (manual or VDOT) | Full     | S      | Virtual Desktop Optimization Tool (VDOT) provides equivalent OS tuning  |

---

## 2. Session host provisioning and images

| Citrix feature                      | AVD equivalent                             | Parity   | Effort | Notes                                                                                                |
| ----------------------------------- | ------------------------------------------ | -------- | ------ | ---------------------------------------------------------------------------------------------------- |
| **Machine Creation Services (MCS)** | Azure Compute Gallery + ARM templates      | Full     | M      | Gallery images replace MCS master images; ARM/Bicep replaces MCS catalogs                            |
| **Provisioning Services (PVS)**     | Azure Compute Gallery + ephemeral OS disks | Full     | M      | PVS streaming replaced by gallery image + ephemeral disk (no write-back)                             |
| **Machine Catalogs**                | Host pools                                 | Full     | S      | Each Machine Catalog maps to an AVD host pool                                                        |
| **Delivery Groups**                 | Application groups                         | Full     | S      | Desktop Delivery Group = Desktop application group; App Delivery Group = RemoteApp application group |
| **Power Management**                | AVD scaling plans                          | Full     | S      | Citrix power policies map to AVD scaling plan schedules                                              |
| **Zones**                           | Host pools per region                      | Full     | S      | Citrix Zones for geographic affinity become region-specific host pools                               |
| **Hosting Connections**             | Not needed (Azure-native)                  | Superior | XS     | No hypervisor connection config; session hosts are Azure VMs natively                                |
| **VDA (Virtual Delivery Agent)**    | AVD agent + boot loader                    | Full     | S      | Remove VDA, install AVD agent; see [Session Host Migration](session-host-migration.md)               |
| **Master Image / Golden Image**     | Azure Compute Gallery image version        | Full     | S      | Sysprep + capture to gallery; same process                                                           |
| **Image versioning**                | Compute Gallery image versions             | Full     | XS     | Native versioning with replication across regions                                                    |
| **MCS I/O optimization**            | Ephemeral OS disks + Azure Disk caching    | Full     | S      | Ephemeral disks provide write-back equivalent without infrastructure                                 |
| **Hypervisor tags**                 | Azure resource tags                        | Full     | XS     | Tag-based management, policy, and cost allocation                                                    |

---

## 3. Protocol and display

| Citrix feature                             | AVD equivalent                            | Parity  | Effort | Notes                                                                                  |
| ------------------------------------------ | ----------------------------------------- | ------- | ------ | -------------------------------------------------------------------------------------- |
| **HDX (ICA) protocol**                     | RDP + RDP Shortpath (UDP)                 | Partial | M      | RDP Shortpath narrows gap; HDX retains edge for low-bandwidth and lossless             |
| **Thinwire (adaptive display)**            | RDP adaptive graphics                     | Partial | XS     | RDP adapts to network; Thinwire progressive display is more granular                   |
| **EDT (Enlightened Data Transport / UDP)** | RDP Shortpath (UDP)                       | Full    | S      | Both provide UDP-based transport; RDP Shortpath for managed and public networks        |
| **HDX 3D Pro (GPU)**                       | RDP with GPU VMs (NVadsA10_v5, NCasT4_v3) | Partial | M      | GPU acceleration works; HDX 3D Pro has lower-latency encoding for some workloads       |
| **Framehawk**                              | Deprecated (replaced by EDT/Shortpath)    | N/A     | XS     | Both platforms have moved to UDP transports                                            |
| **Audio quality (HDX)**                    | RDP audio redirection                     | Full    | XS     | Comparable quality for standard audio; HDX has edge for music/rich audio               |
| **Multi-monitor**                          | RDP multi-monitor (up to 16 monitors)     | Full    | XS     | Both support up to 16 monitors at 8K resolution                                        |
| **Display resolution**                     | Up to 8K (7680x4320) per monitor          | Full    | XS     | Parity                                                                                 |
| **Waterfall bandwidth management**         | QoS policies (GPO/Intune)                 | Partial | M      | Citrix channel-level priority is more granular than RDP QoS                            |
| **HDX Insight (protocol analytics)**       | AVD Insights + connection diagnostics     | Partial | S      | AVD provides connection quality data; HDX Insight is more protocol-specific            |
| **Browser content redirection**            | Microsoft Edge/WebView2                   | Partial | S      | Citrix redirects browser rendering to client; AVD relies on native browser performance |
| **Client-side rendering**                  | Not available                             | Gap     | N/A    | Citrix can offload rendering to the client device; RDP renders server-side             |

---

## 4. User access and authentication

| Citrix feature                             | AVD equivalent                           | Parity   | Effort | Notes                                                                           |
| ------------------------------------------ | ---------------------------------------- | -------- | ------ | ------------------------------------------------------------------------------- |
| **StoreFront**                             | AVD feed (built-in web + client)         | Full     | S      | Users access desktops/apps through Windows client, web client, or mobile client |
| **Citrix Workspace**                       | Microsoft Remote Desktop client          | Full     | S      | Available on Windows, macOS, iOS, Android, web                                  |
| **Citrix Workspace app**                   | Remote Desktop client (MSRDC)            | Partial  | S      | MSRDC covers primary platforms; Citrix has broader thin client support          |
| **NetScaler Gateway**                      | AVD reverse connect (Azure-managed)      | Superior | S      | No inbound firewall ports; no gateway infrastructure to manage                  |
| **SAML authentication**                    | Entra ID SAML/OIDC                       | Full     | M      | Native Entra ID integration; SAML for federated identity                        |
| **Smart card (PIV/CAC)**                   | Certificate-based authentication (CBA)   | Full     | M      | Entra ID CBA supports PIV/CAC; see [Federal Guide](federal-migration-guide.md)  |
| **FIDO2 / passwordless**                   | Entra ID FIDO2 + Windows Hello           | Full     | S      | Native passwordless support                                                     |
| **RADIUS (MFA)**                           | Entra ID MFA + Conditional Access        | Superior | M      | Cloud-native MFA; no RADIUS infrastructure needed                               |
| **nFactor authentication**                 | Conditional Access policies              | Full     | M      | Multi-step, risk-based auth via Conditional Access                              |
| **Session pre-launch**                     | Not available (connection-on-demand)     | Gap      | N/A    | AVD sessions start on connection; no pre-launch warming                         |
| **Session linger**                         | Scaling plan drain mode                  | Partial  | S      | Scaling plans manage session drain but not explicit linger                      |
| **Federated Authentication Service (FAS)** | Entra ID certificate-based auth + SSO    | Full     | M      | FAS maps to Entra CBA; Entra SSO replaces FAS virtual smart card                |
| **Local Host Cache**                       | Not needed (Azure-managed HA)            | Superior | XS     | AVD control plane is Azure-managed with built-in HA                             |
| **Adaptive Access**                        | Conditional Access + Compliance policies | Full     | M      | Risk-based access control through Entra ID                                      |

---

## 5. Profile management

| Citrix feature                             | AVD equivalent                            | Parity   | Effort | Notes                                                                          |
| ------------------------------------------ | ----------------------------------------- | -------- | ------ | ------------------------------------------------------------------------------ |
| **Citrix UPM (User Profile Management)**   | FSLogix Profile Container                 | Superior | M      | VHDx mount replaces file-level sync; 2--5s login vs 15--60s                    |
| **Profile streaming**                      | FSLogix (inherent -- lazy load from VHDx) | Full     | XS     | VHDx is lazily paged; no explicit streaming config                             |
| **Persona Management**                     | FSLogix Profile Container                 | Full     | M      | Full profile capture in VHDx container                                         |
| **Folder redirection**                     | FSLogix + OneDrive Known Folder Move      | Full     | S      | KFM for Documents/Desktop/Pictures; FSLogix for everything else                |
| **Cross-platform profiles**                | Not available                             | Gap      | N/A    | FSLogix is Windows-only; Citrix UPM supports Linux profiles                    |
| **Profile exclusions**                     | FSLogix redirections.xml                  | Full     | S      | XML-based exclusion list; same concept as UPM exclusions                       |
| **Large file handling**                    | FSLogix Office Container                  | Superior | S      | Dedicated VHDx for Outlook OST, Teams cache, OneDrive cache                    |
| **WEM (Workspace Environment Management)** | Intune + GPO + FSLogix                    | Full     | M      | WEM environment management maps to Intune config profiles                      |
| **WEM CPU management**                     | Not directly available                    | Gap      | N/A    | CPU Spike Protection and CPU Clamping are Citrix-specific; use Azure VM sizing |
| **WEM logon optimization**                 | FSLogix + Intune                          | Partial  | M      | FSLogix provides fast logon; Intune handles app deployment                     |

---

## 6. Application delivery

| Citrix feature                   | AVD equivalent                                 | Parity  | Effort | Notes                                                                                         |
| -------------------------------- | ---------------------------------------------- | ------- | ------ | --------------------------------------------------------------------------------------------- |
| **Published applications**       | RemoteApp application groups                   | Full    | S      | Per-app publishing with per-user/group assignment                                             |
| **Published desktops**           | Desktop application groups                     | Full    | S      | Full desktop delivery                                                                         |
| **App Layering**                 | MSIX app attach                                | Full    | M      | MSIX packages replace Elastic Layers; see [App Delivery Migration](app-delivery-migration.md) |
| **App-V integration**            | MSIX app attach or App-V on AVD                | Full    | M      | App-V packages run natively on AVD session hosts                                              |
| **Application probing**          | Azure Monitor + custom health checks           | Partial | M      | No built-in app probing; implement via Azure Automation or custom scripts                     |
| **File Type Association (FTA)**  | RemoteApp FTA configuration                    | Full    | S      | Native in AVD RemoteApp                                                                       |
| **Seamless windows**             | RemoteApp (seamless by default)                | Full    | XS     | RemoteApp runs in seamless window mode natively                                               |
| **Workspace aggregation**        | AVD workspace with multiple application groups | Full    | S      | Multiple app groups under one workspace                                                       |
| **Application limits**           | Per-user app assignment via Entra groups       | Full    | S      | Group-based access control per application group                                              |
| **Secure Browser**               | Microsoft Edge + Application Guard             | Full    | S      | Edge with Application Guard for isolated browsing                                             |
| **Citrix Content Collaboration** | SharePoint + OneDrive                          | Full    | S      | Microsoft 365 content platform replaces Citrix Files                                          |

---

## 7. Printing

| Citrix feature                    | AVD equivalent                         | Parity | Effort | Notes                                                                 |
| --------------------------------- | -------------------------------------- | ------ | ------ | --------------------------------------------------------------------- |
| **Citrix Universal Print Driver** | Universal Print or native driver       | Full   | M      | Universal Print is cloud-native; native drivers work on session hosts |
| **Citrix Universal Print Server** | Universal Print connectors             | Full   | M      | Cloud-based print management                                          |
| **Client printer mapping**        | RDP printer redirection                | Full   | XS     | Client printers redirect into AVD sessions natively                   |
| **Proximity printing**            | Universal Print + location-based rules | Full   | M      | Universal Print supports location-aware printer assignment            |
| **Network printer mapping**       | GPO or Intune printer deployment       | Full   | S      | Standard Windows printer deployment methods                           |
| **Print policy controls**         | Intune + GPO print policies            | Full   | S      | Print restriction policies via endpoint management                    |

---

## 8. Multimedia and peripherals

| Citrix feature                             | AVD equivalent                             | Parity  | Effort | Notes                                                                |
| ------------------------------------------ | ------------------------------------------ | ------- | ------ | -------------------------------------------------------------------- |
| **Teams optimization (HDX)**               | AVD Teams media optimization               | Full    | XS     | Native media offload for Teams on AVD (WebRTC)                       |
| **Zoom optimization (HDX)**                | Zoom VDI plugin for AVD                    | Full    | XS     | Zoom provides native AVD media offload                               |
| **Webcam redirection**                     | RDP webcam redirection                     | Full    | XS     | Webcams redirect natively                                            |
| **USB redirection**                        | RDP USB redirection                        | Partial | S      | Basic USB redirect works; Citrix HDX has deeper device-level control |
| **HDX RealTime Optimization Pack (Skype)** | Deprecated                                 | N/A     | XS     | Skype for Business is EOL; Teams optimization replaces               |
| **Client drive mapping**                   | RDP drive redirection                      | Full    | XS     | Local drives accessible in session                                   |
| **Clipboard redirection**                  | RDP clipboard + Conditional Access control | Full    | S      | Clipboard works natively; CA policies can restrict                   |
| **Serial/COM port redirection**            | RDP serial port redirection                | Full    | XS     | COM port redirect available                                          |
| **Scanner redirection**                    | TWAIN redirection (limited)                | Partial | M      | Basic TWAIN supported; Citrix has more scanner-specific optimization |
| **HDX MediaStream**                        | RDP multimedia redirection                 | Partial | S      | Media redirection available but less optimized than HDX              |

---

## 9. Security

| Citrix feature                                           | AVD equivalent                                   | Parity   | Effort | Notes                                                                   |
| -------------------------------------------------------- | ------------------------------------------------ | -------- | ------ | ----------------------------------------------------------------------- |
| **App Protection (anti-keylogger, anti-screen-capture)** | Screen capture protection + Watermarking         | Partial  | S      | AVD blocks screenshots/recording; Citrix additionally blocks keyloggers |
| **Session recording**                                    | Not built-in (use third-party or Azure Monitor)  | Gap      | M      | No native session recording; third-party solutions available            |
| **SmartAccess (endpoint analysis)**                      | Conditional Access + Intune compliance           | Full     | M      | Device health, OS version, compliance check before access               |
| **Contextual access policies**                           | Conditional Access (location, device, risk, app) | Superior | M      | Entra ID CA is more flexible than SmartAccess                           |
| **SSL/TLS termination**                                  | Azure-managed (reverse connect)                  | Superior | XS     | No certificate management for gateway; Azure handles TLS                |
| **ICA encryption**                                       | TLS 1.2/1.3 for RDP                              | Full     | XS     | Both enforce TLS; AVD uses TLS for all control and data traffic         |
| **Secure ICA**                                           | RDP over TLS                                     | Full     | XS     | Encrypted transport is default                                          |
| **Citrix Secure Private Access**                         | Azure Private Link + Conditional Access          | Full     | M      | Zero-trust access via Private Link and CA                               |
| **Virtual channel allow/deny**                           | Conditional Access + GPO channel control         | Full     | S      | RDP channel redirection controlled via GPO and CA                       |
| **FIPS 140-2 endpoints**                                 | FIPS 140-2 validated crypto on session hosts     | Full     | M      | Windows FIPS mode + Azure FIPS-validated services                       |

---

## 10. Monitoring and analytics

| Citrix feature                            | AVD equivalent                              | Parity | Effort | Notes                                                             |
| ----------------------------------------- | ------------------------------------------- | ------ | ------ | ----------------------------------------------------------------- |
| **Citrix Director**                       | AVD Insights                                | Full   | M      | See [Monitoring Migration](monitoring-migration.md)               |
| **Director -- session details**           | AVD Insights connection diagnostics         | Full   | S      | Per-session and per-user analytics                                |
| **Director -- logon duration breakdown**  | AVD Insights logon duration analysis        | Full   | S      | Breakdown: authentication, profile load, GPO, shell               |
| **Director -- historical trending**       | Azure Monitor workbooks + Log Analytics     | Full   | S      | Custom KQL queries for trending                                   |
| **Citrix Analytics for Security**         | Microsoft Sentinel + Defender for Cloud     | Full   | M      | SIEM/XDR coverage exceeds Citrix Analytics                        |
| **Citrix Analytics for Performance**      | AVD Insights + Azure Monitor metrics        | Full   | M      | Performance telemetry through AVD diagnostics                     |
| **Connection Quality Indicator (CQI)**    | AVD connection quality data (AVD Insights)  | Full   | S      | Round-trip time, bandwidth, frame rate metrics                    |
| **EUEM (End User Experience Monitoring)** | Azure Monitor + Endpoint Analytics (Intune) | Full   | M      | Intune Endpoint Analytics provides user experience scoring        |
| **Alerting**                              | Azure Monitor alerts + Action Groups        | Full   | S      | KQL-based alert rules with email, SMS, webhook, Logic App actions |
| **Custom reports**                        | Azure Monitor workbooks (custom)            | Full   | M      | Fully customizable workbook reports                               |

---

## 11. Networking

| Citrix feature                     | AVD equivalent                                  | Parity   | Effort | Notes                                                          |
| ---------------------------------- | ----------------------------------------------- | -------- | ------ | -------------------------------------------------------------- |
| **NetScaler ADC (load balancing)** | Azure Load Balancer (not needed for AVD broker) | Superior | S      | AVD broker handles session distribution; no separate LB needed |
| **NetScaler Gateway**              | AVD reverse connect                             | Superior | S      | No inbound ports, no gateway VMs, Azure-managed                |
| **ICA proxy**                      | Not needed (reverse connect)                    | Superior | XS     | Reverse connect eliminates proxy requirement                   |
| **HDX Adaptive Transport**         | RDP Shortpath (UDP)                             | Full     | S      | UDP transport for managed networks and public internet         |
| **Multi-stream ICA**               | Single RDP connection with channel multiplexing | Full     | XS     | RDP multiplexes channels within a single connection            |
| **SD-WAN integration**             | Azure Virtual WAN + SD-WAN NVA                  | Full     | M      | Azure Virtual WAN provides SD-WAN hub capabilities             |
| **Rendezvous protocol**            | Not needed (reverse connect is inherent)        | Superior | XS     | All AVD connections use reverse connect by design              |
| **SSL VPN (NetScaler)**            | Azure VPN Gateway or Conditional Access         | Full     | M      | VPN for hybrid; CA + Private Link for zero-trust               |
| **DNS-based service record**       | Azure Traffic Manager + AVD geographic routing  | Full     | S      | Regional routing handled by AVD infrastructure                 |

---

## 12. High availability and disaster recovery

| Citrix feature                 | AVD equivalent                                    | Parity   | Effort | Notes                                                  |
| ------------------------------ | ------------------------------------------------- | -------- | ------ | ------------------------------------------------------ |
| **Local Host Cache**           | Not needed (Azure SLA 99.9%)                      | Superior | XS     | AVD control plane has Azure-backed HA                  |
| **Zone preference**            | Host pool per region                              | Full     | S      | Multi-region host pools for DR                         |
| **StoreFront server groups**   | Not needed (Azure-managed)                        | Superior | XS     | AVD feed is Azure-managed HA                           |
| **NetScaler GSLB**             | Azure Front Door or Traffic Manager               | Full     | M      | Global load balancing for multi-region                 |
| **Database HA (SQL AlwaysOn)** | Not needed (Azure-managed state)                  | Superior | XS     | No customer-managed SQL databases                      |
| **PVS HA**                     | Not needed (gallery image replication)            | Superior | XS     | Azure Compute Gallery replicates images across regions |
| **Site failover**              | AVD cross-region host pools + FSLogix Cloud Cache | Full     | M      | Cloud Cache replicates profiles across regions         |
| **Session host HA**            | Availability Zones + scaling plans                | Full     | S      | Spread session hosts across AZs                        |

---

## 13. Automation and extensibility

| Citrix feature                  | AVD equivalent                             | Parity | Effort | Notes                                          |
| ------------------------------- | ------------------------------------------ | ------ | ------ | ---------------------------------------------- |
| **Citrix PowerShell SDK**       | Az.DesktopVirtualization PowerShell module | Full   | S      | Full PowerShell management                     |
| **Citrix REST APIs**            | Azure ARM REST APIs                        | Full   | S      | Full API management through ARM                |
| **Citrix OData Monitor API**    | Log Analytics REST API + KQL               | Full   | S      | Query monitoring data via KQL                  |
| **Terraform provider**          | AzureRM Terraform provider                 | Full   | S      | Full AVD resource management                   |
| **MCS provisioning automation** | Bicep + ARM templates + DevOps pipelines   | Full   | M      | CI/CD for image build and host deployment      |
| **WEM scripted actions**        | Intune scripts + Azure Automation          | Full   | S      | Proactive remediations and automation runbooks |

---

## 14. Licensing and entitlement

### Features where AVD is superior

1. Windows 10/11 multi-session (unique to AVD)
2. No gateway infrastructure (reverse connect)
3. No SQL databases to manage
4. No licensing server
5. FSLogix VHDx profiles (faster login, better compatibility)
6. Azure-managed control plane HA
7. Conditional Access (richer than SmartAccess)
8. Included in M365 E3/E5 (zero licensing cost)

### Features where Citrix retains an edge

1. HDX protocol for extreme low-bandwidth and lossless graphics
2. App Protection anti-keylogger (AVD covers screenshot/recording only)
3. Client-side rendering offload
4. Session pre-launch
5. Broader thin client device support (Workspace app)
6. Cross-platform profiles (Linux)
7. Session recording (built-in)
8. CPU spike management (WEM)

### Features with full parity

Published applications, published desktops, profile management, application delivery, printing, Teams optimization, multi-monitor, GPU support, smart card authentication, FIDO2, autoscale, monitoring, alerting, PowerShell automation, Terraform, and all infrastructure HA capabilities.

---

## 14. Licensing and entitlement

| Citrix license                       | AVD equivalent                                                           | Notes                       |
| ------------------------------------ | ------------------------------------------------------------------------ | --------------------------- |
| **CVAD Advanced / Premium**          | Included in M365 E3/E5                                                   | No separate VDI license     |
| **Citrix Cloud subscription**        | $0 (Azure-managed control plane)                                         | No management plane license |
| **NetScaler license (VPX/MPX)**      | $0 (reverse connect is Azure-managed)                                    | No gateway license          |
| **Citrix Analytics license**         | Azure Monitor + AVD Insights ($0 platform, Log Analytics ingestion only) | Dramatically lower cost     |
| **App Protection add-on**            | Screen capture protection (included)                                     | Partial: no anti-keylogger  |
| **Citrix Secure Private Access**     | Conditional Access + Private Link (included in Entra P1/P2)              | Stronger integration        |
| **Citrix Endpoint Management (CEM)** | Intune (included in M365 E3/E5)                                          | Full feature replacement    |
| **RDS CAL (for Server OS)**          | Not needed (Windows 10/11 multi-session license in M365)                 | Multi-session is desktop OS |
| **Citrix Content Collaboration**     | SharePoint + OneDrive (included in M365)                                 | Full parity                 |
| **Citrix Virtual Apps standalone**   | AVD RemoteApp application groups                                         | Full parity                 |

---

## 15. Endpoint client support

| Endpoint platform                   | Citrix Workspace app   | Microsoft Remote Desktop client |
| ----------------------------------- | ---------------------- | ------------------------------- |
| **Windows**                         | Full                   | Full                            |
| **macOS**                           | Full                   | Full                            |
| **iOS / iPadOS**                    | Full                   | Full                            |
| **Android / ChromeOS**              | Full                   | Full                            |
| **Linux**                           | Full                   | Preview / Snap package          |
| **Web browser**                     | Full (HTML5)           | Full (HTML5)                    |
| **Windows thin client (IGEL)**      | Optimized (IGEL ready) | Supported (IGEL ready)          |
| **Windows thin client (10ZiG)**     | Optimized              | Supported                       |
| **Windows thin client (HP)**        | Optimized (HP ThinPro) | Supported (HP ThinPro)          |
| **Windows thin client (Dell Wyse)** | Optimized (ThinOS)     | Supported (ThinOS 2302+)        |
| **Raspberry Pi**                    | Community (limited)    | Not supported                   |
| **Windows 365 Thin Client**         | N/A                    | Native (purpose-built)          |

**Citrix advantage:** broader thin client optimization with deeper hardware-level integration (especially IGEL and Dell Wyse). Microsoft is closing this gap with the Windows 365 Thin Client device and expanded thin client support, but Citrix maintains a lead in the embedded device ecosystem.

---

## 16. Data protection and DLP

| Citrix feature                       | AVD equivalent                          | Parity   | Notes                                                     |
| ------------------------------------ | --------------------------------------- | -------- | --------------------------------------------------------- |
| **Session watermarking**             | AVD watermarking (built-in)             | Full     | User identity watermark overlay                           |
| **Screen capture protection**        | AVD screen capture protection           | Full     | Blocks screenshots, recording, sharing                    |
| **Anti-keylogging**                  | Not available                           | Gap      | Citrix App Protection provides client-side anti-keylogger |
| **Clipboard restriction**            | Conditional Access + RDP property       | Full     | `redirectclipboard:i:0` in custom RDP properties          |
| **Drive mapping restriction**        | Conditional Access + RDP property       | Full     | `drivestoredirect:s:` (empty) disables drive redirect     |
| **Download/upload restriction**      | Conditional Access session controls     | Full     | App-enforced restrictions via CA                          |
| **Citrix Secure Browser**            | Microsoft Edge + Application Guard      | Full     | Isolated browser environment                              |
| **Citrix Analytics for Security**    | Microsoft Sentinel + Defender for Cloud | Superior | Enterprise SIEM/XDR vs point solution                     |
| **Insider threat detection**         | Entra ID Identity Protection + Sentinel | Superior | User risk scoring, impossible travel, anomalous behavior  |
| **Session recording for compliance** | Third-party (e.g., Observit, Ekran)     | Gap      | No built-in session recording; requires third-party       |

---

## 17. Disaster recovery and business continuity

| Citrix feature             | AVD equivalent                            | Parity                       | Notes                                            |
| -------------------------- | ----------------------------------------- | ---------------------------- | ------------------------------------------------ |
| **Multi-site DR**          | Multi-region host pools + Traffic Manager | Full                         | Host pools in multiple Azure regions             |
| **Local Host Cache (LHC)** | Azure-managed HA (99.9% SLA)              | Superior                     | No customer-managed LHC needed                   |
| **StoreFront failover**    | Azure-managed feed HA                     | Superior                     | Feed is Azure-managed, globally distributed      |
| **Database replication**   | Not needed (no customer SQL)              | Superior                     | ARM state is Azure-managed                       |
| **PVS failover**           | Gallery image replication                 | Full                         | Compute Gallery replicates across regions        |
| **Profile DR**             | FSLogix Cloud Cache                       | Full                         | Active-active profile replication across regions |
| **NetScaler GSLB**         | Azure Front Door                          | Full                         | Global load balancing with health probes         |
| **Citrix ADM DR**          | Not needed                                | Superior                     | Azure Monitor is globally available              |
| **RTO target**             | 15--60 min (depends on infrastructure)    | 5--15 min (pre-staged hosts) | AVD can pre-stage standby hosts in DR region     |
| **RPO target**             | Depends on profile replication            | < 5 min (Cloud Cache sync)   | Cloud Cache provides near-zero RPO               |

---

## 18. Multi-tenancy and isolation

| Citrix feature                    | AVD equivalent                                     | Parity   | Notes                                                 |
| --------------------------------- | -------------------------------------------------- | -------- | ----------------------------------------------------- |
| **Citrix Cloud multi-tenant**     | Multiple Azure subscriptions / host pools          | Full     | Azure subscription boundaries provide hard isolation  |
| **Zone-based isolation**          | Host pool per tenant / per region                  | Full     | Separate host pools per tenant                        |
| **Delegated administration**      | Azure RBAC + custom roles                          | Superior | Granular RBAC with scope (subscription, RG, resource) |
| **Citrix Service Provider (CSP)** | Azure Lighthouse + multi-tenant management         | Full     | Lighthouse enables managed service provider model     |
| **Tenant-specific policies**      | Per-host-pool custom RDP properties + per-group CA | Full     | Policies scoped to host pool or application group     |
| **Tenant-specific images**        | Per-tenant image definitions in Compute Gallery    | Full     | Image isolation by tenant                             |
| **Tenant-specific profiles**      | Per-tenant Azure Files shares                      | Full     | Storage account isolation per tenant                  |

---

## Migration complexity summary

| Complexity                  | Feature count | Description                                                        |
| --------------------------- | ------------- | ------------------------------------------------------------------ |
| **XS** (configuration only) | 18            | Features that map 1:1 with minimal configuration                   |
| **S** (hours)               | 22            | Features requiring a few hours of setup and testing                |
| **M** (days)                | 14            | Features requiring days of planning, configuration, and validation |
| **L** (weeks)               | 2             | Major architectural changes (rare)                                 |
| **Gap** (no equivalent)     | 6             | Features with no direct AVD equivalent                             |
| **Superior** (AVD exceeds)  | 12            | Features where AVD provides a better solution than Citrix          |

Total features mapped: **74**

---

## 19. Summary: gap analysis

### Features where AVD is superior

1. Windows 10/11 multi-session (unique to AVD)
2. No gateway infrastructure (reverse connect)
3. No SQL databases to manage
4. No licensing server
5. FSLogix VHDx profiles (faster login, better compatibility)
6. Azure-managed control plane HA
7. Conditional Access (richer than SmartAccess)
8. Included in M365 E3/E5 (zero licensing cost)

### Features where Citrix retains an edge

1. HDX protocol for extreme low-bandwidth and lossless graphics
2. App Protection anti-keylogger (AVD covers screenshot/recording only)
3. Client-side rendering offload
4. Session pre-launch
5. Broader thin client device support (Workspace app)
6. Cross-platform profiles (Linux)
7. Session recording (built-in)
8. CPU spike management (WEM)

### Features with full parity

Published applications, published desktops, profile management, application delivery, printing, Teams optimization, multi-monitor, GPU support, smart card authentication, FIDO2, autoscale, monitoring, alerting, PowerShell automation, Terraform, and all infrastructure HA capabilities.

---

## 20. Gap mitigation strategies

For each identified gap, this section provides a recommended mitigation approach:

| Gap | Citrix capability | Recommended mitigation | Risk level |
| --- | --- | --- | --- |
| **Anti-keylogging** | App Protection blocks keylogger software at the client | Deploy Microsoft Defender for Endpoint on session hosts for keylogger detection. Use Intune security baselines to enforce application allow-listing. Screen capture protection blocks the most common data exfiltration vector. For most organizations, the remaining risk is acceptable. | Low |
| **Session recording** | Director records user sessions for compliance/audit | Deploy third-party session recording (Ekran System, Observit, or CyberArk PSM). Alternatively, use Azure Monitor activity logs + screen capture protection + Defender for Endpoint telemetry for equivalent forensic coverage. | Medium |
| **Session pre-launch** | Sessions start before user connects, reducing perceived login time | Configure AVD "Start VM on Connect" to power on session hosts when users connect. With FSLogix 2--5 second profile load, total login time is already low enough that pre-launch is unnecessary for most workloads. | Low |
| **Client-side rendering** | Browser and video content rendered on client device | Use Microsoft Edge browser content redirection for specific URLs. For video content, Teams and Zoom media offload already provides client-side processing. The remaining gap affects only scenarios with heavy browser-based video outside of Teams/Zoom. | Low |
| **Cross-platform profiles** | UPM supports Windows and Linux profiles | For Linux desktop workloads, consider Azure DevBox (cloud-based development workstations). For mixed Windows/Linux environments, maintain separate profile strategies. This gap only affects organizations running Linux VDI, which is rare in enterprise. | Low |
| **CPU spike management** | WEM CPU Clamping and CPU Spike Protection | Right-size session host VMs using Azure Monitor CPU telemetry. Use Azure VM performance data to identify users with excessive CPU consumption. Implement per-user CPU affinity via Group Policy. Deploy Azure autoscale to add capacity under load. | Low |
| **Broader thin client support** | Workspace app optimized for IGEL, 10ZiG, Dell Wyse, HP thin clients | Most thin client vendors (IGEL, 10ZiG, HP, Dell Wyse) now support the Microsoft Remote Desktop client. IGEL OS supports AVD natively. Windows 365 Thin Client provides a purpose-built Microsoft device. The gap is narrowing rapidly. | Low |
| **Scanner redirection** | HDX scanner-specific optimization | Use TWAIN redirection for basic scanning. For high-volume or specialized scanners, use network-attached scanning (scan to email or scan to folder) rather than session-redirected scanning. | Low |

### Overall gap assessment

Of the 8 identified gaps, none represent blocking issues for the vast majority of enterprise or federal workloads. The most common concern raised during migration planning is session recording for compliance -- which has mature third-party solutions available. All other gaps have acceptable mitigations using Azure-native or Microsoft 365 capabilities.

---

## 21. Feature parity by workload type

Different user workloads require different feature subsets. This section assesses AVD readiness by common workload type:

### Knowledge worker (Office, email, web browsing)

| Feature category | Readiness | Notes |
| --- | --- | --- |
| Desktop delivery | Ready | Windows 11 multi-session (superior to Citrix Server OS) |
| Profile management | Ready | FSLogix (superior login time) |
| Office integration | Ready | Full Microsoft 365 integration |
| Teams optimization | Ready | Native WebRTC media offload |
| Printing | Ready | Universal Print or redirected printers |
| Security | Ready | Conditional Access, Defender, screen capture protection |
| Monitoring | Ready | AVD Insights provides Director-equivalent visibility |
| **Overall** | **Ready** | **Recommended: migrate immediately** |

### Data analyst (CSA-in-a-Box pattern)

| Feature category | Readiness | Notes |
| --- | --- | --- |
| Desktop delivery | Ready | Windows 11 multi-session with Power BI, Azure Data Studio, Python |
| Data connectivity | Ready | Private Link to Fabric, Databricks, ADLS from AVD subnet |
| Profile management | Ready | FSLogix preserves Jupyter notebooks, conda envs, VS Code settings |
| GPU acceleration | Ready | NVadsA10_v5 for GPU-accelerated notebooks and Power BI visuals |
| Security/governance | Ready | Conditional Access restricts data access to AVD sessions only |
| Monitoring | Ready | AVD Insights + per-user resource consumption tracking |
| **Overall** | **Ready** | **Recommended: CSA-in-a-Box data analyst desktop pattern** |

### Power user (CAD, GIS, engineering)

| Feature category | Readiness | Notes |
| --- | --- | --- |
| Desktop delivery | Ready | Personal or pooled with GPU VMs |
| GPU performance | Ready (minor gap) | AVD GPU performance is 10--15% below HDX 3D Pro for some workloads |
| Protocol quality | Ready (minor gap) | RDP Shortpath is adequate; HDX retains edge for lossless graphics |
| USB device support | Ready (minor gap) | Basic USB redirect works; specialized USB devices may need testing |
| Printing (large format) | Ready | Network printer or Universal Print |
| **Overall** | **Ready with testing** | **Recommended: pilot with representative users before full migration** |

### Call center / task worker

| Feature category | Readiness | Notes |
| --- | --- | --- |
| Application delivery | Ready | RemoteApp for single-app delivery |
| Thin client support | Ready (minor gap) | Most thin clients supported; verify specific hardware |
| Session density | Ready | 20--26 task workers per D8s_v5 |
| Audio quality | Ready | RDP audio redirection meets call center quality |
| **Overall** | **Ready** | **Recommended: migrate immediately** |

### Developer / DevOps

| Feature category | Readiness | Notes |
| --- | --- | --- |
| Desktop delivery | Ready | Personal desktops or Azure DevBox |
| Development tools | Ready | VS Code, Visual Studio, Docker, WSL2 on session hosts |
| Git integration | Ready | FSLogix preserves Git credentials and repository state |
| Container support | Ready | Docker Desktop on personal session hosts |
| Remote debugging | Ready | VS Code Remote Development works natively |
| **Overall** | **Ready** | **Consider Azure DevBox for development-specific workloads** |

### Healthcare (clinical workstations)

| Feature category | Readiness | Notes |
| --- | --- | --- |
| Desktop delivery | Ready | Windows 11 multi-session or personal for clinical apps |
| DICOM/medical imaging | Conditional | HDX lossless mode is superior for diagnostic-quality imaging. AVD supports GPU VMs with RDP for review-quality imaging. Validate with radiologists. |
| Smart card (PIV/badge-tap) | Ready | Entra ID CBA supports clinical badge-tap workflows |
| Session recording | Conditional | Requires third-party solution for compliance |
| USB (medical devices) | Conditional | Test specific medical devices; USB redirect covers most devices |
| Printing (labels, wristbands) | Ready | Redirected printer + native driver |
| **Overall** | **Ready for most clinical** | **Pilot required for DICOM and specialized medical devices** |

---

## 22. Migration planning by feature complexity

Use this table to plan migration phases based on feature migration complexity:

### Phase 1: Quick wins (XS and S effort -- days to complete)

These features migrate with minimal effort and should be included in the initial AVD deployment:

- Host pool creation (replaces Machine Catalogs)
- Application group configuration (replaces Delivery Groups)
- AVD agent installation (replaces VDA)
- Azure Compute Gallery (replaces master image management)
- Basic user access (replaces StoreFront)
- Multi-monitor support
- Clipboard, drive, and printer redirection
- Audio redirection
- Teams optimization (WebRTC media offload)
- Scaling plan configuration (replaces power management)
- Basic monitoring (AVD Insights)
- PowerShell and Terraform automation

### Phase 2: Core migration (M effort -- weeks to complete)

These features require planning, testing, and staged rollout:

- FSLogix deployment (replaces Citrix UPM) -- see [Profile Migration](profile-migration.md)
- Conditional Access policies (replaces SmartAccess) -- see [Federal Guide](federal-migration-guide.md)
- RDP Shortpath UDP configuration (replaces EDT)
- Intune enrollment and policy configuration (replaces WEM + Citrix policies)
- MSIX app attach (replaces App Layering) -- see [App Delivery Migration](app-delivery-migration.md)
- Azure Monitor alerting (replaces Director alerting)
- Entra ID certificate-based auth (replaces FAS)
- Universal Print deployment (replaces Citrix UPD)
- Network migration (replaces NetScaler) -- see [Networking Migration](networking-migration.md)

### Phase 3: Advanced features (L effort or gap mitigation -- months)

These features require significant planning or third-party solutions:

- Session recording (third-party deployment)
- Advanced GPU workloads (testing and validation)
- Specialized USB device redirection (device-by-device testing)
- Multi-region DR with FSLogix Cloud Cache
- Custom monitoring workbooks (replaces Director custom reports)

### Phase 4: Post-migration optimization

After all users are migrated:

- Reserved Instance purchasing for steady-state VMs
- Scaling plan tuning based on production usage patterns
- Image management CI/CD pipeline
- Cost optimization review
- Citrix infrastructure decommission

---

## 23. CSA-in-a-Box feature requirements matrix

For organizations deploying CSA-in-a-Box data analyst desktops, this matrix identifies the specific features required and their AVD readiness:

| CSA-in-a-Box requirement | Citrix feature used | AVD equivalent | Readiness |
| --- | --- | --- | --- |
| Multi-user data analyst desktops | SBC on Server OS | Windows 11 multi-session host pools | Superior |
| Power BI Desktop access | Published desktop | Desktop application group | Full parity |
| Azure Data Studio + Jupyter | Published desktop | Desktop application group | Full parity |
| Python/R environment persistence | UPM (partial -- often breaks) | FSLogix Profile Container (full state) | Superior |
| Private network to Fabric | NetScaler + firewall rules | Private Link + NSG | Superior |
| Private network to Databricks | NetScaler + firewall rules | Private Endpoint + NSG | Superior |
| Conditional data access | SmartAccess (limited) | Conditional Access (comprehensive) | Superior |
| Data exfiltration prevention | App Protection (add-on) | Screen capture protection + CA session controls | Full parity |
| User activity monitoring | Citrix Analytics (add-on) | AVD Insights + Defender + Sentinel | Superior |
| Profile backup and recovery | UPM backup (file-level) | FSLogix VHDx snapshot + Azure Backup | Superior |
| Autoscale for variable demand | Citrix Autoscale | AVD scaling plans | Full parity |
| GPU for notebook acceleration | GPU VMs + HDX 3D Pro | GPU VMs (NVadsA10_v5) + RDP | Full parity |
| Teams collaboration | HDX Teams optimization | AVD Teams media optimization | Full parity |
| Golden image management | MCS/PVS | Azure Compute Gallery + Bicep CI/CD | Full parity |
| Federal compliance (IL4/IL5) | Citrix on Azure Government | AVD on Azure Government | Full parity |
| Smart card (PIV/CAC) | NetScaler smart card passthrough | Entra ID CBA | Full parity |

**CSA-in-a-Box assessment:** AVD meets or exceeds every feature requirement for the data analyst desktop pattern. No gaps or mitigations are needed for this workload.

---

**Maintainers:** CSA-in-a-Box core team
**Last updated:** 2026-04-30
