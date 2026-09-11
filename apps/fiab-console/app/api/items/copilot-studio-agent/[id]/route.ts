/**
 * GET    /api/items/copilot-studio-agent/[id]?envId=  — fetch agent
 * PATCH  /api/items/copilot-studio-agent/[id]         — update (body: { envId, name?, description?, instructions?, modelDeployment? })
 * DELETE /api/items/copilot-studio-agent/[id]?envId=  — delete
 */

import { NextRequest, NextResponse } from 'next/server';
import {
  getAgent, updateAgent, deleteAgent,
} from '@/lib/azure/copilot-studio-client';
import { copilotStudioErrorEnvelope } from '@/lib/azure/copilot-studio-error';
import { withSession } from '@/lib/api/route-toolkit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function handleErr(e: any) {
  const { status, body: envelope } = copilotStudioErrorEnvelope(e);
  return NextResponse.json(envelope, { status });
}

function envIdOf(req: NextRequest): string | null {
  return new URL(req.url).searchParams.get('envId');
}

export const GET = withSession<{ id: string }>(async (req: NextRequest, { session, params }) => {
  const envId = envIdOf(req);
  if (!envId) return NextResponse.json({ ok: false, error: 'envId is required' }, { status: 400 });
  try {
    const agent = await getAgent(envId, params.id);
    return NextResponse.json({ ok: true, agent });
  } catch (e: any) { return handleErr(e); }
});

export const PATCH = withSession<{ id: string }>(async (req: NextRequest, { session, params }) => {
  const body = await req.json().catch(() => ({}));
  if (!body?.envId) return NextResponse.json({ ok: false, error: 'envId is required' }, { status: 400 });
  try {
    const agent = await updateAgent(String(body.envId), params.id, {
      name: body.name,
      description: body.description,
      instructions: body.instructions,
      modelDeployment: body.modelDeployment,
    });
    return NextResponse.json({ ok: true, agent });
  } catch (e: any) { return handleErr(e); }
});

export const DELETE = withSession<{ id: string }>(async (req: NextRequest, { params }) => {
  const envId = envIdOf(req);
  if (!envId) return NextResponse.json({ ok: false, error: 'envId is required' }, { status: 400 });
  try {
    await deleteAgent(envId, params.id);
    return NextResponse.json({ ok: true });
  } catch (e: any) { return handleErr(e); }
});
