/**
 * GET /api/powerplatform/tables?envId=<env> → { ok, tables: DataverseTable[] }
 *
 * Dataverse tables in a Power Platform environment (Dataverse Web API,
 * EntityDefinitions; scope <org>.crm.dynamics.com/.default per environment).
 *
 * Honest, layered gating:
 *   - Control-plane gate (no LOOM_UAMI_CLIENT_ID)      → 503 code:'not_configured'
 *   - Dataverse SP gate  (no LOOM_DATAVERSE_CLIENT_ID) → 503 code:'dataverse_not_configured'
 *     UAMI tokens are NOT valid Dataverse Application Users (Microsoft
 *     platform restriction); the dedicated MSAL Web App SP must be registered
 *     as a Dataverse Application User on the env. The navigator renders this
 *     as an honest sub-gate row (the rest of the tree still works).
 *   - Real 401/403/404 from Dataverse                 → surfaced with hint.
 *
 * Real REST. No mocks.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  listTables, createTable, powerPlatformConfigGate, dataverseConfigGate, PowerPlatformError,
  type CreateTableSpec,
} from '@/lib/azure/powerplatform-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function err(e: any) {
  const status = e instanceof PowerPlatformError ? e.status : 502;
  return NextResponse.json(
    { ok: false, error: e?.message || String(e), hint: e?.hint, endpoint: e?.endpoint },
    { status },
  );
}

export async function GET(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const cp = powerPlatformConfigGate();
  if (cp) {
    return NextResponse.json(
      { ok: false, code: 'not_configured', error: `Power Platform not configured: set ${cp.missing}.`, missing: cp.missing },
      { status: 503 },
    );
  }
  const dv = dataverseConfigGate();
  if (dv) {
    return NextResponse.json(
      {
        ok: false,
        code: 'dataverse_not_configured',
        error: `Dataverse tables need a dedicated Application-User SP: set ${dv.missing}.`,
        missing: dv.missing,
      },
      { status: 503 },
    );
  }

  const envId = req.nextUrl.searchParams.get('envId');
  if (!envId) return NextResponse.json({ ok: false, error: 'envId query param is required' }, { status: 400 });
  try {
    const all = await listTables(envId);
    // Surface custom tables + a handful of key system tables (matches the
    // DataverseTableEditor filter) so the count is meaningful, not 1000+ rows.
    const tables = all.filter(
      (t) => t.IsCustomEntity ||
        ['account', 'contact', 'systemuser', 'team', 'msdyn_aimodel', 'mspp_website'].includes(t.LogicalName),
    );
    return NextResponse.json({ ok: true, tables, total: all.length });
  } catch (e: any) { return err(e); }
}

/**
 * POST /api/powerplatform/tables?envId=<env>
 *   body = CreateTableSpec { schemaName, displayName, displayCollectionName,
 *          ownershipType?, primaryNameDisplayName?, hasNotes?, hasActivities?,
 *          tableType? }
 *
 * Creates a real new custom Dataverse table (POST EntityDefinitions). Needs the
 * dedicated Dataverse SP with a customizing role. Azure-native — no Fabric.
 */
const OWNERSHIP = ['UserOwned', 'OrganizationOwned'] as const;
const TABLE_TYPES = ['Standard', 'Elastic'] as const;

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const cp = powerPlatformConfigGate();
  if (cp) {
    return NextResponse.json(
      { ok: false, code: 'not_configured', error: `Power Platform not configured: set ${cp.missing}.`, missing: cp.missing },
      { status: 503 },
    );
  }
  const dv = dataverseConfigGate();
  if (dv) {
    return NextResponse.json(
      {
        ok: false, code: 'dataverse_not_configured',
        error: `Creating tables needs a dedicated Application-User SP: set ${dv.missing}.`,
        hint: 'Set LOOM_DATAVERSE_CLIENT_ID / LOOM_DATAVERSE_CLIENT_SECRET / LOOM_DATAVERSE_TENANT_ID and register that SP as a Dataverse Application User with the System Administrator (or System Customizer) role on this environment.',
        missing: dv.missing,
      },
      { status: 503 },
    );
  }

  const envId = req.nextUrl.searchParams.get('envId');
  if (!envId) return NextResponse.json({ ok: false, error: 'envId query param is required' }, { status: 400 });

  let body: any;
  try { body = await req.json(); } catch { body = null; }
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ ok: false, error: 'JSON body required' }, { status: 400 });
  }
  const { schemaName, displayName, displayCollectionName } = body;
  if (!schemaName || typeof schemaName !== 'string') {
    return NextResponse.json({ ok: false, error: 'schemaName is required (e.g. new_Invoice)' }, { status: 400 });
  }
  if (!displayName || typeof displayName !== 'string') {
    return NextResponse.json({ ok: false, error: 'displayName is required' }, { status: 400 });
  }
  if (!displayCollectionName || typeof displayCollectionName !== 'string') {
    return NextResponse.json({ ok: false, error: 'displayCollectionName (plural) is required' }, { status: 400 });
  }

  const spec: CreateTableSpec = {
    schemaName: schemaName.trim(),
    displayName: displayName.trim(),
    displayCollectionName: displayCollectionName.trim(),
    ownershipType: OWNERSHIP.includes(body.ownershipType) ? body.ownershipType : 'UserOwned',
    primaryNameDisplayName: typeof body.primaryNameDisplayName === 'string' ? body.primaryNameDisplayName.trim() || undefined : undefined,
    hasNotes: !!body.hasNotes,
    hasActivities: !!body.hasActivities,
    tableType: TABLE_TYPES.includes(body.tableType) ? body.tableType : 'Standard',
    description: typeof body.description === 'string' ? body.description.trim() || undefined : undefined,
  };

  try {
    const result = await createTable(envId, spec);
    return NextResponse.json({ ok: true, envId, metadataId: result.metadataId, entityId: result.entityId });
  } catch (e: any) { return err(e); }
}
