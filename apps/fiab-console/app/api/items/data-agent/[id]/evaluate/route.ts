/**
 * POST /api/items/data-agent/[id]/evaluate
 *
 * Real Data Agent EVALUATION (Fabric "Evaluate a data agent" parity). Given a
 * ground-truth set of question / expected-answer / expected-query rows, run each
 * question through the SAME live grounded backend the test-chat uses
 * (`chatGrounded` → live AOAI deployment + real per-source query execution), then
 * judge each answer with an AOAI LLM-as-judge (correctness + query match). Returns
 * an aggregate accuracy score + per-question pass/fail, the generated query, and
 * the model that answered. The run is persisted into the agent's Cosmos item state
 * (`state.evalRuns`, newest first, capped) so it survives reload.
 *
 * Body: { questions: { question, expectedAnswer?, expectedQuery? }[] }
 *
 * No AOAI deployment → 503 + remediation (deploy a model from the Foundry hub).
 * See .claude/rules/no-vaporware.md + docs/fiab/parity/data-agent.md (#15).
 */
import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import { getSession } from '@/lib/auth/session';
import { loadOwnedItem, updateOwnedItem } from '../../../_lib/item-crud';
import { chatGrounded, NoAoaiDeploymentError, type DataAgentConfig } from '@/lib/azure/data-agent-client';
import { aoaiChatJson } from '@/lib/azure/aoai-chat-client';
import type { WorkspaceItem } from '@/lib/types/workspace';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ITEM_TYPE = 'data-agent';
const MAX_QUESTIONS = 25;
const POOL = 3;       // bounded concurrency so a large set doesn't stampede AOAI
const MAX_RUNS = 20;  // keep the newest N runs in item state

interface EvalCaseIn { question: string; expectedAnswer?: string; expectedQuery?: string }
interface EvalResult {
  question: string; expectedAnswer?: string; expectedQuery?: string;
  answer: string; query?: string; sourceUsed?: string;
  pass: boolean; score: number; queryMatch?: boolean; rationale: string; error?: string;
}
interface EvalRun {
  id: string; ranAt: string; ranBy?: string; model?: string;
  total: number; passed: number; accuracy: number; results: EvalResult[];
}

/** Same projection the /chat route uses, kept local so the two stay independent. */
function stateToConfig(state: Record<string, unknown>): DataAgentConfig {
  const sources = Array.isArray(state.sources) ? (state.sources as any[]) : [];
  return {
    instructions: String(state.instructions || state.systemPrompt || ''),
    description: state.description ? String(state.description) : undefined,
    sources: sources.map((s) => ({
      id: String(s.id || s.name || ''),
      type: s.type,
      name: String(s.name || ''),
      tables: s.tables ? String(s.tables) : undefined,
      description: s.description ? String(s.description) : undefined,
      instructions: s.instructions ? String(s.instructions) : undefined,
      examples: Array.isArray(s.examples) ? s.examples : undefined,
    })),
  };
}

const JUDGE_SYSTEM =
  'You are a strict evaluation judge for an enterprise data agent that answers natural-language ' +
  'questions by generating and running queries (SQL / KQL / DAX / GQL) over governed data. ' +
  'You are given the user QUESTION, the agent ANSWER, the agent GENERATED QUERY, and optionally an ' +
  'EXPECTED ANSWER and/or EXPECTED QUERY. Decide whether the agent answer is correct and grounded. ' +
  'When an expected answer is provided, the agent answer must be semantically equivalent. When an ' +
  'expected query is provided, judge whether the generated query is logically equivalent (ignore ' +
  'formatting / alias / whitespace differences). When neither is provided, judge whether the answer ' +
  'is specific, grounded in a real query (not a refusal or hedge), and directly answers the question. ' +
  'Respond ONLY as compact JSON: ' +
  '{"pass": boolean, "score": number between 0 and 1, "queryMatch": boolean, "rationale": string (<=240 chars)}.';

async function judge(c: EvalCaseIn, answer: string, query: string | undefined): Promise<{ pass: boolean; score: number; queryMatch?: boolean; rationale: string }> {
  const user =
    `QUESTION:\n${c.question}\n\n` +
    `AGENT ANSWER:\n${answer || '(empty)'}\n\n` +
    `GENERATED QUERY:\n${query || '(none)'}\n\n` +
    (c.expectedAnswer ? `EXPECTED ANSWER:\n${c.expectedAnswer}\n\n` : '') +
    (c.expectedQuery ? `EXPECTED QUERY:\n${c.expectedQuery}\n\n` : '') +
    'Return the JSON verdict.';
  const v = await aoaiChatJson<{ pass?: boolean; score?: number; queryMatch?: boolean; rationale?: string }>({
    messages: [
      { role: 'system', content: JUDGE_SYSTEM },
      { role: 'user', content: user },
    ],
    temperature: 0,
    maxCompletionTokens: 400,
  });
  const score = typeof v?.score === 'number' ? Math.max(0, Math.min(1, v.score)) : (v?.pass ? 1 : 0);
  return {
    pass: v?.pass === true || score >= 0.6,
    score,
    queryMatch: typeof v?.queryMatch === 'boolean' ? v.queryMatch : undefined,
    rationale: String(v?.rationale || '').slice(0, 240),
  };
}

