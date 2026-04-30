# SharePoint Migration: Total Cost of Ownership Analysis

**Status:** Authored 2026-04-30
**Audience:** CFOs, CIOs, procurement officers, and IT finance analysts evaluating the cost case for migrating from SharePoint Server on-premises to SharePoint Online.
**Methodology:** Cost models use publicly available Microsoft licensing, representative infrastructure pricing, and industry-standard labor rates. All numbers are illustrative and should be validated against your specific environment.

---

## How to read this document

This TCO analysis compares the fully loaded cost of operating SharePoint Server on-premises against the cost of SharePoint Online included in Microsoft 365 licensing. The analysis covers three organizational profiles (small, mid-size, large) across a 5-year horizon, including infrastructure, licensing, labor, and opportunity costs that are frequently omitted from vendor-provided calculators.

---

## 1. On-premises SharePoint cost components

### 1.1 Server infrastructure

SharePoint Server farms require dedicated compute, storage, and networking infrastructure. A production farm with high availability requires a minimum of six servers (two web front ends, two application servers, two SQL Server nodes). Larger farms scale to 20+ servers.

| Component                 | Small farm (< 1,000 users) | Mid-size farm (1,000-10,000) | Large farm (10,000+)     |
| ------------------------- | -------------------------- | ---------------------------- | ------------------------ |
| **Web front-end servers** | 2x (VM or physical)        | 4x                           | 8-12x                    |
| **Application servers**   | 2x                         | 4x                           | 6-8x                     |
| **SQL Server nodes**      | 2x (AlwaysOn AG)           | 2-4x (AlwaysOn AG)           | 4-6x (AlwaysOn FCI + AG) |
| **Search servers**        | Shared with app tier       | 2-4x dedicated               | 6-10x dedicated          |
| **Distributed cache**     | Shared with WFE            | 2x dedicated                 | 4x dedicated             |
| **Total servers**         | 6                          | 12-16                        | 28-40+                   |

### 1.2 Annual infrastructure costs

| Cost category                           | Small farm              | Mid-size farm           | Large farm                |
| --------------------------------------- | ----------------------- | ----------------------- | ------------------------- |
| **Server hardware/VM hosting**          | $30,000 - $50,000       | $80,000 - $150,000      | $200,000 - $400,000       |
| **SQL Server licensing**                | $15,000 - $30,000       | $60,000 - $120,000      | $150,000 - $300,000       |
| **SharePoint Server licensing**         | $8,000 - $15,000        | $15,000 - $30,000       | $30,000 - $60,000         |
| **Windows Server licensing**            | $6,000 - $12,000        | $15,000 - $30,000       | $40,000 - $80,000         |
| **Storage (SAN/NAS)**                   | $10,000 - $20,000       | $30,000 - $60,000       | $80,000 - $200,000        |
| **Network infrastructure**              | $5,000 - $10,000        | $10,000 - $25,000       | $25,000 - $60,000         |
| **Data center (power, cooling, space)** | $8,000 - $15,000        | $20,000 - $40,000       | $50,000 - $120,000        |
| **Backup infrastructure**               | $5,000 - $10,000        | $15,000 - $30,000       | $40,000 - $80,000         |
| **DR infrastructure**                   | $15,000 - $30,000       | $50,000 - $100,000      | $120,000 - $250,000       |
| **Annual infrastructure total**         | **$102,000 - $192,000** | **$295,000 - $585,000** | **$735,000 - $1,550,000** |

### 1.3 Software licensing

SharePoint Server licensing follows a Server + CAL model:

| License                              | Cost (approximate)                | Notes                                                                               |
| ------------------------------------ | --------------------------------- | ----------------------------------------------------------------------------------- |
| SharePoint Server 2019 (per server)  | $7,500 - $8,500                   | Required for each server running SharePoint                                         |
| SharePoint Server CAL (per user)     | $115 - $130 (Standard)            | Required for each user accessing SharePoint                                         |
| SharePoint Server Enterprise CAL     | $85 - $95 (add-on)                | Required for Enterprise features (Excel Services, Visio Services, PerformancePoint) |
| SQL Server Enterprise (per core)     | $7,000 - $7,500 (per 2-core pack) | Required for SQL Server hosting SharePoint databases                                |
| Windows Server Datacenter (per core) | $6,000 - $6,200 (per 16-core)     | Required for virtualized environments                                               |

