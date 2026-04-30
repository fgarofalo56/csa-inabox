# Visualization Migration: Tableau to Power BI

**A chart-by-chart migration guide covering visual type mapping, dashboard actions, formatting, and best practices for visual fidelity.**

---

## Guiding principle

Do not replicate Tableau dashboards pixel-for-pixel. Tableau's mark-based rendering model and Power BI's field-based visual model are fundamentally different paradigms. Instead, identify the analytical intent of each visualization and implement it using Power BI's native strengths. This document maps every common Tableau chart type to its Power BI equivalent and provides guidance on where to redesign rather than replicate.

---

## 1. Chart type mapping

### 1.1 Charts with direct equivalents

These chart types have native Power BI visuals that are functionally identical to their Tableau counterparts. Migration is straightforward.

| Tableau chart type          | Power BI visual                    | Migration notes                                                    |
| --------------------------- | ---------------------------------- | ------------------------------------------------------------------ |
| **Bar chart** (horizontal)  | Clustered bar chart                | Direct mapping. Drag category to Y axis, measure to X axis         |
| **Column chart** (vertical) | Clustered column chart             | Direct mapping. Category on X, measure on Y                        |
| **Stacked bar/column**      | Stacked bar/column                 | Add a legend field for the stack                                   |
| **100% stacked bar/column** | 100% stacked bar/column            | Direct mapping                                                     |
| **Line chart**              | Line chart                         | Direct mapping. Power BI supports markers, step lines, line styles |
| **Area chart**              | Area chart                         | Direct mapping. Stacked and 100% stacked variants available        |
| **Scatter plot**            | Scatter chart                      | Direct mapping. Power BI adds Play axis for time animation         |
| **Pie chart**               | Pie chart                          | Direct mapping. Consider donut or treemap instead                  |
| **Donut chart**             | Donut chart                        | Direct mapping                                                     |
| **Treemap**                 | Treemap                            | Direct mapping                                                     |
| **Waterfall**               | Waterfall chart                    | Native in Power BI. Supports category and breakdown                |
| **Funnel**                  | Funnel chart                       | Direct mapping                                                     |
| **KPI card**                | Card / Multi-row card / KPI visual | Card for single metric, KPI visual for target comparison           |
| **Text table** (crosstab)   | Matrix visual                      | Direct mapping. Supports row/column hierarchies, subtotals         |
| **Highlight table**         | Matrix with conditional formatting | Apply background color rules based on measure values               |

### 1.2 Charts requiring configuration

These chart types exist in Power BI but require specific configuration to match Tableau behavior.

| Tableau chart type            | Power BI visual                                           | Configuration needed                                                                             |
| ----------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| **Dual-axis chart**           | Combo chart (line + clustered column)                     | Add measures to both Column values and Line values wells. Enable secondary Y axis in format pane |
| **Combined axis**             | Combo chart                                               | Same visual, multiple measures on shared or split axes                                           |
| **Small multiples (trellis)** | Any chart + Small multiples field                         | Drag a category field to the Small multiples well. Available on most chart types since 2021      |
| **Reference line**            | Analytics pane → Constant line / Average / Median / Trend | Open Analytics pane on the visual, add the desired reference                                     |
| **Reference band**            | Analytics pane → Error bars or constant lines             | Use two constant lines to create a band effect                                                   |
| **Histogram**                 | Column chart with binned field                            | Create a bin on the numeric field (right-click → New Group), then chart the bin                  |
| **Filled map (choropleth)**   | Filled map visual                                         | Drag location to Location, measure to Color saturation                                           |
| **Symbol map (point map)**    | Map visual                                                | Drag latitude/longitude or location fields, measure to Size                                      |
| **Circle view**               | Scatter chart (without lines)                             | Use scatter chart with category on Details, no lines                                             |
| **Side-by-side bars**         | Clustered bar/column chart                                | Add a legend field to create side-by-side groups                                                 |

### 1.3 Charts requiring custom visuals or alternatives

These Tableau chart types do not have native Power BI equivalents. Use AppSource custom visuals or alternative approaches.

