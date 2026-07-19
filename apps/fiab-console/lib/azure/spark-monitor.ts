/**
 * Spark observability client — the real backend behind Monitor → Spark
 * (analytics + performance-tuning + troubleshooting for Spark applications and
 * runs). Reads live Log Analytics only; no mocks, no sample data.
 *
 * Data sources (all in the Loom Log Analytics workspace):
 *   - Synapse Spark → LA diagnostic emitter: SparkListenerEvent_CL /
 *     SparkMetrics_CL / SparkLoggingEvent_CL (enabled via the
 *     spark.synapse.logAnalytics.* confs every Loom session ships — see
 *     lib/spark/config-presets.synapseLogAnalyticsConf()).
 *   - Databricks workspace diagnostic settings: DatabricksJobs (run history).
 *
 * Every KQL leads with `union isfuzzy=true (<table>)` + `column_ifexists(...)`
 * so a workspace WITHOUT the Spark diagnostic tables (telemetry not wired yet)
 * degrades to ZERO rows instead of a 400 BadArgumentError — exactly the pattern
 * monitor-client.queryActivityFeed / queryLoomAppEvents use. The honest gate
 * (MonitorNotConfiguredError → MessageBar naming the env var) fires only when
 * the workspace id itself is unset.
 *
 * The tuning-recommendation engine (recommendTuning) is a PURE function over a
 * metrics summary — deterministic, unit-tested, and decoupled from KQL — so the
 * heuristics are reviewable and the UI can map each rec onto an "Apply" action
 * in the Spark config builder.
 *
 * Learn:
 *   https://learn.microsoft.com/azure/synapse-analytics/spark/azure-monitor-add-on
 *   https://learn.microsoft.com/azure/databricks/admin/account-settings/audit-logs
 *   https://spark.apache.org/docs/latest/sql-performance-tuning.html
 */

import { queryLogs, MonitorNotConfiguredError, logAnalyticsWorkspaceId } from './monitor-client';

export { MonitorNotConfiguredError } from './monitor-client';

// ----------------------------------------------------------------------------
// Applications + runs
// ----------------------------------------------------------------------------

export interface SparkApplication {
  appId: string;
  name: string;
  /** 'synapse-spark' | 'databricks' — which engine emitted the telemetry. */
  engine: 'synapse-spark' | 'databricks';
  pool?: string;          // Synapse Spark pool / Databricks cluster
  user?: string;
  start?: string;         // ISO 8601
  end?: string;           // ISO 8601
  durationMs?: number;
  status?: string;        // Succeeded | Failed | Running | Unknown
  /** count of listener/metric events seen for this app (telemetry volume). */
  events?: number;
}

export interface SparkAppsOpts {
  days?: number;          // lookback; default 7; clamped 1..30
  limit?: number;         // row cap; default 100; clamped 1..500
}

/**
 * Recent Spark applications / runs across Synapse Spark + Databricks, from Log
 * Analytics. Throws MonitorNotConfiguredError when the workspace id is unset
 * (→ honest gate). Returns [] (not an error) when configured but the Spark
 * diagnostic tables don't exist / are empty — the pane then renders the
 * "telemetry not flowing yet" note + the native-diag links.
 */
