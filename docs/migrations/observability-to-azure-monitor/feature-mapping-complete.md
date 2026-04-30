# Complete Feature Mapping: Observability Platforms to Azure Monitor

**Audience:** Platform Architects, SREs, DevOps Engineers
**Last updated:** 2026-04-30

---

## How to read this mapping

Each feature is rated for migration complexity:

| Rating      | Meaning                                                                  | Typical effort |
| ----------- | ------------------------------------------------------------------------ | -------------- |
| **Direct**  | 1:1 mapping; configuration-level migration                               | Hours          |
| **Near**    | Functional equivalent with minor differences                             | Days           |
| **Partial** | Azure covers most but not all of the source capability                   | Days-Weeks     |
| **Gap**     | No direct Azure Monitor equivalent; workaround or alternative documented | Weeks or N/A   |

Vendor columns use abbreviations: **DD** = Datadog, **NR** = New Relic, **SO** = Splunk Observability.

---

## 1. Application Performance Monitoring (APM)

| #   | Feature                            | DD      | NR            | SO      | Azure Monitor equivalent                                   | Mapping | Notes                                                           |
| --- | ---------------------------------- | ------- | ------------- | ------- | ---------------------------------------------------------- | ------- | --------------------------------------------------------------- |
| 1   | Auto-instrumentation (.NET)        | Yes     | Yes           | Yes     | Application Insights auto-instrumentation                  | Direct  | Codeless attach for IIS and Azure App Service                   |
| 2   | Auto-instrumentation (Java)        | Yes     | Yes           | Yes     | Application Insights Java agent (auto-instrumentation)     | Direct  | Zero-code agent; Spring Boot, Tomcat, Jetty, Quarkus            |
| 3   | Auto-instrumentation (Node.js)     | Yes     | Yes           | Yes     | Application Insights Node.js SDK                           | Near    | Requires npm package; auto-instruments Express, Fastify         |
| 4   | Auto-instrumentation (Python)      | Yes     | Yes           | Yes     | Application Insights Python SDK (OpenTelemetry)            | Near    | OpenTelemetry-based; Django, Flask, FastAPI                     |
| 5   | Auto-instrumentation (Go)          | DD only | Limited       | Yes     | OpenTelemetry Go SDK + Azure Monitor exporter              | Near    | No codeless attach; requires SDK integration                    |
| 6   | Auto-instrumentation (Ruby)        | DD only | Yes           | Limited | OpenTelemetry Ruby SDK + Azure Monitor exporter            | Near    | Community-maintained OTel instrumentation                       |
| 7   | Auto-instrumentation (PHP)         | DD only | Yes           | Limited | OpenTelemetry PHP SDK + Azure Monitor exporter             | Near    | Community-maintained                                            |
| 8   | Distributed tracing                | Yes     | Yes           | Yes     | Application Insights distributed tracing                   | Direct  | W3C TraceContext propagation; OpenTelemetry native              |
| 9   | Service map / topology             | Yes     | Yes           | Yes     | Application Insights Application Map                       | Direct  | Auto-discovered dependency topology                             |
| 10  | Dependency tracking                | Yes     | Yes           | Yes     | Application Insights dependency tracking                   | Direct  | SQL, HTTP, Azure services auto-tracked                          |
| 11  | Transaction traces                 | Yes     | Yes           | Yes     | Application Insights end-to-end transaction view           | Direct  | Drill from request to all downstream calls                      |
| 12  | Error tracking / grouping          | Yes     | Yes           | Yes     | Application Insights exceptions + failure analysis         | Near    | Grouping less sophisticated than DD Error Tracking              |
| 13  | Continuous profiler                | DD, NR  | Yes           | No      | Application Insights Profiler                              | Near    | .NET and Java; production profiling with low overhead           |
| 14  | Snapshot debugger                  | No      | No            | No      | Application Insights Snapshot Debugger                     | Unique  | .NET only; captures variable state at exception point           |
| 15  | Code-level tracing (Code Hotspots) | DD only | NR CodeStream | No      | Application Insights Profiler + VS integration             | Partial | Profiler shows hot paths; no inline IDE code-level spans        |
| 16  | Deployment tracking                | DD, NR  | Yes           | No      | Application Insights release annotations                   | Near    | Annotations on timeline; less automated than NR deployments     |
| 17  | SLI/SLO tracking                   | DD, NR  | Yes           | Yes     | Azure Monitor SLI/SLO (preview) + Workbooks                | Partial | Preview feature; custom Workbooks for SLO dashboards            |
| 18  | Service catalog                    | DD only | NR Entities   | No      | Application Insights Application Map + resource tags       | Partial | No dedicated service catalog UI; Azure Resource Graph fills gap |
| 19  | Runtime metrics                    | Yes     | Yes           | Yes     | Application Insights performance counters + custom metrics | Direct  | CPU, memory, GC, thread pool metrics                            |
| 20  | Live metrics stream                | No      | NR Streaming  | No      | Application Insights Live Metrics                          | Unique  | Real-time telemetry stream with <1s latency                     |

