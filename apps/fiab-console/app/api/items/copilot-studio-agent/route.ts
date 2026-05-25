/**
 * GET  /api/items/copilot-studio-agent             — list agents (requires ?envId=)
 * POST /api/items/copilot-studio-agent             — create agent (body: { envId, name, description?, instructions?, modelDeployment? })
 * GET  /api/items/copilot-studio-agent?envs=1      — list Power Platform environments
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  listEnvironments,
  listAgents,
  createAgent,
  CopilotStudioError,
} from '@/lib/azure/copilot-studio-client';

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
  try {
    if (searchParams.get('envs') === '1') {
      const envs = await listEnvironments();
      return NextResponse.json({ ok: true, environments: envs });
    }
    const envId = searchParams.get('envId');
    if (!envId) return NextResponse.json({ ok: false, error: 'envId is required' }, { status: 400 });
    const agents = await listAgents(envId);
    return NextResponse.json({ ok: true, agents });
  } catch (e: any) { return handleErr(e); }
}

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  if (!body?.envId) return NextResponse.json({ ok: false, error: 'envId is required' }, { status: 400 });
  if (!body?.name) return NextResponse.json({ ok: false, error: 'name is required' }, { status: 400 });
  try {
    const agent = await createAgent(String(body.envId), {
      name: String(body.name),
      description: body.description,
      instructions: body.instructions,
      modelDeployment: body.modelDeployment,
    });
    return NextResponse.json({ ok: true, agent });
  } catch (e: any) { return handleErr(e); }
}
