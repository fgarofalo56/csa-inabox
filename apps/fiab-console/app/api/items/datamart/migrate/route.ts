/**
 * POST /api/items/datamart/migrate
 *
 * Migrates a (deprecated) datamart Cosmos item to its Azure-native equivalent:
 *   1. Synapse Serverless user database — `CREATE DATABASE [loom_dm_<name>]`
 *      via TDS + AAD on the env-bound Serverless endpoint (LOOM_SYNAPSE_WORKSPACE).
 *   2. Azure Analysis Services server  — ARM REST PUT (Microsoft.AnalysisServices/servers)
 *      using the Console UAMI credential.
 *
 * On success it stamps `state.migration` on the source item so the editor
 * surfaces the receipt and the item is visibly deprecated/migrated. The call is
 * idempotent: a CREATE DATABASE guarded by `IF NOT EXISTS`, an ARM PUT (no-op
 * when the server exists), and a short-circuit when `state.migration.status`
 * is already 'migrated'.
 *
 * Body: { datamartId: string }
 * Response: { ok, synapseDatabase, serverlessEndpoint, aasServer,
 *             aasConnectionUri, aasProvisioningState, migratedAt }
 *
 * Auth: session required. Caller's upn logged in the receipt.
 *
 * Cloud-matrix (all endpoints resolved by cloud-endpoints.ts — no literals):
 *   Commercial / GCC — ARM management.azure.com,        AAS asazure.windows.net
 *   GCC-High / IL5   — ARM management.usgovcloudapi.net, AAS asazure.usgovcloudapi.net
 *   DoD              — ARM (Gov host),                   AAS asazure.usgovcloudapi.net
 *
 * No Fabric / Power BI dependency — works with LOOM_DEFAULT_FABRIC_WORKSPACE unset.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { loadOwnedItem, updateOwnedItem } from '@/app/api/items/_lib/item-crud';
import { executeQuery, serverlessTarget, serverlessEndpoint } from '@/lib/azure/synapse-sql-client';
import {
  provisionAasServer,
  getAasServer,
  AasNotConfiguredError,
  AasClientError,
} from '@/lib/azure/aas-client';
import { sanitizeAasName, sanitizeDbName } from '@/lib/azure/aas-naming';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const datamartId = (body?.datamartId || '').toString().trim();
  if (!datamartId) {
    return NextResponse.json({ ok: false, error: 'datamartId is required' }, { status: 400 });
  }

  // Load + verify the source item is a 'datamart' owned by this tenant.
  const item = await loadOwnedItem(datamartId, 'datamart', session.claims.oid);
  if (!item) {
    return NextResponse.json(
      { ok: false, error: 'datamart not found or not owned by this tenant' },
      { status: 404 },
    );
  }

  // Idempotency: if already migrated, return the existing receipt.
  const existingMigration = (item.state as any)?.migration;
  if (existingMigration?.status === 'migrated') {
    return NextResponse.json({ ok: true, ...existingMigration, idempotent: true });
  }

  const displayName = item.displayName;
  const synapseDatabase = sanitizeDbName(displayName);
  let aasServerName: string;
  try {
    aasServerName = sanitizeAasName(displayName);
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: e?.message || 'Invalid datamart name for AAS' },
      { status: 400 },
    );
  }

  // ── Step 1: Synapse Serverless DB ──────────────────────────────────────────
  // CREATE DATABASE must run against 'master' (the only DB that allows it in
  // Serverless) and is guarded by IF NOT EXISTS for idempotency.
  let serverlessFqdn: string;
  try {
    serverlessFqdn = serverlessEndpoint();
  } catch (e: any) {
    // LOOM_SYNAPSE_WORKSPACE unset — honest infra gate (no Fabric requirement).
    return NextResponse.json(
      {
        ok: false,
        error:
          `Synapse Serverless not configured: ${e?.message || String(e)}. ` +
          'Set LOOM_SYNAPSE_WORKSPACE to the Loom Synapse workspace name.',
        code: 'SYNAPSE_NOT_CONFIGURED',
      },
      { status: 503 },
    );
  }
  const createDbSql = `
IF NOT EXISTS (SELECT 1 FROM sys.databases WHERE name = N'${synapseDatabase.replace(/'/g, "''")}')
  CREATE DATABASE [${synapseDatabase}];
`.trim();
  try {
    await executeQuery(serverlessTarget('master'), createDbSql, 120_000);
  } catch (e: any) {
    return NextResponse.json(
      {
        ok: false,
        error: `Synapse Serverless DB creation failed: ${e?.message || String(e)}`,
        code: 'SYNAPSE_DB_ERROR',
      },
      { status: 502 },
    );
  }

  // ── Step 2: AAS server (ARM PUT) ───────────────────────────────────────────
  // AAS admin SP identifier format: `app:<applicationId>@<tenantId>`. The UAMI
  // clientId IS its application id; tenant comes from env (no `tid` claim).
  const appId =
    process.env.LOOM_UAMI_APP_ID || process.env.LOOM_UAMI_CLIENT_ID || process.env.AZURE_CLIENT_ID || '';
  const tenantId = process.env.LOOM_ENTRA_TENANT_ID || process.env.AZURE_TENANT_ID || '';
  const adminSpIdentifier = appId && tenantId ? `app:${appId}@${tenantId}` : '';

  let aasServer: { name: string; connectionUri: string; aasProvisioningState: string };
  try {
    const existing = await getAasServer(aasServerName);
    if (existing) {
      aasServer = {
        name: existing.name,
        connectionUri: existing.connectionUri,
        aasProvisioningState: existing.provisioningState,
      };
    } else {
      const provisioned = await provisionAasServer({
        serverName: aasServerName,
        // ARM requires ≥1 admin member; when env is incomplete we still pass a
        // best-effort SP identifier so the control-plane PUT succeeds, and we
        // surface a warning in the receipt (data-plane model deploy needs XMLA).
        adminSpIdentifier: adminSpIdentifier || `app:${appId || 'unknown'}@${tenantId || 'unknown'}`,
      });
      aasServer = {
        name: provisioned.name,
        connectionUri: provisioned.connectionUri,
        aasProvisioningState: provisioned.provisioningState,
      };
    }
  } catch (e: any) {
    if (e instanceof AasNotConfiguredError) {
      return NextResponse.json(
        {
          ok: false,
          error: `${e.message}. Set LOOM_SUBSCRIPTION_ID + LOOM_AAS_RG (or LOOM_DLZ_RG) to enable AAS provisioning.`,
          code: 'AAS_NOT_CONFIGURED',
        },
        { status: 503 },
      );
    }
    if (e instanceof AasClientError) {
      return NextResponse.json(
        { ok: false, error: `AAS provisioning failed: ${e.message}`, code: 'AAS_PROVISION_ERROR' },
        { status: 502 },
      );
    }
    return NextResponse.json({ ok: false, error: String(e?.message || e) }, { status: 502 });
  }

  // ── Step 3: Stamp migration receipt on the Cosmos item ─────────────────────
  const migratedAt = new Date().toISOString();
  const migration = {
    status: 'migrated' as const,
    migratedAt,
    migratedBy: session.claims.upn || session.claims.email || session.claims.oid,
    synapseDatabase,
    serverlessEndpoint: serverlessFqdn,
    aasServer: aasServer.name,
    aasConnectionUri: aasServer.connectionUri,
    aasProvisioningState: aasServer.aasProvisioningState,
    ...(adminSpIdentifier
      ? {}
      : {
          aasAdminWarning:
            'LOOM_UAMI_APP_ID/LOOM_ENTRA_TENANT_ID not set — AAS admin not configured; data-plane model deployment requires manual SSMS/XMLA setup.',
        }),
  };

  await updateOwnedItem(datamartId, 'datamart', session.claims.oid, {
    state: { ...((item.state as Record<string, unknown>) || {}), migration, _deprecated: true },
  });

  return NextResponse.json({
    ok: true,
    synapseDatabase,
    serverlessEndpoint: migration.serverlessEndpoint,
    aasServer: aasServer.name,
    aasConnectionUri: aasServer.connectionUri,
    aasProvisioningState: aasServer.aasProvisioningState,
    migratedAt,
    ...(migration.aasAdminWarning ? { aasAdminWarning: migration.aasAdminWarning } : {}),
  });
}
