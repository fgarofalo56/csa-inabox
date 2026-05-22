# Loom Direct-Lake Shim service

Per [ADR fiab-0004](../adr/0004-direct-lake-parity.md) and [Direct
Lake parity workload](../workloads/direct-lake-parity.md).

## Purpose

Best-effort Direct Lake parity. Keep Power BI Premium semantic models
refreshed close to the underlying Delta commit cadence using
notification-driven partition-scoped refresh.

**Latency target: 5-30 seconds median** from Delta commit to
refreshed model for partition-aware tables. **Honest gap vs Fabric's
sub-second documented openly.**

## Service shape

| Aspect | Value |
|---|---|
| Repo path | `apps/fiab-direct-lake-shim/` |
| Language | C# .NET 10 |
| TOM client | Microsoft.AnalysisServices.Core 19.x |
| Trigger | Azure Event Grid on Storage `BlobCreated` events |
| State store | Azure Cosmos DB (per-table version map) |
| Concurrency control | Azure Cache for Redis distributed lock |
| Container host | Container Apps (Commercial / GCC); AKS (GCC-H / IL5) |
| Build PRP | PRP-08 |

## Architecture

```
   Customer lakehouse                  Loom Direct-Lake Shim
   ───────────────────                 ───────────────────────────
   ADLS Gen2 Delta                     Container App / AKS workload
   _delta_log/*.json
        │
        │ Event Grid: BlobCreated
        │ filtered to /_delta_log/*
        ▼
                                    ┌──────────────────────────────┐
                                    │ EventGridTrigger handler     │
                                    │ 1. Parse Delta commit info   │
                                    │ 2. Identify changed parts    │
                                    │ 3. Resolve to semantic-model │
                                    │    partitions                │
                                    │ 4. Acquire Redis lock        │
                                    │ 5. TOM partition refresh     │
                                    │    via XMLA endpoint         │
                                    │ 6. Update version tracker    │
                                    └──────────────────────────────┘
                                              │
                                              ▼ refresh via XMLA
                          Power BI Premium semantic model
                          (Premium F-SKU capacity)
```

## Per-table refresh policy

Stored in Cosmos DB; editable via Console "Semantic Model" pane (v1.1)
or CLI (v1):

| Policy | Behavior |
|---|---|
| `partition` | Refresh only the affected partition |
| `full` | Full table refresh |
| `directquery-fallback` | DirectQuery against Synapse Serverless / Databricks SQL |
| `composite` | TMDL composite (mix of Import + DirectQuery) |

## Health endpoint

```json
{
  "status": "healthy",
  "event_grid_subscription": "active",
  "tracked_tables": 23,
  "last_refresh_age_seconds": 18,
  "median_refresh_latency_seconds": 14,
  "p95_refresh_latency_seconds": 27
}
```

## Operational SLAs

| Metric | Target |
|---|---|
| Refresh latency p50 (partition) | < 30 s |
| Refresh latency p95 (partition) | < 60 s |
| Refresh latency p50 (full table, small) | < 90 s |
| Concurrent refresh deadlock prevention | Redis lock — no double-refresh |
| Event Grid → handler latency | < 5 s |

## Limitations

- **Sub-second freshness not achievable** — see [Direct Lake parity](../workloads/direct-lake-parity.md)
- **Power BI Premium F-SKU required** — Pro / Premium-Per-User not
  supported (XMLA endpoint requires Premium)
- **GCC has no F-SKU** — Direct Lake parity unavailable in GCC
  (structural gap)

## Runbooks

- [Direct-Lake-Shim stuck](../runbooks/direct-lake-shim-stuck.md)

## Related

- ADR: [fiab-0004 Direct Lake parity](../adr/0004-direct-lake-parity.md)
- Workload: [Direct Lake parity](../workloads/direct-lake-parity.md)
- Build PRP: PRP-08
- Tutorial: [Tutorial 03 — Direct Lake parity](../tutorials/03-direct-lake-parity.md)
- Research: [`temp/fiab-research/03-fabric-only-internals.md` §1](../../../temp/fiab-research/03-fabric-only-internals.md)
