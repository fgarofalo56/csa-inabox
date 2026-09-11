/**
 * GET /api/items/copilot-studio-analytics/[id]?envId=&days=30
 *   [id] is the agentId.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAnalytics } from '@/lib/azure/copilot-studio-client';
import { copilotStudioErrorEnvelope } from '@/lib/azure/copilot-studio-error';
import { withSession } from '@/lib/api/route-toolkit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withSession<{ id: string }>(async (req: NextRequest, { params }) => {
  const { searchParams } = new URL(req.url);
  const envId = searchParams.get('envId');
  if (!envId) return NextResponse.json({ ok: false, error: 'envId is required' }, { status: 400 });
  const days = Math.max(1, Math.min(180, Number(searchParams.get('days') || '30')));
  try {
    const analytics = await getAnalytics(envId, params.id, days);
    return NextResponse.json({ ok: true, analytics });
  } catch (e: any) {
    const { status, body } = copilotStudioErrorEnvelope(e);
    return NextResponse.json(body, { status });
  }
});
