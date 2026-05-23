# PRP-08 — Loom Direct-Lake Shim (Direct Lake Parity Service)

## Context

Best-effort Direct Lake parity: keep Power BI Premium semantic models
refreshed close to the underlying Delta commit cadence using
notification-driven partition-scoped refresh. The honest gap (5-30s
vs Fabric's sub-second) is documented openly.

PRD ref: `temp/fiab-prd/05-workload-parity.md` §5.9;
`temp/fiab-prd/06-custom-apps.md` §6.5; AMENDMENTS §A6.

## Goal

`apps/fiab-direct-lake-shim/` is a Container App (Commercial / GCC)
or AKS workload (GCC-High / IL5) that subscribes to Storage Event
Grid notifications on `_delta_log` writes in registered lakehouses
and issues TOM partition-scoped refresh operations against associated
Power BI Premium semantic models.

## Acceptance criteria

- [ ] C# .NET 10 service using Microsoft.AnalysisServices.Core 19.x
  (TOM client library)
- [ ] Storage Event Grid subscription on `BlobCreated` filtered to
  `/Tables/*/_delta_log/*.json` per registered lakehouse
- [ ] Per-table refresh policy: `partition` / `full` / `directquery-
  fallback` / `composite` (stored in Cosmos DB)
- [ ] Partition resolver maps Delta commit info → affected semantic-
  model partitions
- [ ] TOM XMLA refresh against Power BI Premium semantic model
- [ ] Redis distributed lock prevents concurrent refresh on same model
- [ ] Cosmos DB tracker: per-table → version map + refresh history
- [ ] Loom Console "Semantic Model" pane integration (or CLI in v1 if
  pane deferred per PRP-03 risk)
- [ ] Latency target: < 60s median for partition refresh on small-
  to-medium tables
- [ ] OAP egress: only outbound to Power BI XMLA endpoint + Cosmos +
  Redis + LAW

## Validation gates

- Synthetic Delta commit on test lakehouse → measure refresh latency
- Unit tests on partition resolver + TOM refresh logic
- Integration test: write to lakehouse table → semantic model query
  returns updated values within 60s
- Concurrency test: rapid-fire commits on same table → single
  refresh executes (Redis lock works)
- Document expected latency ranges in `docs/fiab/workloads/direct-lake-parity.md`

## Implementation outline

1. Scaffold .NET 10 service
2. Wire Event Grid subscription handler
3. Implement Delta commit info parser (reads `_delta_log/000000...json`)
4. Implement partition resolver
5. Wire TOM client for XMLA refresh
6. Add Redis distributed lock
7. Implement Cosmos DB tracker
8. Surface REST API for the Console "Semantic Model" pane
9. Helm chart + Container App Bicep
10. Document the freshness gap honestly in the workload page

## File changes

```
apps/fiab-direct-lake-shim/                                  created (.NET project)
apps/fiab-direct-lake-shim/Program.cs                        created
apps/fiab-direct-lake-shim/EventGridHandler/                 created
apps/fiab-direct-lake-shim/PartitionResolver/                created
apps/fiab-direct-lake-shim/TomRefresh/                       created
apps/fiab-direct-lake-shim/Dockerfile                        created
apps/fiab-direct-lake-shim/helm/                             created
platform/fiab/bicep/modules/landing-zone/direct-lake-shim.bicep created
docs/fiab/workloads/direct-lake-parity.md                    created (by PRP-15)
```

## Open questions / risks

- Sub-second freshness not achievable; document openly
- Direct Lake on OneLake (no-fallback) parity not delivered; out of
  scope
- GCC has no Direct Lake parity available (no F-SKU); honest
  structural gap; document in GCC deployment page
- TOM XMLA endpoint requires Power BI Premium workspace; can't run
  against Power BI Pro / Premium-Per-User

## References

- `temp/fiab-prd/05-workload-parity.md` §5.9
- `temp/fiab-prd/06-custom-apps.md` §6.5
- `temp/fiab-prd/AMENDMENTS.md` §A6
- `temp/fiab-research/03-fabric-only-internals.md` §1
- SQLBI Direct Lake deep-dives (linked from research file)
