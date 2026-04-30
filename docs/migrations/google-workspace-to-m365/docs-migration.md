# Docs Migration: Google Docs, Sheets, and Slides to Microsoft Office

**Status:** Authored 2026-04-30
**Audience:** M365 administrators, migration engineers, and business application owners managing the transition from Google productivity apps to Microsoft Office.
**Scope:** Format conversion fidelity, formula compatibility (Sheets to Excel), macro migration (Apps Script to VBA/Office Scripts/Power Automate), and template migration.

---

## Overview

Google Docs, Sheets, and Slides automatically convert to Word (.docx), Excel (.xlsx), and PowerPoint (.pptx) during Drive migration via Migration Manager. The file-level conversion is largely automated and high-fidelity for most documents. The primary migration challenges are:

1. **Apps Script macros** --- Google's JavaScript-based automation does not convert to Microsoft formats.
2. **Google Sheets-specific functions** --- Some Sheets functions have no direct Excel equivalent.
3. **Templates and workflows** --- Organizational templates must be recreated.
4. **Add-on integrations** --- Google Workspace Marketplace add-ons must be replaced with Office add-ins.

---

## Google Docs to Word conversion

### What converts well

| Feature                     | Conversion fidelity | Notes                                                    |
| --------------------------- | ------------------- | -------------------------------------------------------- |
| Text content and formatting | High                | Font, size, color, bold, italic, underline all preserved |
| Headings and styles         | High                | Heading levels map to Word heading styles                |
| Tables                      | High                | Table structure, borders, and cell formatting preserved  |
| Images (embedded)           | High                | Images preserved at original quality                     |
| Hyperlinks                  | High                | Internal and external links preserved                    |
| Comments and suggestions    | High                | Comment threads preserved with author attribution        |
| Page breaks                 | High                | Direct mapping                                           |
| Headers and footers         | High                | Content preserved; some positioning may shift            |
| Table of contents           | Medium              | Auto-generated TOC may need refresh in Word              |
| Footnotes and endnotes      | High                | Direct mapping                                           |
| Bulleted and numbered lists | High                | Direct mapping                                           |
| Page numbering              | High                | Direct mapping                                           |

### What may need manual adjustment

| Feature                                            | Issue                                        | Workaround                                 |
| -------------------------------------------------- | -------------------------------------------- | ------------------------------------------ |
| **Google Drawings (embedded)**                     | Convert to static images; no longer editable | Rebuild in Word shapes or Visio            |
| **Linked Google Sheets charts**                    | Link to Sheets breaks; chart becomes static  | Re-link to Excel workbook                  |
| **Add-on formatting**                              | Add-on-specific features lost                | Manually reformat                          |
| **Smart chips** (mentions, dates, links)           | Convert to plain text or hyperlinks          | No action needed; formatting is acceptable |
| **Building blocks** (table of contents, bookmarks) | May need manual refresh in Word              | Update fields in Word (Ctrl+A, then F9)    |
| **Watermarks**                                     | May not convert                              | Re-add watermarks in Word                  |
| **Page orientation mixed** (portrait + landscape)  | Section breaks may shift                     | Verify section breaks in Word              |

### Best practice

After migration, spot-check a representative sample of documents:

- [ ] 5 simple documents (memos, letters).
- [ ] 5 complex documents (reports with tables, images, TOC).
- [ ] 5 documents with comments/suggestions.
- [ ] 3 documents with embedded charts or drawings.
- [ ] 2 documents with headers/footers and page numbers.

---

## Google Sheets to Excel conversion

### Formula compatibility

Google Sheets and Excel share most common formulas. Migration Manager converts Sheets formulas to Excel equivalents automatically.

#### Formulas that convert directly (no changes needed)

