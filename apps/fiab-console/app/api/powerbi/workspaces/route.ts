/**
 * GET /api/powerbi/workspaces
 * Returns the Power BI / Fabric workspaces (groups) the Console UAMI can see.
 *
 * If the UAMI's SP is not authorized in the Power BI tenant, returns the
 * underlying 401/403 error verbatim so the editor's workspace picker can
 * surface a clear remediation message.
 */

import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { listWorkspaces, PowerBiError } from '@/lib/azure/powerbi-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  try {
    const workspaces = await listWorkspaces();
    return NextResponse.json({ ok: true, workspaces });
  } catch (e: any) {
    const status = e instanceof PowerBiError ? e.status : 502;
    return NextResponse.json(
      { ok: false, error: e?.message || String(e), endpoint: e?.endpoint, hint: powerBiHint(status) },
      { status },
    );
  }
}

function powerBiHint(status: number): string | undefined {
  if (status === 401 || status === 403) {
    return 'The Console UAMI is not authorized for Power BI. A Power BI admin must (1) enable "Service principals can use Fabric APIs" in the tenant settings and (2) add the UAMI to the workspace as Member or Contributor.';
  }
  return undefined;
}