---

## 2. Infrastructure Monitoring

| #   | Feature                        | DD     | NR         | SO      | Azure Monitor equivalent                  | Mapping | Notes                                                      |
| --- | ------------------------------ | ------ | ---------- | ------- | ----------------------------------------- | ------- | ---------------------------------------------------------- |
| 21  | VM monitoring                  | Yes    | Yes        | Yes     | VM Insights (Azure Monitor Agent)         | Direct  | Performance counters, dependencies, processes              |
| 22  | Container monitoring           | Yes    | Yes        | Yes     | Container Insights                        | Direct  | AKS, Arc-enabled Kubernetes, self-managed k8s              |
| 23  | Kubernetes cluster monitoring  | Yes    | Yes        | Yes     | Container Insights + Managed Prometheus   | Direct  | Node, pod, container, and namespace level metrics          |
| 24  | Serverless monitoring          | Yes    | Yes        | Limited | Application Insights for Azure Functions  | Direct  | Auto-instrumented for Azure Functions                      |
| 25  | Host maps / topology           | Yes    | Yes        | Yes     | VM Insights Map                           | Near    | Network dependency visualization                           |
| 26  | Process-level monitoring       | Yes    | Yes        | Limited | VM Insights processes                     | Near    | Process inventory and connections                          |
| 27  | Cloud integrations (Azure)     | Yes    | Yes        | Yes     | Native (Azure Monitor Metrics)            | Direct  | 200+ Azure services; zero-config                           |
| 28  | Cloud integrations (AWS)       | Yes    | Yes        | Yes     | Azure Monitor (limited)                   | Gap     | Azure Monitor focuses on Azure; use OTel Collector for AWS |
| 29  | Cloud integrations (GCP)       | Yes    | Yes        | Yes     | Azure Monitor (limited)                   | Gap     | Same as AWS; Managed Grafana can bridge                    |
| 30  | Network performance monitoring | DD NPM | NR Network | Limited | Network Watcher + Connection Monitor      | Near    | Flow logs, topology, packet capture                        |
| 31  | SNMP monitoring                | Yes    | Yes        | Yes     | Azure Monitor Agent (SNMP via custom DCR) | Partial | Not native; requires custom data collection                |
| 32  | GPU monitoring                 | Yes    | Limited    | Yes     | Azure Monitor Metrics for GPU VMs         | Near    | NCv3/NCv4/NDv4 GPU metrics; Container Insights GPU         |

---

## 3. Log Management

