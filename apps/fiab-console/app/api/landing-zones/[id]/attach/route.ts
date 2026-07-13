/**
 * POST /api/landing-zones/[id]/attach
 * -----------------------------------
 * Register one or more EXISTING brownfield Azure services against a landing zone
 * (§2.2 step 4 / §2.3). Body: { services: { armResourceId, kind, displayName? }[] }.
 *
 * Flow (all real — no-vaporware.md):
 *   1. Re-run preflight server-side (reachability + posture + the exact RBAC role
 *      the Console UAMI needs) so the persisted registry doc carries an honest,
 *      current posture — never a client-asserted one.
 *   2. Write an AttachedService registry doc per pick (idempotent per resource).
 *   3. Return a RECEIPT: what was registered, and what still needs a manual
 *      action (RBAC grant — Phase 2 auto-grant; private-endpoint path — Phase 3).
 *
 * "Attach" borrows the resource; it never creates/deletes the customer's Azure
 * resource. Gated to `admin.attach-service` (Admin) + PDP (default-shadow).
 */
import { NextRequest, NextResponse } from 'next/server';
import { apiError } from '@/lib/api/respond';
import { getSession } from '@/lib/auth/session';
import { enforceCapability } from '@/lib/auth/feature-gate';
import { pdpCheck } from '@/lib/auth/pdp/enforce';
import { getUserArmToken } from '@/lib/azure/user-token-store';
import { uamiArmCredential } from '@/lib/azure/arm-credential';
import { armBase, armScope } from '@/lib/azure/cloud-endpoints';
import { composePreflight, preflightToValidation } from '@/lib/azure/attach-preflight';
import { coordsFromArmId } from '@/lib/azure/attached-discovery';
import {
  isAttachedServiceKind,
  armTypeToKind,
  kindLabel,
  type AttachedServiceKind,
} from '@/lib/azure/attached-service-kinds';
import { createAttachedService } from '@/lib/azure/attached-services-store';
import { decodeLandingZoneId } from '@/lib/azure/landing-zone-id';
import { emitAuditEvent } from '@/lib/admin/audit-stream';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const CAP = 'admin.attach-service';
const ARG_URL = `${armBase()}/providers/Microsoft.ResourceGraph/resources?api-version=2021-03-01`;

interface ArgIdRow { id: string; type: string; kind?: string; properties?: any; name?: string }

function buildIdQuery(ids: string[]): string {
  const list = ids.map((i) => `'${i.replace(/'/g, "''")}'`).join(',');
  return `resources | where id in~ (${list}) | project id, name, type, kind, properties`;
}

async function runArgById(token: string, ids: string[]): Promise<ArgIdRow[]> {
  try {
    const res = await fetch(ARG_URL, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ query: buildIdQuery(ids), options: { resultFormat: 'objectArray' } }),
    });
    if (!res.ok) return [];
    const body: any = await res.json().catch(() => ({}));
    return Array.isArray(body?.data) ? body.data : [];
  } catch {
    return [];
  }
}

