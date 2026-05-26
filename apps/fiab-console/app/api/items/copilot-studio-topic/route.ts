/**
 * GET  /api/items/copilot-studio-topic?envId=&agentId=    — list topics
 * POST /api/items/copilot-studio-topic                    — create topic (body: { envId, agentId, name, triggerPhrases, flowYaml })
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { listTopics, upsertTopic, CopilotStudioError } from '@/lib/azure/copilot-studio-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function handleErr(e: any) {
  const status = e instanceof CopilotStudioError ? e.status : 502;
  return NextResponse.json({ ok: false, error: e?.message || String(e), body: e?.body, status }, { status });
}

export async function GET(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const { searchParams } = new URL(req.url);
  const envId = searchParams.get('envId');
  const agentId = searchParams.get('agentId');
  if (!envId || !agentId) return NextResponse.json({ ok: false, error: 'envId and agentId are required' }, { status: 400 });
  try {
    const topics = await listTopics(envId, agentId);
    return NextResponse.json({ ok: true, topics });
  } catch (e: any) { return handleErr(e); }
}

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  if (!body?.envId || !body?.agentId) return NextResponse.json({ ok: false, error: 'envId and agentId are required' }, { status: 400 });
  if (!body?.name) return NextResponse.json({ ok: false, error: 'name is required' }, { status: 400 });
  try {
    const topic = await upsertTopic(String(body.envId), {
      agentId: String(body.agentId),
      name: String(body.name),
      triggerPhrases: Array.isArray(body.triggerPhrases) ? body.triggerPhrases.map(String) : [],
      flowYaml: typeof body.flowYaml === 'string' ? body.flowYaml : '',
    });
    return NextResponse.json({ ok: true, topic });
  } catch (e: any) { return handleErr(e); }
}
