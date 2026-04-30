# Complete Feature Mapping: Splunk to Microsoft Sentinel

**Status:** Authored 2026-04-30
**Audience:** Security Architects, SOC Engineers, Detection Engineers, Platform Engineers
**Purpose:** Comprehensive feature-by-feature mapping from Splunk to Microsoft Sentinel with CSA-in-a-Box integration points

---

## How to use this document

This document maps 50+ Splunk features to their Microsoft Sentinel equivalents. Each mapping includes:

- **Splunk feature** -- what it does in Splunk
- **Sentinel equivalent** -- the corresponding Sentinel/Azure capability
- **Migration complexity** -- effort required (XS/S/M/L/XL)
- **Notes** -- key differences, gotchas, and CSA-in-a-Box integration points

---

## 1. Query languages

### SPL vs KQL

| Concept              | SPL (Splunk)                                | KQL (Sentinel / Log Analytics)                                                            | Notes                                                      |
| -------------------- | ------------------------------------------- | ----------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| **Basic search**     | `search index=main error`                   | `SecurityEvent \| where EventData contains "error"`                                       | KQL is pipe-forward like SPL; tables replace indexes       |
| **Field extraction** | `\| rex field=_raw "user=(?<username>\w+)"` | `\| extend username = extract("user=(\\w+)", 1, RawData)`                                 | KQL uses `extract()` with regex groups                     |
| **Statistics**       | `\| stats count by src_ip`                  | `\| summarize count() by SrcIP`                                                           | `stats` maps to `summarize`                                |
| **Time chart**       | `\| timechart span=1h count by status`      | `\| summarize count() by bin(TimeGenerated, 1h), Status`                                  | `timechart` maps to `summarize` + `bin()`                  |
| **Conditional**      | `\| eval risk=if(count>10,"high","low")`    | `\| extend risk = iff(count_ > 10, "high", "low")`                                        | `eval` maps to `extend`; `if()` maps to `iff()`            |
| **Where clause**     | `\| where count > 5`                        | `\| where count_ > 5`                                                                     | Nearly identical syntax                                    |
| **Sort**             | `\| sort -count`                            | `\| sort by count_ desc`                                                                  | KQL uses explicit `asc`/`desc`                             |
| **Head/limit**       | `\| head 10`                                | `\| take 10` or `\| top 10 by field`                                                      | `head` maps to `take`                                      |
| **Dedup**            | `\| dedup src_ip`                           | `\| distinct SrcIP` or `\| summarize take_any(*) by SrcIP`                                | Use `distinct` for simple dedup                            |
| **Rename**           | `\| rename src_ip AS SourceIP`              | `\| project-rename SourceIP = SrcIP`                                                      | `rename` maps to `project-rename`                          |
| **Table**            | `\| table src_ip, dest_ip, action`          | `\| project SrcIP, DstIP, Action`                                                         | `table` maps to `project`                                  |
| **Lookup**           | `\| lookup threat_intel ip AS src_ip`       | `\| join kind=leftouter (ThreatIntelligenceIndicator) on $left.SrcIP == $right.NetworkIP` | Lookups map to `join` or `externaldata`                    |
| **Transaction**      | `\| transaction session_id maxspan=30m`     | `\| summarize makelist(EventID), ... by session_id, bin(TimeGenerated, 30m)`              | No direct equivalent; use `summarize` with aggregations    |
| **Subsearch**        | `[search index=threats \| fields ip]`       | `let threats = ThreatIntel \| project IP; MainTable \| where SrcIP in (threats)`          | Use `let` statements for subqueries                        |
| **Macro**            | `` `my_macro(param)` ``                     | Functions in Log Analytics                                                                | Create saved functions for reusable query patterns         |
| **Eventtypes**       | `eventtype=authentication`                  | Saved queries or functions                                                                | No direct equivalent; use functions or workbook parameters |
| **Tags**             | `tag=network`                               | Custom fields via DCR transforms                                                          | Tags map to custom columns added at ingestion              |
| **Calculated field** | `\| eval duration=end_time-start_time`      | `\| extend duration = EndTime - StartTime`                                                | `eval` maps to `extend`                                    |
| **Multivalue**       | `\| mvexpand field`                         | `\| mv-expand field`                                                                      | Nearly identical                                           |
| **String functions** | `\| eval lower_user=lower(user)`            | `\| extend lower_user = tolower(user)`                                                    | Function names differ slightly                             |
| **Time functions**   | `\| eval hour=strftime(_time, "%H")`        | `\| extend hour = datetime_part("hour", TimeGenerated)`                                   | Different function names and syntax                        |