export async function listSparkApplications(opts: SparkAppsOpts = {}): Promise<SparkApplication[]> {
  if (!logAnalyticsWorkspaceId()) throw new MonitorNotConfiguredError(['LOOM_LOG_ANALYTICS_WORKSPACE_ID']);
  const days = Math.min(30, Math.max(1, opts.days ?? 7));
  const limit = Math.min(500, Math.max(1, opts.limit ?? 100));

  // Synapse Spark: aggregate the listener stream into one row per applicationId.
  // column_ifexists keeps the projection valid whether the table exists or not
  // (and tolerates the schema-version differences in the _CL column names).
  const kql = `
union isfuzzy=true (SparkListenerEvent_CL
  | where TimeGenerated >= ago(${days}d)
  | extend
      _appId = tostring(column_ifexists("applicationId_s", column_ifexists("AppId_s", ""))),
      _name  = tostring(column_ifexists("applicationName_s", column_ifexists("AppName_s", ""))),
      _pool  = tostring(column_ifexists("sparkPoolName_s", column_ifexists("SparkPool_s", ""))),
      _user  = tostring(column_ifexists("submitter_s", column_ifexists("user_s", "")))
  | where isnotempty(_appId)
  | summarize _start=min(TimeGenerated), _end=max(TimeGenerated), _events=count(),
              name=any(_name), pool=any(_pool), user=any(_user) by appId=_appId
  | project appId, name, pool, user, start=_start, end=_end, events=_events,
            engine="synapse-spark", status="")
union isfuzzy=true (SynapseBigDataPoolApplicationsEnded
  // Pool DIAGNOSTIC-SETTINGS stream (BigDataPoolAppsEnded → this table) — the
  // control-plane route that works even when the in-session LA emitter cannot:
  // on a workspace with preventDataExfiltration=true the managed VNet blocks
  // the emitter's egress and a session carrying the spark.synapse.logAnalytics
  // confs DIES at startup (live receipt 2026-07-18: sessions 44/48 + warm-pool
  // sessions all state=dead while conf-less sessions ran fine). One row per
  // ENDED application with livyState + submit/start/end times in Properties.
  | where TimeGenerated >= ago(${days}d)
  | extend p = parse_json(Properties)
  | extend
      _appId = tostring(p.applicationId),
      _name  = tostring(p.applicationName),
      _pool  = tostring(extract(@"/bigdatapools/([^/]+)$", 1, tolower(_ResourceId))),
      _user  = tostring(p.submitterId),
      _state = tolower(tostring(p.livyState)),
      _start = todatetime(p.startTime),
      _end   = todatetime(p.endTime)
  | where isnotempty(_appId)
  | summarize _startm=min(_start), _endm=max(_end), _events=count(),
              name=any(_name), pool=any(_pool), user=any(_user), st=any(_state) by appId=_appId
  | project appId, name, pool, user, start=_startm, end=_endm, events=_events,
            engine="synapse-spark",
            status=case(st == "success", "Succeeded", st in ("dead", "killed", "error"), "Failed", "Unknown"))
union isfuzzy=true (DatabricksJobs
  | where TimeGenerated >= ago(${days}d)
  | extend
      _rid    = tostring(column_ifexists("RequestId_s", column_ifexists("RunId_s", ""))),
      _name   = tostring(column_ifexists("JobName_s", column_ifexists("ActionName_s", "Databricks job"))),
      _cluster= tostring(column_ifexists("ClusterId_s", "")),
      _user   = tostring(column_ifexists("UserName_s", column_ifexists("Identity_s", ""))),
      _res    = tostring(column_ifexists("Response_s", ""))
  | where isnotempty(_rid)
  | summarize _start=min(TimeGenerated), _end=max(TimeGenerated), _events=count(),
              name=any(_name), pool=any(_cluster), user=any(_user), res=any(_res) by appId=_rid
  | project appId, name, pool, user, start=_start, end=_end, events=_events,
            engine="databricks",
            status=iff(res has "error" or res has "FAILED", "Failed", ""))
| order by start desc
| take ${limit}
`.trim();

  let result;
  try {
    result = await queryLogs(kql, `P${days}D`);
  } catch (e: any) {
    // Degrade an unresolved-table / syntax rejection to ZERO apps (telemetry not
    // wired) rather than failing the pane. Auth + not-configured still propagate.
    if (e?.status === 400 && /invalid propert|SyntaxError|SemanticError|Failed to resolve|could not be found/i.test(`${e.message} ${JSON.stringify(e.body ?? '')}`)) {
      return [];
    }
    throw e;
  }

  const at = (n: string) => result!.columns.indexOf(n);
  const i = {
    appId: at('appId'), name: at('name'), pool: at('pool'), user: at('user'),
    start: at('start'), end: at('end'), events: at('events'), engine: at('engine'), status: at('status'),
  };
  const str = (row: unknown[], idx: number) => (idx >= 0 ? String(row[idx] ?? '') : '');
  return result.rows.map((row): SparkApplication => {
    const start = str(row, i.start);
    const end = str(row, i.end);
    let durationMs: number | undefined;
    if (start && end) {
      const ms = new Date(end).getTime() - new Date(start).getTime();
      if (Number.isFinite(ms) && ms >= 0) durationMs = ms;
    }
    const eventsRaw = i.events >= 0 ? Number(row[i.events]) : NaN;
    return {
      appId: str(row, i.appId),
      name: str(row, i.name) || '(unnamed)',
      engine: (str(row, i.engine) as SparkApplication['engine']) || 'synapse-spark',
      pool: str(row, i.pool) || undefined,
      user: str(row, i.user) || undefined,
      start: start || undefined,
      end: end || undefined,
      durationMs,
      status: str(row, i.status) || undefined,
      events: Number.isFinite(eventsRaw) ? eventsRaw : undefined,
    };
  });
}

