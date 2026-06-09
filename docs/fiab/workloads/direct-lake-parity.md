# Direct Lake parity

> **This is the hardest single workload to parity.** Loom is honest
> about the gap.

!!! warning "Shipped reality vs. design (2026-06-09)"
    **What ships today** is the Loom Thread **"Build a Power BI model"** edge
    (`/api/thread/build-powerbi-model`): it reads a warehouse table (or a custom
    SQL query) and creates a real Power BI **push dataset** with typed columns +
    a sample of rows — *no XMLA required*. The **Direct-Lake-Shim backend
    service** (`apps/fiab-direct-lake-shim`) is real, tested, and bicep-deployed
    (Delta-log ingestion + TOM partition/full refresh + Cosmos refresh-policy
    store), but it is **not yet wired into the Console**: the TOM/XMLA
    partition-refresh editor, per-table refresh-policy picker, DirectQuery
    fallback, and incremental-refresh editor described below are the target
    DESIGN (tasks **T4–T6**, see `docs/fiab/prp/power-bi.md`). Treat the Console
    "Semantic Model" pane sections as roadmap until all three land in `main`.
    Per-capability status is tracked in
    [`parity/direct-lake.md`](../parity/direct-lake.md).
    **Removal trigger:** delete this banner only when T4, T5, and T6 are merged
    to `main` with real-data E2E receipts (Delta write → shim → warm cache → DAX
    returns new rows within SLA; stale cache → Serverless fallback badge;
    incremental + DQ current-period partition provisioned).

## What Fabric does

Direct Lake is Power BI semantic-model storage mode where the
**VertiPaq engine** (the columnar in-memory engine behind Power BI
Import and Analysis Services) reads **Delta-Parquet files directly
from OneLake**, on demand, without an Import-mode copy and without
DirectQuery's per-query federation.

Two flavors exist:
- **Direct Lake on SQL Endpoint (DL/SQL)** — falls back to DirectQuery
  on guardrail breach
- **Direct Lake on OneLake (DL/OL)** — newer; no fallback; errors on
  guardrail breach

The novel engineering is the **transcoder**: VertiPaq reads Parquet
column chunks and converts them on-the-fly into VertiPaq's compressed
columnstore segments. **Framing** (not refresh) advances the model to
the latest Delta version by dropping changed segments + retaining
dictionaries — takes seconds, no data movement.

Sub-second query latency on warm columns. Cold-column first-touch is
fast (no refresh!). Per-F-SKU guardrails cap rows, row groups,
Parquet files, model size.

**V-Order** is the proprietary Parquet write-time sort + encoding that
gives VertiPaq dramatically better paging behavior — files are still
100% Parquet-spec-compliant.

## Why this can't be exactly matched

Per `temp/fiab-research/03-fabric-only-internals.md §1`:

> No OSS engine implements columnar-on-Parquet caching with a DAX /
> MDX surface. The closest open-source projects (DuckDB over Parquet,
> Apache DataFusion, Velox) lack the DAX engine. Power BI / AAS
> Tabular is the only engine that speaks DAX, and Microsoft's
> transcoder is the proprietary IP.

A full OSS replica would be a multi-year engineering project.

## CSA Loom parity design — `apps/fiab-direct-lake-shim`

Per [ADR fiab-0004](../adr/0004-direct-lake-parity.md): **Power BI
Premium Import semantic model + notification-driven warm-cache
materializer**.

### Architecture

```
Customer lakehouse                    Loom Direct-Lake-Shim service
────────────────                      ───────────────────────────────
ADLS Gen2 Delta tables
   _delta_log/*.json                 Container App / AKS workload
        │                               C# .NET 10 + TOM client
        │ Storage Event Grid
        ▼                            ┌─────────────────────────────┐
   "BlobCreated on /_delta_log/*" ──►│ EventGridTrigger handler    │
                                     │  1. Parse Delta commit info │
                                     │  2. Identify changed parts  │
                                     │  3. Decide refresh strategy │
                                     │  4. TOM partition refresh   │
                                     │     via XMLA endpoint       │
                                     └─────────────────────────────┘
                                              │
                                              ▼ refresh via XMLA
                              Power BI Premium semantic model
                              (Premium F-SKU capacity)
```

### Refresh policy per table

Stored in Cosmos DB; editable via Console "Semantic Model" pane (v1.1)
or CLI in v1:

