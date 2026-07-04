/**
 * Data-product access requests (F15).
 *
 *   POST /api/data-products/[id]/access-requests
 *     Create a purpose-bound access request. The body must reference a
 *     permitted purpose (policyId + purposeName) returned by
 *     GET /api/data-products/[id]/policies. Writes a real document to the
 *     `access-requests` Cosmos container (PK /dataProductId), status 'pending'.
 *
 *   GET  /api/data-products/[id]/access-requests
 *     Default (T12 "My data access"): the caller's own requests for this
 *     product. With ?role=approver: ALL requests for the product, but only if
 *     the caller owns it (the approver inbox, T14) — otherwise 403.
 *
 * Cosmos-only — no Fabric/Purview dependency.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  accessRequestsContainer,
  itemsContainer,
  workspacesContainer,
} from '@/lib/azure/cosmos-client';
import type { AccessRequest } from '@/lib/types/access-request';
import type { WorkspaceItem } from '@/lib/types/workspace';
import crypto from 'node:crypto';
import { apiServerError } from '@/lib/api/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Resolve the owning workspace tenantId for a data product (or null). */
async function resolveOwnerTenantId(id: string): Promise<{ found: boolean; ownerTenantId: string | null; name?: string }> {
  const items = await itemsContainer();
  const { resources } = await items.items
    .query<Pick<WorkspaceItem, 'workspaceId' | 'displayName' | 'state'>>({
      query: 'SELECT c.workspaceId, c.displayName, c.state FROM c WHERE c.id = @id AND c.itemType = @t',
      parameters: [
        { name: '@id', value: id },
        { name: '@t', value: 'data-product' },
      ],
    })
    .fetchAll();
  const item = resources[0];
  if (!item) return { found: false, ownerTenantId: null };
  const name = (item.state as any)?.displayName || item.displayName;
  const ws = await workspacesContainer();
  const { resources: wsRes } = await ws.items
    .query<{ tenantId: string }>({
      query: 'SELECT c.tenantId FROM c WHERE c.id = @id',
      parameters: [{ name: '@id', value: item.workspaceId }],
    })
    .fetchAll();
  return { found: true, ownerTenantId: wsRes[0]?.tenantId ?? null, name };
}

export async function POST(
  req: NextRequest,
  props: { params: Promise<{ id: string }> },
) {
  const { id } = await props.params;
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const body = await req.json().catch(() => ({} as any));
  const policyId = String(body?.policyId || '').trim();
  const purposeName = String(body?.purposeName || '').trim();
  const justification = String(body?.justification || '').trim().slice(0, 1000);
  if (!policyId || !purposeName) {
    return NextResponse.json({ ok: false, error: 'policyId and purposeName are required' }, { status: 400 });
  }

  try {
    // Confirm the product exists (so we don't accept orphan requests).
    const owner = await resolveOwnerTenantId(id);
    if (!owner.found) return NextResponse.json({ ok: false, error: 'Data product not found' }, { status: 404 });

    const now = new Date().toISOString();
    const doc: AccessRequest = {
      id: crypto.randomUUID(),
      dataProductId: id,
      dataProductName: owner.name,
      requesterId: s.claims.oid,
      requesterUpn: s.claims.upn || s.claims.email || s.claims.oid,
      policyId,
      purposeName,
      justification: justification || undefined,
      status: 'pending',
      createdAt: now,
      updatedAt: now,
    };

    const container = await accessRequestsContainer();
    const { resource } = await container.items.create(doc);
    return NextResponse.json({ ok: true, request: resource }, { status: 201 });
  } catch (e: any) {
    return apiServerError(e);
  }
}

export async function GET(
  req: NextRequest,
  props: { params: Promise<{ id: string }> },
) {
  const { id } = await props.params;
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const role = req.nextUrl.searchParams.get('role');
  const approverView = role === 'approver';

  try {
    const container = await accessRequestsContainer();

    if (approverView) {
      // T14 approver inbox — only the product owner may see every request.
      const owner = await resolveOwnerTenantId(id);
      if (!owner.found) return NextResponse.json({ ok: false, error: 'Data product not found' }, { status: 404 });
      if (!owner.ownerTenantId || owner.ownerTenantId !== s.claims.oid) {
        return NextResponse.json({ ok: false, error: 'Only the data product owner can view all requests' }, { status: 403 });
      }
      const { resources } = await container.items
        .query<AccessRequest>({
          query: 'SELECT * FROM c WHERE c.dataProductId = @id ORDER BY c.createdAt DESC',
          parameters: [{ name: '@id', value: id }],
        })
        .fetchAll();
      return NextResponse.json({ ok: true, requests: resources });
    }

    // T12 "My data access" — the caller's own requests for this product.
    const { resources } = await container.items
      .query<AccessRequest>({
        query: 'SELECT * FROM c WHERE c.dataProductId = @id AND c.requesterId = @rid ORDER BY c.createdAt DESC',
        parameters: [
          { name: '@id', value: id },
          { name: '@rid', value: s.claims.oid },
        ],
      })
      .fetchAll();
    return NextResponse.json({ ok: true, requests: resources });
  } catch (e: any) {
    return apiServerError(e);
  }
}
