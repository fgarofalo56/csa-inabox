/**
 * GET  /api/items/copilot-studio-action?envId=&agentId=  — list actions
 * POST /api/items/copilot-studio-action                  — bind (body: { envId, agentId, name, type, connectorId?, flowId?, parameters? })
 */

import { NextRequest, NextResponse } from 'next/server';
import { listActions, bindAction, copilotStudioErrorEnvelope } from '@/lib/azure/copilot-studio-client';
import { withSession } from '@/lib/api/route-toolkit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function handleErr(e: any) {
  const { status, body } = copilotStudioErrorEnvelope(e);
  return NextResponse.json(body, { status });
}

export const GET = withSession(async (req: NextRequest) => {
  const { searchParams } = new URL(req.url);
  const envId = searchParams.get('envId');
  const agentId = searchParams.get('agentId');
  if (!envId || !agentId) return NextResponse.json({ ok: false, error: 'envId and agentId are required' }, { status: 400 });
  try {
    const actions = await listActions(envId, agentId);
    return NextResponse.json({ ok: true, actions });
  } catch (e: any) { return handleErr(e); }
});

export const POST = withSession(async (req: NextRequest) => {
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
});
