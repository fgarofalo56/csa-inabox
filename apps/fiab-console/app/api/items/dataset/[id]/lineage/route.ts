/**
 * GET /api/items/dataset/[id]/lineage?project=<name> — real producers/consumers
 * of a data asset, derived from AML jobs that reference it (inputs = consumers,
 * outputs = producers). No mock data; empty arrays when nothing references it.
 *
 * Item scope: the caller needs read access to the dataset ITEM `[id]`
 * (`resolveItemAccessByOid`), as on the lakehouse routes; a tenant admin may
 * read an asset's lineage by name. See `../../_lib/dataset-item-scope.ts`.
 */
import { NextRequest, NextResponse } from 'next/server';
import { withSession } from '@/lib/api/route-toolkit';
import { isTenantAdmin } from '@/lib/auth/feature-gate';
import { resolveItemAccessByOid } from '@/lib/auth/item-access';
import { datasetItemNotFound } from '../../_lib/dataset-item-scope';
import { getDataAssetLineage, FoundryError, NotDeployedError } from '@/lib/azure/foundry-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withSession<{ id: string }>(async (req: NextRequest, { session, params }) => {
  const { id } = params;
  const access = await resolveItemAccessByOid(session, id, 'dataset');
  if (!access && !isTenantAdmin(session)) return datasetItemNotFound();

  const project = req.nextUrl.searchParams.get('project') || undefined;
  try {
    const lineage = await getDataAssetLineage(id, project);
    return NextResponse.json({ ok: true, ...lineage });
  } catch (e: any) {
    if (e instanceof NotDeployedError) return NextResponse.json({ ok: false, error: e.message, hint: e.hint, notDeployed: true }, { status: 503 });
    const status = e instanceof FoundryError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
  }
});
