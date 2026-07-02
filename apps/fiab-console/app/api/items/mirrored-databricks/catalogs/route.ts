/**
 * GET /api/items/mirrored-databricks/catalogs
 *
 * Lists the Databricks Unity Catalog catalogs the BFF can see, so the
 * "Mount a Databricks Unity Catalog" dialog can offer a real picker instead
 * of a freeform text box. Calls Databricks REST /api/2.1/unity-catalog/catalogs
 * via the BFF UAMI (or the user's OBO token in local dev).
 *
 * If LOOM_DATABRICKS_HOSTNAME is not configured the route returns
 * { ok: false, error, code: 'NO_DATABRICKS' } so the editor falls back to a
 * freeform Combobox entry (the picker is a convenience, never a hard gate).
 */
import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { listUcCatalogs } from '@/lib/azure/databricks-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  if (!process.env.LOOM_DATABRICKS_HOSTNAME) {
    return NextResponse.json(
      {
        ok: false,
        code: 'NO_DATABRICKS',
        error: 'Databricks workspace not provisioned in this deployment',
        hint: 'Set LOOM_DATABRICKS_HOSTNAME on the Console container app and grant the Console UAMI workspace-user (see docs/fiab/v3-tenant-bootstrap.md). You can still type a catalog name manually.',
      },
      { status: 503 },
    );
  }

  try {
    const catalogs = await listUcCatalogs();
    return NextResponse.json({ ok: true, catalogs: (catalogs || []).map((c: any) => c?.name).filter(Boolean) });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}
