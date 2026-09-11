/**
 * POST /api/items/copilot-studio-agent/[id]/publish — publish (body: { envId })
 */

import { NextRequest, NextResponse } from 'next/server';
import { publishAgent } from '@/lib/azure/copilot-studio-client';
import { withSession } from '@/lib/api/route-toolkit';
import { copilotStudioErrorEnvelope } from '@/lib/azure/copilot-studio-error';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withSession<{ id: string }>(async (req: NextRequest, { params }) => {
  const body = await req.json().catch(() => ({}));
  if (!body?.envId) return NextResponse.json({ ok: false, error: 'envId is required' }, { status: 400 });
  try {
    const r = await publishAgent(String(body.envId), params.id);
    return NextResponse.json(r);
  } catch (e: any) {
    const { status, body: envelope } = copilotStudioErrorEnvelope(e);
    return NextResponse.json(envelope, { status });
  }
});