/** Last segment of an ARM id (the resource name) for a display fallback. */
function nameFromArmId(id: string): string {
  const parts = (id || '').split('/').filter(Boolean);
  return parts[parts.length - 1] || id;
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const session = getSession();
  const gate = await enforceCapability(session, CAP, 'Admin');
  if (gate) return gate;
  const tenantId = session!.claims.tid || session!.claims.oid;
  const blocked = await pdpCheck(session!, { level: 'domain', id: tenantId }, 'admin');
  if (blocked) return blocked;

  const landingZoneId = decodeLandingZoneId(params.id);

  const body = await req.json().catch(() => ({}));
  const requested: Array<{ armResourceId: string; kind?: AttachedServiceKind; displayName?: string }> =
    Array.isArray(body?.services) ? body.services : [];
  if (requested.length === 0) return apiError('services (array of { armResourceId, kind }) required', 400);

  const ids = requested.map((s) => (s?.armResourceId || '').trim()).filter(Boolean);
  if (ids.length === 0) return apiError('no valid armResourceId in services', 400);

  // Server-side posture read (ARG by id) — UAMI first (Loom's perspective),
  // then the caller's token; ARG can silently return zero for one identity.
  let rows: ArgIdRow[] = [];
  try {
    const tok = await uamiArmCredential().getToken(armScope());
    if (tok?.token) rows = await runArgById(tok.token, ids);
  } catch { /* fall through */ }
  if (rows.length === 0) {
    try {
      const userToken = await getUserArmToken(session!.claims.oid);
      if (userToken) rows = await runArgById(userToken, ids);
    } catch { /* leave empty */ }
  }
  const byId = new Map(rows.map((r) => [r.id.toLowerCase(), r]));

  const registered: Array<{
    id: string; kind: AttachedServiceKind; displayName: string; armResourceId: string;
    reachability?: string; rbacState?: string; networkPosture?: string;
  }> = [];
  const manualActions: Array<{ armResourceId: string; action: string }> = [];
  const errors: Array<{ armResourceId: string; error: string }> = [];

  for (const svc of requested) {
    const armResourceId = (svc.armResourceId || '').trim();
    if (!armResourceId) continue;
    const row = byId.get(armResourceId.toLowerCase());
    const kind: AttachedServiceKind =
      (svc.kind && isAttachedServiceKind(svc.kind) ? svc.kind : undefined) ??
      (row ? armTypeToKind(row.type, row.kind) ?? undefined : undefined) ??
      ('storage-adls' as AttachedServiceKind);

    const preflight = row
      ? composePreflight(armResourceId, kind, { status: 200, properties: row.properties })
      : composePreflight(armResourceId, kind, { status: 0, error: 'Resource Graph did not return this resource.' });

    const { subscriptionId, resourceGroup } = coordsFromArmId(armResourceId);
    const displayName = svc.displayName?.trim() || row?.name || nameFromArmId(armResourceId) || kindLabel(kind);

    try {
      const view = await createAttachedService(session!, {
        landingZoneId,
        kind,
        displayName,
        armResourceId,
        subscriptionId,
        resourceGroup,
        location: row?.properties?.location,
        validation: preflightToValidation(preflight),
        origin: 'day2-attach',
        // pending-grants until Phase 2 confirms the RBAC assignment is live.
        status: 'pending-grants',
      });
      registered.push({
        id: view.id,
        kind,
        displayName,
        armResourceId,
        reachability: preflight.reachability,
        rbacState: preflight.rbacState,
        networkPosture: preflight.networkPosture,
      });
      // Every attach needs the navigator RBAC granted (Phase 2 auto-grant).
      manualActions.push({
        armResourceId,
        action: `Grant the Console UAMI the "${preflight.rbacRoleName}" role at ${preflight.rbacScope}.`,
      });
      if (preflight.networkPosture === 'private-endpoint') {
        manualActions.push({
          armResourceId,
          action:
            'Resource is private-endpoint / public-access-disabled — add a private-endpoint + private-DNS ' +
            'path from the hub VNet before its data plane is reachable (guided PE remediation is Phase 3).',
        });
      }
    } catch (e: any) {
      errors.push({ armResourceId, error: e?.message || String(e) });
    }
  }

  emitAuditEvent({
    actorOid: session!.claims.oid,
    actorUpn: session!.claims.upn || session!.claims.email || tenantId,
    action: 'landing-zone.attach-service',
    targetType: 'landing-zone',
    targetId: landingZoneId,
    tenantId,
    detail: { registered: registered.map((r) => r.armResourceId), errors: errors.length },
  });

  return NextResponse.json({
    ok: errors.length === 0,
    landingZoneId,
    registered,
    manualActions,
    errors,
    receipt: {
      attached: registered.length,
      failed: errors.length,
      note:
        'Services are registered in Loom. Each still needs its navigator RBAC granted (Phase 2 ' +
        'auto-grant) before data-plane calls succeed; private-endpoint-locked resources also need a ' +
        'hub PE path (Phase 3). Governance / telemetry / chargeback auto-integration lands in Phase 2.',
    },
  });
}
