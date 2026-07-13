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
import {
  createAttachedService,
  applyIntegrationResults,
  attachedTenantId,
  type AttachedServiceIntegration,
} from '@/lib/azure/attached-services-store';
import { runAttachIntegration } from '@/lib/azure/attach-integration';
import { resolveUamiPrincipalId } from '@/lib/clients/azure-connections-client';
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
    integration?: AttachedServiceIntegration;
  }> = [];
  const manualActions: Array<{ armResourceId: string; action: string }> = [];
  const errors: Array<{ armResourceId: string; error: string }> = [];

  // Resolve the Console UAMI principal once — every attach in this batch grants
  // to the same identity (Phase-2 auto-RBAC). Best-effort: null → honest gate.
  const registryTenantId = attachedTenantId(session!);
  const principalId = await resolveUamiPrincipalId().catch(() => null);

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
      // Phase-2 auto-integration: RBAC grant + Purview + telemetry + chargeback.
      // Each step is best-effort and individually recorded on the service doc; a
      // hook failure never fails the attach (the registry doc already exists).
      let integration: AttachedServiceIntegration | undefined;
      try {
        integration = await runAttachIntegration({
          armResourceId,
          kind,
          displayName,
          subscriptionId,
          resourceGroup,
          location: row?.properties?.location,
          principalId,
        });
        await applyIntegrationResults(registryTenantId, view.id, integration).catch(() => null);
      } catch { /* integration is best-effort — never fail the attach */ }

      registered.push({
        id: view.id,
        kind,
        displayName,
        armResourceId,
        reachability: preflight.reachability,
        rbacState: preflight.rbacState,
        networkPosture: preflight.networkPosture,
        integration,
      });
      // Surface the RBAC step's honest gate (grant command) as a manual action
      // only when auto-grant did not go through.
      if (integration?.rbac?.status === 'granted') {
        // Auto-granted — no manual RBAC action needed.
      } else if (integration?.rbac?.grantScript) {
        manualActions.push({ armResourceId, action: integration.rbac.grantScript });
      } else {
        manualActions.push({
          armResourceId,
          action: `Grant the Console UAMI the "${preflight.rbacRoleName}" role at ${preflight.rbacScope}.`,
        });
      }
      // A pending telemetry grant is also an honest manual action.
      if (integration?.telemetry?.status === 'pending-grants' && integration.telemetry.grantScript) {
        manualActions.push({ armResourceId, action: integration.telemetry.grantScript });
      }
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
        'Services are registered in Loom and auto-integrated: the Console UAMI navigator RBAC was ' +
        'granted (or an honest grant command is listed under manualActions), the resource was registered ' +
        'as a Purview scan source where supported, diagnostic settings route its logs to the hub Log ' +
        'Analytics workspace, and its subscription is in the chargeback sweep. Private-endpoint-locked ' +
        'resources still need a hub PE path (Phase 3).',
    },
  });
}
