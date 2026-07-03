/**
 * GET /api/admin/copilot-usage?days=30
 *
 * Queries the Loom Log Analytics workspace for `copilot.usage` custom events
 * emitted by the Console Copilot orchestrator AND the copilot-chat Function
 * (AppEvents table — workspace-based App Insights maps customEvents→AppEvents,
 * customDimensions→Properties). Returns real token aggregations broken out
 * per persona, per model+day, and per (hashed) user.
 *
 * Real KQL only — no synthetic numbers. Honest-gate via MonitorNotConfiguredError
 * when LOOM_LOG_ANALYTICS_WORKSPACE_ID is unset.
 *
 * Shape:
 *   { ok:true, data: CopilotUsageSummary }      — events found
 *   { ok:true, data:null, noEvents:true }       — workspace OK, no copilot.usage yet
 *   { ok:false, gate:{ missing, message } }     — App Insights / LAW unconfigured
 *   { ok:false, error }                          — query failure
 */
import { NextResponse, type NextRequest } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { requireTenantAdmin } from '@/lib/auth/feature-gate';
import { queryLogs, MonitorNotConfiguredError, type LogQueryResult } from '@/lib/azure/monitor-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const col = (r: LogQueryResult, name: string) => r.columns.indexOf(name);
const numAt = (row: unknown[], i: number) => (i < 0 ? 0 : Number(row[i] ?? 0) || 0);
const strAt = (row: unknown[], i: number) => (i < 0 ? '' : String(row[i] ?? ''));

