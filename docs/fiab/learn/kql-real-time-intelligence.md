# KQL / Real-time intelligence

Loom's real-time intelligence surface is one-for-one with Fabric Real-Time
Intelligence and Azure Data Explorer: an **Eventstream** ingests streaming
sources, a **KQL database** (Eventhouse / ADX) stores time-series and telemetry,
a **KQL queryset** runs interactive Kusto queries, a **KQL dashboard** pins live
charts, and an **Activator** rule fires actions on a threshold. This guide walks
the end-to-end real-time path.

## When to use it

- **Telemetry, logs, IoT, and time-series** at scale, queried with millisecond
  latency.
- **Streaming ingestion** from Event Hubs, IoT Hub, Kafka, or Azure SQL CDC into
  a queryable store.
- **Alerting** when a streaming metric crosses a threshold (failure rate > 5 %,
  temperature spike, fraud signal).

For batch analytics over Delta tables use the warehouse / lakehouse SQL surface;
KQL is the real-time, append-heavy, time-series tool.

## The pieces and how they connect

| Item | Role |
|---|---|
| **Eventstream** | Code-free source → optional transform → destination. |
| **Eventhouse** | Container of KQL databases sharing compute. |
| **KQL database** | The store. Ingests from Eventstream / Event Hubs / direct REST. |
| **KQL queryset** | Saved set of Kusto queries; pin charts to a dashboard. |
| **KQL dashboard** | Auto-refresh tiles, parameters, time-pickers, drilldowns. |
| **Activator** | Watches a KQL query / stream and dispatches Teams/email/Power Automate. |

### Step-by-step: stream → store → query → alert

1. **Eventstream.** Open an eventstream item. **Add a source** — Event Hub or
   IoT Hub for telemetry, Kafka for cross-cloud. Optionally drop in transforms
   (filter, derived columns, manage fields). **Add a destination** — a KQL
   database for real-time queries (plus a Lakehouse for long-term retention).
2. **KQL database.** Open the KQL database / Kusto navigator. Confirm the table
   is being populated, then run a Kusto query in the query pane:

   ```kusto
   DeviceTelemetry
   | where Timestamp > ago(15m)
   | summarize avg(Temperature) by bin(Timestamp, 1m), DeviceId
   | render timechart
   ```

3. **KQL queryset.** Save the query to a queryset and **pin** its chart to a
   **KQL dashboard**. Add a time-picker parameter so consumers scope the window.
4. **Activator.** Create an Activator rule over the KQL query: pick the source
   (KQL queryset / Eventstream / measure), set the trigger (value crosses a
   threshold or a pattern occurs), and pick the action (Teams notification,
   email, or Power Automate flow).

## Honest infra gate

If the ADX/Kusto cluster isn't wired, the navigator shows a `MessageBar` naming
`EXISTING_KUSTO_CLUSTER` (or the `adxEnabled` provision flag) and the
`AllDatabasesAdmin` grant required. The query surface still renders so you can
author KQL.

## Tip

Use `bin()` and a `time` filter (`where Timestamp > ago(...)`) on every query —
KQL is column- and time-partitioned, so a bounded time range is the single
biggest performance and cost lever.

## Learn more

- **MS Learn — [What is Real-Time Intelligence in Fabric?](https://learn.microsoft.com/fabric/real-time-intelligence/overview)**
- MS Learn — [Eventstreams overview](https://learn.microsoft.com/fabric/real-time-intelligence/event-streams/overview)
- MS Learn — [Azure Data Explorer overview](https://learn.microsoft.com/azure/data-explorer/data-explorer-overview)
- MS Learn — [Activator introduction](https://learn.microsoft.com/fabric/data-activator/activator-introduction)
- Loom editor guides — [KQL database](../tutorials/editor-kql-database.md) · [Eventstream](../tutorials/editor-eventstream.md) · [KQL dashboard](../tutorials/editor-kql-dashboard.md) · [Activator](../tutorials/editor-activator.md)
- Loom tutorial — [Activator rules over an IoT stream](../tutorials/04-activator-rules.md)
