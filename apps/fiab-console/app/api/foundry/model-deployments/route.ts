/**
 * GET    /api/foundry/model-deployments — list AOAI / AIServices model deployments.
 * POST   /api/foundry/model-deployments — deploy a model.
 *   body: { deploymentName, modelName, modelVersion?, skuName?, capacity? }
 * DELETE /api/foundry/model-deployments?name=<deployment>[&account=&rg=] — delete a deployment.
 *
 * Real ARM (Microsoft.CognitiveServices/accounts/{acct}/deployments, 2024-10-01):
 *   list   = GET    .../deployments
 *   create = PUT    .../deployments/{name}   (sku.capacity + properties.model{format,name,version})
 *   delete = DELETE .../deployments/{name}
 * Account is selected by the AI Foundry account picker (?account=&rg= or body).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  listModelDeployments,
  createModelDeployment,
  deleteModelDeployment,
  CsError,
  CsNotConfiguredError,
} from '@/lib/azure/foundry-cs-client';
import { selectorFromQuery, selectorFromBody } from '../_selector';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  try {
    const { account, deployments } = await listModelDeployments(selectorFromQuery(req));
    return NextResponse.json({ ok: true, account: { name: account.name, location: account.location, kind: account.kind, endpoint: account.endpoint }, deployments });
  } catch (e: any) {
    if (e instanceof CsNotConfiguredError) return NextResponse.json({ ok: false, error: e.message, hint: e.hint, notDeployed: true }, { status: 503 });
    const status = e instanceof CsError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e), body: e?.body }, { status });
  }
}

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  try {
    const body = await req.json();
    if (!body?.modelName) return NextResponse.json({ ok: false, error: 'modelName required' }, { status: 400 });
    const deploymentName = String(body.deploymentName || body.modelName).trim();
    if (!deploymentName) return NextResponse.json({ ok: false, error: 'deploymentName required' }, { status: 400 });
    const deployment = await createModelDeployment({
      deploymentName,
      modelName: String(body.modelName),
      modelFormat: body.modelFormat ? String(body.modelFormat) : undefined,
      modelVersion: body.modelVersion ? String(body.modelVersion) : undefined,
      skuName: body.skuName ? String(body.skuName) : undefined,
      capacity: typeof body.capacity === 'number' ? body.capacity : undefined,
      raiPolicyName: body.raiPolicyName ? String(body.raiPolicyName) : undefined,
    }, selectorFromBody(body));
    return NextResponse.json({ ok: true, deployment });
  } catch (e: any) {
    if (e instanceof CsNotConfiguredError) return NextResponse.json({ ok: false, error: e.message, hint: e.hint, notDeployed: true }, { status: 503 });
    const status = e instanceof CsError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e), body: e?.body }, { status });
  }
}

export async function DELETE(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  try {
    const name = req.nextUrl.searchParams.get('name')?.trim();
    if (!name) return NextResponse.json({ ok: false, error: 'name required' }, { status: 400 });
    await deleteModelDeployment(name, selectorFromQuery(req));
    return NextResponse.json({ ok: true, deleted: name });
  } catch (e: any) {
    if (e instanceof CsNotConfiguredError) return NextResponse.json({ ok: false, error: e.message, hint: e.hint, notDeployed: true }, { status: 503 });
    const status = e instanceof CsError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e), body: e?.body }, { status });
  }
}
