/**
 * DELETE /api/items/copilot-studio-action/[id]?envId=  — unbind an action
 * PATCH  /api/items/copilot-studio-action/[id]?envId=  — update an action's
 *        input/output parameter mapping (the Inputs/Outputs grid). Body:
 *        { envId?, parameters: ActionParameter[] }. `envId` may be supplied
 *        on the query string or in the JSON body. The mapping is persisted to
 *        the action's msdyn_parameterconfiguration Memo column via a real
 *        Dataverse PATCH; a missing column surfaces the client's honest 422
 *        entity-check gate (CopilotStudioError.status) verbatim to the UI.
 */

import { NextRequest, NextResponse } from 'next/server';
import {
  deleteAction,
  updateActionParameters,
  type ActionParameter,
} from '@/lib/azure/copilot-studio-client';
import { copilotStudioErrorEnvelope } from '@/lib/azure/copilot-studio-error';
import { withSession } from '@/lib/api/route-toolkit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const DELETE = withSession<{ id: string }>(async (req: NextRequest, { session, params }) => {
  const envId = new URL(req.url).searchParams.get('envId');
  if (!envId) return NextResponse.json({ ok: false, error: 'envId is required' }, { status: 400 });
  try {
    await deleteAction(envId, params.id);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    const { status, body: envelope } = copilotStudioErrorEnvelope(e);
    return NextResponse.json(envelope, { status });
  }
});

export const PATCH = withSession<{ id: string }>(async (req: NextRequest, { params }) => {
  const body = await req.json().catch(() => ({} as any));
  // envId from the query string or the JSON body (either is accepted).
  const envId = new URL(req.url).searchParams.get('envId') || body?.envId;
  if (!envId) return NextResponse.json({ ok: false, error: 'envId is required' }, { status: 400 });
  // Structured parameter grid only — never a freeform blob. The client maps
  // each row to the action's msdyn_parameterconfiguration Memo JSON.
  if (!Array.isArray(body?.parameters)) {
    return NextResponse.json({ ok: false, error: 'parameters (array) is required' }, { status: 400 });
  }
  try {
    const action = await updateActionParameters(
      String(envId),
      params.id,
      body.parameters as ActionParameter[],
    );
    return NextResponse.json({ ok: true, action });
  } catch (e: any) {
    // Same CopilotStudioError -> status shape as DELETE: the honest 422
    // entity-check gate (missing Memo column) propagates to the UI verbatim.
    const { status, body: envelope } = copilotStudioErrorEnvelope(e);
    return NextResponse.json(envelope, { status });
  }
});
