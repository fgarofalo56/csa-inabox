# mapping-dataflow — parity with the ADF / Synapse "Mapping Data Flow" designer

> Parity audit per `.claude/rules/ui-parity.md` + `.claude/rules/no-vaporware.md`
> + `.claude/rules/no-fabric-dependency.md`. Graded conservatively.

**What this is.** A **Mapping Data Flow** is a visually-designed, Spark-executed
data transformation (Source → transformations → Sink, compiling to Data Flow
Script). In the real product it's authored in **ADF Studio / Synapse Studio →
Author hub → Data flows** and invoked from a pipeline's *Data flow* activity — a
**sub-feature of Data Factory**, not a standalone app.

CSA Loom surfaces the Mapping Data Flow in two places, and this is deliberate:

- **As a first-class catalog item** (`mapping-dataflow`) with its own editor —
  the subject of this doc. Distinct from the `dataflow` item type, which is the
  Power Query / **Dataflow Gen2 (wrangling)** editor.
- **Inline** inside the **Mounted ADF** editor's Data flows tab — audited
  separately in `adf-mapping-data-flow.md`. Both host the same shared
  `MappingDataFlowDesigner`; see that doc for the exhaustive
  transform/canvas/DFS inventory. This doc covers the standalone editor chrome.

**Source UI (grounded in Microsoft Learn, not memory):**
- Mapping data flows overview: https://learn.microsoft.com/azure/data-factory/concepts-data-flow-overview
- Data flow script (DFS): https://learn.microsoft.com/azure/data-factory/data-flow-script
- Debug mode + data preview: https://learn.microsoft.com/azure/data-factory/concepts-data-flow-debug-mode
- Transformation overview: https://learn.microsoft.com/azure/data-factory/data-flow-transformation-overview
- REST — `Microsoft.DataFactory/factories/dataflows`: https://learn.microsoft.com/rest/api/datafactory/data-flows

**Loom surface:**
- Editor: `apps/fiab-console/lib/editors/mapping-dataflow-editor.tsx` — hosts the
  shared `MappingDataFlowDesigner`
  (`lib/components/pipeline/dataflow/mapping-dataflow-designer.tsx`) plus a
  new-flow name field, honest debug gate, and a **per-transformation data
  preview** panel.
- Catalog: `apps/fiab-console/lib/catalog/item-types/data-factory.ts`
  (`slug: 'mapping-dataflow'`, `restType: 'MappingDataFlow'`).
- BFF: `app/api/adf/dataflows/route.ts` + `…/[name]/route.ts` (get/upsert/delete),
  `app/api/adf/datasets` (source/sink picker),
  `app/api/adf/dataflows/[name]/debug/route.ts` (probe + run a real debug preview).

**Backend reality check.** Load/save round-trip real ARM
(`Microsoft.DataFactory/factories/dataflows`, `properties.type = MappingDataFlow`)
on the deployment-default factory. Data preview rows come **only** from a live
ADF debug session (`createDataFlowDebugSession → addDataFlowToDebugSession →
executeDataFlowDebugCommand(executePreviewQuery)`) — never fabricated. When the
factory isn't configured, or no Spark debug session is available, an honest
Fluent MessageBar names the requirement (an Azure IR with data-flow compute) and
authoring still writes the real definition. Azure-native default — no Fabric
dependency.

---

## Azure/Fabric feature inventory → Loom coverage → backend

Legend: built ✅ · honest-gate ⚠️ · MISSING ❌ · (see `adf-mapping-data-flow.md`
for the full canvas/transform row-by-row grade)

### Editor chrome (this surface)

