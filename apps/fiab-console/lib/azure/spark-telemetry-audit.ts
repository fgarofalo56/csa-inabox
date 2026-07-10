/**
 * Spark-telemetry reconciler — the real backend behind
 * /api/admin/spark-telemetry/audit and the Capacity & compute "Spark telemetry"
 * card. Enforces the die-hard rule that EVERY Spark-capable engine in the estate
 * (Synapse Spark, Databricks, Azure ML) routes its diagnostic logs + metrics to
 * the ONE Loom Log Analytics workspace — the same LAW the Spark-insights reports
 * read from.
 *
 * Loom's bicep wires the standardized diagnostic setting (`diag-loom-stdz`) on
 * each of these workspaces at deploy time (databricks.bicep, synapse.bicep,
 * deploy-planner/ml-workspace.bicep). This reconciler is the RUNTIME safety net:
 * it enumerates the live Spark resources, checks each has a setting routing to
 * the Loom LAW, and APPLIES the missing ones (ARM PUT) — covering config drift
 * and any Spark workspace attached after the initial deploy. Default-ON, no
 * approval gate: "Apply all" is one click.
 *
 * Built on the generic diagnostics primitives in monitor-client
 * (getDiagnosticsCoverage / enableDiagnostics) so there is ONE ARM/diag code
 * path — this module only adds the Spark-engine filter, the per-engine telemetry
 * catalog, the session-emitter status, and last-run persistence.
 *
 * Auth: the Console UAMI needs "Monitoring Contributor" on the Loom
 * subscription/RGs to PUT diagnostic settings (Monitoring Reader is enough for
 * the read-only audit). Honest gate: MonitorNotConfiguredError names the exact
 * env var (LOOM_LOG_ANALYTICS_RESOURCE_ID) when the LAW coordinate is unset.
 *
 * Learn:
 *   https://learn.microsoft.com/azure/azure-monitor/reference/supported-logs/microsoft-machinelearningservices-workspaces-logs
 *   https://learn.microsoft.com/azure/databricks/admin/account-settings/audit-log-delivery
 *   https://learn.microsoft.com/azure/synapse-analytics/monitor-synapse-analytics-reference
 */

import {
  getDiagnosticsCoverage,
  enableDiagnostics,
  logAnalyticsResourceId,
  clearMonitorCache,
  MonitorError,
  MonitorNotConfiguredError,
  type DiagCoverage,
} from './monitor-client';
import { synapseLogAnalyticsConfigured } from '@/lib/spark/config-presets';
import { maintenanceJobsContainer } from './cosmos-client';

export { MonitorNotConfiguredError } from './monitor-client';

// ----------------------------------------------------------------------------
// The Spark-capable engines + what each emits to the LAW once wired.
// ----------------------------------------------------------------------------

export type SparkEngine = 'synapse-spark' | 'databricks' | 'aml';

interface EngineSpec {
  engine: SparkEngine;
  label: string;
  /** Log Analytics tables the engine's telemetry lands in once diagnostics flow. */
  tables: string[];
  /** How the diagnostic setting is provisioned (for the UI's "what this covers"). */
  note: string;
}

/** ARM type (lowercased) → engine spec. */
const SPARK_ENGINE_BY_TYPE: Record<string, EngineSpec> = {
  'microsoft.synapse/workspaces': {
    engine: 'synapse-spark',
    label: 'Synapse Spark',
    tables: [
      'SynapseBigDataPoolApplicationsEnded',
      'SparkListenerEvent_CL',
      'SparkMetrics_CL',
      'SparkLoggingEvent_CL',
    ],
    note:
      'Workspace + Spark-pool diagnostics (BigDataPoolAppsEnded) plus the per-session '
      + 'spark.synapse.logAnalytics emitter (SparkListenerEvent / SparkMetrics).',
  },
  'microsoft.databricks/workspaces': {
    engine: 'databricks',
    label: 'Databricks',
    tables: ['DatabricksClusters', 'DatabricksJobs', 'DatabricksNotebook', 'DatabricksSparkAnalytics'],
    note: 'Workspace diagnostic settings — clusters, jobs, notebook, unityCatalog, sqlanalytics.',
  },
  'microsoft.machinelearningservices/workspaces': {
    engine: 'aml',
    label: 'Azure ML',
    tables: ['AmlComputeJobEvent', 'AmlComputeClusterEvent', 'AmlComputeCpuGpuUtilization', 'AmlRunStatusChangedEvent'],
    note: 'Workspace diagnostics (allLogs) — AmlCompute job/cluster events cover managed/serverless Spark jobs.',
  },
};

