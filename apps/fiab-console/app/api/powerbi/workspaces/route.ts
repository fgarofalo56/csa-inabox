/**
 * GET /api/powerbi/workspaces
 * Returns the Power BI / Fabric workspaces (groups) visible to the caller.
 *
 * By default Loom calls Power BI as the SIGNED-IN USER (user passthrough / OBO,
 * matching Synapse's Power BI integration) — NOT the Console service principal.
 * So a 401/403 on the default path is a delegated-scope consent gap, not an SP
 * tenant-setting gap; the hint below is passthrough-aware and only names the SP
 * remediation when passthrough has been explicitly disabled.
 */

import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { listWorkspaces, PowerBiError } from '@/lib/azure/powerbi-client';
import { userPassthroughEnabled, PBI_PASSTHROUGH_DELEGATED_SCOPES } from '@/lib/auth/obo';

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
  if (status !== 401 && status !== 403) return undefined;
  if (userPassthroughEnabled()) {
    // Default path: Loom calls Power BI as the signed-in USER, so the fix is
    // delegated-scope admin consent on the Loom app registration — NOT the SP
    // "Service principals can use Fabric APIs" tenant setting and NOT adding a
    // UAMI to the workspace (neither applies to a user-delegated token).
    return (
      'Power BI uses your own identity (user passthrough), so no service-principal ' +
      'tenant setting or workspace-membership change is needed. A tenant admin must ' +
      `grant the Loom app registration the delegated Power BI scopes (${PBI_PASSTHROUGH_DELEGATED_SCOPES.join(', ')}) ` +
      'and grant admin consent (see docs/fiab/v3-tenant-bootstrap.md → Power BI delegated ' +
      'permissions), then sign out and back in.'
    );
  }
  // Passthrough explicitly disabled (LOOM_POWERBI_USER_PASSTHROUGH=false): the
  // call runs as the Console SP, so the SP tenant grant + workspace membership apply.
  return 'The Console UAMI is not authorized for Power BI. A Power BI admin must (1) enable "Service principals can use Fabric APIs" in the tenant settings and (2) add the UAMI to the workspace as Member or Contributor.';
}
