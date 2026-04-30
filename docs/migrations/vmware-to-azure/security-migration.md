# Security Migration -- vSphere Security to Azure Security

**Complete guide to migrating VMware vSphere security controls to Azure-native security services including Defender for Cloud, NSG, Entra ID, Azure Policy, and Microsoft Sentinel.**

---

## Security mapping overview

| VMware security domain                   | Azure equivalent               | Service(s)                                      |
| ---------------------------------------- | ------------------------------ | ----------------------------------------------- |
| **vSphere SSO / vCenter authentication** | Identity and access management | Entra ID (Azure AD) + Entra ID PIM              |
| **vCenter RBAC roles**                   | Role-based access control      | Azure RBAC + custom roles                       |
| **NSX micro-segmentation**               | Network security               | NSG + ASG + Azure Firewall                      |
| **VM encryption (vSphere)**              | Data-at-rest encryption        | Azure Disk Encryption / SSE                     |
| **vSphere Secure Boot / vTPM**           | Trusted compute                | Azure Trusted Launch + vTPM                     |
| **Carbon Black / AppDefense**            | Endpoint protection            | Microsoft Defender for Endpoint                 |
| **VMware Aria Operations (security)**    | Security posture management    | Microsoft Defender for Cloud                    |
| **vCenter audit logging**                | Security monitoring            | Microsoft Sentinel + Azure Monitor              |
| **NSX IDS/IPS**                          | Intrusion detection            | Azure Firewall Premium IDPS                     |
| **vSphere certificate management**       | Certificate management         | Azure Key Vault                                 |
| **VMware SRM (DR security)**             | DR security controls           | Azure Site Recovery + Azure Policy              |
| **vSphere content verification**         | Image integrity                | Azure Compute Gallery + Defender for Containers |

---

## 1. Identity and access management

### vSphere SSO to Entra ID

| vSphere SSO concept              | Entra ID equivalent         | Migration approach                             |
| -------------------------------- | --------------------------- | ---------------------------------------------- |
| SSO domain (vsphere.local)       | Entra ID tenant             | Map to existing Entra ID tenant                |
| SSO users                        | Entra ID users              | Sync via Entra ID Connect or create directly   |
| SSO groups                       | Entra ID groups             | Map vSphere groups to Entra ID security groups |
| Identity sources (AD/LDAP)       | Entra ID Connect (hybrid)   | Existing AD syncs to Entra ID                  |
| SSO policies (password, lockout) | Entra ID conditional access | Stronger policy options in Entra ID            |
| Two-factor authentication        | Entra ID MFA                | Microsoft Authenticator, FIDO2, phone          |

### vCenter RBAC to Azure RBAC

| vSphere role               | Azure built-in role                | Scope                                       |
| -------------------------- | ---------------------------------- | ------------------------------------------- |
| Administrator              | Owner                              | Subscription / resource group               |
| Read-Only                  | Reader                             | Subscription / resource group               |
| Virtual Machine Power User | Virtual Machine Contributor        | Resource group                              |
| Network Administrator      | Network Contributor                | Resource group                              |
| Datastore Consumer         | Storage Account Contributor        | Resource group                              |
| No Access                  | No role assignment (implicit deny) | Default in Azure (no access unless granted) |

```bash
# Assign Azure RBAC role to a user
az role assignment create \
  --assignee user@contoso.com \
  --role "Virtual Machine Contributor" \
  --scope /subscriptions/{sub}/resourceGroups/rg-migrated-vms

# Create custom role for AVS administrators
az role definition create --role-definition '{
  "Name": "AVS Administrator",
  "Description": "Manage AVS private clouds and VMs",
  "Actions": [
    "Microsoft.AVS/*",
    "Microsoft.Network/virtualNetworks/read",
    "Microsoft.Compute/virtualMachines/read"
  ],
  "NotActions": [],
  "AssignableScopes": ["/subscriptions/{sub}"]
}'
```

### Privileged Identity Management (PIM)

For administrative access that was permanently assigned in vSphere, use Entra ID PIM for just-in-time access:

```
vSphere: User has permanent Administrator role on vCenter
Azure:   User has eligible Owner role, must activate via PIM with:
         - Justification required
         - MFA verification
         - Maximum 8-hour activation window
         - Approval workflow (optional)
         - Audit trail
```

---

## 2. Network security (NSX to Azure)

### NSX micro-segmentation to NSG + ASG

See [Networking Migration](networking-migration.md) for detailed NSX DFW to NSG rule mapping.

Key security improvements in the Azure model:

