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
  listAllMetastores, listMetastoresFromWorkspace, listWorkspaceHostnames, listCatalogs,
  UnityCatalogNotConfiguredError, UnityCatalogError,
} from '@/lib/azure/unity-catalog-client';
import { listOneLakeWorkspaces } from '@/lib/azure/onelake-catalog-client';
import { listDatabricksWorkspaces } from '@/lib/azure/databricks-discovery';

/** Detect the "calling identity is not a Databricks account admin" 403 that
 *  the UC account/metastore API returns. Databricks phrases this a few ways
 *  ("not an account admin", "User is not an account admin for Account"). */
function isAccountAdmin403(status?: number, message?: string): boolean {
  if (status !== 403) return false;
  const m = (message || '').toLowerCase();
  return m.includes('account admin') || m.includes('account-admin');
}

const ACCOUNT_ADMIN_GATE = {
  title: 'Databricks account-admin role required to list metastores',
  detail:
    'Listing Unity Catalog metastores needs the calling identity to be a Databricks account admin. ' +
    'Grant the Console UAMI (LOOM_UAMI_CLIENT_ID) the Account Admin role in the Databricks account console, ' +
    'OR register the workspace metastore manually below — selecting a workspace lists its UC catalogs directly, ' +
    'which does not require account-admin.',
  remediation: {
    role: 'Databricks "Account Admin"',
    identity: 'The Console UAMI named by LOOM_UAMI_CLIENT_ID',
    where: 'Databricks account console → User management → Service principals → (UAMI) → Roles → Account admin',
  },
};

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const result: any = { ok: true };

  // Unity — federated metastore list. listAllMetastores() folds per-workspace
  // failures into synthetic `ERROR_<host>` rows so one bad workspace doesn't
  // 500 the whole call. We split those out here: account-admin 403s become an
  // honest gate, other per-workspace errors become a `unityWorkspaceErrors`
  // list, and only real metastores stay in `result.unity`.
  try {
    const metas = await listAllMetastores();
    const real: typeof metas = [];
    const workspaceErrors: Array<{ workspace_hostname: string; message: string; accountAdmin: boolean }> = [];
    let accountAdminGate = false;
    for (const m of metas) {
      if (m.metastore_id.startsWith('ERROR_')) {
        // name looks like "(workspace <host> unreachable: <status> <message>)"
        const adminLike = /account.?admin/i.test(m.name);
        if (adminLike) accountAdminGate = true;
        workspaceErrors.push({
          workspace_hostname: m.workspace_hostname,
          message: m.name,
          accountAdmin: adminLike,
        });
      } else {
        real.push(m);
      }
    }
    result.unity = real;
    result.unityHosts = listWorkspaceHostnames();
    if (workspaceErrors.length) result.unityWorkspaceErrors = workspaceErrors;
    if (accountAdminGate) result.accountAdminGate = ACCOUNT_ADMIN_GATE;
  } catch (e: any) {
    result.unity = [];
    if (isAccountAdmin403(e?.status, e?.message)) {
      result.accountAdminGate = ACCOUNT_ADMIN_GATE;
    } else {
      result.unityError = e?.message || String(e);
      if (e instanceof UnityCatalogNotConfiguredError) result.unityHint = e.hint;
    }
  }

  // Discoverable Databricks workspaces (ARM) — powers the registration
  // dropdown. Soft-fail: if the identity can't read ARM we simply omit the
  // list and the UI falls back to manual hostname entry.
  try {
    result.discoverableWorkspaces = await listDatabricksWorkspaces();
  } catch (e: any) {
    result.discoverableWorkspaces = [];
    result.discoveryError = e?.message || String(e);
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
    // CLASSIC Data Map host — {account}.purview.azure.com (NOT -api).
    const shortName = account.replace(/^https?:\/\//, '').replace(/-api\.purview\.azure\.com.*$/, '').replace(/\.purview\.azure\.com.*$/, '');
    result.purview = { account: shortName, endpoint: `https://${shortName}.purview.azure.com` };
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

  // Listing this workspace's UC CATALOGS is the operation that actually
  // works without account-admin — so we lead with it. The metastore list is
  // attempted too, but a 403 there only means "not account admin", not that
  // the workspace is unreachable; we surface that as an honest gate while
  // still returning the catalogs.
  const followUp = {
    action: 'Update LOOM_DATABRICKS_HOSTNAMES env on the Console Container App to include this hostname for permanent registration.',
    bicepModule: 'platform/fiab/bicep/modules/admin-plane/app-deployments.bicep (apps[].env block)',
  };

  let catalogs: Awaited<ReturnType<typeof listCatalogs>> = [];
  let catalogsError: string | undefined;
  try {
    catalogs = await listCatalogs(host);
  } catch (e: any) {
    // A catalogs 403/401 means the workspace itself is unreachable for this
    // identity — that's a hard failure worth returning with the upstream code.
    const status = e instanceof UnityCatalogError ? e.status : 500;
    return NextResponse.json({
      ok: false,
      probed: host,
      error: e?.message || String(e),
      ...(isAccountAdmin403(status, e?.message) ? { accountAdminGate: ACCOUNT_ADMIN_GATE } : {}),
    }, { status });
  }

  let metastores: Awaited<ReturnType<typeof listMetastoresFromWorkspace>> = [];
  let accountAdminGate: typeof ACCOUNT_ADMIN_GATE | undefined;
  try {
    metastores = await listMetastoresFromWorkspace(host);
  } catch (e: any) {
    const status = e instanceof UnityCatalogError ? e.status : 500;
    if (isAccountAdmin403(status, e?.message)) {
      accountAdminGate = ACCOUNT_ADMIN_GATE;
    } else {
      // Non-403 metastore failure: still return the catalogs we got, but note it.
      catalogsError = e?.message || String(e);
    }
  }

  return NextResponse.json({
    ok: true,
    probed: host,
    catalogs,
    metastores,
    ...(catalogsError ? { metastoreError: catalogsError } : {}),
    ...(accountAdminGate ? { accountAdminGate } : {}),
    followUp,
  });
}
