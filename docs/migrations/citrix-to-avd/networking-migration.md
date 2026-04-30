# Networking Migration: Citrix NetScaler/Gateway to AVD

**Audience:** Network Engineers, Security Architects, VDI Engineers
**Scope:** Migrating from Citrix NetScaler ADC, Citrix Gateway, and HDX protocol infrastructure to AVD reverse connect, RDP Shortpath, Private Link, and Azure networking.
**Last updated:** 2026-04-30

---

## Overview

Citrix networking is built around NetScaler ADC (formerly Citrix ADC/NetScaler) -- a dedicated appliance or virtual appliance that handles gateway services, SSL termination, load balancing, and ICA proxying. AVD eliminates the need for customer-managed gateway infrastructure entirely through its reverse connect architecture.

---

## 1. Architecture comparison

### Citrix networking model

```
User → Internet → NetScaler Gateway (DMZ)
  → NetScaler ADC (internal) → StoreFront
  → ICA proxy → Session Host (VDA)

Components managed by customer:
- NetScaler Gateway VPX (DMZ, HA pair)
- NetScaler ADC (internal, HA pair)
- StoreFront servers
- SSL certificates (gateway, StoreFront, VDA)
- Firewall rules (inbound 443 to Gateway)
- DNS records (gateway FQDN)
- Load balancer configurations
```

### AVD networking model

```
User → Internet → AVD Gateway (Azure-managed)
  → Reverse connect → Session Host (AVD agent)

Components managed by customer:
- Session host subnet (outbound to Azure only)
- Private endpoints (optional, for storage and PaaS services)
- NSG rules (outbound only, no inbound required)

Components managed by Azure:
- AVD Gateway (global, redundant)
- Broker and diagnostics
- TLS termination
- Connection orchestration
```

### Key architectural difference

Citrix requires **inbound** connectivity from the internet to customer-managed infrastructure (NetScaler Gateway). AVD uses **reverse connect** -- session hosts establish outbound connections to the Azure-managed gateway. No inbound ports are required.

| Aspect                     | Citrix NetScaler                       | AVD Reverse Connect              |
| -------------------------- | -------------------------------------- | -------------------------------- |
| **Inbound ports**          | TCP 443 (Gateway)                      | None                             |
| **Gateway infrastructure** | Customer-managed (2--4 VMs)            | Azure-managed (no VMs)           |
| **SSL certificates**       | Customer-managed (renewal, rotation)   | Azure-managed                    |
| **DDoS protection**        | Customer responsibility (NetScaler)    | Azure DDoS Protection (platform) |
| **Global availability**    | Customer-deployed per region           | Azure-managed global network     |
| **Cost**                   | $50K--$500K/yr (appliances + licenses) | $0 (included in AVD)             |

---

## 2. Protocol migration: HDX/ICA to RDP/Shortpath

### 2.1 Protocol comparison

| Feature           | Citrix HDX/ICA                          | RDP + RDP Shortpath                     |
| ----------------- | --------------------------------------- | --------------------------------------- |
| **Transport**     | TCP + EDT (UDP)                         | TCP + RDP Shortpath (UDP)               |
| **Compression**   | Adaptive (Thinwire, lossless, lossy)    | Adaptive (AVC/H.264, AV1)               |
| **Channels**      | Multi-stream ICA (32 virtual channels)  | Single connection, multiplexed channels |
| **Audio**         | HDX audio (optimized codecs)            | RDP audio redirection                   |
| **Video**         | HDX MediaStream (client-side decode)    | Multimedia redirection                  |
| **USB**           | HDX USB (generic + optimized)           | RDP USB redirection                     |
| **Printing**      | Citrix Universal Print Driver           | Universal Print + RDP printer redirect  |
| **Clipboard**     | HDX clipboard                           | RDP clipboard                           |
| **File transfer** | Citrix Files / client drive mapping     | RDP drive mapping                       |
| **Teams**         | HDX media optimization (WebRTC offload) | AVD media optimization (WebRTC offload) |
| **Latency**       | 20--50ms typical (EDT/UDP)              | 20--50ms typical (Shortpath/UDP)        |
| **Bandwidth**     | 200--500 Kbps typical (office work)     | 200--500 Kbps typical (office work)     |

### 2.2 RDP Shortpath configuration

RDP Shortpath provides UDP-based transport for AVD sessions, equivalent to Citrix EDT. Two modes:

