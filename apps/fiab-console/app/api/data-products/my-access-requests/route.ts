/**
 * GET /api/data-products/my-access-requests — the caller's data-product access
 * requests, for the Data Marketplace "My data access" sub-tab.
 *
 * Reads the REAL durable access-request records written by
 * /api/catalog/request-access into the Cosmos `audit-log` container
 * (action='access-requested'), scoped to this caller (upn) and to
 * itemType='data-product'. No mock data.
 *
 * Status is `pending` until the owner grants access in Governance → Policies
 * (which enforces real Azure-native RBAC). This is an honest reflection of the
 * T13/T14 request lifecycle — the request is recorded; approval is a separate
 * owner action surfaced in the asset activity.
 */
import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { auditLogContainer } from '@/lib/azure/cosmos-client';
import { apiServerError } from '@/lib/api/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const requester = s.claims.upn || s.claims.email || s.claims.oid;
  try {
    const audit = await auditLogContainer();
    const { resources } = await audit.items
      .query<{
        id: string; itemId: string; itemType: string; action: string;
        summary?: string; upn: string; at: string;
      }>({
        query:
          'SELECT * FROM c WHERE c.action = @a AND c.upn = @u AND c.itemType = @t ORDER BY c.at DESC',
        parameters: [
          { name: '@a', value: 'access-requested' },
          { name: '@u', value: requester },
          { name: '@t', value: 'data-product' },
        ],
      })
      .fetchAll();
    const requests = (resources || []).map((r) => ({
      id: r.id,
      productId: r.itemId,
      summary: r.summary || '',
      requestedAt: r.at,
      // Parse the permission out of the human summary ("...requested read access...").
      permission: /requested (read|write|admin) access/i.exec(r.summary || '')?.[1] || 'read',
      status: 'pending' as const,
    }));
    return NextResponse.json({ ok: true, requests });
  } catch (e: any) {
    return apiServerError(e);
  }
}
