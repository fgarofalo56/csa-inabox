# fiab-0004: Direct Lake parity via Premium Import + warm-cache materializer

**Status:** Accepted
**Date:** 2026-05-22
**Locked decision ref:** LD-7

## Context

Microsoft Fabric's Direct Lake mode is the single most distinctive
engineering artifact in the Fabric product. It uses the proprietary
VertiPaq transcoder to read Delta-Parquet files directly from
OneLake, with **sub-second cold-data query latency** and "framing
not refresh" sync semantics. There is **no open-source engine that
implements columnar-on-Parquet caching with a DAX/MDX surface** —
DuckDB, Apache DataFusion, and Velox come close on the columnar
side but lack DAX.

CSA Loom needs to deliver the closest tractable parity given that:
1. Power BI Premium is available in GCC-H / IL5 (F-SKU) and GCC
   (P-SKU)
2. Power BI Desktop authors models in TMDL format
3. The Tabular Object Model (TOM) supports programmatic partition-
   scoped refresh
4. Azure Storage emits Event Grid notifications on `_delta_log` writes
5. Direct Lake's sub-second freshness genuinely cannot be matched
   without owning the VertiPaq transcoder

Per `temp/fiab-research/03-fabric-only-internals.md §1`, two viable
approaches exist:
- **Approach A**: Power BI Premium Import semantic model + custom
  warm-cache materializer that subscribes to Delta commit events and
  issues TOM partition refresh
- **Approach B**: Databricks SQL Warehouse + Power BI DirectQuery +
  aggregation tables — always-live but DAX engine sees DirectQuery
  latency

## Decision

**Approach A: Power BI Premium Import + notification-driven warm-cache
materializer.** Implemented as `apps/fiab-direct-lake-shim/`.

Architecture:
1. Customer's Loom lakehouse writes to ADLS Gen2 Delta tables (via
   Databricks Spark notebooks, dbt, or Mirroring Engine)
2. Each Delta commit produces a new entry under `Tables/<name>/_delta_log/`
3. Storage Event Grid subscription on `BlobCreated` filtered to
   `/Tables/*/_delta_log/*.json`
4. Direct-Lake Shim service (Container App in Commercial / GCC; AKS
   in GCC-H / IL5) receives the event
5. Service parses the Delta commit, identifies changed Parquet
   partitions
6. Service uses Microsoft.AnalysisServices.Core TOM client to issue
   partition-scoped refresh against the associated Power BI Premium
   semantic model
7. Refresh latency target: **5-30 seconds** from commit to refreshed
   model for partition-aware tables; minutes for full-table refresh
   on unpartitioned tables

Per-table refresh policy (stored in Cosmos DB, edited via Console
"Semantic Model" pane):
- **`partition`**: refresh only the affected partition (preferred)
- **`full`**: full table refresh
- **`directquery-fallback`**: DirectQuery against Synapse Serverless
  / Databricks SQL Warehouse — always-live but slower DAX
- **`composite`**: TMDL composite model mixing the above

DirectQuery fallback handles tables exceeding F-SKU memory limits
OR tables marked "DirectQuery only" by the customer.

## Consequences

### Positive

- Uses standard Power BI Premium semantic model engine — same
  VertiPaq engine as Direct Lake; same DAX execution; warm-data
  query latency identical to Direct Lake
- 5-30 second freshness is acceptable for most analytical workloads
  (daily, hourly, or near-real-time reporting)
- Works across Commercial / GCC-H / IL5 — wherever Power BI Premium
  F-SKU (or P-SKU in GCC) is available
- TOM partition refresh is well-supported Microsoft engineering;
  semantic-link-labs has working code patterns
- Composite models let customers mix Import (fast warm queries) +
  DirectQuery (live but slow) per-table

### Negative

- **Sub-second freshness is not achievable.** Documented openly in
  [Direct Lake parity workload page](../workloads/direct-lake-parity.md)
  — customers who need Fabric-native sub-second wait for Fabric Gov GA
- Cold-data first query is faster than Direct Lake (Import is already
  in memory) BUT data can be stale until next refresh — different
  cold-query characteristics
- For very large fact tables, full refresh is slow; partition-aware
  TMDL authoring requires upfront design discipline
- **In GCC: no Direct Lake parity at all** — F-SKU is unavailable
  in GCC (per Power BI Government rules); structural gap, not
  timing-fixable

### Neutral

- The Shim service is a new operational component to monitor
  (latency, success rate, deadlock-on-concurrent-refresh)
- Customers needing Direct Lake's "always-live + sub-second" must
  document the gap and plan accordingly
- Forward migration: when Fabric Gov GA arrives, semantic models
  re-author for Direct Lake on OneLake; Shim service is retired

## Alternatives considered

| Alternative | Why not chosen |
|---|---|
| Databricks SQL Warehouse + DirectQuery + aggregation tables | DAX engine sees DirectQuery latency for all queries (not just cold); aggregation tables require careful per-workload tuning; doesn't work in Gov (no Databricks SQL Warehouse in usgovaz/usgovva) |
| DuckDB over Parquet + custom DAX shim | No production-grade DAX engine in OSS; multi-year build |
| Synapse Serverless + DirectQuery only | No caching; query latency dominated by Parquet scan; misses VertiPaq perf entirely |
| Wait for Fabric Gov GA (no parity in v1) | Misses the strategic anchor — Direct Lake is what makes Fabric customers love Power BI |

## References

- PRD: [`temp/fiab-prd/05-workload-parity.md`](https://github.com/fgarofalo56/csa-inabox/blob/csa-loom-pillar/temp/fiab-prd/05-workload-parity.md) §5.9, [`06-custom-apps.md`](https://github.com/fgarofalo56/csa-inabox/blob/csa-loom-pillar/temp/fiab-prd/06-custom-apps.md) §6.5
- Amendments: [`temp/fiab-prd/AMENDMENTS.md`](https://github.com/fgarofalo56/csa-inabox/blob/csa-loom-pillar/temp/fiab-prd/AMENDMENTS.md) §A6
- Research: [`temp/fiab-research/03-fabric-only-internals.md`](https://github.com/fgarofalo56/csa-inabox/blob/csa-loom-pillar/temp/fiab-research/03-fabric-only-internals.md) §1
- External: [Microsoft Learn — Direct Lake overview](https://learn.microsoft.com/fabric/fundamentals/direct-lake-overview), [SQLBI Direct Lake deep-dives](https://www.sqlbi.com/blog/marco/2025/05/13/direct-lake-vs-import-vs-direct-lakeimport-fabric-semantic-models-may-2025/)
- Build: PRP-08 — `apps/fiab-direct-lake-shim/`
