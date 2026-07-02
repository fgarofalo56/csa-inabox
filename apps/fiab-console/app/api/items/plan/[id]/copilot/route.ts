/**
 * POST /api/items/plan/[id]/copilot — Plan Copilot (connected-planning assistant).
 *
 * The streaming backend for the Plan editor's collapsible right-rail Copilot. It
 * grounds a chat completion on the plan's REAL persisted state — every sheet's
 * period subtotals, per-line-item variance vs actuals, a two-period forecast, and
 * the cube model summary — computed with the same pure helpers the grid uses
 * (lib/editors/_plan-model). The model answers questions like "explain this
 * variance" or "draft a next-quarter forecast" over that grounding.
 *
 * REAL backend (no-vaporware.md): the completion is the shared, unified Azure
 * OpenAI client (lib/azure/aoai-chat-client → aoaiChatStream) — no mocks, no
 * canned strings. The AOAI SSE deltas are re-emitted as the app's normalized
 * `event: token | final | error | done` stream the pane renders incrementally.
 * When no AOAI deployment is wired the route returns an honest 503 gate the pane
 * surfaces in a Fluent MessageBar (the editor stays fully functional).
 *
 * Azure-native (no-fabric-dependency.md): grounding is Cosmos plan state + AOAI
 * only. No Microsoft Fabric / Power BI host is ever contacted, and the route
 * works with LOOM_DEFAULT_FABRIC_WORKSPACE unset.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { loadOwnedItem } from '../../../_lib/item-crud';
import { resolveAoaiTarget, NoAoaiDeploymentError } from '@/lib/azure/copilot-orchestrator';
import { aoaiChatStream, type AoaiChatMessage } from '@/lib/azure/aoai-chat-client';
import {
  periodSeries, computeVariance, grandTotal, planInsights, forecastPeriods,
  defaultScenarios,
  type PlanningSheet, type PlanScenario,
} from '@/lib/editors/_plan-model';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ITEM_TYPE = 'plan';

const SYSTEM_PROMPT =
  'You are Plan Copilot, the connected-planning assistant embedded in a CSA Loom Plan — the Azure-native ' +
  'parity of Microsoft Fabric IQ Plan. You help finance and operations users understand and build budgets, ' +
  'forecasts, what-if scenarios, and plan-vs-actual variance. Ground every answer ONLY in the PLAN GROUNDING ' +
  'JSON provided: use the real line-item and period names, never invent numbers, and if the plan lacks the ' +
  'data to answer (e.g. no actuals captured yet) say so and name exactly what to enter to unlock it. When ' +
  'asked to draft a forecast, base it on the trend/forecast points in the grounding and state your ' +
  'assumptions. Be concise and specific. Azure-native — never suggest a Microsoft Fabric or Power BI ' +
  'dependency; actuals come from the Planning sheet, InfoBridge mappings, or a bound Loom/AAS semantic model.';

/** Build a compact, bounded grounding object from the persisted plan state. */
function buildGrounding(state: Record<string, unknown>) {
  const sheets: PlanningSheet[] = Array.isArray(state?.sheets) ? (state.sheets as PlanningSheet[]) : [];
  const scenarios: PlanScenario[] =
    Array.isArray(state?.scenarios) && (state.scenarios as PlanScenario[]).length
      ? (state.scenarios as PlanScenario[])
      : defaultScenarios();
  const activeScenarioId = scenarios.some((s) => s.id === state?.activeScenarioId)
    ? (state.activeScenarioId as string)
    : scenarios[0]?.id;
  const scenario = scenarios.find((s) => s.id === activeScenarioId) || scenarios[0];

  const modelRaw = (state?.model && typeof state.model === 'object' ? state.model : {}) as {
    dimensions?: Array<{ name?: string; members?: unknown[] }>;
    measures?: Array<{ name?: string; agg?: string }>;
  };

  const sheetGrounding = sheets.slice(0, 4).map((sheet) => {
    const series = periodSeries(sheet, activeScenarioId);
    const variance = computeVariance(sheet, activeScenarioId, sheet.actuals || {});
    const forecast = forecastPeriods(sheet, activeScenarioId, 2).filter((p) => p.forecast);
    return {
      sheet: sheet.name,
      periods: (sheet.periods || []).map((p) => p.label),
      lineItems: (sheet.lineItems || []).map((li) => ({
        name: li.name, kind: li.kind, driver: !!li.driver, unit: li.unit || undefined,
      })),
      periodSubtotals: series.map((p) => ({ period: p.label, value: p.value })),
      grandTotal: grandTotal(sheet, activeScenarioId),
      variance: variance
        .filter((v) => v.actual !== 0)
        .map((v) => ({ lineItem: v.name, plan: v.plan, actual: v.actual, delta: v.delta, pct: v.pct })),
      forecastNextPeriods: forecast.map((p) => ({ label: p.label, value: p.value })),
      insights: planInsights(sheet, activeScenarioId, variance),
    };
  });

  return {
    scenario: scenario?.name,
    scenarios: scenarios.map((s) => s.name),
    model: {
      dimensions: (modelRaw.dimensions || []).map((d) => ({ name: d.name, members: (d.members || []).length })),
      measures: (modelRaw.measures || []).map((m) => ({ name: m.name, agg: m.agg })),
    },
    sheets: sheetGrounding,
  };
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const { id } = await ctx.params;
  if (!id || id === 'new') {
    return NextResponse.json({ ok: false, error: 'Save the plan before chatting with Plan Copilot.' }, { status: 400 });
  }

  let body: { prompt?: string; history?: Array<{ role?: string; content?: string }> } = {};
  try { body = (await req.json()) as typeof body; } catch { /* validated below */ }
  const prompt = String(body.prompt || '').trim();
  if (!prompt) return NextResponse.json({ ok: false, error: 'prompt is required' }, { status: 400 });

  const plan = await loadOwnedItem(id, ITEM_TYPE, session.claims.oid);
  if (!plan) return NextResponse.json({ ok: false, error: 'plan not found' }, { status: 404 });

  // Honest 503 gate when no Azure OpenAI deployment is wired.
  try {
    await resolveAoaiTarget();
  } catch (e: any) {
    if (e instanceof NoAoaiDeploymentError) {
      return NextResponse.json({ ok: false, code: 'no_aoai', error: e.message }, { status: 503 });
    }
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }

  const grounding = buildGrounding((plan.state || {}) as Record<string, unknown>);
  const history: AoaiChatMessage[] = (Array.isArray(body.history) ? body.history : [])
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .slice(-8)
    .map((m) => ({ role: m.role as 'user' | 'assistant', content: String(m.content) }));

  const messages: AoaiChatMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'system', content: `PLAN GROUNDING (JSON):\n${JSON.stringify(grounding).slice(0, 12000)}` },
    ...history,
    { role: 'user', content: prompt },
  ];

  let upstream: Response;
  try {
    upstream = await aoaiChatStream({ messages, maxCompletionTokens: 1024, temperature: 0.3 });
  } catch (e: any) {
    if (e instanceof NoAoaiDeploymentError) {
      return NextResponse.json({ ok: false, code: 'no_aoai', error: e.message }, { status: 503 });
    }
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }

  // Re-emit the AOAI SSE deltas as the app's normalized token/final/error stream.
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown) =>
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      let full = '';
      try {
        const reader = upstream.body!.getReader();
        let buf = '';
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const lines = buf.split('\n');
          buf = lines.pop() ?? ''; // keep the trailing partial line
          for (const line of lines) {
            const t = line.trim();
            if (!t.startsWith('data:')) continue;
            const payload = t.slice(5).trim();
            if (!payload || payload === '[DONE]') continue;
            try {
              const j = JSON.parse(payload);
              const delta = j?.choices?.[0]?.delta?.content;
              if (typeof delta === 'string' && delta) { full += delta; send('token', { text: delta }); }
            } catch { /* keepalive / partial frame — ignore */ }
          }
        }
        send('final', { text: full });
      } catch (e: any) {
        send('error', { error: e?.message || String(e) });
      } finally {
        send('done', {});
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    },
  });
}
