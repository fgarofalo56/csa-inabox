# fiab-0012: Forward migration — OneLake shortcut + hybrid topology first-class

**Status:** Accepted
**Date:** 2026-05-22
**Locked decision ref:** LD-13

## Context

The strategic justification for CSA Loom is "head-start, not detour."
Federal customers adopt Loom because Fabric isn't available in their
boundary today; when Fabric reaches their boundary (whether that's
2027, 2028, or later), they expect a clean forward-migration path.

Without a forward-migration story, Loom looks like a permanent
investment in a non-Fabric platform — which contradicts the
csa-inabox parent project's ADR-0010 ("Fabric is the strategic
target"). Customers will be hesitant to commit Bronze/Silver/Gold
production workloads to a platform they can't migrate forward.

Per `temp/fiab-research/03-fabric-only-internals.md`:
- **OneLake is ADLS Gen2 underneath** with a unified namespace via a
  Microsoft-managed gateway; OneLake shortcuts are first-class
  filesystem mounts that resolve to any ADLS Gen2 path
- Most Loom artifacts (Delta tables, dbt models, KQL queries,
  notebooks) are already in formats Fabric understands directly
- Some Loom artifacts (Activator rules JSON, Data Agent configs,
  TMDL semantic models) port via REST API export/import

## Decision

**Three commitments:**

### 1. Bidirectional migration documented + tooled

Both Loom → Fabric and Fabric → Loom are first-class documented
patterns:

- **Loom → Fabric** (forward) — when Fabric reaches your boundary;
  the strategic move
- **Fabric → Loom** (reverse) — for customers who piloted in Fabric
  Commercial then needed to move workload into Gov; documented but
  rarer

`fiab-migrate` CLI ships in v1.1 (PRP-104) to automate the forward-
migration:
- `fiab-migrate snapshot` — capture current Loom estate to portable
  JSON bundle
- `fiab-migrate plan` — reads snapshot + target Fabric capacity;
  produces migration plan flagging Direct / Manual / Skip per item
- `fiab-migrate execute` — runs the plan against Fabric REST APIs
- `fiab-migrate verify` — diff results across Loom + Fabric

### 2. OneLake shortcut as the data-movement bridge

For Delta tables (the largest data volume customers carry), forward
migration is **zero data movement**:

1. Create OneLake shortcut from a Fabric workspace pointing at the
   existing Loom ADLS Gen2 lakehouse path
2. Data is queryable from Fabric immediately
3. Customer optionally promotes data into OneLake native paths later
   via copy (incremental, customer-paced)

Per-component effort:

| Loom artifact | Migration mechanism | Effort |
|---|---|---|
| Delta tables | OneLake shortcut | **Zero data movement** |
| dbt models | dbt-fabric adapter; change connection string | **Low** |
| Databricks notebooks | Git folder port; runtime swap | Medium |
| TMDL semantic models | Re-author for Direct Lake on OneLake storage mode | Medium |
| ADX databases / KQL queries | ADX databases attach as Fabric Eventhouse via documented procedure; queries unchanged | **Low — same engine** |
| Power BI semantic models | Already in Power BI Premium; rebind to OneLake shortcut | Low |
| Activator rule JSON | Export from Loom Activator → import via Reflex definition REST API | Low-Medium |
| Mirroring configs | Per-source case-by-case (Fabric Mirroring GA for some sources; keep Loom Mirroring for others) | Variable |
| Data Agents | Export agent config JSON → Fabric Data Agents REST API | Low |
| Purview catalog | **Same engine** — Fabric items auto-register into existing Purview | **Zero** |

### 3. Hybrid topology as first-class architecture pattern

The most realistic federal customer pattern is **Fabric (Commercial)
+ Loom (Gov) running side-by-side indefinitely**:

- Commercial tenant runs Fabric for public datasets, cross-agency
  analytics, exec Power BI dashboards
- Gov tenant runs Loom for CUI / classified mission data, agency-
  internal analytics, ITAR-eligible GCC-High workloads
- Cross-cloud B2B invitations bridge identity
- APIM Premium in each cloud brokers controlled cross-cloud API calls

This pattern lets customers move at their own audit-review cadence
rather than a forced cutover. Documented in
[`docs/fiab/use-cases/hybrid-topology.md`](../use-cases/hybrid-topology.md).

## Consequences

### Positive

- Customers can commit production workloads to Loom knowing they're
  not trapped — every workload has a documented forward path
- OneLake shortcut means **no data-movement cost** at migration time
  for the largest data volume (Delta tables)
- Most artifact types port 1:1 (dbt, KQL, Purview) — only TMDL +
  notebooks + rules require re-author/runtime-swap effort
- Hybrid topology is a stable end-state, not just a transition
  pattern — many federal customers will run hybrid for years

### Negative

- Some Fabric-only artifacts (Direct Lake sub-second freshness,
  Fabric IQ Ontology / Plan / Graph) **don't reverse-map back** —
  Fabric → Loom migration has more friction than forward
- `fiab-migrate` CLI ships in v1.1, not v1 — v1 forward-migration is
  manual per the runbook
- Customer must commit to the discipline of authoring TMDL in Git,
  rules in Git, agent configs in Git — so migration tooling can
  read them from a single source of truth
- Some Loom-specific extensions (rules using Loom-only NRules
  primitives that Reflex doesn't support) won't port; customers must
  re-author

### Neutral

- Forward-migration is a quarterly check-in topic with Microsoft
  Fabric product team (when does Fabric Gov reach our customer's
  boundary?)
- Customers should treat Loom + Fabric as a continuum, not as a
  decision-point

## Alternatives considered

| Alternative | Why not chosen |
|---|---|
| Forward-only (Loom → Fabric; no reverse) | Misses Fabric Commercial pilot → Loom Gov scenarios (real but rarer) |
| Hybrid only (no forward migration tooling) | Customer is blocked when Fabric Gov GA arrives and they need to migrate |
| Custom Loom-specific format for everything | Maximum lock-in; defeats the strategic positioning |
| Bidirectional sync (live mirroring Fabric ↔ Loom) | Engineering cost extreme; semantic conflict resolution unsolved; not a real customer ask |

## References

- PRD: [`temp/fiab-prd/09-forward-migration.md`](https://github.com/fgarofalo56/csa-inabox/blob/csa-loom-pillar/temp/fiab-prd/09-forward-migration.md)
- Amendments: [`temp/fiab-prd/AMENDMENTS.md`](https://github.com/fgarofalo56/csa-inabox/blob/csa-loom-pillar/temp/fiab-prd/AMENDMENTS.md) §A14
- Parent ADR: [`docs/adr/0010-fabric-strategic-target.md`](../../adr/0010-fabric-strategic-target.md) — Loom refines for the Gov-interim case
- Build: PRP-104 — `platform/fiab-migrate/` (v1.1)
