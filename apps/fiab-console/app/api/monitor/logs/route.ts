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
import { KQL_LIBRARY, KQL_CATEGORIES, kqlById } from '@/lib/azure/kql-library';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// The prebuilt query catalog lives in lib/azure/kql-library.ts — a categorized
// set of troubleshooting / performance / audit / cost / per-service queries,
// each a real KQL against the standard Log Analytics tables Loom's diagnostic
// settings populate. Tables not ingested in a given workspace simply return
// zero rows (the pane shows an empty grid). Shape kept backward-compatible:
// the GET still returns `presets` (id/label/query/description) plus new
// `categories` + per-item `category`/`chart` for the grouped picker.
const PRESETS = KQL_LIBRARY;

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
  // presets: backward-compatible flat list; categories: ordered groups the
  // pane uses to render the categorized library picker.
  return NextResponse.json({
    ok: true,
    data: { presets: PRESETS, categories: KQL_CATEGORIES },
  });
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
    const preset = kqlById(presetId);
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
