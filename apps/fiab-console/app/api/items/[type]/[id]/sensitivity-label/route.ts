/**
 * Sensitivity-label routes for a Loom workspace item.
 *
 *   GET  /api/items/[type]/[id]/sensitivity-label   (F12 flyout)
 *        → { ok, currentLabelId, currentLabelName, labels[], source, gov }
 *        Live taxonomy from Microsoft Graph Information Protection
 *        (GET /beta/security/informationProtection/sensitivityLabels via
 *        mip-graph-client.listSensitivityLabels). Never a static list.
 *
 *   PUT  /api/items/[type]/[id]/sensitivity-label   body { labelId }  (F12 flyout)
 *        → applies the label:
 *          1. validates labelId against the live taxonomy AND isAppliable
 *             (policy-blocked labels are rejected 400 with the restriction
 *             reason from the label tooltip/description),
 *          2. PATCHes item.state.sensitivityLabel + sensitivityLabelId in
 *             Cosmos (this is what /api/governance/sensitivity reads back —
 *             so the catalog reflects the change immediately),
 *          3. best-effort writes the label onto the Purview Atlas asset when
 *             item.state.purviewAssetGuid is set and Purview is configured,
 *          4. appends an audit-log row + a tenant-partitioned
 *             label-assignments row.
 *        body { labelId: '' } clears the label.
 *
 *   PATCH /api/items/[type]/[id]/sensitivity-label  (F20/F21 protection)
 *        Applies (or changes) the sensitivity label with two protections wired
 *        to real backends:
 *
 *          F20 — Change-label rights gate. If the item currently carries a
 *                PROTECTED label (Graph beta `hasProtection`), the caller must
 *                hold EXPORT or EDIT usage rights on that label (verified via
 *                Microsoft Graph) or the request is rejected 403. No Fabric
 *                dependency — pure Graph + Cosmos.
 *
 *          F21 — Label → RBAC enforcement. When a `principalId` is supplied,
 *                the new label's sensitivity tier is enforced as a REAL Azure
 *                RBAC grant on the item's backing store (ADLS container /
 *                Synapse pool / ADX db) via `enforceLabelRbac` →
 *                `enforceAccessGrant`. The resulting grant is persisted in
 *                `state.labelRbacGrant`.
 *
 *        Body:
 *          {
 *            labelId: string;                 // required — Graph sensitivity label id
 *            labelName?: string;              // optional — display name to persist
 *            principalId?: string;            // optional — Entra principal to (re)scope
 *            principalName?: string;          // optional — UPN/name (required for warehouse)
 *            principalType?: 'User'|'Group'|'ServicePrincipal';
 *          }
 *
 * Azure-native by default: there is NO Fabric/Power BI dependency. The label
 * taxonomy is Microsoft 365 / Purview Information Protection, reachable in
 * Commercial + GCC. In GCC-High / IL5 the Graph MIP surface is unavailable;
 * the route returns an honest 503 hint (and a gov-boundary note) so the
 * flyout renders the NotConfiguredBar rather than fabricating labels.
 */
import { NextRequest, NextResponse } from 'next/server';
import crypto from 'node:crypto';
import { getSession } from '@/lib/auth/session';
import {
  itemsContainer,
  workspacesContainer,
  auditLogContainer,
  labelAssignmentsContainer,
} from '@/lib/azure/cosmos-client';
import {
  listSensitivityLabels,
  getSensitivityLabel,
  MipNotConfiguredError,
  MipError,
  type SensitivityLabel,
} from '@/lib/azure/mip-graph-client';
import {
  isPurviewConfigured,
  registerAtlasEntity,
  getAssetDetail,
} from '@/lib/azure/purview-client';
import { isGovCloud } from '@/lib/azure/cloud-endpoints';
import { handleSecurityError } from '@/app/api/admin/security/_lib/error-handling';
import {
  isProtectedLabel,
  checkLabelChangeRights,
  enforceLabelRbac,
  resolveItemBackingScope,
} from '@/lib/azure/label-protection';
import type { Workspace, WorkspaceItem } from '@/lib/types/workspace';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function err(error: string, status: number, code?: string, extra?: Record<string, unknown>) {
  return NextResponse.json({ ok: false, error, code, ...(extra || {}) }, { status });
}

