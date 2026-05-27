# Loom GQL Graph Editor — Fabric-parity spec

> Captured 2026-05-26 by catalog agent. Sources: Microsoft Learn — [GQL language guide for graph in Microsoft Fabric](https://learn.microsoft.com/fabric/graph/gql-language-guide), [GQL quick reference](https://learn.microsoft.com/fabric/graph/gql-reference-abridged), [GQL query performance](https://learn.microsoft.com/fabric/graph/gql-query-performance), [GQL Query API reference](https://learn.microsoft.com/fabric/graph/gql-query-api), [How graph in Microsoft Fabric works](https://learn.microsoft.com/fabric/graph/how-graph-works), [Graph Query Language (preview) — Kusto](https://learn.microsoft.com/kusto/query/graph-query-language?view=microsoft-fabric), [GQL reference](https://learn.microsoft.com/kusto/query/graph-query-language-reference?view=microsoft-fabric). Cross-checked against current Loom editor at `apps/fiab-console/lib/editors/graph-editors.tsx::GqlGraphEditor`.

## What it is

**GQL (Graph Query Language)** is the ISO-standardized graph query language — ISO/IEC 39075:2024, developed by the same working group that standardizes SQL. **Microsoft Fabric Graph** is the first Microsoft service to expose a native GQL endpoint (currently public preview), reachable via:

```
POST https://api.fabric.microsoft.com/v1/workspaces/{workspaceId}/GraphModels/{GraphModelId}/executeQuery?preview=true
```

GQL is also available in **Azure Data Explorer / Eventhouse** as a preview alternative dialect to KQL graph operators. The GQL surface in Fabric provides three execution paths: **GQL** (direct), **NL2GQL** (natural-language translated to GQL, surfaced via Fabric Data Agent), and **REST** (programmatic). A typical query looks like:

```gql
MATCH (n:Person)-[:knows]->(m:Person)
LET fullName = n.firstName || ' ' || n.lastName
FILTER m.gender = 'female'
ORDER BY fullName ASC
OFFSET 10
LIMIT 5
RETURN fullName, m.firstName
```

GQL is **public preview** as of 2026-Q2 — no SLA, syntax can change. Statement composition is currently linear (basic chaining of `MATCH`, `LET`, `FILTER`, `ORDER BY`, `OFFSET`, `LIMIT`, `RETURN`); set operations (`UNION DISTINCT`, `EXCEPT`, `INTERSECT`, `OTHERWISE`) are not yet supported.

## UI components

### Page chrome
- Title bar: GraphModel name + saved-state indicator + **Preview** badge
- Top toolbar: **Run**, **Save Query**, **Load Query**, **Cancel**, **Explain**, **Format**, **NL2GQL** (preview)

### Left pane — Graph model explorer
- Tree of `workspace → GraphModel → labels (node + edge)` returned by the Fabric Catalog Search API
- Per-label actions: **Preview 10 nodes**, **Show properties**, **Insert MATCH stub**
- **Sample datasets** branch with the documented Microsoft samples (social network graph, Adventure Works graph) so authors can test against known data

### Query editor (top main)
- Monaco-based GQL editor with ISO/IEC 39075 syntax highlighting (`MATCH`, `LET`, `FILTER`, `ORDER BY`, `OFFSET`, `LIMIT`, `RETURN`, label expressions `:Person&Company`, edge patterns `-[:knows]->`, path patterns `()-[:knows]->{1,3}()`)
- Auto-complete for labels + property names discovered from the graph model schema
- Inline lint: warns when filters are placed in a later `FILTER` statement instead of inside `MATCH ... WHERE` (the documented #1 performance pattern in [GQL query performance](https://learn.microsoft.com/fabric/graph/gql-query-performance))
- **Run** + **Cancel**
- **Explain** — surfaces the query plan returned by the Fabric Graph REST API
- **Format** — pretty-prints per GQL canonical style

### NL2GQL (preview) drawer
- Natural-language prompt input ("Show me everyone Alice knows two hops out who works at a company in Seattle")
- Calls Fabric Data Agent under the hood; the Data Agent invokes the NL2GQL planner and shows the generated GQL in the editor for user review before run
- Toggle: **Run as authored** vs **Run as planned**

### Results pane (bottom main) — three tabs
- **Visual graph** — interactive node/edge visualization for `RETURN` clauses that project NODE / EDGE / PATH types (per [GQL Query API value types](https://learn.microsoft.com/fabric/graph/gql-query-api))
- **Table** — flattened columns with proper GQL-type rendering (`STRING`, `INT64`, `ZONED DATETIME`, `LIST<...>`, `PATH`)
- **JSON** — raw `executeQuery` response

### Per-query metrics
- Rows returned, server-side execution time, hard limits reminder (graph size, result size, query timeout per [GQL current limitations](https://learn.microsoft.com/fabric/graph/limitations))

### Saved querysets
- Persistent named queries against this GraphModel
- "Share as read-only queryset" — parity with Fabric's queryset sharing primitive

## What Loom has

The current `GqlGraphEditor` (`apps/fiab-console/lib/editors/graph-editors.tsx`, lines 191-213) is honestly stubbed:

- Plain `<textarea>` seeded with a 3-line GQL `MATCH (p1:Person {name:'Alice'})-[:KNOWS]->(p2:Person) RETURN ... LIMIT 25` sample
- A `MessageBar intent="warning"` titled **"GQL compiler deferred"** stating *"No GA Azure backend speaks GQL natively today. v3.x will add a parser → KQL/Gremlin compiler. For now the editor persists the query into item state."* — the "no GA backend" wording is accurate (Fabric Graph is preview, ADX GQL is preview)
- No **Run** button (intentional: there is no wired backend)
- Persists the query string into Cosmos item state
- Ribbon advertises a **Run** action but it does nothing
- Grade: **D (stubbed)** — honest gate + persistence work, no backend wired

## Gaps for parity

1. **No backend wired** — even though Fabric Graph has a documented REST API (`POST .../GraphModels/{id}/executeQuery`), Loom does not call it. The MessageBar admits this honestly but the **Run** ribbon button is vaporware until removed or wired.
2. **No graph-model picker** — Fabric Graph requires `{workspaceId}` + `{GraphModelId}`. Loom has no surface to resolve these from the signed-in user's workspaces.
3. **Monaco editor + GQL highlighting absent** — plain textarea.
4. **No visual graph tab** — same gap as cosmos-gremlin and cypher-graph editors.
5. **No table tab with typed columns** — GQL has rich value types (NODE, EDGE, PATH, ZONED DATETIME, LIST<...>) that need proper rendering.
6. **No graph-model schema explorer** — no labels tree, no property listing, no "Insert MATCH stub".
7. **NL2GQL drawer absent** — the documented natural-language path via Fabric Data Agent is not surfaced.
8. **Explain plan absent** — Fabric REST API does not document a separate explain endpoint, but the `executeQuery` response includes plan-style hints when `preview` is enabled.
9. **Filter-position lint absent** — the #1 documented performance pattern (filter inside MATCH ... WHERE, not as a separate FILTER) should be a one-line inline warning.
10. **Saved querysets absent** — Fabric ships querysets as a first-class shareable primitive; Loom does not.
11. **No limits surface** — graph-size / result-size / query-timeout hard limits aren't shown in the editor.
12. **Preview-honesty MessageBar** — the editor SHOULD keep a `Badge "Preview"` plus a MessageBar pointing at [GQL current limitations](https://learn.microsoft.com/fabric/graph/limitations) even after the backend is wired.

## Backend mapping

| Loom surface | Backing service | Notes |
|---|---|---|
| GQL query execution (Fabric Graph) | **Fabric Graph REST** `POST https://api.fabric.microsoft.com/v1/workspaces/{ws}/GraphModels/{id}/executeQuery?preview=true` body `{"query": "MATCH ... RETURN ..."}` | New BFF route `/api/items/gql-graph/[id]/query` that wraps this; signed-in user delegated token (Fabric REST is user-identity scoped) |
| GQL query execution (ADX preview alternative) | Existing `/api/items/kql-database/[id]/query` route — ADX accepts GQL in preview with the right cluster setting | Reuse existing kusto-client |
| Graph-model discovery | `GET /v1/workspaces/{ws}/GraphModels` Fabric REST → list of `{id, displayName}` | Drives the left-pane picker |
| Label / property schema | Fabric Graph REST does not yet document a `/schema` endpoint; workaround is a sentinel `MATCH (n) RETURN DISTINCT labels(n), keys(n) LIMIT 100` query | Cache result per session |
| NL2GQL | Existing Loom Fabric Data Agent surface (`data-agent` editor) — add a Graph data source to the agent and call `threads.messages.create` → planner returns GQL | No new backend; reuses the AOAI Assistants integration |
| Saved querysets | Cosmos `items` container, partition `gql-graph-queryset` | Fabric's own queryset item is preview; Loom mirrors the shape |
| Visual graph viz | Client-side vis-network or Cytoscape over the JSON result shape; NODE / EDGE / PATH values map naturally to vertices + edges | No backend |
| Auth | Delegated user token via `Bearer <token>` against `api.fabric.microsoft.com` scope `https://api.fabric.microsoft.com/.default` | Already wired in `lib/azure/fabric-client.ts` |

## Required Azure resources

- **Fabric capacity** (F2 minimum; F64+ recommended) with the **Graph in Fabric** preview tenant setting enabled
- **At least one GraphModel item** created in a Fabric workspace (the Loom data-product-template's RAG / mesh / knowledge-graph variants would spawn one)
- **AAD app registration** with delegated `Fabric.Read.All` + `Fabric.ReadWrite.All` (or appropriate `Workspace.ReadWrite` scope) — already present in `bicep/identity.bicep`
- **No tenant-level admin step** beyond the Graph-in-Fabric preview toggle
- **For ADX-GQL preview path**: an Eventhouse-backed KQL DB (already deployed by Loom) with the GQL preview feature flag enabled at the cluster

## Estimated effort

- **Session N+1 (~3 hrs)** — wire the Fabric REST `executeQuery` route + workspace/graph-model picker in the left pane + remove the vaporware Run ribbon stub
- **Session N+2 (~3 hrs)** — Monaco editor with GQL highlighting (ANTLR grammar from the ISO spec or a hand-written tokenizer for the documented statement set) + filter-position lint + Format
- **Session N+3 (~3 hrs)** — Visual graph tab + typed Table tab (rendering NODE / EDGE / PATH / ZONED DATETIME / LIST<...> properly per the documented value-types table)
- **Session N+4 (~3 hrs)** — NL2GQL drawer wiring through the Loom Data Agent surface (re-uses existing Assistants integration) + saved querysets
- **Session N+5 (~1 hr)** — Vitest + Playwright covering the preview MessageBar, the Fabric REST happy path, and the limits-exceeded error path

Total: **~13 hrs** across 5 sessions. Current grade: **D**. Target: **A** while GQL stays in preview (A+ deferred to GA since Microsoft has not yet finalized statement composition + set operations).
