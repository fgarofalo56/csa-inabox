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
import { uamiArmCredential } from '@/lib/azure/arm-credential';
import { getSession } from '@/lib/auth/session';
import { isTenantAdmin } from '@/lib/auth/feature-gate';
import { resolveAoaiTarget, NoAoaiDeploymentError } from '@/lib/azure/copilot-orchestrator';
import { loadTenantCopilotConfig } from '@/lib/azure/copilot-config-store';
import { cogScope } from '@/lib/azure/cloud-endpoints';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// ---------- Credential (ACA-first UAMI chain — shared helper) ----------
const credential = uamiArmCredential();

export async function POST(req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  if (!isTenantAdmin(s)) {
    return NextResponse.json({ ok: false, error: 'forbidden', code: 'admin_only' }, { status: 403 });
  }

  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ ok: false, error: 'invalid JSON' }, { status: 400 }); }
  const question = String(body?.question || '').trim();
  if (!question) return NextResponse.json({ ok: false, error: 'question is required' }, { status: 400 });
  const chartData = body?.chartData ?? {};

  let target;
  try {
    const tenantConfig = await loadTenantCopilotConfig(s.claims.oid).catch(() => null);
    target = await resolveAoaiTarget(tenantConfig);
  } catch (e) {
    if (e instanceof NoAoaiDeploymentError) {
      return NextResponse.json(
        {
          ok: false,
          error: e.message,
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

  let token: string;
  try {
    const t = await credential.getToken(cogScope());
    if (!t?.token) throw new Error('no token');
    token = t.token;
  } catch (e) {
    return NextResponse.json({ ok: false, error: `Failed to acquire AOAI token: ${(e as any)?.message || e}`, code: 'aoai_auth' }, { status: 502 });
  }

  const url = `${target.endpoint}/openai/deployments/${encodeURIComponent(target.deployment)}/chat/completions?api-version=${target.apiVersion}`;
  const payload = {
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: question },
    ],
    max_tokens: 800,
    temperature: 0.2,
    stream: true,
  };

  let upstream: Response;
  try {
    upstream = await fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: `AOAI request failed: ${(e as any)?.message || e}`, code: 'aoai_upstream' }, { status: 502 });
  }

  if (!upstream.ok || !upstream.body) {
    const errText = await upstream.text().catch(() => '');
    // Some reasoning models reject temperature; retry once without it (non-streamed
    // would change shape, so retry streamed without temperature).
    if (upstream.status === 400 && /temperature|unsupported_value|does not support/i.test(errText)) {
      const retry = await fetch(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ ...payload, temperature: undefined }),
      }).catch(() => null);
      if (retry?.ok && retry.body) {
        return new NextResponse(retry.body, {
          headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store' },
        });
      }
    }
    return NextResponse.json(
      { ok: false, error: `AOAI chat-completions failed ${upstream.status}: ${errText.slice(0, 400)}`, code: 'aoai_upstream' },
      { status: 502 },
    );
  }

  // Pipe the SSE stream straight through to the browser (OpenAI-compatible
  // chat-completions delta chunks). The client reads `choices[0].delta.content`.
  return new NextResponse(upstream.body, {
    headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store' },
  });
}
