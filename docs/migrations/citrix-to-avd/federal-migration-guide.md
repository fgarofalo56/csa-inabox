# Federal Migration Guide: Citrix to AVD in Azure Government

**Audience:** Federal CIO, CISO, AO (Authorizing Official), VDI Engineers in government environments
**Scope:** AVD deployment in Azure Government for IL2--IL5 workloads, FedRAMP High inheritance, FIPS 140-2 endpoints, smart card (PIV/CAC) authentication, DoD VDI requirements, and screen capture protection.
**Last updated:** 2026-04-30

---

## Overview

Federal agencies and DoD components running Citrix Virtual Apps and Desktops face the same licensing cost pressures as commercial enterprises, compounded by additional compliance requirements. Azure Virtual Desktop on Azure Government provides a FedRAMP High-authorized VDI service with native support for PIV/CAC smart cards, FIPS 140-2 validated cryptographic modules, and screen capture protection -- capabilities that are either unavailable or require significant additional configuration on Citrix.

---

## 1. Azure Government AVD availability

### 1.1 Region availability

| Azure Government region | AVD available | IL coverage                 |
| ----------------------- | ------------- | --------------------------- |
| US Gov Virginia         | Yes           | IL2, IL4, IL5               |
| US Gov Arizona          | Yes           | IL2, IL4, IL5               |
| US Gov Texas            | Yes           | IL2, IL4, IL5               |
| US DoD Central          | Yes           | IL2, IL4, IL5, IL6 (select) |
| US DoD East             | Yes           | IL2, IL4, IL5, IL6 (select) |

### 1.2 Service endpoints

AVD on Azure Government uses government-specific endpoints:

| Service           | Commercial endpoint         | Azure Government endpoint       |
| ----------------- | --------------------------- | ------------------------------- |
| AVD control plane | `*.wvd.microsoft.com`       | `*.wvd.microsoft.us`            |
| AVD web client    | `client.wvd.microsoft.com`  | `client.wvd.microsoft.us`       |
| Entra ID          | `login.microsoftonline.com` | `login.microsoftonline.us`      |
| Azure AD Graph    | `graph.windows.net`         | `graph.windows.net`             |
| Key Vault         | `*.vault.azure.net`         | `*.vault.usgovcloudapi.net`     |
| Storage           | `*.file.core.windows.net`   | `*.file.core.usgovcloudapi.net` |

### 1.3 Feature parity

Most AVD features are available in Azure Government. Notable differences:

| Feature                   | Commercial | Azure Government | Notes                   |
| ------------------------- | ---------- | ---------------- | ----------------------- |
| AVD Insights              | GA         | GA               | Full parity             |
| Scaling plans             | GA         | GA               | Full parity             |
| MSIX app attach           | GA         | GA               | Full parity             |
| RDP Shortpath (managed)   | GA         | GA               | Full parity             |
| RDP Shortpath (public)    | GA         | GA               | Full parity             |
| Screen capture protection | GA         | GA               | Full parity             |
| Watermarking              | GA         | GA               | Full parity             |
| Private Link              | GA         | GA               | Full parity             |
| Start VM on Connect       | GA         | GA               | Full parity             |
| Multimedia redirection    | GA         | Preview          | Check current status    |
| Azure AD joined hosts     | GA         | GA               | Entra ID join supported |
| Intune management         | GA         | GA (GCC-High)    | Intune for Government   |

---

## 2. Compliance framework mapping

### 2.1 FedRAMP High

AVD inherits the Azure Government FedRAMP High authorization. The authorization boundary includes:

- **AVD control plane:** broker, gateway, diagnostics, connection orchestration
- **Azure Compute:** session host VMs
- **Azure Storage:** Azure Files for FSLogix profiles
- **Azure Networking:** VNets, NSGs, Private Link
- **Azure Monitor:** diagnostics, Log Analytics
- **Entra ID:** authentication, Conditional Access, MFA

**Customer responsibility:**

| Control family                           | Customer action                                         |
| ---------------------------------------- | ------------------------------------------------------- |
| **AC (Access Control)**                  | Configure Conditional Access, MFA, session timeouts     |
| **AU (Audit)**                           | Enable diagnostic settings, retain logs per NIST 800-53 |
| **CM (Configuration Management)**        | Use Intune security baselines, golden image hardening   |
| **IA (Identification & Authentication)** | Configure PIV/CAC, certificate-based auth               |
| **SC (System Communications)**           | Enable TLS, FIPS mode, Private Link                     |
| **SI (System Information Integrity)**    | Enable Defender for Endpoint, patch management          |

