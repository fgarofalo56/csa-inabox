/**
 * Cloud-flow in-product authoring — real Dataverse `workflow` writes.
 *
 *   GET   /api/items/power-automate-flow/[id]/definition?envId=<env>
 *           → { ok, flow: FlowAuthoringDoc }  (parsed clientdata definition + connectionReferences)
 *   PATCH /api/items/power-automate-flow/[id]/definition?envId=<env>
 *           body { definition?, name?, state?: 'on'|'off' }
 *           → updates the flow definition (clientdata) / name / on-off state
 *   POST  /api/items/power-automate-flow/new/definition?envId=<env>
 *           body { name, definition }
 *           → creates a new modern cloud flow (Draft), returns { ok, workflowId }
 *
 *   id = the Dataverse workflow id (GUID) for an existing flow; "new" for create.
 *
 * Authoring the Logic Apps workflow definition + connection references in-product
 * (no deep link). The visual drag-drop designer can't be embedded (needs a
 * delegated JWT) — that stays an honest "open visual designer" gate in the UI —
 * but the structured definition is authored here against the real Dataverse Web
 * API. Azure-native — no Fabric / Power BI dependency.
 *
 * Honest config gate: writes need the dedicated Dataverse SP
 * (LOOM_DATAVERSE_CLIENT_ID), an Application User with a customizing role.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  getFlowDefinition, createFlow, updateFlowDefinition, setFlowStateViaDataverse,
  dataverseConfigGate, PowerPlatformError,
} from '@/lib/azure/powerplatform-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function err(e: any) {
  const status = e instanceof PowerPlatformError ? e.status : 502;
  return NextResponse.json(
    { ok: false, error: e?.message || String(e), hint: e?.hint, endpoint: e?.endpoint, body: e?.body },
    { status },
  );
}

function gateResponse() {
  const gate = dataverseConfigGate();
  if (!gate) return null;
  return NextResponse.json(
    {
      ok: false, code: 'not_configured',
      error: `Dataverse write not configured — ${gate.missing} is unset.`,
      hint: 'Set LOOM_DATAVERSE_CLIENT_ID / LOOM_DATAVERSE_CLIENT_SECRET / LOOM_DATAVERSE_TENANT_ID and register that SP as a Dataverse Application User with the System Administrator (or System Customizer) role on this environment.',
    },
    { status: 503 },
  );
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const envId = req.nextUrl.searchParams.get('envId');
  if (!envId) return NextResponse.json({ ok: false, error: 'envId query param required' }, { status: 400 });
  const gated = gateResponse();
  if (gated) return gated;
  try {
    const flow = await getFlowDefinition(envId, (await ctx.params).id);
    return NextResponse.json({ ok: true, envId, flow });
  } catch (e: any) { return err(e); }
}

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const envId = req.nextUrl.searchParams.get('envId');
  if (!envId) return NextResponse.json({ ok: false, error: 'envId query param required' }, { status: 400 });
  const gated = gateResponse();
  if (gated) return gated;

  let body: any;
  try { body = await req.json(); } catch { body = null; }
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ ok: false, error: 'JSON body required' }, { status: 400 });
  }
  const id = (await ctx.params).id;
  try {
    if (body.state === 'on' || body.state === 'off') {
      await setFlowStateViaDataverse(envId, id, body.state === 'on');
    }
    if (body.definition || typeof body.name === 'string') {
      await updateFlowDefinition(envId, id, {
        definition: body.definition,
        name: typeof body.name === 'string' ? body.name : undefined,
      });
    }
    return NextResponse.json({ ok: true, envId, workflowId: id });
  } catch (e: any) { return err(e); }
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const envId = req.nextUrl.searchParams.get('envId');
  if (!envId) return NextResponse.json({ ok: false, error: 'envId query param required' }, { status: 400 });
  const gated = gateResponse();
  if (gated) return gated;

  // POST is the create path (id is typically "new"); ignore the route id.
  void ctx;
  let body: any;
  try { body = await req.json(); } catch { body = null; }
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ ok: false, error: 'JSON body required' }, { status: 400 });
  }
  if (!body.name || typeof body.name !== 'string') {
    return NextResponse.json({ ok: false, error: 'name is required' }, { status: 400 });
  }
  if (!body.definition || typeof body.definition !== 'object') {
    return NextResponse.json({ ok: false, error: 'definition is required' }, { status: 400 });
  }
  try {
    const res = await createFlow(envId, { name: body.name, definition: body.definition });
    return NextResponse.json({ ok: true, envId, workflowId: res.workflowId, entityId: res.entityId });
  } catch (e: any) { return err(e); }
}