| #   | Feature                   | DD          | NR             | SO              | Azure Monitor equivalent                    | Mapping | Notes                                              |
| --- | ------------------------- | ----------- | -------------- | --------------- | ------------------------------------------- | ------- | -------------------------------------------------- |
| 33  | Centralized log ingestion | Yes         | Yes            | Yes             | Log Analytics workspace                     | Direct  | Unified log store; KQL query language              |
| 34  | Log parsing / structuring | Yes         | Yes            | Yes             | Data Collection Rules (DCR) transformations | Direct  | KQL-based transformations at ingestion             |
| 35  | Log search                | Yes         | Yes            | Yes             | Log Analytics queries (KQL)                 | Direct  | Full KQL with joins, aggregations, time series     |
| 36  | Log patterns / clustering | DD Patterns | NR Logs        | SO Log Observer | Log Analytics pattern detection             | Near    | KQL `reduce` operator for pattern clustering       |
| 37  | Log pipelines / routing   | Yes         | Yes            | Yes             | Data Collection Rules (DCR)                 | Direct  | Route to Analytics, Basic, or different workspaces |
| 38  | Log archiving             | Yes         | Yes            | Yes             | Log Analytics archive tier                  | Direct  | $0.02/GB/month; searchable via restore/search jobs |
| 39  | Log rehydration           | $0.10/GB    | Included       | Yes             | Archive search jobs                         | Near    | No re-ingestion fee; search job charges            |
| 40  | Sensitive data scanning   | DD Scanner  | NR Obfuscation | Yes             | DCR transformation rules                    | Near    | KQL regex masking at ingestion                     |
| 41  | Log-to-metric generation  | Yes         | Yes            | Yes             | Data Collection Rules + KQL summarize       | Near    | Create metrics from log data via scheduled queries |
| 42  | Live tail                 | Yes         | Yes            | Yes             | Log Analytics live tail (preview)           | Near    | Near-real-time log streaming                       |
| 43  | Custom log API            | Yes         | Yes            | Yes             | Logs Ingestion API (DCR-based)              | Direct  | REST API with DCR for schema enforcement           |
| 44  | Syslog collection         | Yes         | Yes            | Yes             | Azure Monitor Agent (syslog DCR)            | Direct  | RFC 3164 and RFC 5424                              |
| 45  | Windows Event Log         | Yes         | Yes            | Yes             | Azure Monitor Agent (Windows Events DCR)    | Direct  | XPath-based event filtering                        |

---

## 4. Metrics

| #   | Feature                       | DD              | NR         | SO      | Azure Monitor equivalent               | Mapping | Notes                                                            |
| --- | ----------------------------- | --------------- | ---------- | ------- | -------------------------------------- | ------- | ---------------------------------------------------------------- |
| 46  | Platform metrics              | Yes             | Yes        | Yes     | Azure Monitor Metrics                  | Direct  | 200+ Azure services; zero configuration                          |
| 47  | Custom metrics API            | Yes             | Yes        | Yes     | Azure Monitor custom metrics API       | Direct  | REST API for application-generated metrics                       |
| 48  | Prometheus collection         | Yes             | Yes        | Yes     | Azure Monitor managed Prometheus       | Direct  | Prometheus remote write; PromQL queries                          |
| 49  | StatsD collection             | Yes             | Yes        | Yes     | Application Insights StatsD connector  | Near    | Via OpenTelemetry Collector                                      |
| 50  | Metric aggregation            | Yes             | Yes        | Yes     | Azure Monitor Metrics (pre-aggregated) | Direct  | 1-minute granularity; aggregation at ingestion                   |
| 51  | High-resolution metrics (10s) | DD only         | No         | SO (1s) | Azure Monitor Metrics (1-min minimum)  | Partial | 1-minute minimum for platform metrics; Prometheus for sub-minute |
| 52  | Tag-based filtering           | Yes             | Yes        | Yes     | Dimension-based filtering              | Direct  | Up to 10 custom dimensions per metric                            |
| 53  | Metric correlations           | DD Correlations | NR Lookout | SO      | Azure Monitor Metrics Explorer         | Near    | Side-by-side comparison; less automated correlation              |

---

## 5. Alerting and Incident Management

