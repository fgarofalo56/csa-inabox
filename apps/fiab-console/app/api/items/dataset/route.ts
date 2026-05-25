/**
 * GET  /api/items/dataset?project=<name> — list data assets (project or hub)
 * POST /api/items/dataset — create asset
 *   body: { name, dataType, dataUri, version?, description?, project? }
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { listDataAssets, createDataAsset, FoundryError, NotDeployedError } from '@/lib/azure/foundry-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function err(e: any) {
  if (e instanceof NotDeployedError) return NextResponse.json({ ok: false, error: e.message, hint: e.hint, notDeployed: true }, { status: 503 });
  const status = e instanceof FoundryError ? e.status : 502;
  return NextResponse.json({ ok: false, error: e?.message || String(e), body: e?.body }, { status });
}

export async function GET(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const project = req.nextUrl.searchParams.get('project') || undefined;
  try {
    const assets = await listDataAssets(project);
    return NextResponse.json({ ok: true, assets, scope: project ? `project:${project}` : 'hub' });
  } catch (e: any) { return err(e); }
}

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  try {
    const body = await req.json();
    if (!body?.name || !body?.dataType || !body?.dataUri) {
      return NextResponse.json({ ok: false, error: 'name, dataType, dataUri required' }, { status: 400 });
    }
    const asset = await createDataAsset(body.name, {
      dataType: body.dataType,
      dataUri: body.dataUri,
      version: body.version,
      description: body.description,
      workspaceName: body.project,
    });
    return NextResponse.json({ ok: true, asset });
  } catch (e: any) { return err(e); }
}
