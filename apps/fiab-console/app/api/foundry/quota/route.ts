/**
 * GET  /api/foundry/quota — per-region Cognitive Services usages (quota).
 *   ?location=eastus2 (defaults to the account's region)
 * POST /api/foundry/quota — one-click "deploy gpt-4o-mini" to unblock the
 *   cross-item-copilot AOAI gate. Optional body overrides:
 *   { modelName?, deploymentName?, capacity? }.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  listUsages,
  createModelDeployment,
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
    const location = req.nextUrl.searchParams.get('location') || undefined;
    const { account, location: loc, usages } = await listUsages(location, selectorFromQuery(req));
    return NextResponse.json({ ok: true, account: { name: account.name, location: account.location }, location: loc, usages });
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
    const body = await req.json().catch(() => ({}));
    const modelName = String(body?.modelName || 'gpt-4o-mini');
    const deploymentName = String(body?.deploymentName || modelName);
    const capacity = typeof body?.capacity === 'number' ? body.capacity : 10;
    const deployment = await createModelDeployment({ deploymentName, modelName, skuName: 'GlobalStandard', capacity }, selectorFromBody(body));
    return NextResponse.json({ ok: true, deployment, message: `Deploying ${modelName} as "${deploymentName}". Once provisioned, set LOOM_AOAI_DEPLOYMENT=${deploymentName} (or rely on Foundry connection discovery) to unblock cross-item Copilot.` });
  } catch (e: any) {
    if (e instanceof CsNotConfiguredError) return NextResponse.json({ ok: false, error: e.message, hint: e.hint, notDeployed: true }, { status: 503 });
    const status = e instanceof CsError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e), body: e?.body }, { status });
  }
}
