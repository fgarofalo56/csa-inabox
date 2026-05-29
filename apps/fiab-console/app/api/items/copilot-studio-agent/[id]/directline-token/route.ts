/**
 * POST /api/items/copilot-studio-agent/[id]/directline-token
 *   Mints a single-conversation Direct Line token for the agent's test chat.
 *   Returns 424 with an honest infra-gate message when no Direct Line secret
 *   is configured for the agent (LOOM_COPILOT_DIRECTLINE_SECRET[_<id>]).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { getDirectLineToken, CopilotStudioError } from '@/lib/azure/copilot-studio-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  try {
    const tok = await getDirectLineToken((await ctx.params).id);
    return NextResponse.json({ ok: true, ...tok });
  } catch (e: any) {
    const status = e instanceof CopilotStudioError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e), body: e?.body, status }, { status });
  }
}
