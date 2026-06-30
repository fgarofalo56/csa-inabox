# ontology — parity with Palantir Foundry Ontology

**Category:** Fabric IQ · **Loom slug:** `ontology` · **Editor:** `OntologyEditor` in
`apps/fiab-console/lib/editors/phase4-editors.tsx` (registry → `phase4-editors`).
**Backend (default, Azure-native, NO Fabric):** Cosmos (item state / model
persistence), Apache AGE on Azure Database for PostgreSQL Flexible Server
(object + link instances, write-back actions), Synapse dedicated/serverless SQL
+ ADLS Gen2 Delta (backing datasources / column introspection), Azure Monitor
scheduled-query alerts (Activator triggers), Data API Builder over ACA (OSDK).

Source UI: Palantir Foundry **Ontology Manager**
- https://www.palantir.com/docs/foundry/ontology-manager/overview
- Object & link types: https://www.palantir.com/docs/foundry/object-link-types/object-types-overview
- Property base types: https://www.palantir.com/docs/foundry/object-link-types/base-types
- Link types: https://www.palantir.com/docs/foundry/object-link-types/link-types-overview
- Action types: https://www.palantir.com/docs/foundry/action-types/overview
- Shared properties: https://www.palantir.com/docs/foundry/object-link-types/shared-property-overview
- Interfaces: https://www.palantir.com/docs/foundry/interfaces/interface-overview
- Structs / Time series / Geospatial: structs-overview, time-series-setup, geospatial/ontology

> Note: this surface is also positioned against Microsoft Fabric IQ Ontology /
> digital-twin semantic canvas, but the *feature-complete* real-world equivalent
> is Palantir Foundry Ontology — used here as the parity bar. All parity is met
> with Azure-native + OSS backends; a real Fabric/Foundry tenant is never required.

---

## Real feature inventory (Palantir Foundry Ontology Manager)

Top-level workbench tabs: **Object types · Link types · Action types · Shared
properties · Interfaces · Functions · Datasources · Proposals (branches/review)**.

### A. Object types
Each object type opens an editor with:
1. **Datasources / backing datasets** — one or more backing datasets (a table /
   RID) supply the object's instances; an optional separate *edits-only*
   datasource; per-property datasource mapping.
2. **Properties** — list of typed properties; each has API name, display name,
   base type, description, visibility (prominent / normal / hidden), value
   formatting + conditional formatting, renderer hints, typeclasses, edit-only flag.
3. **Primary key** — the identifier property.
4. **Title key** — property used as the object's display title.
5. **Display metadata** — display name (singular/plural), description, **icon**,
   **color**, **type groups**.
6. **Status** — Active / Experimental / Deprecated (lifecycle badge).
7. **Visibility** — Prominent / Normal / Hidden.
8. **Object views** — configurable tabs/widgets that render a single object
   instance (overview, properties, linked objects, charts, map, timeseries).
9. **Security / granular permissions** — type-level + property-level + row-level
   (restricted views, mandatory markings) controls on who can read/edit.
10. **Derived properties** — computed from linked objects or a function (e.g.
    rollups / aggregations), not stored on the backing dataset.

### B. Property base types (the type system)
string, boolean, byte, short, integer, long, float, double, decimal, date,
timestamp, **array** (of any base type), **struct**, **geopoint / geohash**,
**geoshape**, **timeseries**, **attachment**, **media reference**, **marking**,
**vector/embedding**, **cipher text**. (Array of any except Vector/Time series.)

### C. Link types
Named relationship between two object types: cardinality **one-to-one /
one-to-many / many-to-many**; from/to object types; display name per direction;
**backing datasource** (a foreign-key column on an object datasource, or a
separate join/mapping dataset for many-to-many); metadata/description.

### D. Action types (the write-back surface)
1. **Rules / logic** — create object, modify object, delete object, create link,
   delete link, and batched combinations.
2. **Typed parameters** — each parameter has a type (string, boolean, number,
   date, timestamp, **object reference**, attachment, multi-select, struct,
   geohash), a prompt, default value, required/optional.
3. **Parameter validation** — allowed-values lists, range/regex checks,
   conditional visibility, conditional requiredness, cross-parameter rules.
4. **Submission criteria / conditions** — gate whether the action can run.
5. **Form layout** — ordered sections/fields the operator fills in.
6. **Function-backed validation + side effects** (Functions on Objects).
7. **Security** — which groups may submit; **Ontology edits history / audit log**.

### E. Shared properties
Define a property (type + metadata) once and reuse across object types for
consistency; the building block interfaces are declared against.

### F. Interfaces
Abstract types declaring **property constraints + link constraints + action
constraints**; object types **implement** interfaces → polymorphic apps/SDK.

### G. Cross-cutting
Ontology **proposals / branches** (Git-like staged change + review), object
**search/indexing**, **Functions** (TS/Python on objects), and **OSDK**
generation.

---

## Loom coverage (current state — honest)

