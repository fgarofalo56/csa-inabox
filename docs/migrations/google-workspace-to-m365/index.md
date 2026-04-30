# Google Workspace to Microsoft 365 Migration Center

**The definitive resource for migrating from Google Workspace to Microsoft 365, Microsoft Copilot, and the CSA-in-a-Box data and AI platform.**

---

## Who this is for

This migration center serves IT administrators, M365 architects, change management leads, federal CIOs, and enterprise decision-makers who are evaluating or executing a migration from Google Workspace (Gmail, Drive, Docs, Sheets, Slides, Meet, Chat, Calendar, Sites, Forms, AppSheet, Vault, Admin Console) to Microsoft 365. Whether you are consolidating identity onto Entra ID, deploying Microsoft 365 Copilot as a competitive differentiator, addressing federal compliance requirements that Google Workspace cannot meet, or extending productivity into enterprise analytics and AI through CSA-in-a-Box, these resources provide the evidence, patterns, and step-by-step guidance to execute confidently.

**Market context:** Google Workspace serves over 9 million businesses. Microsoft FastTrack covers Gmail and Drive migration at no additional cost for qualifying tenants (150+ seats). Microsoft 365 Copilot is the primary competitive differentiator that Google Workspace cannot match at comparable enterprise depth.

---

## Quick-start decision matrix

| Your situation                                | Start here                                                      |
| --------------------------------------------- | --------------------------------------------------------------- |
| Executive evaluating M365 vs Google Workspace | [Why M365 over Google Workspace](why-m365-over-google.md)       |
| Need cost justification for migration         | [Total Cost of Ownership Analysis](tco-analysis.md)             |
| Need a feature-by-feature comparison          | [Complete Feature Mapping](feature-mapping-complete.md)         |
| Ready to plan a migration                     | [Migration Playbook](../google-workspace-to-m365.md)            |
| Federal/government-specific requirements      | [Federal Migration Guide](federal-migration-guide.md)           |
| Migrating Gmail to Exchange Online            | [Email Migration Guide](email-migration.md)                     |
| Migrating Google Drive to OneDrive/SharePoint | [Drive Migration Guide](drive-migration.md)                     |
| Migrating Docs/Sheets/Slides to Office        | [Docs Migration Guide](docs-migration.md)                       |
| Migrating Calendar and Contacts               | [Calendar & Contacts Migration](calendar-contacts-migration.md) |
| Migrating Meet/Chat/Spaces to Teams           | [Collaboration Migration](collaboration-migration.md)           |
| Migrating Google Identity to Entra ID         | [Identity Migration](identity-migration.md)                     |
| Comparing Gemini vs Copilot capabilities      | [Benchmarks & Capabilities](benchmarks.md)                      |

---

## Strategic resources

These documents provide the business case, cost analysis, and strategic framing for decision-makers.

| Document                                                  | Audience                | Description                                                                                                                                                |
| --------------------------------------------------------- | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Why M365 over Google Workspace](why-m365-over-google.md) | CIO / CDO / Board       | Executive white paper covering enterprise compliance, Copilot AI, identity, endpoint management, Power Platform, Fabric analytics, and security advantages |
| [Total Cost of Ownership Analysis](tco-analysis.md)       | CFO / CIO / Procurement | Detailed pricing comparison: Google Workspace Business/Enterprise vs M365 E3/E5/F1, including add-on costs and hidden gaps                                 |
| [Complete Feature Mapping](feature-mapping-complete.md)   | CTO / IT Architecture   | 50+ Google Workspace features mapped to M365 equivalents with migration complexity ratings                                                                 |

---

## Migration guides

Domain-specific deep dives covering every aspect of a Google Workspace-to-M365 migration.

| Guide                                                 | Google Workspace capability                           | Microsoft 365 destination                                    |
| ----------------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------ |
| [Email Migration](email-migration.md)                 | Gmail, labels, filters, delegation, confidential mode | Exchange Online, Outlook, mail flow rules                    |
| [Drive Migration](drive-migration.md)                 | Google Drive, shared drives, file sharing             | OneDrive for Business, SharePoint document libraries         |
| [Docs Migration](docs-migration.md)                   | Google Docs, Sheets, Slides, Apps Script              | Word, Excel, PowerPoint, VBA, Office Scripts, Power Automate |
| [Calendar & Contacts](calendar-contacts-migration.md) | Google Calendar, Contacts, room resources             | Outlook Calendar, Exchange contacts, room mailboxes          |
| [Collaboration Migration](collaboration-migration.md) | Google Meet, Chat, Spaces, Groups                     | Microsoft Teams, M365 Groups, Teams Phone                    |
| [Identity Migration](identity-migration.md)           | Google Cloud Identity, SAML SSO, SCIM, MFA            | Entra ID, Conditional Access, Microsoft Authenticator        |

---

## Tutorials

Step-by-step walkthroughs with PowerShell examples, screenshots descriptions, and validation steps.

| Tutorial                                                  | Description                                                                                                          | Duration                         |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| [Gmail to Exchange Online](tutorial-gmail-to-exo.md)      | Configure Google Workspace migration in Exchange admin center, create migration batch, monitor, complete, update DNS | 2-4 hours setup + migration time |
| [Google Drive to OneDrive](tutorial-drive-to-onedrive.md) | Configure Migration Manager, scan and assess, run migration, validate permissions, communicate to users              | 2-3 hours setup + migration time |

---

## Technical references

