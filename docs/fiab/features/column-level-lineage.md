# Column-level lineage and impact analysis

> **Surface:** the shared lineage canvas — Unified Catalog → Lineage, `/catalog/lineage`, and the per-asset `/catalog/<source>/<id>` view
> **Backend:** the unified lineage graph (`GET /api/catalog/lineage?columns=true`), synthesised from OpenLineage ingest, Purview column lineage, dbt manifests and the platform's own capture
> **Kill-switch flag:** `l5-column-lineage-ui` (default ON)
> **Honest gate:** none — a table with no captured column lineage simply does not expand

Lineage at table grain answers "where did this table come from". Column grain
answers the question that actually stops a deployment: **if I change this
column, what breaks?**

Expand a table node on the lineage canvas to fan out its columns, follow
column-to-column edges across the graph, and run impact analysis on any single
column.

## Why it exists

Table-grain lineage over-reports. A downstream table "depends on" an upstream
table even when it only reads two of its forty columns, so every schema change
looks like it threatens everything. Column grain makes the blast radius real and
usually much smaller — and when it is genuinely large, you find out before the
change ships instead of after.

## How to use it end to end

1. **Open a lineage canvas** — Unified Catalog → Lineage, or the Lineage view on
   any asset.
2. **Expand a table.** Table nodes carry a fan-out affordance; expanding one
   reveals its column nodes beneath it. A column node is visible only while its
   owning table is expanded, so the canvas does not explode.
3. **Follow column-to-column edges.** Where the source declared one, the edge
   carries the **transform expression** (for example `UPPER(x)`), so you can see
   *how* the value got there, not just that it did.
4. **Select a column.** The right details panel switches to column mode and
   shows:
   - **Column of** — a jump-to link back to the owning table.
   - **Impact if this column changes** — a downstream-column count badge, split
     into **direct** and **transitive**. Zero downstream is stated plainly: "no
     recorded downstream column depends on this column — a change here is
     isolated as far as captured lineage knows."
   - **Downstream columns** and **Upstream columns** — the chains themselves,
     each row clickable to jump to that column on the canvas.
   - The column's fully-qualified identifier.
5. **Click Analyze impact.** The canvas switches to impact mode and focus mode:
   only the **downstream** chain of the selected column is highlighted, so you
   are looking at the blast radius and nothing else.
6. **Click Focus chain** instead to highlight the full chain in both directions.
7. **Collapse** the table to return to table grain.

Impact analysis is computed over the **full** graph, not just what is currently
expanded, so a collapsed table's columns still count toward the impact numbers.

## What the backend actually does

| Control | Backend |
|---|---|
| Column graph | The unified lineage layer synthesises column nodes (`col:<table>::<column>`, each pointing at its owning table node) and `column`-kind edges |
| API facet | `GET /api/catalog/lineage?columns=true` |
| Sources | OpenLineage ingest, Purview column lineage, dbt manifest lineage, and Loom's own per-item capture |
| Fan-out, visibility, impact walk | Deterministic, side-effect-free helpers — unit-tested without mounting the canvas |

The transform expression on an edge is carried through from whatever the source
declared. Loom does not infer one.

## Honest gates

None. Two behaviours worth understanding:

- **"No recorded downstream column"** means exactly that — as far as *captured*
  lineage knows. It is a statement about the lineage graph, not a guarantee about
  the world, and the copy says so.
- **A table that does not expand** has no captured column lineage from any
  source. Wire up OpenLineage ingest or a Purview scan for that source to
  populate it.

## Kill-switch

`l5-column-lineage-ui` — default ON, fail-open. Flipping it OFF reverts every
lineage canvas to the pre-L5 table-grain rendering on the next load: column
nodes and edges are simply filtered out client-side. **The column model, the
`?columns=true` API facet, and all lineage capture keep running either way.** No
roll required.

## Related

- [Lineage (governance)](../governance/lineage.md) · [Catalog lineage](../catalog/lineage.md)
- [Canvas full-screen](canvas-fullscreen.md) — useful on a wide column graph
- [Tagging and classification](../governance/tagging-classification.md)
