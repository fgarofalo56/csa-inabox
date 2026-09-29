/**
 * GET /api/items/lakehouse/[id]/abfss
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
 * AUTHORIZATION. The lakehouse is authorized through `resolveItemAccessByOid`
 * (read access suffices — this only reports a path). An id the caller cannot
 * reach answers 404, never 403, so a response never distinguishes "does not
 * exist" from "not yours". The workspace passed to the resolver is the ITEM's
 * own `workspaceId`; a `?workspaceId=` on the query string is still accepted
 * for older callers and is ignored.
 *
 * Azure-native: the path comes from the lakehouse's provisioned DLZ ADLS Gen2
 * coordinates (no Microsoft Fabric / OneLake dependency).
 */
import { NextRequest, NextResponse } from 'next/server';
import { withSession } from '@/lib/api/route-toolkit';
import { resolveLakehouseAbfss } from '@/lib/azure/lakehouse-abfss';
import { authorizeLakehouse } from '../../../../lakehouse/_lib/item-scope';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withSession<{ id: string }>(async (_req: NextRequest, { session, params }) => {
  const id = String(params?.id || '').trim();
  const access = await authorizeLakehouse(session, id);
  if (access instanceof NextResponse) return access;

  try {
    const r = await resolveLakehouseAbfss(id, access.item.workspaceId);
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
});
