/**
 * POST /api/items/copilot-studio-agent/[id]/directline-token
 *   Mints a single-conversation Direct Line token for the agent's test chat.
 *   Returns 424 with an honest infra-gate message when no Direct Line secret
 *   is configured for the agent (LOOM_COPILOT_DIRECTLINE_SECRET[_<id>]).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getDirectLineToken } from '@/lib/azure/copilot-studio-client';
import { withSession } from '@/lib/api/route-toolkit';
import { copilotStudioErrorEnvelope } from '@/lib/azure/copilot-studio-error';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withSession<{ id: string }>(async (_req: NextRequest, { params }) => {
  try {
    const tok = await getDirectLineToken(params.id);
    return NextResponse.json({ ok: true, ...tok });
  } catch (e: any) {
    const { status, body: envelope } = copilotStudioErrorEnvelope(e);
    return NextResponse.json(envelope, { status });
  }
});
