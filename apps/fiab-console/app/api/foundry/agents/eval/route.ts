/**
 * AIF-13 — agent eval hooks (eval-linked scoring). Run a structured prompt-set
 * against an agent and score each answer with a REAL AOAI judge call.
 *
 *   GET  /api/foundry/agents/eval?agent=<name>  — list this caller's stored eval runs.
 *   POST /api/foundry/agents/eval               — run an eval.
 *     body { agent, name?, prompts:[{prompt, criteria?}], instructions?, model?, passThreshold? }
 *     → { ok, eval } — per-row {answer, score 1-5, rationale} + avgScore + passRate.
 *
 * Each prompt is a REAL agent run (runAgentInspectTiered) followed by a REAL
 * AOAI judge call (aoaiChatJson). Honest-gated (HTTP 501 not_configured) when
 * neither agent runtime tier is configured; the judge surfaces an AOAI error if
 * no chat deployment is reachable. Owner-scoped by session oid. No mocks.
 * See .claude/rules/no-vaporware.md.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { FoundryAgentError } from '@/lib/azure/foundry-agent-client';
import {
  runAgentInspectTiered,
  selectAgentTier,
  FoundryAgentNotConfiguredError,
  MafAgentDefinitionRequiredError,
} from '@/lib/azure/agent-runtime-tier';
import { aoaiChatJson } from '@/lib/azure/aoai-chat-client';
import { saveEvalRun, listEvalRuns, type AgentEvalResultRow } from '@/lib/azure/agent-memory-client';
import {
  normalizePromptSet, buildJudgePrompt, clampScore, summarizeEval,
  DEFAULT_PASS_THRESHOLD, type EvalPrompt,
} from '@/lib/foundry/agent-eval';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;

export async function GET(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const userOid = session.claims.oid;
  const agent = req.nextUrl.searchParams.get('agent')?.trim();
  if (!agent) return NextResponse.json({ ok: false, error: 'agent (agent name) required' }, { status: 400 });
  try {
    const runs = await listEvalRuns(agent, userOid);
    return NextResponse.json({ ok: true, runs });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const userOid = session.claims.oid;

  let body: any;
  try { body = await req.json(); } catch { body = {}; }
  const agent = typeof body?.agent === 'string' ? body.agent.trim() : '';
  const instructions = typeof body?.instructions === 'string' ? body.instructions : undefined;
  const model = typeof body?.model === 'string' ? body.model : undefined;
  const name = (typeof body?.name === 'string' && body.name.trim()) ? body.name.trim() : `Eval ${new Date().toISOString().slice(0, 16)}`;
  const passThreshold = Number.isFinite(body?.passThreshold) ? Math.min(5, Math.max(1, Math.round(body.passThreshold))) : DEFAULT_PASS_THRESHOLD;
  const prompts: EvalPrompt[] = normalizePromptSet(Array.isArray(body?.prompts) ? body.prompts : []);
  if (!agent) return NextResponse.json({ ok: false, error: 'agent (agent name) required' }, { status: 400 });
  if (!prompts.length) return NextResponse.json({ ok: false, error: 'prompts (a non-empty prompt-set) required' }, { status: 400 });

  try {
    const results: AgentEvalResultRow[] = [];
    for (const p of prompts) {
      // 1) REAL agent run for this prompt.
      let answer = '';
      let status = 'failed';
      try {
        const { inspection } = await runAgentInspectTiered({
          agentName: agent, question: p.prompt, userOid, instructions, model,
        });
        answer = inspection.answer || '';
        status = inspection.status || 'completed';
      } catch (e) {
        // A per-prompt runtime error (not a not-configured gate — that rethrows
        // below) is recorded as an unscored failed row so the run still returns.
        if (e instanceof FoundryAgentNotConfiguredError || e instanceof MafAgentDefinitionRequiredError) throw e;
        results.push({ prompt: p.prompt, criteria: p.criteria, answer: '', score: 0, status: 'failed', rationale: 'Agent run failed.' });
        continue;
      }
      // 2) REAL AOAI judge scores the answer 1-5.
      let score = 0;
      let rationale: string | undefined;
      try {
        const judged = await aoaiChatJson<{ score?: unknown; rationale?: unknown }>({
          maxCompletionTokens: 256,
          messages: buildJudgePrompt({ prompt: p.prompt, criteria: p.criteria, answer }),
        });
        score = clampScore(judged?.score);
        rationale = judged?.rationale ? String(judged.rationale).slice(0, 300) : undefined;
      } catch {
        rationale = 'Judge scoring unavailable (no AOAI chat deployment reachable).';
      }
      results.push({ prompt: p.prompt, criteria: p.criteria, answer, score, status, rationale });
    }

    const summary = summarizeEval(results, passThreshold);
    const saved = await saveEvalRun({
      agentId: agent, userOid, name, model,
      results, avgScore: summary.avgScore, passRate: summary.passRate, passThreshold,
    });
    return NextResponse.json({ ok: true, eval: saved, summary });
  } catch (e: any) {
    if (e instanceof FoundryAgentNotConfiguredError) {
      return NextResponse.json(
        { ok: false, code: 'not_configured', error: e.message, hint: e.hint, missing: 'LOOM_FOUNDRY_PROJECT_ENDPOINT' },
        { status: 501 },
      );
    }
    if (e instanceof MafAgentDefinitionRequiredError) {
      return NextResponse.json(
        { ok: false, code: 'maf_needs_definition', error: e.message, tier: selectAgentTier().tier },
        { status: 400 },
      );
    }
    const status = e instanceof FoundryAgentError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e), body: e?.body }, { status });
  }
}
