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
 *   { ok: true, resolved: false, reason, hint }            — the resolver
 *     withheld the location (`root-shared` / `root-unverified`); `hint` is its
 *     one wording, `lakehouseStorageWithheldMessage`.
 *
 * AUTHORIZATION. The lakehouse is authorized through `resolveItemAccessByOid`
 * (read access suffices — this only reports a path). An id the caller cannot
 * open answers 404, like a missing one. The resolver reads the item from its
 * own `workspaceId`; a `?workspaceId=` query parameter from older callers is
 * not used.
 *
 * Azure-native: the path comes from the lakehouse's provisioned DLZ ADLS Gen2
 * coordinates (no Microsoft Fabric / OneLake dependency).
 */
import { NextRequest, NextResponse } from 'next/server';
import { withSession } from '@/lib/api/route-toolkit';
import { apiNotFound } from '@/lib/api/respond';
import { lakehouseStorageWithheldMessage, resolveLakehouseStorage } from '@/lib/azure/lakehouse-abfss';
import { authorizeLakehouse } from '../../../../lakehouse/_lib/item-scope';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withSession<{ id: string }>(async (_req: NextRequest, { session, params }) => {
  const id = String(params?.id || '').trim();
  const access = await authorizeLakehouse(session, id);
  if (access instanceof NextResponse) return access;

  try {
    const r = await resolveLakehouseStorage(id, access.item.workspaceId);
    if (r.ok) {
      const b = r.bound;
      return NextResponse.json({ ok: true, resolved: true, abfss: b.abfss, container: b.container, root: b.root });
    }
    if (r.reason === 'not-found') return apiNotFound('lakehouse not found');
    const withheld = lakehouseStorageWithheldMessage(r.reason);
    if (withheld) {
      return NextResponse.json({ ok: true, resolved: false, reason: r.reason, hint: withheld });
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