### Advanced SPL to KQL patterns

| SPL pattern                                      | KQL equivalent                                                                                                              | Complexity                             |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| `\| tstats count where index=main by sourcetype` | `union * \| summarize count() by Type`                                                                                      | M                                      |
| `\| datamodel Authentication \| search ...`      | `SigninLogs \| where ...`                                                                                                   | S (data models map to specific tables) |
| `\| inputlookup my_list.csv`                     | `externaldata(col1:string, col2:string) [@"https://storage.blob.core.windows.net/lookups/my_list.csv"] with (format="csv")` | M                                      |
| `\| map search="search index=main src_ip=$ip$"`  | `let ips = ...; SecurityEvent \| where SrcIP in (ips)`                                                                      | M                                      |
| `\| appendcols [search ...]`                     | `\| join kind=inner (subquery) on key`                                                                                      | M                                      |
| `\| fillnull value=0`                            | `\| extend field = coalesce(field, 0)`                                                                                      | XS                                     |
| `\| bucket span=1h _time`                        | `\| summarize by bin(TimeGenerated, 1h)`                                                                                    | XS                                     |

---

## 2. Data storage and management

| Splunk feature                   | Sentinel/Azure equivalent                 | Migration complexity | Notes                                                                                                                                                              |
| -------------------------------- | ----------------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Indexes**                      | Log Analytics tables / custom tables      | M                    | Each Splunk index maps to one or more Log Analytics tables. Built-in tables (SecurityEvent, Syslog, etc.) have pre-defined schemas. Custom logs use custom tables. |
| **Sourcetypes**                  | Table name + Data Collection Rules        | S                    | Sourcetypes are implicit in Sentinel -- each connector writes to specific tables. DCRs handle transformation.                                                      |
| **Hot/Warm buckets**             | Analytics Logs (interactive tier)         | XS                   | No manual tier management -- all interactive data is hot.                                                                                                          |
| **Cold buckets**                 | Basic Logs tier                           | S                    | High-volume, infrequently queried data at 60-75% cost reduction.                                                                                                   |
| **Frozen buckets**               | Archive tier                              | S                    | Near-zero cost storage. Restore to interactive on demand (search job).                                                                                             |
| **Data models**                  | Table schemas + watchlists                | M                    | Splunk data models map to pre-defined table schemas. Custom data models require custom tables.                                                                     |
| **Lookups**                      | Watchlists / externaldata / enrichment    | M                    | Watchlists for frequently used reference data. `externaldata` for larger datasets. Enrichment via Logic Apps for dynamic lookups.                                  |
| **Summary indexing**             | Summarize rules / ADX materialized views  | M                    | Pre-computed aggregations can be scheduled as analytics rules writing to custom tables, or materialized in ADX.                                                    |
| **Event forwarding**             | Data export rules / Event Hub integration | S                    | Log Analytics data export to Event Hub, Storage, or ADX for downstream processing.                                                                                 |
| **Index-time field extraction**  | Data Collection Rule transforms           | M                    | DCRs support KQL-based transformation at ingestion time.                                                                                                           |
| **Search-time field extraction** | KQL at query time                         | XS                   | KQL `extract`, `parse`, `extend` at query time.                                                                                                                    |
| **Data retention policies**      | Log Analytics retention settings          | XS                   | Per-table retention from 30 days to 12 years. Archive tier for extended retention.                                                                                 |
| **License usage tracking**       | Azure Cost Management + Usage table       | S                    | `Usage` table in Log Analytics tracks ingestion per table. Azure Cost Management for billing.                                                                      |

---

## 3. Detection and alerting