/** Find an item by id (cross-partition) + verify the caller's tenant owns its workspace. */
async function loadItem(itemId: string, type: string, tenantId: string): Promise<WorkspaceItem | null> {
  const items = await itemsContainer();
  const { resources } = await items.items
    .query<WorkspaceItem>({
      query: 'SELECT * FROM c WHERE c.id = @id AND c.itemType = @t',
      parameters: [
        { name: '@id', value: itemId },
        { name: '@t', value: type },
      ],
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

/** Map the MIP not-configured / upstream errors to a structured response. */
function mapMipError(e: unknown): NextResponse {
  if (e instanceof MipNotConfiguredError) {
    const gov = isGovCloud();
    const hint = { ...e.hint };
    if (gov) {
      hint.followUp =
        'Microsoft Graph Information Protection (sensitivity labels) is not available in the Azure Government (GCC-High / IL5) boundary. Apply and manage labels in the Microsoft Purview compliance portal; Loom will reflect a label once it is recorded on the item. ' +
        (hint.followUp || '');
    }
    return NextResponse.json(
      { ok: false, error: e.message, code: 'mip_not_configured', hint, gov },
      { status: 503 },
    );
  }
  if (e instanceof MipError) {
    const code = e.status >= 400 && e.status < 500 ? 'mip_client_error' : 'mip_upstream_error';
    const status = e.status >= 400 && e.status < 500 ? e.status : 502;
    return NextResponse.json(
      { ok: false, error: e.message, code, status: e.status, body: e.body, endpoint: e.endpoint },
      { status },
    );
  }
  return err((e as any)?.message || 'Failed to read sensitivity labels', 500, 'unexpected');
}

export async function GET(
  _req: NextRequest,
  props: { params: Promise<{ type: string; id: string }> },
) {
  const params = await props.params;
  const session = getSession();
  if (!session) return err('Unauthorized', 401, 'unauthorized');
  try {
    const item = await loadItem(params.id, params.type, session.claims.oid);
    if (!item) return err('Item not found', 404, 'not_found');

    let labels: SensitivityLabel[];
    try {
      labels = await listSensitivityLabels();
    } catch (e) {
      return mapMipError(e);
    }
    // Only labels that are active (published) make sense to show; keep
    // non-appliable ones visible but greyed (policy-blocked) in the UI.
    const visible = labels
      .filter((l) => l.isActive !== false && !!l.id)
      .sort((a, b) => (a.sensitivity ?? 0) - (b.sensitivity ?? 0));

    return NextResponse.json({
      ok: true,
      currentLabelId: (item.state?.sensitivityLabelId as string | undefined) ?? null,
      currentLabelName: (item.state?.sensitivityLabel as string | undefined) ?? null,
      hasPurviewAsset: !!(item.state?.purviewAssetGuid),
      labels: visible,
      source: 'graph-beta',
    });
  } catch (e: any) {
    return err(e?.message || 'Failed to load sensitivity labels', 500, 'cosmos_error');
  }
}

export async function PUT(req: NextRequest, props: { params: Promise<{ type: string; id: string }> }) {
  const params = await props.params;
  const session = getSession();
  if (!session) return err('Unauthorized', 401, 'unauthorized');

  let body: any;
  try {
    body = await req.json();
  } catch {
    return err('Invalid JSON', 400, 'bad_json');
  }
  const labelId = typeof body?.labelId === 'string' ? body.labelId.trim() : '';

  try {
    const item = await loadItem(params.id, params.type, session.claims.oid);
    if (!item) return err('Item not found', 404, 'not_found');

    const items = await itemsContainer();

    // --- Clear label -------------------------------------------------------
    if (!labelId) {
      const cleared = { ...(item.state || {}) };
      delete (cleared as any).sensitivityLabel;
      delete (cleared as any).sensitivityLabelId;
      const next: WorkspaceItem = {
        ...item,
        state: cleared,
        updatedAt: new Date().toISOString(),
      };
      await items.item(item.id, item.workspaceId).replace<WorkspaceItem>(next);
      await writeAudit(params, item, session, 'sensitivity-label-cleared', '(none)');
      return NextResponse.json({ ok: true, labelId: null, labelName: null, cleared: true });
    }

    // --- Apply label: validate against live taxonomy + policy --------------
    let labels: SensitivityLabel[];
    try {
      labels = await listSensitivityLabels();
    } catch (e) {
      return mapMipError(e);
    }
    const label = labels.find((l) => l.id === labelId);
    if (!label) {
      return err('Unknown sensitivity label', 400, 'label_not_found');
    }
    if (label.isAppliable === false) {
      const reason =
        label.tooltip ||
        label.description ||
        'A label policy in this tenant prevents this label from being applied manually.';
      return err('label_policy_blocked', 400, 'label_policy_blocked', { reason, labelId: label.id });
    }

    const labelName = label.displayName || label.name || labelId;

    const next: WorkspaceItem = {
      ...item,
      state: {
        ...(item.state || {}),
        sensitivityLabel: labelName,
        sensitivityLabelId: label.id,
      },
      updatedAt: new Date().toISOString(),
    };
    await items.item(item.id, item.workspaceId).replace<WorkspaceItem>(next);

    // --- Best-effort: stamp the label onto the Purview Atlas asset ---------
    let purviewStatus = 'skipped:no-asset';
    const assetGuid = item.state?.purviewAssetGuid as string | undefined;
    if (!assetGuid) {
      purviewStatus = 'skipped:no-asset';
    } else if (!isPurviewConfigured()) {
      purviewStatus = 'skipped:purview-not-configured';
    } else {
      try {
        const detail = await getAssetDetail(assetGuid);
        const entity = detail?.entity;
        const qn = entity?.attributes?.qualifiedName;
        if (entity?.typeName && qn) {
          await registerAtlasEntity({
            typeName: entity.typeName,
            qualifiedName: qn,
            displayName: entity.attributes?.name || item.displayName,
            attributes: {
              sensitivityLabel: labelName,
              sensitivityLabelId: label.id,
            },
          });
          purviewStatus = 'written';
        } else {
          purviewStatus = 'skipped:asset-not-found';
        }
      } catch (e: any) {
        purviewStatus = `error:${(e?.message || String(e)).slice(0, 120)}`;
      }
    }

    // --- Audit + tenant-partitioned assignment row -------------------------
    await writeAudit(params, item, session, 'sensitivity-label-applied', labelName);
    try {
      const la = await labelAssignmentsContainer();
      await la.items.create({
        id: crypto.randomUUID(),
        tenantId: session.claims.oid,
        itemId: params.id,
        itemType: params.type,
        workspaceId: item.workspaceId,
        labelId: label.id,
        labelName,
        appliedBy: session.claims.upn || session.claims.name || session.claims.oid,
        purviewStatus,
        at: new Date().toISOString(),
      });
    } catch {
      /* assignment-tier write is non-fatal; the item.state write is the source of truth */
    }

    return NextResponse.json({ ok: true, labelId: label.id, labelName, purviewStatus });
  } catch (e: any) {
    return err(e?.message || 'Failed to apply sensitivity label', 500, 'cosmos_error');
  }
}

/**
 * PATCH — F20/F21 protected/label-based access control. Applies a label while
 * enforcing change-rights (F20) and propagating the new tier to real Azure
 * RBAC (F21).
 */
export async function PATCH(req: NextRequest, props: { params: Promise<{ type: string; id: string }> }) {
  const params = await props.params;
  const session = getSession();
  if (!session) return err('Unauthorized', 401, 'unauthorized');
  const callerUpn = session.claims.upn || session.claims.email || '';

  let body: any;
  try { body = await req.json(); } catch { return err('Invalid JSON', 400, 'bad_json'); }
  const labelId = typeof body?.labelId === 'string' ? body.labelId.trim() : '';
  if (!labelId) return err('labelId is required', 400, 'bad_input');

  try {
    const item = await loadItem(params.id, params.type, session.claims.oid);
    if (!item) return err('Item not found', 404, 'not_found');

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
            'protected_label_no_upn',
            { hint: 'Sign in with a user identity that carries a UPN, or have an administrator change this protected label.' },
          );
        }
        const gate = await checkLabelChangeRights(currentLabelId, currentLabel, callerUpn);
        if (!gate.allowed) {
          return err(gate.reason || 'You are not permitted to change this protected label.', 403, 'protected_label_denied', { hint: gate.hint });
        }
      }
    }

    // ── Resolve the NEW label (must exist).
    const newLabel = await getSensitivityLabel(labelId);
    if (!newLabel) return err(`Sensitivity label "${labelId}" was not found.`, 400, 'label_not_found');
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

    await writeAudit(params, item, session, 'sensitivity-label-applied', labelName);

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
    return err(e?.message || 'Failed to apply sensitivity label', 500, 'cosmos_error');
  }
}