| # | ADF Studio capability | Loom | Where / backend |
|---|---|---|---|
| 1 | Create a named data flow (`dataflows/{name}`) | ✅ built | new-flow name field → `PUT …/[name]` on Save |
| 2 | Open / hydrate an existing flow | ✅ built | `GET /api/adf/dataflows/{name}` → `definitionToModel` |
| 3 | Save (writes DFS to ADF) | ✅ built | Save → `PUT …/[name]` (`modelToTypeProperties`) |
| 4 | Refresh / reload | ✅ built | ribbon Refresh → `reloadKey` |
| 5 | **Debug mode toggle** + availability probe | ✅ built | `GET …/{name}/debug` → lights the designer's Debug surface; **U7** adds a HELD session (see §U7) |
| 6 | **Data preview of the SELECTED transformation** | ✅ built | preview picker → `POST …/{name}/debug` `executePreviewQuery` |
| 7 | Preview renders real rows (no faked data) | ✅ built | `normalizePreview` renders only route rows |
| 8 | Honest gate when no debug session / factory | ⚠️ honest-gate | Fluent MessageBar naming the ADF + IR requirement |

### Debug mode — held session + per-transform tabs (U7)

The ADF-Studio Debug authoring loop: toggle **Debug** once to hold a session for
the whole loop, then preview / inspect / profile any transform cheaply against
that warm session. Behind FLAG0 flag `u7-dataflow-debug` (default-ON; OFF reverts
to row-6 single-stream inline preview). UI: `dataflow-debug-panel.tsx`.

| # | ADF Studio capability | Loom | Where / backend |
|---|---|---|---|
| U7-1 | **Held debug session** (toggle Debug → 1 cluster for the loop) w/ TTL chip | ✅ built (PR-1) | `POST …/mapping-dataflow/[id]/debug/session` acquire/release → `create/deleteDataFlowDebugSession` |
| U7-2 | **Data preview per transform** (type-badged grid + timing status bar) | ✅ built (PR-1) | `POST …/debug/preview` → `addDataFlowToDebugSession` + `executePreviewQuery`; shared `PreviewTable` |
| U7-3 | Preview reflects **unsaved** in-canvas edits | ✅ built (PR-1) | route re-adds the live serialized graph package before each preview |
| U7-4 | **Inspect** — in/out schema per transform + schema-drift badges | ⏳ U7 PR-2 | `GET …/debug/schema` → `parseDfsSchema`/`diffSchemas` (helper landed PR-1) |
| U7-5 | **Statistics** — null %/distinct/min/max/mean/stddev + histograms | ⏳ U7 PR-2 | `POST …/debug/stats` → `computeColumnStats` over the sample (helper landed PR-1) |
| U7-6 | **Quick-actions** — preview column → Typecast/Modify/Remove inserts a transform | ⏳ U7 PR-3 | preview-grid column context menu → draft graph mutation |

### Canvas + transforms (delegated to the shared designer)

| # | ADF capability | Loom | Notes |
|---|---|---|---|
| 9 | Visual Source→transform→Sink graph | ✅ built | React Flow canvas — see `adf-mapping-data-flow.md` §B |
| 10 | Transform library (Select/Filter/Join/Aggregate/Derived/…) | ✅ built | palette — see `adf-mapping-data-flow.md` §C |
| 11 | Dataset-backed Source/Sink pickers | ✅ built | `GET /api/adf/datasets` |
| 12 | **Visual expression builder** (Add Dynamic Content) | ❌ MISSING | plain expression textareas (see `adf-mapping-data-flow.md` C9) |
| 13 | Free edge-drawing / inline "+" between nodes | ⚠️ partial | add chains off the selected node |
| 14 | Per-node Optimize / Inspect / Data-preview tabs | ✅ built (U7) / ⏳ | Data-preview tab shipped (U7-2); Inspect/Statistics tabs U7 PR-2 (§U7) |
| 15 | Rename / clone / Publish-Git shell | ❌ MISSING | direct PUT only |

**Grade: B.** The standalone editor gives a real create→author→save→**live
debug preview** loop against ADF REST, with an honest Spark-debug gate. The
deep-authoring gaps (visual expression builder, per-node tabs, publish/git) are
shared with the mounted-ADF surface and tracked in `adf-mapping-data-flow.md` —
not stubs, and never Fabric-gated.
