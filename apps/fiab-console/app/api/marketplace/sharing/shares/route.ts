/**
 * GET  /api/marketplace/sharing/shares          → list outbound Delta shares
 * POST /api/marketplace/sharing/shares           → create a share { name, comment? }
 *
 * TWO backends, selected by `sharingBackend()` (LU-9):
 *   loom       — the Azure-native DEFAULT wherever the OSS Delta Sharing server
 *                is deployed (LOOM_SHARING_URL). Shares live in Cosmos and are
 *                The recipient-facing endpoint that serves them is a follow-up
 *                change; see docs/fiab/security/loom-sharing-threat-model.md.
 *   databricks — the Unity Catalog Delta Sharing REST, for estates that have a
 *                Databricks workspace and no loom-sharing.
 *
 * Honest 501 gate when neither backend is available (see ./_lib, ./_loom-backend).
 */
import { NextResponse } from 'next/server';
import { withSession, withTenantAdmin } from '@/lib/api/route-toolkit';
import { isTenantAdmin } from '@/lib/auth/feature-gate';
import { listShares, createShare } from '@/lib/azure/unity-catalog-client';
import { resolveShareHost, sharingErrorResponse } from '../_lib';
import { isLoomSharingBackend, loomListShares, loomCreateShare, loomSharingErrorResponse } from '../_loom-backend';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withSession(async (req, { session }) => {
  try {
    // Non-admins get the catalog shape without the estate infrastructure fields
    // (server FQDN, abfss roots, recipient principal ids) - see _loom-backend.
    if (isLoomSharingBackend()) return await loomListShares({ full: isTenantAdmin(session) });
    const host = await resolveShareHost(req.nextUrl.searchParams.get('host'));
    const shares = await listShares(host);
    return NextResponse.json({ ok: true, backend: 'databricks', host, shares });
  } catch (e) {
    return loomSharingErrorResponse(e) || sharingErrorResponse(e);
  }
});

// Publishing data OUTSIDE the boundary is an estate-level act, so creating a
// share on the Loom backend requires a tenant admin — not merely a signed-in
// user. The Databricks path is unchanged in effect: its real gate has always
// been the metastore's own CREATE SHARE privilege, which only admins hold.
export const POST = withTenantAdmin(async (req, { session }) => {
  try {
    const body = await req.json().catch(() => ({}));
    if (isLoomSharingBackend()) {
      return await loomCreateShare(body, session.claims.upn || session.claims.oid || 'unknown');
    }
    const name = String(body?.name || '').trim();
    if (!name) return NextResponse.json({ ok: false, error: 'name is required' }, { status: 400 });
    const host = await resolveShareHost(body?.host);
    const share = await createShare(host, { name, comment: body?.comment });
    return NextResponse.json({ ok: true, backend: 'databricks', host, share });
  } catch (e) {
    return loomSharingErrorResponse(e) || sharingErrorResponse(e);
  }
});
