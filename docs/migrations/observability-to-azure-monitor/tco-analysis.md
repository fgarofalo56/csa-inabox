# Total Cost of Ownership: Observability Platform Comparison

**Audience:** CFO, CIO, VP Engineering, Procurement, Federal Contracting Officers
**Reading time:** 20 minutes
**Last updated:** 2026-04-30

---

## Methodology

This analysis compares the total cost of ownership (TCO) for four observability platforms across three representative environment sizes over a 5-year period. All prices use publicly available list rates as of Q1 2026. Negotiated enterprise discounts vary; this analysis notes where discounts are typically available and their approximate range.

**Platforms compared:**

- **Datadog** -- Pro and Enterprise tiers
- **New Relic** -- Standard and Pro tiers
- **Splunk Observability** -- Infrastructure + APM + Log Observer
- **Azure Monitor** -- Log Analytics + Application Insights + Managed Prometheus

**Environment sizes modeled:**

| Parameter                          | Small     | Medium     | Large      |
| ---------------------------------- | --------- | ---------- | ---------- |
| Monitored hosts (VMs + containers) | 50        | 500        | 3,000      |
| Applications with APM              | 10        | 50         | 200        |
| Daily log ingestion                | 50 GB/day | 500 GB/day | 3 TB/day   |
| Custom metrics                     | 5,000     | 50,000     | 500,000    |
| Full-platform users                | 10        | 50         | 200        |
| Synthetic test runs/month          | 5,000     | 50,000     | 200,000    |
| RUM sessions/month                 | 100,000   | 1,000,000  | 10,000,000 |

---

## Pricing model comparison

### Datadog pricing axes

Datadog uses a multi-axis pricing model where each observability capability is licensed separately.

| Capability                        | Pro (per host/month) | Enterprise (per host/month) | Notes                                            |
| --------------------------------- | -------------------- | --------------------------- | ------------------------------------------------ |
| Infrastructure monitoring         | $23                  | $33                         | Per host; containers counted as fraction of host |
| APM                               | $40                  | $40                         | Per APM host; includes 1M trace spans/month      |
| APM + DevSecOps                   | --                   | $40                         | Additional for Application Security              |
| Log management (ingestion)        | $0.10/GB             | $0.10/GB                    | Ingestion cost only                              |
| Log management (15-day retention) | $1.70/million events | $1.70/million events        | On top of ingestion                              |
| Log management (30-day retention) | $2.50/million events | $2.50/million events        | Extended retention                               |
| Custom metrics                    | $0.05/metric/month   | $0.05/metric/month          | Beyond 100 included                              |
| Synthetics API tests              | $7.20/10K runs       | $7.20/10K runs              | Monthly                                          |
| Synthetics browser tests          | $16.80/1K runs       | $16.80/1K runs              | Monthly                                          |
| RUM                               | $1.80/1K sessions    | $1.80/1K sessions           | Monthly                                          |
| Continuous Profiler               | $19/host/month       | $19/host/month              | Per APM host                                     |
| Database monitoring               | $84/host/month       | $84/host/month              | Per database host                                |
| CI Visibility                     | $13/committer/month  | $13/committer/month         | Per active committer                             |

**Hidden costs:**

- Container monitoring counts fractional hosts (5 containers on a node = 1 host), but ephemeral containers can spike host counts unpredictably
- Log rehydration from archive costs $0.10/GB -- the same as initial ingestion
- Custom metrics beyond the base 100 per host can accumulate rapidly in microservice architectures (Prometheus-style metrics can generate thousands per service)
- On-demand log scanning charges separately from indexed logs

### New Relic pricing axes

New Relic simplified to per-user plus data ingestion pricing in 2020.

| Capability                | Standard                | Pro                     | Notes                          |
| ------------------------- | ----------------------- | ----------------------- | ------------------------------ |
| Full Platform User        | $549/user/month         | $1,149/user/month       | Per named user                 |
| Core User                 | $99/user/month          | $349/user/month         | Limited query/dashboard access |
| Basic User                | Free                    | Free                    | Very limited access            |
| Data ingestion            | Free first 100 GB/month | Free first 100 GB/month | Per account                    |
| Data Plus (beyond free)   | $0.35/GB                | $0.35/GB                | 90-day retention               |
| Standard (beyond free)    | $0.30/GB                | $0.30/GB                | 30-day retention               |
| Additional data retention | $0.05/GB/month          | $0.05/GB/month          | Per month beyond default       |
| Synthetics checks         | $0.005/check            | $0.005/check            | Per ping check                 |
| Vulnerability management  | Included                | Included                | With Data Plus                 |

