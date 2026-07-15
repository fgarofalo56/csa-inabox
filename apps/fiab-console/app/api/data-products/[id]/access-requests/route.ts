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
import type { AccessRequest, ProvisionedTarget } from '@/lib/types/access-request';
import type { WorkspaceItem } from '@/lib/types/workspace';
import crypto from 'node:crypto';
import { apiServerError } from '@/lib/api/respond';
import { recordListingSubscribe } from '@/lib/marketplace/listing-analytics';
import { emitLoomEvent } from '@/lib/events/webhook-emitter';
import { resolveGrantTargets, rollUpFulfillment } from '@/lib/dataproducts/fulfillment';
import { enforceAccessGrant } from '@/lib/azure/access-policy-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Resolve the owning workspace tenantId for a data product (or null). */
async function resolveOwnerTenantId(id: string): Promise<{ found: boolean; ownerTenantId: string | null; name?: string; state?: Record<string, unknown> }> {
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
  return { found: true, ownerTenantId: wsRes[0]?.tenantId ?? null, name, state: (item.state || {}) as Record<string, unknown> };
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
  // DP-10 — usage purpose + attestations (structured booleans, no freeform).
  const usagePurpose = String(body?.usagePurpose || purposeName).trim().slice(0, 200);
  const rawAtt = (body?.attestations && typeof body.attestations === 'object') ? body.attestations : {};
  const attestations = {
    noCopy: !!rawAtt.noCopy,
    termsOfUse: !!rawAtt.termsOfUse,
    custom: !!rawAtt.custom,
  };
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
      usagePurpose,
      attestations,
      justification: justification || undefined,
      status: 'pending',
      createdAt: now,
      updatedAt: now,
    };

    const container = await accessRequestsContainer();
    const { resource } = await container.items.create(doc);

    // W18 — real subscribe counter increment on the existing subscribe path +
    // fan a marketplace.listing.subscribed event out to the owner's webhooks
    // (both best-effort, fire-and-forget; never block the subscribe response).
    void recordListingSubscribe(id, s.claims.oid);
    if (owner.ownerTenantId) {
      emitLoomEvent({
        type: 'marketplace.listing.subscribed',
        tenantId: owner.ownerTenantId,
        subject: id,
        subjectName: owner.name,
        actor: { oid: s.claims.oid, upn: s.claims.upn || s.claims.email },
        data: { requestId: doc.id, purposeName, policyId, requesterUpn: doc.requesterUpn },
      });
    }
    return NextResponse.json({ ok: true, request: resource }, { status: 201 });
  } catch (e: any) {
    return apiServerError(e);
  }
}

/**
 * PATCH /api/data-products/[id]/access-requests  (DP-10)
 *
 * Owner APPROVE + zero-touch FULFILLMENT of a purpose-bound access request.
 * Body: { requestId, decision: 'approved' | 'rejected', reviewComment? }.
 *
 * On approval this does the DataZone-parity auto-fulfillment: it resolves the
 * product's OUTPUT-PORT backing resources (DP-8) into concrete Azure RBAC grant
 * targets and provisions each via the REAL role-assignment path
 * (`enforceAccessGrant` — Storage Blob Data Reader / Synapse db_datareader / ADX
 * viewer), with NO manual portal grant. Honest-gate (no-vaporware): when nothing
 * is resolvable, or a grant returns a config/infra gate, the request is marked
 * approved-but-not-provisioned with a precise note rather than a fake success.
 * Owner-only. Azure-native; role-assignment REST identical per cloud.
 */
