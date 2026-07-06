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
import { queryLogs, MonitorError, MonitorNotConfiguredError, type LogQueryResult } from '@/lib/azure/monitor-client';
import { apiServerError, apiHonestError } from '@/lib/api/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const col = (r: LogQueryResult, name: string) => r.columns.indexOf(name);
const numAt = (row: unknown[], i: number) => (i < 0 ? 0 : Number(row[i] ?? 0) || 0);
const strAt = (row: unknown[], i: number) => (i < 0 ? '' : String(row[i] ?? ''));

/**
 * Azure OpenAI published list price per 1K tokens (USD), keyed by a model
 * substring. Used to derive an ESTIMATED cost from the REAL token counts (the
 * numbers themselves are live AOAI usage; only the $ rate is list-price). Keyed
 * loosely so `gpt-4o-mini-2024-07-18` matches `gpt-4o-mini`. Embeddings models
 * bill input-only. A conservative default covers unrecognized deployments.
 */
const PRICE_PER_1K: Record<string, { in: number; out: number }> = {
  'gpt-4o-mini': { in: 0.00015, out: 0.0006 },
  'gpt-4.1-mini': { in: 0.0004, out: 0.0016 },
  'gpt-4.1-nano': { in: 0.0001, out: 0.0004 },
  'gpt-4.1': { in: 0.002, out: 0.008 },
  'gpt-4o': { in: 0.005, out: 0.015 },
  'o4-mini': { in: 0.0011, out: 0.0044 },
  'o3-mini': { in: 0.0011, out: 0.0044 },
  'text-embedding-3-large': { in: 0.00013, out: 0 },
  'text-embedding-3-small': { in: 0.00002, out: 0 },
  'text-embedding-ada-002': { in: 0.0001, out: 0 },
};
const DEFAULT_PRICE = { in: 0.002, out: 0.008 };
function priceFor(model: string): { in: number; out: number } {
  const m = (model || '').toLowerCase();
  const key = Object.keys(PRICE_PER_1K).find((k) => m.includes(k));
  return key ? PRICE_PER_1K[key] : DEFAULT_PRICE;
}
function estCostUsd(model: string, promptTokens: number, completionTokens: number): number {
  const p = priceFor(model);
  return Number(((promptTokens / 1000) * p.in + (completionTokens / 1000) * p.out).toFixed(4));
}

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

    const byDay = byDayR.rows.map((row) => {
      const promptTokens = numAt(row, col(byDayR, 'prompt_tokens'));
      const completionTokens = numAt(row, col(byDayR, 'completion_tokens'));
      const model = strAt(row, col(byDayR, 'model'));
      return {
        day: strAt(row, col(byDayR, 'day')).slice(0, 10),
        model,
        persona: strAt(row, col(byDayR, 'persona')) || 'unknown',
        promptTokens,
        completionTokens,
        totalTokens: numAt(row, col(byDayR, 'total_tokens')),
        calls: numAt(row, col(byDayR, 'calls')),
        // Estimated $ from real tokens × the model's published list price.
        estCostUsd: estCostUsd(model, promptTokens, completionTokens),
      };
    });

    // Per-persona cost, summed from the model-aware daily rows (the persona
    // rollup itself has no model column, so its $ is derived here).
    const personaCost = new Map<string, number>();
    for (const d of byDay) personaCost.set(d.persona, (personaCost.get(d.persona) || 0) + d.estCostUsd);

    const byPersona = byPersonaR.rows.map((row) => {
      const persona = strAt(row, col(byPersonaR, 'persona')) || 'unknown';
      return {
        persona,
        promptTokens: numAt(row, col(byPersonaR, 'prompt_tokens')),
        completionTokens: numAt(row, col(byPersonaR, 'completion_tokens')),
        totalTokens: numAt(row, col(byPersonaR, 'total_tokens')),
        calls: numAt(row, col(byPersonaR, 'calls')),
        estCostUsd: Number((personaCost.get(persona) || 0).toFixed(4)),
      };
    });

    const byUser = byUserR.rows.map((row) => {
      const promptTokens = numAt(row, col(byUserR, 'prompt_tokens'));
      const completionTokens = numAt(row, col(byUserR, 'completion_tokens'));
      return {
        userHash: strAt(row, col(byUserR, 'user_hash')),
        promptTokens,
        completionTokens,
        totalTokens: numAt(row, col(byUserR, 'total_tokens')),
        calls: numAt(row, col(byUserR, 'calls')),
        // Per-user rows carry no model → default-priced estimate.
        estCostUsd: estCostUsd('', promptTokens, completionTokens),
      };
    });

    const totals = byPersona.reduce(
      (acc, p) => ({
        promptTokens: acc.promptTokens + p.promptTokens,
        completionTokens: acc.completionTokens + p.completionTokens,
        totalTokens: acc.totalTokens + p.totalTokens,
        calls: acc.calls + p.calls,
        estCostUsd: acc.estCostUsd + p.estCostUsd,
      }),
      { promptTokens: 0, completionTokens: 0, totalTokens: 0, calls: 0, estCostUsd: 0 },
    );
    totals.estCostUsd = Number(totals.estCostUsd.toFixed(4));

    const models = Array.from(new Set(byDay.map((d) => d.model).filter(Boolean)));

    return NextResponse.json({
      ok: true,
      // pricing:'list' flags that estCostUsd is a list-price estimate over real
      // token counts (not a billed figure) — the UI labels it "estimated".
      data: { byPersona, byDay, byUser, totals, models, days, pricing: 'list' },
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
    // A real Azure Monitor API error (permission / throttle / bad query) is an
    // honest, user-actionable signal ("caller lacks Log Analytics Reader") —
    // surface its message, don't genericize it. Unknown exceptions still get the
    // safe generic 500 via apiServerError.
    if (e instanceof MonitorError) {
      return apiHonestError(e, 500);
    }
    return apiServerError(e);
  }
}
