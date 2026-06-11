/**
 * GET /api/catalog/metastores
 *   List every back-end the unified catalog federates over:
 *     - unity-catalog: every UC metastore reachable from each registered
 *       Databricks workspace (env hosts UNIONed with the Cosmos-persisted
 *       registrations, so a registration survives a Console reload)
 *     - purview: the Purview account configured for this tenant
 *     - onelake: every Fabric region/capacity the UAMI can see
 *     - registrations: the persisted Databricks workspace registrations
 *       (Cosmos), with UC-attach + Purview source/scan status badges
 *
 * POST /api/catalog/metastores
 *   Body: {
 *     source: 'unity-catalog', hostname,
 *     workspaceNumericId?, metastoreId?, defaultCatalog?,
 *     registerPurview?: bool, runScan?: bool,
 *     purviewCollection?, scan?: { httpPath, credentialName, integrationRuntimeName? }
 *   }
 *   Orchestrates a REAL, PERSISTENT registration:
 *     1. Probe the workspace's UC catalogs (no account-admin needed).
 *     2. Persist the registration to Cosmos (this alone makes it survive reloads).
 *     3. If metastoreId given + account API configured → attach the workspace to
 *        the UC metastore (account-plane PUT). 403 → honest account-admin gate.
 *     4. If registerPurview + LOOM_PURVIEW_ACCOUNT set → register the workspace
 *        as a Purview "Azure Databricks Unity Catalog" source; optionally define
 *        + trigger a scan (gated honestly when no scan credential/IR supplied —
 *        Databricks scans need a PAT-in-Key-Vault credential, MI is unsupported).
 *   Each external step is best-effort: a failure in one folds an honest gate into
 *   the response rather than failing the whole call (the Cosmos persist already
 *   succeeded). No mocks, no placeholders — real Azure REST or honest gate.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  listAllMetastores, listMetastoresFromWorkspace, listWorkspaceHostnames, listCatalogs,
  UnityCatalogNotConfiguredError, UnityCatalogError,
} from '@/lib/azure/unity-catalog-client';
import {
  listAccountMetastores, getWorkspaceMetastoreAssignment, assignMetastore,
  isAccountApiConfigured, UnityCatalogAccountError,
} from '@/lib/azure/unity-catalog-account-client';
import { listOneLakeWorkspaces } from '@/lib/azure/onelake-catalog-client';
import { listDatabricksWorkspaces } from '@/lib/azure/databricks-discovery';
import { metastoreRegistrationsContainer, type MetastoreRegistration } from '@/lib/azure/cosmos-client';
import {
  registerDatabricksUnityCatalogSource, defineDatabricksUnityCatalogScan, triggerScanRun,
  PurviewNotConfiguredError, PurviewError,
} from '@/lib/azure/purview-client';

/** Detect the "calling identity is not a Databricks account admin" 403 that
 *  the UC account/metastore API returns. Databricks phrases this a few ways
 *  ("not an account admin", "User is not an account admin for Account"). */
function isAccountAdmin403(status?: number, message?: string): boolean {
  if (status !== 403) return false;
  const m = (message || '').toLowerCase();
  return m.includes('account admin') || m.includes('account-admin');
}

