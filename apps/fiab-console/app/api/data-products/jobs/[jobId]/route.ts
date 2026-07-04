/**
 * GET /api/data-products/jobs/[jobId]
 *
 * Returns the current status of a bulk data-product import job from the
 * `dataproduct-jobs` Cosmos container (F18 job monitoring). Polled every 5s by
 * the Import flyout's Monitor tab.
 *
 * Response:
 *   { ok: true, job: DataProductImportJob }
 *   { ok: false, error: 'not found' }   (404 — unknown job or wrong tenant)
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { dataproductJobsContainer, type DataProductImportJob } from '@/lib/azure/cosmos-client';
import { apiServerError } from '@/lib/api/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req: NextRequest, props: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await props.params;
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const tenantId = session.claims.oid;

  const jobs = await dataproductJobsContainer();
  try {
    const { resource } = await jobs.item(jobId, tenantId).read<DataProductImportJob>();
    if (!resource || resource.tenantId !== tenantId) {
      return NextResponse.json({ ok: false, error: 'not found' }, { status: 404 });
    }
    return NextResponse.json({ ok: true, job: resource });
  } catch (e: any) {
    if (e?.code === 404) return NextResponse.json({ ok: false, error: 'not found' }, { status: 404 });
    return apiServerError(e);
  }
}