### 2.2 NIST 800-53 Rev 5 controls for VDI

| Control      | Requirement                       | AVD implementation                                |
| ------------ | --------------------------------- | ------------------------------------------------- |
| **AC-2**     | Account management                | Entra ID user lifecycle, Conditional Access       |
| **AC-3**     | Access enforcement                | Application group RBAC, Conditional Access        |
| **AC-7**     | Unsuccessful logon attempts       | Entra ID Smart Lockout                            |
| **AC-8**     | System use notification           | Custom RDP property: `use banner:i:1`             |
| **AC-11**    | Session lock                      | GPO screen lock timeout                           |
| **AC-12**    | Session termination               | Scaling plan disconnect/logoff timers             |
| **AC-17**    | Remote access                     | AVD reverse connect (no VPN required)             |
| **AU-2**     | Audit events                      | AVD diagnostics to Log Analytics                  |
| **AU-3**     | Content of audit records          | WVDConnections, WVDCheckpoints tables             |
| **AU-6**     | Audit review                      | AVD Insights workbooks, custom alerts             |
| **IA-2**     | Multi-factor authentication       | Entra ID MFA (push, FIDO2, PIV/CAC)               |
| **IA-2(12)** | PIV-compliant authentication      | Entra ID certificate-based authentication         |
| **SC-8**     | Transmission confidentiality      | TLS 1.2/1.3 for all connections                   |
| **SC-13**    | Cryptographic protection          | FIPS 140-2 validated modules (Windows FIPS mode)  |
| **SC-28**    | Protection of information at rest | BitLocker on session hosts, encrypted Azure Files |

### 2.3 DoD IL4/IL5

For DoD workloads at IL4 and IL5:

**IL4 requirements met by AVD on Azure Government:**

- Data residency within the United States
- Background-investigated Microsoft personnel
- Azure Government FedRAMP High authorization
- Logical separation from commercial Azure

**IL5 additional requirements met by AVD on Azure Government:**

- Dedicated DoD regions (DoD Central, DoD East) for IL5 workloads
- National security-cleared personnel for data center operations
- Dedicated physical infrastructure
- Additional network isolation

```bash
# Deploy AVD for IL5 in DoD region
az desktopvirtualization hostpool create \
  --name hp-dod-il5 \
  --resource-group rg-avd-dod \
  --location usdodcentral \
  --host-pool-type Pooled \
  --load-balancer-type BreadthFirst \
  --max-session-limit 10
```

---

## 3. Smart card authentication (PIV/CAC)

### 3.1 Architecture

Federal users authenticate with PIV (Personal Identity Verification) or CAC (Common Access Card) smart cards. AVD supports this through Entra ID certificate-based authentication (CBA).

```
User with PIV/CAC → Remote Desktop Client
  → Entra ID Certificate-Based Authentication
  → Certificate validation against Entra ID CBA policy
  → AVD session established
  → Smart card redirected into session for in-session auth
```

### 3.2 Configure Entra ID certificate-based authentication

```bash
# Step 1: Upload CA certificates to Entra ID
# Navigate to: Entra ID > Security > Certificate Authorities
# Upload the DoD Root CA certificates:
# - DoD Root CA 3
# - DoD Root CA 4
# - DoD Root CA 5
# - DoD Root CA 6
# And intermediate CAs as needed

# Step 2: Enable CBA in Entra ID
# Navigate to: Entra ID > Security > Authentication Methods > Certificate-based authentication
# Enable for target users/groups
# Configure certificate-to-user binding:
# - Binding: PrincipalName (UPN) maps to certificate SAN:UPN
# - Affinity: High affinity (certificate issuer + serial number)
```

### 3.3 Configure smart card redirection in AVD

```bash
# RDP property for smart card redirection
az desktopvirtualization hostpool update \
  --name hp-dod-il5 \
  --resource-group rg-avd-dod \
  --custom-rdp-property "redirectsmartcards:i:1;enablerdsaadauth:i:1;use redirection server name:i:1"
```

### 3.4 Session host configuration for smart card

```powershell
# Ensure smart card service is running
Set-Service -Name "SCardSvr" -StartupType Automatic
Start-Service -Name "SCardSvr"

# Enable smart card logon via GPO or Intune
# Computer Configuration > Windows Settings > Security Settings > Local Policies > Security Options
# "Interactive logon: Require smart card" = Enabled (if requiring PIV/CAC for all logons)
# "Interactive logon: Smart card removal behavior" = Lock Workstation
```

