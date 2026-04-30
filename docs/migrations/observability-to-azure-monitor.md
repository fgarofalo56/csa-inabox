# Migrating from Observability Platforms to Azure Monitor

**Status:** Authored 2026-04-30
**Audience:** Platform Engineers, SREs, DevOps Leads, IT Directors, Federal CTO/CIO running Datadog, New Relic, Splunk Observability (formerly SignalFx), or Dynatrace and evaluating Azure Monitor as a unified observability platform.
**Scope:** Full-stack observability: APM (distributed tracing, profiling), infrastructure monitoring, log management, metrics, dashboards, alerting, synthetic monitoring, and real user monitoring.

---

!!! tip "Expanded Migration Center Available"
This playbook is the concise migration reference. For the complete Observability-to-Azure-Monitor migration package -- including executive briefs, TCO analysis, APM migration, log migration, alerting, federal guidance, and benchmarks -- visit the **[Observability to Azure Monitor Migration Center](observability-to-azure-monitor/index.md)**.

    **Quick links:**

    - [Why Azure Monitor (Executive Brief)](observability-to-azure-monitor/why-azure-monitor.md)
    - [Total Cost of Ownership Analysis](observability-to-azure-monitor/tco-analysis.md)
    - [Complete Feature Mapping (50+ features)](observability-to-azure-monitor/feature-mapping-complete.md)
    - [APM Migration Guide](observability-to-azure-monitor/apm-migration.md)
    - [Log Migration Guide](observability-to-azure-monitor/log-migration.md)
    - [Federal Migration Guide](observability-to-azure-monitor/federal-migration-guide.md)
    - [Tutorials & Walkthroughs](observability-to-azure-monitor/index.md#tutorials)
    - [Benchmarks & Performance](observability-to-azure-monitor/benchmarks.md)
    - [Best Practices](observability-to-azure-monitor/best-practices.md)

    **Migration guides by domain:** [APM](observability-to-azure-monitor/apm-migration.md) | [Logs](observability-to-azure-monitor/log-migration.md) | [Metrics](observability-to-azure-monitor/metrics-migration.md) | [Alerting](observability-to-azure-monitor/alerting-migration.md) | [Dashboards](observability-to-azure-monitor/dashboard-migration.md)

---

## 1. Executive summary

The observability market is dominated by per-host and per-GB pricing models that punish growth. Datadog charges per host for infrastructure plus per-GB for logs plus per-host for APM -- a three-axis pricing model that consistently produces bill shock. New Relic moved to per-user plus data-ingest pricing that creates awkward access restrictions. Splunk Observability (the former SignalFx product, now under Cisco ownership) layers per-host infrastructure monitoring on top of Splunk's already expensive log ingestion. All three vendors operate outside the Azure control plane, requiring separate identity management, separate compliance scoping, and separate procurement vehicles.

Azure Monitor is the native observability platform for Azure. It provides unified metrics, logs (via Log Analytics), distributed tracing (via Application Insights), infrastructure monitoring (VM Insights, Container Insights), and AI-powered diagnostics -- all within the Azure control plane. Pricing is consumption-based: pay per GB of log ingestion with commitment tier discounts up to 30%, and Application Insights charges only for ingested telemetry with configurable sampling. There are no per-host fees, no per-user fees, and no separate APM licensing.

**CSA-in-a-Box extends the story.** Azure Monitor is CSA-in-a-Box's native observability layer. Every component in the reference architecture -- Microsoft Fabric workspaces, Databricks clusters, Azure Data Factory pipelines, Purview governance scans, Azure OpenAI endpoints -- emits diagnostics to Azure Monitor. The migration is not just swapping an observability vendor; it is unifying observability with the data platform, governance layer, and AI services that CSA-in-a-Box deploys.

---

## 2. Why migrate now

| Driver                                 | Detail                                                                                                                                                                                                                           |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Per-host pricing pressure**          | Datadog and Splunk Observability charge per host. As container density increases and ephemeral compute (serverless, spot) grows, per-host models become unpredictable. Azure Monitor has zero per-host fees.                     |
| **Bill shock and unpredictable costs** | Datadog custom metrics ($0.05/metric/month beyond 100), log ingestion ($0.10/GB ingested + $1.70/million events indexed), and APM ($31/host/month) compound rapidly. Azure Monitor commitment tiers provide predictable pricing. |
| **Vendor lock-in risk**                | Proprietary query languages (DQL, NRQL), vendor-specific agents, and custom integrations create deep lock-in. Azure Monitor supports OpenTelemetry natively, providing a standards-based escape hatch.                           |
| **Cisco/Splunk uncertainty**           | Splunk Observability's roadmap is now under Cisco. Federal customers report uncertainty on long-term investment, similar to the SIEM story.                                                                                      |
| **Azure-native integration**           | Organizations running Azure workloads get zero-configuration monitoring for 200+ Azure services. Third-party tools require custom integrations for each Azure service.                                                           |
| **Federal compliance**                 | Azure Monitor in Azure Government meets FedRAMP High, IL4/IL5. Datadog and New Relic have limited FedRAMP coverage; Splunk Observability has none in government clouds.                                                          |
| **AI-powered insights**                | Copilot in Azure assists with KQL query generation, anomaly explanation, and root-cause analysis. No additional licensing required.                                                                                              |

---

## 3. What migrates where

| Source capability                                                    | Azure Monitor destination                   | Notes                                                                                      |
| -------------------------------------------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------ |
| **APM / Distributed Tracing** (Datadog APM, NR APM, Splunk APM)      | Application Insights                        | Auto-instrumentation for .NET, Java, Node.js, Python. OpenTelemetry SDK for all languages. |
| **Infrastructure Monitoring** (Datadog Infra, NR Infra, Splunk IM)   | VM Insights + Container Insights            | Azure Monitor Agent (AMA) replaces vendor agents.                                          |
| **Log Management** (Datadog Logs, NR Logs, Splunk Log Observer)      | Log Analytics workspace                     | KQL replaces DQL/NRQL/SPL. Data Collection Rules (DCR) for ingestion routing.              |
| **Metrics** (Datadog Metrics, NR Metrics, Splunk Metrics)            | Azure Monitor Metrics + Prometheus          | Native metrics for Azure services; Prometheus for Kubernetes; custom metrics API.          |
| **Dashboards** (Datadog Dashboards, NR One, Splunk Dashboards)       | Azure Workbooks + Azure Managed Grafana     | Workbooks for Azure-native; Managed Grafana for teams with existing Grafana investment.    |
| **Alerting** (Datadog Monitors, NR Alerts, Splunk Detectors)         | Azure Monitor Alerts                        | Metric alerts, log search alerts, smart detection, action groups.                          |
| **Synthetic Monitoring** (Datadog Synthetics, NR Synthetics)         | Application Insights availability tests     | URL ping tests, multi-step web tests, standard tests from global locations.                |
| **RUM** (Datadog RUM, NR Browser)                                    | Application Insights browser SDK            | JavaScript SDK for page load, user interactions, and error tracking.                       |
| **Profiling** (Datadog Continuous Profiler, NR CodeStream)           | Application Insights Profiler               | .NET and Java continuous profiling in production.                                          |
| **Error Tracking**                                                   | Application Insights + Snapshot Debugger    | Automatic exception snapshots for .NET.                                                    |
| **On-call / Incident Management** (PagerDuty, Opsgenie integrations) | Action groups + ITSM connector              | Native PagerDuty, ServiceNow, webhook integrations.                                        |
| **SLO Tracking**                                                     | Azure Monitor SLI/SLO (preview) + Workbooks | Custom SLO tracking via KQL queries and workbook templates.                                |
| **Network Monitoring** (Datadog NPM, NR Network)                     | Network Watcher + Connection Monitor        | Flow logs, packet capture, topology visualization.                                         |

---

## 4. Migration sequence (phased approach)

A realistic observability migration for a mid-to-large enterprise runs 12-20 weeks. The key principle is **dual-ship first, cut over second** -- run both platforms in parallel before decommissioning the source.

### Phase 0 -- Discovery (Weeks 1-2)

- Inventory all monitored hosts, containers, applications, and services.
- Catalog every dashboard, alert rule, synthetic test, and custom metric.
- Map vendor agent deployments (Datadog Agent, NR Infrastructure Agent, Splunk OTEL Collector).
- Identify SLA/SLO definitions and on-call routing.
- Document custom integrations and API consumers.

### Phase 1 -- Foundation (Weeks 3-5)

- Deploy Log Analytics workspace(s) with appropriate retention and commitment tier.
- Deploy Application Insights resources (workspace-based).
- Configure Azure Monitor Agent (AMA) on VMs via Data Collection Rules.
- Enable Container Insights for AKS/Kubernetes clusters.
- Enable diagnostic settings for all Azure services.
- Configure OpenTelemetry SDK in new applications (abstraction layer for dual-shipping).

### Phase 2 -- Dual-Ship Logs and Metrics (Weeks 5-10)

- Configure OpenTelemetry Collector to dual-ship to both Azure Monitor and the existing vendor.
- Migrate log ingestion pipelines to use Data Collection Rules (DCR).
- Rebuild top-20 dashboards in Azure Workbooks or Managed Grafana.
- Convert top-20 alert rules from vendor format to Azure Monitor Alerts.
- Validate alert parity: confirm the same conditions fire on both platforms.

### Phase 3 -- APM Migration (Weeks 8-14)

- Enable Application Insights auto-instrumentation for Java and .NET applications.
- Swap vendor APM SDKs for OpenTelemetry SDK (or Application Insights SDK) in remaining applications.
- Configure distributed tracing, dependency tracking, and application map.
- Migrate synthetic monitors to Application Insights availability tests.
- Enable Application Insights Profiler for critical services.

### Phase 4 -- Validation and Cutover (Weeks 12-18)

- Run full parallel validation for 2-4 weeks.
- Confirm: alert fidelity, dashboard accuracy, trace completeness, log coverage.
- Train operations teams on KQL, Azure Workbooks, and alert management.
- Cut over on-call routing to Azure Monitor action groups.
- Decommission vendor agents and cancel licenses.

### Phase 5 -- Optimization (Weeks 16-20)

- Tune log ingestion: move low-value logs to Basic tier, archive cold data to storage.
- Configure Application Insights sampling for high-volume services.
- Implement cost anomaly alerts.
- Integrate CSA-in-a-Box platform monitoring with business observability (Power BI dashboards over Azure Monitor data).

---

## 5. Cost comparison snapshot

Illustrative comparison for a 200-host / 50-application environment ingesting 500 GB/day of logs.

| Cost element                 | Datadog (annual)                 | New Relic (annual)                         | Splunk Observability (annual)    | Azure Monitor (annual)                         |
| ---------------------------- | -------------------------------- | ------------------------------------------ | -------------------------------- | ---------------------------------------------- |
| Infrastructure monitoring    | $468K (200 hosts x $195/host/mo) | Included in data plan                      | $360K (200 hosts x $150/host/mo) | $0 (included with AMA)                         |
| APM / Tracing                | $372K (200 hosts x $155/host/mo) | Included in data plan                      | $480K (200 hosts x $200/host/mo) | $0 (included with App Insights ingestion)      |
| Log ingestion (500 GB/day)   | $657K ($0.10/GB + indexing)      | $547K (data ingest pricing)                | $730K (Splunk platform pricing)  | $328K (500GB/day commitment tier)              |
| User licenses                | $0                               | $414K (30 full-platform users x $1,149/mo) | $0                               | $0                                             |
| Custom metrics               | $60K (100K metrics)              | Included                                   | $36K                             | $0 (first 10 dimensions free; low cost beyond) |
| Synthetics                   | $48K                             | $24K                                       | N/A                              | $0 (included with App Insights)                |
| **Total estimated**          | **$1.6M**                        | **$985K**                                  | **$1.6M**                        | **$328K-$450K**                                |
| **Savings vs Azure Monitor** | --                               | --                                         | --                               | **60-75% lower**                               |

These are illustrative list prices. Actual costs depend on negotiated discounts, commitment tiers, and workload patterns. See the [full TCO analysis](observability-to-azure-monitor/tco-analysis.md) for detailed modeling.

---

## 6. Query language translation

The single most labor-intensive migration task is converting queries from DQL/NRQL/SPL to KQL. Here are representative translations.

### Error rate by service (last hour)

=== "KQL (Azure Monitor)"

    ```kusto
    AppRequests
    | where TimeGenerated > ago(1h)
    | summarize total = count(), errors = countif(Success == false) by AppRoleName
    | extend error_rate = round(100.0 * errors / total, 2)
    | order by error_rate desc
    ```

=== "DQL (Datadog)"

    ```
    @type:trace @http.status_code:>=500
    | stats count(*) as errors, count(*) as total by service
    | eval error_rate = (errors / total) * 100
    ```

=== "NRQL (New Relic)"

    ```sql
    SELECT percentage(count(*), WHERE error IS true) AS 'Error Rate'
    FROM Transaction
    FACET appName
    SINCE 1 hour ago
    ```

=== "SPL (Splunk)"

    ```spl
    index=apm sourcetype=traces earliest=-1h
    | stats count as total, count(eval(status_code>=500)) as errors by service
    | eval error_rate=round(errors/total*100, 2)
    ```

### P95 response time by endpoint

=== "KQL (Azure Monitor)"

    ```kusto
    AppRequests
    | where TimeGenerated > ago(1h)
    | summarize p95 = percentile(DurationMs, 95) by Name
    | order by p95 desc
    | take 20
    ```

=== "DQL (Datadog)"

    ```
    @type:trace
    | stats percentile(@duration, 0.95) as p95 by resource_name
    | sort p95 desc
    | head 20
    ```

=== "NRQL (New Relic)"

    ```sql
    SELECT percentile(duration, 95) AS 'P95'
    FROM Transaction
    FACET name
    SINCE 1 hour ago
    LIMIT 20
    ```

---

## 7. CSA-in-a-Box integration

Azure Monitor is not an add-on to CSA-in-a-Box -- it is the built-in observability layer. Every CSA-in-a-Box component emits diagnostics to Azure Monitor by default.

| CSA-in-a-Box component | Azure Monitor integration                                                                     |
| ---------------------- | --------------------------------------------------------------------------------------------- |
| Microsoft Fabric       | Diagnostic settings to Log Analytics; capacity metrics in Azure Monitor Metrics               |
| Databricks             | Azure Monitor integration via spark listeners + Log Analytics; cluster metrics via Prometheus |
| Azure Data Factory     | Pipeline run metrics + diagnostic logs to Log Analytics                                       |
| Purview                | Scan telemetry + audit logs to Log Analytics                                                  |
| Azure OpenAI           | Token usage, latency, and error metrics to Azure Monitor                                      |
| Power BI               | Usage metrics + refresh telemetry                                                             |
| Azure Key Vault        | Access audit logs + diagnostic settings                                                       |
| ADLS Gen2 / OneLake    | Storage metrics + access logs                                                                 |

Migrating to Azure Monitor unifies platform observability with application observability. Instead of correlating Datadog APM traces with Azure-native infrastructure metrics across two platforms, everything lives in a single Log Analytics workspace queryable with KQL.

---

## 8. Competitive framing

### Where Datadog / New Relic / Splunk Observability win today

- **Multi-cloud parity.** Datadog and New Relic provide first-class monitoring for AWS, GCP, and Azure simultaneously. If your infrastructure is genuinely multi-cloud with equal investment across providers, a third-party tool may reduce operational overhead.
- **Mature notebook-style investigation.** Datadog Notebooks and New Relic Workloads provide collaborative investigation workflows that Azure Workbooks is still maturing toward.
- **Broader SaaS integrations.** Datadog has 750+ integrations; Azure Monitor focuses on Azure services and OpenTelemetry-compatible sources.
- **Single-pane for non-Azure.** If the majority of your infrastructure is on AWS or GCP, Azure Monitor provides less value.

### Where Azure Monitor wins today

- **Zero per-host licensing.** The pricing model structurally favors Azure Monitor as host counts grow.
- **Azure-native depth.** 200+ Azure services emit metrics and logs natively -- no agent configuration, no custom integrations.
- **OpenTelemetry-first.** Application Insights is built on OpenTelemetry, providing vendor-neutral instrumentation.
- **Unified platform.** Logs, metrics, traces, profiler, availability tests, and alerts in a single platform with a single query language (KQL).
- **Federal compliance.** FedRAMP High, IL4/IL5 in Azure Government. No competitor matches this coverage for observability.
- **Cost structure.** 60-75% lower total cost for Azure-primary environments (see Section 5).
- **AI integration.** Copilot assists with KQL queries, anomaly explanation, and incident triage -- included in the platform.

### Decision framework

- **Choose Azure Monitor if:** Your primary infrastructure is Azure, you want unified observability and platform monitoring, federal compliance is required, or cost reduction from per-host pricing is a priority.
- **Choose Azure Managed Grafana + Azure Monitor backend if:** Your team has deep Grafana expertise and you want to preserve the Grafana dashboard experience while benefiting from Azure Monitor's data platform.
- **Stay with current vendor if:** Your infrastructure is primarily non-Azure, you have heavy investment in vendor-specific features (Datadog Notebooks, NR Workloads), or you are mid-contract with favorable terms.

---

## 9. Related resources

- **Migration Center:** [Observability to Azure Monitor Migration Center](observability-to-azure-monitor/index.md)
- **Companion playbooks:** [Splunk to Sentinel](splunk-to-sentinel.md), [AWS to Azure](aws-to-azure.md)
- **CSA-in-a-Box observability:** `patterns/observability-otel.md`, `best-practices/monitoring-observability.md`
- **ADRs:** `docs/adr/0020-portal-observability-and-rate-limiting.md`
- **Compliance:** `docs/compliance/nist-800-53-rev5.md` (AU-\* controls), `docs/compliance/fedramp-moderate.md`
- **Operational guides:** `docs/COST_MANAGEMENT.md`, `docs/TROUBLESHOOTING.md`

---

**Maintainers:** CSA-in-a-Box core team
**Last updated:** 2026-04-30
