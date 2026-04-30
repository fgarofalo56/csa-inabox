# Total Cost of Ownership: Splunk vs Microsoft Sentinel

**Status:** Authored 2026-04-30
**Audience:** CFOs, CISOs, Procurement, Security Architects
**Purpose:** Detailed TCO comparison between Splunk Enterprise/Cloud and Microsoft Sentinel

---

!!! warning "Pricing disclaimer"
Pricing data in this document is illustrative and based on publicly available list prices as of early 2026. Actual pricing varies by contract terms, negotiated discounts, commitment agreements, and federal pricing vehicles (GSA Schedule, NASA SEWP, CIO-CS). Always validate with Microsoft and Cisco/Splunk sales teams for current pricing.

---

## 1. Pricing model comparison

### Splunk pricing structure

Splunk uses a **volume-based licensing model** tied to daily data ingestion:

| Splunk component                          | Pricing model                             | Typical federal cost                |
| ----------------------------------------- | ----------------------------------------- | ----------------------------------- |
| **Splunk Enterprise** (on-premises)       | Per GB/day of indexed data                | $1,800 - $3,600 per GB/day annually |
| **Splunk Cloud**                          | Per GB/day of indexed data + platform fee | $2,200 - $4,000 per GB/day annually |
| **Splunk Enterprise Security (ES)**       | Premium add-on (% of base license)        | 50-100% premium on base license     |
| **Splunk SOAR**                           | Separate product license                  | $100,000 - $500,000 annually        |
| **Splunk IT Service Intelligence (ITSI)** | Separate product license                  | $100,000 - $300,000 annually        |
| **Premium apps** (UBA, PCI, etc.)         | Per-app licensing                         | $50,000 - $200,000 each annually    |

**Volume penalty:** As daily ingest volume increases, per-GB unit cost decreases -- but total cost still escalates linearly with data growth. A federal SOC ingesting 1.5 TB/day at $2,500/GB/day pays $3.75M annually in base licensing alone.

### Sentinel pricing structure

Sentinel uses a **consumption-based model** with multiple cost optimization levers:

| Sentinel component                           | Pricing model                               | Typical cost                            |
| -------------------------------------------- | ------------------------------------------- | --------------------------------------- |
| **Log Analytics ingestion (Analytics tier)** | Per GB ingested                             | $2.76 - $4.30 per GB (Azure Government) |
| **Commitment tier discounts**                | Pre-committed daily GB volume               | 15-50% discount vs pay-as-you-go        |
| **Basic Logs**                               | High-volume, low-query data                 | ~$0.50 per GB (limited query included)  |
| **Archive tier**                             | Long-term compliance retention              | ~$0.02 per GB/month storage             |
| **Free Microsoft data sources**              | M365, Entra ID, Defender XDR, Activity logs | $0.00 per GB                            |
| **Sentinel solution**                        | Analytics rules, workbooks, hunting         | Included with Log Analytics ingestion   |
| **Logic Apps (playbooks)**                   | Pay-per-execution                           | $0.000025 per action                    |
| **Security Copilot**                         | Security Compute Units (SCUs)               | Priced per SCU-hour                     |

**Key cost advantages:**

1. **Free Microsoft data:** Organizations using M365, Entra ID, and Defender XDR often see 30-50% of their security telemetry ingested at no cost
2. **Basic Logs:** High-volume data sources (DNS, network flow, verbose audit) can use Basic Logs at 60-75% cost reduction
3. **No infrastructure cost:** Zero servers, storage, or networking to provision
4. **No SOAR licensing:** Logic Apps are pay-per-execution, not a flat license
5. **Commitment tiers:** Predictable pricing with significant discounts

---

## 2. Cost modeling scenarios

### Scenario A: Mid-sized federal agency

**Profile:** 30 TB/month ingestion, 50 SOC analysts, 200 detection rules, 20 SOAR playbooks