---

## 4. FIPS 140-2 compliance

### 4.1 Enable FIPS mode on session hosts

```powershell
# Enable FIPS 140-2 validated cryptographic algorithms
$fipsKey = "HKLM:\SYSTEM\CurrentControlSet\Control\Lsa\FIPSAlgorithmPolicy"
Set-ItemProperty -Path $fipsKey -Name "Enabled" -Value 1 -Type DWord

# Verify FIPS mode is active after reboot
# Check: System event log for "FIPS validated algorithm" entries
```

### 4.2 FIPS considerations

| Component               | FIPS support | Notes                                   |
| ----------------------- | ------------ | --------------------------------------- |
| Windows OS (FIPS mode)  | Yes          | Enables FIPS-validated crypto modules   |
| RDP protocol (TLS 1.2)  | Yes          | TLS with FIPS-approved cipher suites    |
| FSLogix (VHDx)          | Yes          | VHDx uses NTFS encryption (optional)    |
| Azure Files (SMB)       | Yes          | SMB 3.1.1 with FIPS-approved encryption |
| Entra ID authentication | Yes          | FIPS-compliant authentication flow      |
| BitLocker (OS disk)     | Yes          | FIPS-validated encryption module        |

---

## 5. Screen capture protection

### 5.1 Enable screen capture protection

Screen capture protection prevents screenshots, screen recording, and screen sharing of AVD session content. This is critical for classified and CUI (Controlled Unclassified Information) workloads.

```bash
# Enable screen capture protection on host pool
az desktopvirtualization hostpool update \
  --name hp-dod-il5 \
  --resource-group rg-avd-dod \
  --custom-rdp-property "screen capture protection:i:2"
  # 0 = disabled
  # 1 = block screen capture (apps see black screen)
  # 2 = block screen capture + hide from screen sharing
```

### 5.2 Comparison with Citrix App Protection

| Capability              | AVD screen capture protection       | Citrix App Protection    |
| ----------------------- | ----------------------------------- | ------------------------ |
| Block screenshots       | Yes                                 | Yes                      |
| Block screen recording  | Yes                                 | Yes                      |
| Block screen sharing    | Yes (level 2)                       | Yes                      |
| Anti-keylogging         | No                                  | Yes                      |
| Client-side enforcement | Yes                                 | Yes                      |
| Watermarking            | Separate feature (AVD watermarking) | Included                 |
| Licensing               | Included in AVD                     | $2--$4/user/month add-on |

### 5.3 Enable watermarking

```bash
# Enable watermarking for session identification
# Shows user identity information as a watermark on the session
az desktopvirtualization hostpool update \
  --name hp-dod-il5 \
  --resource-group rg-avd-dod \
  --custom-rdp-property "screen capture protection:i:2;use watermarking:i:1;watermarking opacity:i:2000;watermarking width:i:320;watermarking height:i:180"
```

---

## 6. DoD-specific VDI requirements

### 6.1 STIG compliance

Apply Defense Information Systems Agency (DISA) STIGs to AVD session hosts:

```powershell
# Download and apply Windows 11 STIG
# Available from: https://public.cyber.mil/stigs/

# Key STIG settings for VDI session hosts:
# V-253261: Session timeout (15 minutes idle)
# V-253262: Session lock (smart card removal)
# V-253263: Audit policy configuration
# V-253264: BitLocker encryption
# V-253265: Windows Defender configuration
# V-253266: Credential Guard

# Apply via Intune security baselines or GPO
# Intune > Endpoint Security > Security Baselines > Windows 11
```

### 6.2 Conditional Access for DoD

```
Policy 1: Require MFA/PIV for AVD access
- Assignments: All DoD users
- Cloud apps: Azure Virtual Desktop, Microsoft Remote Desktop
- Conditions: All platforms
- Grant: Require MFA or certificate-based authentication
- Session: Sign-in frequency 8 hours

Policy 2: Require compliant device
- Assignments: All DoD users
- Cloud apps: Azure Virtual Desktop
- Conditions: All platforms
- Grant: Require device compliance (Intune)
- Session: Persistent browser session disabled

Policy 3: Block access from untrusted locations
- Assignments: All DoD users
- Cloud apps: Azure Virtual Desktop
- Conditions: Locations NOT in trusted list (DoD networks, VPN endpoints)
- Grant: Block access

Policy 4: Restrict client apps
- Assignments: IL5 users
- Cloud apps: Azure Virtual Desktop
- Conditions: Client apps = Browser, Mobile apps and desktop clients
- Grant: Require approved client app
```

