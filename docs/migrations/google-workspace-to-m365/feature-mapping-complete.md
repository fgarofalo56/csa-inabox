# Complete Feature Mapping: Google Workspace to Microsoft 365

**A comprehensive mapping of 50+ Google Workspace features to their Microsoft 365 equivalents, with migration complexity and fidelity ratings.**

---

## How to read this document

Every feature mapping includes:

- **Google Workspace feature** --- the specific capability in Google Workspace.
- **M365 equivalent** --- the Microsoft 365 component that provides the same or better capability.
- **Migration path** --- how data and configuration migrate (automated, manual, or rebuild).
- **Fidelity** --- how closely the M365 equivalent matches the Google feature (High / Medium / Low).
- **Complexity** --- effort required to migrate (XS / S / M / L / XL).

**Fidelity ratings:**

- **High** --- feature parity or better; users will find familiar functionality.
- **Medium** --- core functionality maps; some workflows change.
- **Low** --- significant rework required; feature is conceptually different.

**Complexity ratings:**

- **XS** --- automated migration, minimal configuration.
- **S** --- straightforward migration with some manual steps.
- **M** --- moderate effort; requires planning and testing.
- **L** --- significant effort; requires rearchitecture or rebuild.
- **XL** --- major project; custom development or third-party tools required.

---

## 1. Email and communication

| #   | Google Workspace feature      | M365 equivalent                                       | Migration path                                                            | Fidelity | Complexity |
| --- | ----------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------- | -------- | ---------- |
| 1   | Gmail (email)                 | Exchange Online + Outlook                             | Google Workspace migration in EAC or IMAP migration                       | High     | S          |
| 2   | Gmail labels                  | Outlook folders + categories                          | Labels map to folders (primary use) or categories (tags)                  | Medium   | S          |
| 3   | Gmail filters                 | Outlook rules + Exchange transport rules              | Per-user filters to Outlook rules; org-wide to transport rules            | Medium   | M          |
| 4   | Gmail delegation              | Exchange shared mailboxes or full-access permissions  | Re-configure in Exchange Admin Center                                     | High     | S          |
| 5   | Gmail send-as aliases         | Exchange send-as permissions                          | Configure on shared mailbox or distribution group                         | High     | S          |
| 6   | Gmail confidential mode       | Outlook message encryption (OME) + sensitivity labels | OME provides encryption; sensitivity labels provide persistent protection | High     | S          |
| 7   | Gmail add-ons                 | Outlook add-ins (Office Store)                        | Rebuild or find equivalent add-ins                                        | Medium   | M          |
| 8   | Gmail offline mode            | Outlook desktop offline mode + Outlook PWA offline    | Desktop Outlook has full offline; web has limited offline                 | High     | XS         |
| 9   | Gmail multi-send (mail merge) | Outlook + Power Automate or third-party               | No native mail merge in Outlook; Power Automate or tool needed            | Low      | M          |
| 10  | Google Chat (1:1 and group)   | Microsoft Teams chat                                  | Workflow migration; no chat history migration                             | High     | S          |
| 11  | Google Spaces (channels)      | Microsoft Teams channels                              | Map Spaces to Teams channels; recreate structure                          | High     | M          |
| 12  | Google Meet (video)           | Microsoft Teams meetings                              | Workflow migration; train users on Teams meeting features                 | High     | S          |
| 13  | Google Meet recording         | Teams meeting recording                               | Recordings auto-save to OneDrive/SharePoint                               | High     | XS         |
| 14  | Google Meet transcription     | Teams transcription + Copilot recap                   | Teams includes transcription; Copilot adds meeting summary                | High     | XS         |
| 15  | Google Meet breakout rooms    | Teams breakout rooms                                  | Feature parity                                                            | High     | XS         |
| 16  | Google Voice (phone)          | Teams Phone                                           | Port phone numbers; configure calling plans or direct routing             | High     | L          |

---

## 2. File storage and collaboration