=== "Splunk Enterprise"

    | Cost category | Annual cost | Notes |
    |---|---|---|
    | Splunk Enterprise license (1 TB/day at $2,500/GB/day) | $2,500,000 | Volume-based indexing license |
    | Splunk ES add-on | $1,250,000 | 50% premium on base |
    | Splunk SOAR | $200,000 | Standalone SOAR platform |
    | Infrastructure (indexer cluster) | $480,000 | 12 indexers, 3 search heads, storage |
    | Infrastructure (forwarder management) | $120,000 | Deployment server, certificates |
    | Splunk admin FTE (2 senior admins) | $350,000 | Salary + benefits |
    | Premium apps (UBA, PCI compliance) | $150,000 | Two add-on products |
    | Training and Splunk certification | $50,000 | Annual training budget |
    | **Annual total** | **$5,100,000** | |
    | **3-year total** | **$15,300,000** | Assumes 5% annual price escalation |

=== "Microsoft Sentinel"

    | Cost category | Annual cost | Notes |
    |---|---|---|
    | Log Analytics ingestion (20 TB/month billable at commitment tier) | $720,000 | 10 TB/month free from Microsoft sources |
    | Sentinel analytics | $0 | Included with Log Analytics |
    | Basic Logs (5 TB/month at $0.50/GB) | $30,000 | Verbose logs on Basic tier |
    | Logic Apps (playbook executions) | $12,000 | ~500K executions/year |
    | Security Copilot (3 SCUs) | $120,000 | AI-assisted triage and hunting |
    | Azure Monitor Agent deployment | $0 | Agent is free; VM compute existing |
    | Cloud operations FTE (1 engineer) | $175,000 | Salary + benefits |
    | Training (KQL + Sentinel) | $30,000 | Annual training budget |
    | **Annual total** | **$1,087,000** | |
    | **3-year total** | **$3,261,000** | Assumes stable consumption pricing |

    **3-year savings: $12,039,000 (79%)**

### Scenario B: Large federal SOC / DoD component

**Profile:** 100 TB/month ingestion, 200 SOC analysts, 800 detection rules, 100 SOAR playbooks

=== "Splunk Enterprise"

    | Cost category | Annual cost | Notes |
    |---|---|---|
    | Splunk Enterprise license (3.3 TB/day) | $6,000,000 | Negotiated volume discount |
    | Splunk ES add-on | $3,000,000 | 50% premium |
    | Splunk SOAR | $500,000 | Enterprise tier |
    | Infrastructure (large cluster) | $1,200,000 | 30+ indexers, HA search heads, SAN storage |
    | Splunk admin FTE (4 admins) | $700,000 | Dedicated platform team |
    | Premium apps and add-ons | $400,000 | Multiple add-ons |
    | Contractor support | $300,000 | Vendor professional services |
    | **Annual total** | **$12,100,000** | |
    | **3-year total** | **$36,300,000** | Assumes 5% annual escalation |

=== "Microsoft Sentinel"

    | Cost category | Annual cost | Notes |
    |---|---|---|
    | Log Analytics ingestion (60 TB/month billable) | $1,800,000 | 40 TB/month free from Microsoft sources |
    | Basic Logs (20 TB/month) | $120,000 | High-volume sources on Basic tier |
    | Logic Apps (playbook executions) | $36,000 | ~1.5M executions/year |
    | Security Copilot (10 SCUs) | $400,000 | Full SOC deployment |
    | Azure Data Explorer (long-term retention) | $180,000 | 5-year retention at archive rates |
    | Cloud operations FTE (2 engineers) | $350,000 | Salary + benefits |
    | Training and transition | $100,000 | Year 1 ramp-up |
    | **Annual total** | **$2,986,000** | |
    | **3-year total** | **$8,958,000** | |

    **3-year savings: $27,342,000 (75%)**

### Scenario C: Small agency / bureau

**Profile:** 5 TB/month ingestion, 10 SOC analysts, 50 detection rules, 5 SOAR playbooks

=== "Splunk Cloud"

    | Cost category | Annual cost | Notes |
    |---|---|---|
    | Splunk Cloud license (170 GB/day) | $500,000 | Cloud platform + ingest |
    | Splunk ES Cloud | $250,000 | ES add-on |
    | Splunk SOAR | $100,000 | Starter tier |
    | Admin FTE (1 part-time) | $87,500 | Half an FTE dedicated to Splunk ops |
    | **Annual total** | **$937,500** | |
    | **3-year total** | **$2,812,500** | |

