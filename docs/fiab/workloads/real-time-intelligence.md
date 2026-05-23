# Real-Time Intelligence parity

## What Fabric does

Real-Time Intelligence is the umbrella over: **Real-Time Hub**
(catalog of streaming sources), **Eventstream** (no-code ingestion +
transform), **Eventhouse** (container) → **KQL Database** (storage) →
**KQL Queryset** (saved queries), **Real-Time Dashboard** (Kusto
dashboards), **Activator** (rules — covered separately on
[Data Activator parity](data-activator-parity.md)).

Eventhouse runs on the **same Kusto engine that Azure Data Explorer
(ADX) uses** — KQL queries are 1:1 portable.

## CSA Loom parity design

### Real-Time Hub

Loom Console **Real-Time Hub** pane lists all configured streaming
sources (Event Hubs namespaces, IoT Hubs, Kafka clusters via Event
Hubs Kafka protocol, partner CDC sources from Mirroring Engine).
CRUD via REST API backed by Cosmos DB.

### Eventstream

**Azure Stream Analytics jobs** (in Commercial / GCC) OR Azure
Functions stream-processing (Gov interim where Stream Analytics fits
awkwardly). For Gov-H / IL5, use ASA primarily — it's GA across all
Gov boundaries per `research/02-gov-boundary-availability.md §1`.

Stream transforms (filter, project, aggregate over windows, dedupe)
expressed in ASA SQL or Azure Stream Analytics editor — embedded in
Loom Console "Stream" pane. Console renders a visual stream designer
that compiles to ASA SQL.

### Eventhouse → KQL Database

**Azure Data Explorer cluster** (shared per Admin Plane; database
per DLZ — per [ADR fiab-0005](../adr/0005-activator-engine.md) ADX
deployment model):

- 5-10 s cold start matches Fabric Eventhouse semantics
- ADX engine = same Kusto engine Eventhouse uses; KQL queries portable
- ADX `.create async materialized-view`, `.create function`, update
  policies — all available in Gov
- ADX external tables over Delta + ADLS Gen2 → cross-engine access

### KQL Queryset

Loom Console "Queryset" pane is a KQL editor + saved-query store
(Cosmos DB).

### Real-Time Dashboard

ADX dashboards (mature, authored via the ADX Web UI embed in Loom
Console "Real-Time Dashboard" pane).

### OneLake availability

ADX `ContinuousExport` to ADLS Gen2 Delta or Parquet. Loom Console
exposes this as a per-table toggle ("Also land in lakehouse for
cross-engine access").

## Per-boundary behavior

| Boundary | ADX | Eventstream (ASA) | KQL DBs | ADX Dashboards |
|---|---|---|---|---|
| Commercial | ✅ | ✅ | ✅ | ✅ |
| GCC | ✅ | ✅ | ✅ | ✅ |
| GCC-High / IL4 | ✅ | ✅ | ✅ | ✅ |
| IL5 (v1.1) | ✅ | ✅ | ✅ | ✅ |

ADX is authorized at every Gov boundary per `research/02-gov-boundary-
availability.md §7.8` — this is one of the easiest workloads to deliver
parity for.

## Honest gaps

- **ADX `.sandbox` Python plugin in Gov**: exists in Commercial; verify
  per cluster in Gov (typically requires Microsoft engagement to
  enable). v1 docs flag this; v1.1 includes runbook for enablement.
- **Sub-second-on-cold-Eventhouse**: ADX cold-start is 5-10 s,
  identical to Fabric. Steady-state latency is identical.
- **Real-Time Hub UI**: Fabric's RT Hub is a curated discovery
  surface; Loom's equivalent is functionally complete but visually
  simpler.

## Forward migration

- KQL queries + datasets migrate 1:1 (same engine)
- Dashboards via KQL dashboard JSON export → Fabric Real-Time
  Dashboard import
- Eventstreams: rebuild in Fabric Eventstream (ASA → Eventstream is a
  manual port; both are SQL-flavored)
- ADX databases can be attached as Fabric Eventhouse via documented
  procedures

## Related

- ADR: [fiab-0005 Activator engine](../adr/0005-activator-engine.md)
- Build PRP: PRP-02 (ADX Bicep), PRP-03 (Console RT pane)
- Related parity: [Data Activator parity (Reflex)](data-activator-parity.md)
- Parent: [Azure Data Explorer Guide](../../guides/azure-data-explorer.md)
