# Data Activator parity (Reflex)

## What Fabric does

Reflex (Data Activator) is a declarative rules engine over streaming
+ tabular events. Built on top of Eventhouse (KQL/ADX) for the query
work + per-object state tracking for `andStays` / `noPresence`
semantics. Per Microsoft engineering blogs (see `research/03-fabric-
only-internals.md §3`), Reflex is **not its own stream-processing
runtime** — it's a thin layer that schedules KQL queries against
Eventhouse on intervals and maintains object state.

Entity model: Data sources → Events (filters / projections) → Objects
(stateful entities keyed by `splitColumn`) → Attributes (computed
properties) → Rules → Actions.

Rule primitives: `increasesAbove`, `decreasesBelow`, `is above`,
`is below`, `changesTo`, `andStays(duration)`,
`noPresenceOfData(seconds)`, `everyNthTime(n, seconds)`.

Action surface: Teams, Email, Power Automate, Pipeline run, Notebook
run, Spark job, Dataflow Gen2 refresh, User Data Function call.

End-to-end latency: 5-30 s.

## CSA Loom parity design — `apps/fiab-activator-engine`

Full design in [ADR fiab-0005](../adr/0005-activator-engine.md).
Summary:

| Component | Implementation |
|---|---|
| Query engine | Azure Data Explorer (same Kusto engine Fabric Eventhouse uses) |
| Rule evaluator | NRules (.NET production Rete rules engine) |
| Per-object state | Azure Cache for Redis Premium (TTL'd keys) |
| Rule scheduler | Cron orchestrator reading from Cosmos DB definitions |
| Action dispatcher | Azure Functions with output bindings |

All 8 Fabric Reflex primitives implemented. Latency target: 5-30 s
end-to-end (matches Fabric).

### Rule definition

JSON schema documented in `apps/fiab-activator-engine/schemas/`.
Authored via Loom Console "Activator" pane (visual designer with
KQL backing store) or directly in JSON for Git-based authoring.

Example (CPU high sustained):

```json
{
  "id": "rule-cpu-high-andstays",
  "workspaceId": "ws-001",
  "name": "VM CPU sustained high",
  "dataSource": {
    "type": "adx-kql",
    "cluster": "adx-loom-eastus2",
    "database": "telemetry",
    "query": "VmMetrics | where TimestampUtc > ago(15m) | summarize avg(CpuPercent) by VmId, bin(TimestampUtc, 1m)",
    "splitColumn": "VmId",
    "cadenceMinutes": 1
  },
  "rules": [
    {
      "name": "Sustained CPU > 85% for 5 min",
      "expression": {
        "operator": "andStays",
        "left": {
          "operator": "isAbove",
          "attribute": "avg_CpuPercent",
          "threshold": 85
        },
        "durationMinutes": 5
      },
      "actions": [
        {
          "type": "teams-message",
          "channel": "#ops-alerts",
          "template": "VM {VmId} CPU is at {avg_CpuPercent}% for >5 min."
        },
        {
          "type": "databricks-job",
          "workspace": "dbx-ws-001",
          "jobId": "12345"
        }
      ]
    }
  ],
  "enabled": true
}
```

### Action surface

Status as of 2026-06-06 (✅ shipped / 🟡 editor-only / ⛔ roadmap, not built):

| Action type | Binding | Status |
|---|---|---|
| Teams message | Graph API / webhook | ✅ engine + editor |
| Email | Azure Communication Services | ✅ engine + editor |
| Logic App | HTTP webhook | ✅ engine |
| Generic webhook | HTTPS POST | ✅ engine + editor |
| ADF Pipeline | ADF REST | 🟡 editor configures it |
| Notebook run | notebook id | 🟡 editor configures it |
| Power Automate flow | HTTP trigger | 🟡 editor configures it |
| Databricks Job | Databricks Jobs API | ⛔ not implemented |
| User Data Function | Function call | ⛔ not implemented |

The C# engine (`ActionDispatcher.cs`) dispatches the four ✅ rows; the Console
activator editor (`phase3-editors.tsx`) additionally configures the three 🟡
rows. The ⛔ rows are roadmap.

## Per-boundary behavior

| Boundary | ADX | NRules / Redis / Functions |
|---|---|---|
| Commercial | ✅ | ✅ Container Apps |
| GCC | ✅ | ✅ Container Apps |
| GCC-High / IL4 | ✅ | ✅ AKS workload (Container Apps not at IL4+) |
| IL5 (v1.1) | ✅ | ✅ AKS workload |

## Honest gaps

- **Per-object state in Redis** is functionally equivalent but
  Fabric's internal state store may have stricter exactly-once
  guarantees (Microsoft hasn't published these — flagged in
  `research/03-fabric-only-internals.md §3` as thin info). Loom's
  semantics documented openly.
- **Visual rule designer** is functional in v1 but won't match
  Fabric's drag-drop UX polish; v1.1 invests in UX parity.
- **Cron-based 1-min minimum cadence** — Fabric's internal scheduler
  may run more often. For sub-second latency, use Azure Stream
  Analytics directly (out of scope).

## Forward migration

Rules export to JSON via `apps/fiab-activator-engine/export` →
Reflex definition import via Fabric REST API. State doesn't migrate
(by design — rules re-arm in Fabric).

## Related

- ADR: [fiab-0005 Activator engine](../adr/0005-activator-engine.md)
- Build PRP: PRP-06 — `apps/fiab-activator-engine/`
- Service docs: [Activator Engine service](../services/activator-engine.md)
- Tutorial: [Tutorial 04 — Activator rules over IoT stream](../tutorials/04-activator-rules.md)
- Runbook: [Activator rules not firing](../runbooks/activator-rules-not-firing.md)
