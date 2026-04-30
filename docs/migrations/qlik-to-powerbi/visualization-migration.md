---
title: "Qlik to Power BI Visualization Migration"
description: "Chart-by-chart mapping from Qlik Sense visualizations to Power BI visuals — native charts, extensions, selection model adaptation, and storytelling."
---

# Qlik to Power BI: Visualization Migration

**Audience:** Report developers, UX designers, BI leads
**Purpose:** Map every Qlik Sense chart type and interaction pattern to its Power BI equivalent
**Reading time:** 15-20 minutes

---

## 1. Chart type mapping

### 1.1 Native Qlik charts to Power BI visuals

| Qlik Sense chart                | Power BI equivalent                           | Fidelity | Notes                                                                     |
| ------------------------------- | --------------------------------------------- | -------- | ------------------------------------------------------------------------- |
| Bar chart (vertical/horizontal) | Clustered bar / Clustered column chart        | High     | Direct mapping; Power BI separates vertical (column) and horizontal (bar) |
| Stacked bar chart               | Stacked bar / Stacked column chart            | High     | Direct mapping                                                            |
| Line chart                      | Line chart                                    | High     | Direct mapping; Power BI adds forecast, trend lines via Analytics pane    |
| Area chart                      | Area chart                                    | High     | Direct mapping                                                            |
| Combo chart (bar + line)        | Line and clustered column chart               | High     | Direct mapping with dual Y-axis support                                   |
| Pie chart                       | Pie chart                                     | High     | Direct mapping                                                            |
| Donut chart                     | Donut chart                                   | High     | Direct mapping                                                            |
| Scatter plot                    | Scatter chart                                 | High     | Power BI adds play axis for time animation                                |
| KPI object                      | Card visual / KPI visual                      | High     | KPI visual includes trend indicator; Card is simpler                      |
| Gauge chart                     | Gauge visual                                  | High     | Direct mapping with min/max/target                                        |
| Pivot table                     | Matrix visual                                 | High     | Matrix supports expand/collapse rows, conditional formatting              |
| Straight table (flat table)     | Table visual                                  | High     | Direct mapping with data bars, sparklines, conditional formatting         |
| Treemap                         | Treemap                                       | High     | Direct mapping                                                            |
| Waterfall chart                 | Waterfall chart                               | High     | Native in Power BI                                                        |
| Funnel chart                    | Funnel chart                                  | High     | Direct mapping                                                            |
| Histogram                       | Histogram (custom visual or binning)          | Medium   | Use "New group" binning on a column, then bar chart                       |
| Box plot                        | Box and Whisker (AppSource custom visual)     | Medium   | Available as certified custom visual on AppSource                         |
| Distribution plot               | Histogram or violin (custom visual)           | Medium   | Custom visual required for violin/density plots                           |
| Bullet chart                    | Bullet chart (AppSource custom visual)        | Medium   | Available on AppSource                                                    |
| Mekko / Marimekko chart         | Marimekko (AppSource) or stacked bar          | Medium   | AppSource has Marimekko visuals; stacked bar is the native fallback       |
| Network chart (extension)       | Force-directed graph (AppSource)              | Medium   | Multiple network/graph visuals on AppSource                               |
| Sankey chart (extension)        | Sankey (AppSource)                            | Medium   | Available as certified custom visual on AppSource                         |
| Word cloud (extension)          | Word Cloud (AppSource)                        | High     | Available on AppSource                                                    |
| Org chart (extension)           | Org Chart (AppSource) or Decomposition Tree   | Medium   | Decomposition Tree provides similar drill-down hierarchy                  |
| Calendar heatmap (extension)    | Heatmap or Matrix with conditional formatting | Medium   | Matrix with background color formatting achieves calendar heatmap         |
| Radar chart (extension)         | Radar chart (AppSource)                       | Medium   | Available on AppSource                                                    |
| Multi-KPI (extension)           | Multi-row card                                | High     | Multi-row card displays multiple KPIs in a compact layout                 |

### 1.2 Custom/advanced Qlik visuals

| Qlik visual                       | Power BI approach                                 |
| --------------------------------- | ------------------------------------------------- |
| Nebula.js custom extension        | Power BI custom visual SDK (TypeScript, D3.js)    |
| Qlik Sense mashup (HTML page)     | Power BI Embedded (JavaScript SDK, React wrapper) |
| SPC (statistical process control) | SPC chart custom visual on AppSource              |
| Variance waterfall                | Variance chart custom visual on AppSource         |
| Timeline / Gantt                  | Gantt chart custom visual on AppSource            |
| HTML extension (custom rendering) | Power BI HTML content visual or R/Python visual   |
| Video extension                   | Web URL visual (embed video)                      |
| On-demand drill (ODAG link)       | Drillthrough page + parameterized DirectQuery     |