| Splunk feature                         | Sentinel equivalent                  | Migration complexity | Notes                                                                                                |
| -------------------------------------- | ------------------------------------ | -------------------- | ---------------------------------------------------------------------------------------------------- |
| **Correlation searches (ES)**          | Analytics rules (scheduled)          | M                    | SPL correlation searches translate to KQL analytics rules. SIEM Migration Experience automates this. |
| **Notable events (ES)**                | Incidents                            | S                    | Notables become incidents with severity, entities, and evidence.                                     |
| **Risk-based alerting (ES)**           | Analytics rules + entity behavior    | M                    | Sentinel UEBA provides entity risk scoring. Custom risk rules via analytics.                         |
| **Adaptive response actions (ES)**     | Automation rules + playbooks         | M                    | Automation rules trigger playbooks (Logic Apps) on incident creation.                                |
| **Threat intelligence framework (ES)** | Threat Intelligence blade            | S                    | Native TI connector supports STIX/TAXII, Microsoft TI, MISP.                                         |
| **MITRE ATT&CK mapping (ES)**          | MITRE ATT&CK blade in Sentinel       | XS                   | Native MITRE ATT&CK coverage visualization.                                                          |
| **Scheduled searches**                 | Analytics rules (scheduled)          | S                    | Direct mapping. KQL query runs on schedule, generates alerts/incidents.                              |
| **Real-time searches**                 | Near-real-time (NRT) analytics rules | S                    | NRT rules run every minute with minimal latency.                                                     |
| **Alerts**                             | Analytics rules                      | S                    | All alert types map to analytics rules with configurable severity and entity mapping.                |
| **Alert actions**                      | Automation rules                     | S                    | Automation rules execute on alert/incident creation -- assign, tag, run playbook, suppress.          |
| **Throttling**                         | Alert grouping + suppression         | S                    | Sentinel supports event grouping and suppression windows.                                            |
| **Custom alert actions**               | Playbooks (Logic Apps)               | M                    | Custom actions become Logic App workflows triggered by automation rules.                             |

---

## 4. Security operations

| Splunk feature                      | Sentinel equivalent                | Migration complexity | Notes                                                                                                |
| ----------------------------------- | ---------------------------------- | -------------------- | ---------------------------------------------------------------------------------------------------- |
| **Splunk Enterprise Security (ES)** | Microsoft Sentinel                 | L                    | ES is a premium Splunk app; Sentinel is the base platform with all SIEM capabilities included.       |
| **ES Security Posture dashboard**   | Sentinel Overview + workbooks      | M                    | Pre-built Sentinel workbooks provide similar posture views. Custom workbooks for SOC-specific views. |
| **ES Incident Review**              | Sentinel Incidents blade           | S                    | Incidents with investigation graph, entity timeline, and evidence.                                   |
| **ES Investigation workbench**      | Investigation graph + entity pages | M                    | Sentinel's investigation graph provides entity-centric investigation.                                |
| **ES Asset & Identity framework**   | UEBA + watchlists                  | M                    | UEBA provides entity behavior analytics. Watchlists for asset/identity enrichment.                   |
| **ES Threat Intelligence**          | Threat Intelligence blade          | S                    | Native TI management with STIX/TAXII support.                                                        |
| **ES Risk framework**               | UEBA anomaly scores                | M                    | UEBA calculates anomaly scores per entity. Custom risk scoring via analytics rules.                  |
| **ES Content Management**           | Content Hub                        | S                    | Content Hub solutions provide pre-built analytics rules, workbooks, playbooks, and connectors.       |
| **ES Use Case Library**             | Content Hub solutions catalog      | S                    | Browse solutions by vendor, data source, or scenario.                                                |

---

## 5. SOAR and automation

