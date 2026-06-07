/**
 * GET /api/items/eventhouse/[id]/overview?timespan=PT1H|P1D|P7D|P30D
 *
 * Aggregates the Eventhouse system-overview dashboard from the live shared
 * Loom ADX cluster (Fabric RTI Eventhouse Azure-native default — see
 * .claude/rules/no-fabric-dependency.md). Sources:
 *   - `.show diagnostics`        → cluster health + total storage + ingestion load
 *   - `.show capacity ingestions`→ concurrent-ingestion capacity (total/consumed)
 *   - `.show database <db> details` (per db) → per-db original/compressed/hot size
 *   - `.show queries | summarize`→ top-10 queried databases + top-5 users
 *   - Azure Monitor metrics      → ingestion latency/volume, query duration, throttling
 *
 * Every value is read from a real backend; partial failures are tolerated via
 * Promise.allSettled so one unavailable command never blanks the panel. When
 * the ADX cluster ARM coordinates (sub/rg/name) aren't configured the Monitor
 * section degrades to an honest gate (`monitorGate`) while the KQL-sourced
 * sections still render. No mocks, no placeholder arrays.
 *
 * Grounded in Microsoft Learn:
 *   https://learn.microsoft.com/azure/data-explorer/check-cluster-health (.show diagnostics)
 *   https://learn.microsoft.com/kusto/management/show-capacity-command
 *   https://learn.microsoft.com/kusto/management/show-database (details columns)
 *   https://learn.microsoft.com/azure/azure-monitor/reference/supported-metrics/microsoft-kusto-clusters-metrics
 */

import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  clusterUri,
  listDatabases,
  getDatabaseDetails,
  executeMgmtCommand,
  KustoError,
} from '@/lib/azure/kusto-client';
import {
  fetchMetrics,
  type MetricResult,
} from '@/lib/azure/monitor-client';
import {
  readKustoArmConfig,
  KustoNotConfiguredError,
} from '@/lib/azure/kusto-arm-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Timespan = 'PT1H' | 'P1D' | 'P7D' | 'P30D';

const VALID_TIMESPANS: Timespan[] = ['PT1H', 'P1D', 'P7D', 'P30D'];

/** ISO-8601 duration → KQL `ago()` literal for the `.show queries` window. */
function kustoAgo(ts: Timespan): string {
  switch (ts) {
    case 'PT1H': return '1h';
    case 'P1D': return '1d';
    case 'P7D': return '7d';
    case 'P30D': return '30d';
  }
}

/** ISO-8601 duration → Monitor grain (coarser windows use a coarser interval). */
function monitorInterval(ts: Timespan): string {
  return ts === 'PT1H' ? 'PT5M' : ts === 'P1D' ? 'PT1H' : 'PT6H';
}

/** Pull a column value by name from a single-row mgmt result, coercing to number. */
function numFromRow(
  cols: string[],
  row: unknown[] | undefined,
  ...names: string[]
): number | null {
  if (!row) return null;
  for (const n of names) {
    const i = cols.indexOf(n);
    if (i >= 0) {
      const v = Number(row[i]);
      if (Number.isFinite(v)) return v;
    }
  }
  return null;
}

function boolFromRow(cols: string[], row: unknown[] | undefined, name: string): boolean {
  if (!row) return false;
  const i = cols.indexOf(name);
  if (i < 0) return false;
  const v = row[i];
  return v === true || v === 1 || String(v).toLowerCase() === 'true';
}