const ACCOUNT_ADMIN_GATE = {
  title: 'Unity Catalog not enabled / metastore not listable',
  detail:
    'Listing Unity Catalog metastores needs the workspace to be attached to a UC metastore AND the caller to be a ' +
    'Databricks account/metastore admin. If the catalog is empty, the workspace likely has no UC metastore yet — ' +
    'a Databricks ACCOUNT ADMIN must create one (once per region) and assign it to the workspace. ' +
    'Selecting a workspace below still lists its UC catalogs directly (no account-admin needed) once UC is enabled.',
  remediation: {
    role: 'Databricks "Account Admin" (to enable UC) → then "Metastore Admin" for the Loom UAMI (least-privilege)',
    identity: 'The Console UAMI named by LOOM_UAMI_CLIENT_ID',
    where: 'Databricks ACCOUNT console (accounts.azuredatabricks.net) → Catalog → Create metastore + Assign to workspace; then run scripts/csa-loom/add-loom-uami-to-uc-metastore-admin.sh',
    docs: 'docs/fiab/catalog/metastores.md#enabling-unity-catalog-on-a-loom-databricks-workspace-one-time-account-admin',
  },
};

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function normalizeHost(h: string): string {
  return String(h).replace(/^https?:\/\//, '').replace(/\/$/, '');
}

/** Best-effort read of every persisted registration for a tenant. */
async function listRegistrations(tenantId: string): Promise<MetastoreRegistration[]> {
  try {
    const c = await metastoreRegistrationsContainer();
    const { resources } = await c.items
      .query<MetastoreRegistration>({
        query: 'SELECT * FROM c WHERE c.tenantId = @t',
        parameters: [{ name: '@t', value: tenantId }],
      })
      .fetchAll();
    return resources;
  } catch {
    return [];
  }
}

export async function GET() {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const tenantId = s.claims.oid;

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
    result.unityHosts = safeEnvHosts();
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

  // Persisted registrations (Cosmos) — what makes registration survive reloads.
  result.registrations = await listRegistrations(tenantId);

  // Account metastores (for the attach picker). Soft-fail with an honest gate
  // when the account API isn't configured or the UAMI isn't an account admin.
  result.accountApiConfigured = isAccountApiConfigured();
  if (result.accountApiConfigured) {
    try {
      result.accountMetastores = await listAccountMetastores();
    } catch (e: any) {
      result.accountMetastores = [];
      if (e instanceof UnityCatalogAccountError && e.accountAdmin) {
        result.accountAdminGate = result.accountAdminGate || ACCOUNT_ADMIN_GATE;
      } else {
        result.accountMetastoresError = e?.message || String(e);
      }
    }
  } else {
    result.accountMetastores = [];
    result.accountApiHint = {
      missingEnvVar: 'LOOM_DATABRICKS_ACCOUNT_ID',
      detail:
        'Set LOOM_DATABRICKS_ACCOUNT_ID (the Databricks account GUID) on the Console Container App to enable one-click ' +
        'metastore attach. Registration + catalog listing work without it.',
      bicepModule: 'platform/fiab/bicep/modules/admin-plane/main.bicep (apps[].env)',
    };
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
    const shortName = account.replace(/^https?:\/\//, '').replace(/-api\.purview\.azure\.com.*$/, '').replace(/\.purview\.azure\.com.*$/, '');
    result.purview = { account: shortName, endpoint: `https://${shortName}.purview.azure.com`, configured: true };
  } else {
    result.purview = null;
    result.purviewError = 'LOOM_PURVIEW_ACCOUNT not configured';
  }

  return NextResponse.json(result);
}

/** Env-only hostnames without throwing the NotConfigured gate (for display). */
function safeEnvHosts(): string[] {
  try { return listWorkspaceHostnames(); } catch { return []; }
}

export async function POST(req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const tenantId = s.claims.oid;
  const who = s.claims.upn || s.claims.email || s.claims.oid;

  let body: any = {};
  try { body = await req.json(); } catch { /* allow empty */ }
  if (body.source !== 'unity-catalog' || !body.hostname) {
    return NextResponse.json({ ok: false, error: 'source=unity-catalog and hostname required' }, { status: 400 });
  }
  const host = normalizeHost(body.hostname);
  const workspaceNumericId: string | undefined = body.workspaceNumericId ? String(body.workspaceNumericId) : undefined;
  const workspaceName: string | undefined = body.workspaceName;
  const workspaceArmId: string | undefined = body.workspaceArmId;
  const metastoreId: string | undefined = body.metastoreId;
  const defaultCatalog: string = body.defaultCatalog || 'main';
  const registerPurview: boolean = !!body.registerPurview;
  const runScan: boolean = !!body.runScan;
  const purviewCollection: string | undefined = body.purviewCollection;
  const scanCfg = body.scan as { httpPath?: string; credentialName?: string; integrationRuntimeName?: string } | undefined;

  // ---- Step 1: probe the workspace's UC catalogs (no account-admin needed) ----
  // A catalogs 401/403 means the workspace is unreachable for this identity —
  // a hard failure worth returning with the upstream code (we don't persist a
  // registration we can't even read).
  let catalogs: Awaited<ReturnType<typeof listCatalogs>> = [];
  try {
    catalogs = await listCatalogs(host);
  } catch (e: any) {
    const status = e instanceof UnityCatalogError ? e.status : 500;
    return NextResponse.json({
      ok: false,
      probed: host,
      error: e?.message || String(e),
      ...(isAccountAdmin403(status, e?.message) ? { accountAdminGate: ACCOUNT_ADMIN_GATE } : {}),
    }, { status });
  }

  // ---- Step 2: persist the registration to Cosmos (survives reloads) ----
  const now = new Date().toISOString();
  let registration: MetastoreRegistration;
  let persisted = false;
  try {
    const c = await metastoreRegistrationsContainer();
    let existing: MetastoreRegistration | undefined;
    try {
      const r = await c.item(host, tenantId).read<MetastoreRegistration>();
      existing = r.resource || undefined;
    } catch { /* not found */ }
    registration = {
      id: host,
      tenantId,
      workspaceUrl: host,
      workspaceName: workspaceName ?? existing?.workspaceName,
      workspaceArmId: workspaceArmId ?? existing?.workspaceArmId,
      workspaceNumericId: workspaceNumericId ?? existing?.workspaceNumericId,
      metastoreId: existing?.metastoreId,
      defaultCatalog: existing?.defaultCatalog,
      ucAttached: existing?.ucAttached ?? false,
      purviewSourceName: existing?.purviewSourceName,
      purviewScanName: existing?.purviewScanName,
      lastScanRunId: existing?.lastScanRunId,
      purviewRegistered: existing?.purviewRegistered ?? false,
      purviewScanned: existing?.purviewScanned ?? false,
      registeredAt: existing?.registeredAt ?? now,
      registeredBy: existing?.registeredBy ?? who,
      updatedAt: now,
    };
    await c.items.upsert(registration);
    persisted = true;
  } catch (e: any) {
    // If we can't even persist, the core acceptance ("survives reloads") fails —
    // surface it but still return the catalogs we already read.
    return NextResponse.json({
      ok: false,
      probed: host,
      catalogs,
      error: `Failed to persist registration: ${e?.message || String(e)}`,
    }, { status: 500 });
  }

  const steps: Record<string, unknown> = {};
  let accountAdminGate: typeof ACCOUNT_ADMIN_GATE | undefined;

  // Also surface the workspace's currently-assigned metastore (read-only probe).
  try {
    const metastores = await listMetastoresFromWorkspace(host);
    steps.workspaceMetastores = metastores;
  } catch (e: any) {
    if (isAccountAdmin403(e instanceof UnityCatalogError ? e.status : undefined, e?.message)) {
      accountAdminGate = ACCOUNT_ADMIN_GATE;
    }
  }

  // ---- Step 3: attach to a UC metastore (account-plane) when requested ----
  if (metastoreId) {
    if (!isAccountApiConfigured()) {
      steps.attach = {
        ok: false,
        gate: accountApiGate(),
      };
    } else if (!workspaceNumericId) {
      steps.attach = {
        ok: false,
        error:
          'Numeric Databricks workspace id is required to attach a metastore. Pick the workspace from the discovered ' +
          'list (it carries the id) rather than typing the hostname manually.',
      };
    } else {
      try {
        const assignment = await assignMetastore(workspaceNumericId, metastoreId, defaultCatalog);
        registration.metastoreId = metastoreId;
        registration.defaultCatalog = defaultCatalog;
        registration.ucAttached = true;
        steps.attach = { ok: true, assignment };
      } catch (e: any) {
        if (e instanceof UnityCatalogAccountError && e.accountAdmin) {
          accountAdminGate = ACCOUNT_ADMIN_GATE;
          steps.attach = { ok: false, accountAdminGate: ACCOUNT_ADMIN_GATE };
        } else {
          steps.attach = { ok: false, error: e?.message || String(e) };
        }
      }
    }
  } else {
    // No metastoreId passed — surface whatever the workspace is already attached
    // to, best-effort, so the UI can reflect current state.
    try {
      const current = await getWorkspaceMetastoreAssignment(workspaceNumericId || '0');
      if (current?.metastore_id) {
        registration.metastoreId = registration.metastoreId || current.metastore_id;
        registration.ucAttached = true;
        steps.currentAssignment = current;
      }
    } catch { /* best-effort */ }
  }

  // ---- Step 4: register as a Purview source + optionally scan ----
  if (registerPurview) {
    if (!process.env.LOOM_PURVIEW_ACCOUNT) {
      steps.purview = {
        ok: false,
        gate: {
          title: 'Purview not configured',
          detail: 'Set LOOM_PURVIEW_ACCOUNT on the Console Container App to register this workspace as a Purview Data Map source.',
          envVar: 'LOOM_PURVIEW_ACCOUNT',
          bicepModule: 'platform/fiab/bicep/modules/admin-plane/catalog.bicep',
        },
      };
    } else if (!registration.metastoreId) {
      steps.purview = {
        ok: false,
        error: 'A UC metastore id is required to register the Azure Databricks Unity Catalog source in Purview. Attach a metastore first (or select one above).',
      };
    } else {
      const sourceName = `adbuc-${host.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 50)}`;
      try {
        const ds = await registerDatabricksUnityCatalogSource({
          name: sourceName,
          metastoreId: registration.metastoreId,
          collectionName: purviewCollection,
        });
        registration.purviewSourceName = sourceName;
        registration.purviewRegistered = true;
        const purviewStep: Record<string, unknown> = { ok: true, source: ds };

        // Scan define + trigger — only when the operator supplied the scan
        // config (HTTP path + Key-Vault Access-Token credential). Otherwise an
        // honest gate (MI is unsupported for Databricks scans).
        if (runScan) {
          if (!scanCfg?.httpPath || !scanCfg?.credentialName) {
            purviewStep.scanGate = {
              title: 'Scan needs a Databricks credential + SQL Warehouse HTTP path',
              detail:
                'Microsoft Purview scans of Azure Databricks Unity Catalog require an Access Token stored in Key Vault ' +
                '(managed identity is NOT supported for Databricks) plus a running SQL Warehouse and its HTTP path. ' +
                'Provide a Purview credential name + HTTP path to define and run the scan.',
              docs: 'https://learn.microsoft.com/purview/register-scan-azure-databricks-unity-catalog#scan',
            };
          } else {
            const scanName = `${sourceName}-scan`;
            try {
              const scan = await defineDatabricksUnityCatalogScan(sourceName, scanName, {
                workspaceUrl: `https://${host}`,
                httpPath: scanCfg.httpPath,
                credentialName: scanCfg.credentialName,
                integrationRuntimeName: scanCfg.integrationRuntimeName,
                collectionName: purviewCollection,
              });
              registration.purviewScanName = scanName;
              const run = await triggerScanRun(sourceName, scanName);
              registration.lastScanRunId = run.runId;
              registration.purviewScanned = true;
              purviewStep.scan = { ok: true, scan, runId: run.runId };
            } catch (e: any) {
              purviewStep.scan = { ok: false, error: e?.message || String(e) };
            }
          }
        }
        steps.purview = purviewStep;
      } catch (e: any) {
        if (e instanceof PurviewNotConfiguredError) {
          steps.purview = { ok: false, gate: e.hint };
        } else if (e instanceof PurviewError) {
          steps.purview = { ok: false, error: e.message, status: e.status };
        } else {
          steps.purview = { ok: false, error: e?.message || String(e) };
        }
      }
    }
  }

  // Re-persist the updated registration so the attach/Purview status sticks.
  if (persisted) {
    try {
      registration.updatedAt = new Date().toISOString();
      const c = await metastoreRegistrationsContainer();
      await c.items.upsert(registration);
    } catch { /* best-effort — the initial persist already succeeded */ }
  }

  return NextResponse.json({
    ok: true,
    probed: host,
    persisted,
    registration,
    catalogs,
    steps,
    ...(accountAdminGate ? { accountAdminGate } : {}),
  });
}

/** Build the account-API not-configured hint without constructing the error
 *  (the constructor needs a hint object). Kept inline so the route stays one
 *  file; mirrors UnityCatalogAccountNotConfiguredError.hint. */
function accountApiGate() {
  return {
    missingEnvVar: 'LOOM_DATABRICKS_ACCOUNT_ID',
    detail:
      'Metastore attach is an account-level operation. Set LOOM_DATABRICKS_ACCOUNT_ID (the Databricks account GUID) ' +
      'on the Console Container App and make the Loom UAMI a Databricks account admin. The registration still persists ' +
      'and lists catalogs without it — only the one-click attach is unavailable.',
    bicepModule: 'platform/fiab/bicep/modules/admin-plane/main.bicep (apps[].env)',
  };
}