### 1.4 Administration and labor

SharePoint on-premises requires dedicated administration staff:

| Role                         | Small farm        | Mid-size farm     | Large farm   |
| ---------------------------- | ----------------- | ----------------- | ------------ |
| **SharePoint administrator** | 0.5 FTE           | 1-2 FTE           | 2-4 FTE      |
| **SQL Server DBA**           | 0.25 FTE (shared) | 0.5-1 FTE         | 1-2 FTE      |
| **Windows Server admin**     | 0.25 FTE (shared) | 0.5 FTE           | 1 FTE        |
| **Network admin**            | 0.1 FTE (shared)  | 0.25 FTE (shared) | 0.5 FTE      |
| **Security admin**           | 0.1 FTE (shared)  | 0.25 FTE (shared) | 0.5 FTE      |
| **Help desk (SharePoint)**   | 0.25 FTE          | 0.5-1 FTE         | 1-2 FTE      |
| **Total FTE**                | 1.45 FTE          | 3.0-5.0 FTE       | 6.0-10.0 FTE |

At an average fully loaded cost of $130,000/FTE (including benefits, training, tools):

|                       | Small farm | Mid-size farm       | Large farm            |
| --------------------- | ---------- | ------------------- | --------------------- |
| **Annual labor cost** | $188,500   | $390,000 - $650,000 | $780,000 - $1,300,000 |

### 1.5 Ongoing operational costs

| Cost category                                   | Small farm            | Mid-size farm           | Large farm              |
| ----------------------------------------------- | --------------------- | ----------------------- | ----------------------- |
| **Patching and CU testing**                     | $5,000 - $10,000      | $15,000 - $30,000       | $30,000 - $60,000       |
| **Custom solution maintenance**                 | $10,000 - $25,000     | $30,000 - $80,000       | $80,000 - $200,000      |
| **Workflow maintenance (SP Workflows, Nintex)** | $5,000 - $10,000      | $15,000 - $40,000       | $40,000 - $100,000      |
| **InfoPath form maintenance**                   | $2,000 - $5,000       | $5,000 - $15,000        | $15,000 - $40,000       |
| **Third-party product licenses**                | $5,000 - $15,000      | $15,000 - $40,000       | $40,000 - $100,000      |
| **Security auditing and compliance**            | $5,000 - $10,000      | $15,000 - $30,000       | $30,000 - $80,000       |
| **Capacity planning**                           | $2,000 - $5,000       | $5,000 - $15,000        | $15,000 - $40,000       |
| **Annual operational total**                    | **$34,000 - $80,000** | **$100,000 - $250,000** | **$250,000 - $620,000** |

### 1.6 Total on-premises annual cost

|                  | Small farm              | Mid-size farm             | Large farm                  |
| ---------------- | ----------------------- | ------------------------- | --------------------------- |
| Infrastructure   | $102,000 - $192,000     | $295,000 - $585,000       | $735,000 - $1,550,000       |
| Labor            | $188,500                | $390,000 - $650,000       | $780,000 - $1,300,000       |
| Operations       | $34,000 - $80,000       | $100,000 - $250,000       | $250,000 - $620,000         |
| **Annual total** | **$324,500 - $460,500** | **$785,000 - $1,485,000** | **$1,765,000 - $3,470,000** |

---

## 2. SharePoint Online cost components

### 2.1 M365 licensing (SPO included)

SharePoint Online is included in every Microsoft 365 and Office 365 suite that includes Exchange and Teams. Most organizations already have M365 licensing for email and Teams, making SPO a zero-incremental-cost addition.