| NSX security feature            | Azure equivalent                    | Azure advantage                                     |
| ------------------------------- | ----------------------------------- | --------------------------------------------------- |
| Distributed Firewall            | NSG (subnet/NIC-level)              | Deeper integration with Azure platform              |
| Gateway Firewall                | Azure Firewall Premium              | Managed service, built-in IDPS with 67K+ signatures |
| NSX IDS/IPS                     | Azure Firewall Premium IDPS         | Signature-based + TLS inspection                    |
| NSX URL filtering               | Azure Firewall URL filtering        | Category-based + custom                             |
| Service Insertion (third-party) | NVA + UDR or Azure Firewall Manager | Centralized policy management                       |

### Azure Firewall Premium for IDPS

```bash
# Enable IDPS on Azure Firewall Premium
az network firewall policy create \
  --name fw-policy-prod \
  --resource-group rg-network \
  --location eastus2 \
  --sku Premium \
  --idps-mode Deny

# Configure TLS inspection
az network firewall policy update \
  --name fw-policy-prod \
  --resource-group rg-network \
  --key-vault-secret-id https://kv-certs.vault.azure.net/secrets/fw-tls-cert \
  --transport-security-certificate-authority /subscriptions/{sub}/resourceGroups/rg-network/providers/Microsoft.Network/firewallPolicies/fw-policy-prod/certificateAuthority/default
```

---

## 3. Endpoint protection

### Carbon Black / AppDefense to Microsoft Defender for Endpoint

| VMware security tool             | Microsoft equivalent                               | Capability                                   |
| -------------------------------- | -------------------------------------------------- | -------------------------------------------- |
| Carbon Black Cloud               | Microsoft Defender for Endpoint                    | EDR, next-gen AV, attack surface reduction   |
| AppDefense                       | Defender for Cloud (adaptive application controls) | Application whitelisting                     |
| Carbon Black Audit & Remediation | Defender for Endpoint live response                | Remote investigation and remediation         |
| Carbon Black Container Security  | Defender for Containers                            | Container image scanning, runtime protection |

### Enable Defender for Cloud

```bash
# Enable Defender for Cloud (subscription level)
az security pricing create \
  --name VirtualMachines \
  --tier Standard

# Enable specific Defender plans
az security pricing create --name SqlServers --tier Standard
az security pricing create --name AppServices --tier Standard
az security pricing create --name StorageAccounts --tier Standard
az security pricing create --name KeyVaults --tier Standard
az security pricing create --name Dns --tier Standard
az security pricing create --name Containers --tier Standard
```

### Defender for Cloud security posture

Defender for Cloud provides a Secure Score that measures your security posture:

- **Recommendations**: prioritized security findings with remediation steps
- **Regulatory compliance**: built-in compliance dashboards for NIST 800-53, CIS, PCI-DSS
- **Attack path analysis**: identifies paths an attacker could use to reach critical resources
- **Cloud security graph**: queries relationships between resources to find risks

---

## 4. Data encryption

### VM disk encryption

| VMware encryption                    | Azure encryption                                        | Notes                         |
| ------------------------------------ | ------------------------------------------------------- | ----------------------------- |
| vSphere VM Encryption (vCenter KMS)  | Azure Disk Encryption (ADE) with BitLocker/DM-Crypt     | Guest-level encryption        |
| vSphere VM Encryption (policy-based) | Server-Side Encryption (SSE) with platform-managed keys | Default on all Managed Disks  |
| vSAN encryption (at-rest)            | SSE with customer-managed keys (CMK)                    | Key Vault integration         |
| vSphere encryption in transit        | TLS 1.2+ for all Azure service communication            | Default, enforced             |
| vTPM (key sealing)                   | Azure Trusted Launch vTPM                               | Secure boot and measured boot |

### Azure Disk Encryption with Key Vault

```bash
# Create Key Vault for disk encryption keys
az keyvault create \
  --name kv-diskenc-eastus2 \
  --resource-group rg-security \
  --location eastus2 \
  --enabled-for-disk-encryption true

# Enable Azure Disk Encryption on a VM
az vm encryption enable \
  --name migrated-vm-01 \
  --resource-group rg-migrated-vms \
  --disk-encryption-keyvault kv-diskenc-eastus2 \
  --volume-type All
```

### Server-Side Encryption with CMK

```bash
# Create disk encryption set with customer-managed key
az disk-encryption-set create \
  --name des-cmk-prod \
  --resource-group rg-security \
  --location eastus2 \
  --source-vault /subscriptions/{sub}/resourceGroups/rg-security/providers/Microsoft.KeyVault/vaults/kv-diskenc-eastus2 \
  --key-url https://kv-diskenc-eastus2.vault.azure.net/keys/disk-enc-key/version

# Apply to existing disks
az disk update \
  --name disk-vm01-os \
  --resource-group rg-migrated-vms \
  --disk-encryption-set des-cmk-prod
```

