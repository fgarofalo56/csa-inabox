# Loom Power BI Report — Fabric parity gap

> **Validator: v2 4-phase (live browser) — 2026-05-26**
> Loom URL: https://loom-console-fvbbctd4eehqbkcs.b02.azurefd.net/items/report/new
> Fabric reference: app.powerbi.com / app.fabric.microsoft.com (login-gated; spec-derived from docs/fiab/report-parity-spec.md)
> Screenshot: temp/parity/report-loom.png
> Source under review: apps/fiab-console/lib/editors/phase3-editors.tsx lines 1540-1641

## Phase 1 + 2 captures
Live Loom DOM (heading + ribbon):
- Heading: "New report"
- Ribbon tab: Home only (vs Fabric: Home + Insert + Modeling + View + Help)
- Ribbon buttons: New page, Duplicate, New visual, Format, Bookmark, Refresh, Filters, plus toolbar Refresh
- <iframe> count: 0 (NO embedded Power BI report)
- Monaco editor: NO
- Visualizations / Fields / Filters / Format panes: NONE present
- Fluent MessageBar: 0 (no honest gate)
- powerbi-client SDK in package.json: NOT INSTALLED

## Phase 3 gap matrix
| Fabric element | Loom present? | Severity | Notes |
|---|---|---|---|
| Embedded Power BI report canvas (live, via powerbi-client SDK + GenerateToken) | MISSING | BLOCKER | The headline feature. Placeholder card text reads "v2.1: showing metadata only — full embed via Power BI Embed SDK lands in v2.2." (phase3-editors.tsx:1625) |
| Visualizations pane (20+ visual types) | MISSING | BLOCKER | — |
| Fields (Data) pane | MISSING | BLOCKER | — |
| Filters pane (three-tier) | label-only | BLOCKER | "Filters" button has no handler |
| Format pane (paint-brush) | label-only | BLOCKER | "Format" button has no handler |
| Pages tabs + + button | MISSING | BLOCKER | "New page" label does nothing |
| Ribbon Insert tab | MISSING | MAJOR | — |
| Ribbon Modeling tab | MISSING | MAJOR | — |
| Ribbon View tab | MISSING | MAJOR | — |
| Save / Undo / Redo / Share | MISSING | MAJOR | None present |
| Q&A natural language | MISSING | MAJOR | — |
| Bookmark / Selection / Navigator panes | label-only Bookmark | MAJOR | — |
| Ribbon Help tab | MISSING | MINOR | — |
| Report listing (left rail) | PRESENT | — | loadList wired to /api/items/report — real PBI REST |
| Report metadata card | PRESENT | — | loadDetail wired to /api/items/report/{id} (1615-1622). Only working surface. |
| embedUrl shown as plain code | PRESENT but worse than missing | MAJOR | Loom prints the embedUrl as TEXT instead of embedding the report. Vaporware pattern per no-vaporware.md |

## Phase 4 click-every-button
| Button | Expected | Observed | Status |
|---|---|---|---|
| New page | new page | nothing | BROKEN — primary no-op |
| Duplicate | duplicate page | nothing | BROKEN |
| New visual | visual picker | nothing | BROKEN |
| Format | Format pane | nothing | BROKEN |
| Bookmark | Bookmark pane | nothing | BROKEN |
| Filters | Filters pane | nothing | BROKEN |
| Refresh (ribbon Data group) | refresh | nothing | BROKEN |
| Refresh (toolbar) | reload list | wired loadList | OK (gated on workspaceId) |
| workspace picker | fetch reports | triggers MSAL redirect when scope not consented | partial |

Root cause: REPORT_RIBBON (line 1543) declares RibbonAction entries with only { label }, no onClick. Ribbon component spreads ...rest → Button has no handler.

## Fair-where-due
BFF is real:
- /api/items/report → listReports() against real Power BI REST /v1.0/myorg/groups/{ws}/reports
- /api/items/report/{id} → getReport() returns name, type, datasetId, webUrl, embedUrl, modifiedBy/At

So listing is honest. The editor surface itself is a metadata browser plus dead labels.

## Final grade: D
Phase 3 has 7 BLOCKER rows + multiple MAJOR. Phase 4 has 7 BROKEN primary controls. The "embed lands in v2.2" placeholder is a no-vaporware.md violation (no tracked TODO, surrounded by dead buttons pretending to be a real editor).

## Remediation
1. Install powerbi-client + powerbi-client-react in apps/fiab-console/package.json.
2. Add BFF route POST /api/items/report/{id}/embed-token calling Power BI REST POST /v1.0/myorg/groups/{ws}/reports/{id}/GenerateToken with accessLevel 'view' (then 'edit'). Cache token client-side until ~5 min before expiry.
3. Replace the "Embed preview" placeholder (phase3-editors.tsx:1623-1628) with <PowerBIEmbed> passing embedUrl + accessToken + reportId. embedType:'report', tokenType:models.TokenType.Embed.
4. Wire ribbon buttons to SDK events:
   - New page → report.addPage(name)
   - Format → setVisualEditMode(true)
   - Filters → updateSettings({ filterPaneEnabled: true })
   - New visual → report.createVisual(...)
   - Bookmark → report.bookmarksManager.capture()
5. Add honest MessageBars per no-vaporware.md for tenant gates (capacity assignment, "Embed content in apps" tenant setting, SP in PBI security group).
6. Bicep: add Microsoft.Fabric/capacities module + workspace-to-capacity assignment. Document tenant-admin settings in docs/fiab/v3-tenant-bootstrap.md.
7. Vitest/Playwright coverage: mock GenerateToken, assert iframe src matches app.powerbi.com/reportEmbed.

Estimated effort to grade B: 2 sessions. Grade A adds Loom-chrome panes wrapping embed SDK events.