| Policy | Behavior | Use case |
|---|---|---|
| `partition` | Refresh only the affected partition on each Delta commit. Requires partition-aware TMDL. | Time-series facts (e.g., partitioned by event_date) |
| `full` | Full table refresh. Slow for large tables. | Small dimension tables |
| `directquery-fallback` | Marks table as DirectQuery against Synapse Serverless or Databricks SQL. Always live, slower DAX. | Tables exceeding F-SKU memory limits |
| `composite` | TMDL composite mixing the above. | Slowly-changing dims + fast facts |

### Refresh latency

**5-30 seconds median** for partition refresh on small-to-medium
tables. Minutes for full refresh of large tables. **Not sub-second.**

### Console "Semantic Model" pane

- TMDL editor (Monaco with TMDL syntax)
- Visual model designer (drag-drop tables, relationships,
  hierarchies, measures)
- Per-table refresh-policy picker (partition / full / DirectQuery)
- Deploy button (creates / updates the Power BI Premium semantic
  model via Power BI REST API)
- DAX editor with Copilot NL→DAX side panel
- Test query against the deployed model
- Lineage from underlying lakehouse tables

## Per-boundary behavior

| Boundary | F-SKU available | Direct-Lake-Shim |
|---|---|---|
| Commercial | ✅ | ✅ Premium Import + warm-cache |
| **GCC** | ❌ **No F-SKU; P-SKU only** | **Honest structural gap — no Direct Lake parity** |
| GCC-High / IL4 | ✅ | ✅ Premium Import + warm-cache |
| IL5 (v1.1) | ✅ | ✅ Premium Import + warm-cache |

## Honest gaps

This page is the canonical place where Loom documents what it can't
match:

- **Sub-second freshness on new commits = not achievable.** Expected
  range: 5-30 seconds for partition refresh; minutes for full table
  refresh of large tables.
- **VertiPaq paging characteristics** — Import models have warm/cold
  query latency same as Fabric Direct Lake on warm data; cold-data
  first-touch is faster than Fabric Direct Lake (because Import is
  already in memory) but stale until the next refresh.
- **Direct Lake on OneLake (no-fallback) parity** — not delivered.
  Documented as v1 OUT.
- **GCC has no Direct Lake parity** — F-SKU is unavailable in GCC.
  This is a **structural gap, not timing-fixable**.
- **V-Order** — Loom-written Delta tables don't have V-Order; only
  matters when Fabric reads them (mitigated by OneLake shortcut +
  Fabric re-compaction post-migration).

## When to use what

| Scenario | Recommended approach |
|---|---|
| Aggregate analytics (MTD / QTD / YoY) over partition-aware fact tables | Partition refresh + Direct-Lake-Shim — 5-30 s freshness |
| Slowly-changing dimensions | Full refresh on schedule (nightly / hourly) |
| Tables exceeding F-SKU memory | DirectQuery fallback against Databricks SQL Warehouse / Synapse Serverless |
| Mixed (large facts + slow dims) | Composite TMDL — Import for dims + DirectQuery for facts |
| GCC tenant requiring < 1s freshness | Wait for Fabric Gov GA |
| Sub-second freshness on Gov-H/IL5 | Wait for Fabric Gov GA (no Loom parity available) |

## Forward migration

When Fabric Gov GA arrives:
1. Re-author semantic models in Power BI Desktop with Direct Lake on
   OneLake storage mode
2. Point at OneLake shortcuts to Loom's existing lakehouse
3. Retire the Direct-Lake-Shim service — Power BI handles freshness
   natively

## Related

- ADR: [fiab-0004 Direct Lake parity](../adr/0004-direct-lake-parity.md)
- Build PRP: PRP-08 — `apps/fiab-direct-lake-shim/`
- Service docs: [Direct-Lake Shim service](../services/direct-lake-shim.md)
- Tutorial: [Tutorial 03 — Direct Lake parity](../tutorials/03-direct-lake-parity.md)
- Runbook: [Direct-Lake-Shim stuck](../runbooks/direct-lake-shim-stuck.md)
- Research: [`temp/fiab-research/03-fabric-only-internals.md` §1](https://github.com/fgarofalo56/csa-inabox/blob/csa-loom-pillar/temp/fiab-research/03-fabric-only-internals.md)
