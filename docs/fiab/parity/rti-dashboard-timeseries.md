# rti-dashboard-timeseries — parity with Fabric Real-Time Dashboard time-chart tile

Source UI: Microsoft Fabric Real-Time Dashboard → time-chart tile interactions
(legend, multiple y-axes, log scale, zoom/brush). Backed in Loom by the
Azure-native ADX path — `app/api/items/kql-dashboard/[id]/run` executing real
Kusto over the shared Azure Data Explorer cluster (no Fabric / OneLake; works
with `LOOM_DEFAULT_FABRIC_WORKSPACE` UNSET).

Renderer: `apps/fiab-console/lib/components/adx/time-series-chart.tsx`
(+ pure model `time-series-model.ts`), wired into `TileVisual` in
`lib/editors/phase3-editors.tsx` for the `line` / `timechart` visuals. It is
used by the KQL Dashboard tile grid, the tile-edit flyout preview, and the KQL
Queryset / Eventhouse result panels.

## Fabric/ADX feature inventory

| # | Capability (Fabric/ADX time-chart) | Behavior |
|---|------------------------------------|----------|
| 1 | Legend with per-series names       | Lists every series in the result |
| 2 | Legend search / filter             | Type to narrow the plotted + listed series |
| 3 | Pin / highlight a series           | Click to emphasize a series; others dim |
| 4 | Overlay multiple highlighted       | Multiple pins stay bright + on top |
| 5 | Multiple y-axes / small multiples  | Split each series into its own stacked panel |
| 6 | Y axis: linear / log scale         | Toggle logarithmic Y axis |
| 7 | Zoom / time brush                  | Drag a range to zoom onto a sub-window |
| 8 | Reset zoom                         | Return to the full time domain |
| 9 | Multi-series from one query        | Wide + long (pivoted) Kusto shapes |

## Loom coverage

| # | Status | Notes |
|---|--------|-------|
| 1 | ✅ | Color-swatched legend chips, brand categorical palette |
| 2 | ✅ | `Search series…` input filters legend + plotted lines live |
| 3 | ✅ | Click a legend chip to pin; non-pinned lines drop to 18% opacity |
| 4 | ✅ | Pin set; pinned lines render last (on top), thicker stroke; Clear pins |
| 5 | ✅ | `Multi-panel` switch → one independent-Y panel per visible series |
| 6 | ✅ | `Log Y` switch; log domain skips non-positive points safely |
| 7 | ✅ | Dual-thumb range brush over the X domain; X/Y rescale to the window |
| 8 | ✅ | `Reset zoom` button appears once zoomed |
| 9 | ✅ | `parseSeries` auto-detects wide (`[t, a, b]`) vs long (`[t, name, v]`) |

Zero ❌, zero stub banners.

## Backend per control

Every control operates on the **real ADX series** already loaded into the tile:
the KQL Dashboard editor runs each tile through
`POST /api/items/kql-dashboard/[id]/run`, which calls the live Kusto data plane
via `lib/azure/kusto-client.ts` (Console UAMI; ARM-resolved shared ADX cluster).
The result `columns`/`rows`/`columnTypes` flow into `TimeSeriesChart`. All five
controls are client-side transforms over that real result — no mock data, no
extra backend, no new env var or Azure resource. If a tile's query is gated
(cluster unreachable / DB missing), the existing `LoomTileBody` MessageBar
surfaces the honest reason before the chart renders.

## Tests

`lib/components/adx/__tests__/time-series-model.test.ts` — 9 vitest cases
covering wide/long parsing, time sorting, null gap alignment, numeric coercion,
guards, and the zoom-window index mapping.