**Hidden costs:**

- The per-user model forces organizations to restrict access. In a 200-person engineering org, only 20-50 might get Full Platform licenses, creating bottlenecks during incidents
- Data Plus retention (90 days) requires upgrading from Standard data; organizations needing long retention pay both ingestion and retention premiums
- Live archives for compliance use cases add additional cost per GB

### Splunk Observability pricing axes

Splunk Observability (formerly SignalFx) prices by host for infrastructure and APM.

| Capability                | Per host/month                | Notes                                    |
| ------------------------- | ----------------------------- | ---------------------------------------- |
| Infrastructure monitoring | $15                           | Per host; includes 10K MTS/host          |
| APM                       | $55                           | Per APM host; includes traces            |
| RUM                       | $1/1K sessions                | Monthly                                  |
| Log Observer Connect      | Included with Splunk Platform | Requires Splunk Enterprise/Cloud license |
| Log Observer (standalone) | $2.00/GB                      | Ingestion pricing                        |
| On-call                   | $21/user/month                | For incident management                  |
| Synthetics                | $11/test/month                | Per scripted browser test                |

**Hidden costs:**

- Log Observer is often positioned as "included" but requires a Splunk Platform license (Enterprise or Cloud), which itself costs $2-15/GB/day depending on workload tier
- The Cisco acquisition has introduced uncertainty about long-term pricing; several federal customers report renewal increases of 15-25% in 2025-2026
- MTS (metric time series) overages beyond 10K per host charge $3.60/1K MTS/month

### Azure Monitor pricing axes

Azure Monitor uses consumption-based pricing with no per-host or per-user fees.

| Capability                            | Cost                           | Notes                                             |
| ------------------------------------- | ------------------------------ | ------------------------------------------------- |
| Log Analytics (pay-as-you-go)         | $2.76/GB ingested              | Analytics logs; includes 31-day retention         |
| Log Analytics (100 GB/day commitment) | $2.30/GB                       | 17% discount; monthly commitment                  |
| Log Analytics (200 GB/day commitment) | $2.07/GB                       | 25% discount                                      |
| Log Analytics (500 GB/day commitment) | $1.96/GB                       | 29% discount                                      |
| Log Analytics (1000+ GB/day)          | $1.84/GB                       | 33% discount                                      |
| Basic logs                            | $0.88/GB ingested              | 67% cheaper; 8-day query window                   |
| Archive                               | ~$0.02/GB/month                | Long-term storage; search via jobs                |
| Application Insights                  | Same as Log Analytics          | Workspace-based; ingestion pricing                |
| Azure Monitor Metrics                 | Free for Azure resources       | Platform metrics included                         |
| Custom metrics                        | $0.258/1K time series/month    | First 150K time series free with certain services |
| Prometheus (managed)                  | $0.08/million samples ingested | Azure Monitor managed service for Prometheus      |
| Alerts (metric)                       | $0.10/signal/month             | Per monitored metric signal                       |
| Alerts (log search)                   | $0.50-$1.50/rule/month         | Depends on frequency                              |
| Availability tests (URL ping)         | Free                           | Up to 100 per App Insights resource               |
| Availability tests (standard)         | $1.00/test/month               | 5 locations, 5-minute frequency                   |
| Multi-step web tests                  | $10.00/test/month              | Complex scenarios                                 |
| Azure Managed Grafana (Essential)     | ~$360/month                    | Optional; for Grafana dashboard UX                |
| Azure Managed Grafana (Standard)      | ~$720/month                    | Includes alerting, SLA                            |

**Cost advantages:**

- No per-host fees: 500 hosts and 50 hosts cost the same for infrastructure monitoring
- No per-user fees: every engineer can access Log Analytics and Application Insights
- Free Microsoft data: Activity logs, Entra ID logs, Defender data ingested free
- VM Insights and Container Insights included with Azure Monitor Agent deployment
- Application Insights sampling reduces ingestion volume while maintaining statistical accuracy

---

## TCO comparison: Small environment (50 hosts, 50 GB/day)