| Category    | Examples                                                           |
| ----------- | ------------------------------------------------------------------ |
| Math        | SUM, AVERAGE, COUNT, MIN, MAX, ROUND, ABS, CEILING, FLOOR          |
| Logical     | IF, AND, OR, NOT, IFS, SWITCH                                      |
| Text        | CONCATENATE, LEFT, RIGHT, MID, LEN, TRIM, UPPER, LOWER, SUBSTITUTE |
| Lookup      | VLOOKUP, HLOOKUP, INDEX, MATCH, XLOOKUP (Excel has this natively)  |
| Date        | TODAY, NOW, DATE, YEAR, MONTH, DAY, DATEDIF                        |
| Statistical | COUNTIF, COUNTIFS, SUMIF, SUMIFS, AVERAGEIF                        |
| Financial   | PMT, FV, PV, NPV, IRR                                              |

#### Formulas that require manual adjustment

| Google Sheets formula                   | Excel equivalent                           | Notes                                                 |
| --------------------------------------- | ------------------------------------------ | ----------------------------------------------------- |
| `IMPORTDATA(url)`                       | Power Query web connector                  | Must rebuild as Power Query                           |
| `IMPORTRANGE(spreadsheet, range)`       | External workbook reference or Power Query | Different syntax; requires rebuild                    |
| `IMPORTHTML(url, query, index)`         | Power Query web connector                  | Must rebuild as Power Query                           |
| `IMPORTXML(url, xpath)`                 | Power Query XML connector                  | Must rebuild as Power Query                           |
| `GOOGLEFINANCE(ticker)`                 | `STOCKHISTORY()` or data type              | Excel stock data type or web query                    |
| `GOOGLETRANSLATE(text, source, target)` | No direct equivalent                       | Use Power Automate with Azure Translator              |
| `QUERY(range, query)`                   | Power Query or PivotTable                  | Must rebuild using Power Query M language             |
| `FILTER(range, condition)`              | `FILTER()` (Excel 365)                     | Direct equivalent in Excel 365; not in older versions |
| `SORT(range, column, ascending)`        | `SORT()` (Excel 365)                       | Direct equivalent in Excel 365                        |
| `UNIQUE(range)`                         | `UNIQUE()` (Excel 365)                     | Direct equivalent in Excel 365                        |
| `ARRAYFORMULA(expression)`              | Dynamic arrays (Excel 365)                 | Excel 365 spills arrays natively; no wrapper needed   |
| `IMAGE(url)`                            | `IMAGE()` (Excel 365)                      | Direct equivalent in Excel 365                        |
| `SPARKLINE(range)`                      | Excel sparklines (Insert > Sparklines)     | UI-based sparklines; not formula-based                |

#### Google Sheets functions with no Excel equivalent

| Function            | Workaround                                                                                          |
| ------------------- | --------------------------------------------------------------------------------------------------- |
| `QUERY()`           | Use Power Query for complex data transformations; or rewrite as combination of FILTER, SORT, UNIQUE |
| `IMPORTDATA()`      | Power Query web data source                                                                         |
| `IMPORTRANGE()`     | External workbook reference `=[Workbook.xlsx]Sheet1!A1` or Power Query                              |
| `GOOGLETRANSLATE()` | Azure AI Translator via Power Automate or custom function                                           |
| `GOOGLEFINANCE()`   | Excel stock data type or `STOCKHISTORY()`                                                           |

### Chart conversion

| Chart type               | Conversion fidelity | Notes                                               |
| ------------------------ | ------------------- | --------------------------------------------------- |
| Bar, column, line, pie   | High                | Direct mapping                                      |
| Scatter, bubble          | High                | Direct mapping                                      |
| Area                     | High                | Direct mapping                                      |
| Combo charts             | Medium              | May need formatting adjustment                      |
| Treemap                  | Medium              | Available in Excel; may need formatting             |
| Waterfall                | Medium              | Available in Excel; may need formatting             |
| Geo charts (Google Maps) | Low                 | No direct equivalent; use Excel Map chart (limited) |
| Gauges                   | Low                 | No direct equivalent; rebuild with doughnut chart   |
| Org charts               | Low                 | Use Visio or SmartArt                               |

### Pivot table conversion

Google Sheets pivot tables convert to Excel PivotTables with high fidelity. Key differences:

