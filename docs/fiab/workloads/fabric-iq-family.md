# Fabric IQ family — v2 deferred

> **This workload group is deferred to CSA Loom v2.** Public
> information on Fabric IQ items (Ontology, Graph, Plan, Operations
> Agent, Maps) is too thin in 2026-Q2 to design honest parity
> against. v2 follows Build 2026 + the Q3-Q4 2026 wave of Microsoft
> material on these items.

## What Fabric does

Announced/GA at Ignite November 2025 + FabCon March 2026. The Fabric
IQ family extends Fabric beyond data-storage + compute into semantic
intelligence:

| Item | Purpose |
|---|---|
| **Ontology** | Semantic graph of business concepts that grounds agents in domain meaning (not just schemas) |
| **Plan** | Agent-orchestration recipes that compose Fabric items (lakehouses, semantic models, data agents) into multi-step workflows |
| **Graph / FabricGraph** | First-class graph data item — vertices + edges; for traversal-heavy analytics |
| **Operations Agent** | Agent class that takes action on Fabric resources (pipeline runs, semantic model refreshes, OAP toggles) — distinct from Data Agents which only retrieve |
| **Maps** | Geospatial first-class workload (COG / PMTiles support) |

Plus:
- **HorizonDB** (preview at FabCon 2026) — managed PostgreSQL-
  compatible service inside Fabric
- **Fabric Databases unified hub** — SQL DB, Cosmos DB, HorizonDB,
  external Azure databases all surfaced through one experience

## CSA Loom roadmap

### v1 — explicitly OUT

Per [ADR fiab-0001 Fabric feature scope](../adr/0001-fabric-feature-scope.md),
Fabric IQ items are out of v1 scope.

### v1.1 — Operations Agent

The Operations Agent — taking action on Loom resources via Copilot —
ships in v1.1 (PRP-107). Extension of Loom Copilot with write-tools
(capacity scale, workspace create, OAP toggle, pipeline trigger).

### v2 — full Fabric IQ family parity

Pre-emptive sketches (will be refined as Microsoft publishes more
architectural detail):

| Item | v2 sketch |
|---|---|
| Ontology | Cosmos DB store of business concepts + Azure AI Search vector index for semantic similarity. Loom Data Agents grounds on this when generating queries |
| Plan | JSON-defined orchestration recipes executed by a Container App / AKS workload; calls Loom Console REST APIs in sequence |
| Graph | Azure Cosmos DB for Apache Gremlin (graph API); OR Apache TinkerPop on AKS. Console pane for graph queries |
| Operations Agent | Already in v1.1 — extends Loom Copilot with write-tools |
| Maps | Azure Maps in Commercial (when authorized); Mapbox or open-source PMTiles in Gov (Azure Maps not in Gov per `research/02-gov-boundary-availability.md §1`) |
| HorizonDB-equivalent | Azure Database for PostgreSQL Flexible Server with auto-mirror to lakehouse |

## Per-boundary outlook

| Boundary | v2 IQ family availability |
|---|---|
| Commercial / GCC | Full target |
| GCC-High / IL4 | Most items deliverable; Azure Maps replaced by open alternatives |
| IL5 (v1.1) | Operations Agent only in v1.1; rest in v2 |

## Honest gaps

- **Microsoft architectural detail is thin** as of 2026-Q2 — public
  blog posts describe what these items DO; internal architecture
  (graph storage, ontology format, plan execution semantics) isn't
  published. Loom v2 design will firm up as material lands.
- **Forward-migration mapping** for Fabric IQ items isn't yet
  defined — Loom v2 ships migration tooling once the formats stabilize

## Forward migration (v2)

When Fabric IQ family reaches Gov GA, migrate via JSON export/import
of ontology + plan definitions; graph data via documented graph-
migration format.

## Tracking

- Build 2026 (June 2-3) — freshness rescan scheduled for week of
  June 8
- FabCon 2026 follow-up announcements — quarterly rescan
- Q3-Q4 2026 Microsoft material — primary input for v2 design

## Related

- ADR: [fiab-0001 Fabric feature scope](../adr/0001-fabric-feature-scope.md)
  (documents v1 OUT)
- Build PRPs (v2): PRP-201, PRP-202, PRP-203
- Research: [`temp/fiab-research/01-fabric-capability-surface.md` §21](../../../temp/fiab-research/01-fabric-capability-surface.md) — Item type enumeration
