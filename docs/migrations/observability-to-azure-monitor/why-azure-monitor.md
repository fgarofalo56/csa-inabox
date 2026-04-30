# Why Azure Monitor: Executive Brief

**Audience:** CIO, CTO, VP Engineering, VP Infrastructure, Federal Technology Leaders
**Reading time:** 15 minutes
**Last updated:** 2026-04-30

---

## The observability cost crisis

Enterprise observability spending has become one of the fastest-growing line items in IT budgets. The three dominant vendors -- Datadog, New Relic, and Splunk Observability -- have built pricing models that systematically punish the behaviors modern architectures demand: more hosts (containers, serverless), more telemetry (distributed tracing, custom metrics), and more users (shift-left, developer self-service).

**Datadog** charges per host for infrastructure ($23/host/month Pro, $33/host/month Enterprise), per host for APM ($40/host/month), per GB for log management ($0.10/GB ingested plus $1.70/million events for 15-day retention), and per custom metric ($0.05/metric/month beyond 100 included). A mid-size enterprise running 500 hosts with APM, 1 TB/day of logs, and 50,000 custom metrics faces a Datadog bill exceeding $3M annually -- before adding Synthetics, RUM, CI Visibility, or Database Monitoring.

**New Relic** restructured to per-user pricing in 2020. Full Platform Users cost $549/month (standard) or $1,149/month (Pro), with data ingestion charged beyond a free tier. While this simplified infrastructure pricing, it created a new problem: organizations restrict who can access the observability platform to control per-user costs, undermining the democratized observability that modern DevOps requires.

**Splunk Observability** (the former SignalFx product) charges per host for infrastructure monitoring ($15/host/month) and per host for APM ($55/host/month), on top of Splunk's already expensive log platform pricing. Following Cisco's $28B acquisition of Splunk, the product roadmap is being absorbed into Cisco's broader observability portfolio, creating uncertainty for customers who built on SignalFx's real-time streaming architecture.

Azure Monitor eliminates these pricing pressures with a fundamentally different model: **consumption-based pricing with no per-host or per-user fees**. You pay for log ingestion (per GB) with commitment tier discounts up to 30%, and Application Insights charges only for the telemetry it ingests -- with configurable sampling to control volume. Infrastructure metrics for Azure services are included at no additional cost. There is no separate APM license, no per-user gate, and no custom metrics surcharge for the first 10 custom dimensions.

---

## Five pillars of Azure Monitor advantage

### 1. Unified observability -- one platform, one query language

Azure Monitor consolidates metrics, logs, traces, profiling, availability testing, and alerting into a single platform queried with Kusto Query Language (KQL). There is no need to context-switch between separate APM, log management, and infrastructure monitoring products.

| Observability pillar               | Azure Monitor component                 | Third-party equivalent                         |
| ---------------------------------- | --------------------------------------- | ---------------------------------------------- |
| Application Performance Monitoring | Application Insights                    | Datadog APM, NR APM, Splunk APM                |
| Distributed tracing                | Application Insights (OpenTelemetry)    | Datadog Trace, NR Distributed Tracing          |
| Log management                     | Log Analytics workspace                 | Datadog Logs, NR Logs, Splunk Log Observer     |
| Infrastructure monitoring          | VM Insights, Container Insights         | Datadog Infrastructure, NR Infrastructure      |
| Custom metrics                     | Azure Monitor Metrics                   | Datadog Custom Metrics, NR Dimensional Metrics |
| Prometheus metrics                 | Azure Monitor managed Prometheus        | Datadog Prometheus, NR Prometheus integration  |
| Dashboards                         | Azure Workbooks + Managed Grafana       | Datadog Dashboards, NR Dashboards              |
| Alerting                           | Azure Monitor Alerts                    | Datadog Monitors, NR Alerts, Splunk Detectors  |
| Synthetic monitoring               | Application Insights availability tests | Datadog Synthetics, NR Synthetics              |
| Real User Monitoring               | Application Insights browser SDK        | Datadog RUM, NR Browser                        |
| Profiling                          | Application Insights Profiler           | Datadog Continuous Profiler                    |
| Error tracking                     | Application Insights exceptions         | Datadog Error Tracking                         |
| Network monitoring                 | Network Watcher                         | Datadog NPM                                    |

All of these components share the same Log Analytics backend, the same KQL query language, the same RBAC model, and the same billing. A query that joins application traces with infrastructure metrics with custom business events is a single KQL statement -- not a cross-product correlation that requires API stitching.

### 2. Azure-native integration depth

Azure Monitor is not a third-party agent bolted onto Azure -- it is the native telemetry platform that Azure services are built to emit to. Over 200 Azure services send metrics and diagnostic logs to Azure Monitor with zero agent installation and zero configuration beyond enabling diagnostic settings.

For CSA-in-a-Box components specifically:

