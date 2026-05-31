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
  listTables, powerPlatformConfigGate, dataverseConfigGate, PowerPlatformError,
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
