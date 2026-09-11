/**
 * GET    /api/items/copilot-studio-topic/[id]?envId=  — fetch topic
 * PATCH  /api/items/copilot-studio-topic/[id]         — update (body: { envId, agentId, name, triggerPhrases, flowYaml })
 * DELETE /api/items/copilot-studio-topic/[id]?envId=
 */

import { NextRequest, NextResponse } from 'next/server';
import { getTopic, upsertTopic, deleteTopic } from '@/lib/azure/copilot-studio-client';
import { withSession } from '@/lib/api/route-toolkit';
import { copilotStudioErrorEnvelope } from '@/lib/azure/copilot-studio-error';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function handleErr(e: any) {
  const { status, body: envelope } = copilotStudioErrorEnvelope(e);
  return NextResponse.json(envelope, { status });
}

export const GET = withSession<{ id: string }>(async (req: NextRequest, { session, params }) => {
  const envId = new URL(req.url).searchParams.get('envId');
  if (!envId) return NextResponse.json({ ok: false, error: 'envId is required' }, { status: 400 });
  try {
    const topic = await getTopic(envId, params.id);
    return NextResponse.json({ ok: true, topic });
  } catch (e: any) { return handleErr(e); }
});

export const PATCH = withSession<{ id: string }>(async (req: NextRequest, { session, params }) => {
  const body = await req.json().catch(() => ({}));
  if (!body?.envId) return NextResponse.json({ ok: false, error: 'envId is required' }, { status: 400 });
  try {
    const topic = await upsertTopic(String(body.envId), {
      agentId: String(body.agentId || ''),
      name: String(body.name || ''),
      triggerPhrases: Array.isArray(body.triggerPhrases) ? body.triggerPhrases.map(String) : [],
      flowYaml: typeof body.flowYaml === 'string' ? body.flowYaml : '',
    }, params.id);
    return NextResponse.json({ ok: true, topic });
  } catch (e: any) { return handleErr(e); }
});

export const DELETE = withSession<{ id: string }>(async (req: NextRequest, { params }) => {
  const envId = new URL(req.url).searchParams.get('envId');
  if (!envId) return NextResponse.json({ ok: false, error: 'envId is required' }, { status: 400 });
  try {
    await deleteTopic(envId, params.id);
    return NextResponse.json({ ok: true });
  } catch (e: any) { return handleErr(e); }
});
