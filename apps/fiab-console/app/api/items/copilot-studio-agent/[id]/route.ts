/**
 * GET    /api/items/copilot-studio-agent/[id]?envId=  — fetch agent
 * PATCH  /api/items/copilot-studio-agent/[id]         — update (body: { envId, name?, description?, instructions?, modelDeployment? })
 * DELETE /api/items/copilot-studio-agent/[id]?envId=  — delete
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  getAgent, updateAgent, deleteAgent, CopilotStudioError,
} from '@/lib/azure/copilot-studio-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function handleErr(e: any) {
  const status = e instanceof CopilotStudioError ? e.status : 502;
  return NextResponse.json({ ok: false, error: e?.message || String(e), body: e?.body, status }, { status });
}

function envIdOf(req: NextRequest): string | null {
  return new URL(req.url).searchParams.get('envId');
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const envId = envIdOf(req);
  if (!envId) return NextResponse.json({ ok: false, error: 'envId is required' }, { status: 400 });
  try {
    const agent = await getAgent(envId, (await ctx.params).id);
    return NextResponse.json({ ok: true, agent });
  } catch (e: any) { return handleErr(e); }
}

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  if (!body?.envId) return NextResponse.json({ ok: false, error: 'envId is required' }, { status: 400 });
  try {
    const agent = await updateAgent(String(body.envId), (await ctx.params).id, {
      name: body.name,
      description: body.description,
      instructions: body.instructions,
      modelDeployment: body.modelDeployment,
    });
    return NextResponse.json({ ok: true, agent });
  } catch (e: any) { return handleErr(e); }
}

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const envId = envIdOf(req);
  if (!envId) return NextResponse.json({ ok: false, error: 'envId is required' }, { status: 400 });
  try {
    await deleteAgent(envId, (await ctx.params).id);
    return NextResponse.json({ ok: true });
  } catch (e: any) { return handleErr(e); }
}