/** Last non-null point value for a named metric from a fetchMetrics result set. */
function lastMetric(results: MetricResult[], name: string): number | null {
  const m = results.find((r) => r.name.toLowerCase() === name.toLowerCase());
  if (!m) return null;
  for (let i = m.points.length - 1; i >= 0; i--) {
    const v = m.points[i].value;
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  return null;
}

/** Read a numeric property from a `.show database details` record by candidate names. */
function detailNum(rec: Record<string, unknown> | null, ...names: string[]): number | null {
  if (!rec) return null;
  for (const n of names) {
    if (n in rec) {
      const v = Number(rec[n]);
      if (Number.isFinite(v)) return v;
    }
  }
  return null;
}

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  await ctx.params; // [id] is the Loom item id; the overview is cluster-wide.

  const url = new URL(_req.url);
  const tsParam = (url.searchParams.get('timespan') || 'P1D') as Timespan;
  const timespan: Timespan = VALID_TIMESPANS.includes(tsParam) ? tsParam : 'P1D';
  const ago = kustoAgo(timespan);

  try {
    // 1) List databases first (needed to fan out per-db details).
    const databases = await listDatabases();

    // 2) Fan out every read in parallel; tolerate partial failures.
    const [
      diagRes,
      capRes,
      topDbRes,
      topUserRes,
      detailResults,
    ] = await Promise.allSettled([
      executeMgmtCommand('NetDefaultDB', '.show diagnostics'),
      executeMgmtCommand('NetDefaultDB', '.show capacity ingestions'),
      executeMgmtCommand(
        'NetDefaultDB',
        `.show queries | where StartedOn > ago(${ago}) | summarize QueryCount=count() by Database | order by QueryCount desc | take 10`,
      ),
      executeMgmtCommand(
        'NetDefaultDB',
        `.show queries | where StartedOn > ago(${ago}) | summarize QueryCount=count() by User | order by QueryCount desc | take 5`,
      ),
      Promise.allSettled(databases.map((d) => getDatabaseDetails(d.name))),
    ]);

    // ----- diagnostics -----
    let diagnostics: Record<string, unknown> | null = null;
    if (diagRes.status === 'fulfilled') {
      const r = diagRes.value;
      const row = r.rows[0];
      diagnostics = {
        isHealthy: boolFromRow(r.columns, row, 'IsHealthy'),
        isScaleOutRequired: boolFromRow(r.columns, row, 'IsScaleOutRequired'),
        machinesTotal: numFromRow(r.columns, row, 'MachinesTotal') ?? 0,
        machinesOffline: numFromRow(r.columns, row, 'MachinesOffline') ?? 0,
        extentsTotal: numFromRow(r.columns, row, 'ExtentsTotal') ?? 0,
        totalOriginalDataSizeBytes: numFromRow(r.columns, row, 'TotalOriginalDataSize') ?? 0,
        totalExtentSizeBytes: numFromRow(r.columns, row, 'TotalExtentSize') ?? 0,
        ingestionsLoadFactor: numFromRow(r.columns, row, 'IngestionsLoadFactor') ?? 0,
        ingestionsInProgress: numFromRow(r.columns, row, 'IngestionsInProgress') ?? 0,
        ingestionsSuccessRate: numFromRow(r.columns, row, 'IngestionsSuccessRate') ?? 0,
      };
    }

    // ----- capacity (ingestions resource row) -----
    let capacity: { ingestions: { total: number; consumed: number; remaining: number } } | null = null;
    if (capRes.status === 'fulfilled') {
      const r = capRes.value;
      // Prefer the row whose Resource === 'ingestions'; else first row.
      const resIdx = r.columns.indexOf('Resource');
      const row =
        (resIdx >= 0 && r.rows.find((rw) => String(rw[resIdx]).toLowerCase() === 'ingestions')) ||
        r.rows[0];
      capacity = {
        ingestions: {
          total: numFromRow(r.columns, row, 'Total') ?? 0,
          consumed: numFromRow(r.columns, row, 'Consumed') ?? 0,
          remaining: numFromRow(r.columns, row, 'Remaining') ?? 0,
        },
      };
    }

    // ----- per-db storage -----
    const dbDetails =
      detailResults.status === 'fulfilled' ? detailResults.value : [];
    const dbStorage = databases.map((d, i) => {
      const settled = dbDetails[i];
      const rec = settled && settled.status === 'fulfilled' ? settled.value : null;
      return {
        name: d.name,
        totalOriginalSizeBytes: detailNum(rec, 'OriginalSize', 'TotalOriginalSize'),
        totalExtentSizeBytes: detailNum(rec, 'ExtentSize', 'TotalExtentSize', 'CompressedSize'),
        hotDataSizeBytes: detailNum(rec, 'HotExtentSize', 'HotOriginalSize'),
        rowCount: detailNum(rec, 'RowCount'),
      };
    });

    // ----- top queried dbs -----
    const topQueriedDbs: Array<{ database: string; queryCount: number }> = [];
    if (topDbRes.status === 'fulfilled') {
      const r = topDbRes.value;
      const dbIdx = r.columns.indexOf('Database');
      const cntIdx = r.columns.indexOf('QueryCount');
      for (const row of r.rows) {
        topQueriedDbs.push({
          database: String(row[dbIdx >= 0 ? dbIdx : 0] ?? ''),
          queryCount: Number(row[cntIdx >= 0 ? cntIdx : 1] ?? 0),
        });
      }
    }

    // ----- top users -----
    const topUsers: Array<{ user: string; queryCount: number }> = [];
    if (topUserRes.status === 'fulfilled') {
      const r = topUserRes.value;
      const userIdx = r.columns.indexOf('User');
      const cntIdx = r.columns.indexOf('QueryCount');
      for (const row of r.rows) {
        topUsers.push({
          user: String(row[userIdx >= 0 ? userIdx : 0] ?? ''),
          queryCount: Number(row[cntIdx >= 0 ? cntIdx : 1] ?? 0),
        });
      }
    }

    // ----- Azure Monitor metrics (honest gate when ARM coords / RBAC absent) -----
    let monitor: Record<string, number | null> | null = null;
    let monitorGate: string | undefined;
    try {
      const cfg = readKustoArmConfig();
      const resourceId =
        `/subscriptions/${cfg.subscriptionId}/resourceGroups/${cfg.resourceGroup}` +
        `/providers/Microsoft.Kusto/clusters/${cfg.clusterName}`;
      const interval = monitorInterval(timespan);
      const [avg, total] = await Promise.all([
        fetchMetrics({
          resourceId,
          metricNames: ['IngestionLatencyInSeconds', 'QueryDuration', 'CPU', 'IngestionUtilization'],
          timespan,
          interval,
          aggregation: 'Average',
        }),
        fetchMetrics({
          resourceId,
          metricNames: ['IngestionVolumeInMB', 'TotalNumberOfThrottledCommands', 'TotalNumberOfThrottledQueries'],
          timespan,
          interval,
          aggregation: 'Total',
        }),
      ]);
      monitor = {
        ingestionLatencyAvgSec: lastMetric(avg, 'IngestionLatencyInSeconds'),
        queryDurationAvgMs: lastMetric(avg, 'QueryDuration'),
        cpuAvgPct: lastMetric(avg, 'CPU'),
        ingestionUtilPct: lastMetric(avg, 'IngestionUtilization'),
        ingestionVolumeTotalMb: lastMetric(total, 'IngestionVolumeInMB'),
        throttledCommandsTotal: lastMetric(total, 'TotalNumberOfThrottledCommands'),
        throttledQueriesTotal: lastMetric(total, 'TotalNumberOfThrottledQueries'),
      };
    } catch (e: any) {
      if (e instanceof KustoNotConfiguredError) {
        monitorGate =
          `Azure Monitor metrics unavailable — set ${e.missing.join(', ')} so the cluster resource id can be built. ` +
          `The Console UAMI also needs "Monitoring Reader" on the cluster.`;
      } else {
        monitorGate =
          `Azure Monitor metrics unavailable: ${e?.message || String(e)}. ` +
          `Ensure the Console UAMI holds "Monitoring Reader" on the ADX cluster ` +
          `(in Gov clouds also confirm AZURE_CLOUD=AzureUSGovernment).`;
      }
    }

    return NextResponse.json({
      ok: true,
      cluster: clusterUri(),
      timespan,
      diagnostics,
      capacity,
      databases: dbStorage,
      topQueriedDbs,
      topUsers,
      monitor,
      ...(monitorGate ? { monitorGate } : {}),
    });
  } catch (e: any) {
    const status = e instanceof KustoError ? e.status : 502;
    return NextResponse.json(
      { ok: false, error: e?.message || String(e), body: e?.body },
      { status },
    );
  }
}