=== "Microsoft Sentinel"

    | Cost category | Annual cost | Notes |
    |---|---|---|
    | Log Analytics ingestion (3 TB/month billable) | $108,000 | 2 TB/month free Microsoft sources |
    | Logic Apps | $3,000 | Low playbook volume |
    | Security Copilot (1 SCU) | $40,000 | Single SCU |
    | Cloud operations (part-time) | $43,750 | Quarter FTE |
    | **Annual total** | **$194,750** | |
    | **3-year total** | **$584,250** | |

    **3-year savings: $2,228,250 (79%)**

---

## 3. Hidden costs in Splunk deployments

Federal agencies often undercount the true cost of Splunk operations. These hidden costs should be included in TCO analysis:

### Infrastructure hidden costs

| Hidden cost                | Typical annual impact | Why it is hidden                                                                                             |
| -------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------ |
| **Storage growth**         | $100K - $500K         | Splunk hot/warm storage costs grow with data; often funded from infrastructure budgets, not security budgets |
| **Network bandwidth**      | $50K - $200K          | Forwarder-to-indexer traffic, especially for distributed deployments across WANs                             |
| **Disaster recovery**      | $200K - $600K         | Full cluster replication for HA/DR doubles infrastructure footprint                                          |
| **Dev/test environments**  | $100K - $300K         | Separate Splunk clusters for development, testing, training                                                  |
| **Certificate management** | $20K - $50K           | TLS certificates for forwarder-indexer-search head communication                                             |

### Operational hidden costs

| Hidden cost                      | Typical annual impact | Why it is hidden                                                                         |
| -------------------------------- | --------------------- | ---------------------------------------------------------------------------------------- |
| **Upgrade labor**                | $50K - $100K          | Multi-week upgrade cycles across cluster components; overtime and change management      |
| **Knowledge object maintenance** | $100K - $200K         | SPL queries, lookups, macros, eventtypes -- ongoing maintenance by skilled Splunk admins |
| **Forwarder lifecycle**          | $50K - $150K          | Deploying, updating, and troubleshooting forwarders across the endpoint fleet            |
| **Capacity planning**            | $30K - $75K           | Ongoing indexer sizing, storage forecasting, license compliance monitoring               |
| **Splunk app licensing**         | $100K - $400K         | Splunkbase apps (some paid) for specific data sources and use cases                      |

### Talent hidden costs

| Hidden cost               | Typical annual impact  | Why it is hidden                                                                      |
| ------------------------- | ---------------------- | ------------------------------------------------------------------------------------- |
| **Splunk admin premium**  | $50K - $100K per admin | Splunk-certified admins command 15-25% salary premium over general security engineers |
| **Contractor dependency** | $200K - $500K          | Many federal agencies rely on contractor support for Splunk operations                |
| **Training recurrence**   | $30K - $75K            | Ongoing Splunk certification and training as platform evolves                         |

### Total hidden cost estimate

For a mid-sized federal deployment: **$800K - $2.5M annually** in costs that typically do not appear in the Splunk license line item.

---

## 4. Sentinel cost optimization strategies

### Free data sources

The single largest cost optimization in Sentinel is leveraging free Microsoft data ingestion:

| Data source                         | Free in Sentinel | Typical volume (mid-size agency) | Splunk equivalent cost       |
| ----------------------------------- | ---------------- | -------------------------------- | ---------------------------- |
| Microsoft 365 audit logs            | Yes              | 3-5 TB/month                     | $90K - $150K/year            |
| Entra ID sign-in and audit logs     | Yes              | 1-3 TB/month                     | $30K - $90K/year             |
| Defender XDR alerts and incidents   | Yes              | 500 GB - 1 TB/month              | $15K - $30K/year             |
| Azure Activity logs                 | Yes              | 200-500 GB/month                 | $6K - $15K/year              |
| Microsoft Defender for Cloud alerts | Yes              | 100-300 GB/month                 | $3K - $9K/year               |
| **Total free data**                 |                  | **5-10 TB/month**                | **$144K - $294K/year saved** |

### Commitment tiers