const SPARK_RESOURCE_TYPES = new Set(Object.keys(SPARK_ENGINE_BY_TYPE));

function engineForType(type: string): EngineSpec | undefined {
  return SPARK_ENGINE_BY_TYPE[type.toLowerCase()];
}

// ----------------------------------------------------------------------------
// Report shapes
// ----------------------------------------------------------------------------

export interface SparkTelemetryResource {
  id: string;
  name: string;
  type: string;
  resourceGroup: string;
  engine: SparkEngine;
  engineLabel: string;
  /** A diagnostic setting exists that routes this resource's logs to the Loom LAW. */
  routesToLoomLaw: boolean;
  /** Names of existing diagnostic settings (any destination). */
  settingNames: string[];
  /** LA tables this engine's telemetry lands in once diagnostics flow. */
  tables: string[];
  /** Provisioning note for the UI. */
  note: string;
  /** Set when the per-resource probe failed for a non-"unsupported" reason. */
  probeNote?: string;
}

export interface SparkTelemetryAudit {
  generatedAt: string;
  /** The Loom LAW resource id every setting should route to. */
  lawResourceId: string;
  /**
   * Whether the per-session Synapse→LA emitter is configured (LOOM_SPARK_LA_*).
   * The workspace/pool diagnostic setting gives app-completion records; the
   * emitter gives the fine-grained executor/task metrics the reports use.
   */
  sessionEmitterConfigured: boolean;
  summary: { total: number; covered: number; missing: number };
  resources: SparkTelemetryResource[];
}

export interface ApplyResult {
  id: string;
  name: string;
  engine: SparkEngine;
  ok: boolean;
  /** enableDiagnostics mode on success (e.g. 'allLogs+AllMetrics'). */
  mode?: string;
  error?: string;
}

export interface ApplyReport {
  appliedAt: string;
  attempted: number;
  succeeded: number;
  failed: number;
  results: ApplyResult[];
}

// ----------------------------------------------------------------------------
// Audit
// ----------------------------------------------------------------------------

function toResource(c: DiagCoverage): SparkTelemetryResource {
  const spec = engineForType(c.type)!; // caller filters to spark types first
  return {
    id: c.id,
    name: c.name,
    type: c.type,
    resourceGroup: c.resourceGroup,
    engine: spec.engine,
    engineLabel: spec.label,
    routesToLoomLaw: c.routesToLoomLaw,
    settingNames: c.settingNames,
    tables: spec.tables,
    note: spec.note,
    probeNote: c.note,
  };
}

/**
 * Audit Spark-telemetry coverage across every Spark-capable engine in the
 * estate. Throws MonitorNotConfiguredError when LOOM_LOG_ANALYTICS_RESOURCE_ID
 * is unset (→ honest gate). Read-only (no writes).
 */
export async function auditSparkTelemetry(): Promise<SparkTelemetryAudit> {
  const lawResourceId = logAnalyticsResourceId();
  if (!lawResourceId) throw new MonitorNotConfiguredError(['LOOM_LOG_ANALYTICS_RESOURCE_ID']);

  const coverage = await getDiagnosticsCoverage();
  const resources = coverage
    .filter((c) => SPARK_RESOURCE_TYPES.has(c.type.toLowerCase()))
    .map(toResource)
    // Deterministic: engine, then name.
    .sort((a, b) => (a.engine === b.engine ? a.name.localeCompare(b.name) : a.engine.localeCompare(b.engine)));

  const covered = resources.filter((r) => r.routesToLoomLaw).length;
  return {
    generatedAt: new Date().toISOString(),
    lawResourceId,
    sessionEmitterConfigured: synapseLogAnalyticsConfigured(),
    summary: { total: resources.length, covered, missing: resources.length - covered },
    resources,
  };
}

