import type { FabricItemType } from './types';

/**
 * Power BI — item-type catalog slice.
 *
 * Split out of lib/catalog/fabric-item-types.ts (barrel-preserving refactor):
 * grouping is by the item's `category` field and recomposed into
 * FABRIC_ITEM_TYPES (in category-appearance order) by the barrel.
 *
 * Copy leads with the AZURE-NATIVE / Loom-native default per
 * no-fabric-dependency.md (rel-T07): every item is fully functional with no
 * Power BI or Fabric workspace; the Power BI leg is described as the opt-in
 * alternative (NEXT_PUBLIC_LOOM_BI_BACKEND=powerbi), never the lead.
 */
export const powerBiItems: FabricItemType[] = [
  // Power BI
  { slug: 'semantic-model', displayName: 'Semantic model', restType: 'SemanticModel', category: 'Power BI',
    description: 'Tables, relationships, measures, and roles — Loom-native tabular layer over your warehouse or lakehouse.',
    learnContent: {
      "overview": "A Semantic model holds the tables, relationships, measures, and roles backing reports, dashboards, and scorecards. In Loom it is a Loom-native tabular layer over your warehouse or lakehouse by default — authored, versioned, and validated in Loom with no Power BI or Fabric workspace required. Azure Analysis Services (when deployed) hosts the live model for DAX queries; syncing to a Power BI workspace is the opt-in alternative.",
      "steps": [
        {
          "title": "Connect data",
          "body": "Point the model at a lakehouse or warehouse SQL endpoint — the Azure-native data path."
        },
        {
          "title": "Author DAX measures",
          "body": "Write measures for KPIs such as Revenue, Cost, and Margin percent; validation runs in Loom."
        },
        {
          "title": "Configure RLS",
          "body": "Define row-level security roles so each consumer sees only their slice."
        },
        {
          "title": "Optional: sync to Power BI",
          "body": "With the Power BI backend opted in (NEXT_PUBLIC_LOOM_BI_BACKEND=powerbi), push the model to a Power BI workspace and refresh it via live Power BI REST."
        }
      ],
      "docsUrl": "https://learn.microsoft.com/power-bi/transform-model/datasets/dataset-modes-understand"
    } },
  { slug: 'report', displayName: 'Report', restType: 'Report', category: 'Power BI',
    description: 'Interactive report with pages, visuals, and filters — Loom-native designer and renderer.',
    learnContent: {
      "overview": "A Report is an interactive, multi-page surface of visuals and filters bound to a semantic model. In Loom the report designer and renderer are Loom-native by default: author pages, visuals, filters, bookmarks, and themes in Loom and render them with live DAX over the semantic layer — no Power BI workspace required. Embedding a published Power BI report is the opt-in alternative.",
      "steps": [
        {
          "title": "Bind a semantic model",
          "body": "The report's visuals read from a semantic model — the Loom-native tabular layer by default."
        },
        {
          "title": "Design pages and visuals",
          "body": "Use the report designer: pages, 11 visual types, field wells, filters, bookmarks, and themes."
        },
        {
          "title": "View with live data",
          "body": "The Loom renderer executes the bound model's DAX so visuals show real data in-console."
        },
        {
          "title": "Optional: Power BI embed",
          "body": "With the Power BI backend opted in, embed a published Power BI report in place and export via the Power BI REST export-to-file flow."
        }
      ],
      "docsUrl": "https://learn.microsoft.com/power-bi/create-reports/"
    } },
  { slug: 'dashboard', displayName: 'Dashboard', restType: 'Dashboard', category: 'Power BI',
    description: 'Tile canvas for at-a-glance KPIs — Loom-native streaming (ADX) and Q&A (DAX) tiles.',
    learnContent: {
      "overview": "A Dashboard is a tile canvas for monitoring KPIs at a glance. In Loom the canvas is Azure-native by default: streaming tiles query Azure Data Explorer, Q&A tiles run DAX on the semantic layer, and the layout persists to Cosmos — no Power BI workspace required. Linking and embedding live Power BI dashboards is the opt-in alternative.",
      "steps": [
        {
          "title": "Add tiles",
          "body": "Add streaming ADX tiles, Copilot Q&A (DAX) tiles, or pinned visuals from the ribbon."
        },
        {
          "title": "Arrange the layout",
          "body": "Size and position tiles on the 12-column grid so the most important KPIs read first; Save layout persists to Cosmos."
        },
        {
          "title": "Watch live data",
          "body": "Each tile executes its real backend query (KQL on ADX, DAX on the model) on refresh."
        },
        {
          "title": "Optional: Power BI view",
          "body": "With the Power BI backend opted in, link a Power BI workspace to embed its dashboards and pin their tiles alongside Loom tiles."
        }
      ],
      "docsUrl": "https://learn.microsoft.com/power-bi/create-reports/service-dashboards"
    } },
  { slug: 'paginated-report', displayName: 'Paginated report', restType: 'PaginatedReport', category: 'Power BI',
    description: 'Pixel-perfect RDL report for printable, parameterized output — Loom-native designer and export.',
    learnContent: {
      "overview": "A Paginated report is a pixel-perfect RDL report for printable, parameterized output (formerly SSRS) — invoices, financial statements, regulatory filings. In Loom the RDL designer is Loom-native by default: author data sources, dataset SQL, tablixes, and parameters in Loom and export to PDF / Excel / Word via the Loom render service — no Power BI workspace required. Embedding a published Power BI paginated report is the opt-in alternative.",
      "steps": [
        {
          "title": "Bind a data source",
          "body": "The RDL report queries a warehouse, lakehouse SQL endpoint, or direct SQL source."
        },
        {
          "title": "Design the tablix and parameters",
          "body": "Author columns, row groups, expressions, and report parameters so consumers run it for a specific scope (date range, entity)."
        },
        {
          "title": "Render and export",
          "body": "Preview in-console and export pixel-perfect PDF / Excel / Word via the Loom paginated-report renderer."
        },
        {
          "title": "Optional: Power BI live preview",
          "body": "With the Power BI backend opted in, embed a published Power BI paginated (RDL) report in place."
        }
      ],
      "docsUrl": "https://learn.microsoft.com/power-bi/paginated-reports/paginated-reports-report-builder-power-bi"
    } },
  { slug: 'scorecard', displayName: 'Scorecard', restType: 'Scorecard', category: 'Power BI', noRestApi: true,
    description: 'KPI/OKR tree with targets, check-ins, and status rollups — Loom-native goal store.',
    learnContent: {
      "overview": "A Scorecard is a KPI tree with targets and status (OKR-style). In Loom it is a Loom-native goal store by default: goals, check-ins (value + status + note with full history), rollup aggregation, and threshold status rules all persist to Cosmos and compute in Loom — no Power BI workspace required. Syncing check-ins to a live Power BI scorecard is the opt-in alternative.",
      "steps": [
        {
          "title": "Define goals",
          "body": "Create the top-level goals and their owners."
        },
        {
          "title": "Add KPIs",
          "body": "Nest KPIs under goals with targets and current values."
        },
        {
          "title": "Check in and roll up",
          "body": "Record check-ins with a cadence; parent goals roll up from children (Sum / Average / Min / Max) and color by your status rules."
        },
        {
          "title": "Optional: Power BI sync",
          "body": "With the Power BI backend opted in, live Power BI scorecards list alongside Loom ones, goals can bind to live DAX measures, and check-ins also push to the Fabric goal."
        }
      ],
      "docsUrl": "https://learn.microsoft.com/power-bi/consumer/metrics/metrics-get-started"
    } },
];
