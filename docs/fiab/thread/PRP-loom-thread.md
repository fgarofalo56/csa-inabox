# PRP — Loom Thread (the integration fabric that weaves every service together)

**Status:** Foundation in progress · **Effective:** 2026-06-05 · **Owner:** operator + agent

## Problem

CSA Loom items/editors are largely standalone — each is a thin UI over one Azure
service. There is no glue that lets a user go **raw → bronze → silver → gold →
(SQL endpoint / API / Power BI / data-agent)** in a few clicks without leaving
the UI, typing connection strings, or doing "technical gymnastics". Dependent
services (e.g. a notebook's cluster) can't be started/edited in place.

## Vision

**Thread** is the underlying fabric that weaves Loom services together. Every
editor gets a **"Weave"** action: a context-aware menu of one-click integrations
into upstream/downstream Loom services, each backed by a **wizard that populates
every choice from pre-configured services** (dropdowns from real discovery APIs —
never a typed path or connection string). The result is the real wiring of two
services. Secure by design: every option is scoped to what the caller can already
see; nothing is provisioned or connected without an explicit, disclosed step.

## Operator decisions (locked 2026-06-05)

- **First edges (all four):** notebook/lakehouse → SQL warehouse · query/table →
  data-agent source · gold table → Power BI · table/query → API endpoint.
- **Provisioning:** BOTH — wizards list existing pre-configured targets AND offer
  "create a new one" (provision the Azure resource, with cost/permission
  disclosure). Reuse `createOwnedItem` + the data-product `instantiate` walk.
- **Power BI:** Premium/PPU + service principal available → full embed + push +
  **XMLA** (so semantic-model DAX execution + embedded reports are in scope).
- **Naming:** framework = **Thread**; the editor button = **Weave** ("Weave into…").

## Architecture (grounded in the codebase investigation)

### Single insertion point
`apps/fiab-console/lib/editors/item-editor-chrome.tsx` — EVERY editor + the
generic fallback funnel through this chrome. Its `PageShell` `actions` slot
already hosts the universal `ItemSidePanel`. We insert **`<ThreadMenu type={item.slug} id={id} item={item} />`** there → all ~120 editors light up with one edit.

### Declarative edge registry — `lib/thread/thread-actions.ts`
Mirrors the orchestrator `ToolDef`/`LoomToolRegistry` shape:
```ts
interface ThreadAction {
  id: string;
  label: string;            // "Add as a Data Agent source"
  verbLabel?: string;       // menu group: "Analyze with AI" / "Publish" / "Promote"
  description: string;
  fromTypes: string[] | '*';// source item slugs this action appears on
  produces?: string;        // target item-type slug (when it creates one)
  icon?: ReactNode;
  fields: ThreadField[];    // wizard inputs — ALL dropdown/picker/toggle (no freeform)
  execute: { route: string } // BFF route POSTed with the collected field values
}
```
`actionsFor(slug)` filters the registry for an editor. Edges are grouped in the
menu by `verbLabel` (Promote · Analyze with AI · Publish · Visualize).

### Wizard field types (no-freeform-config compliant)
`ThreadField` kinds, each populated from a **real discovery route**:
- `loom-item` (by-type picker → `/api/items/by-type?types=…`)
- `compute-target` (`/api/loom/compute-targets`)
- `workspace` (`/api/loom/workspaces`)
- `lakehouse-container` / `lakehouse-path` (`/api/lakehouse/containers`, `/paths`)
- `table` / `column` (per-backend schema routes; a normalizing adapter)
- `powerbi-workspace` / `powerbi-dataset` (`/api/powerbi/*`)
- `select` (static enum) · `text` (only where a free display name is legitimate,
  e.g. the new item's name) · `toggle`
- A `create-or-pick` field = a picker with a "+ Create new" branch that swaps to
  the create form for `produces`.

### Execution
- Prefer existing backends: the orchestrator has ~32 tools
  (`lib/azure/copilot-orchestrator.ts`) + `createOwnedItem` + per-service clients.
- Each Thread action POSTs to a small BFF route under `app/api/thread/<action>/`
  that calls the real client (or reuses an existing route). Real backend or honest
  Fluent gate — `no-vaporware`. Result drawer shows success + a deep link to the
  produced/updated item (and an "open it" / "start it" affordance).

### In-place service lifecycle
Dependent-service start/edit is already proven (notebook "Start compute" →
`/api/loom/compute-targets/{id}/start`). Thread standardizes a `ServiceChip`
that shows a dependency's state + Start/Edit/Open-in-editor inline, reusable on
every editor that depends on a compute/endpoint.

### The edge graph (persisted)
A new Cosmos container `thread-edges` (PK `/tenantId`) records
`{ id, tenantId, fromItemId, fromType, toItemId, toType, action, createdAt, createdBy }`
so Loom can render a **lineage/mesh view** ("what feeds what") and make chains
promotable. (Phase 2 — the first slice can write edges without the viewer.)

## Reuse map (what already exists — do NOT rebuild)

| Need | Reuse |
|------|-------|
| Pick a Loom item by type | `GET /api/items/by-type?types=` |
| Pick compute / start it | `GET /api/loom/compute-targets`, `POST …/{id}/start` |
| Lakehouse containers/paths | `/api/lakehouse/containers`, `/api/lakehouse/paths` |
| Tables/columns (SQL/UC/ADX/PBI) | `sql-objects-client`, `unity-catalog-client`, `kusto-client`, `powerbi-client` (+ a normalizing adapter) |
| Spawn a target item | `createOwnedItem` (`app/api/items/_lib/item-crud.ts`) |
| Spawn a wired chain | data-product `instantiate` walk |
| Data-agent attach | `DA_SOURCE_TYPES` + `state.sources[]` (generalize) |
| Table → API | `data-api-builder-editor` (SQL); gap: Delta/Databricks-SQL |
| Query → Power BI model | `powerbi-client` createPushDataset/putPushTable/postPushRows/executeDatasetQueries/embed |
| Universal editor chrome | `item-editor-chrome.tsx` |
| Universal drawer action pattern | `item-side-panel.tsx` |

## Identified gaps (Thread must add)

1. Medallion **promotion as a flow** (promote table → next layer) — Thread's spine.
2. **gold table → data-agent source** one-click (today the picker needs a pre-existing item).
3. **notebook output → warehouse/external table** register.
4. **Delta/Databricks-SQL → API** (DAB only does Azure SQL / Synapse dedicated).
5. **table/query → Power BI report** (model exists; report build does not).
6. **query → REST endpoint** (user-data-function not wired from a query surface).
7. The **edge/promotion graph** + a normalizing **columns adapter** across backends.

## Delivery plan (multi-PR program)

- **PR 1 (this one) — Foundation:** `thread-actions.ts` registry + `ThreadMenu`
  (Weave button → grouped menu → wizard drawer with real-discovery fields) wired
  into `item-editor-chrome.tsx`; `thread-edges` write; and the **first real edges**:
  (a) *Add as Data Agent source*, (b) *Build a Power BI model* — both fully working
  on real backends, with honest gates.
- **PR 2 — Explore + SQL/warehouse edges:**
  - ✅ *Analyze in a Notebook* — from any lakehouse/warehouse/KQL/SQL item, create a
    notebook with that item attached + a starter cell (`/api/thread/analyze-in-notebook`).
  - ⏭ *lakehouse → SQL endpoint* (Synapse Serverless view over Delta) — deferred:
    needs a serverless database + external-table/view DDL (CREATE DATABASE/VIEW),
    an honest infra step; lands with the columns adapter next.
- **PR 3 — API edges:** table/query → Data API Builder / APIM (+ Delta path), query → UDF REST.
- **PR 4 — Medallion promotion + edge-graph mesh viewer:** promote bronze→silver→gold,
  lineage view over `thread-edges`.
- **PR 5 — Power BI deepening:** embedded reports in Loom, report build from a model, XMLA DAX.
- **Cross-cutting:** Web-3.0 polish (icons/colors per type via `itemVisual`), ServiceChip
  in-place start/edit, and `ui-parity` + `no-vaporware` receipts per edge.

## Acceptance (per edge)

Real backend wiring (or honest Fluent gate naming the exact missing infra) ·
every field a dropdown/picker from a real discovery route (no freeform) · the
produced/updated item is real and deep-linked · secure (scoped to caller's
visibility; provisioning disclosed) · Fluent v9 + Loom tokens · parity doc +
`thread-edges` recorded.