### 6.3 Network isolation for DoD

```bash
# Deploy AVD in isolated VNet for DoD workloads
az network vnet create \
  --name vnet-avd-dod-il5 \
  --resource-group rg-avd-dod \
  --location usdodcentral \
  --address-prefix 10.200.0.0/16

# Session host subnet (no internet access)
az network vnet subnet create \
  --name snet-sessionhosts-il5 \
  --vnet-name vnet-avd-dod-il5 \
  --resource-group rg-avd-dod \
  --address-prefix 10.200.1.0/24

# Use Azure Firewall or NVA for controlled egress
# Only allow: AVD service endpoints, KMS, Windows Update (WSUS proxy)
# Block: all direct internet access

# Enable Private Link for AVD
az desktopvirtualization hostpool update \
  --name hp-dod-il5 \
  --resource-group rg-avd-dod \
  --public-network-access Disabled
```

---

## 7. Compliance evidence and audit trail

### 7.1 Audit data for ATO package

| Evidence requirement             | AVD data source                      | Retention                                  |
| -------------------------------- | ------------------------------------ | ------------------------------------------ |
| User authentication events       | Entra ID sign-in logs                | 30 days (Entra) + archive to Log Analytics |
| Session connection/disconnection | WVDConnections table (Log Analytics) | 90 days (configurable)                     |
| Administrative actions           | Azure Activity Log                   | 90 days + archive to Storage Account       |
| Host health status               | WVDAgentHealthStatus table           | 90 days (configurable)                     |
| Configuration changes            | Azure Activity Log + Resource Graph  | 90 days + archive                          |
| Conditional Access evaluation    | Entra ID CA logs                     | 30 days + archive                          |
| Endpoint compliance              | Intune device compliance logs        | 30 days + archive                          |

### 7.2 Long-term log retention

```bash
# Archive logs to storage account for long-term retention (7 years for federal)
az monitor diagnostic-settings create \
  --name diag-avd-archive \
  --resource /subscriptions/.../hostPools/hp-dod-il5 \
  --storage-account /subscriptions/.../storageAccounts/stauditarchive \
  --logs '[
    {"category": "Connection", "enabled": true, "retentionPolicy": {"enabled": true, "days": 2555}},
    {"category": "Error", "enabled": true, "retentionPolicy": {"enabled": true, "days": 2555}},
    {"category": "Management", "enabled": true, "retentionPolicy": {"enabled": true, "days": 2555}},
    {"category": "Checkpoint", "enabled": true, "retentionPolicy": {"enabled": true, "days": 2555}}
  ]'
```

---

## 8. Migration considerations for federal Citrix environments

### 8.1 Citrix on SIPRNet

Citrix environments running on classified networks (SIPRNet) cannot be directly migrated to Azure Government (IL5). Options:

- **IL5 on Azure Government:** for CUI and IL5-eligible workloads
- **Azure Government Top Secret (IL6):** available through Microsoft-operated IL6 regions (contact Microsoft Federal for access)
- **Keep on-premises:** classified workloads that cannot move to cloud

### 8.2 Citrix Federal Cloud (Citrix Cloud Government)

Organizations currently using Citrix Cloud Government can migrate to AVD on Azure Government. The migration path is the same as commercial Citrix-to-AVD, with Azure Government endpoints.

### 8.3 Procurement

AVD does not require a separate procurement action if the agency already has:

- Microsoft 365 E3/E5 (or G3/G5 for government)
- Azure Government subscription

The AVD service, Windows multi-session licensing, and FSLogix are all included. Only Azure compute and storage consumption require ongoing procurement.

---

## 9. CSA-in-a-Box federal data analyst pattern

For federal data analysts accessing CSA-in-a-Box services (Fabric, Databricks, Power BI) from AVD:

- **Session hosts in DoD region** with Private Link to data services
- **PIV/CAC authentication** for both AVD session and data service access
- **Conditional Access** restricting data access to compliant AVD sessions only
- **Screen capture protection** preventing data exfiltration via screenshots
- **Watermarking** for visual accountability
- **FSLogix** preserving analyst configurations and cached data
- **Intune compliance** ensuring endpoint security baselines

This pattern provides the highest-security virtual workstation for federal data work, combining physical security (Azure Government data centers), logical security (Conditional Access, PIV/CAC), and operational security (screen capture protection, watermarking, audit logging).

---

**Maintainers:** CSA-in-a-Box core team
**Last updated:** 2026-04-30
