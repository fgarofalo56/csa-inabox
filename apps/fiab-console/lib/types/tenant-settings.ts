/**
 * Tenant Settings schema for the Loom admin portal. Mirrors the shape Fabric
 * uses for its 25-section / 160-toggle tenant settings page but scoped to
 * the toggles Loom actually controls in this codebase.
 *
 * Persistence: one doc per tenant in the `tenant-settings` Cosmos container
 * (partition key: /tenantId). Default values land in the doc on first load.
 *
 * Audit: every PUT emits an audit-log entry per changed toggle so admins can
 * trace who flipped what.
 */

export type ToggleScope = 'tenant' | 'capacity' | 'domain';

export interface ToggleDef {
  id: string;
  label: string;
  help: string;
  /** Optional learn-more URL. */
  learnUrl?: string;
  /** Default value for new tenants. */
  default: boolean;
  /** What scope this toggle applies to. */
  scope?: ToggleScope;
}

export interface ToggleGroupDef {
  id: string;
  label: string;
  description?: string;
  toggles: ToggleDef[];
}

/**
 * The 15 Loom-specific categories called out in the validator's
 * tenant-settings gap doc, with concrete toggles. Each toggle is consumed
 * by a specific part of the Loom backend (the `id` matches the env-var
 * gate that the corresponding editor checks).
 */
