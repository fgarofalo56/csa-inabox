# Loom Power BI Dashboard — Fabric parity gap

> **Validator: v2 4-phase (live browser) — 2026-05-26**
> Loom URL: https://loom-console-fvbbctd4eehqbkcs.b02.azurefd.net/items/dashboard/new
> Fabric reference: app.powerbi.com (login-gated; spec-derived from docs/fiab/dashboard-parity-spec.md + Microsoft Learn /power-bi/create-reports/service-dashboards)
> Screenshot: temp/parity/dashboard-loom.png
> Source under review: apps/fiab-console/lib/editors/phase3-editors.tsx lines 1643-1730

## Phase 1 + 2 captures
Live Loom (DashboardEditor renders):
- Heading: "New dashboard" / "Power BI dashboard" badge
- Ribbon: REUSES REPORT_RIBBON (phase3-editors.tsx:1683) → buttons are New page, Duplicate, New visual, Format, Bookmark, Refresh, Filters — wrong vocabulary for a dashboard
- Action bar: workspace picker + Refresh
- Main canvas: a flat CSS grid of "tile metadata cards" (subTitle, title, colSpan×rowSpan) — NOT an interactive dashboard
- Tile-detail: a small card listing id / reportId / datasetId / embedUrl as raw text
- <iframe> count: 0 (NO embedded dashboard)
- Drag handles / resize handles / + Add a tile button / Q&A bar / Comments pane / Subscribe / Share / Edit toggle: NONE

## Phase 3 gap matrix
| Fabric element | Loom present? | Severity | Notes |
|---|---|---|---|
| Embedded dashboard canvas (live, via powerbi-client SDK + dashboards/{id}/GenerateToken) | MISSING | BLOCKER | The headline feature. Loom renders only metadata cards in a CSS grid (phase3-editors.tsx:1707-1716) |
| Top action bar: + Add a tile, Ask a question, Comments, View menu, Share, Subscribe, Set as featured, Pin to, Favorite, File menu, Edit toggle | MISSING | BLOCKER | None of these action-bar items exist |
| Per-tile chrome (Edit details, Pin tile, Focus mode, Export data, Delete, pencil/pin icons on hover) | MISSING | BLOCKER | Tile is a static card; no hover affordances, no More-options menu |
| Tile details dialog (title override, subtitle, last refresh, custom link, alerts threshold) | MISSING | BLOCKER | Loom shows raw id/reportId/datasetId/embedUrl as readonly text |
| Tile move (drag) + resize (handle) | MISSING | BLOCKER | Cards are non-interactive |
| Tile flow toggle / grid sizing 1×1 – 5×5 | MISSING | BLOCKER | colSpan/rowSpan shown as label only |
| + Add a tile widget picker (Web content / Image / Text box / Video / Custom streaming / Real-time) | MISSING | BLOCKER | No picker, no widget creation |
| Q&A bar at top of dashboard | MISSING | BLOCKER | — |
| Comments pane (right side, threaded, @-mentions) | MISSING | MAJOR | — |
| Settings (Rename / Q&A on-off / Tile flow / Background / Theme) | MISSING | MAJOR | — |
| Phone / mobile view layout designer | MISSING | MAJOR | — |
| Pin-from-report / Pin-from-Q&A / Pin-from-Excel flows | MISSING | MAJOR | These originate elsewhere but must land here |
| Subscribe (cadenced email) | MISSING | MAJOR | — |
| Share + permissions | MISSING | MAJOR | — |
| Alert configuration (KPI/card tiles) | MISSING | MAJOR | — |
| Clone tile (CloneTile REST: POST .../tiles/{id}/Clone) | MISSING | MAJOR | REST exists but no UI |
| Right-rail Insights / Smart narrative | MISSING | MINOR | preview-tier feature |
| Wrong ribbon (uses REPORT_RIBBON: New page, New visual, Format, Bookmark, Filters) | PRESENT but WRONG | MAJOR | Dashboards have no "pages" or "visuals"; these labels are misleading. They are also dead. |
| Dashboards listing (left rail, click to select) | PRESENT | — | loadList wired to /api/items/dashboard real PBI REST |
| Dashboard tiles list (count, metadata) | PRESENT | — | loadDetail wired to /api/items/dashboard/{id} (1670-1677). Honest BFF call. |
| embedUrl printed as <code> text on selected tile | PRESENT but worse than missing | MAJOR | Same no-vaporware.md anti-pattern as Report editor |

