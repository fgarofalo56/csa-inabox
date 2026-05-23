# Loom Activator Engine service

Per [ADR fiab-0005](../adr/0005-activator-engine.md) and [Data
Activator parity workload](../workloads/data-activator-parity.md).

## Purpose

Reflex / Data Activator parity service. Declarative rules over
streaming + tabular events with stateful object tracking + diverse
action surface.

## Service shape

| Aspect | Value |
|---|---|
| Repo path | `apps/fiab-activator-engine/` |
| Language | C# .NET 10 |
| Rule engine | NRules (.NET production-grade Rete) |
| State store | Azure Cache for Redis Premium |
| Schedule store | Azure Cosmos DB |
| Action dispatcher | Azure Functions (Premium EP1 in Gov; Flex Consumption in Commercial) |
| Container host | Container Apps (Commercial / GCC); AKS workload (GCC-H / IL5) |
| Build PRP | PRP-06 |

## Components

```
                  ┌─────────────────────────────────────────────────┐
                  │  Loom Console "Activator" pane                  │
                  │   Visual rule designer + KQL backing store      │
                  │   CRUD via REST → Cosmos DB (rule definitions)  │
                  └────────────────────┬────────────────────────────┘
                                       │ deploys/syncs
                                       ▼
                  ┌─────────────────────────────────────────────────┐
                  │  Loom Activator Engine container                │
                  │                                                  │
                  │  - Rule Scheduler (cron orchestrator)           │
                  │  - KQL Query Runner (scheduled queries → ADX)   │
                  │  - NRules Evaluator (rule firing logic)         │
                  │  - State Manager (Redis client)                 │
                  │  - Dispatcher client (calls Function App)       │
                  └─────────────────────────────────────────────────┘
                                       │
                                       ▼
                  ┌─────────────────────────────────────────────────┐
                  │  Action Dispatcher Function App                 │
                  │   Teams / Email / Power Automate / Logic App /  │
                  │   Databricks Job / ADF Pipeline / UDF / Webhook │
                  └─────────────────────────────────────────────────┘
```

## Capacity / cost model

- Per-rule cost: minimal (KQL query + Redis state ops per cadence)
- Container scale: 1 minimum (for cron); scale-out on rule count
- Estimated cost per 100 active rules at 1-min cadence: ~$80/month
  in Commercial

## Health endpoint

`GET /health` returns:

```json
{
  "status": "healthy",
  "redis_connection": "ok",
  "cosmos_connection": "ok",
  "adx_connection": "ok",
  "rules_loaded": 47,
  "last_evaluation_age_seconds": 12
}
```

## Operational SLAs

| Metric | Target |
|---|---|
| End-to-end latency (event → action) | 5-30 s |
| Rule scheduler lag | < 10 s |
| Action dispatch success rate | > 99% |
| Redis state read latency p99 | < 50 ms |

## Runbooks

- [Activator rules not firing](../runbooks/activator-rules-not-firing.md)

## Related

- ADR: [fiab-0005 Activator engine](../adr/0005-activator-engine.md)
- Workload: [Data Activator parity](../workloads/data-activator-parity.md)
- Build PRP: PRP-06
- Tutorial: [Tutorial 04 — Activator rules over IoT stream](../tutorials/04-activator-rules.md)