| M365 Plan                       | Monthly per user | SPO included | Storage per user                                |
| ------------------------------- | ---------------- | ------------ | ----------------------------------------------- |
| Microsoft 365 Business Basic    | $6.00            | Yes          | 1 TB OneDrive + pooled SPO                      |
| Microsoft 365 Business Standard | $12.50           | Yes          | 1 TB OneDrive + pooled SPO                      |
| Microsoft 365 E3                | $36.00           | Yes          | 1 TB OneDrive + pooled SPO (5 TB with 5+ users) |
| Microsoft 365 E5                | $57.00           | Yes          | 1 TB OneDrive + pooled SPO (5 TB with 5+ users) |
| Microsoft 365 G3 (GCC)          | $32.00           | Yes          | 1 TB OneDrive + pooled SPO                      |
| Microsoft 365 G5 (GCC)          | $54.00           | Yes          | 1 TB OneDrive + pooled SPO                      |
| Microsoft 365 G5 (GCC-High)     | $60.00           | Yes          | 1 TB OneDrive + pooled SPO                      |

**SPO tenant storage:** 1 TB base + 10 GB per licensed user. A 5,000-user tenant receives approximately 51 TB of pooled SPO storage.

### 2.2 SPO-specific add-on costs

| Add-on                           | Cost                           | When needed                                                     |
| -------------------------------- | ------------------------------ | --------------------------------------------------------------- |
| Additional SPO storage           | $0.20/GB/month ($2.40/GB/year) | When pooled storage is insufficient                             |
| Microsoft 365 Extra File Storage | $0.20/GB/month                 | Same as above, purchased through admin center                   |
| Power Automate per-user plan     | $15/user/month                 | For advanced workflow scenarios beyond M365 included flows      |
| Power Apps per-user plan         | $20/user/month                 | For advanced form scenarios beyond basic SPO list forms         |
| Microsoft 365 Copilot            | $30/user/month                 | AI-powered productivity (optional but increasingly essential)   |
| SharePoint Advanced Management   | $3/user/month                  | Advanced governance, access policies, site lifecycle management |

### 2.3 Reduced labor costs with SPO

| Role                         | SPO (small org)   | SPO (mid-size)      | SPO (large)         |
| ---------------------------- | ----------------- | ------------------- | ------------------- |
| **M365 administrator**       | 0.25 FTE (shared) | 0.5-1 FTE           | 1-2 FTE             |
| **SPO governance/architect** | 0.1 FTE           | 0.25-0.5 FTE        | 0.5-1 FTE           |
| **Help desk**                | 0.1 FTE           | 0.25-0.5 FTE        | 0.5-1 FTE           |
| **Total FTE**                | 0.45 FTE          | 1.0-2.0 FTE         | 2.0-4.0 FTE         |
| **Annual labor cost**        | $58,500           | $130,000 - $260,000 | $260,000 - $520,000 |

**Labor savings:** 60-70% reduction in dedicated administration staff. SQL Server DBA, Windows Server admin, network admin, and security admin roles are eliminated for the SharePoint workload (these roles may still exist for other on-premises systems).

---

## 3. Five-year TCO comparison

### 3.1 Small organization (500 users, M365 E3)

| Cost category                        | On-premises (5-year)        | SPO (5-year)                             |
| ------------------------------------ | --------------------------- | ---------------------------------------- |
| Infrastructure                       | $510,000 - $960,000         | $0 (included in M365)                    |
| Software licensing                   | Included in infrastructure  | $0 (included in M365)                    |
| M365 licensing (incremental for SPO) | N/A                         | $0 (already licensed for Exchange/Teams) |
| Additional storage (10 TB extra)     | Included                    | $24,000                                  |
| Labor                                | $942,500                    | $292,500                                 |
| Operations                           | $170,000 - $400,000         | $25,000 - $50,000                        |
| **5-year total**                     | **$1,622,500 - $2,302,500** | **$341,500 - $366,500**                  |
| **Annual average**                   | **$324,500 - $460,500**     | **$68,300 - $73,300**                    |

**Savings: 79-84%**

### 3.2 Mid-size organization (5,000 users, M365 E3)