| Splunk feature                   | Sentinel equivalent                       | Migration complexity | Notes                                                                                                           |
| -------------------------------- | ----------------------------------------- | -------------------- | --------------------------------------------------------------------------------------------------------------- |
| **Splunk SOAR platform**         | Playbooks (Logic Apps) + automation rules | L                    | SOAR is a separate Splunk product. Sentinel playbooks are built on Logic Apps -- included, no separate license. |
| **SOAR playbooks**               | Logic App workflows                       | M                    | Each SOAR playbook maps to a Logic App. 500+ pre-built connectors available.                                    |
| **SOAR apps (integrations)**     | Logic App connectors                      | M                    | Most SOAR app integrations have Logic App connector equivalents. Custom connectors for niche integrations.      |
| **SOAR actions**                 | Logic App actions                         | S                    | Individual actions (block IP, disable user, create ticket) map to Logic App connector actions.                  |
| **SOAR prompts (human-in-loop)** | Logic App approval workflows              | M                    | Approval connectors for Teams, email, and custom prompts.                                                       |
| **SOAR case management**         | Sentinel incident management              | S                    | Incidents with assignment, comments, tasks, and evidence.                                                       |
| **SOAR custom scripts**          | Azure Functions + Logic Apps              | M                    | Custom Python/PowerShell scripts become Azure Functions called from Logic Apps.                                 |
| **SOAR workbooks**               | Sentinel workbooks for SOAR metrics       | S                    | Custom workbooks tracking playbook execution, MTTR, automation coverage.                                        |
| **Automation frequency**         | Automation rule triggers                  | S                    | Automation rules trigger on incident creation, update, or alert creation.                                       |

---

## 6. Data collection and forwarding

| Splunk feature                 | Sentinel equivalent                   | Migration complexity | Notes                                                                                                       |
| ------------------------------ | ------------------------------------- | -------------------- | ----------------------------------------------------------------------------------------------------------- |
| **Universal Forwarder (UF)**   | Azure Monitor Agent (AMA)             | M                    | AMA replaces UF on Windows/Linux endpoints. Data Collection Rules control what is collected.                |
| **Heavy Forwarder (HF)**       | Log forwarder VM / Azure Functions    | M                    | For syslog/CEF aggregation, deploy a log forwarder VM with AMA. For custom processing, use Azure Functions. |
| **Deployment Server**          | Azure Arc / Intune / GPO              | M                    | Agent deployment via Azure Arc (servers), Intune (endpoints), or GPO (domain-joined).                       |
| **Syslog inputs**              | Syslog via AMA on Linux forwarder     | S                    | AMA on Linux collects syslog. Syslog table in Log Analytics.                                                |
| **CEF inputs**                 | CEF via AMA on Linux forwarder        | S                    | AMA on Linux collects CEF. CommonSecurityLog table.                                                         |
| **Windows Event Log**          | AMA Windows event collection          | S                    | AMA collects Windows events via Data Collection Rules. SecurityEvent table.                                 |
| **HTTP Event Collector (HEC)** | Data Collection API (DCR-based)       | M                    | Log Analytics Data Collection API replaces HEC for custom data ingestion.                                   |
| **Scripted inputs**            | Azure Functions + Data Collection API | M                    | Custom data collection scripts become Azure Functions posting to Data Collection API.                       |
| **Modular inputs**             | Logic Apps + Data Collection API      | M                    | Modular inputs (API polling) map to Logic Apps or Azure Functions on a timer.                               |
| **DB Connect**                 | Logic App SQL connector / ADF         | M                    | Database polling maps to Logic App SQL connector or ADF pipelines.                                          |
| **Splunk apps (data inputs)**  | Content Hub data connectors           | S                    | Most Splunk app data inputs have equivalent Content Hub connectors.                                         |
| **S2S (Splunk-to-Splunk)**     | Workspace-to-workspace queries        | S                    | Cross-workspace queries in KQL. Azure Lighthouse for multi-tenant.                                          |
| **Index-time parsing**         | Data Collection Rule transforms       | M                    | DCR transforms support KQL-based parsing at ingestion time.                                                 |

---

## 7. Visualization and reporting

