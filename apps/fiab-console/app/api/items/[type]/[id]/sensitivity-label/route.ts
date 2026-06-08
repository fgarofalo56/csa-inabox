/**
 * Sensitivity-label flyout (F12) — manual label application to a Loom item.
 *
 *   GET  /api/items/[type]/[id]/sensitivity-label
 *        → { ok, currentLabelId, currentLabelName, labels[], source, gov }
 *        Live taxonomy from Microsoft Graph Information Protection
 *        (GET /beta/security/informationProtection/sensitivityLabels via
 *        mip-graph-client.listSensitivityLabels). Never a static list.
 *
 *   PUT  /api/items/[type]/[id]/sensitivity-label   body { labelId }
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
