/**
 * GET /api/items/lakehouse/[id]/abfss?workspaceId=...
 *
 * Resolve an attached lakehouse to the canonical
 *   abfss://<container>@<account>.dfs.<suffix>/<root>
 * URI of its ADLS Gen2 root, so the notebook editor's attached-sources list can
 * show the user the REAL path they can copy + the auto-mount preamble injects
 * into the Spark session (issue #655).
 *
 * Returns:
 *   { ok: true, resolved: true, abfss, container, root }   — resolvable
 *   { ok: true, resolved: false, hint }                    — honest gate: no
 *     provisioning record yet / no storage env configured (names the env var).
 *
 * Azure-native: the path comes from the lakehouse's provisioned DLZ ADLS Gen2
 * coordinates (no Microsoft Fabric / OneLake dependency).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { resolveLakehouseAbfss } from '@/lib/azure/lakehouse-abfss';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const workspaceId = req.nextUrl.searchParams.get('workspaceId');
  if (!workspaceId) return NextResponse.json({ ok: false, error: 'workspaceId required' }, { status: 400 });

  try {
    const r = await resolveLakehouseAbfss((await ctx.params).id, workspaceId);
    if (r) {
      return NextResponse.json({ ok: true, resolved: true, abfss: r.abfss, container: r.container, root: r.root });
    }
    return NextResponse.json({
      ok: true,
      resolved: false,
      hint:
        'No ADLS Gen2 path resolved for this lakehouse yet. It resolves once the ' +
        'lakehouse is provisioned, and requires the internal Data Landing Zone ' +
        'storage to be configured — set LOOM_LANDING_URL (and/or ' +
        'LOOM_BRONZE_URL / LOOM_SILVER_URL / LOOM_GOLD_URL) to the DLZ ADLS Gen2 ' +
        'container URLs the DLZ Bicep deploy emits. No Microsoft Fabric required.',
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}