| Cost element (annual)               | Datadog Enterprise | New Relic Pro      | Splunk Observability | Azure Monitor         |
| ----------------------------------- | ------------------ | ------------------ | -------------------- | --------------------- |
| Infrastructure monitoring           | $19,800            | Included           | $9,000               | $0                    |
| APM (10 app hosts)                  | $4,800             | Included           | $6,600               | $0                    |
| Log ingestion (50 GB/day)           | $1,825             | $4,563             | $36,500              | $42,140 (PAYG)        |
| Log indexing/retention              | $31,025            | Included in ingest | Incl. with platform  | Included (31 days)    |
| User licenses                       | $0                 | $137,880 (10 Pro)  | $0                   | $0                    |
| Custom metrics (5K)                 | $2,940             | Included           | $0 (within 10K MTS)  | $0 (within free tier) |
| Synthetics (5K/mo)                  | $432               | $300               | $0                   | $0 (URL ping free)    |
| RUM (100K sessions/mo)              | $2,160             | Included           | $1,200               | Included              |
| **Annual total**                    | **$63,000**        | **$142,700**       | **$53,300**          | **$42,100**           |
| **5-year total**                    | **$315,000**       | **$713,500**       | **$266,500**         | **$210,500**          |
| **5-year savings vs Azure Monitor** | $104,500 more      | $503,000 more      | $56,000 more         | Baseline              |

At the small end, Azure Monitor's advantage is moderate -- savings are driven primarily by the absence of per-host and per-user fees. The biggest surprise is New Relic's cost, driven by per-user pricing that dominates even small environments.

---

## TCO comparison: Medium environment (500 hosts, 500 GB/day)

| Cost element (annual)               | Datadog Enterprise | New Relic Pro      | Splunk Observability | Azure Monitor                   |
| ----------------------------------- | ------------------ | ------------------ | -------------------- | ------------------------------- |
| Infrastructure monitoring           | $198,000           | Included           | $90,000              | $0                              |
| APM (50 app hosts)                  | $24,000            | Included           | $33,000              | $0                              |
| Log ingestion (500 GB/day)          | $18,250            | $45,625            | $365,000             | $357,700 (500 GB tier)          |
| Log indexing/retention              | $310,250           | Included in ingest | Incl. with platform  | Included (31 days)              |
| User licenses                       | $0                 | $689,400 (50 Pro)  | $0                   | $0                              |
| Custom metrics (50K)                | $29,400            | Included           | $14,400              | $0 (mostly within tiers)        |
| Synthetics (50K/mo)                 | $4,320             | $3,000             | $6,600               | $1,200                          |
| RUM (1M sessions/mo)                | $21,600            | Included           | $12,000              | Included                        |
| Continuous Profiler                 | $11,400            | Included           | N/A                  | $0 (included with App Insights) |
| **Annual total**                    | **$617,200**       | **$738,000**       | **$521,000**         | **$359,000**                    |
| **5-year total**                    | **$3,086,000**     | **$3,690,000**     | **$2,605,000**       | **$1,795,000**                  |
| **5-year savings vs Azure Monitor** | $1,291,000 more    | $1,895,000 more    | $810,000 more        | Baseline                        |

At medium scale, Azure Monitor's advantage becomes substantial. The primary driver is per-host costs (infrastructure + APM) for Datadog and Splunk Observability, and per-user costs for New Relic. Azure Monitor's 500 GB/day commitment tier provides a 29% discount over pay-as-you-go.

---

## TCO comparison: Large environment (3,000 hosts, 3 TB/day)

| Cost element (annual)               | Datadog Enterprise | New Relic Pro        | Splunk Observability | Azure Monitor              |
| ----------------------------------- | ------------------ | -------------------- | -------------------- | -------------------------- |
| Infrastructure monitoring           | $1,188,000         | Included             | $540,000             | $0                         |
| APM (200 app hosts)                 | $96,000            | Included             | $132,000             | $0                         |
| Log ingestion (3 TB/day)            | $109,500           | $273,750             | $2,190,000           | $2,014,800 (3 TB/day tier) |
| Log indexing/retention              | $1,861,500         | Included in ingest   | Incl. with platform  | Included (31 days)         |
| User licenses                       | $0                 | $2,757,600 (200 Pro) | $0                   | $0                         |
| Custom metrics (500K)               | $294,000           | Included             | $176,400             | $92,000                    |
| Synthetics (200K/mo)                | $17,280            | $12,000              | $26,400              | $4,800                     |
| RUM (10M sessions/mo)               | $216,000           | Included             | $120,000             | Included                   |
| Continuous Profiler                 | $45,600            | Included             | N/A                  | $0                         |
| Database monitoring (20 hosts)      | $20,160            | Included             | N/A                  | $0 (for Azure SQL)         |
| **Annual total**                    | **$3,848,000**     | **$3,043,400**       | **$3,185,000**       | **$2,112,000**             |
| **5-year total**                    | **$19,240,000**    | **$15,217,000**      | **$15,925,000**      | **$10,560,000**            |
| **5-year savings vs Azure Monitor** | $8,680,000 more    | $4,657,000 more      | $5,365,000 more      | Baseline                   |