// Clearing via DELETE is an alias of PUT { labelId: '' } for REST symmetry.
export async function DELETE(_req: NextRequest, props: { params: Promise<{ type: string; id: string }> }) {
  const params = await props.params;
  const session = getSession();
  if (!session) return err('Unauthorized', 401, 'unauthorized');
  try {
    const item = await loadItem(params.id, params.type, session.claims.oid);
    if (!item) return err('Item not found', 404, 'not_found');
    const items = await itemsContainer();
    const cleared = { ...(item.state || {}) };
    delete (cleared as any).sensitivityLabel;
    delete (cleared as any).sensitivityLabelId;
    await items.item(item.id, item.workspaceId).replace<WorkspaceItem>({
      ...item,
      state: cleared,
      updatedAt: new Date().toISOString(),
    });
    await writeAudit(params, item, session, 'sensitivity-label-cleared', '(none)');
    return NextResponse.json({ ok: true, labelId: null, labelName: null, cleared: true });
  } catch (e: any) {
    return err(e?.message || 'Failed to clear sensitivity label', 500, 'cosmos_error');
  }
}

async function writeAudit(
  params: { type: string; id: string },
  item: WorkspaceItem,
  session: NonNullable<ReturnType<typeof getSession>>,
  action: string,
  summary: string,
) {
  try {
    const audit = await auditLogContainer();
    await audit.items.create({
      id: crypto.randomUUID(),
      itemId: params.id,
      itemType: params.type,
      workspaceId: item.workspaceId,
      userId: session.claims.oid,
      upn: session.claims.upn,
      action,
      summary,
      at: new Date().toISOString(),
    });
  } catch {
    /* audit write is best-effort */
  }
}
