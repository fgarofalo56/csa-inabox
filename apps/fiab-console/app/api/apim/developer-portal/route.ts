/**
 * Developer portal for the deployment-default APIM service (the APIM navigator →
 * "Developer portal" tab). Surfaces the portal URLs + publish history and runs
 * the portal's publishing pipeline via real ARM REST on
 * Microsoft.ApiManagement/service/{name}/portalRevisions.
 *
 *   GET  /api/apim/developer-portal  → {
 *     ok, developerPortalUrl, portalUrl, managementApiUrl, developerPortalStatus,
 *     revisions: [{ id, name, isCurrent, status, description, createdDateTime }]
 *   }
 *   POST /api/apim/developer-portal  body { description?, isCurrent? } → publish
 *
 * Publish is an async LRO (ARM 201/202). We don't block on the poll — the
 * revision is created and the client re-lists to show progress/completion.
 *
 * Honest 503 gate when the APIM service is unset (names the missing env var).
 * Real ARM REST. No mocks.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  apimConfigGate, getServiceInfo, listPortalRevisions, publishPortalRevision, ApimError,
} from '@/lib/azure/apim-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function gate() {
  const g = apimConfigGate();
  if (g) {
    return NextResponse.json(
      { ok: false, code: 'not_configured', error: `APIM service not configured: set ${g.missing}.`, missing: g.missing },
      { status: 503 },
    );
  }
  return null;
}

function fail(e: any) {
  const status = e instanceof ApimError ? e.status : 502;
  return NextResponse.json({ ok: false, error: e?.message || String(e), body: e?.body }, { status });
}

export async function GET() {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const g = gate(); if (g) return g;
  try {
    // Fetch service info (for the portal URLs) and the revision history together.
    // Revisions can 404 on a brand-new service that has never published — treat
    // that as an empty list rather than a hard error.
    const svc = await getServiceInfo();
    if (!svc) {
      return NextResponse.json(
        { ok: false, error: 'APIM service not found at the configured scope. Verify LOOM_APIM_NAME / LOOM_APIM_RG / LOOM_APIM_SUB.' },
        { status: 404 },
      );
    }
    let revisions: Awaited<ReturnType<typeof listPortalRevisions>> = [];
    try {
      revisions = await listPortalRevisions();
    } catch (e: any) {
      // A never-published portal returns no revisions; only a real error surfaces.
      if (!(e instanceof ApimError && e.status === 404)) throw e;
    }
    return NextResponse.json({
      ok: true,
      developerPortalUrl: svc.developerPortalUrl,
      portalUrl: svc.portalUrl,
      managementApiUrl: svc.managementApiUrl,
      developerPortalStatus: svc.developerPortalStatus,
      provisioningState: svc.state,
      revisions,
    });
  } catch (e: any) { return fail(e); }
}

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const g = gate(); if (g) return g;
  const body = await req.json().catch(() => ({} as any));
  const description = typeof body?.description === 'string' && body.description.trim() ? body.description.trim() : undefined;
  const isCurrent = body?.isCurrent === false ? false : true;
  try {
    const revision = await publishPortalRevision({ description, isCurrent });
    return NextResponse.json({ ok: true, revision });
  } catch (e: any) { return fail(e); }
}
