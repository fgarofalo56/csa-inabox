# Mapping data flow Debug sessions

> **Surface:** Mapping data flow editor (`/items/mapping-dataflow/<id>`) — the bottom **Debug** dock with **Data preview**, **Inspect** and **Statistics** tabs
> **Backend:** a real Azure Data Factory data-flow **debug session** (`createDataFlowDebugSession` -> `addDataFlowToDebugSession` -> `executeDataFlowDebugCommand`) on the deployment-default factory's Managed Integration Runtime
> **Kill-switch flag:** `u7-dataflow-debug` (default ON)
> **Honest gate:** a data-flow-capable Azure Integration Runtime is required — with or without this feature

ADF Studio's Debug experience, one for one. Toggle Debug on, and every
transform on the canvas becomes inspectable: a live sample of the rows flowing
out of it, its input and output schema with drift detection, and per-column
statistics — all served from **one held warm session** so clicking around is
cheap.

## Why it exists

Before this, the mapping data flow editor had a single inline preview of one
stream. Authoring a real flow means asking "what does the data look like *after
this join*, and *before that filter*?" — which needs per-transform preview, and
per-transform preview is only affordable if the debug cluster is held warm
between clicks rather than acquired per request.

The critical design property: a preview runs the **same Data Flow Script** the
flow's production run path executes. One compiler, two entry points. There is no
parallel PySpark implementation that could disagree with production, and no
mocks.

## How to use it end to end

1. **Open a mapping data flow** and design your graph on the canvas.
2. **Toggle Debug on** in the bottom dock. This acquires a **held** ADF debug
   session — a short-lived Spark cluster on the deployment-default factory's
   Managed IR. The dock header shows the session state and its remaining
   lifetime.
3. **Data preview tab.** Pick a transform from the dropdown, set a sample size,
   and Run. Rows come back through the shared preview table with **type-badged
   columns** and a timing status bar. ADF's preview cap is 1,000 rows; the
   default sample is 100.
4. **Use the preview grid's column quick-actions.** Right-click a column for:
   - **Typecast** — inserts a real **Cast** transform (`col as <type>`) wired off
     the previewed stream;
   - **Modify** — inserts a **Derived Column** transform (`col = col`, ready to
     edit);
   - **Remove** — inserts a **Select** in rule mode dropping the column.

   These generate genuine transforms with the exact catalog settings the Data
   Flow Script builder consumes, so the projection is faithful rather than
   best-effort. They are **draft only** and published on Save — the live flow is
   never mutated behind your back.
5. **Inspect tab.** The in and out schema for the selected transform, plus
   **schema drift** entries — the columns that appeared or changed shape versus
   what the flow declares.
6. **Statistics tab.** Per-column profile cards with top-value mini-histograms,
   so you can see distribution and null density without writing a profiling
   query.
7. **Toggle Debug off** (or navigate away) to release the session. Sessions are
   released on unmount, so a forgotten tab does not hold a cluster.

## What the backend actually does

| Control | Backend |
|---|---|
| Debug toggle | `POST …/debug/session` with `acquire` / release -> the ADF debug-session lifecycle |
| Data preview | `…/debug/preview` -> `executeDataFlowDebugCommand` against the held session |
| Inspect (schema + drift) | `…/debug/schema` -> the debug session's schema command, parsed by the shared Data Flow Script parser |
| Statistics | `…/debug/stats` -> per-column profile computed off the real returned rows |
| Package resolution | The shared helper resolves the flow plus every dataset and linked service it references, and enumerates the previewable streams |

`Microsoft.DataFactory` is Azure-native. There is no Fabric dependency on any
path here.

## Honest gates

Data preview and debug **require a data-flow-capable Azure Integration
Runtime** — that is an ADF requirement, not a Loom one, and it applies with or
without this feature. When one is not available the dock renders the gate
naming the requirement instead of showing an empty grid.

Everything else degrades honestly: a transform whose upstream is not previewable
says so, and a session that has expired offers re-acquire rather than silently
returning stale rows.

## Kill-switch

`u7-dataflow-debug` — default ON. Flipping it OFF reverts the mapping data flow
editor to the pre-U7 single-stream inline preview on the next load. The real ADF
debug session, the factory, and the authoring path are unaffected — only the
richer bottom Debug panel is hidden.

## Related

- Editor guide — [Mapping data flow](../tutorials/editor-mapping-dataflow.md)
- [Data pipelines and Mapping Data Flow](../learn/data-pipelines-and-dataflows.md)
- [Dataflow Gen2 parity](../workloads/dataflow.md)
- [Canvas full-screen](canvas-fullscreen.md) — more room for the canvas above the dock