| Commitment tier (GB/day) | Pay-as-you-go cost | Commitment cost | Savings |
| ------------------------ | ------------------ | --------------- | ------- |
| 100 GB/day               | $430/day           | $368/day        | 15%     |
| 200 GB/day               | $860/day           | $690/day        | 20%     |
| 500 GB/day               | $2,150/day         | $1,505/day      | 30%     |
| 1,000 GB/day             | $4,300/day         | $2,580/day      | 40%     |
| 2,000 GB/day             | $8,600/day         | $4,730/day      | 45%     |
| 5,000+ GB/day            | $21,500/day        | $10,750/day     | 50%     |

### Basic Logs vs Analytics Logs

| Data type                  | Recommended tier | Cost difference | Use case                                 |
| -------------------------- | ---------------- | --------------- | ---------------------------------------- |
| Security alerts, incidents | Analytics        | Full price      | Frequent querying, analytics rules       |
| Authentication events      | Analytics        | Full price      | Detection rules, investigation           |
| DNS query logs             | Basic            | 60-75% savings  | Low-frequency hunting, compliance        |
| Network flow logs (NSG)    | Basic            | 60-75% savings  | Forensic investigation on-demand         |
| Verbose application logs   | Basic            | 60-75% savings  | Troubleshooting, not real-time detection |
| Raw syslog (high volume)   | Basic            | 60-75% savings  | Compliance retention, periodic review    |

### Data collection rules (DCRs)

Azure Monitor Agent supports **Data Collection Rules** that filter and transform data at ingestion time:

```bicep
// Example: Filter verbose Windows events before ingestion
resource dcr 'Microsoft.Insights/dataCollectionRules@2022-06-01' = {
  name: 'dcr-windows-security-filtered'
  location: location
  properties: {
    dataSources: {
      windowsEventLogs: [
        {
          name: 'windowsSecurityEvents'
          streams: ['Microsoft-SecurityEvent']
          xPathQueries: [
            'Security!*[System[(EventID=4624 or EventID=4625 or EventID=4648 or EventID=4672 or EventID=4688)]]'
          ]
        }
      ]
    }
  }
}
```

**Impact:** Filtering noisy events at the source can reduce ingestion volumes by 30-60% for Windows event data without losing security-relevant telemetry.

---

## 5. Three-year TCO projection

### Assumptions

- Data growth: 30% year-over-year
- Splunk price escalation: 5% annually (conservative post-acquisition estimate)
- Sentinel pricing: stable (commitment tier lock-in)
- Migration costs included in Year 1 for Sentinel
- Federal pricing (Azure Government rates)

### Mid-sized agency (starting at 30 TB/month)

| Year             | Splunk Enterprise                     | Microsoft Sentinel                    | Cumulative savings    |
| ---------------- | ------------------------------------- | ------------------------------------- | --------------------- |
| Year 1           | $5,100,000                            | $1,287,000 (includes $200K migration) | $3,813,000            |
| Year 2           | $6,885,000 (data growth + escalation) | $1,187,000                            | $9,511,000            |
| Year 3           | $9,306,000 (compounding)              | $1,387,000                            | $17,430,000           |
| **3-year total** | **$21,291,000**                       | **$3,861,000**                        | **$17,430,000 (82%)** |

### Large DoD component (starting at 100 TB/month)

| Year             | Splunk Enterprise | Microsoft Sentinel                    | Cumulative savings    |
| ---------------- | ----------------- | ------------------------------------- | --------------------- |
| Year 1           | $12,100,000       | $3,486,000 (includes $500K migration) | $8,614,000            |
| Year 2           | $16,335,000       | $3,286,000                            | $21,663,000           |
| Year 3           | $22,052,000       | $3,886,000                            | $39,829,000           |
| **3-year total** | **$50,487,000**   | **$10,658,000**                       | **$39,829,000 (79%)** |

---

## 6. Migration cost considerations

### One-time migration costs