At enterprise scale, Azure Monitor saves $4.6M-$8.7M over 5 years compared to competitors. The cost gap widens with scale because per-host fees scale linearly while Azure Monitor's ingestion-only model benefits from commitment tier discounts at higher volumes.

---

## Hidden cost analysis

Beyond list prices, several hidden costs affect TCO calculations.

### Datadog hidden costs

| Hidden cost                 | Impact                                                                                                                         | Azure Monitor equivalent                                                                 |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| **Container host counting** | Ephemeral containers cause unpredictable host counts; Kubernetes pod churn can inflate bills                                   | No per-host fees; Container Insights is usage-based                                      |
| **Custom metric explosion** | Prometheus-style metrics generate thousands of time series per service; at $0.05/metric/month, 100K custom metrics = $60K/year | First 150K time series free with certain services; Managed Prometheus at $0.08/M samples |
| **Log rehydration**         | Retrieving archived logs costs $0.10/GB -- same as initial ingestion; frequent compliance queries double log costs             | Archive search jobs at minimal cost; no re-ingestion fee                                 |
| **Sensitive data scanner**  | $0.12/GB scanned for PII detection in logs                                                                                     | Log Analytics transformation rules (included)                                            |
| **Audit trail**             | Enterprise-only feature; required for compliance                                                                               | Azure Activity Log + Diagnostic Settings (free)                                          |
| **SSO/SAML**                | Enterprise-only ($33/host/month vs $23/host/month Pro)                                                                         | Entra ID integration (included)                                                          |
| **HIPAA compliance**        | Enterprise-only                                                                                                                | Azure Monitor in Azure Government (included)                                             |

### New Relic hidden costs

| Hidden cost                   | Impact                                                                                                                                     | Azure Monitor equivalent                                  |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------- |
| **Access restriction**        | Per-user pricing forces organizations to restrict observability access; engineers without Full Platform licenses cannot investigate issues | No per-user fees; all engineers can query                 |
| **Data retention upgrades**   | Standard retention is 30 days; extending to 90 days requires Data Plus at $0.35/GB (vs $0.30/GB standard)                                  | 31-day default; extend up to 730 days at incremental cost |
| **Live Archives**             | Long-term compliance retention costs additional per GB                                                                                     | Basic logs (67% cheaper) + archive ($0.02/GB/month)       |
| **Vulnerability management**  | Requires Data Plus subscription                                                                                                            | Microsoft Defender (separate product)                     |
| **Certified premium support** | $99/user/month premium support                                                                                                             | Azure support plans (shared across all Azure services)    |

### Splunk Observability hidden costs

| Hidden cost                       | Impact                                                                  | Azure Monitor equivalent                                    |
| --------------------------------- | ----------------------------------------------------------------------- | ----------------------------------------------------------- |
| **Splunk Platform dependency**    | Log Observer "included" requires Splunk Platform license ($2-15/GB/day) | Log Analytics standalone ($2.76/GB or less with commitment) |
| **MTS overages**                  | Metric time series beyond 10K/host at $3.60/1K MTS/month                | Azure Monitor Metrics free for platform metrics             |
| **Cisco acquisition uncertainty** | Renewal increases of 15-25% reported; roadmap integration uncertainty   | Azure Monitor pricing has been stable since 2022            |
| **On-call pricing**               | $21/user/month for incident management                                  | Action groups included; ITSM connector included             |
| **Training and certification**    | Splunk-specific skills; Observability differs from Splunk Enterprise    | KQL is the common language across all Azure data services   |

---

## Cost optimization strategies for Azure Monitor

### Commitment tiers

The single largest cost lever. Organizations should analyze 30 days of ingestion data and commit to the appropriate tier.

| Daily ingestion | Pay-as-you-go | Commitment tier            | Annual savings |
| --------------- | ------------- | -------------------------- | -------------- |
| 100 GB/day      | $100,740/yr   | $83,950/yr (100 GB tier)   | $16,790 (17%)  |
| 300 GB/day      | $302,220/yr   | $237,250/yr (300 GB tier)  | $64,970 (21%)  |
| 500 GB/day      | $503,700/yr   | $357,700/yr (500 GB tier)  | $146,000 (29%) |
| 1,000 GB/day    | $1,007,400/yr | $671,600/yr (1000 GB tier) | $335,800 (33%) |