---

## 2. Selection model adaptation

The Qlik selection model (green/white/gray) is one of the hardest UX patterns to replicate in Power BI. This section provides practical alternatives.

### 2.1 Selection state comparison

| Qlik selection state    | Meaning                         | Power BI equivalent                                |
| ----------------------- | ------------------------------- | -------------------------------------------------- |
| Green (selected)        | User has selected this value    | Slicer shows selected item highlighted             |
| White (possible)        | Value exists in associated data | Other visuals show filtered data (cross-filtering) |
| Gray (excluded)         | Value has no associated data    | No direct equivalent -- excluded values are hidden |
| Dark gray (alternative) | Not selected but could be       | No direct equivalent                               |

### 2.2 Recreating the selection experience

**Strategy 1: Slicer panels**

Create a slicer panel on the left or top of the report with slicers for each dimension. Use slicer sync to propagate selections across pages.

**Strategy 2: Cross-filtering and cross-highlighting**

Power BI's default interaction behavior is cross-highlighting: clicking a bar in a chart highlights related data in other visuals. Configure via "Edit Interactions" to switch between filter and highlight modes.

**Strategy 3: Filter pane**

The Power BI filter pane shows all active filters at visual, page, and report levels. This replaces the Qlik selection bar for showing "what is currently filtered."

**Strategy 4: Reset button**

Add a "Clear All Filters" bookmark button to reset the report to its default state, similar to Qlik's "Clear All" selection button.

```
// To create a reset button:
// 1. Set all slicers to default state
// 2. Create a bookmark "Default State" capturing this state
// 3. Add a Button visual, set Action = Bookmark, choose "Default State"
```

**Strategy 5: Selection display visual**

For users who miss the Qlik current-selections bar, create a card or text visual with a DAX measure that shows active filter context:

```dax
Active Filters Text =
VAR SelectedRegion = IF(ISFILTERED(Geography[Region]),
    "Region: " & SELECTEDVALUE(Geography[Region], "Multiple"),
    "")
VAR SelectedYear = IF(ISFILTERED(Calendar[Year]),
    "Year: " & SELECTEDVALUE(Calendar[Year], "Multiple"),
    "")
RETURN
COMBINEVALUES(" | ", SelectedRegion, SelectedYear)
```

---

## 3. Container and conditional visibility

### Qlik containers

Qlik containers allow multiple objects to occupy the same space, with tabs or conditions controlling which is visible. Common patterns:

- Tabbed containers (show different charts in the same area)
- Conditional show (show/hide based on selections)

### Power BI equivalents

**Bookmarks + buttons (tabbed container replacement):**

1. Create visual A and visual B in the same position on the canvas
2. Create Bookmark "Show A" with visual A visible, visual B hidden
3. Create Bookmark "Show B" with visual A hidden, visual B visible
4. Add Button visuals labeled "View A" and "View B" that navigate to the respective bookmarks
5. Uncheck "Data" in each bookmark to preserve filter state when toggling

**Conditional formatting (conditional show replacement):**

Use the "Title" or entire visual's visibility based on a measure:

1. Select the visual
2. In Format pane, go to General > Properties
3. Set visibility to "Based on a field" and reference a DAX measure that returns TRUE/FALSE

---

## 4. Alternate states to bookmarks

### Qlik alternate states

Qlik alternate states allow a single sheet to show the same visualization with two different selection states side-by-side (for example, comparing Region A vs Region B).

### Power BI comparison patterns

**Pattern 1: What-If parameter + duplicate measure**

```dax
// Create a What-If parameter "Comparison Region" with region values
// Then create a comparison measure:
Comparison Sales =
CALCULATE(
    SUM(Sales[Amount]),
    Geography[Region] = SELECTEDVALUE('Comparison Region'[Comparison Region])
)
```

**Pattern 2: Field parameters (2023+)**

Field parameters allow users to dynamically switch which measure or dimension a visual displays, providing some of the flexibility of alternate states.

**Pattern 3: Bookmarks for snapshot comparison**

Create two bookmarks with different slicer states and use a toggle button to switch between them.

---

## 5. Storytelling to report navigation

### Qlik storytelling

Qlik's storytelling feature lets users create guided narratives by arranging snapshots of visualizations with annotations into a sequential story format.

### Power BI equivalents