// ----------------------------------------------------------------------------
// Per-application metrics summary (drives the analytics charts + tuning recs)
// ----------------------------------------------------------------------------

export interface SparkAppMetrics {
  appId: string;
  /** Bytes spilled to disk during shuffles (a top tuning signal). */
  diskSpillBytes?: number;
  shuffleReadBytes?: number;
  shuffleWriteBytes?: number;
  /** Total JVM GC time across executors (ms). */
  gcTimeMs?: number;
  /** Total executor run time across tasks (ms) — GC% denominator. */
  executorRunTimeMs?: number;
  /** Max vs median task duration (ms) — skew signal. */
  maxTaskMs?: number;
  medianTaskMs?: number;
  failedTasks?: number;
  inputBytes?: number;
  /** Peak concurrent executors observed. */
  executorCount?: number;
  /** Mean executor utilization 0..1 (busy time / wall time) when derivable. */
  executorAvgUtilization?: number;
}

/**
 * Best-effort per-app metric summary from SparkMetrics_CL. Returns a partial
 * shape — missing metrics stay undefined and the recs engine simply skips the
 * heuristics it can't evaluate (no fabricated numbers). Empty/absent table →
 * `{ appId }` with everything undefined.
 */
export async function getSparkAppMetrics(appId: string, days = 7): Promise<SparkAppMetrics> {
  if (!logAnalyticsWorkspaceId()) throw new MonitorNotConfiguredError(['LOOM_LOG_ANALYTICS_WORKSPACE_ID']);
  const safeAppId = JSON.stringify(appId); // KQL string literal, injection-safe
  const d = Math.min(30, Math.max(1, days));
  const kql = `
union isfuzzy=true (SparkMetrics_CL
  | where TimeGenerated >= ago(${d}d)
  | where tostring(column_ifexists("applicationId_s", column_ifexists("AppId_s", ""))) == ${safeAppId}
  | extend _name = tostring(column_ifexists("name_s", column_ifexists("MetricName_s", ""))),
           _val  = todouble(column_ifexists("value_d", column_ifexists("count_d", real(null))))
  | summarize v=sum(_val) by metric=_name)
| where isnotempty(metric)
`.trim();

  const out: SparkAppMetrics = { appId };
  let result;
  try {
    result = await queryLogs(kql, `P${d}D`);
  } catch (e: any) {
    if (e?.status === 400) return out; // table/schema absent → empty summary
    throw e;
  }
  const mIdx = result.columns.indexOf('metric');
  const vIdx = result.columns.indexOf('v');
  if (mIdx < 0 || vIdx < 0) return out;
  const byMetric = new Map<string, number>();
  for (const row of result.rows) {
    const m = String(row[mIdx] ?? '').toLowerCase();
    const v = Number(row[vIdx]);
    if (m && Number.isFinite(v)) byMetric.set(m, v);
  }
  // Map well-known Spark metric names (substring match — names vary by version).
  const pick = (...needles: string[]): number | undefined => {
    for (const [k, v] of byMetric) if (needles.some((n) => k.includes(n))) return v;
    return undefined;
  };
  out.diskSpillBytes = pick('diskbytesspilled', 'disk_bytes_spilled');
  out.shuffleReadBytes = pick('shuffletotalbytesread', 'shuffle_read');
  out.shuffleWriteBytes = pick('shufflebyteswritten', 'shuffle_write');
  out.gcTimeMs = pick('jvmgctime', 'gc_time');
  out.executorRunTimeMs = pick('executorruntime', 'executor_run_time');
  out.inputBytes = pick('inputbytes', 'input_bytes');
  out.failedTasks = pick('failedtasks', 'failed_tasks');
  return out;
}

// ----------------------------------------------------------------------------
// Performance-tuning recommendation engine (PURE — unit-tested)
// ----------------------------------------------------------------------------

