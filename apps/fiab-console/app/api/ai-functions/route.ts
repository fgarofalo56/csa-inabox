/**
 * AI Functions → HTTP surface.
 *
 * The REAL backend for the data-science "AI Functions" capability (replaces the
 * vaporware `fiab-ai-functions` PyPI lib + Models/Endpoints panes). Runs a
 * GPT-class text operation against the SAME live AOAI deployment the cross-item
 * Copilot and data-agent test-chat resolve. No Microsoft Fabric / Power BI
 * dependency — pure Azure OpenAI (per .claude/rules/no-fabric-dependency.md).
 *
 *   POST /api/ai-functions
 *     body { fn: one of AI_FN_NAMES (summarize|classify|sentiment|extract|
 *              translate|fix_grammar|generate_response|embed|similarity),
 *            input: string,
 *            options?: { maxTokens?, labels?, fields?, targetLang?, compareTo?,
 *                        embeddingDeployment? } }
 *     → 200 { ok: true, result, model, usage, vector?, similarity? }
 *     → 501 { ok: false, code: 'not_configured', ... }  (no AOAI model deployed)
 *     → 4xx/502 on validation / upstream errors
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { loadTenantCopilotConfig } from '@/lib/azure/copilot-config-store';
import {
  callAiFn,
  emitAiFnUsage,
  NoAoaiDeploymentError,
  AI_FN_NAMES,
  isAiFn,
  type AiFnOptions,
} from '@/lib/azure/ai-functions-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  let body: any;
  try { body = await req.json(); } catch { body = {}; }

  const fn = typeof body?.fn === 'string' ? body.fn.trim() : '';
  if (!isAiFn(fn)) {
    return NextResponse.json(
      { ok: false, error: `Invalid fn "${fn}". Must be one of: ${AI_FN_NAMES.join(', ')}.` },
      { status: 400 },
    );
  }

  const input = typeof body?.input === 'string' ? body.input : '';
  if (!input.trim()) {
    return NextResponse.json({ ok: false, error: 'input required (non-empty string)' }, { status: 400 });
  }

  const opts: AiFnOptions = {};
  const o = body?.options;
  if (o && typeof o === 'object') {
    if (typeof o.maxTokens === 'number' && o.maxTokens > 0) opts.maxTokens = o.maxTokens;
    if (Array.isArray(o.labels)) opts.labels = o.labels.map((x: unknown) => String(x)).filter(Boolean);
    if (Array.isArray(o.fields)) opts.fields = o.fields.map((x: unknown) => String(x)).filter(Boolean);
    if (typeof o.targetLang === 'string' && o.targetLang.trim()) opts.targetLang = o.targetLang.trim();
    if (typeof o.compareTo === 'string' && o.compareTo.trim()) opts.compareTo = o.compareTo.trim();
    if (typeof o.embeddingDeployment === 'string' && o.embeddingDeployment.trim()) opts.embeddingDeployment = o.embeddingDeployment.trim();
  }

  try {
    // Forward the admin-picked tenant Copilot deployment (Admin → Tenant
    // settings → Copilot & Agents) so AI Functions resolve the same live AOAI
    // target as the cross-item Copilot — works even when LOOM_AOAI_ENDPOINT is
    // unset but a tenant chat model is configured. Azure-native, no Fabric.
    opts.tenantConfig = await loadTenantCopilotConfig(session.claims.oid).catch(() => null);
    const { result, model, usage, vector, similarity } = await callAiFn(fn, input, opts);
    // Per-call token/cost receipt → App Insights (persona `ai-function`); the
    // usage-chargeback + copilot-usage admin panels meter it. Awaited so the
    // event flushes before the serverless invocation can freeze; never throws.
    await emitAiFnUsage(fn, usage, model, session.claims.oid);
    return NextResponse.json({ ok: true, result, model, usage, vector, similarity });
  } catch (e: any) {
    if (e instanceof NoAoaiDeploymentError) {
      return NextResponse.json(
        {
          ok: false,
          code: 'not_configured',
          error: e.message,
          hint: 'Deploy a chat model (e.g. gpt-4o-mini) from the AI Foundry hub ("Quota + usage" → Deploy), or set LOOM_AOAI_ENDPOINT + LOOM_AOAI_DEPLOYMENT. No Microsoft Fabric required.',
          missing: 'LOOM_AOAI_DEPLOYMENT',
        },
        { status: 501 },
      );
    }
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}
