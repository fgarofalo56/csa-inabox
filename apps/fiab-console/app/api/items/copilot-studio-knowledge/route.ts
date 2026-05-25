/**
 * GET  /api/items/copilot-studio-knowledge?envId=&agentId=  — list knowledge sources
 * POST /api/items/copilot-studio-knowledge                  — add (body: { envId, agentId, type, name?, uri? })
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  listKnowledgeSources, addKnowledgeSource, CopilotStudioError,
  type KnowledgeSourceType,
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
  const envId = searchParams.get('envId');
  const agentId = searchParams.get('agentId');
  if (!envId || !agentId) return NextResponse.json({ ok: false, error: 'envId and agentId are required' }, { status: 400 });
  try {
    const knowledge = await listKnowledgeSources(envId, agentId);
    return NextResponse.json({ ok: true, knowledge });
  } catch (e: any) { return handleErr(e); }
}

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  if (!body?.envId || !body?.agentId) return NextResponse.json({ ok: false, error: 'envId and agentId are required' }, { status: 400 });
  if (!body?.type) return NextResponse.json({ ok: false, error: 'type is required' }, { status: 400 });
  try {
    const ks = await addKnowledgeSource(String(body.envId), String(body.agentId), {
      type: body.type as KnowledgeSourceType,
      name: body.name,
      uri: body.uri,
    });
    return NextResponse.json({ ok: true, knowledge: ks });
  } catch (e: any) { return handleErr(e); }
}
