# Loom Activator Engine service

Per [ADR fiab-0005](../adr/0005-activator-engine.md) and [Data
Activator parity workload](../workloads/data-activator-parity.md).

## Purpose

Reflex / Data Activator parity service. Declarative rules over
streaming + tabular events with stateful object tracking + diverse
action surface.

!!! warning "Shipped action set (2026-06-06)"
    The C# engine (`apps/fiab-activator-engine`, `ActionDispatcher.cs`) currently
    dispatches **four** action types: **Teams, Email, Logic App, Webhook**. The
    Console activator editor additionally lets you configure **ADF Pipeline run,
    Notebook run, and Power Automate flow** actions. **Databricks Job** and
    **User Data Function** actions referenced elsewhere in these docs are **not
    implemented** in either backend — treat them as roadmap. The Azure-native
    default rule backend is an **Azure Monitor scheduled-query alert** (Fabric
    Reflex is opt-in via `LOOM_ACTIVATOR_BACKEND=fabric`).

!!! info "ADX-native Activator runtime (2026-07-01)"
    The console activator now defaults new rules to an **Eventhouse / KQL
    Database (ADX) source** (`sourceKind: 'adx'` in
    `apps/fiab-console/lib/azure/activator-monitor.ts`). The rule wizard's
    `/adx-source` pickers resolve the **real cluster, databases, and tables**
    from the shared Loom ADX cluster, and the rule's KQL evaluates **directly
    against Eventhouse/ADX data**:

    - **On-demand (default):** **Trigger / Preview** runs the rule's KQL
      against ADX now and dispatches actions if rows match — real data, no
      scheduled host required.
    - **Scheduled (opt-in):** set `LOOM_ADX_ALERT_SCOPE` to the ADX cluster
      ARM resource id (and grant the alert identity **Database Viewer**);
      Loom then creates a real Azure Monitor `scheduledQueryRule` **scoped to
      the ADX cluster** (`skipQueryValidation` — the KQL targets ADX, not Log
      Analytics) for hands-off continuous evaluation.

    **Log Analytics** KQL and **Event Hub** sources remain available and always
    evaluate continuously via standard Azure Monitor scheduled-query alerts.
    Actions on all paths dispatch through real **Azure Monitor action groups**
    (email, SMS, webhook, Logic App). This supersedes the older
    "KQL Query Runner (scheduled queries → ADX)" description below for the
    console-authored rule path; the C# engine remains the container-hosted
    evaluation option (GCC-H / IL5).

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