export async function PATCH(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const body = await req.json().catch(() => ({} as any));
  const requestId = String(body?.requestId || '').trim();
  const decision = body?.decision === 'rejected' ? 'rejected' : body?.decision === 'approved' ? 'approved' : null;
  const reviewComment = String(body?.reviewComment || '').trim().slice(0, 1000) || undefined;
  if (!requestId || !decision) {
    return NextResponse.json({ ok: false, error: 'requestId and decision ("approved"|"rejected") are required' }, { status: 400 });
  }

  try {
    // Owner-only: only the product owner may action requests.
    const owner = await resolveOwnerTenantId(id);
    if (!owner.found) return NextResponse.json({ ok: false, error: 'Data product not found' }, { status: 404 });
    if (!owner.ownerTenantId || owner.ownerTenantId !== s.claims.oid) {
      return NextResponse.json({ ok: false, error: 'Only the data product owner can approve requests' }, { status: 403 });
    }

    const container = await accessRequestsContainer();
    const { resource: doc } = await container.item(requestId, id).read<AccessRequest>();
    if (!doc) return NextResponse.json({ ok: false, error: 'request not found' }, { status: 404 });
    if (doc.status !== 'pending') {
      return NextResponse.json({ ok: false, error: `request is already ${doc.status}` }, { status: 409 });
    }

    const now = new Date().toISOString();
    doc.reviewedBy = s.claims.upn || s.claims.email || s.claims.oid;
    doc.reviewedAt = now;
    doc.reviewComment = reviewComment;
    doc.updatedAt = now;

    if (decision === 'rejected') {
      doc.status = 'rejected';
      await container.item(requestId, id).replace(doc);
      return NextResponse.json({ ok: true, request: doc });
    }

    // ── APPROVED — zero-touch fulfillment ─────────────────────────────────────
    const targets = resolveGrantTargets(owner.state);
    let httpStatus = 200;
    if (targets.length === 0) {
      // Honest-gate: approved, but no resolvable backing resource to grant.
      doc.status = 'approved';
      doc.provisioned = false;
      doc.fulfillmentNote = 'Approved, but no output-port backing resource is declared to grant against. Declare an output port (ADLS / Synapse / ADX) on the product\'s Ports tab, then re-approve to provision access.';
      await container.item(requestId, id).replace(doc);
      return NextResponse.json({ ok: true, request: doc, provisioned: false, note: doc.fulfillmentNote });
    }

    const provisioned: ProvisionedTarget[] = [];
    for (const t of targets) {
      const grant = await enforceAccessGrant({
        principalId: doc.requesterId,
        principalName: doc.requesterUpn,
        principalType: 'User',
        scopeType: t.scopeType,
        scopeRef: t.scopeRef,
        permission: t.permission,
      });
      provisioned.push({ scopeType: t.scopeType, scopeRef: t.scopeRef, roleName: grant.roleName, roleAssignmentId: grant.roleAssignmentId, status: grant.status, detail: grant.detail, source: t.source });
    }
    const roll = rollUpFulfillment(provisioned);
    doc.provisionedTargets = provisioned;
    if (roll === 'provisioned') {
      doc.status = 'completed';
      doc.provisioned = true;
      doc.provisionedAt = now;
    } else {
      // partial / failed — approved but not fully provisioned (honest-gate).
      doc.status = 'approved';
      doc.provisioned = false;
      doc.fulfillmentNote = provisioned.map((p) => p.detail).filter(Boolean).join(' ') ||
        'Some grants could not be provisioned (config/infra gate). Grant the Console UAMI User Access Administrator on the data-plane resource group and re-approve.';
      httpStatus = roll === 'failed' ? 502 : 200;
    }
    await container.item(requestId, id).replace(doc);

    // Emit the fulfillment event (reuse the marketplace channel) + subscribe counter.
    if (doc.provisioned) void recordListingSubscribe(id, doc.requesterId);
    emitLoomEvent({
      type: 'marketplace.listing.subscribed',
      tenantId: owner.ownerTenantId,
      subject: id,
      subjectName: owner.name,
      actor: { oid: s.claims.oid, upn: s.claims.upn || s.claims.email },
      data: { requestId, provisioned: doc.provisioned, targets: provisioned.length, requesterUpn: doc.requesterUpn },
    });

    return NextResponse.json({ ok: roll !== 'failed', request: doc, provisioned: doc.provisioned, targets: provisioned }, { status: httpStatus });
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
