/**
 * GET /api/catalog/metastores
 *   List every back-end the unified catalog federates over:
 *     - unity-catalog: every UC metastore reachable from each registered
 *       Databricks workspace
 *     - purview: the Purview account configured for this tenant
 *     - onelake: every Fabric region/capacity the UAMI can see (we surface
 *       the workspaces as logical "metastores")
 *
 *   Returns { ok, unity: UCMetastore[], purview: {...}, onelake: OneLakeWorkspace[] }
 *
 * POST /api/catalog/metastores
 *   Body: { source: 'unity-catalog', hostname: string }
 *   Appends a new Databricks workspace hostname to the in-memory federation
 *   list and probes its UC metastore. Returns 501 with bicep hint —
 *   permanent registration requires updating LOOM_DATABRICKS_HOSTNAMES on
 *   the Container App (bicep flip). The probe lets the admin pre-validate
 *   that the metastore admin group includes the Loom UAMI.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  listAllMetastores, listMetastoresFromWorkspace, listWorkspaceHostnames,
  UnityCatalogNotConfiguredError, UnityCatalogError,
} from '@/lib/azure/unity-catalog-client';
import { listOneLakeWorkspaces } from '@/lib/azure/onelake-catalog-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const result: any = { ok: true };

  // Unity
  try {
    result.unity = await listAllMetastores();
    result.unityHosts = listWorkspaceHostnames();
  } catch (e: any) {
    result.unity = [];
    result.unityError = e?.message || String(e);
    if (e instanceof UnityCatalogNotConfiguredError) result.unityHint = e.hint;
  }

  // OneLake
  try {
    result.onelake = await listOneLakeWorkspaces();
  } catch (e: any) {
    result.onelake = [];
    result.onelakeError = e?.message || String(e);
  }

  // Purview — surface the configured account env var if present.
  const account = process.env.LOOM_PURVIEW_ACCOUNT;
  if (account) {
    result.purview = { account, endpoint: `https://${account.replace(/^https?:\/\//, '').replace(/-api\.purview\.azure\.com.*$/, '')}-api.purview.azure.com` };
  } else {
    result.purview = null;
    result.purviewError = 'LOOM_PURVIEW_ACCOUNT not configured';
  }

  return NextResponse.json(result);
}

export async function POST(req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  let body: any = {};
  try { body = await req.json(); } catch { /* allow empty */ }
  if (body.source !== 'unity-catalog' || !body.hostname) {
    return NextResponse.json({ ok: false, error: 'source=unity-catalog and hostname required' }, { status: 400 });
  }
  const host = String(body.hostname).replace(/^https?:\/\//, '').replace(/\/$/, '');
  try {
    const metas = await listMetastoresFromWorkspace(host);
    return NextResponse.json({
      ok: true,
      probed: host,
      metastores: metas,
      // Persistent registration still requires a bicep flip — surface that as a hint.
      followUp: {
        action: 'Update LOOM_DATABRICKS_HOSTNAMES env on the Console Container App to include this hostname for permanent registration.',
        bicepModule: 'platform/fiab/bicep/modules/admin-plane/app-deployments.bicep (apps[].env block)',
      },
    });
  } catch (e: any) {
    const status = e instanceof UnityCatalogError ? e.status : 500;
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
  }
}
