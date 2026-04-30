# Migrating from On-Premises Active Directory to Microsoft Entra ID

**Status:** Authored 2026-04-30
**Audience:** Federal CIO / CISO / Identity Architect / IT Administrator managing on-premises Active Directory infrastructure and planning migration to cloud-native identity with Microsoft Entra ID.
**Scope:** The on-premises Active Directory estate: domain controllers, AD FS, AD CS, Group Policy, LDAP applications, Kerberos-dependent services, domain-joined devices, and the full identity lifecycle. Ancillary services (DNS, DHCP, DFS, RADIUS, NPS) are addressed where they touch identity.

---

!!! tip "Expanded Migration Center Available"
This playbook is the core migration reference. For the complete AD-to-Entra-ID migration package --- including white papers, deep-dive guides, tutorials, benchmarks, and federal-specific guidance --- visit the **[AD to Entra ID Migration Center](ad-to-entra-id/index.md)**.

    **Quick links:**

    - [Why Entra ID over Active Directory (Executive Brief)](ad-to-entra-id/why-entra-over-ad.md)
    - [Total Cost of Ownership Analysis](ad-to-entra-id/tco-analysis.md)
    - [Complete Feature Mapping (50+ features)](ad-to-entra-id/feature-mapping-complete.md)
    - [Federal Migration Guide](ad-to-entra-id/federal-migration-guide.md)
    - [Tutorials & Walkthroughs](ad-to-entra-id/index.md#tutorials)
    - [Benchmarks & Performance](ad-to-entra-id/benchmarks.md)
    - [Best Practices](ad-to-entra-id/best-practices.md)

## 1. Executive summary

Identity is the Zero Trust control plane. Every enterprise runs Active Directory --- Microsoft estimates over 90% of Fortune 1000 organizations depend on AD for authentication and authorization. Federal Executive Order 14028 mandates cloud-native identity, CISA's Zero Trust Maturity Model places identity at the foundation, and Microsoft's hard-match hardening enforcement dates of June--July 2026 create a forcing function for every organization still running hybrid identity in legacy configurations.

CSA-in-a-Box on Azure uses **Microsoft Entra ID** as the identity provider for every service in the platform --- Fabric workspaces, Databricks SCIM provisioning, Purview access policies, Azure OpenAI RBAC, Power BI row-level security, and Azure Monitor diagnostic access. Migrating from on-premises AD to Entra ID is not optional for CSA-in-a-Box adoption; it is foundational.

This playbook is practical. Active Directory has been the enterprise identity backbone for 25 years. The migration is not a weekend project --- it is a phased program that typically runs 6--18 months depending on application portfolio complexity, device fleet size, and Group Policy density. The guidance here is honest about what works, what breaks, and what requires application remediation before identity cutover.

### Federal considerations --- on-premises AD vs Entra ID

| Consideration                    | On-premises AD today                                               | Entra ID on Azure                                       | Notes                                                         |
| -------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------- | ------------------------------------------------------------- |
| EO 14028 compliance              | **Gap** --- on-prem AD does not meet cloud-native identity mandate | Compliant                                               | Federal mandate                                               |
| Zero Trust architecture          | Requires bolt-on solutions (AD FS + MFA server)                    | Native --- Conditional Access, Identity Protection, PIM | CISA ZTMM pillar 1                                            |
| FedRAMP High                     | Customer-managed; no inheritance                                   | Inherited through Azure Government / M365 GCC High      | Platform-level                                                |
| PIV/CAC authentication           | AD CS + third-party middleware                                     | Native Entra CBA with PIV/CAC                           | FIPS 201-3                                                    |
| Passwordless                     | Limited (Windows Hello for Business on-prem is complex)            | FIDO2, Windows Hello, Microsoft Authenticator, CBA      | Phishing-resistant MFA                                        |
| Domain controller infrastructure | 2--6+ DCs per site, hardware lifecycle, patching                   | Eliminated (Entra ID is SaaS)                           | OpEx reduction                                                |
| LAPS                             | Microsoft LAPS (legacy)                                            | Windows LAPS with Entra ID backup                       | Cloud-native                                                  |
| Group Policy                     | Full GPO estate                                                    | Intune configuration profiles + compliance policies     | See [GPO Migration](ad-to-entra-id/group-policy-migration.md) |
| Hard-match hardening             | **Enforcement June/July 2026**                                     | Native                                                  | Breaking change for legacy sync                               |

---

## 2. Decision matrix --- migration strategy

The first architectural decision is the target identity state. Three paths exist; most enterprises traverse at least two of them sequentially.

| Strategy                  | When to use                                                                        | Timeline                | Complexity  | Target for CSA-in-a-Box |
| ------------------------- | ---------------------------------------------------------------------------------- | ----------------------- | ----------- | ----------------------- |
| **Hybrid Join (interim)** | Large device fleets, legacy apps requiring Kerberos, AD-dependent LOB applications | 3--6 months to deploy   | Medium      | Interim only            |
| **Entra Join (target)**   | New devices, Autopilot-provisioned fleet, cloud-first applications                 | 6--12 months full fleet | Medium-High | **Primary target**      |
| **Cloud-only (final)**    | Full decommission of on-prem AD, all apps modernized, no Kerberos dependency       | 12--18+ months          | High        | **Ultimate goal**       |

### Recommended progression

```mermaid
flowchart LR
    A[On-Prem AD Only] --> B[Hybrid Identity\nEntra Connect/Cloud Sync]
    B --> C[Hybrid Joined Devices\nDual auth capability]
    C --> D[Entra Joined Devices\nIntune managed]
    D --> E[Cloud-Only Identity\nAD decommissioned]

    style A fill:#d32f2f,color:#fff
    style B fill:#f57c00,color:#fff
    style C fill:#fbc02d,color:#000
    style D fill:#388e3c,color:#fff
    style E fill:#1565c0,color:#fff
```

---

## 3. Capability mapping --- AD to Entra ID

This section maps the core AD capabilities to their Entra ID equivalents. The [Complete Feature Mapping](ad-to-entra-id/feature-mapping-complete.md) covers 50+ features in detail.

### 3.1 Authentication

| AD capability           | Entra ID equivalent                       | Migration complexity | Notes                                                                  |
| ----------------------- | ----------------------------------------- | -------------------- | ---------------------------------------------------------------------- |
| Kerberos authentication | OAuth 2.0 / OIDC + Kerberos cloud trust   | Medium               | Cloud trust eliminates on-prem KDC dependency for Entra-joined devices |
| NTLM authentication     | **Eliminated** --- modern auth only       | High                 | NTLM apps must be remediated or proxied                                |
| AD FS (SAML/WS-Fed)     | Entra ID SSO (native SAML/OIDC)           | Medium               | AD FS farm decommissioned post-migration                               |
| AD CS (PKI)             | Entra ID CBA + Key Vault managed PKI      | Medium               | PIV/CAC flows natively                                                 |
| Smart card (PIV/CAC)    | Entra ID certificate-based authentication | Medium               | Native FIPS 201-3 support                                              |
| RADIUS/NPS              | Entra ID Private Access + network policy  | Medium               | 802.1x scenarios require planning                                      |

### 3.2 Authorization and management

| AD capability                         | Entra ID equivalent                       | Migration complexity | Notes                                                         |
| ------------------------------------- | ----------------------------------------- | -------------------- | ------------------------------------------------------------- |
| Organizational Units (OUs)            | Administrative Units                      | Low                  | Scope-limited admin delegation                                |
| Group Policy Objects (GPOs)           | Intune configuration profiles             | High                 | See [GPO Migration](ad-to-entra-id/group-policy-migration.md) |
| Security groups                       | Entra ID security groups + dynamic groups | Low                  | Dynamic membership eliminates manual group management         |
| LDAP queries                          | Microsoft Graph API                       | Medium               | All directory queries migrate to Graph                        |
| AD admin groups (Domain Admins, etc.) | Privileged Identity Management (PIM)      | Medium               | Just-in-time elevation replaces standing access               |
| Sites and Services                    | Named Locations + Conditional Access      | Low                  | Network-aware policies                                        |

### 3.3 Device management

| AD capability                | Entra ID equivalent                | Migration complexity | Notes                                                      |
| ---------------------------- | ---------------------------------- | -------------------- | ---------------------------------------------------------- |
| Domain join                  | Entra Join                         | Medium               | See [Device Migration](ad-to-entra-id/device-migration.md) |
| Group Policy (device config) | Intune MDM/MAM                     | High                 | Configuration profiles replace GPOs                        |
| WSUS                         | Windows Update for Business        | Low                  | Cloud-managed updates                                      |
| BitLocker (AD-backed)        | BitLocker with Entra ID key escrow | Low                  | Automatic key rotation                                     |

---

## 4. Hybrid identity --- the bridge

Most organizations begin with hybrid identity as the bridge between on-premises AD and Entra ID. Two sync engines are available.

### Entra Connect vs Cloud Sync

| Capability                          | Entra Connect                        | Cloud Sync                         |
| ----------------------------------- | ------------------------------------ | ---------------------------------- |
| Architecture                        | Single server (HA with staging mode) | Lightweight agent (multi-agent HA) |
| Multi-forest support                | Yes (complex)                        | Yes (simplified)                   |
| Password hash sync                  | Yes                                  | Yes                                |
| Pass-through authentication         | Yes                                  | No                                 |
| Federation (AD FS)                  | Yes                                  | No                                 |
| Exchange hybrid                     | Full support                         | Limited                            |
| Device writeback                    | Yes                                  | No                                 |
| Group writeback                     | Yes                                  | Yes (v2)                           |
| **Recommended for new deployments** | Legacy --- migrate away              | **Yes**                            |

```powershell
# Install Entra Cloud Sync agent
# Download from https://portal.azure.com > Entra ID > Entra Connect > Cloud Sync
# Run installer on a domain-joined server (not a domain controller)
.\AADConnectProvisioningAgentSetup.exe /quiet

# Verify agent registration
Get-Service AADConnectProvisioningAgent | Select-Object Status, StartType
```

See the [Cloud Sync Tutorial](ad-to-entra-id/tutorial-cloud-sync.md) for step-by-step deployment.

---

## 5. Migration sequence (phased project plan)

A realistic mid-to-large federal AD migration runs 30--50 weeks because the surface area extends beyond identity into devices, applications, and infrastructure services.

### Phase 0 --- Discovery (Weeks 1--4)

- Inventory all domain controllers, forests, trusts, and sites.
- Catalog AD FS relying parties and SAML/WS-Fed applications.
- Run Group Policy Analytics in Intune to assess GPO migration readiness.
- Identify LDAP-dependent applications with port scanning and LDAP query logging.
- Map Kerberos-constrained delegation (KCD) configurations.
- Inventory AD CS certificate templates and enrolled certificates.
- Document DNS/DHCP dependencies on AD-integrated zones.

**Success criteria:** Complete identity estate inventory; application dependency map; GPO migration readiness report.

### Phase 1 --- Hybrid identity deployment (Weeks 4--8)

- Deploy Entra Cloud Sync agents (minimum 2 for HA).
- Enable password hash synchronization.
- Configure Entra ID Conditional Access baseline policies.
- Enable Entra ID Identity Protection.
- Deploy Entra ID PIM for privileged roles.
- Pilot SSO for 3--5 SaaS applications (replacing AD FS).

**Success criteria:** All users synced; PHS operational; Conditional Access enforcing MFA; pilot SSO validated.

### Phase 2 --- Application migration (Weeks 8--20)

- Migrate AD FS relying parties to Entra ID SSO (prioritize SaaS apps).
- Deploy Entra Application Proxy for legacy on-prem web apps.
- Migrate LDAP-bound applications to Graph API or LDAP proxy.
- Configure Kerberos cloud trust for remaining Kerberos apps.
- Migrate RADIUS/NPS to Entra ID Private Access where applicable.

**Success criteria:** 80%+ applications migrated from AD FS; LDAP dependency reduced; Application Proxy deployed.

### Phase 3 --- Device migration (Weeks 12--30)

- Deploy Hybrid Entra Join as interim for existing device fleet.
- Configure Autopilot profiles for new device provisioning.
- Migrate GPOs to Intune configuration profiles (priority-ordered).
- Begin Entra Join migration for device refresh cycles.
- Migrate BitLocker recovery keys to Entra ID.
- Deploy Windows LAPS with Entra ID backup.

**Success criteria:** All devices Hybrid Entra Joined or Entra Joined; Intune managing 90%+ device policy; LAPS migrated.

### Phase 4 --- Security hardening (Weeks 20--36)

- Deploy passwordless authentication (FIDO2, Windows Hello, CBA).
- Configure Conditional Access with device compliance requirements.
- Enable Entra ID Identity Governance (access reviews, entitlement management).
- Migrate AD admin tier model to Entra PIM roles.
- Deploy Entra ID Workload Identities for service accounts.

**Success criteria:** Passwordless deployed for privileged users; standing admin access eliminated; workload identities replacing service accounts.

### Phase 5 --- AD decommission preparation (Weeks 30--44)

- Switch Source of Authority from AD to Entra ID for pilot OUs.
- Validate all applications function without AD connectivity.
- Migrate remaining DNS zones from AD-integrated to Azure DNS.
- Migrate DFS namespaces to SharePoint/OneDrive or Azure Files.
- Decommission AD FS farm.
- Decommission AD CS (migrate to Entra CBA + Key Vault).

**Success criteria:** AD FS decommissioned; AD CS decommissioned; Source of Authority switched for 100% of users.

### Phase 6 --- Domain controller decommission (Weeks 40--50)

- Final validation: no LDAP queries, no Kerberos tickets issued from on-prem DCs.
- Demote domain controllers (DVPROMO demotion sequence).
- Remove AD DS role from all servers.
- Archive AD database and SYSVOL for compliance retention.
- Update documentation and runbooks.

**Success criteria:** All domain controllers decommissioned; AD forest archived; Entra ID is sole identity provider.

---

## 6. CSA-in-a-Box identity integration

Once Entra ID is the identity provider, CSA-in-a-Box services bind directly.

| CSA-in-a-Box service | Entra ID integration                  | Configuration                                   |
| -------------------- | ------------------------------------- | ----------------------------------------------- |
| Microsoft Fabric     | Workspace RBAC via Entra groups       | Entra security groups map to Fabric roles       |
| Databricks           | SCIM provisioning from Entra ID       | Automatic user/group sync to Databricks         |
| Purview              | Data access policies via Entra groups | Governance roles bound to Entra security groups |
| Azure OpenAI         | RBAC via Entra managed identities     | Service principals and managed identities       |
| Power BI             | Row-level security via Entra groups   | Dynamic security with Entra group membership    |
| Azure Monitor        | Diagnostic access via Entra RBAC      | Log Analytics workspace access control          |
| Key Vault            | Access policies or RBAC via Entra     | Managed identity authentication                 |
| ADLS Gen2            | ACLs + RBAC via Entra identities      | Storage Blob Data roles                         |

---

## 7. Cost comparison

Illustrative. A federal agency running **~$800K/year** on AD infrastructure typically lands on:

| Cost category                          | On-premises AD (annual) | Entra ID (annual)                    | Savings     |
| -------------------------------------- | ----------------------- | ------------------------------------ | ----------- |
| Domain controller hardware + hosting   | $150K--$250K            | $0                                   | 100%        |
| AD FS farm (hardware + licensing + HA) | $80K--$120K             | $0                                   | 100%        |
| AD CS PKI infrastructure               | $40K--$80K              | Included in M365 E5                  | 100%        |
| Windows Server CALs (for DC)           | $50K--$100K             | $0                                   | 100%        |
| Identity admin FTE (2--3 FTE)          | $300K--$500K            | 1--1.5 FTE ($150K--$250K)            | 50%         |
| MFA server/solution                    | $30K--$60K              | Included in Entra ID P1/P2           | 100%        |
| Entra ID P2 licensing                  | N/A                     | $108/user/year (included in M365 E5) | ---         |
| Intune licensing                       | N/A                     | Included in M365 E3/E5               | ---         |
| **Typical run-rate**                   | **$650K--$1.1M**        | **$250K--$400K**                     | **50--65%** |

See [TCO Analysis](ad-to-entra-id/tco-analysis.md) for detailed 3- and 5-year projections.

---

## 8. Federal compliance

- **EO 14028:** Mandates cloud-native identity; Entra ID satisfies the identity pillar directly.
- **CISA Zero Trust Maturity Model:** Identity is Pillar 1; Conditional Access + Identity Protection + PIM maps to Advanced maturity level.
- **FedRAMP High:** Entra ID in Azure Government and M365 GCC High inherits FedRAMP High authorization.
- **PIV/CAC:** Entra ID certificate-based authentication supports FIPS 201-3 PIV and CAC smart cards natively.
- **Hard-match hardening:** Microsoft enforcement dates June--July 2026 require updated sync configurations. See [Hybrid Identity Migration](ad-to-entra-id/hybrid-identity-migration.md).

See [Federal Migration Guide](ad-to-entra-id/federal-migration-guide.md) for comprehensive federal guidance.

---

## 9. Gaps and roadmap

| Gap                         | Description                                                                      | Planned remediation                                       |
| --------------------------- | -------------------------------------------------------------------------------- | --------------------------------------------------------- |
| **Legacy Kerberos apps**    | Some LOB apps require on-prem Kerberos; cloud trust does not cover all scenarios | Application Proxy + KCD or app modernization              |
| **AD-integrated DNS**       | DNS zones in AD require migration planning                                       | Azure DNS Private Zones or standalone DNS                 |
| **RADIUS/802.1x**           | Network device authentication requires NPS replacement                           | Entra Private Access or third-party NAC                   |
| **Print server GPOs**       | Universal Print covers most but not all print scenarios                          | Universal Print + Intune printer deployment               |
| **Linux/macOS domain join** | AD domain join for non-Windows                                                   | Entra ID + Intune MDM (macOS); SSSD with Entra ID (Linux) |

---

## 10. Related resources

- **Migration index:** [docs/migrations/README.md](README.md)
- **Migration Center:** [AD to Entra ID Migration Center](ad-to-entra-id/index.md)
- **Companion playbooks:** [VMware to Azure](vmware-to-azure.md), [SQL Server to Azure](sql-server-to-azure.md)
- **Compliance matrices:**
    - `docs/compliance/nist-800-53-rev5.md`
    - `docs/compliance/fedramp-moderate.md`
- **Platform modules:**
    - `csa_platform/unity_catalog_pattern/` --- Unity Catalog + identity binding
    - `csa_platform/csa_platform/governance/purview/` --- Purview access policies
    - `csa_platform/ai_integration/` --- AI Foundry managed identity patterns
- **Operational guides:**
    - `docs/QUICKSTART.md`, `docs/ARCHITECTURE.md`, `docs/GOV_SERVICE_MATRIX.md`

---

**Maintainers:** csa-inabox core team
**Last updated:** 2026-04-30
