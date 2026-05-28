/**
 * GET    /api/items/copilot-studio-topic/[id]?envId=  — fetch topic
 * PATCH  /api/items/copilot-studio-topic/[id]         — update (body: { envId, agentId, name, triggerPhrases, flowYaml })
 * DELETE /api/items/copilot-studio-topic/[id]?envId=
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { getTopic, upsertTopic, deleteTopic, CopilotStudioError } from '@/lib/azure/copilot-studio-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function handleErr(e: any) {
  const status = e instanceof CopilotStudioError ? e.status : 502;
  return NextResponse.json({ ok: false, error: e?.message || String(e), body: e?.body, status }, { status });
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const envId = new URL(req.url).searchParams.get('envId');
  if (!envId) return NextResponse.json({ ok: false, error: 'envId is required' }, { status: 400 });
  try {
    const topic = await getTopic(envId, (await ctx.params).id);
    return NextResponse.json({ ok: true, topic });
  } catch (e: any) { return handleErr(e); }
}

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  if (!body?.envId) return NextResponse.json({ ok: false, error: 'envId is required' }, { status: 400 });
  try {
    const topic = await upsertTopic(String(body.envId), {
      agentId: String(body.agentId || ''),
      name: String(body.name || ''),
      triggerPhrases: Array.isArray(body.triggerPhrases) ? body.triggerPhrases.map(String) : [],
      flowYaml: typeof body.flowYaml === 'string' ? body.flowYaml : '',
    }, (await ctx.params).id);
    return NextResponse.json({ ok: true, topic });
  } catch (e: any) { return handleErr(e); }
}

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const envId = new URL(req.url).searchParams.get('envId');
  if (!envId) return NextResponse.json({ ok: false, error: 'envId is required' }, { status: 400 });
  try {
    await deleteTopic(envId, (await ctx.params).id);
    return NextResponse.json({ ok: true });
  } catch (e: any) { return handleErr(e); }
}
