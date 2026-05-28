/**
 * POST /api/items/copilot-studio-channel/[id]/publish
 *   body: { envId, channelType, config? }
 *   Note: [id] is the agentId (not a channel id) — channels are created per
 *   publish call and keyed off the parent agent.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { publishToChannel, CopilotStudioError } from '@/lib/azure/copilot-studio-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  if (!body?.envId) return NextResponse.json({ ok: false, error: 'envId is required' }, { status: 400 });
  if (!body?.channelType) return NextResponse.json({ ok: false, error: 'channelType is required' }, { status: 400 });
  try {
    const channel = await publishToChannel(
      String(body.envId),
      (await ctx.params).id,
      String(body.channelType),
      body.config || {},
    );
    return NextResponse.json({ ok: true, channel });
  } catch (e: any) {
    const status = e instanceof CopilotStudioError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e), body: e?.body, status }, { status });
  }
}