/** Run a bounded-concurrency map preserving input order. */
async function mapPool<I, O>(items: I[], limit: number, fn: (item: I, idx: number) => Promise<O>): Promise<O[]> {
  const out = new Array<O>(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const { id } = await ctx.params;
  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ ok: false, error: 'invalid JSON body' }, { status: 400 }); }

  const questions: EvalCaseIn[] = (Array.isArray(body?.questions) ? body.questions : [])
    .map((q: any) => ({
      question: String(q?.question || '').trim(),
      expectedAnswer: q?.expectedAnswer ? String(q.expectedAnswer) : undefined,
      expectedQuery: q?.expectedQuery ? String(q.expectedQuery) : undefined,
    }))
    .filter((q: EvalCaseIn) => q.question.length > 0)
    .slice(0, MAX_QUESTIONS);
  if (questions.length === 0) {
    return NextResponse.json({ ok: false, error: 'At least one ground-truth question is required.' }, { status: 400 });
  }

  let item: WorkspaceItem | null;
  try {
    item = await loadOwnedItem(id, ITEM_TYPE, session.claims.oid);
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || 'cosmos error' }, { status: 500 });
  }
  if (!item) return NextResponse.json({ ok: false, error: 'data-agent item not found' }, { status: 404 });

  const cfg = stateToConfig((item.state || {}) as Record<string, unknown>);
  if (cfg.sources.length === 0) {
    return NextResponse.json({ ok: false, error: 'Attach at least one data source on the Build tab before evaluating.' }, { status: 400 });
  }

  let model: string | undefined;
  try {
    const results = await mapPool<EvalCaseIn, EvalResult>(questions, POOL, async (c) => {
      try {
        const ans = await chatGrounded(cfg, [], c.question);
        if (ans.model) model = ans.model;
        const v = await judge(c, ans.answer, ans.query);
        return {
          question: c.question, expectedAnswer: c.expectedAnswer, expectedQuery: c.expectedQuery,
          answer: ans.answer, query: ans.query, sourceUsed: ans.sourceUsed,
          pass: v.pass, score: v.score, queryMatch: v.queryMatch, rationale: v.rationale,
        };
      } catch (e: any) {
        if (e instanceof NoAoaiDeploymentError) throw e; // bubble to the 503 gate
        return {
          question: c.question, expectedAnswer: c.expectedAnswer, expectedQuery: c.expectedQuery,
          answer: '', pass: false, score: 0, rationale: 'agent error', error: e?.message || String(e),
        };
      }
    });

    const passed = results.filter((r) => r.pass).length;
    const run: EvalRun = {
      id: randomUUID(),
      ranAt: new Date().toISOString(),
      ranBy: session.claims.upn || session.claims.email || session.claims.oid,
      model,
      total: results.length,
      passed,
      accuracy: results.length ? Math.round((passed / results.length) * 100) : 0,
      results,
    };

    // Persist the run into the agent's Cosmos item state (newest first, capped).
    try {
      const prevRuns = Array.isArray((item.state as any)?.evalRuns) ? ((item.state as any).evalRuns as EvalRun[]) : [];
      const nextState = { ...(item.state || {}), evalRuns: [run, ...prevRuns].slice(0, MAX_RUNS) };
      await updateOwnedItem(id, ITEM_TYPE, session.claims.oid, { state: nextState });
    } catch { /* persistence best-effort: the run is still returned to the caller */ }

    return NextResponse.json({ ok: true, run });
  } catch (e: any) {
    if (e instanceof NoAoaiDeploymentError) {
      return NextResponse.json({
        ok: false,
        notDeployed: true,
        error: e.message,
        hint: 'Open the AI Foundry hub editor → "Quota + usage" tab → "Deploy gpt-4o-mini" (or set LOOM_AOAI_ENDPOINT + LOOM_AOAI_DEPLOYMENT). Evaluation reuses the same AOAI deployment as the data-agent test chat.',
      }, { status: 503 });
    }
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}
