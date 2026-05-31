/**
 * Monitor → Logs (KQL) tab. Runs Kusto queries against the Loom Log Analytics
 * workspace via the real Log Analytics query API (monitor-client.queryLogs).
 *
 *   GET  /api/monitor/logs               → { ok, data: { presets: Preset[] } }
 *   POST /api/monitor/logs
 *     body { query?: string, preset?: string, timespan?: string }
 *                                          → { ok, data: { columns, rows, rowCount, kql } }
 *
 * Honest gate: when LOOM_LOG_ANALYTICS_WORKSPACE_ID is unset, queryLogs throws
 * MonitorNotConfiguredError and we return { ok:false, gate:{ missing, message } }
 * so the pane shows a precise MessageBar instead of erroring. No mocks — real
 * Log Analytics REST only (see .claude/rules/no-vaporware.md).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { queryLogs, MonitorNotConfiguredError, MonitorError } from '@/lib/azure/monitor-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface Preset {
  id: string;
  label: string;
  query: string;
  description: string;
}

// Starter KQL presets surfaced in the Logs tab's preset dropdown. Each is a
// real query against standard Log Analytics tables; tables that aren't ingested
// in a given workspace simply return zero rows (the pane shows an empty grid).
const PRESETS: Preset[] = [
  {
    id: 'signIns',
    label: 'Entra sign-ins (24h)',
    query: 'SigninLogs | where TimeGenerated > ago(24h) | project TimeGenerated, UserPrincipalName, AppDisplayName, ResultType, IPAddress | sort by TimeGenerated desc | take 100',
    description: 'Recent Entra ID sign-in events (requires SigninLogs ingestion).',
  },
  {
    id: 'heartbeat',
    label: 'Host heartbeat',
    query: 'Heartbeat | summarize LastSeen = max(TimeGenerated) by Computer | sort by LastSeen desc',
    description: 'Most recent heartbeat per monitored host/agent.',
  },
  {
    id: 'consoleLogs',
    label: 'Container Apps console (1h)',
    query: 'ContainerAppConsoleLogs_CL | where TimeGenerated > ago(1h) | project TimeGenerated, ContainerAppName_s, Log_s | sort by TimeGenerated desc | take 200',
    description: 'Console output from the Loom Container Apps (console, mcp, activator, …).',
  },
  {
    id: 'appErrors',
    label: 'App exceptions (24h)',
    query: 'AppExceptions | where TimeGenerated > ago(24h) | project TimeGenerated, ProblemId, OuterMessage, CloudRoleName | sort by TimeGenerated desc | take 100',
    description: 'Application exceptions from the App Insights-linked workspace.',
  },
  {
    id: 'ingestion',
    label: 'Ingestion by table (24h)',
    query: 'Usage | where TimeGenerated > ago(24h) | summarize GB = round(sum(Quantity) / 1024, 3) by DataType | sort by GB desc',
    description: 'Data-ingestion volume per table over the last day.',
  },
];

function gateOrError(e: unknown) {
  if (e instanceof MonitorNotConfiguredError) {
    return NextResponse.json({ ok: false, gate: { missing: e.missing, message: e.message } });
  }
  const status = e instanceof MonitorError ? e.status : 500;
  return NextResponse.json({ ok: false, error: (e as Error).message }, { status });
}

export async function GET() {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  return NextResponse.json({ ok: true, data: { presets: PRESETS } });
}

export async function POST(req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  let body: any;
  try { body = await req.json(); } catch { body = {}; }

  const presetId = typeof body?.preset === 'string' ? body.preset.trim() : '';
  const rawQuery = typeof body?.query === 'string' ? body.query.trim() : '';
  const timespan = typeof body?.timespan === 'string' && body.timespan.trim() ? body.timespan.trim() : 'P1D';

  if (presetId) {
    const preset = PRESETS.find((p) => p.id === presetId);
    if (!preset) return NextResponse.json({ ok: false, error: `unknown preset: ${presetId}` }, { status: 400 });
    try {
      const result = await queryLogs(preset.query, timespan);
      return NextResponse.json({ ok: true, data: { ...result, kql: preset.query, preset: preset.id } });
    } catch (e) { return gateOrError(e); }
  }

  if (!rawQuery) {
    return NextResponse.json({ ok: false, error: 'query or preset required' }, { status: 400 });
  }

  try {
    const result = await queryLogs(rawQuery, timespan);
    return NextResponse.json({ ok: true, data: { ...result, kql: rawQuery } });
  } catch (e) { return gateOrError(e); }
}
