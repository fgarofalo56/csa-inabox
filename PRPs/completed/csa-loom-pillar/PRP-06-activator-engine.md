# PRP-06 — Loom Activator Engine (Reflex/Data Activator Parity)

## Context

Data Activator / Reflex parity service: declarative rules over
streaming + tabular data with stateful object tracking + diverse
action surface. Backed by ADX (Kusto) for the query engine + NRules
(.NET) for rule evaluation + Redis for per-object state + Function
App for action dispatch.

PRD ref: `temp/fiab-prd/05-workload-parity.md` §5.6;
`temp/fiab-prd/06-custom-apps.md` §6.3.

## Goal

`apps/fiab-activator-engine/` runs as a Container App (Commercial /
GCC) or AKS workload (GCC-High / IL5) and delivers Reflex-equivalent
rule semantics including all Fabric primitives (`increasesAbove`,
`decreasesBelow`, `is above`, `is below`, `changesTo`, `andStays`,
`noPresenceOfData`, `everyNthTime`).

## Acceptance criteria

- [ ] C# .NET 10 service with NRules rule engine + Redis state store
  (Azure Cache for Redis Premium)
- [ ] Rule definitions stored in Cosmos DB
- [ ] Data source connectors: ADX databases, KQL Querysets, ADLS Gen2
  Delta tables (via Databricks SQL Warehouse in Commercial / Synapse
  Serverless in Gov)
- [ ] Rule scheduler: per-rule cadence (min 1 min, default 5 min)
- [ ] Object state manager: per-`splitColumn` tracking; supports
  `andStays(duration)` + `noPresenceOfData(seconds)` semantics
- [ ] All 8 Fabric rule primitives implemented
- [ ] Action dispatcher (Function App) with output bindings:
  Teams (Graph API), Email (ACS), Power Automate webhook, Logic App
  webhook, Databricks Jobs API, ADF pipeline trigger, UDF call,
  generic webhook
- [ ] Loom Console "Activator" pane (in PRP-03) → REST CRUD against
  this service's API
- [ ] Telemetry: every rule firing + every action dispatch logged to
  App Insights + Sentinel (in Gov)
- [ ] Latency target: 5-30 s end-to-end from event to action (matches
  Fabric Reflex)

## Validation gates

- Unit tests for each rule primitive
- Integration tests against a test ADX cluster with synthetic data
- E2E test: deploy a rule → inject events → verify Teams message
  arrives at a test channel within latency SLA
- Performance test: 100 active rules at 1-min cadence → no degradation

## Implementation outline

1. Scaffold .NET 10 project with NRules
2. Implement rule definition JSON schema (per PRD §6.3 example)
3. Implement Object State Manager backed by Redis (TTL'd keys)
4. Implement Rule Scheduler (cron orchestrator reading from Cosmos)
5. Implement KQL Query Runner (against ADX REST)
6. Implement Rule Evaluator (NRules rules built from JSON definitions)
7. Implement Action Dispatcher Function App
8. Wire from Console Activator pane via REST API
9. Helm chart for AKS (Gov); Container App deployment for Commercial
10. Telemetry + Sentinel integration

## File changes

```
apps/fiab-activator-engine/                              created (.NET project)
apps/fiab-activator-engine/Program.cs                    created
apps/fiab-activator-engine/RuleScheduler/                created
apps/fiab-activator-engine/RuleEvaluator/                created
apps/fiab-activator-engine/StateManager/                 created
apps/fiab-activator-engine/Dockerfile                    created
apps/fiab-activator-engine/helm/                         created
apps/fiab-activator-dispatcher/                          created (Function App)
apps/fiab-activator-dispatcher/function_app.py           created
platform/fiab/bicep/modules/landing-zone/activator-engine.bicep created
```

## Open questions / risks

- Per-object state in Redis is functionally equivalent but Fabric's
  internal state-store may have stricter exactly-once guarantees
  (Microsoft hasn't published these); document our semantics openly
- Visual rule designer (Console pane) is functional but won't match
  Fabric's drag-drop UX polish in v1; v1.1 polishes

## References

- `temp/fiab-prd/05-workload-parity.md` §5.6
- `temp/fiab-prd/06-custom-apps.md` §6.3
- `temp/fiab-research/03-fabric-only-internals.md` §3
- learn.microsoft.com/fabric/real-time-intelligence/data-activator/