- **Microsoft Fabric** emits capacity utilization, query performance, and pipeline run metrics directly to Azure Monitor Metrics and Log Analytics
- **Azure Databricks** integrates with Log Analytics via the Spark listener and Ganglia metrics; cluster events and job telemetry flow natively
- **Azure Data Factory** publishes pipeline run duration, activity success/failure, trigger metrics, and SSIS integration runtime status
- **Microsoft Purview** sends scan telemetry, classification counts, and governance audit events
- **Azure OpenAI** reports token consumption, model latency, content filter triggers, and rate limiting events
- **Power BI** publishes dataset refresh metrics, query performance, and usage analytics

Third-party tools can collect some of this data via Azure Event Hubs export or API polling, but the integration is never as deep, never as real-time, and always requires custom configuration per service.

### 3. AI-powered insights -- Copilot for observability

Azure Monitor integrates with Microsoft Copilot to provide AI-assisted observability capabilities.

**KQL query generation.** Operators describe what they want in natural language -- "show me the top 10 slowest API endpoints in the last hour with error rates above 5%" -- and Copilot generates the KQL query. This eliminates the learning-curve barrier that slows KQL adoption.

**Anomaly explanation.** When Azure Monitor detects an anomaly in metrics or logs, Copilot provides a natural-language explanation of what changed, potential root causes, and suggested remediation steps.

**Incident triage.** Copilot analyzes alert context, correlated events, and historical patterns to prioritize incidents and suggest investigation paths.

**Smart detection.** Application Insights proactively detects failure anomalies, performance degradation, and memory leaks without requiring manual threshold configuration.

These capabilities are included in the Azure Monitor platform. Datadog requires Watchdog (included in Enterprise) and Bits AI (separate product). New Relic offers AI-powered features through New Relic AI but with separate pricing. Splunk requires IT Service Intelligence (ITSI) at additional cost.

### 4. OpenTelemetry-native -- no vendor lock-in

Application Insights is built on OpenTelemetry (OTel), the CNCF standard for telemetry collection. This is not an afterthought integration -- the Application Insights SDKs for .NET, Java, Node.js, and Python are OpenTelemetry distributions.

What this means for migration:

- **Instrument once, ship anywhere.** Applications instrumented with OpenTelemetry SDKs can send telemetry to Azure Monitor, Datadog, New Relic, Grafana Cloud, or any OTel-compatible backend -- simultaneously if needed during migration.
- **No proprietary agent lock-in.** The Azure Monitor Agent (AMA) for infrastructure and the OpenTelemetry SDK for applications are both open-standards-based. Contrast with Datadog's proprietary dd-agent, New Relic's proprietary infrastructure agent, and Splunk's customized OTEL collector.
- **Community instrumentation.** OpenTelemetry provides auto-instrumentation libraries for all major frameworks (Spring Boot, ASP.NET Core, Express.js, Django/Flask), database drivers, HTTP clients, and messaging systems. These work with Azure Monitor out of the box.
- **Future-proof.** As OpenTelemetry matures (metrics GA, logs GA, profiling in progress), Azure Monitor inherits new capabilities through the standard rather than through proprietary SDK updates.

### 5. Cost structure -- aligned with modern architectures

Azure Monitor's pricing is designed for the architectures enterprises are building today: containerized microservices with ephemeral compute, serverless functions, and elastic scaling.

**No per-host fees.** Whether you run 50 VMs or 5,000 containers, Azure Monitor charges the same: per GB of log ingestion. Container Insights, VM Insights, and AKS monitoring are included with the Azure Monitor Agent at no additional per-host cost.

**Commitment tier discounts.** Organizations can commit to daily ingestion volumes (100 GB/day, 200 GB/day, up to 5,000 GB/day) for discounts of 17-30% vs pay-as-you-go pricing. These tiers are adjustable monthly.

**Basic logs.** Low-value, high-volume logs (debug logs, verbose traces, compliance archives) can be ingested at the Basic tier -- approximately 67% cheaper than Analytics logs. Basic logs support limited KQL queries (8-day query window) but are ideal for compliance retention and ad-hoc investigation.

**Log data archive.** After interactive retention (30-730 days), logs can be archived at approximately $0.02/GB/month -- 95% cheaper than active retention. Archived data is searchable via restore or search jobs.

**Application Insights sampling.** Adaptive sampling automatically reduces telemetry volume in production while preserving statistically accurate metrics. A service generating 10,000 requests/second might sample to 100 requests/second while maintaining accurate error rates, latency percentiles, and throughput counts.

**Free Microsoft data.** Azure Activity logs, Entra ID sign-in logs, and certain Defender telemetry types are ingested at no cost when sent to a Log Analytics workspace.

---

## Honest assessment -- where competitors lead

Azure Monitor is the right choice for Azure-primary environments, but intellectual honesty requires acknowledging where competitors currently lead.

### Datadog strengths

