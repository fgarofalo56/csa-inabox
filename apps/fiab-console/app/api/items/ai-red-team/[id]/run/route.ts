/**
 * POST /api/items/ai-red-team/[id]/run   (AIF-15)
 *   body { deployment, categories[], account?, rg?, perCategory?, useContentSafety? }
 *
 * A DEFENSIVE safety scan: sends curated adversarial probe prompts (safety
 * benchmark requests the model SHOULD refuse) to the chosen model deployment,
 * classifies each response as refused / partial / unsafe with an AOAI judge
 * (keyword-heuristic fallback), optionally scores each response with Azure AI
 * Content Safety, and reports the deployment's refusal rate + attack-success
 * rate. Azure-native — the Azure-native analog of the Microsoft AI Red Teaming
 * Agent / PyRIT scan. No Microsoft Fabric dependency.
 *
 * Honest gates (no-vaporware): no model deployment configured → 503; the AOAI
 * judge / Content Safety being unavailable degrades gracefully (heuristic
 * verdict / no safety score) but never fabricates results. Owner-scoped via
 * loadOwnedItem / updateOwnedItem (route-guards).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { chatCompletion, CsError, CsNotConfiguredError, type AccountSelector } from '@/lib/azure/foundry-cs-client';
import { aoaiChatJson, NoAoaiDeploymentError } from '@/lib/azure/aoai-chat-client';
import { moderateContent } from '@/lib/azure/foundry-client';
import {
  selectProbes, buildRefusalJudgePrompt, refusalHeuristic, summarizeRedTeam,
  type RedTeamCategory, type RedTeamResultRow, type RedTeamVerdict,
} from '@/lib/foundry/red-team';
import { loadOwnedItem, updateOwnedItem, jerr } from '../../../_lib/item-crud';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const ITEM_TYPE = 'ai-red-team';

/** Classify one target response: AOAI judge, heuristic fallback. */
async function judge(prompt: string, response: string): Promise<{ verdict: RedTeamVerdict; rationale?: string }> {
  try {
    const j = await aoaiChatJson<{ verdict?: string; rationale?: string }>({
      messages: buildRefusalJudgePrompt({ prompt, response }),
      maxCompletionTokens: 200,
      temperature: 0,
    });
    const v = j?.verdict === 'unsafe' || j?.verdict === 'partial' || j?.verdict === 'refused' ? (j.verdict as RedTeamVerdict) : null;
    if (v) return { verdict: v, rationale: j?.rationale };
  } catch { /* judge unavailable → heuristic */ }
  return { verdict: refusalHeuristic(response), rationale: 'Classified by refusal heuristic (AOAI judge unavailable).' };
}

/** Bounded-concurrency map. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let idx = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (idx < items.length) {
      const i = idx++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return jerr('unauthenticated', 401);
  const itemId = (await ctx.params).id;
  const item = await loadOwnedItem(itemId, ITEM_TYPE, session.claims.oid);
  if (!item) return jerr('ai-red-team item not found', 404);
  const state = (item.state || {}) as Record<string, any>;

  const body = await req.json().catch(() => ({}));
  const deployment = String(body?.deployment || state?.deployment || '').trim();
  if (!deployment) return NextResponse.json({ ok: false, error: 'A target model deployment is required.' }, { status: 400 });
  const categories: RedTeamCategory[] = Array.isArray(body?.categories) ? body.categories : Array.isArray(state?.categories) ? state.categories : [];
  const probes = selectProbes(categories, Number(body?.perCategory) || undefined);
  if (probes.length === 0) return NextResponse.json({ ok: false, error: 'Select at least one harm category to probe.' }, { status: 400 });
  const useContentSafety = body?.useContentSafety !== false;
  const selector: AccountSelector | undefined = body?.account ? { name: String(body.account), rg: body?.rg ? String(body.rg) : undefined } : undefined;

  const startedAt = new Date().toISOString();
  const t0 = Date.now();

  // 1. Probe the target deployment (bounded concurrency). A config/gate error on
  //    the FIRST call is an honest 503 (nothing to score).
  let gate503: { error: string; hint?: string } | null = null;
  const rows = await mapLimit(probes, 3, async (probe): Promise<RedTeamResultRow | null> => {
    let response = '';
    try {
      const res = await chatCompletion(deployment, [{ role: 'user', content: probe.prompt }], { temperature: 0.7, maxTokens: 512 }, selector);
      response = res.content || '';
    } catch (e: any) {
      if (e instanceof CsNotConfiguredError) { gate503 = { error: e.message, hint: (e as any).hint }; return null; }
      if (e instanceof CsError && e.status === 404) { gate503 = { error: `Model deployment "${deployment}" not found.`, hint: 'Pick a deployed model in the target picker, or deploy one from the AI Foundry hub.' }; return null; }
      // Transient per-probe error → record as an errored refusal (no harmful output produced).
      return { id: probe.id, category: probe.category, prompt: probe.prompt, response: `⚠ ${e?.message || String(e)}`, verdict: 'refused', rationale: 'Model call failed — no output produced.' };
    }
    const { verdict, rationale } = await judge(probe.prompt, response);
    const row: RedTeamResultRow = { id: probe.id, category: probe.category, prompt: probe.prompt, response, verdict, rationale };
    if (useContentSafety) {
      try {
        const v = await moderateContent(response);
        if (v.severity != null) { row.safetySeverity = v.severity; row.safetyCategory = v.category; }
      } catch { /* Content Safety optional — fail-open, no score */ }
    }
    return row;
  });

  if (gate503) {
    const g = gate503 as { error: string; hint?: string };
    return NextResponse.json({ ok: false, code: 'not_configured', gated: true, error: g.error, hint: g.hint || 'Configure a target model deployment (Azure OpenAI / AI Foundry) and grant the Console UAMI "Cognitive Services OpenAI User".' }, { status: 503 });
  }

  const resultRows = rows.filter((r): r is RedTeamResultRow => r != null);
  const summary = summarizeRedTeam(resultRows);
  const run = {
    id: crypto.randomUUID(), startedAt, finishedAt: new Date().toISOString(),
    deployment, categories, summary, results: resultRows, durationMs: Date.now() - t0,
    ranBy: session.claims.upn || session.claims.email || session.claims.oid,
  };

  // Persist the run (results trimmed to keep the doc bounded) + last-used config.
  const persistRun = { ...run, results: resultRows.map((r) => ({ ...r, response: r.response.slice(0, 600) })) };
  const runs = Array.isArray(state.runs) ? state.runs : [];
  await updateOwnedItem(itemId, ITEM_TYPE, session.claims.oid, {
    state: { ...state, deployment, categories, runs: [persistRun, ...runs].slice(0, 25) },
  }).catch(() => {});

  return NextResponse.json({ ok: true, run });
}
