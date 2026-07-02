/**
 * GET  /api/items/copilot-studio-action?envId=&agentId=  — list actions
 * POST /api/items/copilot-studio-action                  — bind (body: { envId, agentId, name, type, connectorId?, flowId?, parameters? })
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { listActions, bindAction, CopilotStudioError } from '@/lib/azure/copilot-studio-client';

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
    const actions = await listActions(envId, agentId);
    return NextResponse.json({ ok: true, actions });
  } catch (e: any) { return handleErr(e); }
}

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  if (!body?.envId || !body?.agentId) return NextResponse.json({ ok: false, error: 'envId and agentId are required' }, { status: 400 });
  if (!body?.name || !body?.type) return NextResponse.json({ ok: false, error: 'name and type are required' }, { status: 400 });
  try {
    const action = await bindAction(String(body.envId), {
      agentId: String(body.agentId),
      name: String(body.name),
      type: String(body.type),
      connectorId: body.connectorId,
      flowId: body.flowId,
      // Forward the structured Inputs/Outputs mapping grid (no freeform JSON).
      // bindAction performs an honest EntityDefinitions pre-flight on
      // msdyn_parameterconfiguration and either persists the Memo JSON or
      // throws a 422 gate — it never silently drops the mapping.
      parameters: Array.isArray(body.parameters) ? body.parameters : undefined,
    });
    return NextResponse.json({ ok: true, action });
  } catch (e: any) { return handleErr(e); }
}