| Feature           | Google Sheets       | Excel                                 | Notes                                   |
| ----------------- | ------------------- | ------------------------------------- | --------------------------------------- |
| Basic pivot       | Pivot table editor  | PivotTable Fields pane                | Different UI, same concept              |
| Calculated fields | Supported           | Supported                             | Syntax may differ                       |
| Slicers           | Supported           | Supported with timeline slicers       | Excel has more slicer options           |
| Pivot charts      | Supported           | PivotCharts                           | More chart types in Excel               |
| Refresh           | Manual or scheduled | Manual, refresh all, or VBA-triggered | Power Query scheduled refresh available |

---

## Apps Script to Microsoft migration

Apps Script is the single most complex migration challenge. Google Apps Script is a JavaScript-based platform tightly integrated with Google Workspace. There is no automated conversion to Microsoft equivalents.

### Migration strategy by complexity

| Complexity                  | Apps Script profile                                          | Target platform                               | Effort                               |
| --------------------------- | ------------------------------------------------------------ | --------------------------------------------- | ------------------------------------ |
| **Simple** (< 50 lines)     | Custom menus, simple formatting, email sending               | Office Scripts or Power Automate              | 1-4 hours per script                 |
| **Moderate** (50-200 lines) | Form processing, data validation, conditional formatting     | Power Automate + Office Scripts               | 4-16 hours per script                |
| **Complex** (200-500 lines) | Multi-sheet automation, API integrations, scheduled triggers | Power Automate + Power Apps + Azure Functions | 16-40 hours per script               |
| **Enterprise** (500+ lines) | Full applications (Apps Script web apps, add-ons)            | Power Apps + Power Automate + Azure Functions | 40+ hours; treat as separate project |

### Apps Script to Office Scripts mapping

| Apps Script concept           | Office Scripts equivalent                          | Notes                                        |
| ----------------------------- | -------------------------------------------------- | -------------------------------------------- |
| `SpreadsheetApp`              | `ExcelScript.Workbook`                             | Different API; same capability               |
| `DocumentApp`                 | No direct equivalent                               | Use Power Automate for Word automation       |
| `SlidesApp`                   | No direct equivalent                               | Use Power Automate for PowerPoint automation |
| `GmailApp`                    | Power Automate (Outlook connector)                 | Different platform                           |
| `DriveApp`                    | Power Automate (OneDrive/SharePoint connector)     | Different platform                           |
| `CalendarApp`                 | Power Automate (Outlook connector)                 | Different platform                           |
| `UrlFetchApp`                 | Power Automate (HTTP connector) or Azure Functions | Different platform                           |
| `Triggers` (time, edit, form) | Power Automate triggers                            | Power Automate has 1,000+ trigger types      |
| `HtmlService` (web apps)      | Power Apps or Azure Static Web Apps                | Re-implementation required                   |
| `PropertiesService`           | Azure Key Vault or environment variables           | Different architecture                       |

### Example: Apps Script to Office Scripts conversion

**Google Apps Script (bound to a Sheet):**

```javascript
function formatReport() {
    var sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
    var range = sheet.getDataRange();
    var values = range.getValues();

    for (var i = 1; i < values.length; i++) {
        if (values[i][3] > 100000) {
            sheet.getRange(i + 1, 4).setBackground("#90EE90");
        }
    }
}
```

**Office Scripts equivalent:**

```typescript
function main(workbook: ExcelScript.Workbook) {
    let sheet = workbook.getActiveWorksheet();
    let range = sheet.getUsedRange();
    let values = range.getValues();

    for (let i = 1; i < values.length; i++) {
        if ((values[i][3] as number) > 100000) {
            sheet
                .getRange(`D${i + 1}`)
                .getFormat()
                .getFill()
                .setColor("#90EE90");
        }
    }
}
```

### Apps Script to Power Automate mapping

For scripts that interact with email, Drive, Calendar, or external APIs, Power Automate is the recommended replacement:

