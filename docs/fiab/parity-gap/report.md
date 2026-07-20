<!-- parity-doc-meta
Reviewed-on: 2026-07-20
Validated-against:
  - apps/fiab-console/lib/editors/phase3/report-editor.tsx
  - apps/fiab-console/lib/editors/report-designer.tsx
  - apps/fiab-console/lib/components/embed/powerbi-embed.tsx
  - apps/fiab-console/app/api/items/report/[id]/embed-token/route.ts
  - apps/fiab-console/app/api/items/report/route.ts
-->

# Loom Report — parity with Power BI report authoring

> **RE-BASELINED 2026-07-20** (rev `9ad350d3`, code-path refresh). The 2026-05-26
> capture retained below graded this surface `D` ("powerbi-client NOT INSTALLED",
> "no panes", "embed lands in v2.2", 7 dead ribbon buttons) and is **stale in
> every headline claim** — the report item now opens a full Loom-native report
> designer. A live click-walk re-certification (per `no-scaffold`) is still owed
> before stamping a fresh A grade.

## Current state (code-grounded, 2026-07-20)

The report item opens the **Loom-native report designer**, not a metadata browser.
`lib/editors/phase3/report-editor.tsx` resolves to `ReportDesigner`
(`LoomNativeReportEditor → ReportDesigner`; import `:42`, active editor `:1145`).
The designer (`lib/editors/report-designer.tsx`, ~5,135 LOC) is the Azure-native
default: it queries a **bound Azure Analysis Services tabular model with DAX**
(`POST …/query`) and needs **no Power BI or Fabric workspace**. A live Power BI
embed is the **opt-in** alternative.

Corrections to the 2026-05-26 matrix (each verified in code):

| 2026-05-26 claim | Current reality |
|---|---|
| `powerbi-client` NOT INSTALLED | **Installed** — `powerbi-client ^2.23.1` + `powerbi-client-react ^2.0.2` (`package.json`). |
| No embed / "lands in v2.2" placeholder | **`PowerBIEmbed`** (`lib/components/embed/powerbi-embed.tsx`); embed token minted by **`app/api/items/report/[id]/embed-token/route.ts`** (GenerateToken). |
| Visualizations / Fields / Format panes MISSING | **Present** in `report-designer.tsx` (Visualizations, Fields wells, Format pane, DAX-backed live visuals). |
| Ribbon = Home only; Insert/Modeling/View MISSING | **Insert** (and further tabs) present in the designer ribbon. |
| Ribbon buttons are dead labels (7 BROKEN) | Designer controls wired to the DAX/AAS data path (real rows), not `{ label }`-only no-ops. |
| Only working surface = metadata card | The primary surface is now the authoring canvas; list + detail remain real. |

**Run-path (`temp/runpath-verdicts-2026-07-20.md`):** `report` → **B** (honest `412`
when no model bound; **real GROUP BY rows** once bound). Sibling `paginated-report`
→ **A** (real RDL: DataSource + DataSet + Tablix over `loom_sales_wide`).

**Remaining residuals:** live click-walk certification (dark+light, every control)
not re-done in this doc-currency pass; Q&A NL + full bookmark/selection navigator
parity to confirm against the designer.

---

<details>
<summary>Historical capture — 2026-05-26 (superseded, kept for provenance)</summary>

The rows below graded the surface **D** and are retained only to show what changed.
Do NOT cite their "MISSING"/"BROKEN" claims as current — they were remediated by the
report-designer + AAS + PBI-embed work (report auto-bind #2002; Fabric-parity /
report-catalog waves). Original source under review then:
`apps/fiab-console/lib/editors/phase3-editors.tsx:1540-1641`.

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

</details>
