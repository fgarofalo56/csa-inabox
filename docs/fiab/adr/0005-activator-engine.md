# fiab-0005: Activator engine on ADX + NRules + Redis

**Status:** Accepted
**Date:** 2026-05-22

## Context

CSA Loom needs Data Activator / Reflex parity: declarative rules
over streaming + tabular events with stateful object tracking and
a diverse action surface (Teams, Email, Power Automate, Logic App,
Databricks job, ADF pipeline, UDF, webhook).

Per `temp/fiab-research/03-fabric-only-internals.md §3`, Fabric's
Activator is **not a separate stream-processing runtime** — it's a
thin scheduling layer over Eventhouse (Kusto/ADX) that polls KQL
queries on a cadence + tracks per-object state.

Loom has full access to:
- **Azure Data Explorer (Kusto)** — the same engine Fabric Eventhouse
  runs on; available across Commercial / GCC / GCC-High / IL5 / IL6
- **Azure Cache for Redis Premium** — for per-object TTL'd state
- **Azure Functions** — for action dispatch
- **NRules** (.NET production Rete rules engine) — for rule evaluation
- **OPA / Rego** as an alternative rule DSL (policy-language flavor)

All 8 Fabric Reflex rule primitives need to be implemented:
`increasesAbove`, `decreasesBelow`, `is above`, `is below`,
`changesTo`, `andStays(duration)`, `noPresenceOfData(seconds)`,
`everyNthTime(n, seconds)`.

## Decision

**ADX (Kusto) for query engine + NRules for rule evaluation + Redis
for per-object state + Function App for action dispatch.**

Implemented as `apps/fiab-activator-engine/` — Container App
(Commercial / GCC) or AKS workload (GCC-High / IL5).

Components:

1. **Rule Scheduler** (cron orchestrator)
   - Reads rule definitions from Cosmos DB
   - Schedules KQL queries against ADX on per-rule cadence (min 1 min,
     default 5 min)

2. **KQL Query Runner**
   - Executes scheduled queries via ADX REST API
   - Returns per-`splitColumn` event batches

3. **NRules Evaluator**
   - Loads rules at startup from Cosmos JSON definitions
   - Compiles into Rete network
   - Per-object state machines (edge-transition detection vs continuous)

4. **State Manager** (Redis client)
   - Per-`splitColumn` value: object_id → state record
   - State record includes `last_seen`, `current_value`,
     `last_alert_time`, `rule_state_machines` (per rule × per object)
   - TTL'd by `noPresenceOfData` window

5. **Action Dispatcher** (Function App)
   - Output bindings: Teams (Graph API), Email (ACS), Power Automate
     (HTTP webhook), Logic App (HTTP webhook), Databricks Jobs API,
     ADF pipeline trigger, UDF call, generic HTTPS webhook
   - Dynamic substitution via `{columnName}` placeholders

Rule definition format: JSON schema documented in
`apps/fiab-activator-engine/schemas/rule-definition.schema.json`.

Latency target: 5-30 s end-to-end (matches Fabric Reflex).

## Consequences

### Positive

- Uses the same engine (ADX / Kusto) that Fabric Eventhouse uses —
  customers writing KQL queries can port them 1:1 to Fabric
- NRules is production-grade .NET (Rete-based, widely used in
  financial services + healthcare for compliance rules)
- Redis state store gives clean implementations of `andStays` +
  `noPresenceOfData` (sorted sets keyed by event time; TTL-based
  stale detection)
- Function App dispatcher leverages built-in output bindings — no
  custom HTTP retry / dead-letter logic to write
- All 8 Fabric Reflex primitives map naturally to NRules `Rule`
  classes

### Negative

- Per-object state in Redis is functionally equivalent but Fabric's
  internal state-store may have stricter exactly-once guarantees
  (Microsoft hasn't published these); document our semantics openly
- Visual rule designer in Console is functional but not as polished as
  Fabric's drag-drop UX in v1; v1.1 polishes
- Cron-based KQL polling has a 1-minute minimum cadence — Fabric's
  internal scheduler may run more often; for sub-second latency
  customers should use Stream Analytics directly (out of scope)
- Operating multiple Container App / AKS instances per Admin Plane

### Neutral

- Forward migration: rules export to JSON via
  `apps/fiab-activator-engine/export` → Reflex definition import via
  Fabric REST API. State doesn't migrate (rules re-arm in Fabric)
- Customer can mix-and-match: some rules in Loom Activator; some
  rules in Azure Stream Analytics (if sub-second needed)

## Alternatives considered

| Alternative | Why not chosen |
|---|---|
| OPA / Rego for rules | Policy-language flavor less natural for threshold/state-machine rules; smaller .NET ecosystem |
| Easy Rules (JVM) | JVM stack adds runtime to operate; .NET is the existing csa-inabox copilot stack |
| Custom rule DSL (YAML) | Reinvents Rete; loses NRules' battle-testing |
| Azure Stream Analytics only | Strong on continuous-time queries but weak on per-object state machines; doesn't natively express `andStays` semantics |
| Pure KQL (no NRules) | KQL can express most rule logic but state-tracking-across-runs needs external storage; NRules-over-KQL is cleaner separation |

## References

- PRD: [`temp/fiab-prd/05-workload-parity.md`](../../../temp/fiab-prd/05-workload-parity.md) §5.6, [`06-custom-apps.md`](../../../temp/fiab-prd/06-custom-apps.md) §6.3
- Research: [`temp/fiab-research/03-fabric-only-internals.md`](../../../temp/fiab-research/03-fabric-only-internals.md) §3
- External: [Microsoft Learn — Activator overview](https://learn.microsoft.com/fabric/real-time-intelligence/data-activator/activator-introduction), [NRules docs](https://github.com/NRules/NRules)
- Build: PRP-06 — `apps/fiab-activator-engine/`
