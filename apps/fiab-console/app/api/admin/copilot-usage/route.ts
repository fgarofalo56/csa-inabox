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
import { queryLogs, MonitorError, MonitorNotConfiguredError, type LogQueryResult } from '@/lib/azure/monitor-client';
import { apiServerError, apiHonestError } from '@/lib/api/respond';
import { buildScopedCacheKey, getOrComputeCached, resolveBackendTtl } from '@/lib/azure/query-result-cache';
// rel-T85 list-price table + estimator — shared with the per-turn transparency
// status bar (CTS-01) so the $ rate is derived in exactly one place.
import { estCostUsd } from '@/lib/copilot/cost-estimate';
import { withTenantAdmin } from '@/lib/api/route-toolkit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const col = (r: LogQueryResult, name: string) => r.columns.indexOf(name);
const numAt = (row: unknown[], i: number) => (i < 0 ? 0 : Number(row[i] ?? 0) || 0);
const strAt = (row: unknown[], i: number) => (i < 0 ? '' : String(row[i] ?? ''));

export const GET = withTenantAdmin(async (req: NextRequest) => {

  const days = Math.max(1, Math.min(90, Number(req.nextUrl.searchParams.get('days') || '30') || 30));
  const timespan = `P${days}D`;
  const refresh = req.nextUrl.searchParams.get('refresh') === '1';
  const cacheKey = buildScopedCacheKey('admin/copilot-usage', { days });

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

  // Top users (hashed — no PII) by call volume, broken out PER MODEL.
  //
  // #3743 — THE `by user_hash` GROUPING WAS THE BUG. It dropped `model`, so the
  // row build had nothing to price with and passed `estCostUsd('', …)`. That
  // never matches a key in PRICE_PER_1K, so every per-user figure fell through
  // to DEFAULT_PRICE — a catch-all meant for UNRECOGNIZED deployments, not for
  // "we chose not to look up the real one". Measured on the live tenant: the
  // SAME 1,640 + 245 tokens read $0.0004 under Token totals / By persona / By
  // model and $0.0052 under Top users — ~13x, because gpt-4o-mini is
  // {0.00015, 0.0006} and DEFAULT_PRICE is {0.002, 0.008}. It errs the other way
  // on gpt-4o, whose real blended rate is HIGHER than the default. Either way
  // the one breakdown an admin uses to find who is driving spend was the one
  // number on the page that was not derived from the real price.
  //
  // `let` + a `top 20` on the user rollup preserves the previous semantics —
  // still the twenty busiest users, not the twenty busiest (user, model) pairs —
  // while giving the row build the model it needs. The union stays `isfuzzy`
  // (a not-yet-materialized AppEvents table must still contribute 0 rows).
  const kqlByUser = `
let usage = union isfuzzy=true (AppEvents | where Name == "copilot.usage")
| extend pt = toint(Properties.prompt_tokens), ct = toint(Properties.completion_tokens)
| extend user_hash = tostring(Properties.user_oid_hash), model = tostring(Properties.model);
let top_users = usage | summarize calls = count() by user_hash | top 20 by calls desc | project user_hash;
usage
| where user_hash in (top_users)
| summarize prompt_tokens = sum(pt), completion_tokens = sum(ct), total_tokens = sum(pt) + sum(ct), calls = count() by user_hash, model
`.trim();

  try {
    // KQL against Log Analytics is slow + rate-limited; served stale-while-revalidate
    // on a 10-min window (LOOM_QUERY_CACHE_TTL_MS_COPILOTUSAGE). `?refresh=1` bypasses.
    // Only the successful data / noEvents states are cached — gates + errors propagate
    // out of the compute (thrown) and are handled by the catch below, never cached.
    const { value, meta } = await getOrComputeCached(
      cacheKey,
      'admin/copilot-usage',
      async (): Promise<{ data: null; noEvents: true } | { data: Record<string, unknown> }> => {
    const [byPersonaR, byDayR, byUserR] = await Promise.all([
      queryLogs(kqlByPersona, timespan),
      queryLogs(kqlByDay, timespan),
      queryLogs(kqlByUser, timespan),
    ]);

    if (byPersonaR.rowCount === 0 && byDayR.rowCount === 0 && byUserR.rowCount === 0) {
      return { data: null, noEvents: true };
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

    // Per-user rows arrive PER (user, model) now (#3743), so each user's cost is
    // the SUM of MODEL-AWARE per-model estimates — the same derivation `byDay`
    // uses and `byPersona` sums from. One price table, one code path, so Top
    // users cannot disagree with By model about the same tokens again.
    //
    // A row whose `model` is empty (the event genuinely carried no `model`
    // property) still falls through to DEFAULT_PRICE — but so does the identical
    // row in `byDay`, so the two breakdowns stay CONSISTENT, which is the
    // property #3743 asks for. What is gone is the case where the model was
    // known and thrown away.
    const userAgg = new Map<
      string,
      { promptTokens: number; completionTokens: number; totalTokens: number; calls: number; estCostUsd: number }
    >();
    for (const row of byUserR.rows) {
      const userHash = strAt(row, col(byUserR, 'user_hash'));
      const model = strAt(row, col(byUserR, 'model'));
      const promptTokens = numAt(row, col(byUserR, 'prompt_tokens'));
      const completionTokens = numAt(row, col(byUserR, 'completion_tokens'));
      const acc = userAgg.get(userHash)
        ?? { promptTokens: 0, completionTokens: 0, totalTokens: 0, calls: 0, estCostUsd: 0 };
      acc.promptTokens += promptTokens;
      acc.completionTokens += completionTokens;
      acc.totalTokens += numAt(row, col(byUserR, 'total_tokens'));
      acc.calls += numAt(row, col(byUserR, 'calls'));
      acc.estCostUsd += estCostUsd(model, promptTokens, completionTokens);
      userAgg.set(userHash, acc);
    }
    const byUser = Array.from(userAgg, ([userHash, a]) => ({
      userHash,
      promptTokens: a.promptTokens,
      completionTokens: a.completionTokens,
      totalTokens: a.totalTokens,
      calls: a.calls,
      estCostUsd: Number(a.estCostUsd.toFixed(4)),
    })).sort((a, b) => b.calls - a.calls);

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

        return {
          // pricing:'list' flags that estCostUsd is a list-price estimate over real
          // token counts (not a billed figure) — the UI labels it "estimated".
          data: { byPersona, byDay, byUser, totals, models, days, pricing: 'list' },
        };
      },
      { ttlMs: resolveBackendTtl('copilotusage', 10 * 60_000), staleWhileRevalidate: true, bypass: refresh },
    );

    return NextResponse.json({ ok: true, ...value, meta });
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
});
