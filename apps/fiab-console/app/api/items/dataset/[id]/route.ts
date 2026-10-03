/**
 * GET /api/items/dataset/[id]?project=<name> — asset + versions.
 *
 * Item scope: the caller needs read access to the dataset ITEM `[id]`
 * (`resolveItemAccessByOid`), as on the lakehouse routes; a tenant admin may
 * open a data asset by name. See `../_lib/dataset-item-scope.ts`.
 */
import { NextRequest, NextResponse } from 'next/server';
import { withSession } from '@/lib/api/route-toolkit';
import { isTenantAdmin } from '@/lib/auth/feature-gate';
import { resolveItemAccessByOid } from '@/lib/auth/item-access';
import { datasetItemNotFound } from '../_lib/dataset-item-scope';
import { getDataAsset, FoundryError, NotDeployedError } from '@/lib/azure/foundry-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withSession<{ id: string }>(async (req: NextRequest, { session, params }) => {
  const { id } = params;
  const access = await resolveItemAccessByOid(session, id, 'dataset');
  if (!access && !isTenantAdmin(session)) return datasetItemNotFound();

  const project = req.nextUrl.searchParams.get('project') || undefined;
  try {
    const { container, versions } = await getDataAsset(id, project);
    if (!container) return NextResponse.json({ ok: false, error: 'not found' }, { status: 404 });
    return NextResponse.json({ ok: true, asset: container, versions });
  } catch (e: any) {
    if (e instanceof NotDeployedError) return NextResponse.json({ ok: false, error: e.message, hint: e.hint, notDeployed: true }, { status: 503 });
    const status = e instanceof FoundryError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e), body: e?.body }, { status });
  }
});