export const TENANT_SETTING_GROUPS: ToggleGroupDef[] = [
  {
    id: 'onelake',
    label: 'OneLake',
    description: 'Storage layer that backs every Lakehouse + Warehouse + KQL DB in this tenant.',
    toggles: [
      { id: 'onelake.enabled', label: 'OneLake enabled', help: 'Master switch for the OneLake storage layer. Disabling this hides every Lakehouse and Warehouse from the UI.', default: true },
      { id: 'onelake.crossWorkspaceShortcuts', label: 'Cross-workspace shortcuts', help: 'Allow users to create shortcuts that point at OneLake paths in workspaces they do not own.', default: true },
      { id: 'onelake.externalShortcuts', label: 'External (ADLS/S3/GCS) shortcuts', help: 'Allow users to create shortcuts that point at external storage. Disable to keep all data in OneLake.', default: false },
    ],
  },
  {
    id: 'rti',
    label: 'Real-Time Intelligence',
    description: 'Eventstream, Eventhouse, KQL DB/Queryset/Dashboard, Activator.',
    toggles: [
      { id: 'rti.eventstream', label: 'Eventstream enabled', help: 'Allow Eventstream item creation + edit.', default: true },
      { id: 'rti.eventhouse', label: 'Eventhouse / KQL Database enabled', help: 'Allow Eventhouse / KQL Database creation. Disabling hides the underlying ADX cluster.', default: true },
      { id: 'rti.activator', label: 'Activator (Reflex) rules', help: 'Allow Activator rules. Reflex rules can fire emails + Teams notifications + Power Automate flows.', default: true },
    ],
  },
  {
    id: 'ai-copilot',
    label: 'AI & Copilot',
    description: 'Copilot pane, Data Agent, Foundry-backed Cross-Item Copilot.',
    toggles: [
      { id: 'ai.copilotPane', label: 'Copilot pane', help: 'Show the right-rail Copilot pane (Ctrl+/). Backed by /api/copilot/orchestrate.', default: true },
      { id: 'ai.dataAgent', label: 'Data Agent (assistants-on-data)', help: 'Allow per-tenant Data Agent. Requires AI Foundry deployment.', default: true },
      { id: 'ai.allowedDataSources', label: 'Data Agent allowed-sources', help: 'Restrict Data Agent to specific data sources. Configure under "Tools".', default: false },
      { id: 'ai.crossItemCopilot', label: 'Cross-item Copilot orchestrator', help: 'Lets Copilot call Loom tools across all surfaces with admin-defined guardrails.', default: true },
      { id: 'ai.inlineCodeComplete', label: 'Inline code completion (ghost text)', help: 'AOAI-powered gray ghost-text suggestions in Monaco notebook code cells (Tab to accept). Unlike Fabric this needs no F2+/P capacity. Users can also toggle per-session via the cell toolbar sparkle button.', default: true },
    ],
  },
  {
    id: 'mirroring',
    label: 'Mirroring',
    description: 'Continuous replication from Azure SQL / Snowflake / Cosmos into OneLake.',
    toggles: [
      { id: 'mirror.azureSql', label: 'Mirror Azure SQL', help: 'Allow users to set up Azure SQL Mirror jobs.', default: true },
      { id: 'mirror.snowflake', label: 'Mirror Snowflake', help: 'Allow Snowflake Mirror jobs.', default: true },
      { id: 'mirror.cosmos', label: 'Mirror Cosmos DB', help: 'Allow Cosmos DB Mirror jobs.', default: false },
    ],
  },
  {
    id: 'synapse',
    label: 'Synapse passthrough',
    description: 'Dedicated SQL pool, Serverless SQL pool, Spark pool.',
    toggles: [
      { id: 'synapse.dedicatedPool', label: 'Dedicated SQL pool', help: 'Allow users to query the Loom-deployed Synapse Dedicated SQL pool.', default: true },
      { id: 'synapse.serverlessPool', label: 'Serverless SQL pool', help: 'Allow users to query the Synapse Serverless SQL pool.', default: true },
      { id: 'synapse.sparkPool', label: 'Spark pool (notebooks)', help: 'Allow notebooks to dispatch to the Synapse Spark pool via Livy.', default: true },
      { id: 'synapse.autoPause', label: 'Auto-pause Dedicated pool', help: 'Logic App pauses the Dedicated pool nightly to cut cost. Disable for 24/7 workloads.', default: true },
    ],
  },
  {
    id: 'databricks',
    label: 'Databricks passthrough',
    description: 'SQL Warehouses + Jobs + cluster compute.',
    toggles: [
      { id: 'databricks.sqlWarehouses', label: 'SQL Warehouses', help: 'Allow editor access to Databricks SQL Warehouses.', default: true },
      { id: 'databricks.jobs', label: 'Jobs', help: 'Allow Databricks Jobs create / run / schedule.', default: true },
      { id: 'databricks.notebooks', label: 'Notebooks', help: 'Allow Databricks notebook task dispatch from Loom.', default: true },
    ],
  },
  {
    id: 'adf',
    label: 'ADF passthrough',
    description: 'Azure Data Factory pipelines + datasets + triggers.',
    toggles: [
      { id: 'adf.pipelines', label: 'Pipelines', help: 'Allow ADF pipeline create / run.', default: true },
      { id: 'adf.triggers', label: 'Triggers', help: 'Allow ADF trigger create / enable.', default: true },
    ],
  },
  {
    id: 'git',
    label: 'Git integration',
    description: 'Workspace-level Git source control.',
    toggles: [
      { id: 'git.azdoEnabled', label: 'Azure DevOps Git', help: 'Allow workspaces to bind to Azure DevOps repos.', default: true },
      { id: 'git.githubEnabled', label: 'GitHub Git', help: 'Allow workspaces to bind to GitHub repos.', default: true },
      { id: 'git.commitsRequirePR', label: 'Require PR for main', help: 'Block direct commits to the default branch.', default: false },
    ],
  },
  {
    id: 'domains',
    label: 'Domains',
    description: 'Business-area grouping for workspaces (Finance, Operations, etc.).',
    toggles: [
      { id: 'domains.enabled', label: 'Domains enabled', help: 'Show domain selector across workspaces.', default: true },
      { id: 'domains.delegatedAdmin', label: 'Delegated domain admins', help: 'Allow per-domain admin roles.', default: false },
    ],
  },
  {
    id: 'infoProtection',
    label: 'Information protection',
    description: 'Sensitivity labels + DLP.',
    toggles: [
      { id: 'info.sensitivityLabels', label: 'Sensitivity labels', help: 'Surface Microsoft Purview Information Protection labels on items.', default: true },
      { id: 'info.requireLabel', label: 'Require label on new items', help: 'Block save of new items until a label is applied.', default: false },
      { id: 'info.dlpScanning', label: 'DLP scanning', help: 'Allow Purview DLP scans of OneLake.', default: false },
    ],
  },
  {
    id: 'exportSharing',
    label: 'Export & sharing',
    description: 'Outbound data flows from Loom.',
    toggles: [
      { id: 'export.csv', label: 'Allow CSV export', help: 'Allow users to download query results / Lakehouse files as CSV.', default: true },
      { id: 'export.publishToWeb', label: 'Publish to web', help: 'Allow reports to be published publicly. Highly recommend OFF for sensitive tenants.', default: false },
      { id: 'export.shareWithExternal', label: 'Share with external users', help: 'Allow share-link to B2B guests.', default: false },
    ],
  },
  {
    id: 'helpSupport',
    label: 'Help & support',
    description: 'In-product feedback + telemetry.',
    toggles: [
      { id: 'help.feedbackWidget', label: 'Send-feedback widget', help: 'Show the feedback widget in the topbar.', default: true },
      { id: 'help.diagnosticsBundle', label: 'Diagnostics bundle export', help: 'Let admins export a diagnostics bundle for Microsoft support.', default: true },
    ],
  },
  {
    id: 'billing',
    label: 'Billing',
    description: 'Capacity + Azure Cost Management integration.',
    toggles: [
      { id: 'billing.costMgmtEmbed', label: 'Azure Cost Management embed', help: 'Embed cost dashboards in /admin/capacity.', default: false },
      { id: 'billing.chargebackTagging', label: 'Per-domain chargeback tagging', help: 'Tag Azure resources with /domain when items are created.', default: false },
    ],
  },
  {
    id: 'purview',
    label: 'Purview integration',
    description: 'Bind Loom to a Microsoft Purview account.',
    toggles: [
      { id: 'purview.bound', label: 'Purview account bound', help: 'Bind Loom to a Purview account. Requires LOOM_PURVIEW_ACCOUNT env + Console UAMI Purview RBAC.', default: false, learnUrl: 'https://learn.microsoft.com/purview/' },
      { id: 'purview.lineageSync', label: 'Lineage sync', help: 'Continuously sync Loom item edges to Purview lineage.', default: false },
      { id: 'purview.scanScheduling', label: 'Scan scheduling from Loom', help: 'Allow admins to schedule Purview scans from /governance/scans.', default: false },
    ],
  },
  {
    id: 'dataProducts',
    label: 'Data Products',
    description: 'Data product store adapter. Backend: Cosmos (default) | Purview Unified Catalog. The active backend is shown by the indicator below; routing is env-driven (Commercial only for Purview Unified Catalog).',
    toggles: [
      {
        id: 'dataProducts.purviewUnifiedEnabled',
        label: 'Purview Unified Catalog adapter',
        help: 'When enabled (LOOM_DATAPRODUCTS_BACKEND=purview-unified + LOOM_PURVIEW_UNIFIED_ACCOUNT set + cloud=Commercial), data products are stored/retrieved via the Purview Unified Catalog REST API (2026-03-20-preview) instead of Cosmos. On GCC / GCC-High / IL5 the factory silently falls back to Cosmos regardless of this toggle. This switch is informational — actual routing is driven by the deployment env vars, surfaced live by /api/admin/data-products-backend.',
        default: false,
        learnUrl: 'https://learn.microsoft.com/rest/api/purview/unified-catalog-api-overview',
      },
    ],
  },
  {
    id: 'legacyAdla',
    label: 'U-SQL legacy (ADLA)',
    description: 'ADLA reached end-of-life in 2024. This category exists only to surface migration UI.',
    toggles: [
      { id: 'legacy.adlaMigrationHint', label: 'Show ADLA → Stream Analytics migration hint', help: 'When users click the legacy usql-job editor, surface a guided migration MessageBar.', default: true },
    ],
  },
];

/**
 * Build the default settings doc for a new tenant — all toggles set to their
 * `default` value. Tenants can override individual toggles via the UI.
 */
export function defaultSettings(): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const g of TENANT_SETTING_GROUPS) {
    for (const t of g.toggles) {
      out[t.id] = t.default;
    }
  }
  return out;
}

export interface TenantSettingsDoc {
  /** id = tenantId (one doc per tenant). */
  id: string;
  tenantId: string;
  settings: Record<string, boolean>;
  /** Audit metadata. */
  updatedAt: string;
  updatedBy: string;
}