| #   | Feature                                | DD                   | NR                       | SO                    | Azure Monitor equivalent                      | Mapping | Notes                                                                        |
| --- | -------------------------------------- | -------------------- | ------------------------ | --------------------- | --------------------------------------------- | ------- | ---------------------------------------------------------------------------- |
| 54  | Metric-based alerts                    | Yes                  | Yes                      | Yes                   | Azure Monitor metric alerts                   | Direct  | Static and dynamic thresholds                                                |
| 55  | Log-based alerts                       | Yes                  | Yes                      | Yes                   | Azure Monitor log search alerts               | Direct  | KQL query with configurable frequency                                        |
| 56  | Anomaly detection alerts               | DD Anomaly           | NR Baseline              | SO Dynamic            | Smart Detection + dynamic metric alerts       | Direct  | AI-based threshold learning                                                  |
| 57  | Composite alerts (multiple conditions) | Yes                  | Yes                      | Yes                   | Azure Monitor alert processing rules          | Near    | Alert processing rules for suppression/routing; multi-condition via KQL      |
| 58  | Alert grouping / noise reduction       | DD Event Management  | NR Incident Intelligence | SO                    | Alert processing rules + smart groups         | Near    | Automatic alert correlation                                                  |
| 59  | On-call scheduling                     | DD (via integration) | NR (via integration)     | SO On-Call ($21/user) | Action groups (webhook to PagerDuty/Opsgenie) | Near    | No native on-call scheduler; integrates with PagerDuty, Opsgenie, ServiceNow |
| 60  | Escalation policies                    | DD (via PagerDuty)   | NR Workflows             | SO On-Call            | Action groups + Logic Apps                    | Near    | Multi-step escalation via Logic Apps workflow                                |
| 61  | PagerDuty integration                  | Yes                  | Yes                      | Yes                   | Action group (PagerDuty action type)          | Direct  | Native integration                                                           |
| 62  | ServiceNow integration                 | Yes                  | Yes                      | Yes                   | ITSM Connector for ServiceNow                 | Direct  | Bi-directional ticket sync                                                   |
| 63  | Opsgenie integration                   | Yes                  | Yes                      | Yes                   | Action group (webhook)                        | Near    | Via webhook; Opsgenie has Azure Monitor integration                          |
| 64  | Slack/Teams notifications              | Yes                  | Yes                      | Yes                   | Action group (email, SMS, webhook, Logic App) | Direct  | Teams via Logic App; Slack via webhook                                       |
| 65  | Alert API (programmatic)               | Yes                  | Yes                      | Yes                   | Azure Monitor REST API + Bicep/ARM            | Direct  | Full API + IaC support                                                       |
| 66  | Downtime / maintenance windows         | DD Downtime          | NR Muting                | SO Muting             | Alert processing rules (suppression)          | Direct  | Time-based and scope-based suppression                                       |

---

## 6. Dashboards and Visualization

| #   | Feature                                 | DD           | NR           | SO  | Azure Monitor equivalent                                | Mapping | Notes                                                  |
| --- | --------------------------------------- | ------------ | ------------ | --- | ------------------------------------------------------- | ------- | ------------------------------------------------------ |
| 67  | Custom dashboards                       | Yes          | Yes          | Yes | Azure Workbooks + Managed Grafana                       | Direct  | Workbooks for Azure-native; Grafana for multi-source   |
| 68  | Dashboard templates                     | Yes          | Yes          | Yes | Workbook gallery + Grafana community                    | Direct  | Pre-built templates for common scenarios               |
| 69  | Dashboard variables / filters           | Yes          | Yes          | Yes | Workbook parameters + Grafana variables                 | Direct  | Drop-down filters, time range, resource scoping        |
| 70  | Dashboard sharing                       | Yes          | Yes          | Yes | Workbook sharing + Grafana teams/orgs                   | Direct  | RBAC-controlled sharing                                |
| 71  | Embedding dashboards                    | Yes          | Yes          | Yes | Workbook pinning to Azure dashboard + Grafana embedding | Near    | Pin to Azure Portal; Grafana public dashboards         |
| 72  | Time-series visualization               | Yes          | Yes          | Yes | Workbook charts + Grafana panels                        | Direct  | Line, area, bar, scatter                               |
| 73  | Heatmaps                                | Yes          | NR (limited) | Yes | Workbook heatmap + Grafana heatmap                      | Direct  |                                                        |
| 74  | Top lists / tables                      | Yes          | Yes          | Yes | Workbook grids + Grafana table panels                   | Direct  |                                                        |
| 75  | Geomaps                                 | Yes          | Yes          | Yes | Workbook map visualization                              | Near    | Azure Map integration                                  |
| 76  | Notebooks (collaborative investigation) | DD Notebooks | NR Workloads | No  | Azure Workbooks (collaborative)                         | Near    | Workbooks are closest; less freeform than DD Notebooks |