### Basic logs vs Analytics logs

Route high-volume, low-query-frequency logs to Basic tier for 67% savings.

| Log type                      | Recommended tier | Rationale                                   |
| ----------------------------- | ---------------- | ------------------------------------------- |
| Application traces/exceptions | Analytics        | Frequently queried; supports all KQL        |
| Security/audit logs           | Analytics        | Compliance queries; alert rules             |
| Infrastructure metrics/logs   | Analytics        | Active monitoring and dashboards            |
| Debug/verbose logs            | Basic            | Rarely queried; ad-hoc investigation only   |
| CDN/WAF access logs           | Basic            | High volume; occasional investigation       |
| Raw telemetry (IoT, sensors)  | Basic            | Archived for compliance; infrequent queries |

### Application Insights sampling

Adaptive sampling can reduce Application Insights data volume by 50-90% while maintaining statistically accurate metrics.

| Strategy                     | Volume reduction      | Accuracy impact                         |
| ---------------------------- | --------------------- | --------------------------------------- |
| No sampling                  | 0%                    | Perfect (but expensive)                 |
| Adaptive sampling (default)  | 60-80%                | Minimal impact on aggregates            |
| Fixed-rate sampling (1 in 5) | 80%                   | Some rare events may be missed          |
| Ingestion sampling           | 50-90% (configurable) | Applied after collection; less accurate |

### Archive tier for compliance

For organizations with 1-7 year log retention requirements (common in federal), archive tier reduces long-term storage costs by 95%.

| Retention scenario           | Analytics logs (annual)         | Archive (annual)                     | Savings               |
| ---------------------------- | ------------------------------- | ------------------------------------ | --------------------- |
| 500 GB/day, 1-year retention | $503,700 + $146,000 retention   | $357,700 ingestion + $3,650 archive  | 85% on retention cost |
| 500 GB/day, 7-year retention | $503,700 + $1,022,000 retention | $357,700 ingestion + $25,550 archive | 97% on retention cost |

---

## Procurement considerations

### Federal contract vehicles

Azure Monitor is available through all major federal contract vehicles as part of Azure services.

| Vehicle             | Azure Monitor availability | Datadog       | New Relic     | Splunk               |
| ------------------- | -------------------------- | ------------- | ------------- | -------------------- |
| Azure Government EA | Included                   | Not available | Not available | Separate procurement |
| GSA MAS             | Available                  | Limited       | Limited       | Available            |
| NASA SEWP           | Available                  | Limited       | Available     | Available            |
| NITAAC CIO-SP3/SP4  | Available                  | Limited       | Limited       | Available            |
| DoD ESI             | Available                  | Not available | Not available | Available            |

### Microsoft licensing synergies

Organizations with existing Microsoft agreements may benefit from:

- **Azure commitment consumption** -- Azure Monitor spend counts toward Azure commitment minimums
- **Microsoft 365 E5** -- includes advanced audit log ingestion at no additional cost when sent to Sentinel (which shares the Log Analytics backend)
- **Microsoft Unified Support** -- Azure Monitor support is included in enterprise support agreements that already cover Azure

---

## Recommendation

For Azure-primary environments:

1. **Small (50 hosts, 50 GB/day):** Azure Monitor saves 20-70% over competitors. Implement pay-as-you-go pricing and upgrade to commitment tiers as ingestion stabilizes.
2. **Medium (500 hosts, 500 GB/day):** Azure Monitor saves 30-50% over competitors. Implement 500 GB/day commitment tier, use Basic logs for verbose data, and enable Application Insights sampling.
3. **Large (3,000 hosts, 3 TB/day):** Azure Monitor saves 45-55% over competitors. Implement the highest applicable commitment tier, aggressively route to Basic logs, configure archive for compliance retention, and optimize sampling.

For all sizes, the savings increase further when accounting for hidden costs (SSO licensing, audit trail features, access restrictions) and operational costs (single identity model, no separate vendor management, unified support).

---

**Related:** [Why Azure Monitor](why-azure-monitor.md) | [Feature Mapping](feature-mapping-complete.md) | [Migration Playbook](../observability-to-azure-monitor.md) | [Benchmarks](benchmarks.md)