| #   | Google Workspace feature      | M365 equivalent                               | Migration path                                                         | Fidelity | Complexity |
| --- | ----------------------------- | --------------------------------------------- | ---------------------------------------------------------------------- | -------- | ---------- |
| 17  | Google Drive (personal)       | OneDrive for Business                         | Migration Manager for Google Workspace                                 | High     | S          |
| 18  | Google Drive (shared drives)  | SharePoint document libraries                 | Migration Manager; shared drives map to SharePoint sites               | High     | M          |
| 19  | Google Drive file sharing     | OneDrive/SharePoint sharing                   | Permission mapping during Migration Manager migration                  | High     | S          |
| 20  | Google Drive external sharing | SharePoint external sharing                   | Re-configure external sharing policies in SharePoint admin             | High     | S          |
| 21  | Google Drive link sharing     | OneDrive/SharePoint link sharing              | Anyone, organization, specific people link types map directly          | High     | XS         |
| 22  | Google Drive storage quotas   | OneDrive storage quotas (1 TB default)        | Admin configuration in SharePoint admin center                         | High     | XS         |
| 23  | Google Drive activity feed    | OneDrive activity + SharePoint activity       | Feature parity; file activity tracked per-user and per-site            | High     | XS         |
| 24  | Google Drive search           | OneDrive/SharePoint search + Microsoft Search | Microsoft Search covers all M365 content (email, files, Teams, people) | High     | XS         |
| 25  | Google Drive offline access   | OneDrive Files On-Demand + sync client        | OneDrive sync provides full offline with smart sync                    | High     | XS         |
| 26  | Google Drive version history  | OneDrive/SharePoint version history           | Automatic version history with configurable retention                  | High     | XS         |
| 27  | Google Drive DLP              | Microsoft Purview DLP                         | Purview DLP covers OneDrive, SharePoint, Exchange, Teams, endpoints    | High     | M          |

---

## 3. Productivity applications

| #   | Google Workspace feature                  | M365 equivalent                             | Migration path                                                              | Fidelity | Complexity |
| --- | ----------------------------------------- | ------------------------------------------- | --------------------------------------------------------------------------- | -------- | ---------- |
| 28  | Google Docs                               | Word (web + desktop)                        | Automatic conversion during Drive migration (.gdoc to .docx)                | High     | XS         |
| 29  | Google Sheets                             | Excel (web + desktop)                       | Automatic conversion (.gsheet to .xlsx); formula compatibility high         | High     | S          |
| 30  | Google Slides                             | PowerPoint (web + desktop)                  | Automatic conversion (.gslides to .pptx)                                    | High     | XS         |
| 31  | Google Forms                              | Microsoft Forms                             | Manual rebuild; no automated migration                                      | Medium   | M          |
| 32  | Google Drawings                           | Visio Online or PowerPoint shapes           | Export as image; rebuild in Visio or PowerPoint                             | Low      | M          |
| 33  | Google Sites                              | SharePoint Online sites                     | Manual rebuild; third-party tools available (CloudM, AvePoint)              | Medium   | L          |
| 34  | Google Keep (notes)                       | Microsoft Sticky Notes or OneNote           | Manual migration; export Keep to Google Takeout, import to OneNote          | Medium   | S          |
| 35  | Google Jamboard                           | Microsoft Whiteboard                        | Workflow migration; no data migration                                       | High     | XS         |
| 36  | Google Docs real-time co-authoring        | Word/Excel/PowerPoint co-authoring          | Feature parity in web apps; desktop co-authoring with auto-save             | High     | XS         |
| 37  | Google Docs commenting                    | Word/Excel/PowerPoint commenting            | Feature parity; @mentions, resolve, reply                                   | High     | XS         |
| 38  | Google Docs suggesting mode               | Word Track Changes                          | Track Changes is more mature; suggesting mode maps directly                 | High     | XS         |
| 39  | Google Sheets Apps Script                 | Excel VBA + Office Scripts + Power Automate | Manual migration; Apps Script to VBA/Office Scripts requires rewrite        | Low      | L          |
| 40  | Google Sheets connected sheets (BigQuery) | Excel Power Query + Power BI + Fabric       | Power Query connects to 100+ data sources; Fabric for large-scale analytics | High     | M          |
| 41  | Google Sheets pivot tables                | Excel PivotTables                           | Feature parity; Excel PivotTables are more powerful                         | High     | XS         |
| 42  | Google Slides speaker notes               | PowerPoint speaker notes                    | Feature parity                                                              | High     | XS         |

---

## 4. Calendar and scheduling

| #   | Google Workspace feature          | M365 equivalent              | Migration path                                                         | Fidelity | Complexity |
| --- | --------------------------------- | ---------------------------- | ---------------------------------------------------------------------- | -------- | ---------- |
| 43  | Google Calendar                   | Outlook Calendar             | Google Workspace migration in EAC (migrates events + recurring events) | High     | S          |
| 44  | Google Calendar resource booking  | Exchange room mailboxes      | Recreate rooms in Exchange admin; configure booking policies           | High     | M          |
| 45  | Google Calendar delegation        | Outlook Calendar delegation  | Re-configure delegate permissions                                      | High     | S          |
| 46  | Google Calendar appointment slots | Microsoft Bookings           | Bookings provides richer scheduling with customer-facing pages         | High     | S          |
| 47  | Google Calendar out-of-office     | Outlook automatic replies    | Feature parity                                                         | High     | XS         |
| 48  | Google Contacts                   | Outlook Contacts             | Google Workspace migration in EAC                                      | High     | XS         |
| 49  | Google Directory (GAL)            | Exchange Global Address List | Auto-populated from Entra ID                                           | High     | XS         |