| Apps Script pattern          | Power Automate equivalent                                    |
| ---------------------------- | ------------------------------------------------------------ |
| `GmailApp.sendEmail()`       | "Send an email (V2)" action (Outlook connector)              |
| `DriveApp.createFile()`      | "Create file" action (OneDrive/SharePoint connector)         |
| `CalendarApp.createEvent()`  | "Create event (V4)" action (Outlook connector)               |
| `UrlFetchApp.fetch()`        | "HTTP" action (Premium connector)                            |
| `Spreadsheet onEdit trigger` | "When a row is modified" trigger (Excel connector)           |
| `Time-driven trigger`        | "Recurrence" trigger                                         |
| `Form submit trigger`        | "When a new response is submitted" trigger (Forms connector) |

---

## Template migration

### Organizational templates

Google Workspace organizational templates (stored in the template gallery) must be manually recreated in Microsoft 365.

#### Migration steps

1. **Export templates from Google Workspace:**
    - Navigate to Google Docs/Sheets/Slides template gallery.
    - Download each template as .docx/.xlsx/.pptx.

2. **Upload to SharePoint:**
    - Create a "Templates" document library in SharePoint.
    - Upload converted templates.
    - Configure as organizational templates in M365 admin center.

3. **Configure M365 template locations:**

```powershell
# Set organizational template location in SharePoint
# Templates uploaded to: https://contoso.sharepoint.com/sites/templates/Documents
# Configure in M365 admin center > Settings > Org settings > Office templates
```

4. **Brand templates with organizational identity:**
    - Update headers, footers, and logos in Word templates.
    - Apply organizational color palette in PowerPoint templates.
    - Configure default fonts and styles.

### Personal templates

Users with personal templates in Google Workspace should:

1. Open templates in Google Workspace.
2. Download as Office format.
3. Save to OneDrive in a "Templates" folder.
4. Pin the folder in Office apps for quick access.

---

## Post-conversion validation checklist

### Documents (Google Docs to Word)

- [ ] Text content is complete and correctly formatted.
- [ ] Images are present and positioned correctly.
- [ ] Tables are intact with correct formatting.
- [ ] Headers and footers are preserved.
- [ ] Table of contents is functional (may need refresh).
- [ ] Comments and tracked changes are preserved.
- [ ] Hyperlinks are functional.
- [ ] Page numbering is correct.

### Spreadsheets (Google Sheets to Excel)

- [ ] All formulas calculate correctly.
- [ ] Charts render with correct data and formatting.
- [ ] Pivot tables function and refresh correctly.
- [ ] Conditional formatting rules are preserved.
- [ ] Data validation rules are intact.
- [ ] Named ranges are preserved.
- [ ] Cross-sheet references work.
- [ ] `IMPORTDATA`/`IMPORTRANGE` formulas are replaced with Power Query (if applicable).
- [ ] Apps Script macros are documented for rebuild.

### Presentations (Google Slides to PowerPoint)

- [ ] All slides are present with correct layouts.
- [ ] Animations and transitions are preserved.
- [ ] Embedded media (images, videos) display correctly.
- [ ] Speaker notes are preserved.
- [ ] Slide master/layouts are intact.
- [ ] Fonts are available (install any missing fonts).

---

## Google Workspace add-on to Office add-in mapping

| Google Workspace add-on | Microsoft Office equivalent              | Notes                               |
| ----------------------- | ---------------------------------------- | ----------------------------------- |
| **Grammarly**           | Grammarly (Office add-in)                | Direct equivalent available         |
| **DocuSign**            | DocuSign (Office add-in)                 | Direct equivalent available         |
| **Lucidchart**          | Lucidchart (Office add-in) or Visio      | Both available                      |
| **Asana/Trello/Monday** | Office add-ins available for each        | Direct equivalents                  |
| **Mail merge**          | Power Automate or third-party add-in     | No native mail merge in Word Online |
| **PDF editor**          | Adobe Acrobat (Office add-in)            | Direct equivalent                   |
| **Translation**         | Microsoft Translator (built-in)          | Built into Word/Excel/PowerPoint    |
| **Custom add-ons**      | Custom Office add-ins (JavaScript-based) | Re-implementation required          |