| Tableau chart type       | Power BI solution                      | Where to find / how to implement              |
| ------------------------ | -------------------------------------- | --------------------------------------------- |
| **Box-and-whisker plot** | Custom visual: "Box and Whisker"       | AppSource → search "Box and Whisker"          |
| **Gantt chart**          | Custom visual: "Gantt" by MAQ Software | AppSource → search "Gantt"                    |
| **Packed bubble chart**  | Custom visual or treemap alternative   | AppSource → "Packed Bubble" or use treemap    |
| **Bullet chart**         | Custom visual: "Bullet Chart"          | AppSource → search "Bullet Chart"             |
| **Lollipop chart**       | Custom visual: "Lollipop Chart"        | AppSource → search "Lollipop"                 |
| **Bump chart**           | Line chart with rank measure           | Calculate rank per period, plot as line chart |
| **Radial chart**         | Custom visual                          | AppSource → search "Radial"                   |
| **Hex bin plot**         | R or Python visual                     | Use R ggplot2 or Python matplotlib            |
| **Density plot**         | R or Python visual                     | Use R ggplot2 density or Python seaborn       |
| **Sankey diagram**       | Custom visual: "Sankey"                | AppSource → search "Sankey"                   |
| **Chord diagram**        | Custom visual: "Chord"                 | AppSource → search "Chord"                    |

!!! tip "AppSource has 300+ custom visuals"
Before concluding that a chart type is not available in Power BI, search AppSource. Most exotic chart types have community or partner-built visuals. Evaluate for your organization's security and certification requirements before deploying.

---

## 2. Marks and encoding channels

Tableau's mark-based model uses six encoding channels: Color, Size, Shape, Detail, Label, and Tooltip. Power BI uses visual-specific wells. Here is the mapping:

### 2.1 Mark encoding to Power BI wells

| Tableau mark property           | Power BI equivalent                             | How to implement                                                              |
| ------------------------------- | ----------------------------------------------- | ----------------------------------------------------------------------------- |
| **Color** (continuous gradient) | Color saturation well or conditional formatting | Drag measure to Color saturation; or use conditional formatting on the visual |
| **Color** (categorical)         | Legend well                                     | Drag category to Legend to assign colors per category                         |
| **Size** (bubble size)          | Size well (scatter chart)                       | Drag measure to Size well on scatter chart                                    |
| **Shape** (mark shape)          | Not directly available on most visuals          | Scatter chart supports limited shapes via custom visuals                      |
| **Detail** (disaggregate data)  | No direct equivalent                            | Add field to Tooltips well or create a more granular visual                   |
| **Label** (data labels)         | Data labels toggle in format pane               | Turn on data labels; configure position, font, format                         |
| **Tooltip** (hover information) | Tooltips well + Report page tooltips            | Drag fields to Tooltips well; create tooltip pages for rich hover             |

### 2.2 The Detail shelf problem

Tableau's Detail shelf is unique: it disaggregates data points without affecting the visual's appearance. For example, adding Customer ID to Detail on a scatter plot creates one dot per customer without changing axes. Power BI does not have a direct equivalent. Solutions:

1. **Add the field to Tooltips well** — the visual aggregates to the right level but shows the detail on hover
2. **Use the "Don't summarize" option** — for tables/matrices, show raw rows
3. **Create a calculated measure** — aggregate to the desired level explicitly in DAX
4. **Accept the design difference** — Power BI visuals aggregate by default; embrace this rather than fight it

---

## 3. Dashboard actions to Power BI interactions

### 3.1 Filter and highlight actions

| Tableau action                                         | Power BI equivalent  | How to configure                                                                                                                   |
| ------------------------------------------------------ | -------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| **Filter action** (click visual A to filter visual B)  | Cross-filtering      | Default behavior. To customize: select visual A → Format → Edit Interactions → choose Filter/Highlight/None for each target visual |
| **Highlight action** (click to highlight related data) | Cross-highlighting   | Default behavior. Toggle between filter and highlight in Edit Interactions                                                         |
| **Filter action with specific fields**                 | Drillthrough         | Create a drillthrough page with the detail fields. Right-click a data point → Drillthrough → target page                           |
| **Exclude action** (click to exclude data)             | No direct equivalent | Use slicers with exclude mode; or create a DAX measure for dynamic exclusion                                                       |

### 3.2 Navigation actions

| Tableau action                      | Power BI equivalent        | How to configure                                                     |
| ----------------------------------- | -------------------------- | -------------------------------------------------------------------- |
| **Go to Sheet action**              | Page navigation button     | Insert → Button → set Action to Page navigation → select target page |
| **URL action**                      | Button with Web URL action | Insert → Button → set Action to Web URL → use DAX for dynamic URL    |
| **URL action** (open external link) | Web URL visual or button   | Embed a web page or add a clickable button                           |