**Managed networks (private connectivity):**

For session hosts on Azure VNets with direct network path to the client (ExpressRoute, VPN, or same VNet):

```powershell
# Enable RDP Shortpath for managed networks (session host registry)
$rdpShortpathKey = "HKLM:\SYSTEM\CurrentControlSet\Control\Terminal Server\WinStations"
Set-ItemProperty -Path $rdpShortpathKey -Name "fUseUdpPortRedirector" -Value 1 -Type DWord
Set-ItemProperty -Path $rdpShortpathKey -Name "UdpPortNumber" -Value 3390 -Type DWord
```

**Public networks (internet):**

For connections over the public internet, RDP Shortpath uses STUN/TURN for NAT traversal:

```powershell
# Enable RDP Shortpath for public networks via Intune or GPO
# Administrative Templates > Windows Components > Remote Desktop Services >
# Remote Desktop Session Host > Azure Virtual Desktop
# "Enable RDP Shortpath for public networks" = Enabled
```

NSG configuration for RDP Shortpath:

```bash
# Allow UDP for RDP Shortpath (managed networks)
az network nsg rule create \
  --nsg-name nsg-avd-sessionhosts \
  --resource-group rg-avd-prod \
  --name AllowRDPShortpath \
  --priority 200 \
  --direction Inbound \
  --access Allow \
  --protocol Udp \
  --destination-port-ranges 3390 \
  --source-address-prefixes "10.0.0.0/8" "172.16.0.0/12"  # internal only
```

---

## 3. NetScaler Gateway feature mapping

### 3.1 Authentication

| NetScaler feature             | AVD equivalent                                      | Migration action                             |
| ----------------------------- | --------------------------------------------------- | -------------------------------------------- |
| **LDAP authentication**       | Entra ID (synced from AD DS via Entra Connect)      | Already synced if using M365                 |
| **RADIUS (MFA)**              | Entra ID MFA (built-in)                             | Migrate MFA to Entra ID; decommission RADIUS |
| **SAML IdP**                  | Entra ID SAML/OIDC                                  | Configure Entra ID as IdP                    |
| **Smart card (PIV/CAC)**      | Entra ID certificate-based authentication           | Configure CBA in Entra ID                    |
| **nFactor (multi-step auth)** | Conditional Access (multi-step with auth strengths) | Design CA policies matching nFactor flows    |
| **Client certificate**        | Entra ID CBA + Conditional Access                   | Certificate-based device trust               |
| **Kerberos SSO**              | Entra ID SSO + Kerberos (Azure Files)               | Configure Entra Kerberos for file shares     |
| **OAuth/OIDC**                | Entra ID (native)                                   | Configure app registrations                  |
| **Session policies**          | Conditional Access policies                         | Map session timeout, MFA, device compliance  |

### 3.2 SSL/TLS

| NetScaler feature                  | AVD equivalent                    | Migration action                     |
| ---------------------------------- | --------------------------------- | ------------------------------------ |
| **SSL certificate management**     | Azure-managed (reverse connect)   | No customer certs needed for gateway |
| **SSL offloading**                 | Azure-managed                     | No configuration needed              |
| **TLS 1.2/1.3 enforcement**        | Default (Azure enforces TLS 1.2+) | No action needed                     |
| **HSTS**                           | Azure-managed                     | Enabled by default                   |
| **SSL cipher suite configuration** | Azure-managed                     | Azure uses strong cipher suites      |

### 3.3 Load balancing

| NetScaler feature                 | AVD equivalent                         | Migration action                     |
| --------------------------------- | -------------------------------------- | ------------------------------------ |
| **Gateway load balancing (GSLB)** | Azure Traffic Manager / Front Door     | Configure for multi-region AVD       |
| **StoreFront load balancing**     | Not needed (AVD feed is Azure-managed) | No action                            |
| **VDA load balancing**            | AVD broker (breadth-first/depth-first) | Configure host pool load balancing   |
| **Health monitoring**             | AVD health check (built-in)            | Session host health is automatic     |
| **Content switching**             | Not needed                             | N/A                                  |
| **Persistence (sticky sessions)** | AVD connection broker (automatic)      | Users reconnect to existing sessions |

---

## 4. Network security migration

### 4.1 Firewall rules

**Citrix firewall rules (typical):**

