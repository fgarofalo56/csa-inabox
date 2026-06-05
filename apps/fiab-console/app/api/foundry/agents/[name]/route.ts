/**
 * AI Foundry Agents — get + delete a single agent by name.
 *
 *   GET    /api/foundry/agents/{name}  → { ok, agent }  (404 → { ok:false } 404)
 *   DELETE /api/foundry/agents/{name}  → { ok: true }
 *
 * Real Foundry Agent Service REST (lib/azure/foundry-agent-client). Honest gate
 * (HTTP 501, code:'not_configured') when LOOM_FOUNDRY_PROJECT_ENDPOINT isn't set.
 * See .claude/rules/no-vaporware.md.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  getAgent,
  deleteAgent,
  getProjectId,
  FoundryAgentNotConfiguredError,
  FoundryAgentError,
} from '@/lib/azure/foundry-agent-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function errorResponse(e: any): NextResponse {
  if (e instanceof FoundryAgentNotConfiguredError) {
    return NextResponse.json(
      { ok: false, code: 'not_configured', error: e.message, hint: e.hint, missing: 'LOOM_FOUNDRY_PROJECT_ENDPOINT' },
      { status: 501 },
    );
  }
  const status = e instanceof FoundryAgentError ? e.status : 502;
  return NextResponse.json({ ok: false, error: e?.message || String(e), body: e?.body }, { status });
}

export async function GET(_req: NextRequest, ctx: { params: Promise<{ name: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const { name } = await ctx.params;
  if (!name) return NextResponse.json({ ok: false, error: 'agent name required' }, { status: 400 });
  try {
    const projectId = getProjectId();
    const agent = await getAgent(projectId, name);
    if (!agent) return NextResponse.json({ ok: false, error: `agent "${name}" not found` }, { status: 404 });
    return NextResponse.json({ ok: true, agent });
  } catch (e: any) {
    return errorResponse(e);
  }
}

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ name: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const { name } = await ctx.params;
  if (!name) return NextResponse.json({ ok: false, error: 'agent name required' }, { status: 400 });
  try {
    const projectId = getProjectId();
    await deleteAgent(projectId, name);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return errorResponse(e);
  }
}
