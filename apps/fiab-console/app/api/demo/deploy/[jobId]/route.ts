/**
 * GET /api/demo/deploy/[jobId] — poll aggregate progress of a demo-environment
 * deploy started via POST /api/demo/deploy. Returns the demo job doc including
 * `subJobs[]` (one per showcase app, each with its own installJobId the caller
 * can drill into via /api/apps/install-jobs/{id}). Owner-scoped by partition key.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { appInstallJobsContainer } from '@/lib/azure/cosmos-client';
import type { AppInstallJob } from '@/lib/azure/cosmos-client';
import { apiServerError } from '@/lib/api/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req: NextRequest, props: { params: Promise<{ jobId: string }> }) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const { jobId } = await props.params;
  try {
    const jobs = await appInstallJobsContainer();
    const { resource } = await jobs.item(jobId, s.claims.oid).read<AppInstallJob>();
    if (!resource || resource.appId !== 'demo-environment') {
      return NextResponse.json({ ok: false, error: 'demo job not found' }, { status: 404 });
    }
    return NextResponse.json({ ok: true, job: resource });
  } catch (e: any) {
    if (e?.code === 404) return NextResponse.json({ ok: false, error: 'demo job not found' }, { status: 404 });
    return apiServerError(e);
  }
}