export interface TuningRec {
  id: string;
  severity: 'info' | 'warning' | 'critical';
  title: string;
  detail: string;
  /** Concrete spark.* changes to apply (surfaced as "Apply" in the builder). */
  conf?: { key: string; value: string }[];
  /** A preset that addresses this pattern, if one fits. */
  presetId?: string;
}

/**
 * Heuristic tuning recommendations from a metrics summary. Each heuristic only
 * fires when its inputs are present, so a sparse summary yields fewer (never
 * fabricated) recs. Thresholds follow Spark SQL performance-tuning guidance.
 */
export function recommendTuning(m: SparkAppMetrics): TuningRec[] {
  const recs: TuningRec[] = [];

  // 1) Disk spill — shuffle/agg memory pressure.
  const shuffle = (m.shuffleReadBytes ?? 0) + (m.shuffleWriteBytes ?? 0);
  if (typeof m.diskSpillBytes === 'number' && m.diskSpillBytes > 0) {
    const ratio = shuffle > 0 ? m.diskSpillBytes / shuffle : 1;
    if (m.diskSpillBytes > 1_073_741_824 || ratio > 0.05) {
      recs.push({
        id: 'disk-spill',
        severity: ratio > 0.25 ? 'critical' : 'warning',
        title: 'Significant disk spill during shuffles',
        detail: `~${fmtBytes(m.diskSpillBytes)} spilled to disk. Raise shuffle parallelism (smaller partitions) and/or executor memory so shuffles fit in RAM.`,
        conf: [{ key: 'spark.sql.shuffle.partitions', value: '400' }],
        presetId: 'large-shuffle',
      });
    }
  }

  // 2) Task skew — long tail dominates the stage.
  if (typeof m.maxTaskMs === 'number' && typeof m.medianTaskMs === 'number' && m.medianTaskMs > 0) {
    const skew = m.maxTaskMs / m.medianTaskMs;
    if (skew >= 3) {
      recs.push({
        id: 'task-skew',
        severity: skew >= 6 ? 'critical' : 'warning',
        title: 'Task skew detected (long-tail partitions)',
        detail: `Slowest task is ${skew.toFixed(1)}× the median. Enable Adaptive Query Execution skew-join handling so Spark splits the heavy partitions.`,
        conf: [
          { key: 'spark.sql.adaptive.enabled', value: 'true' },
          { key: 'spark.sql.adaptive.skewJoin.enabled', value: 'true' },
        ],
        presetId: 'large-shuffle',
      });
    }
  }

  // 3) GC pressure — too much time in garbage collection.
  if (typeof m.gcTimeMs === 'number' && typeof m.executorRunTimeMs === 'number' && m.executorRunTimeMs > 0) {
    const gcPct = m.gcTimeMs / m.executorRunTimeMs;
    if (gcPct > 0.1) {
      recs.push({
        id: 'gc-pressure',
        severity: gcPct > 0.2 ? 'critical' : 'warning',
        title: 'High JVM garbage-collection time',
        detail: `~${(gcPct * 100).toFixed(0)}% of executor time was GC. Increase executor memory (fewer, larger executors) or reduce per-task data; consider Kryo serialization.`,
        conf: [{ key: 'spark.serializer', value: 'org.apache.spark.serializer.KryoSerializer' }],
        presetId: 'large-shuffle',
      });
    }
  }

  // 4) Failed tasks — reliability, point at troubleshooting.
  if (typeof m.failedTasks === 'number' && m.failedTasks > 0) {
    recs.push({
      id: 'failed-tasks',
      severity: 'warning',
      title: `${m.failedTasks} failed task(s)`,
      detail: 'Tasks failed and were retried — this inflates runtime and can mask OOM/skew. Open the application in the native Spark UI to inspect failed-stage stack traces.',
    });
  }

  // 5) Under-utilized executors — over-provisioned, costs money.
  if (typeof m.executorAvgUtilization === 'number' && m.executorAvgUtilization < 0.4 && (m.executorCount ?? 0) >= 2) {
    recs.push({
      id: 'under-utilized',
      severity: 'info',
      title: 'Executors under-utilized',
      detail: `Mean executor utilization ~${(m.executorAvgUtilization * 100).toFixed(0)}%. Lower the executor count or use a cost-optimized / autoscaling profile to cut spend.`,
      presetId: 'cost-optimized',
    });
  }

  // 6) Many small input files — raise partition size for fewer tasks.
  if (typeof m.inputBytes === 'number' && typeof m.maxTaskMs === 'number' && m.inputBytes > 0 && m.maxTaskMs < 1000 && (m.executorCount ?? 0) >= 1) {
    recs.push({
      id: 'small-files',
      severity: 'info',
      title: 'Many small/short tasks (possible small-file problem)',
      detail: 'Lots of very short tasks suggests reading many small files. Increase the input partition size so each task does more work.',
      conf: [{ key: 'spark.sql.files.maxPartitionBytes', value: '134217728' }],
      presetId: 'high-parallelism',
    });
  }

  if (recs.length === 0) {
    recs.push({
      id: 'healthy',
      severity: 'info',
      title: 'No tuning issues detected',
      detail: 'The available metrics show no spill, skew, GC pressure, or failures worth acting on. Keep the current configuration.',
    });
  }
  return recs;
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const u = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024, i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(1)} ${u[i]}`;
}

// ----------------------------------------------------------------------------
// Portfolio scan — powers the Troubleshooting + Optimization report views
// ----------------------------------------------------------------------------
//
// The list view drills into ONE app on demand. The Troubleshooting and
// Optimization reports need a cross-application view, so this scans the most
// recent apps (bounded sample) once, reads each one's metric summary, runs the
// same PURE recommendTuning engine, and aggregates:
//   - failures      → apps that failed or show failure signals (failed tasks / a
//                     critical tuning finding), for the Troubleshooting report.
//   - optimization  → tuning recs deduplicated across the sample, each with the
//                     count of affected apps, for the Optimization report.
// Bounded (sample clamped 1..25) so the fan-out of per-app metric queries stays
// small. All real LA data; a configured-but-empty workspace yields empty arrays.

export interface FailureInsight {
  appId: string;
  name: string;
  engine: SparkApplication['engine'];
  pool?: string;
  user?: string;
  start?: string;
  durationMs?: number;
  /** Human-readable failure signal (why it's in the troubleshooting list). */
  errorSignal: string;
}

export interface OptimizationInsight {
  /** Rec id from recommendTuning (disk-spill, task-skew, gc-pressure, …). */
  id: string;
  severity: TuningRec['severity'];
  title: string;
  detail: string;
  conf?: { key: string; value: string }[];
  presetId?: string;
  /** How many sampled apps triggered this recommendation. */
  affectedApps: number;
  /** A few example app ids that triggered it. */
  sampleAppIds: string[];
}

export interface SparkInsightsScan {
  scannedAt: string;
  windowDays: number;
  /** Apps whose metrics were actually read (the bounded sample). */
  sampled: number;
  /** Total recent apps seen in the window (may exceed `sampled`). */
  totalApps: number;
  failures: FailureInsight[];
  optimization: OptimizationInsight[];
  /** Wall-clock scan time (drives the reports' timing status bar). */
  elapsedMs: number;
}

const SEVERITY_RANK: Record<TuningRec['severity'], number> = { info: 0, warning: 1, critical: 2 };

/**
 * Scan recent Spark applications and build the cross-app Troubleshooting +
 * Optimization reports. Throws MonitorNotConfiguredError when the workspace id
 * is unset (→ honest gate). Returns empty arrays (not an error) when configured
 * but no Spark telemetry has arrived.
 */
export async function scanSparkInsights(
  opts: { days?: number; sample?: number } = {},
): Promise<SparkInsightsScan> {
  if (!logAnalyticsWorkspaceId()) throw new MonitorNotConfiguredError(['LOOM_LOG_ANALYTICS_WORKSPACE_ID']);
  const started = Date.now();
  const days = Math.min(30, Math.max(1, opts.days ?? 7));
  const sample = Math.min(25, Math.max(1, opts.sample ?? 12));

  const apps = await listSparkApplications({ days, limit: Math.max(sample, 100) });
  const scanned = apps.slice(0, sample);

  // Read each sampled app's metric summary + recs in parallel (bounded by sample).
  const perApp = await Promise.all(
    scanned.map(async (app) => {
      try {
        const metrics = await getSparkAppMetrics(app.appId, days);
        return { app, recs: recommendTuning(metrics), failedTasks: metrics.failedTasks };
      } catch {
        return { app, recs: [] as TuningRec[], failedTasks: undefined as number | undefined };
      }
    }),
  );

  // Failures: explicit failed status, positive failed-task count, or a critical rec.
  const failures: FailureInsight[] = [];
  const optById = new Map<string, OptimizationInsight>();

  for (const { app, recs, failedTasks } of perApp) {
    const statusFailed = (app.status || '').toLowerCase().includes('fail')
      || (app.status || '').toLowerCase().includes('error');
    const critical = recs.find((r) => r.severity === 'critical');
    let signal = '';
    if (statusFailed) signal = 'Application reported Failed';
    else if (typeof failedTasks === 'number' && failedTasks > 0) signal = `${failedTasks} failed task(s)`;
    else if (critical) signal = `Critical: ${critical.title}`;
    if (signal) {
      failures.push({
        appId: app.appId, name: app.name, engine: app.engine, pool: app.pool,
        user: app.user, start: app.start, durationMs: app.durationMs, errorSignal: signal,
      });
    }

    // Aggregate non-"healthy" recs across the sample.
    for (const rec of recs) {
      if (rec.id === 'healthy') continue;
      const prev = optById.get(rec.id);
      if (!prev) {
        optById.set(rec.id, {
          id: rec.id, severity: rec.severity, title: rec.title, detail: rec.detail,
          conf: rec.conf, presetId: rec.presetId, affectedApps: 1, sampleAppIds: [app.appId],
        });
      } else {
        prev.affectedApps += 1;
        if (prev.sampleAppIds.length < 5) prev.sampleAppIds.push(app.appId);
        // Keep the highest severity seen for this pattern.
        if (SEVERITY_RANK[rec.severity] > SEVERITY_RANK[prev.severity]) prev.severity = rec.severity;
      }
    }
  }

  const optimization = Array.from(optById.values()).sort(
    (a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] || b.affectedApps - a.affectedApps,
  );

  return {
    scannedAt: new Date().toISOString(),
    windowDays: days,
    sampled: scanned.length,
    totalApps: apps.length,
    failures,
    optimization,
    elapsedMs: Date.now() - started,
  };
}

// ----------------------------------------------------------------------------
// Native Spark diagnostic-tool deep links (no reinvention — open the real UI)
// ----------------------------------------------------------------------------

export interface NativeDiagLink {
  label: string;
  href: string;
  detail: string;
}

/**
 * Deep links to the native Spark diagnostic tools for this deployment, so a user
 * can jump from Loom analytics into the full Spark UI / History Server when they
 * need executor-level detail. Env-gated — only links that resolve are returned.
 */
export function sparkNativeDiagLinks(env: NodeJS.ProcessEnv = process.env): NativeDiagLink[] {
  const links: NativeDiagLink[] = [];
  const ws = (env.LOOM_SYNAPSE_WORKSPACE || '').trim();
  if (ws) {
    links.push({
      label: 'Synapse — Apache Spark applications',
      href: `https://web.azuresynapse.net/en/monitoring/sparkapplication?workspace=${encodeURIComponent(ws)}`,
      detail: 'Synapse Studio → Monitor → Apache Spark applications. Per-app Spark UI, driver/executor logs, and the Spark History Server.',
    });
  }
  const dbx = (env.LOOM_DATABRICKS_WORKSPACE_URL || env.LOOM_DATABRICKS_HOST || '').trim();
  if (dbx) {
    const base = dbx.startsWith('http') ? dbx.replace(/\/$/, '') : `https://${dbx.replace(/\/$/, '')}`;
    links.push({
      label: 'Databricks — Compute & Spark UI',
      href: `${base}/#setting/clusters`,
      detail: 'Databricks workspace → Compute → a cluster → Spark UI / Driver logs / Metrics (Ganglia).',
    });
  }
  return links;
}

/**
 * Whether the IN-SESSION Spark→LA emitter is opted in + configured. NOTE: the
 * Monitor→Spark application list no longer depends on it — the pool
 * diagnostic-settings table (SynapseBigDataPoolApplicationsEnded) supplies
 * application rows with no in-session emitter (which DIES on
 * preventDataExfiltration workspaces — see synapseLogAnalyticsConf).
 */
export function sparkTelemetryConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.LOOM_SPARK_LA_EMITTER || '').trim() === '1' && !!(env.LOOM_SPARK_LA_WORKSPACE_ID || '').trim();
}