| Splunk feature           | Sentinel equivalent                          | Migration complexity | Notes                                                                       |
| ------------------------ | -------------------------------------------- | -------------------- | --------------------------------------------------------------------------- |
| **Dashboards**           | Sentinel workbooks (Azure Monitor Workbooks) | M                    | Workbooks support KQL queries, parameters, visualizations, and drill-downs. |
| **Dashboard panels**     | Workbook tiles / steps                       | S                    | Each Splunk panel maps to a workbook step with chart type selection.        |
| **Dashboard drilldowns** | Workbook parameters + links                  | M                    | Workbook parameters enable dynamic filtering and drill-through.             |
| **Scheduled reports**    | Scheduled analytics rules + workbooks        | S                    | Schedule queries to run and export results.                                 |
| **PDF/email reports**    | Logic App scheduled exports                  | M                    | Logic Apps can render workbooks to PDF and email on schedule.               |
| **Real-time dashboards** | Workbooks with auto-refresh                  | S                    | Workbooks support auto-refresh intervals for near-real-time views.          |
| **Chart types**          | Workbook visualization types                 | S                    | Time series, bar, pie, map, grid, tile, and custom JSON chart types.        |
| **Dashboard tokens**     | Workbook parameters                          | M                    | Dashboard tokens map to workbook parameters with cascading filter support.  |
| **Dashboard XML**        | Workbook JSON (ARM template)                 | M                    | Workbooks are defined in JSON and can be deployed via ARM/Bicep.            |
| **Splunk Mobile**        | Azure mobile app + Power BI mobile           | S                    | Power BI mobile app provides on-the-go dashboard access.                    |

### CSA-in-a-Box visualization integration

| Visualization need           | Sentinel workbooks | Power BI (via CSA-in-a-Box) | Best for                             |
| ---------------------------- | ------------------ | --------------------------- | ------------------------------------ |
| SOC operational dashboards   | Primary            | Secondary                   | Real-time SOC operations             |
| Executive security reporting | Limited            | Primary                     | Board-level, CISO reporting          |
| Cross-domain analytics       | No                 | Primary                     | Security + business data correlation |
| Compliance dashboards        | Workbook templates | Primary                     | Audit and compliance reporting       |
| Ad-hoc threat hunting        | Primary (KQL)      | No                          | Analyst investigation workflows      |

---

## 8. Administration and management

| Splunk feature          | Sentinel equivalent                      | Migration complexity | Notes                                                                                                         |
| ----------------------- | ---------------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------- |
| **Splunk Web admin**    | Azure portal / Defender portal           | S                    | Web-based administration through Azure portal and Microsoft Defender portal.                                  |
| **User roles**          | Azure RBAC + Sentinel roles              | M                    | Built-in roles: Sentinel Reader, Responder, Contributor, Automation Contributor. Custom roles via Azure RBAC. |
| **Knowledge objects**   | Saved queries, functions, watchlists     | M                    | Macros become functions. Lookups become watchlists. Field aliases handled in DCRs.                            |
| **Apps and add-ons**    | Content Hub solutions                    | S                    | Content Hub provides vendor-specific solutions with connectors, rules, workbooks, and playbooks.              |
| **Server classes**      | Data Collection Rules + Azure Policy     | M                    | Server classes (forwarder grouping) map to DCR associations and Azure Policy-based agent deployment.          |
| **Cluster management**  | Azure-managed (no clusters)              | XS                   | No infrastructure to manage.                                                                                  |
| **License management**  | Azure Cost Management + commitment tiers | S                    | No license servers. Cost management through Azure Cost Management and commitment tiers.                       |
| **Monitoring console**  | Azure Monitor + health diagnostics       | S                    | Sentinel health and audit diagnostics. Azure Monitor for workspace health.                                    |
| **Configuration files** | ARM/Bicep templates + API                | M                    | Infrastructure as code via Bicep (CSA-in-a-Box pattern) or ARM templates.                                     |
| **Distributed search**  | Cross-workspace queries                  | S                    | KQL supports querying across multiple Log Analytics workspaces.                                               |

---

## 9. Threat hunting

| Splunk feature                      | Sentinel equivalent            | Migration complexity | Notes                                                              |
| ----------------------------------- | ------------------------------ | -------------------- | ------------------------------------------------------------------ |
| **Ad-hoc search**                   | Log Analytics query editor     | XS                   | Full KQL editor with IntelliSense.                                 |
| **Saved searches**                  | Hunting queries                | S                    | Saved queries organized by MITRE ATT&CK tactic.                    |
| **Hunting dashboards (ES)**         | Hunting blade                  | S                    | Pre-built and custom hunting queries with bookmarks.               |
| **Investigation notebooks**         | Sentinel notebooks (Jupyter)   | M                    | Jupyter notebooks with MSTICPy library for advanced investigation. |
| **Bookmarks**                       | Hunting bookmarks              | XS                   | Bookmark evidence during hunting for later incident creation.      |
| **Threat intelligence correlation** | TI matching analytics rules    | S                    | Automatic correlation of indicators against all ingested data.     |
| **Anomaly detection**               | UEBA + anomaly analytics rules | M                    | Built-in ML-powered anomaly detection.                             |

