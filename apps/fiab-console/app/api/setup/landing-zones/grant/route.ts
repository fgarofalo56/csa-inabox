/**
 * POST /api/setup/landing-zones/grant  (Wave 1 — auto-set LZ RBAC)
 *
 * Auto-grants the Console UAMI the least-privilege role set it needs to SEE,
 * ATTACH, CREATE, and DEPLOY into a Data Landing Zone — scoped to the DLZ
 * **resource group**, in the DLZ's OWN subscription (never subscription-wide).
 * This is the action the "Add a landing zone" wizard fires after an attach and
 * the Overview pane's "Repair" button fires for a detached DLZ, so the post-
 * attach / post-repair state reads "Attached" without any manual `az` step.
 *
 * Body: { subscriptionId, resourceGroup, principalObjectId? }
 *   - subscriptionId  : the DLZ's own subscription (GUID).
 *   - resourceGroup   : the DLZ resource group (rg-csa-loom-dlz-*). Validated to
 *                       a Loom DLZ RG so this route can never grant the Console
 *                       broad rights on an arbitrary RG.
 *   - principalObjectId (optional) : the Console UAMI object id. When omitted it
 *                       is resolved from env (LOOM_CONSOLE_PRINCIPAL_ID) or the
 *                       tenant-topology doc (hubConsolePrincipalId) so the
 *                       operator never types it.
 *
 * Responses (no-vaporware — every path hits real ARM or returns an honest gate):
 *   200 { ok:true,  scope, outcomes }           — every role granted/already present
 *   207 { ok:false, scope, outcomes }            — partial (some role failed, not 403)
 *   403 { ok:false, error:'forbidden', remediation, commands } — the Console UAMI
 *        itself lacks Microsoft.Authorization/roleAssignments/write at the RG
 *        scope (it is not Owner / User Access Administrator there). The exact
 *        RG-scoped `az role assignment create` lines are returned for an operator
 *        who DOES have rights to run.
 *   400 / 401 / 502 — validation / auth / token errors.
 *
 * Admin-gated on the SAME capability as the DLZ deploy (admin.deploy-dlz) — this
 * mutates RBAC, an admin-tier action. No Fabric anywhere (no-fabric-dependency).
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { enforceCapability } from '@/lib/auth/feature-gate';
import { getTenantTopologySafe } from '@/lib/setup/tenant-topology';
import { parseDlzRgName } from '@/lib/setup/landing-zones-model';
import {
  grantRgScopedRoles,
  buildRgScopedGrantCommands,
  isGovBoundary,
} from '@/lib/setup/lz-rbac';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface GrantBody {
  subscriptionId?: string;
  resourceGroup?: string;
  principalObjectId?: string;
}

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  // Mutating RBAC is admin-tier — same gate as deploying a DLZ.
  const gate = await enforceCapability(session, 'admin.deploy-dlz', 'Admin');
  if (gate) return gate;

  const body = (await req.json().catch(() => ({}))) as GrantBody;
  const subscriptionId = (body.subscriptionId || '').trim();
  const resourceGroup = (body.resourceGroup || '').trim();

  if (!subscriptionId || !GUID_RE.test(subscriptionId)) {
    return NextResponse.json(
      { ok: false, error: `subscriptionId is required and must be a GUID: ${subscriptionId || '(missing)'}` },
      { status: 400 },
    );
  }
  // Only Loom DLZ resource groups are grantable here — this route must never be
  // a generic "grant Contributor on any RG" surface.
  if (!resourceGroup || !parseDlzRgName(resourceGroup)) {
    return NextResponse.json(
      {
        ok: false,
        error: `resourceGroup must be a CSA Loom DLZ resource group (rg-csa-loom-dlz-<domain>-<region>): ${resourceGroup || '(missing)'}`,
      },
      { status: 400 },
    );
  }

  // Resolve the Console UAMI object id the grant targets — env first, then the
  // tenant-topology doc, so the operator never types an object id.
  let principalObjectId = (body.principalObjectId || process.env.LOOM_CONSOLE_PRINCIPAL_ID || '').trim();
  let boundary: string | undefined;
  try {
    const topo = await getTenantTopologySafe();
    boundary = topo.topology?.boundary;
    if (!principalObjectId && topo.topology?.hubConsolePrincipalId) {
      principalObjectId = topo.topology.hubConsolePrincipalId.trim();
    }
  } catch {
    /* topology read is best-effort for the principal-id fallback + boundary */
  }

  if (!principalObjectId || !GUID_RE.test(principalObjectId)) {
    return NextResponse.json(
      {
        ok: false,
        error: 'forbidden',
        reason: 'no-console-principal',
        remediation:
          'The Console UAMI object id is not known to this Console (LOOM_CONSOLE_PRINCIPAL_ID is ' +
          'unset and the tenant-topology doc has no hubConsolePrincipalId). Set LOOM_CONSOLE_PRINCIPAL_ID ' +
          'on the Console app (the loomConsolePrincipalId deploy param), or run the grant below with the ' +
          'Console UAMI object id, scoped to the DLZ resource group:',
        commands: buildRgScopedGrantCommands({
          subscriptionId,
          resourceGroup,
          principalType: 'ServicePrincipal',
          isGov: isGovBoundary(boundary),
        }),
      },
      { status: 403 },
    );
  }

  let result;
  try {
    result = await grantRgScopedRoles({
      subscriptionId,
      resourceGroup,
      principalObjectId,
      principalType: 'ServicePrincipal',
    });
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: `RBAC grant failed: ${e?.message ?? String(e)}` },
      { status: 502 },
    );
  }

  // The Console UAMI itself cannot write role assignments at this scope (it is
  // not Owner / User Access Administrator on the DLZ RG/sub). Return the honest
  // RG-scoped copy-paste gate — never a raw error.
  if (result.forbidden) {
    return NextResponse.json(
      {
        ok: false,
        error: 'forbidden',
        reason: 'caller-cannot-grant',
        scope: result.scope,
        outcomes: result.outcomes,
        remediation:
          'The Console identity attached the landing zone but cannot grant itself RBAC on it — it ' +
          'lacks Microsoft.Authorization/roleAssignments/write at the DLZ resource group scope (it ' +
          'is not Owner or User Access Administrator there). An operator with those rights runs the ' +
          'commands below, then Refresh. Roles are scoped to the DLZ resource group (least-privilege ' +
          '— no subscription-wide grant):',
        commands: buildRgScopedGrantCommands({
          subscriptionId,
          resourceGroup,
          principalObjectId,
          principalType: 'ServicePrincipal',
          isGov: isGovBoundary(boundary),
        }),
      },
      { status: 403 },
    );
  }

  return NextResponse.json(
    { ok: result.allGranted, scope: result.scope, outcomes: result.outcomes },
    { status: result.allGranted ? 200 : 207 },
  );
}
