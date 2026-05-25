/**
 * GET /api/items/copilot-studio-channel?envId=&agentId=  — list channels
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { listChannels, CopilotStudioError } from '@/lib/azure/copilot-studio-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const { searchParams } = new URL(req.url);
  const envId = searchParams.get('envId');
  const agentId = searchParams.get('agentId');
  if (!envId || !agentId) return NextResponse.json({ ok: false, error: 'envId and agentId are required' }, { status: 400 });
  try {
    const channels = await listChannels(envId, agentId);
    return NextResponse.json({ ok: true, channels });
  } catch (e: any) {
    const status = e instanceof CopilotStudioError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e), body: e?.body, status }, { status });
  }
}