---

## 10. Compliance and audit

| Splunk feature            | Sentinel equivalent             | CSA-in-a-Box integration        | Notes                                                                                    |
| ------------------------- | ------------------------------- | ------------------------------- | ---------------------------------------------------------------------------------------- |
| **Splunk PCI Compliance** | Sentinel PCI workbook           | Purview PCI classifications     | Content Hub PCI solution + CSA-in-a-Box PCI-DSS compliance matrix                        |
| **Audit logging**         | Azure Activity + Sentinel audit | Tamper-evident audit logger     | All workspace operations logged. CSA-in-a-Box adds hash-chained audit trail.             |
| **Data integrity**        | Azure storage integrity         | Purview data quality            | Azure storage provides immutable blob support.                                           |
| **Retention compliance**  | Per-table retention + archive   | ADX long-term storage           | Configurable retention per table. ADX for multi-year archive with full query capability. |
| **Role-based access**     | Azure RBAC + table-level RBAC   | Purview access governance       | Fine-grained access control at workspace, table, and row level.                          |
| **FedRAMP evidence**      | Azure compliance portal         | CSA-in-a-Box NIST 800-53 matrix | Inherited from Azure Government authorization + CSA-in-a-Box control mappings.           |

---

## 11. Integration and extensibility

| Splunk feature             | Sentinel equivalent              | Migration complexity | Notes                                                                                        |
| -------------------------- | -------------------------------- | -------------------- | -------------------------------------------------------------------------------------------- |
| **REST API**               | Log Analytics API + Sentinel API | S                    | Full REST API for query, incident management, and configuration.                             |
| **SDKs**                   | Azure SDKs (Python, .NET, etc.)  | S                    | Azure SDK supports all Sentinel operations programmatically.                                 |
| **Webhooks**               | Logic Apps HTTP triggers         | S                    | Logic Apps provide webhook-based integration.                                                |
| **Custom commands**        | KQL functions + Azure Functions  | M                    | Custom search commands become KQL saved functions or Azure Functions for complex processing. |
| **Custom visualizations**  | Workbook custom JSON + Grafana   | M                    | Workbooks support custom visualization via JSON. Grafana plugin for Azure Monitor available. |
| **Splunkbase marketplace** | Content Hub + GitHub             | S                    | Content Hub is the marketplace. Community content on GitHub (Azure Sentinel repository).     |

---

## 12. User Experience and AI

| Splunk feature                               | Sentinel equivalent                             | Migration complexity | Notes                                                                                                      |
| -------------------------------------------- | ----------------------------------------------- | -------------------- | ---------------------------------------------------------------------------------------------------------- |
| **Splunk AI Assistant**                      | Security Copilot                                | XS                   | Copilot is more capable -- incident summarization, script analysis, report generation, not just query help |
| **Splunk MLTK**                              | UEBA + anomaly analytics rules                  | M                    | Built-in ML for entity behavior; custom ML via Jupyter notebooks + MSTICPy                                 |
| **Splunk UBA**                               | UEBA (User Entity Behavior Analytics)           | S                    | Native Sentinel feature; no separate add-on required                                                       |
| **Splunk Augmented Reality**                 | N/A                                             | N/A                  | Niche feature with no Sentinel equivalent                                                                  |
| **Splunk Mission Control**                   | Unified SOC experience in Defender portal       | S                    | Defender portal provides unified incident queue across Defender XDR + Sentinel                             |
| **Splunk Intelligence Management (TruSTAR)** | Threat Intelligence blade                       | M                    | Native TI management with STIX/TAXII; Microsoft TI feed included                                           |
| **Splunk Asset & Risk Framework**            | UEBA + Watchlists + Defender vulnerability data | M                    | Combination of UEBA entity scoring and watchlist-based asset enrichment                                    |
| **Splunk Risk-Based Alerting**               | Analytics rules with entity risk scoring        | M                    | Custom risk scoring via analytics rules writing to custom tables; UEBA anomaly scores                      |
| **SPL Assistant (AI)**                       | Security Copilot KQL generation                 | XS                   | Copilot generates KQL from natural language descriptions                                                   |
| **Splunk Observability Cloud**               | Azure Monitor                                   | M                    | Separate Azure service; integrated but not unified with Sentinel                                           |

