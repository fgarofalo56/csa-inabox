/**
 * Reference-Lakehouse federation (F8) — READ-ONLY path listing.
 *
 * GET /api/lakehouse/references/paths?refId=<lakehouseItemId>&container=<c>&prefix=<p>
 *   → { ok, refId, account, container, prefix, paths[] }
 *
 * Lists an ADLS Gen2 path inside a REFERENCED lakehouse via pass-through RBAC
 * (the Console UAMI must hold Storage Blob Data Reader on the container). There
 * is intentionally NO PUT/POST/DELETE here — references are read-only, and the
 * absence of write handlers is the enforcement layer (a disabled-button tooltip
 * in the UI is the affordance, not the guarantee).
 *
 * Item scope: the referenced lakehouse is authorized for read with the
 * caller's own access to it (`scopeReferenceListing`), and the prefix is confined
 * to that item's root in its own container. An empty prefix lists the root;
 * a container the item has no storage in lists nothing (`paths: []` + `note`).
 */
import { NextRequest, NextResponse } from 'next/server';
import { listPaths } from '@/lib/azure/adls-client';
import { apiError } from '@/lib/api/respond';
import { withSession } from '@/lib/api/route-toolkit';
import { scopeReferenceListing } from '../../_lib/reference-scope';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function err(error: string, status: number, code?: string) {
  return apiError(error, status, code === undefined ? undefined : { code });
}

export const GET = withSession(async (req: NextRequest, { session }) => {
  const refId = (req.nextUrl.searchParams.get('refId') || '').trim();
  const container = (req.nextUrl.searchParams.get('container') || '').trim();
  const prefix = req.nextUrl.searchParams.get('prefix') || '';
  const maxResults = Number(req.nextUrl.searchParams.get('maxResults') || '200');

  if (!refId) return err('refId is required', 400, 'missing_refId');

  try {
    const scoped = await scopeReferenceListing(session, refId, container, prefix);
    if (scoped instanceof NextResponse) return scoped;
    if ('otherContainer' in scoped) {
      // The references tree shows a node per container; only the bound one has content.
      return NextResponse.json({
        ok: true, refId, account: scoped.account || '', container, prefix: '', paths: [],
        note: `This lakehouse stores its files in the ${scoped.boundContainer} container.`,
      });
    }

    const limit = Number.isFinite(maxResults) && maxResults > 0 ? Math.min(maxResults, 1000) : 200;
    const paths = await listPaths(scoped.container, scoped.path, limit, scoped.account);
    return NextResponse.json({
      ok: true, refId, account: scoped.account || '', container: scoped.container, prefix: scoped.path, paths,
    });
  } catch (e: any) {
    const status = e?.statusCode === 404 ? 404 : 502;
    return err(e?.message || String(e), status, e?.code);
  }
});
