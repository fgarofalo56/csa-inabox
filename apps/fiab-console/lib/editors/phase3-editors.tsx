'use client';

/**
 * Phase 3 editors — Real-Time Intelligence, Data Warehouse, Power BI.
 *
 * v2.1 KQL family (Eventhouse, KQL Database, KQL Queryset, KQL Dashboard,
 * Eventstream) are wired live against the shared Loom ADX cluster
 * (default `adx-csa-loom-shared` in `eastus2`, cloud-correct suffix) via the Console UAMI
 * (Kusto raw REST: /v1/rest/query + /v1/rest/mgmt, ARM for database
 * create). Eventstream persists pipeline config to Cosmos; runtime
 * wiring lands in v3.
 *
 * Warehouse is real-REST (Fabric Warehouse over Synapse Dedicated pool).
 *
 * v2.1 Power BI / Fabric family — Semantic model, Report, Dashboard,
 * Paginated report, Scorecard, and Activator — are now wired against
 * live Power BI REST (api.powerbi.com/v1.0/myorg) and Fabric REST
 * (api.fabric.microsoft.com/v1) via the Console UAMI. If the UAMI's SP
 * is not yet registered in the Power BI tenant or hasn't been added to
 * a workspace, the editors surface the underlying 401/403 verbatim with
 * a remediation hint — no mock data is shown.
 */

// ----- Eventhouse -----
export { EventhouseEditor, EventhouseCapacityPanel } from './phase3/eventhouse-editor';

// ----- KQL Database -----
export { KqlDatabaseEditor } from './phase3/kql-database-editor';

// ----- KQL Queryset -----
export { KqlQuerysetEditor } from './phase3/kql-queryset-editor';

// ----- KQL Dashboard (Fabric Real-Time Dashboard parity) -----
export { KqlDashboardEditor } from './phase3/kql-dashboard-editor';

// ----- Eventstream -----
// Ribbon built inside the editor via useMemo so Save binds to the
// existing inline save handler; the rest stay disabled with reasons.

export { EventstreamEditor } from './phase3/eventstream-editor';


// ============================================================
// Power BI / Fabric editor shells — v2.1 live REST.
//
// IMPORTANT: All six editors below require the Console UAMI's service
// principal to be (a) registered in the Power BI tenant and (b) added to
// each target workspace. If either is missing, the editor surfaces the
// underlying 401/403 verbatim via MessageBar so the operator knows
// exactly what to fix. No mock data is shown when the call fails.
// ============================================================

// ----- Activator -----
// Ribbon built inside the editor via useMemo so New rule binds to the
// existing setRuleOpen handler; the rest stay disabled with reasons.

export { ActivatorEditor } from './phase3/activator-editor';

// ----- Warehouse -----
// Ribbon built inside the editor via useMemo so Run binds to the
// existing inline run handler; the rest stay disabled with reasons.

export { WarehouseEditor } from './phase3/warehouse-editor';

// ============================================================
// Semantic Model (Power BI dataset)
// ============================================================
// Ribbon built inside SemanticModelEditor via useMemo so Refresh binds
// to the existing inline refreshNow handler; the rest stay disabled.

export { SemanticModelEditor } from './phase3/semantic-model-editor';
export { ReportEditor } from './phase3/report-editor';
export type { ReportLite } from './phase3/report-editor';
export { PaginatedReportEditor } from './phase3/paginated-report-editor';

// ============================================================
// Dashboard (Power BI dashboard viewer + Loom-native tile canvas)
//
// Azure-native by default (no-fabric-dependency.md): the Loom canvas tab — pin
// a DAX tile, add a Copilot Q&A→DAX tile, add a streaming ADX/KQL tile, drag
// the grid, drill, fullscreen, mobile layout — works with NO Power BI / Fabric
// workspace bound (streaming tiles run on ADX; DAX tiles run on Azure Analysis
// Services when LOOM_SEMANTIC_BACKEND=analysis-services). Power BI embed + the
// "pin from a PBI dashboard" clone path are the opt-in Fabric-family surface.
// Layout + Loom tiles persist to Cosmos (pbi-dashboard-overlays) via
// PUT /api/items/dashboard/[id]; tiles execute via .../tile-query.
// ============================================================

export { DashboardEditor } from './phase3/dashboard-editor';

// ============================================================
// Scorecard (Fabric)
// ============================================================
export { ScorecardEditor } from './phase3/scorecard-editor';

// ============================================================
// Datamart (DEPRECATED) — migration assistant
// ============================================================
//
// Power BI datamarts are deprecated. There is NO create path: id === 'new'
// renders a permanent deprecation notice with no authoring surface. An existing
// datamart shows a Fluent MessageBar intent="warning" with a Migrate button
// that POSTs /api/items/datamart/migrate — provisioning a Synapse Serverless
// database + an Azure Analysis Services server (real backends, no Fabric).
// Once migrated, the receipt (Synapse DB, AAS server, AAS connection URI) is
// surfaced from the Cosmos item's state.migration.

export { DatamartEditor } from './phase3/datamart-editor';
