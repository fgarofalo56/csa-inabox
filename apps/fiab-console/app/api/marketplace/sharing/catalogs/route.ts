/**
 * GET /api/marketplace/sharing/catalogs
 *   The Unity Catalog catalogs on the bound workspace that were created by
 *   SUBSCRIBING to an inbound Delta Share (i.e. mounted via
 *   createCatalog({ provider_name, share_name })). These are the read-only
 *   catalogs the Marketplace "Explore / Query" experience operates on.
 *
 *   ?all=true → return ALL catalogs (not just Delta-Sharing ones), used when a
 *               caller wants the full namespace; default filters to share-mounted.
 *
 * Session-guarded. Returns { ok, host, catalogs: [{ name, provider_name?,
 * share_name?, comment?, catalog_type? }] }. Honest gate via sharingErrorResponse
 * when no workspace is bound or Delta Sharing is unavailable.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { listCatalogs } from '@/lib/azure/unity-catalog-client';
import { resolveShareHost, sharingErrorResponse } from '../_lib';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** A catalog created from an inbound Delta Share carries either the explicit
 *  DELTASHARING_CATALOG type OR the provider_name/share_name pair the REST API
 *  returns. We check both so this works across workspace versions. */
function isShareCatalog(c: any): boolean {
  const type = String(c?.catalog_type || '').toUpperCase();
  if (type.includes('DELTASHARING')) return true;
  return !!(c?.provider_name || c?.share_name);
}

export async function GET(req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  try {
    const host = await resolveShareHost(req.nextUrl.searchParams.get('host'));
    const all = req.nextUrl.searchParams.get('all') === 'true';
    const cats = await listCatalogs(host);
    const filtered = all ? cats : cats.filter(isShareCatalog);
    const catalogs = filtered.map((c: any) => ({
      name: c.name,
      provider_name: c.provider_name,
      share_name: c.share_name,
      comment: c.comment,
      catalog_type: c.catalog_type,
      owner: c.owner,
    }));
    return NextResponse.json({ ok: true, host, catalogs });
  } catch (e) {
    return sharingErrorResponse(e);
  }
}
