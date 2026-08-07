# digital-twin — parity with Azure Digital Twins Explorer (Loom: ADX-native)

**Source UI:** Azure Digital Twins Explorer
<https://learn.microsoft.com/azure/digital-twins/how-to-use-azure-digital-twins-explorer>
Supporting: <https://learn.microsoft.com/azure/digital-twins/concepts-azure-digital-twins-explorer>
· <https://learn.microsoft.com/azure/digital-twins/how-to-manage-graph>
· <https://learn.microsoft.com/azure/digital-twins/concepts-apis-sdks> (Import/Delete Jobs — API-only)

Secondary reference: Microsoft Fabric RTI **Digital Twin Builder** (the item type
this is Loom's parity for, per the surface's own docstring).

**Surface file:** `apps/fiab-console/lib/editors/digital-twin-builder-editor.tsx` (1,077 lines)
**Model:** `apps/fiab-console/lib/editors/digital-twin-model.ts`
**Route:** `/items/digital-twin/[id]` · FGC-12 · Tagged **Preview**.

## Scoping note — the architectures genuinely differ

Per `no-fabric-dependency.md`, Loom's default backend is **Azure Data Explorer**,
not Azure Digital Twins and not Fabric RTI. ADT is a **strictly opt-in alternate**
behind `LOOM_ADT_ENDPOINT` — correct posture, and the editor ships a dedicated
**Azure Digital Twins** tab for it.

That makes this a comparison across two different technology stacks:

| | ADT Explorer | Loom `digital-twin` |
|---|---|---|
| Model language | **DTDL v2/v3** (`dtmi:` identifiers, inheritance, components) | Loom entity + relationship types on a canvas |
| Twin store | ADT instance | **ADX** tables (`.create-merge` + `.set-or-append`) |
| Query | ADT query language | **KQL** `make-graph` / `graph-match` |
| Instance source | Twins created individually or imported | Twins **materialised from real source tables** (Delta / Synapse / ADX) |

Loom's model-**mapping** capability (map an entity type onto a live source table
and materialise the graph from it) has **no ADT Explorer equivalent** — ADT has
no ETL. Conversely Loom has no DTDL. Both are recorded honestly below.

## Feature inventory and Loom coverage

### Shell / connection