---

## 7. Synthetic Monitoring

| #   | Feature                       | DD         | NR                  | SO        | Azure Monitor equivalent                         | Mapping | Notes                                                           |
| --- | ----------------------------- | ---------- | ------------------- | --------- | ------------------------------------------------ | ------- | --------------------------------------------------------------- |
| 77  | HTTP / URL ping tests         | Yes        | Yes                 | No        | Application Insights URL ping test               | Direct  | Free; up to 100 per resource                                    |
| 78  | Multi-step web tests          | Yes        | Yes                 | No        | Application Insights multi-step web test         | Direct  | TrackAvailability API for complex scenarios                     |
| 79  | Browser tests (Selenium-like) | DD Browser | NR Scripted Browser | Yes       | Application Insights standard test               | Partial | Standard tests cover most scenarios; no full browser automation |
| 80  | API tests                     | Yes        | Yes                 | Yes       | Application Insights standard test + custom code | Near    | URL and custom TrackAvailability                                |
| 81  | Private locations             | DD Private | NR Private          | No        | Application Insights (Azure VMs as test agents)  | Near    | Custom availability tests from private endpoints                |
| 82  | SSL certificate monitoring    | Yes        | Yes                 | No        | Application Insights (via standard test)         | Near    | Certificate expiry in test results                              |
| 83  | Global test locations         | Yes (100+) | Yes (20+)           | Yes (30+) | 16 Azure regions                                 | Partial | Fewer locations; covers major global regions                    |

---

## 8. Real User Monitoring (RUM)

| #   | Feature                         | DD                | NR                | SO  | Azure Monitor equivalent                         | Mapping | Notes                                                    |
| --- | ------------------------------- | ----------------- | ----------------- | --- | ------------------------------------------------ | ------- | -------------------------------------------------------- |
| 84  | Page load performance           | Yes               | Yes               | Yes | Application Insights browser SDK                 | Direct  | Page view duration, dependency timing                    |
| 85  | User sessions                   | Yes               | Yes               | Yes | Application Insights user sessions               | Direct  | Session tracking with anonymous user IDs                 |
| 86  | Error tracking (JavaScript)     | Yes               | Yes               | Yes | Application Insights browser exceptions          | Direct  | Unhandled and handled exception capture                  |
| 87  | Core Web Vitals (LCP, FID, CLS) | Yes               | Yes               | Yes | Application Insights (custom events or via OTel) | Near    | Requires custom instrumentation for CWV                  |
| 88  | Session replay                  | DD Session Replay | NR Session Replay | No  | Not available                                    | Gap     | No native session replay; third-party integration needed |
| 89  | User journey / funnel tracking  | DD (limited)      | NR Funnels        | No  | Application Insights user flows                  | Near    | User Flows visualization for navigation paths            |
| 90  | Mobile RUM (iOS/Android)        | Yes               | Yes               | Yes | Application Insights mobile SDKs (community)     | Partial | Less mature than DD/NR mobile SDKs                       |

---

## 9. Security and Compliance