export async function GET(req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const denied = requireTenantAdmin(s);
  if (denied) return denied;

  const days = Math.max(1, Math.min(90, Number(req.nextUrl.searchParams.get('days') || '30') || 30));
  const timespan = `P${days}D`;

  // NOTE: in workspace-based App Insights the AppEvents table is not
  // materialized in the LAW until the first customEvent of any kind is
  // ingested. On a fresh deployment a bare `AppEvents | ...` reference returns
  // a SemanticError (HTTP 400) — which surfaced as the red "could not load"
  // bar instead of the friendly no-events state. `union isfuzzy=true
  // (AppEvents | ...)` makes a missing table contribute 0 rows instead of
  // erroring (same pattern as queryActivityFeed's Synapse union), so the
  // noEvents branch below fires correctly until real copilot.usage events flow.

  // Per-persona rollup (the headline breakdown).
  const kqlByPersona = `
union isfuzzy=true (AppEvents | where Name == "copilot.usage")
| extend pt = toint(Properties.prompt_tokens), ct = toint(Properties.completion_tokens)
| extend persona = tostring(Properties.persona)
| summarize prompt_tokens = sum(pt), completion_tokens = sum(ct), total_tokens = sum(pt) + sum(ct), calls = count() by persona
| order by total_tokens desc
`.trim();

  // Per-model + day for the trend sparkline.
  const kqlByDay = `
union isfuzzy=true (AppEvents | where Name == "copilot.usage")
| extend pt = toint(Properties.prompt_tokens), ct = toint(Properties.completion_tokens)
| extend persona = tostring(Properties.persona), model = tostring(Properties.model)
| summarize prompt_tokens = sum(pt), completion_tokens = sum(ct), total_tokens = sum(pt) + sum(ct), calls = count() by day = format_datetime(bin(TimeGenerated, 1d), 'yyyy-MM-dd'), model, persona
| order by day asc
`.trim();

  // Top users (hashed — no PII) by call volume.
  const kqlByUser = `
union isfuzzy=true (AppEvents | where Name == "copilot.usage")
| extend pt = toint(Properties.prompt_tokens), ct = toint(Properties.completion_tokens)
| extend user_hash = tostring(Properties.user_oid_hash)
| summarize prompt_tokens = sum(pt), completion_tokens = sum(ct), total_tokens = sum(pt) + sum(ct), calls = count() by user_hash
| top 20 by calls desc
`.trim();

  try {
    const [byPersonaR, byDayR, byUserR] = await Promise.all([
      queryLogs(kqlByPersona, timespan),
      queryLogs(kqlByDay, timespan),
      queryLogs(kqlByUser, timespan),
    ]);

    if (byPersonaR.rowCount === 0 && byDayR.rowCount === 0 && byUserR.rowCount === 0) {
      return NextResponse.json({ ok: true, data: null, noEvents: true });
    }

    const byPersona = byPersonaR.rows.map((row) => ({
      persona: strAt(row, col(byPersonaR, 'persona')) || 'unknown',
      promptTokens: numAt(row, col(byPersonaR, 'prompt_tokens')),
      completionTokens: numAt(row, col(byPersonaR, 'completion_tokens')),
      totalTokens: numAt(row, col(byPersonaR, 'total_tokens')),
      calls: numAt(row, col(byPersonaR, 'calls')),
    }));

    const byDay = byDayR.rows.map((row) => ({
      day: strAt(row, col(byDayR, 'day')).slice(0, 10),
      model: strAt(row, col(byDayR, 'model')),
      persona: strAt(row, col(byDayR, 'persona')) || 'unknown',
      promptTokens: numAt(row, col(byDayR, 'prompt_tokens')),
      completionTokens: numAt(row, col(byDayR, 'completion_tokens')),
      totalTokens: numAt(row, col(byDayR, 'total_tokens')),
      calls: numAt(row, col(byDayR, 'calls')),
    }));

    const byUser = byUserR.rows.map((row) => ({
      userHash: strAt(row, col(byUserR, 'user_hash')),
      promptTokens: numAt(row, col(byUserR, 'prompt_tokens')),
      completionTokens: numAt(row, col(byUserR, 'completion_tokens')),
      totalTokens: numAt(row, col(byUserR, 'total_tokens')),
      calls: numAt(row, col(byUserR, 'calls')),
    }));

    const totals = byPersona.reduce(
      (acc, p) => ({
        promptTokens: acc.promptTokens + p.promptTokens,
        completionTokens: acc.completionTokens + p.completionTokens,
        totalTokens: acc.totalTokens + p.totalTokens,
        calls: acc.calls + p.calls,
      }),
      { promptTokens: 0, completionTokens: 0, totalTokens: 0, calls: 0 },
    );

    const models = Array.from(new Set(byDay.map((d) => d.model).filter(Boolean)));

    return NextResponse.json({
      ok: true,
      data: { byPersona, byDay, byUser, totals, models, days },
    });
  } catch (e) {
    if (e instanceof MonitorNotConfiguredError) {
      return NextResponse.json({
        ok: false,
        gate: {
          missing: e.missing,
          message:
            'Copilot usage metering reads token counts from Azure Monitor Log Analytics. ' +
            `Set ${e.missing.join(', ')} on the Console container app (it is wired from the ` +
            'monitoring.bicep workspace output). App Insights must also be configured via ' +
            'APPLICATIONINSIGHTS_CONNECTION_STRING (already injected by app-deployments.bicep) ' +
            'so the orchestrator can emit copilot.usage events. Counts appear after the next real Copilot call.',
        },
      });
    }
    // Belt-and-suspenders: a workspace that has never ingested a customEvent
    // has no AppEvents table yet, so even the isfuzzy union can surface a
    // resolve error on some LAW engine versions. Treat a missing-table /
    // semantic resolve failure as the friendly no-events state rather than a
    // hard error. Genuine permission (403) / throttling errors still bubble up.
    const msg = (e as Error)?.message || '';
    const isMissingTable =
      /Failed to resolve|could not be found|SemanticError|does not refer to any known|Unknown (?:function|table)/i.test(msg);
    if (isMissingTable) {
      return NextResponse.json({ ok: true, data: null, noEvents: true });
    }
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