```
# Inbound (DMZ)
ALLOW TCP 443 Internet → NetScaler Gateway
ALLOW TCP 443 NetScaler Gateway → StoreFront
ALLOW TCP 1494,2598 NetScaler → Session Hosts (ICA/CGP)
ALLOW TCP 443 NetScaler → Cloud Connectors (if Citrix Cloud)

# Outbound
ALLOW TCP 443 Cloud Connectors → Citrix Cloud (*.citrixworkspacesapi.net)
```

**AVD firewall rules:**

```bash
# OUTBOUND ONLY (no inbound rules needed)
# Session hosts need outbound access to:

# AVD service endpoints
# *.wvd.microsoft.com (TCP 443)
# *.servicebus.windows.net (TCP 443)
# *.prod.warm.ingest.monitor.core.windows.net (TCP 443)

# Azure infrastructure
# login.microsoftonline.com (TCP 443)
# login.windows.net (TCP 443)
# kms.core.windows.net (TCP 1688)

# Windows Update
# *.windowsupdate.com (TCP 443)
# *.update.microsoft.com (TCP 443)

# RDP Shortpath (if using public network Shortpath)
# STUN/TURN endpoints (UDP 3478, TCP 443)
```

NSG for session host subnet:

```bash
az network nsg rule create \
  --nsg-name nsg-avd-sessionhosts \
  --resource-group rg-avd-prod \
  --name AllowAVDServiceOutbound \
  --priority 100 \
  --direction Outbound \
  --access Allow \
  --protocol Tcp \
  --destination-port-ranges 443 \
  --destination-address-prefixes "WindowsVirtualDesktop" "AzureMonitor" "AzureActiveDirectory"

# Deny all other outbound (optional, for zero-trust)
az network nsg rule create \
  --nsg-name nsg-avd-sessionhosts \
  --resource-group rg-avd-prod \
  --name DenyAllOutbound \
  --priority 4096 \
  --direction Outbound \
  --access Deny \
  --protocol "*" \
  --destination-port-ranges "*" \
  --destination-address-prefixes "*"
```

### 4.2 Private Link for AVD

For organizations requiring all AVD traffic to stay on the Microsoft backbone (no public internet):

```bash
# Create Private Link for AVD host pool
az desktopvirtualization hostpool update \
  --name hp-analytics-prod \
  --resource-group rg-avd-prod \
  --public-network-access Disabled

# Create private endpoint for host pool connection
az network private-endpoint create \
  --name pe-avd-hostpool \
  --resource-group rg-avd-prod \
  --vnet-name vnet-avd-prod \
  --subnet snet-privateendpoints \
  --private-connection-resource-id /subscriptions/.../hostPools/hp-analytics-prod \
  --group-id connection \
  --connection-name pec-avd-connection

# Create private endpoint for workspace feed
az network private-endpoint create \
  --name pe-avd-workspace \
  --resource-group rg-avd-prod \
  --vnet-name vnet-avd-prod \
  --subnet snet-privateendpoints \
  --private-connection-resource-id /subscriptions/.../workspaces/ws-analytics-prod \
  --group-id feed \
  --connection-name pec-avd-feed
```

---

## 5. Network latency optimization

### 5.1 Proximity placement

Deploy session hosts in the Azure region closest to users:

| User location | Recommended Azure region         | Expected RTT |
| ------------- | -------------------------------- | ------------ |
| US East Coast | East US 2                        | 5--15 ms     |
| US West Coast | West US 2 / West US 3            | 5--15 ms     |
| US Central    | Central US / South Central US    | 10--20 ms    |
| US Government | US Gov Virginia / US Gov Arizona | 10--25 ms    |
| Europe        | West Europe / North Europe       | 5--15 ms     |
| Asia Pacific  | Southeast Asia / East Asia       | 10--30 ms    |

### 5.2 Azure Front Door for global users

For organizations with users in multiple geographic regions:

```bash
# Azure Front Door provides global anycast entry points
# Users connect to the nearest Front Door POP
# Front Door routes to the closest AVD region

az afd profile create \
  --profile-name afd-avd-global \
  --resource-group rg-avd-global \
  --sku Premium_AzureFrontDoor

# Note: Front Door integration with AVD requires Private Link
# for backend connectivity to AVD host pools
```

### 5.3 ExpressRoute for enterprise connectivity

For organizations with on-premises data centers or branch offices:

