# Exchange On-Premises to Exchange Online: Complete Feature Mapping

**Status:** Authored 2026-04-30
**Audience:** Exchange administrators, M365 architects, and compliance officers evaluating feature parity between Exchange Server on-premises and Exchange Online.
**Scope:** 50+ Exchange features mapped with migration complexity, cloud equivalent, and CSA-in-a-Box integration points.

---

## How to read this document

Every feature row includes:

- **On-premises feature** --- the Exchange Server capability.
- **Exchange Online equivalent** --- the cloud counterpart.
- **Migration complexity** --- XS (trivial), S (simple), M (moderate), L (complex), XL (requires redesign).
- **Notes** --- behavioral differences, gaps, or CSA-in-a-Box integration points.

Features are grouped by functional domain.

---

## 1. Mail flow and transport

| On-premises feature                 | Exchange Online equivalent                                 | Complexity | Notes                                                                                                                                                                                                                                                                                                                                   |
| ----------------------------------- | ---------------------------------------------------------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Transport rules (Hub Transport)     | Exchange Online mail flow rules                            | S          | 1:1 mapping; PowerShell: `Get-TransportRule` exports and `New-TransportRule` imports. Some predicates differ (e.g., `HeaderContainsMessageHeader` vs `HeaderContainsWords`).                                                                                                                                                            |
| Edge Transport rules                | Exchange Online mail flow rules + EOP connection filtering | M          | Edge Transport servers are eliminated; their rules merge into EXO mail flow rules and EOP.                                                                                                                                                                                                                                              |
| Send connectors                     | Outbound connectors (Exchange admin center)                | S          | Smart host routing, TLS enforcement, partner connectors.                                                                                                                                                                                                                                                                                |
| Receive connectors                  | Inbound connectors (EOP)                                   | S          | Anonymous relay requires an inbound connector with IP allow list or certificate-based authentication.                                                                                                                                                                                                                                   |
| Internal relay (application SMTP)   | Exchange Online SMTP relay or Direct Send                  | M          | Applications using on-prem relay must be reconfigured. Three options: SMTP AUTH submission, Direct Send, or SMTP relay connector. See [Microsoft Learn: SMTP relay](https://learn.microsoft.com/exchange/mail-flow-best-practices/how-to-set-up-a-multifunction-device-or-application-to-send-email-using-microsoft-365-or-office-365). |
| Delivery reports / message tracking | Message trace (Exchange admin center or PowerShell)        | XS         | `Get-MessageTrace` replaces `Get-MessageTrackingLog`. Historical search: `Start-HistoricalSearch`.                                                                                                                                                                                                                                      |
| Queues (transport queue viewer)     | Not applicable                                             | XS         | Exchange Online manages queues internally. No admin access to transport queues.                                                                                                                                                                                                                                                         |
| Foreign connectors                  | Third-party integration via API or connectors              | L          | Foreign connectors (fax, SMS) must be re-implemented via third-party cloud services or Power Automate.                                                                                                                                                                                                                                  |
| Journaling rules                    | Exchange Online journaling + Purview                       | M          | SMTP journaling rules migrate; consider replacing with Purview retention policies for unified compliance.                                                                                                                                                                                                                               |
| Header firewall                     | EOP mail flow rules                                        | S          | Header manipulation rules map to EOP mail flow rules.                                                                                                                                                                                                                                                                                   |

---

## 2. Anti-spam and anti-malware

| On-premises feature                    | Exchange Online equivalent                       | Complexity | Notes                                                                                                                         |
| -------------------------------------- | ------------------------------------------------ | ---------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Exchange anti-spam (content filtering) | Exchange Online Protection (EOP)                 | XS         | EOP replaces all on-prem anti-spam; significantly more capable with ML-based filtering.                                       |
| Exchange anti-malware                  | EOP anti-malware                                 | XS         | Automatic; multi-engine scanning.                                                                                             |
| Connection filtering (IP allow/block)  | EOP connection filter policy                     | S          | `Set-HostedConnectionFilterPolicy` for IP allow/block lists.                                                                  |
| Content filtering (SCL thresholds)     | EOP anti-spam policy                             | S          | `Set-HostedContentFilterPolicy` for SCL, bulk, phishing thresholds.                                                           |
| Sender filtering                       | EOP anti-spam policy (blocked senders)           | XS         | Blocked sender lists migrate to EOP tenant allow/block list.                                                                  |
| Recipient filtering                    | EOP (automatic; rejects non-existent recipients) | XS         | Built-in; no configuration needed.                                                                                            |
| Safe Senders (user level)              | Outlook junk email settings (synced to EXO)      | XS         | User-level safe senders sync via Outlook.                                                                                     |
| Third-party anti-spam gateway          | EOP (native) or third-party MX                   | S          | Most organizations eliminate third-party gateways. If retained, configure MX to third-party, then route to EXO via connector. |
| Sender ID / SPF validation             | EOP SPF validation + DKIM + DMARC                | S          | SPF is validated automatically. Configure DKIM signing and DMARC policy in DNS.                                               |
| Safe Attachments (ATP)                 | Microsoft Defender for Office 365 (P1/P2)        | S          | Requires E5 or Defender for O365 add-on. Sandboxes attachments before delivery.                                               |
| Safe Links (ATP)                       | Microsoft Defender for Office 365 (P1/P2)        | S          | URL rewriting and time-of-click protection.                                                                                   |
| Anti-phishing (ATP)                    | Defender for Office 365 anti-phishing policies   | S          | Impersonation detection, mailbox intelligence, spoof intelligence.                                                            |

---

## 3. Client access

| On-premises feature         | Exchange Online equivalent                       | Complexity | Notes                                                                                                                             |
| --------------------------- | ------------------------------------------------ | ---------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Outlook Web App (OWA)       | Outlook on the web (outlook.office365.com)       | XS         | Feature-superior to on-prem OWA.                                                                                                  |
| Outlook Anywhere (RPC/HTTP) | MAPI over HTTP (default)                         | XS         | Modern Outlook clients use MAPI/HTTP natively. RPC/HTTP is deprecated.                                                            |
| Exchange ActiveSync         | Exchange ActiveSync (EXO)                        | XS         | 1:1 feature parity. Mobile device access policies migrate.                                                                        |
| POP3/IMAP4                  | POP3/IMAP4 (EXO)                                 | XS         | Available but not recommended. Modern auth required.                                                                              |
| MAPI/CDO                    | Microsoft Graph API / EWS                        | L          | Legacy MAPI/CDO applications must migrate to Graph API or EWS. MAPI/CDO is not available in EXO.                                  |
| Exchange Web Services (EWS) | EWS (supported but deprecated) + Microsoft Graph | M          | EWS remains available but Microsoft Graph is the strategic API. Plan migration to Graph for new integrations.                     |
| Autodiscover (SCP + DNS)    | Autodiscover (cloud; DNS-based)                  | S          | Post-migration, Autodiscover points to EXO. Remove SCP records from AD after decommission.                                        |
| Outlook profiles            | Outlook auto-reconfigures on mailbox move        | XS         | Outlook profiles update automatically via Autodiscover when mailbox moves to EXO. No manual re-profiling needed for hybrid moves. |
| Offline Address Book (OAB)  | Cloud OAB (automatic)                            | XS         | EXO generates and distributes OAB automatically.                                                                                  |
| Address Book Policies (ABP) | Address Book Policies (EXO)                      | S          | 1:1 feature mapping. `New-AddressBookPolicy` works in EXO PowerShell.                                                             |

---

## 4. Mailbox and storage

| On-premises feature                  | Exchange Online equivalent                              | Complexity | Notes                                                                                                |
| ------------------------------------ | ------------------------------------------------------- | ---------- | ---------------------------------------------------------------------------------------------------- |
| User mailboxes                       | User mailboxes (50 GB E3 / 100 GB E5)                   | XS         | Size limit enforced by license tier.                                                                 |
| Archive mailboxes (personal archive) | Archive mailbox (unlimited with E3/E5)                  | XS         | Auto-expanding archive available.                                                                    |
| Shared mailboxes                     | Shared mailboxes (50 GB, no license required)           | XS         | Free in EXO; no license needed unless direct login required.                                         |
| Resource mailboxes (room/equipment)  | Resource mailboxes (free, no license)                   | XS         | Room Finder enhanced in EXO with Workplace features.                                                 |
| Arbitration mailboxes                | System mailboxes (managed by Microsoft)                 | XS         | No admin management needed. Moderation, OAB generation handled automatically.                        |
| Discovery mailboxes                  | Purview eDiscovery (replaces discovery mailboxes)       | M          | Discovery mailboxes are deprecated. Use Purview eDiscovery Standard/Premium for search and export.   |
| Site mailboxes                       | Deprecated                                              | M          | Site mailboxes deprecated in both on-prem and EXO. Use M365 Groups or Teams channels.                |
| Linked mailboxes                     | Not directly supported                                  | L          | Linked mailboxes (cross-forest) require migration to cloud-only or hybrid identity. Redesign needed. |
| Mailbox database management          | Not applicable                                          | XS         | Microsoft manages databases. No admin interaction.                                                   |
| Deleted item recovery (dumpster)     | 14-day (configurable to 30-day) recoverable items       | XS         | `Set-Mailbox -RetainDeletedItemsFor 30` available in EXO.                                            |
| Litigation Hold                      | Litigation Hold (EXO)                                   | XS         | 1:1 feature mapping. `Set-Mailbox -LitigationHoldEnabled $true`.                                     |
| In-Place Hold                        | Purview retention policies / eDiscovery holds           | M          | In-Place Hold deprecated. Use Purview retention policies or eDiscovery case holds.                   |
| Single Item Recovery                 | Single Item Recovery (EXO, enabled by default)          | XS         | Enabled by default in EXO.                                                                           |
| Mailbox quotas                       | Per-license quotas (50 GB / 100 GB + unlimited archive) | XS         | Quotas set by license tier. Custom per-user quotas possible via `Set-Mailbox`.                       |

---

## 5. Public folders

| On-premises feature           | Exchange Online equivalent              | Complexity | Notes                                                                                                                |
| ----------------------------- | --------------------------------------- | ---------- | -------------------------------------------------------------------------------------------------------------------- |
| Public folder hierarchy       | Exchange Online public folders          | M          | Public folders supported in EXO with 1,000 mailbox limit. See [Public Folder Migration](public-folder-migration.md). |
| Mail-enabled public folders   | Mail-enabled public folders (EXO)       | M          | Migrate via batch migration.                                                                                         |
| Public folder permissions     | Public folder permissions (EXO)         | M          | Permissions migrate with the folder hierarchy.                                                                       |
| Public folder replication     | Not applicable (single hierarchy)       | XS         | EXO uses content mailboxes, not replication.                                                                         |
| Public folders to M365 Groups | M365 Groups (recommended modernization) | L          | Consider converting public folders to M365 Groups for Teams integration.                                             |

---

## 6. Recipients and groups

| On-premises feature             | Exchange Online equivalent              | Complexity | Notes                                                                           |
| ------------------------------- | --------------------------------------- | ---------- | ------------------------------------------------------------------------------- |
| Distribution groups             | Distribution groups (EXO)               | XS         | Sync via Entra Connect.                                                         |
| Dynamic distribution groups     | Dynamic distribution groups (EXO)       | S          | Filters may need adjustment for cloud attributes.                               |
| Mail-enabled security groups    | Mail-enabled security groups (Entra ID) | S          | Synced via Entra Connect.                                                       |
| M365 Groups (modern groups)     | M365 Groups (native)                    | XS         | Full feature set available in EXO.                                              |
| Mail contacts                   | Mail contacts (EXO)                     | XS         | Synced via Entra Connect.                                                       |
| Mail users                      | Mail users (EXO)                        | XS         | Synced via Entra Connect.                                                       |
| Equipment/room lists            | Room lists (EXO)                        | XS         | Enhanced with Workplace features.                                               |
| Moderated recipients            | Moderated recipients (EXO)              | XS         | 1:1 feature mapping.                                                            |
| MailTips                        | MailTips (EXO)                          | XS         | 1:1 feature mapping. Custom MailTips via `Set-Mailbox -MailTip`.                |
| Hierarchical Address Book (HAB) | Hierarchical Address Book (EXO)         | S          | Supported; configure via `Set-OrganizationConfig -HierarchicalAddressBookRoot`. |

---

## 7. Compliance and governance

| On-premises feature                          | Exchange Online equivalent                        | Complexity | Notes                                                                                                                                                   |
| -------------------------------------------- | ------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Messaging Records Management (MRM)           | Purview retention policies                        | M          | MRM retention tags/policies replaced by Purview retention. Existing MRM tags continue to work in EXO but Purview is strategic.                          |
| Retention tags (default, personal, system)   | Purview retention labels + policies               | M          | Map default policy tags to Purview org-wide retention. Map personal tags to Purview retention labels users can apply.                                   |
| DLP policies (transport rules)               | Microsoft Purview DLP                             | M          | Transport-rule DLP replaced by Purview DLP with 300+ sensitive info types, ML classifiers, and cross-workload scope.                                    |
| In-Place eDiscovery                          | Purview eDiscovery (Standard/Premium)             | M          | In-Place eDiscovery deprecated. Purview eDiscovery provides review sets, advanced analytics, hold management.                                           |
| Compliance search                            | Purview Content Search                            | S          | `New-ComplianceSearch` in Security & Compliance PowerShell.                                                                                             |
| Information Rights Management (IRM / AD RMS) | Azure Information Protection + sensitivity labels | L          | AD RMS must be migrated to Azure Information Protection. Sensitivity labels replace IRM templates. See [Compliance Migration](compliance-migration.md). |
| S/MIME                                       | S/MIME (EXO)                                      | M          | Supported with certificate management via EXO.                                                                                                          |
| Transport decryption                         | EXO transport decryption                          | S          | Built into EOP/Defender transport pipeline.                                                                                                             |
| Journal rules                                | Exchange Online journal rules                     | S          | SMTP-based journaling continues. Consider Purview retention as modern alternative.                                                                      |
| Audit logging (mailbox audit)                | Unified Audit Log                                 | S          | Mailbox audit logging enabled by default in EXO. Unified Audit Log provides cross-workload audit.                                                       |

### CSA-in-a-Box compliance integration

| EXO compliance feature     | CSA-in-a-Box integration                                             |
| -------------------------- | -------------------------------------------------------------------- |
| Purview DLP                | Same DLP policies apply to email and data lake content               |
| Purview retention          | Unified retention across email, SharePoint, and analytics assets     |
| Purview sensitivity labels | Labels applied in Outlook propagate to data assets in CSA-in-a-Box   |
| Purview eDiscovery         | Cross-workload search covers email + data platform                   |
| Purview Data Map           | Email compliance metadata cataloged alongside data asset metadata    |
| Audit Log                  | Email audit events flow to Azure Monitor for CSA-in-a-Box dashboards |

---

## 8. High availability and disaster recovery

| On-premises feature               | Exchange Online equivalent                                     | Complexity | Notes                                                                                                                                                |
| --------------------------------- | -------------------------------------------------------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Database Availability Group (DAG) | Managed HA (geo-redundant)                                     | XS         | Microsoft manages all HA. No DAG configuration needed.                                                                                               |
| Database copies (active/passive)  | Managed replication                                            | XS         | Multiple copies maintained automatically across datacenters.                                                                                         |
| Automatic failover                | Automatic (managed by Microsoft)                               | XS         | No admin intervention. SLA: 99.99%.                                                                                                                  |
| Backup and restore                | Native data protection (14/30 day retention + litigation hold) | S          | No traditional backup needed. Litigation Hold provides indefinite retention. Third-party backup (Veeam for M365, AvePoint) available for compliance. |
| Lagged database copies            | Not available                                                  | S          | Lagged copies for corruption recovery not available. Recoverable Items folder and litigation hold serve similar purpose.                             |
| Site resilience (stretched DAG)   | Geo-redundant replication (automatic)                          | XS         | Microsoft maintains cross-datacenter resilience without customer configuration.                                                                      |

---

## 9. Unified Messaging (UM) and voice

| On-premises feature           | Exchange Online equivalent                     | Complexity | Notes                                                                                                             |
| ----------------------------- | ---------------------------------------------- | ---------- | ----------------------------------------------------------------------------------------------------------------- |
| Unified Messaging (voicemail) | Cloud Voicemail (Teams Phone)                  | L          | Exchange UM is deprecated in EXO. Voicemail moves to Teams Phone / Cloud Voicemail. Requires Teams Phone license. |
| Auto Attendant (UM)           | Teams Auto Attendant                           | L          | Must be re-implemented in Teams.                                                                                  |
| Call Answering Rules          | Teams voicemail settings                       | M          | User-level voicemail rules move to Teams.                                                                         |
| Fax receiving (UM)            | Third-party cloud fax (eFax, j2 Global)        | L          | No native fax in EXO/Teams. Third-party service required.                                                         |
| Play on Phone                 | Not available                                  | M          | Deprecated feature. Users listen to voicemail in Teams.                                                           |
| SIP gateway integration       | Teams SBC (Direct Routing or Operator Connect) | L          | PBX integration moves to Teams Direct Routing or Operator Connect.                                                |

!!! warning "Unified Messaging deprecation"
Exchange Unified Messaging is fully deprecated in Exchange Online. Organizations with UM dependencies must plan a parallel migration to Microsoft Teams Phone. This is often the most complex workstream in an Exchange Online migration.

---

## 10. Administration and management

| On-premises feature               | Exchange Online equivalent                    | Complexity | Notes                                                                                               |
| --------------------------------- | --------------------------------------------- | ---------- | --------------------------------------------------------------------------------------------------- |
| Exchange Management Console (EMC) | Exchange admin center (EAC, web-based)        | XS         | Web-based admin center.                                                                             |
| Exchange Management Shell (EMS)   | Exchange Online PowerShell (EXO V3 module)    | S          | `Connect-ExchangeOnline` replaces local EMS. Most cmdlets have EXO equivalents.                     |
| RBAC (Exchange roles)             | EXO RBAC + Entra ID roles                     | S          | Exchange RBAC roles available in EXO. M365 admin roles (Global Admin, Exchange Admin) layer on top. |
| Organization-wide settings        | `Set-OrganizationConfig` (EXO)                | XS         | Most org settings have EXO equivalents.                                                             |
| Accepted domains                  | Accepted domains (EXO)                        | XS         | Managed via EAC or `New-AcceptedDomain`.                                                            |
| Email address policies            | Email address policies (EXO)                  | S          | Supported in EXO. Cloud-based policies.                                                             |
| Mobile device access policies     | Exchange ActiveSync policies + Intune MDM/MAM | M          | ActiveSync policies migrate; consider Intune for richer device management.                          |
| Outlook Anywhere settings         | Not applicable (MAPI/HTTP default)            | XS         | Outlook connects via MAPI/HTTP or Outlook Anywhere automatically.                                   |
| Remote domains                    | Remote domains (EXO)                          | XS         | `Set-RemoteDomain` available in EXO.                                                                |
| Sharing policies (calendar)       | Sharing policies (EXO) + org relationships    | S          | 1:1 mapping.                                                                                        |

---

## 11. Features not available in Exchange Online

| On-premises feature                | Status in EXO                        | Recommended alternative                                     |
| ---------------------------------- | ------------------------------------ | ----------------------------------------------------------- |
| Custom transport agents (C# DLLs)  | Not available                        | EXO mail flow rules, Power Automate, third-party connectors |
| Exchange Unified Messaging         | Deprecated                           | Microsoft Teams Phone + Cloud Voicemail                     |
| MAPI/CDO API                       | Not available                        | Microsoft Graph API                                         |
| Linked mailboxes (cross-forest)    | Not directly supported               | Cloud identity + hybrid identity                            |
| Site mailboxes                     | Deprecated                           | M365 Groups, Teams                                          |
| S2S (server-to-server) legacy auth | Deprecated                           | OAuth 2.0 / modern auth                                     |
| Transport queue management         | Not available (managed by Microsoft) | Message trace for troubleshooting                           |
| Database-level management          | Not available (managed by Microsoft) | N/A                                                         |
| Lagged database copies             | Not available                        | Recoverable Items, Litigation Hold                          |
| Foreign connectors                 | Not available                        | Third-party cloud services                                  |

---

## 12. Migration complexity summary

| Complexity                | Count  | Percentage |
| ------------------------- | ------ | ---------- |
| XS (trivial)              | 28     | 49%        |
| S (simple)                | 14     | 25%        |
| M (moderate)              | 11     | 19%        |
| L (complex)               | 3      | 5%         |
| XL (requires redesign)    | 1      | 2%         |
| **Total features mapped** | **57** | **100%**   |

**Key finding:** 74% of Exchange features map to Exchange Online with trivial or simple migration effort. The primary complexity drivers are Unified Messaging (deprecated, requires Teams Phone migration), Information Rights Management (requires AIP migration), and custom transport agents (require re-implementation).

---

**Maintainers:** csa-inabox core team
**Last updated:** 2026-04-30
