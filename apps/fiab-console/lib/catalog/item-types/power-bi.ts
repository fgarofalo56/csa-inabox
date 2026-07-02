import type { FabricItemType } from './types';

/**
 * Power BI — item-type catalog slice.
 *
 * Split out of lib/catalog/fabric-item-types.ts (barrel-preserving refactor):
 * the item literals are VERBATIM; grouping is by the item's `category` field.
 * Recomposed into FABRIC_ITEM_TYPES (in category-appearance order) by the barrel.
 */
export const powerBiItems: FabricItemType[] = [
  // Power BI
  { slug: 'semantic-model', displayName: 'Semantic model', restType: 'SemanticModel', category: 'Power BI',
    description: 'Tables, relationships, measures, and roles backing Power BI reports.',
    learnContent: {
      "overview": "A Semantic model holds the tables, relationships, measures, and roles backing Power BI reports. In Loom it is wired against live Power BI REST via the Console UAMI. Use it as the shared business layer for reports, dashboards, and scorecards.",
      "steps": [
        {
          "title": "Connect data",
          "body": "Connect to a Lakehouse, warehouse SQL endpoint, or import data directly."
        },
        {
          "title": "Author DAX measures",
          "body": "Write measures for KPIs such as Revenue, Cost, and Margin percent."
        },
        {
          "title": "Configure RLS",
          "body": "Define row-level security roles so each consumer sees only their slice."
        },
        {
          "title": "Refresh the model",
          "body": "Trigger or schedule a refresh; the editor calls live Power BI REST and surfaces 401/403 with a hint if the UAMI isn't yet a workspace member."
        }
      ],
      "docsUrl": "https://learn.microsoft.com/power-bi/transform-model/datasets/dataset-modes-understand"
    } },
  { slug: 'report', displayName: 'Report', restType: 'Report', category: 'Power BI',
    description: 'Interactive Power BI report with pages, visuals, and filters.',
    learnContent: {
      "overview": "A Report is an interactive Power BI report with pages, visuals, and filters bound to a semantic model. In Loom it is reframed around embed, refresh, and export against live Power BI REST via the Console UAMI.",
      "steps": [
        {
          "title": "Bind a semantic model",
          "body": "The report's visuals read from a semantic model in the same workspace."
        },
        {
          "title": "Embed and view",
          "body": "Loom embeds the report so you can slice and drill in-console."
        },
        {
          "title": "Refresh underlying data",
          "body": "Refresh the bound semantic model to update the visuals."
        },
        {
          "title": "Export",
          "body": "Export to PDF/PPTX via the Power BI REST export-to-file flow; 401/403 surfaces a remediation hint."
        }
      ],
      "docsUrl": "https://learn.microsoft.com/power-bi/create-reports/"
    } },
  { slug: 'dashboard', displayName: 'Dashboard', restType: 'Dashboard', category: 'Power BI',
    description: 'Pinned-visual dashboard surfacing tiles from multiple reports.',
    learnContent: {
      "overview": "A Dashboard is a pinned-visual canvas surfacing tiles from multiple reports. In Loom it is wired against live Power BI REST via the Console UAMI. Use it to monitor KPIs at a glance across reports.",
      "steps": [
        {
          "title": "Pin tiles",
          "body": "Pin visuals from one or more reports onto the dashboard canvas."
        },
        {
          "title": "Arrange the layout",
          "body": "Size and position tiles so the most important KPIs read first."
        },
        {
          "title": "Embed and view",
          "body": "Loom embeds the dashboard for in-console monitoring."
        },
        {
          "title": "Mind tenant gating",
          "body": "If the Console UAMI isn't yet registered in the Power BI tenant or workspace, the editor surfaces the 401/403 with a remediation hint."
        }
      ],
      "docsUrl": "https://learn.microsoft.com/power-bi/create-reports/service-dashboards"
    } },
  { slug: 'paginated-report', displayName: 'Paginated report', restType: 'PaginatedReport', category: 'Power BI',
    description: 'Pixel-perfect RDL report for printable, parameterized output.',
    learnContent: {
      "overview": "A Paginated report is a pixel-perfect RDL report for printable, parameterized output (formerly SSRS) — invoices, financial statements, regulatory filings. In Loom it is wired against live Power BI REST via the Console UAMI.",
      "steps": [
        {
          "title": "Bind a data source",
          "body": "The RDL report queries a semantic model or direct SQL source."
        },
        {
          "title": "Set parameters",
          "body": "Define report parameters so consumers run it for a specific scope (date range, entity)."
        },
        {
          "title": "Render and view",
          "body": "Loom embeds the rendered report for review."
        },
        {
          "title": "Export to PDF",
          "body": "Export pixel-perfect output via Power BI REST; tenant 401/403 surfaces a remediation hint."
        }
      ],
      "docsUrl": "https://learn.microsoft.com/power-bi/paginated-reports/paginated-reports-report-builder-power-bi"
    } },
  { slug: 'scorecard', displayName: 'Scorecard', restType: 'Scorecard', category: 'Power BI', noRestApi: true,
    description: 'KPI tree with targets and status (no REST API today; metadata only).',
    learnContent: {
      "overview": "A Scorecard is a KPI tree with targets and status (OKR-style). There is no Fabric REST API for scorecards today, so in Loom this is metadata-only — the editor persists the KPI hierarchy and discloses the API limitation honestly.",
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
          "title": "Set status and cadence",
          "body": "Track progress against targets with a check-in cadence."
        },
        {
          "title": "Know the API limit",
          "body": "No scorecard REST API exists today, so this surface stores metadata only and says so in a MessageBar rather than faking live values."
        }
      ],
      "docsUrl": "https://learn.microsoft.com/power-bi/consumer/metrics/metrics-get-started"
    } },
];