## Phase 4 click-every-button
| Button | Expected | Observed | Status |
|---|---|---|---|
| New page (ribbon, wrong for dashboard) | n/a | nothing | BROKEN |
| Duplicate | n/a | nothing | BROKEN |
| New visual (wrong) | n/a | nothing | BROKEN |
| Format | n/a | nothing | BROKEN |
| Bookmark | n/a | nothing | BROKEN |
| Filters | n/a | nothing | BROKEN |
| Refresh (ribbon) | n/a | nothing | BROKEN |
| Refresh (toolbar) | reload dashboard list | wired loadList | OK (gated on workspaceId) |
| Click on a tile card | expect tile-detail / focus mode | sets selectedTile state → renders 4-field readonly card. Not focus mode, not editable. | partial |

Root cause: DashboardEditor passes REPORT_RIBBON to ItemEditorChrome (line 1683). The ribbon actions have only { label } — no onClick. Plus the ribbon vocabulary is wrong for a dashboard surface.

## Fair-where-due
- /api/items/dashboard → listDashboards() against real Power BI REST /v1.0/myorg/groups/{ws}/dashboards
- /api/items/dashboard/{id} → listDashboardTiles() returns id, title, subTitle, reportId, datasetId, embedUrl, rowSpan, colSpan

Listing + metadata are honest. The editor surface is non-functional.

## Final grade: D
Phase 3 has 8 BLOCKER rows + many MAJOR. Phase 4 has 7 BROKEN ribbon buttons AND the ribbon is the wrong one for the surface. Vaporware pattern: tile cards LOOK like a dashboard layout but are static placeholders.

## Remediation
1. Install powerbi-client and powerbi-client-react.
2. Add BFF route POST /api/items/dashboard/{id}/embed-token calling Power BI REST POST /v1.0/myorg/groups/{ws}/dashboards/{id}/GenerateToken. Also wire per-tile token via POST .../tiles/{tileId}/GenerateToken for focus mode.
3. Replace the metadata-card grid (phase3-editors.tsx:1707-1716) with <PowerBIEmbed> embedType:'dashboard'.
4. Build a NEW DASHBOARD_RIBBON (do not reuse REPORT_RIBBON):
   - Home: Save · Refresh dashboard tiles · Share · Subscribe · Pin to · Set as featured · File menu
   - Insert: + Add a tile (opens widget picker for Web content / Image / Text box / Video / Real-time)
   - View: Phone view · Web view · Focus · Print · Comments toggle
   - Wire each to real SDK events or REST calls (or deep-link to PBI service for widget-create where REST is not available — surface MessageBar explaining the limitation per no-vaporware.md).
5. Wire CloneTile via REST: POST /v1.0/myorg/groups/{ws}/dashboards/{id}/tiles/{tileId}/Clone with CloneTileRequest body.
6. Add a Q&A bar at top of canvas (powerbi-client supports an embeddable Q&A component).
7. Add honest MessageBars per no-vaporware.md:
   - "Tile widgets (Web content / Image / Text box / Video) have no public REST API. Use 'Edit in Power BI' to add these via the service UI."
   - "Embed requires Fabric/Premium capacity + tenant settings 'Embed content in apps' + SP in PBI security group."
8. Bicep: same Fabric capacity + workspace-assignment requirements as Report editor.
9. Tests: Playwright probe that asserts iframe src includes app.powerbi.com/dashboardEmbed and tile-click fires focus mode.

Estimated effort to grade B: 2-3 sessions (embed dashboard + correct ribbon + CloneTile + honest gates). Grade A adds widget-picker + Q&A bar + Comments pane.