```bash
# ExpressRoute provides private, dedicated connectivity
# Useful for:
# - Branch offices connecting to AVD via private network
# - Hybrid scenarios with on-prem file servers
# - Regulatory requirements for private connectivity

# ExpressRoute circuit (established via provider)
az network express-route create \
  --name er-avd-primary \
  --resource-group rg-avd-networking \
  --location eastus2 \
  --bandwidth 1000 \
  --peering-location "Washington DC" \
  --provider "Equinix"
```

---

## 6. DNS migration

### 6.1 Citrix DNS records to decommission

| Record                   | Purpose                  | Action                 |
| ------------------------ | ------------------------ | ---------------------- |
| `gateway.company.com`    | NetScaler Gateway        | Remove after migration |
| `storefront.company.com` | StoreFront               | Remove after migration |
| `workspace.company.com`  | Citrix Workspace (Cloud) | Remove after migration |
| `*.nsvpx.internal`       | NetScaler internal VIPs  | Remove after migration |

### 6.2 AVD DNS requirements

| Record                            | Purpose                | Type                                   |
| --------------------------------- | ---------------------- | -------------------------------------- |
| `*.wvd.microsoft.com`             | AVD service endpoints  | Azure-managed (no customer DNS)        |
| `rdweb.wvd.microsoft.com`         | AVD web client         | Azure-managed                          |
| `*.file.core.windows.net`         | Azure Files (profiles) | Private DNS zone if using Private Link |
| `*.privatelink.wvd.microsoft.com` | AVD Private Link       | Private DNS zone                       |

### 6.3 Private DNS zones for Private Link

```bash
# Create private DNS zones for AVD Private Link
az network private-dns zone create \
  --name "privatelink.wvd.microsoft.com" \
  --resource-group rg-avd-networking

# Link to AVD VNet
az network private-dns link vnet create \
  --name link-avd-vnet \
  --resource-group rg-avd-networking \
  --zone-name "privatelink.wvd.microsoft.com" \
  --virtual-network vnet-avd-prod \
  --registration-enabled false

# Create private DNS zone for Azure Files
az network private-dns zone create \
  --name "privatelink.file.core.windows.net" \
  --resource-group rg-avd-networking

az network private-dns link vnet create \
  --name link-avd-files \
  --resource-group rg-avd-networking \
  --zone-name "privatelink.file.core.windows.net" \
  --virtual-network vnet-avd-prod \
  --registration-enabled false
```

---

## 7. CSA-in-a-Box network integration

For data analyst AVD desktops accessing CSA-in-a-Box services, configure private endpoints from the AVD subnet to platform services:

```bash
# Private endpoint to Fabric/Synapse
az network private-endpoint create \
  --name pe-avd-fabric \
  --resource-group rg-avd-prod \
  --vnet-name vnet-avd-prod \
  --subnet snet-privateendpoints \
  --private-connection-resource-id /subscriptions/.../workspaces/fabric-analytics \
  --group-id sql

# Private endpoint to Databricks workspace
az network private-endpoint create \
  --name pe-avd-databricks \
  --resource-group rg-avd-prod \
  --vnet-name vnet-avd-prod \
  --subnet snet-privateendpoints \
  --private-connection-resource-id /subscriptions/.../workspaces/dbx-analytics \
  --group-id databricks_ui_api

# Private endpoint to ADLS Gen2
az network private-endpoint create \
  --name pe-avd-adls \
  --resource-group rg-avd-prod \
  --vnet-name vnet-avd-prod \
  --subnet snet-privateendpoints \
  --private-connection-resource-id /subscriptions/.../storageAccounts/adlsanalytics \
  --group-id dfs
```

This ensures data analyst sessions communicate with platform services over the Azure backbone, not the public internet.

---

## 8. NetScaler decommission checklist

After all users have migrated to AVD:

- [ ] Verify zero active sessions on NetScaler Gateway
- [ ] Export NetScaler configuration for audit trail (`save ns config; show ns config`)
- [ ] Archive SSL certificates (may be needed for other services)
- [ ] Remove NetScaler VPX VMs from Azure
- [ ] Remove NetScaler DNS records
- [ ] Cancel NetScaler/ADC license subscriptions
- [ ] Update firewall rules to remove inbound 443 to former Gateway IPs
- [ ] Remove StoreFront servers (if still running)
- [ ] Update network documentation

---

**Maintainers:** CSA-in-a-Box core team
**Last updated:** 2026-04-30
