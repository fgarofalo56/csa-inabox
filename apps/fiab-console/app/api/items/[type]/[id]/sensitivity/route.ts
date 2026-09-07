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
import { authorizeItemWorkspace } from '@/lib/auth/workspace-guard';
import crypto from 'node:crypto';
import { getSession, type SessionPayload } from '@/lib/auth/session';
import {
  itemsContainer,
  auditLogContainer,
} from '@/lib/azure/cosmos-client';
import {
  isPurviewConfigured,
  listSensitivityLabels,
  ensureClassificationDefs,
  addAssetClassification,
  PurviewNotConfiguredError,
  PurviewError,
  type DataMapSensitivityLabel,
} from '@/lib/azure/purview-client';
import { loomSensitivityLabelTypedefName } from '@/lib/azure/purview-typedef-namespace';
import { isGovCloud } from '@/lib/azure/cloud-endpoints';
import type { WorkspaceItem } from '@/lib/types/workspace';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * #3941 review - A ROUTE CEILING ABOVE THE GROUP WALK.
 *
 * This route's authorization moved from an owner-only point read to
 * `authorizeItemWorkspace`. The owner fast path short-circuits, so a caller who
 * created the workspace pays nothing new - but the population this migration
 * newly ADMITS (non-owner ACL members and tenant admins) is exactly the one
 * that falls through to `resolveEffectiveRole`, which walks group assignments
 * SEQUENTIALLY with no walk-wide ceiling (#3834). 71 other console routes
 * declare a bound; not one of these ten did, so the widening landed on the
 * routes with no ceiling at all.
 *
 * WHAT THIS DOES AND DOES NOT ESTABLISH (deploy-integrity.md R7): it bounds the
 * REQUEST. It does NOT bound the walk - #3834 is still open, and a slow walk
 * still consumes the whole budget before the request is cut off. This turns an
 * unbounded hang into a bounded failure; it is not a fix for #3834.
 */
export const maxDuration = 60;

function err(error: string, status: number, code?: string, extra?: Record<string, unknown>) {
  return NextResponse.json({ ok: false, error, code, ...(extra || {}) }, { status });
}

/**
 * Find an item by id (cross-partition) + AUTHORIZE the caller against its parent
 * workspace through the canonical ladder (#3941). Read-scoped for GET, write-
 * scoped for every mutating verb. This REPLACES an owner-only partition point
 * read that admitted only the workspace CREATOR, so the admitted set strictly
 * GROWS: tenant admins and shared-ACL members with the right role now pass.
 */
async function loadItem(
  itemId: string,
  type: string,
  session: SessionPayload,
  // #3941 review - NAMED, not a bare positional boolean. This argument
  // selects the AUTHORIZATION scope: `true` admits read-only workspace
  // roles, `false` restricts to the write-capable ones. As a positional
  // `boolean` a transposed argument would silently widen a mutation with no
  // compiler complaint, and every call site read `..., session, { allowReadRoles: false })` with
  // nothing on screen saying which way `false` pointed.
  { allowReadRoles }: { allowReadRoles: boolean },
): Promise<{ item: WorkspaceItem | null; denied: NextResponse | null }> {
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
  if (!item) return { item: null, denied: null };
  // #3941 - the canonical ladder, replacing the owner-only partition point read
  // this helper used to do. `workspaces` is partitioned on `/tenantId`, which
  // holds the workspace CREATOR's oid, so `ws.item(workspaceId, callerOid)`
  // could only answer "did YOU create this workspace?" - it refused tenant
  // admins and shared-ACL members on every item type with no dedicated route
  // (the #2941/#2942 defect). `authorizeItemWorkspace` answers "may you ACCESS
  // it?", scoped: read roles for GET, write-capable only for the mutations.
  const denied = await authorizeItemWorkspace(session, {
    workspaceId: item.workspaceId,
    itemId,
    itemType: type,
    allowReadRoles,
    notFound: 'Item not found',
  });
  // An ORDINARY refusal (404) collapses to `null` so the route keeps its own
  // not-found wording, which is what its clients already render. The 409
  // `tenant_unconfirmed` refusal does NOT: flattening it into "item not found"
  // would state that the item does not exist, which the code did not establish
  // - the workspace document WAS read and the admin rights ARE real
  // (deploy-integrity.md R7). It is handed back for the route to return.
  if (denied) return { item: null, denied: denied.status === 404 ? null : denied };
  return { item, denied: null };
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
    const { item, denied } = await loadItem(params.id, params.type, session, { allowReadRoles: true });
    if (denied) return denied;
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
    const { item, denied } = await loadItem(params.id, params.type, session, { allowReadRoles: false });
    if (denied) return denied;
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
      // `labelId` arrives from the request body UNVALIDATED, and Atlas typedefs
      // are ACCOUNT-GLOBAL + permanent — interpolating it straight into
      // `MICROSOFT.GOVERNANCE.LABELS.` squatted the namespace Purview's own MIP
      // integration owns with whatever the caller typed. The authority emits
      // that name ONLY for a real MIP GUID and otherwise falls back to a
      // Loom-owned, tenant-namespaced `LOOM.LABEL.<t8>.<SLUG>`.
      const typedefName = loomSensitivityLabelTypedefName(session.claims.oid, { labelId, labelName });
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
