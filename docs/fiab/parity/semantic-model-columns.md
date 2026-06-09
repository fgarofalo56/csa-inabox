# semantic-model-columns — parity with the Power BI / Fabric Model view (Tables & columns)

Source UI: Power BI Desktop / Fabric **Model view → column Properties pane**
(https://learn.microsoft.com/power-bi/transform-model/desktop-column-properties)
and the Tabular Object Model column properties
(https://learn.microsoft.com/analysis-services/tabular-models/columns-ssas-tabular).

Backend: **Azure Analysis Services XMLA** (Azure-native DEFAULT) or **Power BI
Premium XMLA** (opt-in) via TMSL Execute (Alter / Create) + TMSCHEMA Discover.
NO Microsoft Fabric / Power BI *workspace* is required — AAS is a standalone
Azure resource (per `.claude/rules/no-fabric-dependency.md`: semantic-model →
"Azure Analysis Services optional"). Client:
`apps/fiab-console/lib/azure/aas-client.ts`. BFF:
`apps/fiab-console/app/api/items/semantic-model/[id]/model/route.ts`.

## Azure/Fabric feature inventory (column Properties pane)

| # | Capability (Power BI Model view) | TMSL/TOM property |
|---|----------------------------------|-------------------|
| 1 | Rename / select a column for editing | `column` (Alter object) |
| 2 | **Data category** (Web URL, Image URL, Country, State/Province, City, Postal code, County, Continent, Address, Place, Latitude, Longitude, Barcode) | `dataCategory` |
| 3 | **Format string** (whole number, decimal, percentage, currency, date/time, custom) | `formatString` |
| 4 | **Summarize by** (Default / None / Sum / Min / Max / Count / Average / Distinct count) | `summarizeBy` |
| 5 | **Sort by column** (sort one column by another) | `sortByColumn` |
| 6 | **Display folder** (group columns into folders, nested with `\`) | `displayFolder` |
| 7 | **Is hidden** (hide from report view) | `isHidden` |
| 8 | **Calculated column** (DAX-defined column on an existing table) | `Create column` + `type=calculated` + `expression` |
| 9 | **Calculated table** (DAX-defined table) | `Create table` + calculated partition source |
| 10 | Data type display (string/int64/double/dateTime/decimal/boolean) | `dataType` (read) |

## Loom coverage

| # | Capability | Status | Control |
|---|-----------|--------|---------|
| 1 | Select column to edit | built ✅ | Table grid per-row **Edit** button → column edit panel |
| 2 | Data category dropdown (13 categories) | built ✅ | `Select` in edit panel + add-calc-column dialog |
| 3 | Format string builder | built ✅ | `Select` with integer/decimal/percent/currency/date presets |
| 4 | Summarize by dropdown | built ✅ | `Select` (8 aggregations) |
| 5 | Sort by column dropdown | built ✅ | `Select` listing the table's other columns |
| 6 | Display folder | built ✅ | `Input` (supports nested `\`) |
| 7 | Hidden toggle | built ✅ | `Switch` |
| 8 | Calculated column (DAX) | built ✅ | **Add calculated column** dialog — name + data type + category + folder + Monaco DAX |
| 9 | Calculated table (DAX) | built ✅ | **Add calculated table** dialog — name + Monaco DAX |
| 10 | Data type display | built ✅ | Read-only grid column |
| — | Backend not configured | honest-gate ⚠️ | Fluent `MessageBar intent="warning"` naming `LOOM_AAS_SERVER_URL` / `LOOM_POWERBI_XMLA_ENDPOINT` + the bicep module; read-only structure still renders |

Zero ❌, zero stub banners.

## Backend per control

- **Read (grid + edit panel hydration):** `GET /api/items/semantic-model/[id]/model`
  → `aas-client.readModel()` → XMLA Discover `TMSCHEMA_TABLES`, `TMSCHEMA_COLUMNS`,
  `TMSCHEMA_MEASURES`, `TMSCHEMA_PARTITIONS`; integer enums (ColumnType,
  DataType, AggregateFunction) and ID joins (TableID, SortByColumnID) resolved
  client-side into friendly names.
- **Apply (column edit):** `PATCH … { op: 'alter-column', tableName, columnName, column }`
  → `buildAlterColumnTmsl()` → TMSL **Alter** over XMLA. The UI sends the
  COMPLETE column object (current values merged with edits) because the Alter
  command requires every read-write property.
- **Add calculated column:** `PATCH … { op: 'add-calculated-column', tableName, column }`
  → `buildCreateCalcColumnTmsl()` → TMSL **Create** column with `type=calculated`
  + DAX `expression`.
- **Add calculated table:** `PATCH … { op: 'add-calculated-table', tableName, expression }`
  → `buildCreateCalcTableTmsl()` → TMSL **Create** table with a calculated
  partition source carrying the DAX.

## Per-cloud matrix

| | Commercial | GCC | GCC-High / IL5 |
|---|---|---|---|
| AAS available | yes | yes (Commercial Azure) | **no** (not offered in Azure Government) |
| Default backend | AAS (`LOOM_AAS_SERVER_URL`) | AAS | honest gate or `LOOM_POWERBI_XMLA_ENDPOINT` (if licensed) |
| Token scope (AAS) | `https://<region>.asazure.windows.net/.default` | same | n/a |
| Token scope (PBI XMLA) | `https://analysis.windows.net/powerbi/api/.default` | same | `https://high.analysis.usgovcloudapi.net/powerbi/api/.default` |
| Bicep deploys AAS | yes (`loomSemanticBackend=analysis-services`) | yes | **no** (guarded on `boundary`) |

## Acceptance receipt

With `LOOM_SEMANTIC_BACKEND=analysis-services`,
`LOOM_AAS_SERVER_URL=asazure://eastus2.asazure.windows.net/<name>`,
`LOOM_AAS_DATABASE=loomdb`: open the Semantic model editor → Tables tab → select
`Sales` → Edit `Amount` → set Data category `WebUrl`, Format `#,0.00`, Summarize
`sum`, Display folder `Finance` → Apply. The PATCH returns `{ ok: true, tmsl }`
where `tmsl` is the exact Alter sent. A report visual binding `Amount` then
renders with the format string and treats a WebUrl-categorised column as a link.
