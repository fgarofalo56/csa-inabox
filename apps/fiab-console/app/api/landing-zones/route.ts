/**
 * /api/landing-zones — logical Landing-Zone registry (dlz-brownfield Phase A).
 * -----------------------------------------------------------------------------
 * GET  → list the tenant's LOGICAL landing zones (lightweight brownfield-attach
 *        targets), admin-gated.
 * POST → create a logical landing zone (body: name + optional coordinates), then
 *        return it so the caller can proceed straight into the attach flow
 *        scoped to `lz.id`.
 *
 * A "logical" landing zone is NOT a greenfield DLZ deploy — it provisions nothing
 * in Azure. It is a durable grouping doc the attach wizard points
 * `attached-services` rows at (the registry already accepts any `landingZoneId`).
 * The cloud boundary is inherited from the deployed hub topology when the caller
 * doesn't override it. No Fabric handles (no-fabric-dependency) — every field is
 * an Azure id / name.
 *
 * Gated to `admin.attach-service` (Admin) + PDP (default-shadow), matching
 * app/api/landing-zones/[id]/attach/route.ts so the "create then attach" flow
 * shares one capability.
 */
import { NextRequest, NextResponse } from 'next/server';
import { apiError } from '@/lib/api/respond';
import { getSession } from '@/lib/auth/session';
import { enforceCapability } from '@/lib/auth/feature-gate';
import { pdpCheck } from '@/lib/auth/pdp/enforce';
import { emitAuditEvent } from '@/lib/admin/audit-stream';
import { getTenantTopologySafe } from '@/lib/setup/tenant-topology';
import {
  createLandingZone,
  listLandingZones,
  type CreateLandingZoneInput,
} from '@/lib/azure/landing-zones-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const CAP = 'admin.attach-service';
const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET() {
  const session = getSession();
  const gate = await enforceCapability(session, CAP, 'Admin');
  if (gate) return gate;
  try {
    const landingZones = await listLandingZones(session!);
    return NextResponse.json({ ok: true, landingZones });
  } catch (e: any) {
    return apiError(e?.message || String(e), 502);
  }
}

export async function POST(req: NextRequest) {
  const session = getSession();
  const gate = await enforceCapability(session, CAP, 'Admin');
  if (gate) return gate;
  const tenantId = session!.claims.tid || session!.claims.oid;
  const blocked = await pdpCheck(session!, { level: 'domain', id: tenantId }, 'admin');
  if (blocked) return blocked;

  const body = await req.json().catch(() => ({} as any));
  const name = String(body?.name || '').trim();
  if (!name) return apiError('name is required to create a landing zone', 400);
  if (body?.subscriptionId && !GUID_RE.test(String(body.subscriptionId))) {
    return apiError(`subscriptionId is not a valid GUID: ${body.subscriptionId}`, 400);
  }

  // Inherit the cloud boundary (and, when the caller omits it, the region) from
  // the deployed hub so a logical LZ carries the same boundary as everything else
  // in the tenant — the operator never re-types it (loom-no-freeform-config).
  const topo = await getTenantTopologySafe().catch(() => null);
  const hub = topo?.topology || null;

  const input: CreateLandingZoneInput = {
    id: typeof body?.id === 'string' ? body.id : undefined,
    name,
    subscriptionId:
      typeof body?.subscriptionId === 'string' ? body.subscriptionId : hub?.hubSubscriptionId,
    resourceGroups: Array.isArray(body?.resourceGroups)
      ? body.resourceGroups.filter((r: unknown) => typeof r === 'string')
      : [],
    region: typeof body?.region === 'string' ? body.region : hub?.location,
    crossSubscription:
      typeof body?.crossSubscription === 'boolean'
        ? body.crossSubscription
        : !!hub?.hubSubscriptionId &&
          typeof body?.subscriptionId === 'string' &&
          body.subscriptionId !== hub.hubSubscriptionId,
    network:
      body?.network && typeof body.network === 'object'
        ? {
            vnetId: typeof body.network.vnetId === 'string' ? body.network.vnetId : undefined,
            peeringNeeded: !!body.network.peeringNeeded,
            privateDnsNeeded: !!body.network.privateDnsNeeded,
          }
        : undefined,
    identityPrincipalId:
      typeof body?.identityPrincipalId === 'string' ? body.identityPrincipalId : undefined,
    purviewCollection:
      typeof body?.purviewCollection === 'string' ? body.purviewCollection : undefined,
    boundary: typeof body?.boundary === 'string' ? body.boundary : hub?.boundary,
    costCenter: typeof body?.costCenter === 'string' ? body.costCenter : undefined,
    adminGroupId: typeof body?.adminGroupId === 'string' ? body.adminGroupId : undefined,
    memberGroupId: typeof body?.memberGroupId === 'string' ? body.memberGroupId : undefined,
  };

  try {
    const landingZone = await createLandingZone(session!, input);
    emitAuditEvent({
      actorOid: session!.claims.oid,
      actorUpn: session!.claims.upn || session!.claims.email || tenantId,
      action: 'landing-zone.create-logical',
      targetType: 'landing-zone',
      targetId: landingZone.id,
      tenantId,
      detail: { name: landingZone.name, subscriptionId: landingZone.subscriptionId },
    });
    return NextResponse.json({ ok: true, landingZone });
  } catch (e: any) {
    return apiError(e?.message || String(e), e?.status || 502);
  }
}
