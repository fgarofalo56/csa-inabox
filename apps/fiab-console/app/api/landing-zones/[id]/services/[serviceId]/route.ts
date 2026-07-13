/**
 * DELETE /api/landing-zones/[id]/services/[serviceId]
 * ---------------------------------------------------
 * Detach an EXISTING service from a landing zone (§2.3). Removes ONLY the Loom
 * binding (registry doc + any KV secret) — NEVER the customer's Azure resource
 * (brownfield = we borrow, we don't own). Refuses with 409 + the dependents list
 * when a Loom item still binds it (referential integrity, mirror of
 * ConnectionInUseError). Gated to `admin.attach-service` (Admin) + PDP.
 */
import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { enforceCapability } from '@/lib/auth/feature-gate';
import { pdpCheck } from '@/lib/auth/pdp/enforce';
import { detachService, AttachedServiceInUseError } from '@/lib/azure/attached-services-store';
import { decodeLandingZoneId } from '@/lib/azure/landing-zone-id';
import { emitAuditEvent } from '@/lib/admin/audit-stream';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const CAP = 'admin.attach-service';

export async function DELETE(_req: Request, { params }: { params: { id: string; serviceId: string } }) {
  const session = getSession();
  const gate = await enforceCapability(session, CAP, 'Admin');
  if (gate) return gate;
  const tenantId = session!.claims.tid || session!.claims.oid;
  const blocked = await pdpCheck(session!, { level: 'domain', id: tenantId }, 'admin');
  if (blocked) return blocked;

  const landingZoneId = decodeLandingZoneId(params.id);
  const serviceId = params.serviceId;

  try {
    await detachService(session!, serviceId);
  } catch (e: any) {
    if (e instanceof AttachedServiceInUseError) {
      return NextResponse.json(
        { ok: false, error: e.message, code: 'in_use', dependents: e.dependents },
        { status: 409 },
      );
    }
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }

  emitAuditEvent({
    actorOid: session!.claims.oid,
    actorUpn: session!.claims.upn || session!.claims.email || tenantId,
    action: 'landing-zone.detach-service',
    targetType: 'landing-zone',
    targetId: landingZoneId,
    tenantId,
    detail: { serviceId },
  });

  return NextResponse.json({ ok: true, landingZoneId, serviceId });
}