| Qlik storytelling feature     | Power BI equivalent                                      |
| ----------------------------- | -------------------------------------------------------- |
| Story (multi-slide narrative) | Report with page navigator bar                           |
| Snapshot of visualization     | Pin visual to dashboard or use PowerPoint integration    |
| Annotations on snapshots      | Text boxes on report pages                               |
| Slide transitions             | Page navigation buttons                                  |
| Presentation mode             | Full-screen mode / PowerPoint with live Power BI visuals |
| Narration text                | Smart Narratives visual (AI-generated text)              |

**Recommended approach:** Use PowerPoint with live Power BI visuals for presentation scenarios. Visuals update in real-time during the presentation -- no snapshots needed.

---

## 6. Responsive design and mobile

### Qlik responsive layouts

Qlik Sense uses a responsive grid layout that adapts to screen size automatically. Visualizations resize within the grid.

### Power BI mobile layout

Power BI has a dedicated mobile layout editor:

1. In Power BI Desktop, select View > Mobile Layout
2. Drag visuals from the desktop layout onto the phone canvas
3. Resize and arrange for optimal mobile viewing
4. Publish -- mobile users automatically see the mobile layout

Power BI Mobile app features not available in Qlik:

- Offline access to reports (configured per report)
- QR code scanning to open specific reports
- Annotate and share screenshots from mobile
- Push notifications for data alerts

---

## 7. Formatting and theming

### Qlik themes

Qlik uses JSON-based themes that control colors, fonts, and visual styling across an app.

### Power BI themes

Power BI also uses JSON-based themes with broader customization:

```json
{
    "name": "Corporate Theme",
    "dataColors": ["#0078D4", "#50E6FF", "#FFB900", "#E74856", "#00CC6A"],
    "background": "#FFFFFF",
    "foreground": "#252423",
    "tableAccent": "#0078D4",
    "textClasses": {
        "callout": { "fontSize": 36, "fontFace": "Segoe UI" },
        "title": { "fontSize": 16, "fontFace": "Segoe UI Semibold" },
        "header": { "fontSize": 12, "fontFace": "Segoe UI" },
        "label": { "fontSize": 10, "fontFace": "Segoe UI" }
    }
}
```

Apply themes in Power BI Desktop via View > Themes > Browse for Themes.

### Conditional formatting

Power BI's conditional formatting is more granular than Qlik's:

| Formatting type              | Qlik support           | Power BI support                   |
| ---------------------------- | ---------------------- | ---------------------------------- |
| Background color by value    | Yes (expression-based) | Yes (rules, gradient, field value) |
| Font color by value          | Yes (expression-based) | Yes (rules, gradient, field value) |
| Data bars in table           | Limited                | Yes (built-in data bar formatting) |
| Icons in table (KPI symbols) | Via extensions         | Yes (built-in icon sets)           |
| Sparklines in table          | Via extensions         | Yes (native sparklines since 2022) |
| Web URL (clickable links)    | Yes (URL action)       | Yes (web URL data category)        |
| Image in table               | Via HTML extension     | Yes (image URL data category)      |

---

## 8. Visualization migration checklist

- [ ] **Inventory all sheet objects** -- list every visualization, its type, its expressions, and its dimensions
- [ ] **Map to Power BI visual types** -- use the chart mapping table in Section 1
- [ ] **Identify custom extensions** -- check AppSource for equivalents; plan custom visual development if needed
- [ ] **Plan the selection model** -- decide how to replace green/white/gray with slicers + cross-filtering
- [ ] **Design the page layout** -- Power BI uses a fixed canvas (16:9 or custom); plan layout before building
- [ ] **Build from semantic model measures** -- all calculations should be in the semantic model, not the visual
- [ ] **Apply corporate theme** -- create a Power BI JSON theme matching organizational branding
- [ ] **Configure interactions** -- set Edit Interactions (filter vs highlight) for each visual pair
- [ ] **Create mobile layout** -- design the mobile view for each report page
- [ ] **Validate visual accuracy** -- compare Qlik and Power BI visuals side-by-side with same data and filters

---

## Cross-references

| Topic                            | Document                                         |
| -------------------------------- | ------------------------------------------------ |
| Expression conversion            | [Expression Migration](expression-migration.md)  |
| Feature mapping (visualization)  | [Feature Mapping](feature-mapping-complete.md)   |
| Tutorial: full app migration     | [Tutorial: App to PBIX](tutorial-app-to-pbix.md) |
| Best practices for report design | [Best Practices](best-practices.md)              |

---

**Maintainers:** CSA-in-a-Box core team
**Last updated:** 2026-04-30