---

## 5. Administration and security

| #   | Google Workspace feature          | M365 equivalent                            | Migration path                                                                               | Fidelity | Complexity |
| --- | --------------------------------- | ------------------------------------------ | -------------------------------------------------------------------------------------------- | -------- | ---------- |
| 50  | Google Admin Console              | M365 Admin Center + Entra Admin Center     | Policy recreation; no automated migration                                                    | High     | M          |
| 51  | Google Organizational Units (OUs) | Entra ID groups + administrative units     | Map OUs to Entra groups for policy assignment                                                | High     | M          |
| 52  | Google Workspace admin roles      | M365 admin roles + Entra PIM               | Map roles; Entra PIM adds just-in-time access                                                | High     | M          |
| 53  | Google Workspace audit logs       | Microsoft 365 audit logs + Azure Monitor   | Unified audit log covers all M365 services; 1-10 year retention                              | High     | S          |
| 54  | Google Workspace DLP              | Microsoft Purview DLP                      | Purview DLP covers email, files, Teams, endpoints; 300+ sensitive info types                 | High     | M          |
| 55  | Google Vault (archival)           | Microsoft Purview (retention + eDiscovery) | Export Vault data; recreate retention policies in Purview                                    | High     | M          |
| 56  | Google Vault (legal hold)         | Purview eDiscovery hold                    | Recreate legal holds; export and import held data                                            | High     | M          |
| 57  | Google Vault (eDiscovery search)  | Purview eDiscovery (Standard + Premium)    | Purview eDiscovery is significantly more capable (review sets, analytics, predictive coding) | High     | M          |
| 58  | Google Workspace data regions     | M365 Multi-Geo + data residency            | Configure Multi-Geo for data residency requirements                                          | High     | M          |
| 59  | Google Context-Aware Access       | Entra Conditional Access                   | Entra CA is more granular: device compliance, risk-based, session controls                   | High     | M          |
| 60  | Google Endpoint Management        | Microsoft Intune                           | Intune is significantly more capable; full MDM/MAM across all platforms                      | High     | L          |
| 61  | Google Cloud Identity (IdP)       | Microsoft Entra ID                         | SAML/OIDC migration; Entra provides PIM, identity governance, app proxy                      | High     | L          |
| 62  | Google 2-Step Verification        | Entra MFA (Microsoft Authenticator)        | Re-enroll users in Microsoft Authenticator; support FIDO2, passwordless                      | High     | M          |

---

## 6. AI and advanced features

| #   | Google Workspace feature | M365 equivalent                          | Migration path                                                           | Fidelity | Complexity |
| --- | ------------------------ | ---------------------------------------- | ------------------------------------------------------------------------ | -------- | ---------- |
| 63  | Gemini in Gmail          | Copilot in Outlook                       | Deploy Copilot license; train users                                      | High     | S          |
| 64  | Gemini in Docs           | Copilot in Word                          | Deploy Copilot license; train users                                      | High     | S          |
| 65  | Gemini in Sheets         | Copilot in Excel                         | Deploy Copilot license; train users; Copilot adds Python in Excel        | High     | S          |
| 66  | Gemini in Slides         | Copilot in PowerPoint                    | Deploy Copilot license; train users; Copilot creates from Word docs      | High     | S          |
| 67  | Gemini in Meet           | Copilot in Teams                         | Teams Copilot provides meeting recap, action items, catch-up             | High     | S          |
| 68  | Google Duet AI (code)    | GitHub Copilot                           | Separate product; GitHub Copilot for code assistance                     | High     | S          |
| 69  | NotebookLM               | Copilot (Business Chat) + Copilot Studio | Business Chat queries across M365 data; Copilot Studio for custom agents | Medium   | M          |

---

## 7. Analytics, data, and platform (CSA-in-a-Box advantage)