| #   | Feature               | DD              | NR                 | SO  | Azure Monitor equivalent                        | Mapping | Notes                                                  |
| --- | --------------------- | --------------- | ------------------ | --- | ----------------------------------------------- | ------- | ------------------------------------------------------ |
| 91  | RBAC                  | Yes             | Yes                | Yes | Azure RBAC + Log Analytics workspace-level RBAC | Direct  | Table-level and resource-context RBAC                  |
| 92  | SSO / SAML            | Enterprise only | Yes                | Yes | Entra ID (native)                               | Direct  | No additional cost; inherited from Azure identity      |
| 93  | Audit logging         | Enterprise only | Yes                | Yes | Azure Activity Log + Diagnostic Settings        | Direct  | Free; tamper-evident                                   |
| 94  | Data residency        | Region-specific | US/EU              | US  | Azure region selection (including Gov)          | Direct  | Choose workspace region; data stays in region          |
| 95  | FedRAMP High          | No              | Moderate (limited) | No  | Yes (Azure Government)                          | Unique  | Only Azure Monitor provides FedRAMP High observability |
| 96  | IL4/IL5               | No              | No                 | No  | Yes (Azure Government)                          | Unique  | No competitor offers IL4/IL5 observability             |
| 97  | HIPAA BAA             | Enterprise only | Yes                | Yes | Yes (included with Azure)                       | Direct  | Inherited from Azure BAA                               |
| 98  | SOC 2 Type II         | Yes             | Yes                | Yes | Yes (inherited from Azure)                      | Direct  |                                                        |
| 99  | Customer-managed keys | Yes             | Yes                | Yes | Log Analytics CMK (dedicated cluster)           | Direct  | Requires dedicated cluster ($500/day minimum)          |
| 100 | Private Link          | Yes             | Yes                | Yes | Azure Monitor Private Link Scope (AMPLS)        | Direct  | Private connectivity to Log Analytics and App Insights |

---

## 10. Integrations and Ecosystem

| #   | Feature                 | DD                | NR                | SO           | Azure Monitor equivalent                   | Mapping | Notes                                           |
| --- | ----------------------- | ----------------- | ----------------- | ------------ | ------------------------------------------ | ------- | ----------------------------------------------- |
| 101 | OpenTelemetry support   | Yes               | Yes               | Yes (native) | Application Insights (OTel-based SDKs)     | Direct  | SDKs are OTel distributions                     |
| 102 | Terraform / IaC support | Yes               | Yes               | Yes          | Bicep + ARM + Terraform (azurerm provider) | Direct  | Native IaC for all Azure Monitor resources      |
| 103 | CI/CD integration       | DD CI Visibility  | NR CodeStream     | Limited      | Azure DevOps + GitHub Actions integration  | Near    | Pipeline monitoring via diagnostic settings     |
| 104 | Database monitoring     | DD DBM ($84/host) | NR APM (included) | Limited      | SQL Analytics for Azure SQL + SQL MI       | Near    | Azure SQL deep; limited for non-Azure databases |
| 105 | Webhook/API export      | Yes               | Yes               | Yes          | Event Hubs export + Logic Apps + REST API  | Direct  | Streaming export via diagnostic settings        |
| 106 | Power BI integration    | No                | No                | No           | Native (KQL data connector for Power BI)   | Unique  | Direct Power BI connection to Log Analytics     |

---

## Feature gap summary

| Gap area                                  | Impact                                                                                        | Workaround                                                                                                                   |
| ----------------------------------------- | --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| **Session replay (RUM)**                  | No native equivalent of Datadog Session Replay or NR Session Replay                           | Use third-party tools (FullStory, Hotjar) alongside Application Insights                                                     |
| **Multi-cloud infrastructure monitoring** | Azure Monitor excels at Azure; limited for AWS/GCP infrastructure                             | Use OpenTelemetry Collector to ship non-Azure metrics to Log Analytics; or use Managed Grafana with multi-cloud data sources |
| **Sub-minute metric granularity**         | Azure Monitor Metrics minimum 1-minute resolution                                             | Use Managed Prometheus for sub-minute Kubernetes metrics; Application Insights Live Metrics for real-time                    |
| **CI/CD pipeline visibility**             | No direct equivalent of Datadog CI Visibility                                                 | Use Azure DevOps / GitHub Actions native analytics; Application Insights custom events from pipeline                         |
| **Service catalog**                       | No dedicated service catalog in Azure Monitor                                                 | Azure Resource Graph + Application Insights Application Map + resource tagging                                               |
| **Full browser synthetic tests**          | Application Insights standard tests cover most scenarios but lack full browser DOM automation | Use third-party synthetic tools (Playwright-based) for complex browser scenarios; report results via TrackAvailability API   |

---

**Related:** [Why Azure Monitor](why-azure-monitor.md) | [TCO Analysis](tco-analysis.md) | [APM Migration](apm-migration.md) | [Log Migration](log-migration.md) | [Benchmarks](benchmarks.md)
