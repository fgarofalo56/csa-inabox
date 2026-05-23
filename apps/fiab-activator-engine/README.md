# Loom Activator Engine

Reflex / Data Activator parity service. NRules + Redis + Function
dispatcher backed by ADX.

**Status**: SCAFFOLDED. Real implementation per [PRP-06](../../PRPs/active/csa-loom/PRP-06-activator-engine.md)
+ [ADR fiab-0005](../../docs/fiab/adr/0005-activator-engine.md).

## Tech stack

- C# .NET 10
- NRules (production Rete rules engine)
- Azure Cache for Redis Premium (per-object state)
- Azure Cosmos DB (rule definitions + execution history)
- Azure Functions (action dispatcher — Premium EP1 in Gov, Flex in Commercial)
- Container App (Commercial / GCC) or AKS workload (GCC-H / IL5)

## Architecture

```
Console "Activator" pane
   └→ CRUD via REST → Cosmos DB (rule definitions)
                              │
                              ▼ load rules
Loom Activator Engine container:
   - Rule Scheduler (cron orchestrator)
   - KQL Query Runner (schedules KQL against ADX)
   - NRules Evaluator
   - State Manager (Redis client)
   - Dispatcher Client (calls Action Dispatcher Function App)

Action Dispatcher Function App:
   Teams / Email / Power Automate / Logic App / Databricks Job /
   ADF Pipeline / UDF / Webhook
```

## Rule primitives (all 8 Fabric Reflex primitives)

- `increasesAbove(threshold)`
- `decreasesBelow(threshold)`
- `is above` / `is below`
- `changesTo(value)`
- `andStays(duration)`
- `noPresenceOfData(seconds)`
- `everyNthTime(n, seconds)`

## Scaffolded structure

```
apps/fiab-activator-engine/
├── README.md
├── Dockerfile
├── Program.cs                  # main entry point
├── RuleScheduler/
│   └── CronOrchestrator.cs
├── RuleEvaluator/
│   └── NRulesAdapter.cs
├── StateManager/
│   └── RedisClient.cs
├── KqlQueryRunner/
│   └── AdxQueryExecutor.cs
├── schemas/
│   └── rule-definition.schema.json
└── tests/
    └── (per-primitive test cases)
```

## Related

- [Activator Engine service docs](../../docs/fiab/services/activator-engine.md)
- [Data Activator parity workload](../../docs/fiab/workloads/data-activator-parity.md)
- [PRP-06](../../PRPs/active/csa-loom/PRP-06-activator-engine.md)
- [Activator rules not firing runbook](../../docs/fiab/runbooks/activator-rules-not-firing.md)
