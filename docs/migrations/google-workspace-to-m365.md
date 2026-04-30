# Migrating from Google Workspace to Microsoft 365 + CSA-in-a-Box

**Status:** Authored 2026-04-30
**Audience:** Federal CIO / CDO / IT Directors / M365 Architects / Change Management Leads managing Google Workspace environments and evaluating or executing a migration to Microsoft 365 --- commercial, GCC, or GCC-High.
**Scope:** The complete Google Workspace estate: Gmail, Google Drive, Docs/Sheets/Slides, Meet, Chat, Calendar, Contacts, Sites, Forms, AppSheet, Admin Console, Google Vault, and identity (Google Cloud Identity). Ancillary services (Looker Studio, BigQuery, Google Cloud Platform) are addressed where they touch the productivity suite.

---

!!! tip "Expanded Migration Center Available"
This playbook is the core migration reference. For the complete Google Workspace-to-Microsoft 365 migration package --- including executive briefs, deep-dive guides, tutorials, benchmarks, and federal-specific guidance --- visit the **[Google Workspace to M365 Migration Center](google-workspace-to-m365/index.md)**.

    **Quick links:**

    - [Why M365 over Google Workspace (Executive Brief)](google-workspace-to-m365/why-m365-over-google.md)
    - [Total Cost of Ownership Analysis](google-workspace-to-m365/tco-analysis.md)
    - [Complete Feature Mapping (50+ features)](google-workspace-to-m365/feature-mapping-complete.md)
    - [Federal Migration Guide](google-workspace-to-m365/federal-migration-guide.md)
    - [Tutorials & Walkthroughs](google-workspace-to-m365/index.md#tutorials)
    - [Benchmarks & Capabilities](google-workspace-to-m365/benchmarks.md)
    - [Best Practices](google-workspace-to-m365/best-practices.md)

## 1. Executive summary

Google Workspace is a capable cloud productivity suite serving over 9 million businesses worldwide. The reasons to migrate to Microsoft 365 are rarely about email alone --- they are about enterprise capability convergence: unified identity through Entra ID, endpoint management through Intune, compliance and eDiscovery through Microsoft Purview, AI-powered productivity through Microsoft 365 Copilot, and the analytics and data platform capabilities that CSA-in-a-Box delivers through Microsoft Fabric, Databricks, Power BI, and Azure AI.

CSA-in-a-Box on Azure inherits **FedRAMP High** through Azure Government, **CMMC 2.0 Level 2** compliance mappings, and **HIPAA Security Rule** controls, and ships a reference architecture that extends the Microsoft 365 ecosystem into enterprise data, analytics, and AI capabilities that Google Workspace fundamentally cannot match.

This playbook is honest. Google Workspace excels in simplicity, browser-based collaboration speed, and cost-effective small-business deployments. Where Google Workspace falls short --- and where the migration value proposition crystallizes --- is enterprise governance, compliance depth, endpoint management, AI integration breadth, and the leap from productivity to analytics and data platform capabilities.

### Why now

| Driver                     | Detail                                                                                                                            |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| **Microsoft 365 Copilot**  | GPT-4-powered AI across Word, Excel, PowerPoint, Outlook, Teams --- no Google Workspace equivalent at comparable enterprise depth |
| **FastTrack program**      | Microsoft funds Gmail and Drive migration for qualifying tenants (150+ seats) at no additional cost                               |
| **Compliance gap**         | Google Workspace lacks GCC-High and DoD IL4/IL5 environments; M365 GCC-High is FedRAMP High authorized                            |
| **Endpoint management**    | Intune provides unified MDM/MAM for Windows, macOS, iOS, Android --- Google endpoint management is limited                        |
| **Data platform**          | CSA-in-a-Box + Fabric + Power BI + Azure AI extend the M365 investment into analytics capabilities Google cannot deliver          |
| **Identity consolidation** | Entra ID provides SSO, Conditional Access, PIM, and identity governance --- Google Cloud Identity is narrower in scope            |

---

## 2. Migration scope overview

### 2.1 Workloads in scope

| Google Workspace service | Microsoft 365 destination                 | Migration method                                     |
| ------------------------ | ----------------------------------------- | ---------------------------------------------------- |
| Gmail                    | Exchange Online                           | Google Workspace migration in EAC / IMAP / FastTrack |
| Google Drive (personal)  | OneDrive for Business                     | Migration Manager for Google Workspace               |
| Google Drive (shared)    | SharePoint Online document libraries      | Migration Manager for Google Workspace               |
| Google Docs              | Word Online / Word desktop                | Automatic conversion during Drive migration          |
| Google Sheets            | Excel Online / Excel desktop              | Automatic conversion during Drive migration          |
| Google Slides            | PowerPoint Online / PowerPoint desktop    | Automatic conversion during Drive migration          |
| Google Calendar          | Outlook Calendar                          | Google Workspace migration in EAC                    |
| Google Contacts          | Outlook Contacts                          | Google Workspace migration in EAC                    |
| Google Meet              | Microsoft Teams                           | Workflow migration (no data migration)               |
| Google Chat + Spaces     | Microsoft Teams channels + chat           | Workflow migration (no data migration)               |
| Google Sites             | SharePoint Online sites                   | Manual rebuild / third-party tools                   |
| Google Forms             | Microsoft Forms                           | Manual rebuild                                       |
| AppSheet                 | Power Apps                                | Re-implementation                                    |
| Looker Studio            | Power BI                                  | Report rebuild (significant capability upgrade)      |
| Google Vault             | Microsoft Purview (eDiscovery, retention) | Policy recreation + data export/import               |
| Google Admin Console     | Microsoft 365 Admin Center + Entra ID     | Policy recreation                                    |
| Google Cloud Identity    | Microsoft Entra ID                        | SAML/SCIM migration                                  |

### 2.2 Migration phases

| Phase               | Duration   | Activities                                                                                            |
| ------------------- | ---------- | ----------------------------------------------------------------------------------------------------- |
| **Assessment**      | 2-4 weeks  | Inventory Google Workspace environment, identify dependencies, license mapping, FastTrack eligibility |
| **Pilot**           | 2-4 weeks  | Migrate 50-100 pilot users, validate email/Drive/Calendar migration, test Copilot, gather feedback    |
| **Batch migration** | 4-12 weeks | Migrate remaining users in department-based batches, 200-500 users per batch                          |
| **Coexistence**     | 2-4 weeks  | Run Google Workspace and M365 in parallel, validate all workflows, address edge cases                 |
| **Cutover**         | 1-2 weeks  | Update DNS MX records, decommission Google Workspace, final validation                                |
| **Optimization**    | Ongoing    | Copilot adoption, Power BI deployment, CSA-in-a-Box data platform enablement                          |

**Total timeline:** 12-26 weeks for a 1,000-5,000 user organization.

---

## 3. Pre-migration checklist

### Infrastructure inventory

- [ ] Export Google Workspace Admin Console user list with license assignments.
- [ ] Document all Google Groups: membership, purpose, access grants.
- [ ] Inventory shared drives: owner, size, file count, access patterns.
- [ ] Inventory Google Sites: count, complexity, usage analytics.
- [ ] Document third-party apps authorized via Google OAuth.
- [ ] Export Google Vault retention policies and legal holds.
- [ ] Document all Google Workspace Marketplace apps in use.
- [ ] Export Gmail routing rules, filters, and delegation settings.
- [ ] Document domain aliases and send-as configurations.
- [ ] Inventory Google Forms with active response collection.

### Identity and access

- [ ] Document all domains verified in Google Workspace (primary + aliases).
- [ ] Inventory SAML SSO integrations using Google as IdP.
- [ ] Document SCIM provisioning connections to third-party apps.
- [ ] Export MFA enrollment status for all users.
- [ ] Document Organizational Units (OUs) and their policy assignments.
- [ ] Map Google Workspace admin roles to M365 admin roles.
- [ ] Identify service accounts and their API access.

### Compliance review

- [ ] Confirm target M365 environment meets compliance requirements (commercial, GCC, GCC-High).
- [ ] Identify data residency requirements and map to M365 data location options.
- [ ] Document active legal holds in Google Vault and plan preservation.
- [ ] Export eDiscovery search results before migration.
- [ ] Map Google Workspace DLP rules to Microsoft Purview DLP policies.
- [ ] Review retention label requirements for Microsoft Purview.

### Cost baseline

- [ ] Export current Google Workspace license costs by SKU (Business Starter/Standard/Plus, Enterprise Standard/Plus).
- [ ] Document add-on costs: Google Vault, Endpoint Management, AppSheet, additional Drive storage.
- [ ] Identify third-party tools filling gaps (MDM, DLP, SIEM, backup).
- [ ] Calculate total annual Google Workspace spend including all add-ons and third-party tools.

---

## 4. Email migration: Gmail to Exchange Online

### Migration methods

| Method                               | Best for                                           | Throughput          | Limitations                                                 |
| ------------------------------------ | -------------------------------------------------- | ------------------- | ----------------------------------------------------------- |
| **Google Workspace migration (EAC)** | Full-fidelity migration with calendar and contacts | 2-10 GB/mailbox/day | Requires Google service account with domain-wide delegation |
| **IMAP migration**                   | Simple email-only migration                        | 1-5 GB/mailbox/day  | No calendar, contacts, or Drive; labels partially mapped    |
| **FastTrack**                        | 150+ seat tenants                                  | Microsoft-managed   | Free; Microsoft runs the migration                          |
| **Third-party tools**                | Complex scenarios (BitTitan, Quest, AvePoint)      | Varies              | Additional cost; more control over scheduling               |

### Gmail-specific considerations

- **Labels vs folders:** Gmail labels are multi-assignment tags; Outlook uses a folder hierarchy. Labels map to Outlook categories for simple labels, or folders for labels used as filing structure.
- **Filters to mail flow rules:** Gmail filters map to Exchange transport rules for org-wide rules, or Outlook rules for per-user rules.
- **Delegation:** Gmail delegation maps to Exchange shared mailboxes or full-access permissions.
- **Send-as aliases:** Map to Exchange send-as permissions on shared mailboxes or distribution groups.
- **Confidential mode:** Gmail confidential mode messages cannot be migrated; content must be exported separately.

### DNS cutover (MX records)

```bash
# Before cutover: Google MX records
# Priority 1: ASPMX.L.GOOGLE.COM
# Priority 5: ALT1.ASPMX.L.GOOGLE.COM

# After cutover: Microsoft 365 MX records
# Priority 0: contoso-com.mail.protection.outlook.com
# TTL: Reduce to 300 seconds 48 hours before cutover
```

---

## 5. Drive migration: Google Drive to OneDrive/SharePoint

### Migration Manager for Google Workspace

Migration Manager is the recommended tool for Google Drive to OneDrive/SharePoint migration. It handles:

- Personal Google Drive to OneDrive for Business (1:1 mapping)
- Shared Google Drives to SharePoint document libraries
- Automatic file conversion (Docs to Word, Sheets to Excel, Slides to PowerPoint)
- Permission mapping (Google sharing to SharePoint permissions)
- Incremental sync during coexistence period

### File conversion matrix

| Google format   | Microsoft format   | Fidelity notes                                              |
| --------------- | ------------------ | ----------------------------------------------------------- |
| Google Docs     | .docx (Word)       | High fidelity; some advanced formatting may shift           |
| Google Sheets   | .xlsx (Excel)      | High fidelity; Apps Script macros require manual conversion |
| Google Slides   | .pptx (PowerPoint) | High fidelity; embedded videos may need re-linking          |
| Google Forms    | N/A                | Must be rebuilt in Microsoft Forms                          |
| Google Drawings | N/A                | Export as PNG/SVG and re-embed                              |
| Google Sites    | N/A                | Rebuild in SharePoint                                       |

### Shared Drive mapping strategy

| Google Workspace structure    | Microsoft 365 destination                  | Notes                                                       |
| ----------------------------- | ------------------------------------------ | ----------------------------------------------------------- |
| Shared Drive (department)     | SharePoint site document library           | Each shared drive becomes a document library in a team site |
| Shared Drive (project)        | Teams channel folder or SharePoint library | Project-scoped shared drives map to Teams                   |
| Personal Drive                | OneDrive for Business                      | 1:1 user mapping                                            |
| Drive files shared externally | SharePoint external sharing                | Review and re-grant external sharing permissions            |

---

## 6. Identity migration: Google to Entra ID

### Approach

For most organizations, identity migration follows one of two paths:

1. **Google as source, Entra ID as target:** Provision users in Entra ID (manually, via CSV import, or via Azure AD Connect from on-premises AD), then migrate authentication from Google to Entra ID. This is the most common path.

2. **Coexistence period:** Configure SAML federation between Google and Entra ID so users can authenticate to both platforms during migration. Google Cloud Identity acts as a secondary IdP until all applications are migrated.

### Key identity tasks

- [ ] Provision all users in Entra ID with matching UPN to Google email.
- [ ] Configure MFA in Entra ID (Microsoft Authenticator recommended).
- [ ] Migrate Conditional Access policies (Google Context-Aware Access to Entra Conditional Access).
- [ ] Migrate SAML SSO integrations from Google IdP to Entra ID IdP.
- [ ] Migrate SCIM provisioning connections to point at Entra ID.
- [ ] Configure Intune MDM enrollment for managed devices.
- [ ] Disable Google Cloud Identity accounts after full cutover.

---

## 7. Collaboration migration: Meet/Chat to Teams

Google Meet and Google Chat do not support data migration to Teams. The migration is a workflow transition:

- **Google Meet to Teams meetings:** Train users on Teams meeting scheduling, recording, and transcription. Teams offers live captions, breakout rooms, and Copilot meeting summaries.
- **Google Chat to Teams chat:** Chat history does not migrate. Inform users of the cutover date and archive Google Chat history via Google Vault export.
- **Google Spaces to Teams channels:** Map Google Spaces to Teams channels. Create the channel structure before cutover.
- **Google Groups to M365 Groups:** Migrate distribution lists and collaborative inboxes to M365 Groups or shared mailboxes.

---

## 8. How CSA-in-a-Box extends the M365 investment

Migrating from Google Workspace to Microsoft 365 is the first step. CSA-in-a-Box extends the investment into enterprise data, analytics, and AI capabilities that Google Workspace simply does not offer:

| Capability                | Google Workspace                       | M365 + CSA-in-a-Box                                               |
| ------------------------- | -------------------------------------- | ----------------------------------------------------------------- |
| **Enterprise BI**         | Looker Studio (basic dashboards)       | Power BI with Direct Lake, paginated reports, embedded analytics  |
| **Data platform**         | BigQuery (separate GCP product)        | Microsoft Fabric + Databricks + ADLS Gen2 (integrated with M365)  |
| **AI/ML platform**        | Vertex AI (separate GCP product)       | Azure OpenAI + AI Foundry + Copilot Studio (integrated with M365) |
| **Data governance**       | None in Workspace; Data Catalog in GCP | Microsoft Purview (unified across M365 + Azure)                   |
| **Data mesh**             | Not available                          | CSA-in-a-Box reference architecture with domain ownership         |
| **Compliance automation** | Google Vault (basic)                   | Purview compliance: DLP, retention, eDiscovery, insider risk      |
| **Copilot AI**            | Gemini in Workspace (limited)          | M365 Copilot across all apps + Copilot Studio for custom agents   |

**The migration is not just email and files.** It is the entry point to an enterprise platform that spans productivity, security, compliance, analytics, and AI --- all unified under a single identity and governance framework.

---

## 9. Federal considerations

| Consideration  | Google Workspace                                           | Microsoft 365                                             |
| -------------- | ---------------------------------------------------------- | --------------------------------------------------------- |
| FedRAMP High   | Google Workspace is FedRAMP Moderate; **not FedRAMP High** | M365 GCC-High is FedRAMP High authorized                  |
| GCC-High / DoD | **Not available**                                          | Full M365 GCC-High environment                            |
| IL4/IL5        | **Not available**                                          | M365 GCC-High supports IL4/IL5 workloads                  |
| CMMC 2.0       | Limited compliance tooling                                 | Purview Compliance Manager with CMMC assessment templates |
| ITAR           | Limited data residency guarantees                          | Azure Government with data residency commitments          |
| Procurement    | GSA Schedule; limited federal EA options                   | Microsoft Enterprise Agreement with federal terms         |

**For federal agencies and defense industrial base organizations, Google Workspace is not a viable option at GCC-High or DoD IL4/IL5 compliance tiers.** Microsoft 365 GCC-High is the only hyperscaler productivity suite that meets these requirements.

---

## 10. FastTrack program

Microsoft FastTrack provides free migration assistance for qualifying tenants:

- **Eligibility:** 150+ seats of M365 E3, E5, Business Premium, or F1/F3.
- **Scope:** Gmail migration, Google Drive migration, deployment guidance.
- **Cost:** Included with qualifying licenses --- no additional charge.
- **How to engage:** Visit [fasttrack.microsoft.com](https://fasttrack.microsoft.com) or work with your Microsoft account team.

FastTrack engineers will:

1. Assess your Google Workspace environment.
2. Configure the M365 tenant for migration.
3. Run the email and Drive migration batches.
4. Provide post-migration validation support.

---

## 11. Post-migration optimization

### Copilot deployment

After migration, deploy Microsoft 365 Copilot to accelerate adoption:

- **Copilot in Outlook:** Summarize email threads, draft responses, schedule meetings.
- **Copilot in Word:** Generate documents from prompts, rewrite sections, summarize lengthy documents.
- **Copilot in Excel:** Analyze data with natural language, create formulas, generate charts.
- **Copilot in PowerPoint:** Create presentations from outlines or Word documents.
- **Copilot in Teams:** Meeting summaries, action items, catch-up on missed meetings.

### Power BI and Fabric enablement

Leverage CSA-in-a-Box to deploy:

- **Power BI dashboards** connected to M365 data (SharePoint lists, Exchange, Teams usage).
- **Fabric lakehouse** for enterprise analytics beyond what Looker Studio offered.
- **Azure AI integration** for intelligent document processing, custom copilots, and knowledge mining.

---

## 12. Risk register

| Risk                           | Likelihood | Impact | Mitigation                                                                      |
| ------------------------------ | ---------- | ------ | ------------------------------------------------------------------------------- |
| User resistance to change      | High       | High   | Champion network, training program, Copilot as incentive                        |
| Email migration delays         | Medium     | Medium | Start migration early; run incremental sync during coexistence                  |
| File format conversion issues  | Medium     | Low    | Test conversion on sample files; keep Google Workspace active during validation |
| Apps Script dependency         | Medium     | High   | Inventory all Apps Script automations early; plan Power Automate replacements   |
| Third-party OAuth app breakage | Medium     | Medium | Audit all OAuth apps; re-authorize against Entra ID                             |
| MX record propagation delays   | Low        | High   | Reduce TTL 48 hours before cutover; monitor with MXToolbox                      |
| Google Vault legal hold data   | Low        | High   | Export all legal hold data before decommissioning Google Workspace              |

---

## 13. Success metrics

| Metric                     | Target                              | Measurement                               |
| -------------------------- | ----------------------------------- | ----------------------------------------- |
| Email migration completion | 100% of mailboxes                   | Exchange Admin Center migration dashboard |
| Drive migration completion | 100% of files                       | Migration Manager completion report       |
| User adoption (Teams)      | 80% DAU within 30 days              | M365 Usage Analytics                      |
| Copilot usage              | 60% weekly active within 90 days    | Copilot usage dashboard                   |
| Help desk ticket volume    | < 2x baseline during migration week | ServiceNow / help desk reporting          |
| User satisfaction          | > 4.0/5.0 at 60-day survey          | Post-migration survey                     |

---

## Next steps

1. **Assess your environment:** Complete the pre-migration checklist above.
2. **Engage FastTrack:** If eligible (150+ seats), request FastTrack assistance.
3. **Start with the pilot:** Migrate IT department first, then expand.
4. **Explore the Migration Center:** Visit the [Google Workspace to M365 Migration Center](google-workspace-to-m365/index.md) for deep-dive guides, tutorials, and benchmarks.
5. **Plan Copilot and CSA-in-a-Box:** The migration is the beginning --- not the end --- of the M365 journey.