| Cost category                        | On-premises (5-year)        | SPO (5-year)                |
| ------------------------------------ | --------------------------- | --------------------------- |
| Infrastructure                       | $1,475,000 - $2,925,000     | $0                          |
| M365 licensing (incremental for SPO) | N/A                         | $0                          |
| Additional storage (50 TB extra)     | Included                    | $120,000                    |
| Power Automate (500 power users)     | Included (Nintex ~$50K/yr)  | $450,000                    |
| Labor                                | $1,950,000 - $3,250,000     | $650,000 - $1,300,000       |
| Operations                           | $500,000 - $1,250,000       | $75,000 - $150,000          |
| **5-year total**                     | **$3,925,000 - $7,425,000** | **$1,295,000 - $2,020,000** |
| **Annual average**                   | **$785,000 - $1,485,000**   | **$259,000 - $404,000**     |

**Savings: 67-73%**

### 3.3 Large organization (25,000 users, M365 E5)

| Cost category                        | On-premises (5-year)         | SPO (5-year)                  |
| ------------------------------------ | ---------------------------- | ----------------------------- |
| Infrastructure                       | $3,675,000 - $7,750,000      | $0                            |
| M365 licensing (incremental for SPO) | N/A                          | $0                            |
| Additional storage (200 TB extra)    | Included                     | $480,000                      |
| Power Automate (2,000 power users)   | Included (Nintex ~$150K/yr)  | $1,800,000                    |
| Power Apps (500 power users)         | Included (InfoPath)          | $600,000                      |
| SharePoint Advanced Management       | N/A                          | $900,000                      |
| Copilot (5,000 users)                | N/A                          | $9,000,000                    |
| Labor                                | $3,900,000 - $6,500,000      | $1,300,000 - $2,600,000       |
| Operations                           | $1,250,000 - $3,100,000      | $200,000 - $400,000           |
| **5-year total (without Copilot)**   | **$8,825,000 - $17,350,000** | **$5,280,000 - $6,780,000**   |
| **5-year total (with Copilot)**      | **$8,825,000 - $17,350,000** | **$14,280,000 - $15,780,000** |

**Savings without Copilot: 40-61%**

!!! note "Copilot is not a migration cost"
Copilot for M365 is an optional add-on that provides AI-powered productivity. It is not required for migration and should not be included in migration TCO comparisons. However, Copilot is only available on SPO -- organizations that want Copilot must migrate. The TCO table above shows both scenarios for transparency.

---

## 4. Hidden costs frequently omitted

### On-premises hidden costs

| Hidden cost                            | Description                                                                                     | Typical impact                                |
| -------------------------------------- | ----------------------------------------------------------------------------------------------- | --------------------------------------------- |
| **Opportunity cost of upgrades**       | Staff time spent on in-place upgrades (2013 to 2016, 2016 to 2019) instead of business projects | 2-4 months of team capacity per major upgrade |
| **Technical debt from customizations** | Farm solutions, custom timer jobs, and custom web parts that break during upgrades              | $50,000 - $500,000 per major upgrade          |
| **Shadow IT workarounds**              | Users adopt Box, Dropbox, Google Drive when SharePoint is slow or limited                       | Compliance risk + duplicate licensing cost    |
| **Security incident response**         | Delayed patching creates vulnerability windows; incident response costs average $150,000+       | Risk-adjusted cost of $15,000 - $50,000/year  |
| **Recruitment and retention**          | SharePoint on-premises skills are declining; premium compensation required                      | 10-20% salary premium for on-prem SP admins   |

### SPO migration costs (one-time)