| Migration activity                    | Cost range                | Notes                                                |
| ------------------------------------- | ------------------------- | ---------------------------------------------------- |
| Discovery and assessment              | $50,000 - $150,000        | Splunk inventory, connector mapping, rule export     |
| Sentinel deployment and configuration | $50,000 - $200,000        | Workspace, connectors, Content Hub solutions         |
| Detection rule migration              | $100,000 - $500,000       | SPL-to-KQL conversion, validation, tuning            |
| SOAR playbook migration               | $50,000 - $200,000        | Logic Apps development and testing                   |
| Dashboard/workbook migration          | $30,000 - $100,000        | Workbook creation and validation                     |
| Historical data migration             | $30,000 - $100,000        | Export, transform, load to ADX/Log Analytics         |
| SOC analyst training                  | $50,000 - $150,000        | KQL training, Sentinel orientation, Copilot adoption |
| Parallel-run period                   | $100,000 - $300,000       | Dual SIEM operation for 2-3 months                   |
| **Total migration cost**              | **$460,000 - $1,700,000** |                                                      |

### Migration cost payback

At the mid-sized agency level ($4M annual Splunk savings), migration costs pay back in **1-5 months**.

At the large DoD level ($9M annual savings), migration costs pay back in **1-2 months**.

---

## 7. CSA-in-a-Box cost synergies

Organizations deploying CSA-in-a-Box alongside Sentinel gain additional cost efficiencies:

| Synergy                              | Savings mechanism                                                                                                 |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| **Shared Log Analytics workspace**   | CSA-in-a-Box platform telemetry and Sentinel security data share the same workspace, avoiding duplicate ingestion |
| **Fabric capacity sharing**          | Security analytics workloads in Fabric share capacity with other CSA-in-a-Box analytics workloads                 |
| **Purview governance consolidation** | Security data classifications use the same Purview instance as business data governance                           |
| **Power BI shared capacity**         | Executive security dashboards share Power BI capacity with business reporting                                     |
| **ADX shared cluster**               | Long-term security data retention shares ADX capacity with other historical analytics                             |

---

## 8. FinOps recommendations

### Before migration

1. **Baseline current Splunk costs** including all hidden costs (infrastructure, FTE, apps, contractors)
2. **Inventory data sources** with daily volume per sourcetype
3. **Identify free Microsoft sources** -- calculate how much of your telemetry qualifies for free ingestion
4. **Model commitment tiers** -- determine the optimal commitment level based on projected billable volume
5. **Plan Basic Logs strategy** -- identify high-volume, low-query data sources for Basic tier

### During migration

1. **Use Azure Cost Management** to monitor Sentinel costs daily during ramp-up
2. **Set budget alerts** at 80% and 100% of projected monthly spend
3. **Implement Data Collection Rules** early to filter unnecessary data at ingestion
4. **Review ingestion patterns** weekly during the first month to catch unexpected volume

### Post-migration

1. **Right-size commitment tier** after 3 months of steady-state data
2. **Audit Basic vs Analytics tier** assignments quarterly
3. **Monitor Security Copilot SCU usage** and adjust allocation
4. **Review archive tier** policies for compliance alignment
5. **Document cost model** in CSA-in-a-Box cost management framework (`docs/COST_MANAGEMENT.md`)

---

## Summary

The TCO case for Sentinel over Splunk is compelling across all federal agency sizes:

- **75-82% three-year cost reduction** in direct SIEM costs
- **Free Microsoft data sources** eliminate 30-50% of ingestion charges
- **Zero infrastructure costs** eliminate the hidden cost of Splunk cluster operations
- **No SOAR licensing** -- Logic Apps are pay-per-execution
- **Migration costs pay back in 1-5 months** at typical federal scale
- **CSA-in-a-Box synergies** further reduce costs through shared infrastructure

The financial argument is not the only argument -- cloud-native architecture, Security Copilot, and unified Microsoft stack integration provide strategic value beyond cost. But for CFOs and procurement teams, the numbers speak clearly.

---

**Next steps:**

- [Feature Mapping](feature-mapping-complete.md) -- see what Sentinel provides for each Splunk feature
- [Migration Playbook](../splunk-to-sentinel.md) -- plan the migration
- [Benchmarks](benchmarks.md) -- performance comparison data

---

**Maintainers:** csa-inabox core team
**Last updated:** 2026-04-30
