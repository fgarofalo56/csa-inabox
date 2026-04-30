# Migrating from Exchange On-Premises to Exchange Online

**Status:** Authored 2026-04-30
**Audience:** Exchange administrators, M365 architects, IT managers, and federal CIOs planning an Exchange Online migration.
**Scope:** Exchange Server 2013/2016/2019 to Exchange Online --- cutover, staged, hybrid, and express hybrid migration paths. Covers mailbox, public folder, compliance, and security migration. Federal GCC/GCC-High/DoD considerations throughout.

---

!!! tip "Expanded Migration Center Available"
This playbook is the core migration reference. For the complete Exchange-to-Online migration package --- including white papers, deep-dive guides, tutorials, benchmarks, and federal-specific guidance --- visit the **[Exchange to Online Migration Center](exchange-to-online/index.md)**.

    **Quick links:**

    - [Why Exchange Online (Executive Brief)](exchange-to-online/why-exchange-online.md)
    - [Total Cost of Ownership Analysis](exchange-to-online/tco-analysis.md)
    - [Complete Feature Mapping (50+ features)](exchange-to-online/feature-mapping-complete.md)
    - [Federal Migration Guide (GCC/GCC-High/DoD)](exchange-to-online/federal-migration-guide.md)
    - [Tutorials & Walkthroughs](exchange-to-online/index.md#tutorials)
    - [Benchmarks & Performance](exchange-to-online/benchmarks.md)
    - [Best Practices](exchange-to-online/best-practices.md)

## 1. Executive summary

Exchange Server on-premises is the largest single-product attack surface in enterprise IT. The Hafnium campaign (March 2021) compromised 250,000+ organizations in days. ProxyShell, ProxyLogon, and ProxyNotShell followed --- each targeting on-premises Exchange. Every month that Exchange runs on-prem is a month the organization carries unpatched zero-day risk that Microsoft patches for Exchange Online automatically.

Exchange Online eliminates the patching burden, collapses the DAG/load-balancer/certificate stack, and unlocks Copilot for Outlook, Teams, and M365. FastTrack provides free migration assistance for tenants with 150+ seats. For federal organizations, Exchange Online is available in GCC, GCC-High, and DoD tenants with FedRAMP High authorization.

CSA-in-a-Box extends the value of an Exchange Online migration by providing **Microsoft Purview integration for email compliance** --- DLP policies, sensitivity labels, retention, and eDiscovery that govern email alongside the data platform. When email moves to Exchange Online, Purview provides a single compliance plane across mailboxes, SharePoint, OneDrive, Teams, and the CSA-in-a-Box analytics estate.

### Migration path decision matrix

| Scenario                                             | Recommended path                                               | Timeline    | Complexity |
| ---------------------------------------------------- | -------------------------------------------------------------- | ----------- | ---------- |
| < 2,000 mailboxes, single Exchange version           | [Cutover migration](exchange-to-online/cutover-migration.md)   | 1--3 days   | Low        |
| Exchange 2003/2007, large organization               | [Staged migration](exchange-to-online/staged-migration.md)     | 4--12 weeks | Medium     |
| Exchange 2013/2016/2019, long coexistence needed     | [Hybrid migration](exchange-to-online/hybrid-migration.md)     | 8--24 weeks | High       |
| Exchange 2016/2019, fast hybrid, no long coexistence | Express hybrid (minimal hybrid)                                | 2--6 weeks  | Medium     |
| Government (GCC/GCC-High/DoD)                        | [Federal guide](exchange-to-online/federal-migration-guide.md) | Varies      | High       |

---

## 2. Pre-migration assessment

### Environment inventory

- [ ] Exchange Server versions (2013 CU23, 2016 CU23, 2019 CU14+).
- [ ] Total mailbox count, average mailbox size, largest mailbox size.
- [ ] Database Availability Group (DAG) topology: nodes, witness, networks.
- [ ] Public folder hierarchy: folder count, item count, total size.
- [ ] Transport rules: count and complexity.
- [ ] Connectors: send/receive, partner, application relay.
- [ ] Certificates: SAN certificates, load balancer VIPs, split-brain DNS.
- [ ] Third-party integrations: archiving, DLP, anti-spam gateways, fax, voicemail.
- [ ] Outlook versions in use (minimum Outlook 2016 for modern auth).
- [ ] Mobile device policies (ActiveSync, MDM/MAM).

### Identity readiness

- [ ] Microsoft Entra Connect (formerly Azure AD Connect) deployed and healthy.
- [ ] UPN suffix matches a verified domain in M365.
- [ ] Password hash sync or pass-through auth configured.
- [ ] Hybrid identity validated with `IdFix` tool.

### Network readiness

- [ ] DNS: Autodiscover, MX, SPF, DKIM, DMARC records documented.
- [ ] Firewall: ports 443, 25 (SMTP) open to Exchange Online endpoints.
- [ ] Bandwidth: minimum 1 Mbps per 10 concurrent mailbox moves.
- [ ] Proxy/firewall allows connections to `*.outlook.com`, `*.protection.outlook.com`.

---

## 3. Migration execution overview

### Phase 0 --- Identity and licensing (Weeks 1--2)

1. Deploy or validate Entra Connect with Exchange hybrid configuration.
2. Assign Microsoft 365 licenses (E3/E5/F1/G3/G5) to pilot users.
3. Validate Entra Connect sync: `Get-MsolUser -UserPrincipalName user@domain.com`.
4. Enable modern authentication on Exchange on-premises.

### Phase 1 --- Hybrid configuration (Weeks 2--4)

1. Run the Hybrid Configuration Wizard (HCW).
2. Configure OAuth authentication between on-prem and Exchange Online.
3. Configure mail routing (centralized or decentralized).
4. Test free/busy sharing between on-prem and cloud mailboxes.
5. Validate cross-premises calendar sharing.

See [Tutorial: Hybrid Setup](exchange-to-online/tutorial-hybrid-setup.md) for step-by-step PowerShell.

### Phase 2 --- Pilot migration (Weeks 4--6)

1. Select 10--50 pilot users across departments.
2. Create migration batch in Exchange Admin Center or PowerShell.
3. Monitor migration progress: `Get-MoveRequest | Get-MoveRequestStatistics`.
4. Validate Outlook profile, mobile devices, shared calendars.
5. Gather feedback; adjust migration batch size and schedule.

See [Tutorial: Mailbox Move](exchange-to-online/tutorial-mailbox-move.md) for step-by-step PowerShell.

### Phase 3 --- Production migration (Weeks 6--16)

1. Create migration batches by department or geography.
2. Run batches during off-hours; complete during maintenance windows.
3. Monitor with `Get-MigrationBatch` and `Get-MoveRequestStatistics`.
4. Migrate public folders (if applicable): see [Public Folder Migration](exchange-to-online/public-folder-migration.md).
5. Migrate compliance policies: see [Compliance Migration](exchange-to-online/compliance-migration.md).

### Phase 4 --- DNS cutover and decommission (Weeks 16--20)

1. Update MX records to point to Exchange Online Protection.
2. Update Autodiscover to point to Exchange Online.
3. Update SPF, DKIM, and DMARC records.
4. Monitor mail flow for 2--4 weeks post-cutover.
5. Decommission on-premises Exchange servers (keep one hybrid endpoint for management).
6. Retain Entra Connect for directory synchronization.

---

## 4. Compliance continuity

Exchange Online migration is not just a mailbox move --- it is a compliance migration. On-premises retention policies, journaling rules, DLP policies, and eDiscovery cases must translate to their cloud equivalents.

| On-premises feature           | Exchange Online equivalent                     | CSA-in-a-Box integration                                     |
| ----------------------------- | ---------------------------------------------- | ------------------------------------------------------------ |
| Retention policies (MRM)      | Microsoft Purview retention policies           | Purview unified retention across email + data lake           |
| Transport rule DLP            | Microsoft Purview DLP                          | Single DLP policy across email, Teams, SharePoint, endpoints |
| eDiscovery (in-place holds)   | Microsoft Purview eDiscovery (Premium)         | Cross-workload search including data platform                |
| Journaling                    | Microsoft Purview compliance portal journaling | Purview audit + analytics in CSA-in-a-Box                    |
| Information Rights Management | Microsoft Purview sensitivity labels           | Unified labeling across email and data assets                |

See [Compliance Migration](exchange-to-online/compliance-migration.md) for detailed mapping.

---

## 5. Security posture improvement

Moving to Exchange Online eliminates the on-premises attack surface and provides:

- **Exchange Online Protection (EOP):** Anti-spam, anti-malware, connection filtering.
- **Microsoft Defender for Office 365:** Safe Attachments, Safe Links, anti-phishing.
- **Automated patching:** Zero-day patches deployed by Microsoft --- no admin intervention.
- **Modern authentication:** OAuth 2.0 / OIDC replaces NTLM/Kerberos for mail clients.
- **Conditional Access:** Device compliance, location-based access, MFA enforcement.

See [Security Migration](exchange-to-online/security-migration.md) for transport rule and connector migration.

---

## 6. How CSA-in-a-Box fits

CSA-in-a-Box is an Azure-native reference implementation for Data Mesh, Fabric, Lakehouse, and AI platforms. Exchange Online migration connects to CSA-in-a-Box in three ways:

1. **Microsoft Purview as the unified compliance plane.** When email moves to Exchange Online, Purview governs email, SharePoint, Teams, and the data platform through a single set of DLP policies, sensitivity labels, retention policies, and eDiscovery cases. This eliminates the compliance silo between messaging and analytics.

2. **Copilot for Microsoft 365.** Exchange Online is a prerequisite for Copilot in Outlook and Teams. CSA-in-a-Box integrates Azure OpenAI and AI Foundry for the data platform; Copilot for M365 extends AI to email, calendar, and collaboration. The combination provides AI across the full organizational surface.

3. **Email analytics in the data lake.** Exchange Online message trace logs, mail flow reports, and compliance audit logs can flow into the CSA-in-a-Box analytics estate via Azure Monitor, Event Hubs, or the Microsoft Graph API, enabling email governance dashboards in Power BI alongside data platform governance.

---

## 7. Federal considerations

- **GCC:** FedRAMP High authorized. Standard Exchange Online features available. FastTrack available for GCC.
- **GCC-High:** FedRAMP High + ITAR. Separate tenant infrastructure. Reduced feature set (no consumer interop). Hybrid requires GCC-High-specific HCW endpoints.
- **DoD:** IL5 authorized. Most restrictive feature set. Dedicated tenant infrastructure.
- **Data residency:** All mailbox data stored in US sovereign datacenters for GCC/GCC-High/DoD.
- **FIPS 140-2:** TLS 1.2 with FIPS-validated cryptographic modules required for GCC-High/DoD.

See [Federal Migration Guide](exchange-to-online/federal-migration-guide.md) for detailed GCC/GCC-High/DoD guidance.

---

## 8. Cost comparison snapshot

| Component                     | On-premises (500 mailboxes) | Exchange Online E3 (500 users)               |
| ----------------------------- | --------------------------- | -------------------------------------------- |
| Server hardware (2 DAG nodes) | $40,000 (amortized/yr)      | $0                                           |
| Windows Server + CALs         | $12,000/yr                  | $0                                           |
| Exchange Server licenses      | $15,000 (amortized/yr)      | $0                                           |
| Load balancer + certificates  | $5,000/yr                   | $0                                           |
| Backup infrastructure         | $8,000/yr                   | $0                                           |
| Admin FTE (0.5 FTE)           | $55,000/yr                  | $0                                           |
| DR site (passive DAG node)    | $20,000/yr                  | $0                                           |
| Anti-spam gateway             | $6,000/yr                   | Included (EOP)                               |
| Exchange Online E3 licenses   | $0                          | $198,000/yr ($33/user/mo)                    |
| **Total annual**              | **$161,000**                | **$198,000**                                 |
| Copilot, Defender, Purview    | Not available               | Included with E5 ($57/user/mo = $342,000/yr) |

The on-prem number understates true cost because it excludes patching labor, security incident response, and compliance audit effort. Organizations consistently find that fully-loaded on-prem costs exceed Exchange Online E3 licensing once admin labor and risk are factored in.

See [TCO Analysis](exchange-to-online/tco-analysis.md) for detailed 5-year projections.

---

## 9. Related resources

- **Migration index:** [docs/migrations/README.md](README.md)
- **Companion playbooks:** [sql-server-to-azure.md](sql-server-to-azure.md), [vmware-to-azure.md](vmware-to-azure.md)
- **Microsoft Learn:** [Exchange Online migration overview](https://learn.microsoft.com/exchange/mailbox-migration/mailbox-migration)
- **FastTrack:** [FastTrack for Microsoft 365](https://www.microsoft.com/fasttrack/microsoft-365)
- **CSA-in-a-Box Purview modules:** `csa_platform/csa_platform/governance/purview/`
- **Compliance matrices:** `docs/compliance/nist-800-53-rev5.md`, `docs/compliance/cmmc-2.0-l2.md`

---

**Maintainers:** csa-inabox core team
**Last updated:** 2026-04-30
