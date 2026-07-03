/**
 * POST /api/governance/govern/copilot — Governance Copilot.
 *
 * Body: { question: string; chartData: unknown }
 * The current Govern posture JSON (`chartData`) is injected into the system
 * prompt as grounding (RAG over the live chart data), and the user's question
 * is answered by the tenant's Azure OpenAI GPT-4o deployment. The answer is
 * streamed back as text/event-stream so the tile bar renders it progressively.
 *
 * Real backend: Azure OpenAI chat-completions via resolveAoaiTarget() +
 * cogScope() AAD bearer (sovereign-cloud aware). No mock answers.
 *
 * Admin-gated (F2). No AOAI deployment → 503 `no_aoai` + hint naming
 * LOOM_AOAI_ENDPOINT / LOOM_AOAI_DEPLOYMENT.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { enforceRateLimit } from '@/lib/azure/rate-limiter';
import { isTenantAdmin } from '@/lib/auth/feature-gate';
import { resolveAoaiTarget } from '@/lib/azure/copilot-orchestrator';
import { loadTenantCopilotConfig } from '@/lib/azure/copilot-config-store';
import { aoaiChatStream, NoAoaiDeploymentError } from '@/lib/azure/aoai-chat-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Honest 503 gate body when no AOAI deployment is configured. */
function noAoaiDeployment(message: string) {
  return NextResponse.json(
    {
      ok: false,
      error: message,
      code: 'no_aoai',
      hint: {
        missingEnvVar: 'LOOM_AOAI_ENDPOINT',
        bicepModule: 'platform/fiab/bicep/modules/admin-plane/main.bicep',
        bicepStatus: 'Deploy an AI Foundry account + a gpt-4o class chat deployment; wire LOOM_AOAI_ENDPOINT + LOOM_AOAI_DEPLOYMENT into the apps[].env list (set automatically when agentFoundryEnabled).',
        followUp: 'Set LOOM_AOAI_ENDPOINT and LOOM_AOAI_DEPLOYMENT, or pick a Copilot chat model under Admin → Tenant settings → Copilot & Agents.',
      },
    },
    { status: 503 },
  );
}

export async function POST(req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  if (!isTenantAdmin(s)) {
    return NextResponse.json({ ok: false, error: 'forbidden', code: 'admin_only' }, { status: 403 });
  }

  // Per-principal AOAI rate limit — opt-in (LOOM_RATE_LIMIT=on). Default = no-op
  // (returns null → identical behavior). Checked before any stream is opened.
  const limited = await enforceRateLimit(s, 'aoai');
  if (limited) return limited;

  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ ok: false, error: 'invalid JSON' }, { status: 400 }); }
  const question = String(body?.question || '').trim();
  if (!question) return NextResponse.json({ ok: false, error: 'question is required' }, { status: 400 });
  const chartData = body?.chartData ?? {};

  // Resolve the tenant Copilot config once so a missing deployment surfaces the
  // honest 503 `no_aoai` gate before we stream. The unified client re-resolves
  // the same cfg internally (harmless) when aoaiChatStream is called below.
  let tenantConfig: Awaited<ReturnType<typeof loadTenantCopilotConfig>> = null;
  try {
    tenantConfig = await loadTenantCopilotConfig(s.claims.oid).catch(() => null);
    await resolveAoaiTarget(tenantConfig);
  } catch (e) {
    if (e instanceof NoAoaiDeploymentError) return noAoaiDeployment(e.message);
    return NextResponse.json({ ok: false, error: (e as any)?.message || String(e), code: 'unexpected' }, { status: 500 });
  }

  // Compact the chart JSON so it fits comfortably in the grounding context.
  let grounding = '';
  try { grounding = JSON.stringify(chartData); } catch { grounding = '{}'; }
  if (grounding.length > 12_000) grounding = grounding.slice(0, 12_000) + '…[truncated]';

  const system =
    'You are the CSA Loom Governance Copilot. Answer the user\'s question USING ONLY the ' +
    'following live governance posture data (JSON). Cite the specific numbers from the data ' +
    'in your answer. If the data does not contain the answer, say so plainly — do NOT ' +
    'speculate, invent metrics, or discuss anything outside this governance posture.\n\n' +
    'GOVERNANCE POSTURE DATA:\n' + grounding;

  let res: Response;
  try {
    res = await aoaiChatStream({
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: question },
      ],
      maxCompletionTokens: 800,
      temperature: 0.2,
      cfg: tenantConfig,
    });
  } catch (e) {
    // The pre-resolve above already surfaces the honest 503 gate, but the client
    // re-resolves internally — handle NoAoaiDeploymentError defensively too. Any
    // other throw (token mint or upstream fetch / non-OK status) collapses into
    // the same 502 `aoai_upstream` the inline fetch returned. NOTE: the former
    // `aoai_auth` 502 folds in here since the client now mints the token itself.
    if (e instanceof NoAoaiDeploymentError) return noAoaiDeployment(e.message);
    return NextResponse.json(
      { ok: false, error: `AOAI request failed: ${(e as any)?.message || e}`, code: 'aoai_upstream' },
      { status: 502 },
    );
  }

  // Pipe the SSE stream straight through to the browser (OpenAI-compatible
  // chat-completions delta chunks). The client reads `choices[0].delta.content`.
  return new NextResponse(res.body, {
    headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store' },
  });
}