| Migration cost                                | Small                  | Mid-size                | Large                     |
| --------------------------------------------- | ---------------------- | ----------------------- | ------------------------- |
| **Migration tool licensing (if third-party)** | $5,000 - $15,000       | $15,000 - $50,000       | $50,000 - $150,000        |
| **Migration consulting/SI**                   | $20,000 - $50,000      | $50,000 - $200,000      | $200,000 - $800,000       |
| **Workflow redesign (Power Automate)**        | $10,000 - $30,000      | $30,000 - $100,000      | $100,000 - $400,000       |
| **InfoPath redesign (Power Apps)**            | $5,000 - $15,000       | $15,000 - $50,000       | $50,000 - $200,000        |
| **SPFx development**                          | $5,000 - $20,000       | $20,000 - $80,000       | $80,000 - $300,000        |
| **User training and adoption**                | $5,000 - $10,000       | $10,000 - $40,000       | $40,000 - $150,000        |
| **Total one-time migration cost**             | **$50,000 - $140,000** | **$140,000 - $520,000** | **$520,000 - $2,000,000** |

Migration costs are one-time expenses that are typically recovered within 6-18 months through operational savings.

---

## 5. Federal-specific cost considerations

### GCC and GCC-High pricing

Federal organizations pay a premium for GCC and GCC-High tenants:

| Plan    | Commercial     | GCC            | GCC-High    | Premium                              |
| ------- | -------------- | -------------- | ----------- | ------------------------------------ |
| M365 E3 | $36/user/month | $32/user/month | Varies (EA) | GCC is often lower due to EA pricing |
| M365 E5 | $57/user/month | $54/user/month | Varies (EA) | Volume discounts apply               |

### Federal on-premises premium

Federal on-premises SharePoint farms carry additional costs:

- **STIG compliance** -- hardening SharePoint to DISA STIG requirements adds 20-30% to administration cost
- **Authority to Operate (ATO)** -- maintaining an ATO for on-premises SharePoint costs $50,000-$200,000 per assessment cycle
- **Physical security** -- data center security for controlled environments (CUI/FOUO) adds $20,000-$50,000/year
- **Supply chain verification** -- hardware procurement through approved supply chains adds 10-15% to hardware costs

SharePoint Online in GCC/GCC-High inherits the FedRAMP High ATO from Microsoft, eliminating per-system ATO costs.

---

## 6. Cost optimization strategies for SPO

### Reduce storage costs

- **Archive inactive content** to Microsoft 365 Archive (cold storage at lower cost)
- **Clean up versioning** -- set version limits on document libraries (default is 500 major versions)
- **Delete orphaned sites** -- use SharePoint Advanced Management for site lifecycle policies
- **Large media files** -- store in Azure Blob Storage rather than SPO document libraries

### Optimize Power Platform licensing

- **M365 included flows** cover most standard approval and notification workflows
- **Seeded Power Apps** -- the SPO list form customization capability is included in M365, no additional license needed
- **Per-user plans** only for users who need premium connectors or custom connectors

### Negotiate M365 Enterprise Agreements

- **Multi-year commitments** typically provide 10-20% discounts
- **Bundled licensing** (M365 E5 includes Purview, Defender, advanced compliance) often cheaper than E3 + add-ons
- **Education and nonprofit** pricing provides significant discounts

---

## 7. ROI calculation template

```
=== ANNUAL ON-PREMISES COST ===
Infrastructure:         $___________
Software licensing:     $___________
Administration labor:   $___________
Operations:             $___________
Hidden costs:           $___________
TOTAL ON-PREM/YEAR:     $___________

=== ANNUAL SPO COST ===
M365 licensing (incremental): $___________  (usually $0 if already on M365)
Additional storage:           $___________
Power Platform add-ons:       $___________
Administration labor:         $___________
Operations:                   $___________
TOTAL SPO/YEAR:               $___________

=== ONE-TIME MIGRATION COST ===
Migration tools:        $___________
Consulting/SI:          $___________
Workflow redesign:      $___________
Form redesign:          $___________
SPFx development:       $___________
Training:               $___________
TOTAL MIGRATION:        $___________

=== 5-YEAR TCO ===
On-premises (5 years):  $___________
SPO (5 years + migration): $___________
NET SAVINGS:            $___________
PAYBACK PERIOD:         ___ months
```

---

## 8. Sensitivity analysis

### Key cost variables and their impact

