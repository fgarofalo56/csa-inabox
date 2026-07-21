/**
 * WS-1.5 — POST /api/foundry/agents/eval/judge
 *
 * One-click LLM judge endpoint (mlflow.evaluate-style).
 *
 * Body:
 *   { evaluatorType: EvaluatorType, question: string, answer: string,
 *     context?: string, toolCalls?: string, instructions?: string }
 *
 * Calls the REAL AOAI judge (aoaiChatJson) with the built-in evaluator prompt
 * for the requested evaluator type. Returns:
 *   { ok: true, score: 1-5, rationale, evaluatorType, scoredAt }
 *
 * Honest-gated (HTTP 503 aoai_not_configured) when no AOAI deployment is
 * reachable. Auth: session required (user's own minted-session cookie).
 * No mocks. See .claude/rules/no-vaporware.md.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { aoaiChatJson, NoAoaiDeploymentError } from '@/lib/azure/aoai-chat-client';
import {
  EVALUATOR_TYPES,
  buildEvaluatorPrompt,
  parseJudgeResponse,
  type EvaluatorType,
  type EvaluatorPromptInput,
} from '@/lib/foundry/evaluator-library';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { body = {}; }

  const evaluatorType = String(body?.evaluatorType || '').trim() as EvaluatorType;
  if (!EVALUATOR_TYPES.includes(evaluatorType)) {
    return NextResponse.json(
      { ok: false, error: `evaluatorType must be one of: ${EVALUATOR_TYPES.join(', ')}` },
      { status: 400 },
    );
  }

  const question = String(body?.question || '').trim();
  const answer = String(body?.answer || '').trim();
  if (!question) return NextResponse.json({ ok: false, error: 'question is required' }, { status: 400 });
  if (!answer)   return NextResponse.json({ ok: false, error: 'answer is required' }, { status: 400 });

  const input: EvaluatorPromptInput = {
    evaluatorType,
    question,
    answer,
    context:      typeof body?.context      === 'string' ? body.context      : undefined,
    toolCalls:    typeof body?.toolCalls    === 'string' ? body.toolCalls    : undefined,
    instructions: typeof body?.instructions === 'string' ? body.instructions : undefined,
  };

  const messages = buildEvaluatorPrompt(input);

  try {
    const raw = await aoaiChatJson<Record<string, unknown>>({
      messages,
      maxCompletionTokens: 256,
      temperature: 0,
      taskClass: 'reasoning',
    });
    const result = parseJudgeResponse(raw, evaluatorType);
    return NextResponse.json({ ok: true, ...result });
  } catch (e: unknown) {
    if (e instanceof NoAoaiDeploymentError) {
      return NextResponse.json(
        {
          ok: false,
          error: 'aoai_not_configured',
          hint: 'Set LOOM_AOAI_ENDPOINT + LOOM_AOAI_DEPLOYMENT on the Console app (Admin → Runtime configuration).',
          missing: 'LOOM_AOAI_ENDPOINT, LOOM_AOAI_DEPLOYMENT',
        },
        { status: 503 },
      );
    }
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg.slice(0, 300) }, { status: 502 });
  }
}