// ----------------------------------------------------------------------------
// Apply (default-ON, no approval gate)
// ----------------------------------------------------------------------------

/**
 * Apply the standardized Loom diagnostic setting to Spark resources missing it.
 * When `ids` is omitted, every Spark resource whose telemetry isn't routing to
 * the Loom LAW is remediated. When `ids` is given, only those (and only if they
 * are Spark resources still missing coverage) are touched — so a stale client id
 * can never enable diagnostics on an arbitrary resource. Idempotent.
 */
export async function applySparkTelemetry(ids?: string[]): Promise<ApplyReport> {
  const lawResourceId = logAnalyticsResourceId();
  if (!lawResourceId) throw new MonitorNotConfiguredError(['LOOM_LOG_ANALYTICS_RESOURCE_ID']);

  const audit = await auditSparkTelemetry();
  const missing = audit.resources.filter((r) => !r.routesToLoomLaw);
  const wanted = ids && ids.length
    ? missing.filter((r) => ids.includes(r.id))
    : missing;

  const results: ApplyResult[] = [];
  for (const r of wanted) {
    try {
      const { mode } = await enableDiagnostics(r.id);
      results.push({ id: r.id, name: r.name, engine: r.engine, ok: true, mode });
    } catch (e) {
      results.push({
        id: r.id, name: r.name, engine: r.engine, ok: false,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
  // enableDiagnostics already clears the coverage cache per-call; clear once more
  // so a subsequent audit in the same request reflects every change.
  if (results.some((x) => x.ok)) clearMonitorCache();

  const succeeded = results.filter((x) => x.ok).length;
  return {
    appliedAt: new Date().toISOString(),
    attempted: results.length,
    succeeded,
    failed: results.length - succeeded,
    results,
  };
}

// ----------------------------------------------------------------------------
// Last-run persistence (Cosmos: maintenance-jobs container, /tenantId partition)
// ----------------------------------------------------------------------------

const LAST_RUN_ID = 'spark-telemetry-audit-last-run';

interface LastRunDoc {
  id: string;
  tenantId: string;
  kind: 'spark-telemetry-audit';
  audit: SparkTelemetryAudit;
  lastApply?: ApplyReport;
  updatedAt: string;
  updatedBy?: string;
}

/** Persist the latest audit (and optional apply report) for a tenant. Best-effort. */
export async function saveLastRun(
  tenantId: string,
  audit: SparkTelemetryAudit,
  lastApply?: ApplyReport,
  updatedBy?: string,
): Promise<void> {
  if (!tenantId) return;
  const doc: LastRunDoc = {
    id: LAST_RUN_ID,
    tenantId,
    kind: 'spark-telemetry-audit',
    audit,
    lastApply,
    updatedAt: new Date().toISOString(),
    updatedBy,
  };
  const c = await maintenanceJobsContainer();
  await c.items.upsert(doc);
}

/** Read the last persisted audit/apply for a tenant, or null. Best-effort. */
export async function readLastRun(
  tenantId: string,
): Promise<{ audit: SparkTelemetryAudit; lastApply?: ApplyReport; updatedAt: string; updatedBy?: string } | null> {
  if (!tenantId) return null;
  try {
    const c = await maintenanceJobsContainer();
    const { resource } = await c.item(LAST_RUN_ID, tenantId).read<LastRunDoc>();
    if (!resource) return null;
    return {
      audit: resource.audit,
      lastApply: resource.lastApply,
      updatedAt: resource.updatedAt,
      updatedBy: resource.updatedBy,
    };
  } catch {
    return null;
  }
}

export { MonitorError };
