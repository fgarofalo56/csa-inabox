/**
 * GET /api/items/semantic-model/aas-databases
 *
 * Lists the tabular databases on the env-pinned Azure Analysis Services server
 * (ARM, api-version 2017-08-01), including each database's storage mode
 * (InMemory = Import, DirectQuery, Hybrid). Backs the SemanticModelEditor's
 * AAS database picker + Storage Mode tab.
 *
 * Doubles as the editor's AAS gate probe: when LOOM_AAS_SERVER_NAME (or the
 * other required vars) is unset it returns { ok: false, gate } with a 503 so
 * the editor renders an honest Fluent MessageBar instead of an empty grid.
 *
 * Per no-fabric-dependency.md this is the Azure-native default backend — no
 * Fabric / Power BI workspace required.
 */
import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { listDatabases, aasServerConfigGate, envAasServerName, envAasServerRegion, AasError } from '@/lib/azure/aas-server-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const gate = aasServerConfigGate();
  if (gate) {
    return NextResponse.json(
      { ok: false, error: `Azure Analysis Services not configured: ${gate.missing} — ${gate.detail}`, gate },
      { status: 503 },
    );
  }
  try {
    const databases = await listDatabases();
    const out = { ok: true as const, serverName: envAasServerName(), region: envAasServerRegion(), databases };
    try { console.info(`[aas/aas-databases.GET] receipt: ${JSON.stringify(out).slice(0, 300)}`); } catch { /* noop */ }
    return NextResponse.json(out);
  } catch (e: any) {
    const status = e instanceof AasError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
  }
}