| Variable                                        | Low estimate impact              | High estimate impact                     | How to refine                 |
| ----------------------------------------------- | -------------------------------- | ---------------------------------------- | ----------------------------- |
| **SQL Server licensing model**                  | SA + Enterprise per-core pricing | Standard edition with Software Assurance | Review current EA             |
| **Admin FTE salary**                            | $100K fully loaded               | $160K fully loaded                       | Use org-specific comp data    |
| **Third-party products** (Nintex, K2, AvePoint) | $5K/year                         | $150K/year                               | Audit current licenses        |
| **DR investment**                               | Warm standby (lower cost)        | Full DR farm (highest cost)              | Assess current DR topology    |
| **Power Platform adoption**                     | Basic (M365 included only)       | Heavy (premium licenses)                 | Survey current workflow count |
| **Migration consulting**                        | Internal team (lower cost)       | Full SI engagement (highest)             | RFP or internal assessment    |
| **Storage growth rate**                         | 5% annual                        | 20% annual                               | Review 3-year growth trend    |

### Break-even analysis

For most organizations, SPO breaks even within 6-18 months:

| Organization size      | Migration cost  | Annual savings  | Break-even  |
| ---------------------- | --------------- | --------------- | ----------- |
| Small (500 users)      | $50K - $140K    | $256K - $387K   | 2-6 months  |
| Mid-size (5,000 users) | $140K - $520K   | $526K - $1,081K | 3-10 months |
| Large (25,000 users)   | $520K - $2,000K | $709K - $2,114K | 6-18 months |

### What is NOT included in SPO TCO

These costs exist for both on-premises and SPO, so they cancel out in comparison:

- End-user devices (laptops, monitors)
- Office application licenses (included in M365 for both scenarios in practice)
- Network bandwidth (required for both, though SPO shifts from LAN to WAN)
- End-user productivity loss during migration (one-time, typically 2-4 hours per user)
- Change management program costs (organizational, not technical)

---

## 9. Cost optimization playbook

### Year 1: Migration and stabilization

| Action                                           | Savings potential                     | Effort |
| ------------------------------------------------ | ------------------------------------- | ------ |
| Retire inactive sites before migration           | Reduce migration scope by 20-40%      | Low    |
| Reduce version history during migration          | Reduce storage and migration time     | Low    |
| Use SPMT/Migration Manager (free) vs third-party | $15K - $150K saved on tool licensing  | Medium |
| Leverage FastTrack (free for 500+ seats)         | $50K - $200K saved on consulting      | Low    |
| Decommission on-prem infrastructure promptly     | Stop paying for servers, SQL licenses | Medium |

### Years 2-5: Ongoing optimization

| Action                                        | Savings potential                | Effort |
| --------------------------------------------- | -------------------------------- | ------ |
| Right-size M365 licensing (E3 vs E5 analysis) | 10-30% of licensing cost         | Medium |
| Implement site lifecycle policies             | Reduce storage growth            | Low    |
| Use M365 Archive for cold content             | $0.05/GB/month vs $0.20/GB/month | Medium |
| Consolidate Power Platform licensing          | Reduce per-user premium licenses | Medium |
| Negotiate multi-year EA renewals              | 10-20% discount                  | Low    |

---

## References

- [Microsoft 365 licensing plans](https://www.microsoft.com/microsoft-365/compare-microsoft-365-enterprise-plans)
- [SharePoint Online storage limits](https://learn.microsoft.com/office365/servicedescriptions/sharepoint-online-service-description/sharepoint-online-limits)
- [Power Automate pricing](https://powerautomate.microsoft.com/pricing/)
- [Power Apps pricing](https://powerapps.microsoft.com/pricing/)
- [Microsoft 365 Copilot pricing](https://www.microsoft.com/microsoft-365/copilot)
- [SharePoint Advanced Management](https://learn.microsoft.com/sharepoint/advanced-management)
- [Azure TCO Calculator](https://azure.microsoft.com/pricing/tco/calculator/)
- [Microsoft 365 Government plans](https://learn.microsoft.com/office365/servicedescriptions/office-365-platform-service-description/office-365-us-government/office-365-us-government)

---

**Maintainers:** csa-inabox core team
**Last updated:** 2026-04-30
