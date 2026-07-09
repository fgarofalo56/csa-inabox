/**
 * GET /api/items/digital-twin/[id]/event-route  (FGC-12 — ADT opt-in status)
 *
 * Reports whether the strictly-opt-in Azure Digital Twins alternate backend is
 * configured for this deployment. Azure Digital Twins is NEVER the default
 * (per .claude/rules/no-fabric-dependency.md, FGC-12: the ADX-native twin graph
 * is the default; ADT is opt-in). This surface exists so the editor's ADT tab
 * renders an HONEST gate — the exact env var to set + the bicep module to
 * deploy — instead of pretending an ADT instance exists.
 *
 *   configured=false → { ok:true, configured:false, remediation, bicepModule }
 *   configured=true  → { ok:true, configured:true, endpoint }
 *
 * Owner-checked (caller must own the twin item).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { loadOwnedItem } from '../../../_lib/item-crud';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const { id } = await ctx.params;

  const item = await loadOwnedItem(id, 'digital-twin', s.claims.oid, { allowReadRoles: true });
  if (!item) return NextResponse.json({ ok: false, error: 'not found' }, { status: 404 });

  const endpoint = process.env.LOOM_ADT_ENDPOINT || '';
  if (!endpoint) {
    return NextResponse.json({
      ok: true,
      configured: false,
      backend: 'adx',
      remediation: 'Azure Digital Twins is an opt-in alternate. To enable it, deploy platform/fiab/bicep/modules/integration/adt-instance.bicep, set LOOM_ADT_ENDPOINT to the instance hostname, and grant the Console UAMI the "Azure Digital Twins Data Owner" role. The default Azure-native ADX twin graph needs none of this.',
      bicepModule: 'platform/fiab/bicep/modules/integration/adt-instance.bicep',
    });
  }
  return NextResponse.json({ ok: true, configured: true, backend: 'adt', endpoint });
}