| #   | Google Workspace feature     | M365 + CSA-in-a-Box equivalent                      | Migration path                                              | Fidelity | Complexity |
| --- | ---------------------------- | --------------------------------------------------- | ----------------------------------------------------------- | -------- | ---------- |
| 70  | Looker Studio (dashboards)   | Power BI (Direct Lake, paginated reports, embedded) | Rebuild reports in Power BI; significant capability upgrade | High     | M          |
| 71  | BigQuery (data warehouse)    | Microsoft Fabric Warehouse + Databricks SQL         | CSA-in-a-Box deploys production-ready lakehouse             | High     | L          |
| 72  | Google Cloud Storage (GCS)   | ADLS Gen2 + OneLake                                 | CSA-in-a-Box standardizes on Delta Lake format              | High     | M          |
| 73  | Google Data Catalog          | Microsoft Purview Data Catalog                      | Purview provides unified governance across M365 + Azure     | High     | M          |
| 74  | Vertex AI                    | Azure OpenAI + Azure ML + AI Foundry                | CSA-in-a-Box provides AI integration patterns               | High     | L          |
| 75  | AppSheet                     | Power Apps + Power Automate                         | Rebuild apps; Power Platform is significantly more capable  | High     | L          |
| 76  | Google Workspace Marketplace | Microsoft AppSource + Teams App Store               | Find equivalent apps; ecosystem is larger on Microsoft      | High     | M          |

---

## Migration complexity summary

| Complexity                                 | Count | Examples                                                                      |
| ------------------------------------------ | ----- | ----------------------------------------------------------------------------- |
| **XS** (automated, minimal config)         | 18    | Docs conversion, calendar delegation, search, version history                 |
| **S** (straightforward, some manual steps) | 20    | Email migration, Drive migration, Copilot deployment, contact migration       |
| **M** (moderate, requires planning)        | 24    | DLP policy recreation, Vault migration, resource booking, admin roles         |
| **L** (significant, requires rebuild)      | 11    | Apps Script migration, Google Sites rebuild, identity migration, Intune setup |
| **XL** (major project)                     | 3     | Phone system migration, complex AppSheet apps, custom integrations            |

### Key takeaways

1. **60% of features (38 of 76) migrate at XS or S complexity** --- automated or straightforward.
2. **Email and Drive migration is well-supported** by Microsoft native tools and FastTrack.
3. **The hardest migrations are Apps Script, Google Sites, and identity** --- plan these early.
4. **AI features (Gemini to Copilot) are a capability upgrade**, not a downgrade. Copilot provides deeper cross-app intelligence.
5. **Analytics features (Looker Studio to Power BI, BigQuery to Fabric)** represent the biggest capability leap. CSA-in-a-Box makes this a structured deployment rather than a custom build.

---

## Gap analysis: Google features with no direct M365 equivalent

| Google feature                       | Workaround in M365                                   | Notes                                                         |
| ------------------------------------ | ---------------------------------------------------- | ------------------------------------------------------------- |
| Google Keep (tight integration)      | OneNote + Sticky Notes                               | OneNote is more powerful but heavier; Sticky Notes is simpler |
| Google Drawings (standalone)         | Visio Online (separate license) or PowerPoint shapes | Visio requires additional license for full features           |
| Gmail multi-send (native mail merge) | Power Automate + Outlook or third-party              | No native mail merge in Outlook                               |
| Google Classroom                     | Microsoft Teams for Education                        | Feature parity for education scenarios                        |
| Google Currents (deprecated)         | Viva Engage (Yammer)                                 | Viva Engage is the enterprise social network                  |

---

## M365 features with no Google Workspace equivalent

| M365 feature                             | Capability                                               | Value                          |
| ---------------------------------------- | -------------------------------------------------------- | ------------------------------ |
| **Copilot Business Chat**                | Natural language queries across all M365 data            | No Google equivalent           |
| **Purview Insider Risk Management**      | Anomaly detection for data exfiltration                  | No Google equivalent           |
| **Purview Communication Compliance**     | Policy-based communication monitoring                    | No Google equivalent           |
| **Entra Privileged Identity Management** | Just-in-time admin access with approval workflows        | No Google equivalent           |
| **Power Automate Desktop (RPA)**         | Desktop automation with attended/unattended bots         | No Google equivalent           |
| **Teams Phone**                          | Full cloud PBX with direct routing                       | Google Voice is limited        |
| **Microsoft Bookings**                   | Customer-facing scheduling pages                         | No Google equivalent           |
| **Viva suite**                           | Employee experience platform (learning, insights, goals) | No Google equivalent           |
| **Power BI Direct Lake**                 | Sub-second BI over Delta Lake without import             | No Google equivalent           |
| **Microsoft Fabric**                     | Unified analytics platform                               | Requires separate GCP products |
| **Copilot Studio**                       | Custom AI agent builder                                  | AppSheet AI is limited         |
| **Windows Autopilot**                    | Zero-touch device provisioning                           | ChromeOS only for Google       |
