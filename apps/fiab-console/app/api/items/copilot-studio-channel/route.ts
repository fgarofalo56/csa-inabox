/**
 * GET /api/items/copilot-studio-channel?envId=&agentId=  — list channels
 */

import { NextRequest, NextResponse } from 'next/server';
import { listChannels } from '@/lib/azure/copilot-studio-client';
import { withSession } from '@/lib/api/route-toolkit';
import { copilotStudioErrorEnvelope } from '@/lib/azure/copilot-studio-error';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withSession(async (req: NextRequest) => {
  const { searchParams } = new URL(req.url);
  const envId = searchParams.get('envId');
  const agentId = searchParams.get('agentId');
  if (!envId || !agentId) return NextResponse.json({ ok: false, error: 'envId and agentId are required' }, { status: 400 });
  try {
    const channels = await listChannels(envId, agentId);
    return NextResponse.json({ ok: true, channels });
  } catch (e: any) {
    const { status, body: envelope } = copilotStudioErrorEnvelope(e);
    return NextResponse.json(envelope, { status });
  }
});
