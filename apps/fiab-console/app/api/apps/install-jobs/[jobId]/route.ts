/**
 * GET /api/apps/install-jobs/[jobId]
 *
 * Returns the current status of an async app-install job from the
 * `app-install-jobs` Cosmos container (task-019). Polled every 5s by the
 * InstallAppDialog while an install is provisioning, so a long provision shows
 * live phase + percentComplete + (on completion) the full ProvisionReport
 * instead of blocking the install POST until the gateway 504s.
 *
 * Response:
 *   { ok: true, job: AppInstallJob }
 *   { ok: false, error: 'not found' }   (404 — unknown job or wrong tenant)
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { appInstallJobsContainer, type AppInstallJob } from '@/lib/azure/cosmos-client';
import { apiServerError } from '@/lib/api/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req: NextRequest, props: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await props.params;
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const tenantId = session.claims.oid;

  const jobs = await appInstallJobsContainer();
  try {
    const { resource } = await jobs.item(jobId, tenantId).read<AppInstallJob>();
    if (!resource || resource.tenantId !== tenantId) {
      return NextResponse.json({ ok: false, error: 'not found' }, { status: 404 });
    }
    return NextResponse.json({ ok: true, job: resource });
  } catch (e: any) {
    if (e?.code === 404) return NextResponse.json({ ok: false, error: 'not found' }, { status: 404 });
    return apiServerError(e);
  }
}