### 3.3 Set and parameter actions

| Tableau action                                      | Power BI equivalent           | How to configure                                                           |
| --------------------------------------------------- | ----------------------------- | -------------------------------------------------------------------------- |
| **Set action** (click to add/remove from set)       | Slicer + bookmark combination | Create bookmarks that apply different slicer states; use buttons to toggle |
| **Parameter action** (click to set parameter value) | Field parameter with slicer   | Create a field parameter, expose as slicer, use in measures                |
| **Parameter action** (change measure dynamically)   | Field parameter               | Create a field parameter with multiple measures; slicer lets user switch   |

!!! warning "Set actions are Power BI's biggest interaction gap"
Tableau set actions are powerful: click a data point and it gets added to a set that dynamically filters other visuals. Power BI has no direct equivalent. The closest workaround is a combination of bookmarks, buttons, and DAX logic. If your Tableau dashboard relies heavily on set actions, plan extra redesign time.

---

## 4. Maps and geospatial

### 4.1 Map type mapping

| Tableau map type              | Power BI equivalent                   | When to use                                               |
| ----------------------------- | ------------------------------------- | --------------------------------------------------------- |
| **Symbol map** (dots on map)  | Map visual                            | Default for point-level data with lat/long or place names |
| **Filled map** (choropleth)   | Filled map visual                     | Color regions by measure value                            |
| **Density map** (heat map)    | Azure Maps visual (heat map layer)    | Requires Azure Maps visual from AppSource                 |
| **Dual-axis map** (layers)    | Azure Maps visual (multiple layers)   | Azure Maps supports multiple data layers                  |
| **Custom geocoding**          | Shape map                             | Upload custom TopoJSON for non-standard boundaries        |
| **Mapbox background**         | Azure Maps visual (satellite/terrain) | Azure Maps provides satellite, terrain, and road basemaps |
| **Spatial file** (.shp, .kml) | Shape map with TopoJSON               | Convert spatial files to TopoJSON format                  |

### 4.2 Map migration recommendations

1. **Start with the built-in Map visual** for simple point and filled maps
2. **Use Azure Maps visual** for advanced scenarios (multiple layers, heat maps, custom tile layers)
3. **Use Shape map** for custom geographic boundaries (sales territories, custom regions)
4. **Use ArcGIS Maps for Power BI** for enterprise GIS requirements (requires ArcGIS license)
5. **Convert custom geocoding tables** to Power BI's map visual-friendly format (country, state, city, postal code, lat/long)

---

## 5. Formatting comparison

### 5.1 Key formatting differences

| Formatting feature         | Tableau                                 | Power BI                                                     | Notes                                                                                  |
| -------------------------- | --------------------------------------- | ------------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| **Font control**           | Full control per element                | Format pane per visual                                       | Similar capability; Power BI has more formatting options per visual in recent releases |
| **Color palettes**         | Built-in + custom (hex)                 | Built-in + custom (hex) + themes                             | Power BI themes provide organization-wide consistency                                  |
| **Borders and dividers**   | Borders on worksheets                   | Borders on visuals                                           | Similar capability                                                                     |
| **Background images**      | Dashboard background image              | Report background image or page wallpaper                    | Similar capability                                                                     |
| **Gridlines**              | Configurable per axis                   | Configurable per axis                                        | Similar                                                                                |
| **Number formatting**      | Format pane per field                   | Format pane or DAX FORMAT                                    | DAX FORMAT provides more control                                                       |
| **Conditional formatting** | Color encoding on marks                 | Conditional formatting rules (background, font, icons, bars) | Power BI is more flexible: rules, gradient, field-based                                |
| **Responsive layout**      | Dashboard size: automatic, range, fixed | Report canvas: fixed size (default) or responsive            | Power BI supports multiple page sizes; mobile layout is separate                       |

### 5.2 Power BI themes

Power BI themes (JSON files) provide organization-wide formatting consistency that Tableau does not natively support. Create a theme file with your brand colors, fonts, and defaults. Apply it to all reports for a consistent look.

