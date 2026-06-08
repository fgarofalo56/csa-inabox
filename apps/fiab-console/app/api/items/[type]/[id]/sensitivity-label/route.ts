/**
 * PATCH /api/items/[type]/[id]/sensitivity-label
 *
 * Applies (or changes) the sensitivity label on a Loom workspace item with two
 * protections wired to real backends:
 *
 *   F20 — Change-label rights gate. If the item currently carries a PROTECTED
 *         label (Graph beta `hasProtection`), the caller must hold EXPORT or
 *         EDIT usage rights on that label (verified via Microsoft Graph) or the
 *         request is rejected 403. No Fabric dependency — pure Graph + Cosmos.
 *
 *   F21 — Label → RBAC enforcement. When a `principalId` is supplied, the new
 *         label's sensitivity tier is enforced as a REAL Azure RBAC grant on
 *         the item's backing store (ADLS container / Synapse pool / ADX db) via
 *         `enforceLabelRbac` → `enforceAccessGrant`. The resulting grant is
 *         persisted in `state.labelRbacGrant`.
 *
 * Body:
 *   {
 *     labelId: string;                 // required — Graph sensitivity label id
 *     labelName?: string;              // optional — display name to persist
 *     principalId?: string;            // optional — Entra principal to (re)scope
 *     principalName?: string;          // optional — UPN/name (required for warehouse)
 *     principalType?: 'User'|'Group'|'ServicePrincipal';
 *   }
 *
 * Responses:
 *   200 { ok: true, label: { id, name, hasProtection }, rbac?, grant? }
 *   400 { ok: false, error }                      — bad input / label not found
 *   401 { ok: false, error }                      — unauthenticated
 *   403 { ok: false, error, hint }                — F20 rights gate
 *   404 { ok: false, error }                      — item not found
 *   503 { ok: false, code:'mip_not_configured' }  — LOOM_MIP_ENABLED unset
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { itemsContainer, workspacesContainer } from '@/lib/azure/cosmos-client';
import type { Workspace, WorkspaceItem } from '@/lib/types/workspace';
import { getSensitivityLabel } from '@/lib/azure/mip-graph-client';
import { handleSecurityError } from '@/app/api/admin/security/_lib/error-handling';
import {
  isProtectedLabel,
  checkLabelChangeRights,
  enforceLabelRbac,
  resolveItemBackingScope,
} from '@/lib/azure/label-protection';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function err(error: string, status: number, extra?: Record<string, unknown>) {
  return NextResponse.json({ ok: false, error, ...extra }, { status });
}

async function loadItem(itemId: string, type: string, tenantId: string): Promise<WorkspaceItem | null> {
  const items = await itemsContainer();
  const { resources } = await items.items
    .query<WorkspaceItem>({
      query: 'SELECT * FROM c WHERE c.id = @id AND c.itemType = @t',
      parameters: [{ name: '@id', value: itemId }, { name: '@t', value: type }],
    })
    .fetchAll();
  const item = resources[0];
  if (!item) return null;
  const ws = await workspacesContainer();
  try {
    const { resource } = await ws.item(item.workspaceId, tenantId).read<Workspace>();
    if (!resource || resource.tenantId !== tenantId) return null;
  } catch (e: any) {
    if (e?.code === 404) return null;
    throw e;
  }
  return item;
}

export async function PATCH(req: NextRequest, props: { params: Promise<{ type: string; id: string }> }) {
  const params = await props.params;
  const session = getSession();
  if (!session) return err('Unauthorized', 401);
  const callerUpn = session.claims.upn || session.claims.email || '';

  let body: any;
  try { body = await req.json(); } catch { return err('Invalid JSON', 400); }
  const labelId = typeof body?.labelId === 'string' ? body.labelId.trim() : '';
  if (!labelId) return err('labelId is required', 400);

  try {
    const item = await loadItem(params.id, params.type, session.claims.oid);
    if (!item) return err('Item not found', 404);

    const state = (item.state || {}) as Record<string, unknown>;
    const currentLabelId = typeof state.sensitivityLabelId === 'string' ? state.sensitivityLabelId : '';

    // ── F20: if the CURRENT label is protected, gate the change by caller rights.
    if (currentLabelId && currentLabelId !== labelId) {
      const currentLabel = await getSensitivityLabel(currentLabelId);
      if (currentLabel && isProtectedLabel(currentLabel)) {
        if (!callerUpn) {
          return err(
            'Your session has no UPN; cannot verify usage rights to change a protected label.',
            403,
            { hint: 'Sign in with a user identity that carries a UPN, or have an administrator change this protected label.' },
          );
        }
        const gate = await checkLabelChangeRights(currentLabelId, currentLabel, callerUpn);
        if (!gate.allowed) {
          return err(gate.reason || 'You are not permitted to change this protected label.', 403, { hint: gate.hint });
        }
      }
    }

    // ── Resolve the NEW label (must exist).
    const newLabel = await getSensitivityLabel(labelId);
    if (!newLabel) return err(`Sensitivity label "${labelId}" was not found.`, 400);
    const labelName =
      (typeof body?.labelName === 'string' && body.labelName.trim()) ||
      newLabel.name || newLabel.displayName || labelId;

    // ── F21: enforce the new label's protection tier as real Azure RBAC.
    let rbac: import('@/lib/azure/access-policy-client').AccessGrantResult | undefined;
    let grant: import('@/lib/azure/label-protection').LabelRbacGrant | undefined;
    const principalId = typeof body?.principalId === 'string' ? body.principalId.trim() : '';
    if (principalId) {
      const scope = resolveItemBackingScope(item);
      if ('pending' in scope) {
        rbac = { status: 'pending', detail: scope.pending };
      } else {
        const principalType = (body?.principalType === 'Group' || body?.principalType === 'ServicePrincipal')
          ? body.principalType : 'User';
        const res = await enforceLabelRbac({
          label: newLabel,
          principalId,
          principalName: typeof body?.principalName === 'string' ? body.principalName.trim() : undefined,
          principalType,
          scopeType: scope.scopeType,
          scopeRef: scope.scopeRef,
        });
        grant = res.grant;
        rbac = { status: res.status, roleName: res.roleName, roleAssignmentId: res.roleAssignmentId, detail: res.detail };
      }
    }

    // ── Persist the label + grant on the item.
    const nextState: Record<string, unknown> = { ...state, sensitivityLabel: labelName, sensitivityLabelId: labelId };
    nextState.sensitivityLabelProtected = isProtectedLabel(newLabel);
    if (grant) nextState.labelRbacGrant = grant;
    const next: WorkspaceItem = { ...item, state: nextState, updatedAt: new Date().toISOString() };
    const items = await itemsContainer();
    const { resource } = await items.item(item.id, item.workspaceId).replace<WorkspaceItem>(next);

    return NextResponse.json({
      ok: true,
      label: { id: labelId, name: labelName, hasProtection: isProtectedLabel(newLabel) },
      rbac,
      grant,
      item: resource,
    });
  } catch (e: any) {
    // MIP not configured / Graph upstream errors → structured 503/4xx via shared mapper.
    if (e?.constructor?.name === 'MipNotConfiguredError' || e?.constructor?.name === 'MipError') {
      return handleSecurityError(e);
    }
    return err(e?.message || 'Failed to apply sensitivity label', 500);
  }
}