---

## 13. Deployment and operations

| Splunk feature                   | Sentinel equivalent                | Migration complexity | Notes                                                            |
| -------------------------------- | ---------------------------------- | -------------------- | ---------------------------------------------------------------- |
| **Splunk Cloud (SaaS)**          | Microsoft Sentinel (cloud-native)  | S                    | Both are cloud-managed; Sentinel has no infrastructure component |
| **Splunk SmartStore**            | Log Analytics managed storage      | XS                   | Azure manages all storage automatically                          |
| **Indexer clustering**           | Azure-managed (no clusters)        | XS                   | No equivalent needed; Sentinel auto-scales                       |
| **Search head clustering**       | Azure-managed (no clusters)        | XS                   | No equivalent needed; query capacity auto-scales                 |
| **Splunk Operator (Kubernetes)** | N/A (cloud-native)                 | XS                   | Sentinel does not require Kubernetes deployment                  |
| **Splunk Data Stream Processor** | Azure Stream Analytics / Event Hub | M                    | Real-time stream processing before ingestion                     |
| **Splunk Ingest Actions**        | Data Collection Rule transforms    | S                    | KQL-based ingestion-time transformation and routing              |
| **Splunk Data Manager**          | Data connectors + Content Hub      | S                    | Guided data onboarding experience                                |
| **Splunk Assist**                | Azure Advisor + Sentinel health    | S                    | Platform health and optimization recommendations                 |
| **Configuration replication**    | ARM/Bicep templates + Git          | M                    | Infrastructure as code for all Sentinel configuration            |
| **Index replication**            | Azure zone-redundant storage       | XS                   | Built into Azure infrastructure; no manual configuration         |
| **Bucket lifecycle**             | Automated retention policies       | XS                   | Per-table retention; no manual bucket management                 |

---

## 14. Multi-tenant and MSSP

| Splunk feature                     | Sentinel equivalent                         | Migration complexity | Notes                                                                     |
| ---------------------------------- | ------------------------------------------- | -------------------- | ------------------------------------------------------------------------- |
| **Splunk multi-tenant (indexes)**  | Multi-workspace + Azure Lighthouse          | M                    | Each tenant gets a workspace; Lighthouse provides cross-tenant management |
| **Splunk Cloud Victoria**          | Azure Lighthouse + Defender multi-tenant    | M                    | Cloud-native multi-tenant management                                      |
| **Index-level RBAC**               | Table-level RBAC + resource-context RBAC    | M                    | Fine-grained access control at workspace, table, and resource level       |
| **Saved search sharing**           | Workbook sharing + analytics rule templates | S                    | Share across workspaces via Content Hub or ARM templates                  |
| **Distributed search (federated)** | Cross-workspace queries                     | S                    | `workspace()` function in KQL for cross-workspace queries                 |
| **Search affinity**                | N/A (auto-optimized)                        | XS                   | Query routing handled automatically by Azure                              |

---

## 15. CSA-in-a-Box extended feature mapping

Features that Sentinel + CSA-in-a-Box together provide that neither Splunk nor Sentinel alone offers:

