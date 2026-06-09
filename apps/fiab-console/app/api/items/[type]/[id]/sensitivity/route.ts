/**
 * Purview MIP sensitivity-label routes for a Loom workspace item (Data Map flavour).
 *
 *   GET  /api/items/[type]/[id]/sensitivity
 *        → { ok, currentLabelId, currentLabelName, labels[], hasPurviewAsset, source, gov }
 *        Live MIP label taxonomy from the Microsoft Purview CLASSIC Data Map —
 *        Atlas classification typedefs named `MICROSOFT.GOVERNANCE.LABELS.<guid>`
 *        (purview-client.listSensitivityLabels). NEVER a static list.
 *
 *   PUT  /api/items/[type]/[id]/sensitivity   body { labelId, labelName? }
 *        → persists the selected label to the Cosmos item doc
 *          (item.state.sensitivityLabel + sensitivityLabelId) AND, when Purview
 *          is configured and the item carries a Purview Atlas entity GUID,
 *          tags that entity with the label classification (ensureClassificationDefs
 *          + addAssetClassification). body { labelId: '' } clears the label.
 *
 * Why this route exists alongside /sensitivity-label:
 *   - /sensitivity-label  → Microsoft GRAPH Information Protection (beta). Works
 *                           in Commercial + GCC; unavailable in GCC-High / IL5.
 *   - /sensitivity (this) → Microsoft Purview CLASSIC Data Map. The Data Map data
 *                           plane is reachable in Commercial, GCC AND GCC-High
 *                           (`*.purview.azure.us`). It is the correct surface for
 *                           a deployment that provisions a Purview account.
 *
 * Per-cloud behaviour (no Microsoft Fabric / Power BI dependency anywhere):
 *   - Commercial / GCC : Data Map on `*.purview.azure.com`. Cosmos write + Atlas tag.
 *   - GCC-High         : Data Map on `*.purview.azure.us`. Cosmos write + Atlas tag.
 *   - IL5              : Purview not deployed (LOOM_PURVIEW_ACCOUNT unset). The
 *                        label store is Cosmos ONLY. GET returns an honest 503
 *                        naming LOOM_PURVIEW_ACCOUNT (+ a gov note that MIP is
 *                        unavailable in IL5); PUT still writes Cosmos and returns
 *                        purviewStatus:'skipped:purview_not_configured'.
 *
 * Azure-native default, honest gate per .claude/rules/no-vaporware.md +
 * .claude/rules/no-fabric-dependency.md. No mock arrays, no dead controls.
 */
import { NextRequest, NextResponse } from 'next/server';
import crypto from 'node:crypto';
import { getSession } from '@/lib/auth/session';
import {
  itemsContainer,
  workspacesContainer,
  auditLogContainer,
} from '@/lib/azure/cosmos-client';
import {
  isPurviewConfigured,
  listSensitivityLabels,
  ensureClassificationDefs,
  addAssetClassification,
  SENSITIVITY_LABEL_TYPEDEF_PREFIX,
  PurviewNotConfiguredError,
  PurviewError,
  type DataMapSensitivityLabel,
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

/**
 * Map a PurviewNotConfiguredError (LOOM_PURVIEW_ACCOUNT unset) into a structured
 * 503 the flyout renders as a Fluent MessageBar naming the env var. In Gov
 * boundaries it adds a note that the Cosmos catalog remains the label store and
 * MIP tagging is unavailable until a Purview account is onboarded.
 */
function mapPurviewNotConfigured(e?: PurviewNotConfiguredError): NextResponse {
  const gov = isGovCloud();
  const hint = e?.hint;
  const govNote = gov
    ? 'In the Azure Government (GCC-High / IL5) boundary where Microsoft Purview is not ' +
      'deployed, the sensitivity label is stored in the Loom catalog (Cosmos) only and MIP ' +
      'tagging of the Data Map entity is unavailable. Set LOOM_PURVIEW_ACCOUNT to a provisioned ' +
      'Purview Data Map account to enable Atlas entity tagging.'
    : undefined;
  return NextResponse.json(
    {
      ok: false,
      error: e?.message || 'Microsoft Purview is not configured (LOOM_PURVIEW_ACCOUNT unset).',
      code: 'purview_not_configured',
      hint,
      gov,
      govNote,
    },
    { status: 503 },
  );
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

    if (!isPurviewConfigured()) {
      return mapPurviewNotConfigured();
    }

    let labels: DataMapSensitivityLabel[];
    try {
      labels = await listSensitivityLabels();
    } catch (e) {
      if (e instanceof PurviewNotConfiguredError) return mapPurviewNotConfigured(e);
      if (e instanceof PurviewError) {
        const status = e.status >= 400 && e.status < 500 ? e.status : 502;
        return NextResponse.json(
          { ok: false, error: e.message, code: 'purview_upstream', status: e.status, body: e.body },
          { status },
        );
      }
      throw e;
    }

    return NextResponse.json({
      ok: true,
      currentLabelId: (item.state?.sensitivityLabelId as string | undefined) ?? null,
      currentLabelName: (item.state?.sensitivityLabel as string | undefined) ?? null,
      labels,
      hasPurviewAsset: !!item.state?.purviewAssetGuid,
      source: 'purview-datamap',
      gov: isGovCloud(),
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
      await items.item(item.id, item.workspaceId).replace<WorkspaceItem>({
        ...item,
        state: cleared,
        updatedAt: new Date().toISOString(),
      });
      await writeAudit(params, item, session, 'sensitivity-label-cleared', '(none)');
      return NextResponse.json({ ok: true, labelId: null, labelName: null, cleared: true, purviewStatus: 'skipped:cleared' });
    }

    const labelName =
      (typeof body?.labelName === 'string' && body.labelName.trim()) || labelId;

    // --- Persist to the Cosmos item doc (authoritative label store) --------
    const next: WorkspaceItem = {
      ...item,
      state: {
        ...(item.state || {}),
        sensitivityLabel: labelName,
        sensitivityLabelId: labelId,
      },
      updatedAt: new Date().toISOString(),
    };
    await items.item(item.id, item.workspaceId).replace<WorkspaceItem>(next);

    // --- Best-effort: tag the Purview Atlas entity with the label ----------
    // Azure-native default: the Cosmos write above already succeeded. Atlas
    // tagging is an enrichment that is skipped (honestly reported) when there
    // is no bound asset or Purview is not configured (e.g. IL5).
    let purviewStatus = 'skipped:no-asset';
    const assetGuid = item.state?.purviewAssetGuid as string | undefined;
    if (!isPurviewConfigured()) {
      purviewStatus = 'skipped:purview_not_configured';
    } else if (!assetGuid) {
      purviewStatus = 'skipped:no-asset';
    } else {
      const typedefName = `${SENSITIVITY_LABEL_TYPEDEF_PREFIX}${labelId}`;
      try {
        await ensureClassificationDefs([typedefName]);
        await addAssetClassification(assetGuid, [typedefName]);
        purviewStatus = 'written';
      } catch (e: any) {
        purviewStatus = `error:${(e?.message || String(e)).slice(0, 120)}`;
      }
    }

    await writeAudit(params, item, session, 'sensitivity-label-applied', labelName);

    return NextResponse.json({ ok: true, labelId, labelName, purviewStatus });
  } catch (e: any) {
    return err(e?.message || 'Failed to apply sensitivity label', 500, 'cosmos_error');
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