```json
{
    "name": "Organization Theme",
    "dataColors": ["#1F77B4", "#FF7F0E", "#2CA02C", "#D62728"],
    "background": "#FFFFFF",
    "foreground": "#333333",
    "tableAccent": "#1F77B4",
    "visualStyles": {
        "*": {
            "*": {
                "title": [
                    {
                        "fontFamily": "Segoe UI",
                        "fontSize": 14
                    }
                ]
            }
        }
    }
}
```

---

## 6. Layout and composition

### 6.1 Tableau dashboard layout vs Power BI report page

| Concept                 | Tableau                                              | Power BI                                             |
| ----------------------- | ---------------------------------------------------- | ---------------------------------------------------- |
| **Canvas**              | Dashboard with tiled or floating layout              | Report page with free-form positioning               |
| **Containers**          | Horizontal/vertical containers for responsive layout | No containers; use alignment guides and snap-to-grid |
| **Multiple dashboards** | Multiple dashboard tabs in a workbook                | Multiple pages in a report                           |
| **Blank space**         | Blank objects                                        | Empty space between visuals                          |
| **Show/hide**           | Container show/hide with buttons                     | Bookmarks + buttons (toggle visibility)              |
| **Device-specific**     | Device layouts (desktop, tablet, phone)              | Mobile layout (separate from desktop)                |

### 6.2 Bookmark-based interactivity

Power BI bookmarks replace several Tableau dashboard features:

- **Show/hide containers** → Bookmarks that toggle visual visibility
- **Swap sheets** → Bookmarks that show different visuals in the same position
- **Story navigation** → Bookmark navigator with prev/next buttons
- **Reset filters** → Bookmark that captures default slicer state

```
// To create a show/hide panel:
// 1. Create the panel visuals
// 2. Create Bookmark A with panel hidden
// 3. Create Bookmark B with panel visible
// 4. Add a button that toggles between Bookmark A and B
```

---

## 7. Best practices for visual migration

### 7.1 Redesign, do not replicate

The most common migration mistake is opening a Tableau workbook and trying to recreate the exact same layout in Power BI. Instead:

1. **Document the analytical questions** the Tableau dashboard answers
2. **Identify the key metrics and dimensions** used
3. **Design the Power BI report for Power BI's strengths**: clean semantic models, Copilot, cross-filtering, drillthrough, bookmarks
4. **Accept visual differences** — Power BI's default styling is different and that is acceptable

### 7.2 Leverage Power BI-specific features

Features Power BI has that Tableau does not:

- **Report page tooltips** — rich, multi-visual hover panels
- **Drillthrough pages** — click any data point to navigate to a detail page with context
- **Buttons and bookmarks** — create interactive navigation without code
- **Q&A visual** — embed a natural language query box in the report
- **Key Influencers visual** — AI-driven root cause analysis
- **Decomposition Tree** — interactive hierarchical breakdown
- **Smart Narratives** — AI-generated text summaries of visuals
- **Paginated reports** — pixel-perfect print-ready output

### 7.3 Handling visuals with no direct equivalent

For Tableau visualizations that use mark types or encoding channels with no Power BI equivalent:

1. **Check AppSource** — search for the chart type; there are 300+ custom visuals
2. **Consider R/Python visuals** — for statistical charts (density, violin, etc.), use R ggplot2 or Python matplotlib within a Power BI R/Python visual
3. **Redesign the question** — if the chart type is exotic, ask whether a simpler chart type answers the same question more effectively
4. **Accept the trade-off** — some Tableau-specific visualizations (packed bubbles, advanced dual-axis configurations) may need a different visual approach in Power BI

### 7.4 Validation checklist

After migrating each visualization:

- [ ] Numbers match between Tableau and Power BI at the same aggregation level
- [ ] Filters and slicers produce the same results
- [ ] Cross-filtering behavior is correct (Edit Interactions configured)
- [ ] Data labels are visible and formatted correctly
- [ ] Conditional formatting matches business rules
- [ ] Tooltips display the expected detail
- [ ] Mobile layout is configured if needed
- [ ] Performance is acceptable (visual renders in < 3 seconds)

---

**Last updated:** 2026-04-30
**Maintainers:** CSA-in-a-Box core team
**Related:** [Feature Mapping](feature-mapping-complete.md) | [Calculation Conversion](calculation-conversion.md) | [Tutorial: Workbook to PBIX](tutorial-workbook-to-pbix.md)
