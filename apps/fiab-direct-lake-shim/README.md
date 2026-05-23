# Loom Direct-Lake Shim

Direct Lake parity service. Subscribes to Storage Event Grid
notifications on `_delta_log` writes; issues TOM partition-scoped
refresh against associated Power BI Premium semantic models.

**Latency target: 5-30 seconds median.** Honest gap vs Fabric's
sub-second Direct Lake on OneLake documented openly in
[Direct Lake parity workload page](../../docs/fiab/workloads/direct-lake-parity.md).

**Status**: SCAFFOLDED. Real implementation per [PRP-08](../../PRPs/active/csa-loom/PRP-08-direct-lake-shim.md)
+ [ADR fiab-0004](../../docs/fiab/adr/0004-direct-lake-parity.md).

## Tech stack

- C# .NET 10
- Microsoft.AnalysisServices.Core 19.x (TOM client for XMLA refresh)
- Azure Event Grid subscription on Storage `BlobCreated` filtered to
  `/_delta_log/*.json`
- Azure Cosmos DB (per-table version map + refresh history)
- Azure Cache for Redis (distributed lock to prevent concurrent
  refresh)
- Container App (Commercial / GCC) or AKS workload (GCC-H / IL5)

## Per-table refresh policy

Stored in Cosmos DB:

| Policy | Behavior |
|---|---|
| `partition` | Refresh only affected partition (preferred) |
| `full` | Full table refresh |
| `directquery-fallback` | DirectQuery against Synapse Serverless / Databricks SQL |
| `composite` | TMDL composite (Import + DirectQuery hybrid) |

## Scaffolded structure

```
apps/fiab-direct-lake-shim/
├── README.md
├── Dockerfile
├── Program.cs
├── EventGridHandler/
│   └── DeltaCommitHandler.cs
├── PartitionResolver/
│   └── DeltaPartitionResolver.cs
├── TomRefresh/
│   └── XmlaPartitionRefresher.cs
├── Tracker/
│   └── CosmosVersionTracker.cs
├── Locks/
│   └── RedisDistributedLock.cs
└── tests/
```

## Limitations (honest gaps)

- **Sub-second freshness not achievable** (5-30s typical)
- **Direct Lake on OneLake no-fallback parity** not delivered
- **GCC has no Direct Lake parity** (no F-SKU in GCC; structural gap)
- **Power BI Premium F-SKU required** (Pro / PPU not supported via
  XMLA endpoint)

## Related

- [Direct-Lake Shim service docs](../../docs/fiab/services/direct-lake-shim.md)
- [Direct Lake parity workload](../../docs/fiab/workloads/direct-lake-parity.md)
- [PRP-08](../../PRPs/active/csa-loom/PRP-08-direct-lake-shim.md)
- [Direct-Lake-Shim stuck runbook](../../docs/fiab/runbooks/direct-lake-shim-stuck.md)
- Research: [`temp/fiab-research/03-fabric-only-internals.md` §1](../../temp/fiab-research/03-fabric-only-internals.md)