| Document                                                | Description                                                                                                 |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| [Complete Feature Mapping](feature-mapping-complete.md) | Every Google Workspace feature mapped to its M365 equivalent with migration complexity and fidelity ratings |
| [Benchmarks & Capabilities](benchmarks.md)              | Feature parity, collaboration, mobile, offline, compliance, and AI capability comparisons                   |
| [Migration Playbook](../google-workspace-to-m365.md)    | The end-to-end playbook with phased timeline, pre-migration checklist, and risk register                    |

---

## Government and federal

| Document                                              | Description                                                                                                                                 |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| [Federal Migration Guide](federal-migration-guide.md) | Google Workspace FedRAMP limitations vs M365 GCC/GCC-High, data residency, IL4/IL5 coverage, CMMC mapping, and federal procurement guidance |

---

## Best practices and adoption

| Document                            | Description                                                                                                                                |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| [Best Practices](best-practices.md) | User training, change management, champion network, phased rollout, communication templates, Copilot adoption, and CSA-in-a-Box enablement |

---

## How CSA-in-a-Box fits

CSA-in-a-Box extends the Microsoft 365 migration into a comprehensive enterprise data, analytics, and AI platform that Google Workspace fundamentally cannot deliver. While Google Workspace is a productivity suite, Microsoft 365 + CSA-in-a-Box is an enterprise platform:

- **Microsoft Fabric + Power BI** --- Enterprise analytics with Direct Lake, real-time intelligence, and AI-powered insights that replace Looker Studio and exceed BigQuery capabilities for most enterprise workloads. CSA-in-a-Box deploys a production-ready Fabric lakehouse with domain-based data mesh architecture.
- **Azure AI + Copilot Studio** --- Custom AI agents, document intelligence, and knowledge mining that extend Copilot beyond M365 into business-specific workflows. CSA-in-a-Box provides AI integration patterns through `csa_platform/ai_integration/`.
- **Microsoft Purview** --- Unified data governance across M365 content, Azure data estate, and on-premises sources. Data classification, sensitivity labels, DLP policies, and data lineage that Google Vault cannot approach. CSA-in-a-Box automates Purview classification through `csa_platform/purview/`.
- **Azure Databricks** --- Enterprise-grade Spark processing for data engineering and data science workloads. CSA-in-a-Box provides Unity Catalog integration, Delta Lake standardization, and dbt-based transformation patterns.
- **Data mesh architecture** --- Domain-based data ownership with federated governance. CSA-in-a-Box implements this through domain folders (`domains/`), shared infrastructure (`csa_platform/`), and data marketplace APIs (`csa_platform/data_marketplace/`).

Google Workspace offers no path to these capabilities. BigQuery and Looker Studio are separate Google Cloud Platform products with separate billing, separate identity, and separate governance. Microsoft 365 + Fabric + Azure AI is a unified estate under one identity (Entra ID), one governance framework (Purview), and one billing relationship (Enterprise Agreement).

---

## Migration timeline

### Typical timeline for 1,000-5,000 user organization

```
Week 1-4:    Assessment + FastTrack engagement + pilot planning
Week 5-8:    Pilot migration (50-100 IT users) + validation
Week 9-20:   Batch migration (departments of 200-500 users)
Week 21-24:  Coexistence validation + edge case resolution
Week 25-26:  DNS cutover + Google Workspace decommission
Week 27+:    Copilot deployment + Power BI + CSA-in-a-Box enablement
```

### Key milestones

| Milestone            | Target week | Success criteria                               |
| -------------------- | ----------- | ---------------------------------------------- |
| FastTrack engagement | Week 1      | FastTrack request submitted, engineer assigned |
| Pilot complete       | Week 8      | 50-100 users migrated, < 5 P1 issues           |
| 50% users migrated   | Week 14     | Half of org on M365, coexistence stable        |
| 100% users migrated  | Week 20     | All mailboxes and drives migrated              |
| MX cutover           | Week 25     | Mail flowing to Exchange Online                |
| Google decommission  | Week 26     | Google Workspace licenses canceled             |
| Copilot live         | Week 30     | Copilot deployed to first wave users           |

---

## FastTrack program

Microsoft FastTrack provides **free** migration assistance for qualifying tenants:

- **Eligibility:** 150+ seats of M365 E3, E5, Business Premium, or F1/F3
- **Services included:** Gmail migration, Google Drive migration, deployment guidance, adoption support
- **Cost:** $0 --- included with qualifying licenses
- **Engagement:** Visit [fasttrack.microsoft.com](https://fasttrack.microsoft.com) or contact your Microsoft account team

!!! note "FastTrack is the recommended starting point"
For organizations with 150+ seats, FastTrack should be engaged before purchasing any third-party migration tools. FastTrack engineers handle the migration infrastructure setup, batch execution, and post-migration validation at no cost. Third-party tools (BitTitan, Quest, AvePoint) add value only for complex scenarios that exceed FastTrack's scope.

---

## Getting started

1. **Read the executive brief:** [Why M365 over Google Workspace](why-m365-over-google.md) --- build the business case.
2. **Run the TCO analysis:** [Total Cost of Ownership](tco-analysis.md) --- quantify the financial case.
3. **Complete the playbook checklist:** [Migration Playbook](../google-workspace-to-m365.md) --- assess your environment.
4. **Engage FastTrack:** Submit your request at [fasttrack.microsoft.com](https://fasttrack.microsoft.com).
5. **Start the pilot:** Use the [Gmail tutorial](tutorial-gmail-to-exo.md) and [Drive tutorial](tutorial-drive-to-onedrive.md) to migrate your IT team first.
6. **Deploy Copilot:** After migration, [Copilot adoption](best-practices.md#copilot-adoption-post-migration) is the key value driver.
7. **Enable CSA-in-a-Box:** Extend the M365 investment into [enterprise analytics and AI](best-practices.md#csa-in-a-box-data-and-ai-enablement).