| # | ADT Explorer capability | Loom | Evidence / gap |
|---|---|---|---|
| S1 | Five drag-repositionable panels (Query Explorer, Models, Twins, Twin Graph, Model Graph) | ⚠️ | Loom uses a **5-tab** layout (Model / Mappings / Graph explorer / Time series / Azure Digital Twins) inside `ItemEditorChrome`. Comparable information density; panels are not repositionable, but tabs persist (ADT's layout resets on refresh — arguably Loom is better here). |
| S2 | Instance connect / context switch modal | n/a | Loom binds the deployment's ADX cluster; there is no per-item instance to pick. |
| S3 | Private-endpoint support | ✅ **exceeds** | ADT Explorer explicitly **does not support private endpoints** (Private Link instances must self-host the codebase). Loom's console runs in-VNet and reaches ADX over a private endpoint by construction. |

### Models

| # | ADT Explorer capability | Loom | Evidence / gap |
|---|---|---|---|
| M1 | Upload model `.json` files (single + directory bulk) | ❌ | No DTDL import. Models are authored on the canvas. |
| M2 | View raw DTDL definition modal | ❌ | No DTDL representation exists to view. |
| M3 | Delete model / **Delete All Models** | ✅ | Canvas node delete. |
| M4 | Search / filter the model list | ⚠️ | Canvas filter/highlight is a canvas-node-kit standard; a flat searchable model list is not present. |
| M5 | Per-model images (upload, bulk, filename convention) | ❌ | Not modelled. |
| M6 | **Model Graph** with relationships, inheritance, components | ⚠️ | Loom's Model tab **is** a graph of entity + relationship types — richer to author (see M9) — but has **no inheritance and no components**. DTDL's `extends` and component composition have no Loom equivalent, so a model hierarchy cannot be expressed. |
| M7 | Toggle Relationships / Inheritance / Components; Filter; Highlight; Choose layout | ⚠️ | Layout (ELK) + filter/highlight come from canvas-node-kit; the three toggles are meaningless without inheritance/components (M6). |
| M8 | DTDL v3 caveat (v3 models don't render in Model Graph, can't be imported) | n/a | No DTDL at all. |
| M9 | **Edit** the model graphically | ✅ **exceeds** | ADT Explorer is **read-only** for models — you upload DTDL authored elsewhere. Loom authors on an editable canvas with `useCanvasHistory` **undo/redo**. A real advantage. |
| M10 | Model validation | ⚠️ | ADT validates service-side at upload and surfaces failures. Loom validates its own typed model client-side; there is no formal schema to validate against. |

### Twins / instance graph

| # | ADT Explorer capability | Loom | Evidence / gap |
|---|---|---|---|
| T1 | Create a twin from a model (prompt for id) | ❌ | **By design**: Loom materialises twins in bulk from mapped source tables rather than creating them one at a time. Recorded as ❌ because ad-hoc twin creation is genuinely impossible. |
| T2 | Twins panel: searchable flat list, expand for in/out relationships | ❌ | No flat twin list. Instances are reachable only through a `graph-match` query. |
| T3 | Twin Graph visualisation (circles + lines, drag, layout) | ✅ | **Graph explorer** tab renders the instance graph from a real ADX query. |
| T4 | **Twin display-name property** selector | ❌ | Not offered. |
| T5 | Double-click to expand; **Expansion Level**; **Expansion Direction** (In/Out/In-Out) | ❌ | Expansion is expressed by editing the `graph-match` pattern, not by controls. Powerful for someone who knows KQL, opaque for someone who does not. |
| T6 | Show/hide: Hide selected / + Children / all others / non-children; Show All | ❌ | Not built. |
| T7 | Filter + Highlight over twins and relationships | ⚠️ | canvas-node-kit filter/highlight, not ADT's dedicated controls. |
| T8 | **Property inspector** with per-DTDL-type icons and tooltips | ⚠️ | Node selection shows properties; no type-icon vocabulary (ADT has 10). |
| T9 | **Inline property editing** + Save + JSON-Patch "Path Information" modal | ❌ | The instance graph is **read-only** — it is a projection of source tables, so editing a twin in place would be overwritten on the next materialise. Architecturally consistent, but a real capability difference: ADT is a system of record, Loom's twin graph is a derived view. |
| T10 | Property-error surfacing ("missing" for dropped models / stale properties) | ❌ | Not surfaced. |
| T11 | **Get relationships** JSON modal | ❌ | Not built. |
| T12 | **Create relationship** dialog (source/target pre-populated, swap, type constrained by DTDL) | ⚠️ | Relationship **types** are created on the Model canvas; relationship **instances** come from the mapping, not a dialog. |
| T13 | Delete twin(s) / **Delete All Twins** | ⚠️ | Re-materialise replaces the graph; no targeted twin delete. |

### Query

| # | ADT Explorer capability | Loom | Evidence / gap |
|---|---|---|---|
| Q1 | Query box + **Run Query**, results into the graph | ✅ | Graph explorer runs a real pattern via `POST …/query` (`make-graph` / `graph-match` modes). |
| Q2 | **Overlay results** (highlight new against current) | ❌ | Each run replaces. |
| Q3 | **Saved queries** (named, browser-local, deletable) | ❌ | Not built. |
| Q4 | **Share** link with embedded query + tenant + hostname | ❌ | Not built. |
| Q5 | Relationship-only results render in an Output panel | ⚠️ | Not distinguished. |

### Import / export

| # | ADT Explorer capability | Loom | Evidence / gap |
|---|---|---|---|
| I1 | **Import Graph** (JSON export format **or** `.xlsx` with ordered columns) + preview panel + counts modal | ❌ | No import path. |
| I2 | **Export Graph** (query result + all models → round-trippable JSON) | ❌ | No export. Model and graph are locked in Loom's Cosmos state. |
| I3 | Import/Delete **Jobs** API (NDJSON from blob, MSI + Storage RBAC, cancel, output log, Monitor metrics) | n/a | API-only in Azure — **not** an Explorer UI surface, so not a UI-parity row. |
| I4 | **Materialise the graph from live source tables** | ✅ **Loom-only** | `POST …/materialize` builds the twin graph in ADX from the mapped Delta / Synapse / ADX sources. **ADT has no equivalent** — this is Loom's biggest differentiator on this surface. |
| I5 | Source-schema browse (database → table → columns) for mapping | ✅ **Loom-only** | Three real `GET …/source-schema` calls cascade the picker. |

### Data history / time series

| # | ADT Explorer capability | Loom | Evidence / gap |
|---|---|---|---|
| H1 | Data-history explorer: Twin ID + Property + Label + **Update** | ✅ | **Time series** tab → `POST …/time-series` with entity, property, key value. |
| H2 | **Add time series** — overlay multiple properties | ❌ | One series at a time. |
| H3 | Chart view: time range, Independent vs Shared y-axes, aggregation on overflow | ⚠️ | Loom exposes `agg`, `bin`, and `lookback` — comparable controls. No shared/independent y-axis choice (moot without H2). |
| H4 | **Table** view with values + timestamps + download | ⚠️ | Results render; no download. |
| H5 | **Open query in Azure Data Explorer** | ⚠️ | Loom *is* ADX-backed, so the data is already there; but there is no deep link out to the ADX web UI for the generated query. |
| H6 | "Cast property value to number" toggle | ❌ | Not offered. |

### Accessibility / settings

| # | ADT Explorer capability | Loom | Evidence / gap |
|---|---|---|---|
| X1 | **Keyboard Shortcuts** reference | ✅ | canvas-node-kit shortcut sheet (Wave-2 canvas standard). |
| X2 | Eager Loading toggle | ❌ | Not modelled. |
| X3 | Caching toggle | ❌ | Not modelled. |
| X4 | Console (shell functions over the graph) | ❌ | Not built. |
| X5 | Output (diagnostic operation trace) | ❌ | Not built. |
| X6 | High Contrast | ⚠️ | Loom themes are app-wide (Fluent v9 dark/light); no dedicated high-contrast toggle on this surface. |

### Opt-in ADT alternate *(Loom-only row)*

| # | Capability | Loom | Evidence |
|---|---|---|---|
| D1 | Azure Digital Twins as an **opt-in** backend, honest-gated on `LOOM_ADT_ENDPOINT` | ✅ | Dedicated **Azure Digital Twins** tab; `GET …/event-route` reports wiring status. `no-fabric-dependency.md` posture is exactly right — ADX is the default, ADT is never required. |

## Totals

**11 ✅ (3 exceeding ADT, 2 Loom-only) · 16 ⚠️ · 21 ❌ · 3 n/a — 51 rows.**

## ux-baseline §7 spot-check

| Bar | Status |
|---|---|
| `ItemEditorChrome` + ribbon + dirty tracking | ✅ |
| `TeachingBanner` | ✅ |
| 5 tabs with icons | ✅ |
| canvas-node-kit + `useCanvasHistory` undo/redo + ELK layout | ✅ |
| Loading spinner while the twin loads (`:512`) | ✅ |
| Honest gate for the opt-in ADT path | ✅ |
| Shared `HonestGate` with **Fix it** for the ADX path | ❌ — ADX gating is not evidenced as a registered gate on this surface (**G2** risk). |
| G3 `SplitPane` + persisted `sizingKey` | ❌ — not imported on this surface, unlike its sibling `databricks-pipeline` which does use `SplitPane`. |
| Result grids use `PreviewTable` | ❌ — hand-built tables. |

## Backend per control

| Control | Call | Real backend |
|---|---|---|
| Source database / table / column cascade | `GET /api/items/digital-twin/:id/source-schema[?database=&table=]` | Lakehouse **Delta** / **Synapse** warehouse / **ADX** |
| **Materialise / Build twin graph** | `POST …/materialize` | **ADX** `.create-merge` + `.set-or-append` |
| **Graph explorer** run | `POST …/query` (`mode`, `backend:'adx'`) | **ADX** `make-graph` / `graph-match` |
| **Time series** | `POST …/time-series` | ADX time-series aggregation |
| ADT tab status | `GET …/event-route` | Azure Digital Twins (opt-in, gated) |
| Save | item `PATCH` | Cosmos DB |

Real backend on every control. No mocks. **No Fabric, no OneLake, and no ADT on
any default path** — `no-fabric-dependency.md` fully satisfied.

## Verdict

**C/B.** This is a large, serious surface (1,077 lines) with a real ADX graph
backend, canvas authoring that genuinely exceeds ADT Explorer's read-only model
view, and a materialise-from-source capability ADT does not have at all.

The ❌ concentration is in **instance-graph exploration**, and the cause is
architectural rather than incidental: Loom's twin graph is a **derived
projection** of source tables, so ADT's create-twin (T1), edit-property (T9),
create-relationship-dialog (T12), and delete-twin (T13) affordances have nowhere
to write to. That is a defensible design — but it means Loom is **not** a
system-of-record digital-twin platform, and the surface does not say so anywhere.
A user arriving from ADT Explorer will look for those controls and find nothing;
an explicit statement of the projection model belongs on the surface.

Beyond that, ranked:

1. **T5/T6 (no expansion or hide controls)** — exploring a large graph requires
   editing KQL, which excludes non-KQL users from the surface's main tab.
2. **I1/I2 (no import or export)** — a modelled ontology cannot leave Loom.
3. **M6 (no inheritance / components)** — caps ontology expressiveness against
   any DTDL model.
4. **Q3/Q4 (no saved or shareable queries)** — cheap, and high-value for a graph
   explorer.

## Verification

- **V3 (in-browser click-walk): OWED.** `loom-ui-verify` red since 2026-08-04
  (FINISHLINE C13); Actions degraded. When recovered:
  ```bash
  gh workflow run loom-ui-verify.yml --ref main -f target_route=/items/digital-twin/<id>
  ```
  The walk must exercise the full chain — model on the canvas → map onto a real
  source table → **materialise** → `graph-match` in the explorer → a time-series
  read — because the tabs are only meaningful in sequence.
- Coverage read from source; static evidence only (`no_scaffold_claims`).
