# Loom Ontology Editor — Fabric-parity spec

> Captured 2026-05-26 by catalog agent. Fabric Ontology (preview, Fabric IQ workload) = enterprise semantic layer of entity types, properties, relationships, and data bindings to OneLake sources. Both the Fabric item and most of its surfaces are public preview as of 2026-Q2.

## UI components

### Top ribbon
- **Add entity type** — primary action on the canvas
- **View entity type details** — opens the per-entity Configure page
- **Save** · **Refresh** · **Settings**
- Activator integration entry-point (Rules surface; surfaces detail not fully documented in preview)

### Configuration canvas (Home)
- Visual canvas of entity types as cards
- Per-entity `…` menu: **Bind data**, **View details**, **Delete**, rename
- Center-of-canvas empty-state CTA: **Add entity type**
- Relationship type connectors between entity cards (typed, directional, cardinality-aware)
- Graph item rendered alongside (Fabric auto-creates a managed Graph item when an ontology is created)

### Explorer pane (left)
- Tree of entity types + relationship types
- Per-node selection drives the right-rail Configure page

### Configure page (per entity type)
- **Properties** pane — list of properties with declared data type, source-column binding, identifier flag, display-name property selector
- **Manage property bindings** → **Add binding and properties** wizard
  - Source picker: **Lakehouse table** · **Eventhouse table or materialized view** · **Semantic model** · **Warehouse**
  - OneLake catalog table picker
  - **Entity type key mapping** (string/int columns, single or compound key)
  - **Properties** mapping table (source column ↔ property name; rename / delete / add)
  - **Timeseries data** section (timestamp column, when binding an Eventhouse source)
- **Define entity type key** action
- **Display name property** dropdown
- Static vs time-series binding split

### Relationship type designer
- **Add relationship type** — directional, typed, label-named (`owns`, `placedBy`, `locatedAt`, etc.)
- Attributes on relationships (`distance`, `confidence`, `effectiveAt`)
- Cardinality rules (1:1, 1:*, *:*)
- Relationship source-data binding (OneLake table containing both endpoint keys)

### Entity type details (read mode)
- Basic data preview of bound instances
- Instance grid (sortable, filterable)
- Graph view of related instances (embedded Graph item)

### Ontology query surface
- **NL2Ontology** — natural language → structured query
- Federated query layer that compiles down to **GQL** (Graph item), **KQL** (Eventhouse), or **SQL** (Lakehouse / Warehouse) under the hood
- Result preview pane

### Activator rules (embedded)
- Per-entity rule editor (condition → action)
- Powered by Fabric Activator
- Triggers: Teams alert, Power Automate flow, Fabric job

### Generate-from-semantic-model wizard
- Auto-creates entity types from semantic-model tables
- Auto-creates static bindings + relationships
- Manual follow-up: time-series bindings, multi-key entity keys, relationship bindings

## What Loom has

- `OntologyEditor` in `apps/fiab-console/lib/editors/phase4-editors.tsx` (lines 638-675)
- Cosmos persistence of `state.source` (a free-text source blob)
- Lightweight `parseOntologyHierarchy` regex parser that splits lines like `Customer: Party -- "..."` into class records
- Class hierarchy preview as a Fluent UI `Tree` (read-only)
- MessageBar discloses "v2.1: configuration only" — no data binding, no Graph item, no Activator
- Grade: **D (Stubbed)** — author surface + persistence work, no real ontology engine wired

## Gaps for parity

1. **No entity-type cards canvas** — only a textarea + tree preview
2. **No data binding wizard** — Fabric's whole point is binding entity types to OneLake tables; Loom has zero binding UI
3. **No relationship-type designer** — relationships exist in source text only, not as first-class typed objects
4. **No managed Graph item co-creation** — Fabric auto-spawns a Graph item; Loom does not
5. **No entity instance preview** — cannot view bound rows
6. **No NL2Ontology / federated query surface** — natural-language → GQL/KQL/SQL compilation absent
7. **No Activator rule editor** — condition-action rules cannot be authored
8. **No "generate from semantic model"** — cannot bootstrap an ontology from an existing PBI semantic model
9. **No time-series binding** for Eventhouse-backed entity properties
10. **No display-name property** selector, no entity-type-key mapping

## Backend mapping

- **Persistence**: today Cosmos doc only; parity needs a Fabric IQ ontology item via the **Fabric REST API** (`/v1/workspaces/{ws}/items` with `type: "Ontology"`) once it leaves preview and gains REST surface
- **Data binding catalog**: OneLake `_metadata` + Lakehouse/Warehouse/Eventhouse listing via the existing Fabric SDK proxy
- **Graph co-creation**: also via Fabric REST (Graph item type) — see `graph-model-parity-spec.md`
- **Activator rules**: Activator REST (preview)
- **NL2Ontology**: requires Fabric IQ runtime (no public REST surface as of 2026-Q2); Loom can't reproduce this client-side. Honest gate: MessageBar warning that NL queries require Fabric IQ capacity
- **Federated query execution**: Loom would need to compile against Graph (GQL), Eventhouse (KQL via existing `/api/eventhouse/query`), and Lakehouse (TDS via SQL endpoint) on its own

## Required Azure resources

- Fabric capacity with **Ontology item (preview)** tenant setting enabled
- OneLake-attached storage (already present in FiaB)
- For NL2Ontology: an OpenAI / Foundry model deployment (Loom's existing Foundry Agent Service)
- For Activator-style rules without Fabric: Logic App or Function with Event Grid trigger

## Estimated effort

**6-8 sessions.** The data-binding wizard alone is 2 sessions (OneLake browser + key mapping + property table). Relationship designer is 1. Embedded Graph view + co-creation is 2 (and depends on graph-model parity work). NL2Ontology is gated behind Fabric IQ availability — best path is a MessageBar honest gate plus a local Foundry-backed natural-language → JSONPath query layer that operates on Cosmos-resident ontology state for MVP. Activator rule editor is 1 session if we reuse the Activator REST work from `data-activator-parity-spec.md`.

**Preview honesty**: Ontology is preview as of 2026-Q2. Some ribbon details (Activator surface within ontology, exact NL2Ontology UI) aren't fully documented on Microsoft Learn. Where the spec says "surfaces detail not fully documented", we capture the documented behavior only and gate the rest behind preview MessageBars.