| Capability                           | Splunk alone                       | Sentinel alone                   | Sentinel + CSA-in-a-Box                                                         |
| ------------------------------------ | ---------------------------------- | -------------------------------- | ------------------------------------------------------------------------------- |
| **Cross-domain security analytics**  | Limited (requires data onboarding) | SIEM data only                   | Fabric lakehouses combine security, HR, finance, IT asset data                  |
| **Security data products**           | No                                 | No                               | Published, governed data products with contracts and SLAs                       |
| **Compliance-grade data governance** | Manual classification              | Manual                           | Purview classifications + machine-readable compliance matrices                  |
| **Long-term hunting (years)**        | Cold/frozen (slow, expensive)      | Archive tier (async search jobs) | ADX sub-second queries over years of data                                       |
| **Executive security reporting**     | Splunk dashboards                  | Sentinel workbooks               | Power BI Direct Lake with natural language (Copilot)                            |
| **Security data mesh**               | No                                 | No                               | Security domain publishes governed products consumed by risk, compliance, audit |
| **Tamper-evident audit trail**       | Splunk audit logs                  | Azure Activity logs              | Hash-chained audit path (CSA-0016)                                              |
| **Data product contracts**           | No                                 | No                               | YAML contracts with SLAs, freshness, availability targets                       |
| **dbt-based security transforms**    | No                                 | No                               | dbt models for curated security datasets (bronze/silver/gold)                   |
| **Bicep-deployed SIEM**              | N/A (Ansible/Terraform)            | ARM templates                    | Full Bicep IaC aligned with CSA-in-a-Box deployment patterns                    |

---

## 16. Feature gap analysis

Features where Splunk retains an advantage:

| Feature                        | Splunk advantage                                                   | Sentinel workaround                                                             | Severity                        |
| ------------------------------ | ------------------------------------------------------------------ | ------------------------------------------------------------------------------- | ------------------------------- |
| **SPL ecosystem maturity**     | 20+ years of SPL queries, macros, and community content            | KQL is growing rapidly; SIEM Migration Experience converts most SPL             | Medium                          |
| **On-premises deployment**     | Splunk Enterprise runs on-premises or air-gapped                   | Sentinel is cloud-only; Azure Stack Hub for disconnected scenarios              | High (for specific use cases)   |
| **Unified observability**      | Splunk handles logs, metrics, traces, and security in one platform | Azure Monitor (observability) + Sentinel (security) are separate but integrated | Medium                          |
| **Custom visualization depth** | Splunk Dashboard Studio has rich custom visualization capabilities | Workbooks are functional but less visually customizable                         | Low                             |
| **Splunk DB Connect**          | Native database connectivity for enrichment                        | Logic Apps SQL connector or ADF; slightly more setup                            | Low                             |
| **IL6 support**                | Available in classified environments                               | Not available at IL6                                                            | High (for classified workloads) |

Features where Sentinel has an advantage:

| Feature                      | Sentinel advantage                                          | Splunk limitation                              |
| ---------------------------- | ----------------------------------------------------------- | ---------------------------------------------- |
| **Security Copilot**         | Native AI assistant for hunting, triage, and KQL generation | No equivalent; Splunk AI Assistant is SPL-only |
| **Free Microsoft data**      | M365, Entra, Defender XDR ingested at no cost               | All data sources cost license capacity         |
| **SOAR included**            | Logic Apps are pay-per-execution, no separate license       | SOAR is a separate $100K-$500K product         |
| **Infrastructure**           | Zero infrastructure management                              | Indexer clusters, search heads, forwarders     |
| **Defender XDR integration** | Bi-directional incident sync, unified investigation         | One-way data flow via add-on                   |
| **Multi-tenant (MSSP)**      | Azure Lighthouse native multi-tenant                        | Complex multi-tenant architecture              |
| **UEBA**                     | Built-in entity behavior analytics                          | Requires ES + UBA add-on                       |

---

## Summary

This feature mapping demonstrates that Sentinel provides functional equivalents for the vast majority of Splunk capabilities, with significant advantages in cloud-native architecture, AI integration, cost model, and Microsoft ecosystem integration. The primary gaps are on-premises deployment and IL6 support.

CSA-in-a-Box extends Sentinel's capabilities in cross-domain analytics, compliance governance, executive reporting, and long-term data retention -- areas where neither Splunk nor Sentinel alone provides a complete solution.

---

**Next steps:**

- [Detection Rules Migration](detection-rules-migration.md) -- detailed SPL-to-KQL conversion patterns
- [SOAR Migration](soar-migration.md) -- Splunk SOAR to Sentinel playbooks
- [Tutorial: SPL to KQL](tutorial-spl-to-kql.md) -- hands-on conversion examples
- [Benchmarks](benchmarks.md) -- performance comparison data

---

**Maintainers:** csa-inabox core team
**Last updated:** 2026-04-30
