/**
 * GET /api/data-products/my-access-requests — the caller's data-product access
 * requests, for the Data Marketplace "My data access" sub-tab.
 *
 * Reads the REAL, authoritative request documents (no mock data, no fabricated
 * status) and reflects each request's true lifecycle state. Two backends feed a
 * consumer's data-product requests, and BOTH are surfaced here:
 *
 *   1. F16 governed workflow — `access-request-workflow` container
 *      (PK /tenantId = requester oid), written by /api/catalog/request-access.
 *      Advances manager → privacy → approver → access-provider; the final
 *      approval provisions REAL Azure RBAC. Status: open | denied | completed.
 *
 *   2. F15 purpose-bound requests — `access-requests` container
 *      (PK /dataProductId), written by the marketplace "Request access" dialog
 *      (POST /api/data-products/[id]/access-requests). Owner approval does
 *      zero-touch fulfillment. Status: pending | approved | rejected | completed.
 *
 * Both are normalized to the display vocabulary the "My access" table renders
 * (`pending | approved | rejected | completed`): an in-flight F16 request is
 * `pending` (with its current approval `tier` surfaced), a denied one is
 * `rejected`, and a provisioned one is `completed`. This fixes the prior bug
 * where every row was hard-coded `pending` regardless of the real outcome.
 */
import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  accessRequestWorkflowContainer,
  accessRequestsContainer,
} from '@/lib/azure/cosmos-client';
import type { AccessRequestDoc } from '@/lib/types/access-request-workflow';
import type { AccessRequest } from '@/lib/types/access-request';
import { apiServerError } from '@/lib/api/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Display status the "My access" table understands. */
type DisplayStatus = 'pending' | 'approved' | 'rejected' | 'completed';

interface MyAccessRequest {
  id: string;
  productId: string;
  summary: string;
  requestedAt: string;
  permission: string;
  status: DisplayStatus;
  /** F16 only — the approval tier an in-flight request currently sits at. */
  tier?: string;
}

/**
 * Map the F16 workflow status to the shared display vocabulary. An `open`
 * request is still moving through the approval chain, so it reads as `pending`;
 * `completed` means the final tier provisioned the real grant; `denied` reads
 * as `rejected` (the UI badges it as a failure).
 */
function mapWorkflowStatus(status: AccessRequestDoc['status']): DisplayStatus {
  switch (status) {
    case 'completed': return 'completed';
    case 'denied': return 'rejected';
    default: return 'pending';
  }
}

export async function GET() {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const oid = s.claims.oid;

  try {
    // 1) F16 governed workflow — partitioned by requester oid (tenantId), so this
    //    is a single-partition query. Scoped to data-product assets for this tab.
    const wf = await accessRequestWorkflowContainer();
    const { resources: wfDocs } = await wf.items
      .query<AccessRequestDoc>({
        query:
          'SELECT * FROM c WHERE c.tenantId = @oid AND c.kind = @k AND c.itemType = @t ORDER BY c.requestedAt DESC',
        parameters: [
          { name: '@oid', value: oid },
          { name: '@k', value: 'access-request' },
          { name: '@t', value: 'data-product' },
        ],
      })
      .fetchAll();

    const fromWorkflow: MyAccessRequest[] = (wfDocs || []).map((d) => ({
      id: d.id,
      productId: d.assetId,
      summary: d.assetName || d.assetId,
      requestedAt: d.requestedAt,
      permission: d.permission || 'read',
      status: mapWorkflowStatus(d.status),
      // Only meaningful while the request is still open (pending).
      ...(d.status === 'open' ? { tier: d.tier } : {}),
    }));

    // 2) F15 purpose-bound requests — the `access-requests` container is
    //    data-product-only; query the caller's own across partitions. Its status
    //    vocabulary already matches the display set, so it passes through.
    const ar = await accessRequestsContainer();
    const { resources: arDocs } = await ar.items
      .query<AccessRequest>({
        query: 'SELECT * FROM c WHERE c.requesterId = @oid ORDER BY c.createdAt DESC',
        parameters: [{ name: '@oid', value: oid }],
      })
      .fetchAll();

    const fromPurposeBound: MyAccessRequest[] = (arDocs || []).map((d) => ({
      id: d.id,
      productId: d.dataProductId,
      summary: d.dataProductName || d.dataProductId,
      requestedAt: d.createdAt,
      // F15 grants are data-plane read access; the purpose is the descriptive axis.
      permission: 'read',
      status: d.status,
    }));

    const requests = [...fromWorkflow, ...fromPurposeBound].sort(
      (a, b) => (b.requestedAt || '').localeCompare(a.requestedAt || ''),
    );

    return NextResponse.json({ ok: true, requests });
  } catch (e: any) {
    return apiServerError(e);
  }
}