| Real capability | Loom today | Status |
|---|---|---|
| Object types | A freeform Monaco textarea DSL: `Name : Parent -- desc`. Classes have only an implicit id + description. **No properties, no types.** | ❌ partial (freeform — violates `loom_no_freeform_config`) |
| Property type system | None. Object instances take a freeform JSON props textarea. | ❌ MISSING (+freeform violation) |
| Primary key / title key | None. | ❌ MISSING |
| Display metadata (icon/color/status/groups/visibility) | None (only a class name + optional description). | ❌ MISSING |
| Link types (named, cardinality, from/to, backing FK) | Only **IS_A** inheritance via `Child : Parent`. No named links, no cardinality. | ❌ MISSING |
| Action types | Declared with name + objectType + kind (create/update/delete); **params are a `string[]` of names — untyped, no validation, no defaults, no prompts, no form**. | ⚠️ thin partial |
| Backing datasources | "Bind to data source" maps a **whole** Lakehouse/Warehouse item to entity types (Cosmos). No table pick, **no column→property mapping**, no PK column. | ⚠️ thin partial |
| Object instances (write-back) | Real Apache AGE vertices via `/objects`; create form is a **freeform JSON textarea**. | ⚠️ real backend, freeform UI |
| Link instances | Route exists (`/links`, AGE edges) but **no UI** in the editor. | ⚠️ backend only |
| Shared properties | None. | ❌ MISSING |
| Interfaces | None. | ❌ MISSING |
| Object views | None. | ❌ MISSING |
| Security / granular permissions | None. | ❌ MISSING |
| Derived properties | None. | ❌ MISSING |
| Activator triggers | Real Azure Monitor scheduled-query alert per entity change. | ✅ (Loom extra) |
| Materialize → graph-model (ADX) | Real — emits a graph-model item, ADX-materializable. | ✅ (Loom extra) |
| OSDK | Separate `ontology-sdk` editor (DAB). | ✅ adjacent |

**Verdict:** the editor is a thin "class hierarchy" DSL + AGE instance scratchpad
with two freeform textareas. It models **none** of the Foundry pillars —
typed properties, named link types, typed action parameters, shared properties,
interfaces, object views, security, derived properties. Two `loom_no_freeform_config`
BLOCKING violations (the DSL source textarea and the JSON props textareas).

---

## Build plan (prioritized)

### P0 — core model (removes both freeform violations; the spine of parity)
1. **Object Type designer** — replace the DSL textarea with a structured
   left-rail list of object types + a detail panel: display name (singular/plural),
   description, **icon picker**, **color**, **status** (Active/Experimental/
   Deprecated `Badge`), **groups**, primary key + title key selectors. Persist to
   `state.objectTypes[]` (Cosmos via existing PATCH route). `TileGrid` for the
   type gallery, `EmptyState` for the empty rail.
2. **Property type system** — per object type, a properties `Table` with an
   **Add property** dialog: API name, display name, **base-type `Dropdown`**
   (string/boolean/integer/long/float/double/decimal/date/timestamp/array/struct/
   geopoint/geoshape/timeseries/attachment/media/marking/vector/cipher),
   array-of toggle, visibility, edit-only, PK/title flags. Persist to
   `state.objectTypes[].properties[]`. No freeform JSON — all controls.
3. **Link Type designer** — named link types with **cardinality** (1:1 / 1:many /
   many:many `RadioGroup`), from/to object-type `Dropdown`s, per-direction display
   name, **backing datasource** (FK column on an object datasource, or a join
   table for many:many). Persist `state.linkTypes[]`; render an ER overview.
4. **Action Type builder with typed parameters** — replace `params: string[]`
   with `parameters[]` each `{ apiName, type, required, default, prompt,
   allowedValues?, validation? }`; rule = create/modify/delete object + create/
   delete link. **Run form derives typed controls from the parameter schema**
   (object-reference → instance picker, date → DatePicker, enum → Dropdown) —
   eliminating the JSON props textarea. Validate server-side in `/run-action`.
5. **Backing datasource → column→property mapping** — replace whole-item bind
   with: pick Lakehouse table (existing lakehouse Tables route) or Warehouse table
   (Synapse `INFORMATION_SCHEMA.COLUMNS` introspection via `synapse-sql-client`),
   then a column→property mapping grid + PK column selector. Persist on the
   object type's datasource.

### P1 — completeness
6. **Shared Properties library** — a workbench tab to define reusable typed
   properties; object types reference them; persist `state.sharedProperties[]`.
7. **Interfaces** — abstract types with property/link/action constraints; object
   types declare `implements[]`; enforce constraints at action runtime. Persist
   `state.interfaces[]`.
8. **Object views + instance viewer** — configurable per-type view (overview /
   properties / linked objects / timeseries / map widgets) persisted as JSON; an
   instance detail page that renders it from real AGE data.
9. **Security / granular permissions** — Entra-group ACL on object type +
   property-level + row-level, enforced at `/objects` and `/run-action` (reuse the
   EH Phase-1 PDP/RLS pattern). Honest gate if group resolution unavailable.
10. **Derived properties** — computed-property definitions (rollup over a link, or
    a SQL expression) evaluated via `synapse-sql-client` / AGE cypher; surfaced
    read-only in the instance grid.
11. **Link-instance UI** — wire the existing `/links` AGE route into the editor
    (connect two instances via a typed link type).

### P2 — advanced parity
12. **Ontology proposals / branches** — staged model changes + review/approve
    before publish (Cosmos versioned drafts).
13. **Object search / index** — Azure AI Search index over AGE instances for
    full-text + filter; vector property → vector search.
14. **Geospatial + timeseries rendering** — Azure Maps for geopoint/geoshape
    object views; ADX for timeseries property charts.
15. **Functions on objects** — validation + side-effect functions on ACA / Azure
    Functions, referenced from action validation and derived properties.
16. **ER diagram canvas** — object-types + link-types as a drag-drop diagram via
    the shared `canvas-node-kit` (replaces the small force-directed viz).

### Backend summary (all Azure-native, Fabric opt-in only)
Model persistence → **Cosmos** (item `state`). Instances/links/actions →
**Apache AGE on PostgreSQL Flex** (`weave-ontology-store`). Datasource
introspection → **Synapse SQL** (`INFORMATION_SCHEMA`) + **ADLS Delta** lakehouse
tables. Triggers → **Azure Monitor**. Search/vector → **Azure AI Search**.
Geospatial → **Azure Maps**. Timeseries → **ADX**. Functions → **ACA / Azure
Functions**. SDK → **Data API Builder**. Graph materialize → **ADX**.
