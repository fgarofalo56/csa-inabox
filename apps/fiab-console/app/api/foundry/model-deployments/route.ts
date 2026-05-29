/**
 * GET  /api/foundry/model-deployments — list AOAI / AIServices model deployments.
 * POST /api/foundry/model-deployments — deploy a model.
 *   body: { deploymentName, modelName, modelVersion?, skuName?, capacity? }
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  listModelDeployments,
  createModelDeployment,
  CsError,
  CsNotConfiguredError,
} from '@/lib/azure/foundry-cs-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  try {
    const { account, deployments } = await listModelDeployments();
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
    });
    return NextResponse.json({ ok: true, deployment });
  } catch (e: any) {
    if (e instanceof CsNotConfiguredError) return NextResponse.json({ ok: false, error: e.message, hint: e.hint, notDeployed: true }, { status: 503 });
    const status = e instanceof CsError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e), body: e?.body }, { status });
  }
}
