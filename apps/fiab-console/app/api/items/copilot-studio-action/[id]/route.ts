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
import { getSession } from '@/lib/auth/session';
import {
  deleteAction,
  updateActionParameters,
  CopilotStudioError,
  type ActionParameter,
} from '@/lib/azure/copilot-studio-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const envId = new URL(req.url).searchParams.get('envId');
  if (!envId) return NextResponse.json({ ok: false, error: 'envId is required' }, { status: 400 });
  try {
    await deleteAction(envId, (await ctx.params).id);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    const status = e instanceof CopilotStudioError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e), body: e?.body, status }, { status });
  }
}

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
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
      (await ctx.params).id,
      body.parameters as ActionParameter[],
    );
    return NextResponse.json({ ok: true, action });
  } catch (e: any) {
    // Same CopilotStudioError -> status shape as DELETE: the honest 422
    // entity-check gate (missing Memo column) propagates to the UI verbatim.
    const status = e instanceof CopilotStudioError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e), body: e?.body, status }, { status });
  }
}
