# Loom Eventhouse Editor — Fabric-parity spec

> Captured 2026-05-26 by catalog agent `a8260c3697beb6c69` from live `eventhouse1` in `casino-fabric-poc` + Fabric documentation.

## Fabric UX

### System overview pane
- Eventhouse details + storage metrics
- System resources / compute usage tracking
- Top user activity (last N minutes)
- Ingestion rate monitoring
- Top queried + ingested databases
- "What's new" notifications

### KQL Database management (per database)
**Tables view** (Cards or List layout) with metadata per table:
- Compressed size
- Last ingestion time
- OneLake availability (toggle)
- Row count
- Original size
- Retention policy
- Caching policy
- Creation date
- Table creator profile

**Data preview**: top ingested records inline

**Query insights**:
- Duration percentiles
- Cache hit analysis
- Top queries by duration / CPU / memory / cold storage

### OneLake integration
- OneLake availability sync (seconds latency)
- Mirrored schema with OneLake shortcuts
- Query acceleration policies
- OneLake cache storage (premium tier, cache-policy controlled)
- OneLake standard storage (persistent, retention-policy controlled)
- Sync status monitoring

### KQL Queryset features
- Embedded KQL query editor
- Copilot NL2KQL support
- Query results customization + visualization
- Cross-service queries (Azure Monitor Log Analytics, Application Insights)

### Dashboards + analytics
- Real-time dashboard integration
- KQL or SQL-based analysis
- T-SQL analytics endpoint (when OneLake enabled)

### Consumption + monitoring
- Compute usage tracking by operation
- Storage billing (OneLake Cache vs Standard)
- Workspace Monitoring dashboard
- Fabric Capacity Metrics app integration
- Capacity unit (CU) usage

## What Loom has
- ✅ ADX/Kusto cluster deployed (Loom Eventhouse equivalent)
- ✅ `/api/items/eventhouse/{id}` returns cluster URI + KQL databases (working)
- ✅ KQL execution via `executeQuery` (verified UAT)
- ✅ T-SQL via paired Synapse Serverless

## Gaps for parity
1. **System overview pane** — currently no UI panel showing storage / ingestion rate / top queries
2. **Per-table metadata view** — Loom shows tables but not the rich metadata (compressed size, retention, caching policies, OneLake availability)
3. **OneLake availability toggle** — Loom doesn't expose the ADX `.alter table ... policy onelake_availability` command via UI
4. **Query insights pane** — no duration percentile / cache hit / top-queries-by-metric UI
5. **NL2KQL Copilot** — Loom has cross-item Copilot but not the inline Eventhouse-specific NL2KQL
6. **Capacity metrics integration** — Loom has admin/azure-resources but no per-Eventhouse drill-down

## Backend
All present. Required: just UI work + a few ADX management commands wrapped as BFF routes.

## Estimated effort
2 sessions. Most plumbing exists; this is mostly UI surfacing of metrics + policy controls.