- **Multi-cloud parity.** Datadog provides equally deep integration with AWS, GCP, and Azure. If your infrastructure is genuinely split across clouds, Datadog's single-pane view is valuable.
- **Integration breadth.** 750+ integrations vs Azure Monitor's focus on Azure services and OpenTelemetry-compatible sources.
- **Notebook-style investigation.** Datadog Notebooks provide a collaborative investigation UX that Azure Workbooks is still maturing toward.
- **CI/CD Visibility.** Datadog's CI Visibility product (pipeline performance, test flakiness) has no direct Azure Monitor equivalent.
- **Database monitoring.** Datadog Database Monitoring provides deep query-level visibility into PostgreSQL, MySQL, SQL Server, and Oracle. Azure Monitor covers Azure SQL and Managed Instance deeply but has limited coverage for non-Azure databases.

### New Relic strengths

- **Full-stack per-entity pricing simplicity.** Despite the per-user cost, New Relic's data model is clean: everything is an entity, and the pricing is predictable per entity.
- **Errors Inbox.** New Relic's error grouping and triage UX is more mature than Application Insights' exception handling.
- **Change tracking.** New Relic's deployment markers and change tracking provide tight correlation between code deployments and performance changes.
- **Vulnerability management.** New Relic's integrated vulnerability management (IAST) is more mature than Azure Monitor's security-focused features (which live in Defender).

### Splunk Observability strengths

- **Real-time streaming architecture.** SignalFx was built on a streaming analytics engine; metric alerting evaluates at 1-second granularity vs Azure Monitor's minimum 1-minute evaluation for metric alerts.
- **Tag-based architecture.** Splunk Observability's dimensional metrics model is highly flexible for custom tagging and aggregation.
- **Splunk ecosystem integration.** If you are keeping Splunk Enterprise or Splunk Cloud for SIEM, Splunk Observability provides tight integration. (But see the [Splunk to Sentinel migration](../splunk-to-sentinel.md) for why you might not keep Splunk for SIEM either.)

---

## Federal considerations

Azure Monitor in Azure Government provides:

- **FedRAMP High** authorization inherited through Azure Government
- **DoD IL4 and IL5** coverage for Log Analytics, Application Insights, Azure Monitor Metrics, and Alerts
- **Data residency** -- all log data stays within the Azure Government boundary (US Gov Virginia and US Gov Arizona regions)
- **FIPS 140-2 validated endpoints** for data collection and query APIs
- **Managed identity authentication** for all agent-to-workspace communication (no API keys or shared secrets)

No third-party observability vendor provides equivalent federal compliance coverage:

| Vendor               | FedRAMP            | IL4 | IL5 | Gov Cloud        |
| -------------------- | ------------------ | --- | --- | ---------------- |
| Azure Monitor        | High               | Yes | Yes | Azure Government |
| Datadog              | Moderate (limited) | No  | No  | No               |
| New Relic            | Moderate (limited) | No  | No  | No               |
| Splunk Observability | No                 | No  | No  | No               |

For federal agencies and defense contractors, Azure Monitor is the only observability platform that meets IL4/IL5 requirements without compensating controls.

See the [Federal Migration Guide](federal-migration-guide.md) for detailed compliance mapping.

---

## The CSA-in-a-Box observability story

Migrating to Azure Monitor is not just an observability vendor swap -- it is the final piece of the CSA-in-a-Box unified platform story.

CSA-in-a-Box deploys Microsoft Fabric for analytics, Databricks for data engineering, ADF for orchestration, Purview for governance, and Azure OpenAI for AI services. All of these components emit diagnostics to Azure Monitor. When you migrate your application and infrastructure monitoring to Azure Monitor, you gain:

1. **Single observability plane** for both the data platform and the applications that consume it
2. **Cross-component correlation** -- join an API latency spike (Application Insights) with a Databricks cluster scale event (Log Analytics) with a Fabric capacity throttle (Azure Monitor Metrics) in a single KQL query
3. **Unified alerting** -- one set of action groups, one on-call rotation, one escalation policy for platform and application issues
4. **Power BI business observability** -- the same Power BI service that serves business analytics dashboards can render application and platform SLA dashboards, because the data lives in the same Log Analytics workspace
5. **Cost consolidation** -- observability spend appears in the same Azure Cost Management view as compute, storage, and data platform costs, enabling true TCO visibility

---

## Recommended next steps

1. **Quantify the opportunity:** Read the [TCO Analysis](tco-analysis.md) with your current vendor invoices in hand
2. **Assess feature parity:** Review the [Complete Feature Mapping](feature-mapping-complete.md) against your current usage
3. **Plan the migration:** Follow the [Migration Playbook](../observability-to-azure-monitor.md) phased approach
4. **Start hands-on:** Run through the [Application Insights Tutorial](tutorial-app-insights.md) with a non-production application
5. **Address federal requirements:** If applicable, review the [Federal Migration Guide](federal-migration-guide.md)

---

**Related:** [Migration Center](index.md) | [TCO Analysis](tco-analysis.md) | [Feature Mapping](feature-mapping-complete.md) | [Best Practices](best-practices.md)