---

## 5. Security monitoring and SIEM

### vCenter audit logging to Microsoft Sentinel

| VMware logging source | Azure destination       | Connector                    |
| --------------------- | ----------------------- | ---------------------------- |
| vCenter events        | Microsoft Sentinel      | VMware vCenter connector     |
| ESXi syslog           | Log Analytics workspace | Syslog connector             |
| NSX-T firewall logs   | Log Analytics           | NSX syslog forwarding        |
| AVS platform logs     | Azure Monitor           | Built-in diagnostic settings |
| VM guest OS logs      | Log Analytics           | Azure Monitor Agent (AMA)    |

### Deploy Microsoft Sentinel

```bash
# Create Log Analytics workspace
az monitor log-analytics workspace create \
  --name law-sentinel-eastus2 \
  --resource-group rg-security \
  --location eastus2 \
  --retention-time 90

# Enable Sentinel on the workspace
az sentinel onboarding-state create \
  --resource-group rg-security \
  --workspace-name law-sentinel-eastus2 \
  --name default
```

### Sentinel for AVS monitoring

Microsoft Sentinel provides specific detectors for AVS environments:

- **Suspicious vCenter login**: unusual authentication patterns
- **VM snapshot creation**: potential data exfiltration indicator
- **NSX firewall rule changes**: unauthorized security policy modifications
- **AVS management operations**: host additions, cluster changes
- **ExpressRoute configuration changes**: network security boundary changes

### Azure Policy for security compliance

```bash
# Assign built-in policy initiative (NIST 800-53 Rev 5)
az policy assignment create \
  --name nist-800-53-r5 \
  --scope /subscriptions/{sub} \
  --policy-set-definition "/providers/Microsoft.Authorization/policySetDefinitions/179d1daa-458f-4e47-8086-2a68d0d6c38f"

# Assign policy to enforce disk encryption
az policy assignment create \
  --name require-disk-encryption \
  --scope /subscriptions/{sub} \
  --policy "/providers/Microsoft.Authorization/policyDefinitions/0961003e-5a0a-4549-abde-af6a37f2724d"
```

---

## 6. Trusted compute

### vSphere Secure Boot to Azure Trusted Launch

| vSphere feature      | Azure Trusted Launch feature                     |
| -------------------- | ------------------------------------------------ |
| UEFI Secure Boot     | Secure Boot (prevents boot-level malware)        |
| vTPM 2.0             | vTPM 2.0 (BitLocker, measured boot attestation)  |
| vSGX (Intel SGX)     | Azure Confidential VMs (DCsv3, DCdsv3)           |
| Integrity monitoring | Boot integrity monitoring via Defender for Cloud |

```bash
# Create VM with Trusted Launch
az vm create \
  --name vm-trusted-01 \
  --resource-group rg-migrated-vms \
  --location eastus2 \
  --image Win2022Datacenter \
  --security-type TrustedLaunch \
  --enable-secure-boot true \
  --enable-vtpm true \
  --size Standard_D4s_v5
```

---

## 7. Federal security considerations

For federal migrations, security controls must align with compliance frameworks:

| Framework             | Key security requirements                  | Azure implementation                     |
| --------------------- | ------------------------------------------ | ---------------------------------------- |
| **FedRAMP High**      | AC, AU, IA, SC control families            | Entra ID, Azure Monitor, encryption, NSG |
| **NIST 800-53 Rev 5** | 1,100+ controls across 20 families         | Azure Policy NIST 800-53 initiative      |
| **CMMC 2.0 Level 2**  | 110 practices                              | Defender for Cloud CMMC dashboard        |
| **IL4/IL5**           | Data residency, access control, encryption | Azure Government + encryption + RBAC     |

CSA-in-a-Box provides machine-readable compliance mappings at:

- `csa_platform/csa_platform/governance/compliance/nist-800-53-rev5.yaml`
- `csa_platform/csa_platform/governance/compliance/cmmc-2.0-l2.yaml`

See the [Federal Migration Guide](federal-migration-guide.md) for detailed compliance guidance.

---

## Related

- [Networking Migration](networking-migration.md)
- [AVS Migration Guide](avs-migration.md)
- [Azure IaaS Migration Guide](azure-iaas-migration.md)
- [Federal Migration Guide](federal-migration-guide.md)
- [Feature Mapping](feature-mapping-complete.md)
- [Migration Playbook](../vmware-to-azure.md)

---

**Last updated:** 2026-04-30
**Maintainers:** CSA-in-a-Box core team
