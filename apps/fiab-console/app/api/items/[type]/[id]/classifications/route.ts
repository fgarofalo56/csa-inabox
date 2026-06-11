/**
 * Item-level data CLASSIFICATIONS, read from the tenant label taxonomy.
 *
 *   GET  /api/items/[type]/[id]/classifications
 *        → { ok, classifications: string[], taxonomy: TaxonomyEntry[],
 *            purviewConfigured, hasPurviewAsset, gov }
 *        `classifications` = the labels currently applied to this item
 *        (item.state.classifications). `taxonomy` = the tenant's standard label
 *        set served by /api/governance/classification-types (Cosmos
 *        tenant-settings doc `classification-types:<tenantId>`). The picker is
 *        ALWAYS bound to this taxonomy — never free-text (see
 *        .claude/rules/loom-no-freeform-config.md).
 *
 *   PUT  /api/items/[type]/[id]/classifications   body { classifications: string[] }
 *        → validates every value is a member of the tenant taxonomy (rejects
 *          unknowns with 400 `unknown_classification` — this is what enforces
 *          "not free-text" on the server), normalises to the taxonomy's casing,
 *          persists to the Cosmos item doc (item.state.classifications), writes
 *          an audit row, and — best-effort, when Microsoft Purview is configured
 *          AND the item carries a Purview Atlas entity GUID — tags that entity
 *          with the matching Atlas classifications (ensureClassificationDefs +
 *          addAssetClassification). body { classifications: [] } clears them.
 *
 * Why a dedicated route (mirrors ./sensitivity/route.ts):
 *   - Classifications are distinct from sensitivity labels in Microsoft Purview
 *     (Learn: data-map-classification). This route owns the classification
 *     surface; ./sensitivity owns the MIP label surface.
 *   - The authoritative store is the Loom catalog (Cosmos) in EVERY cloud, so
 *     the feature is 100% functional with NO Microsoft Fabric / Power BI / real
 *     Purview dependency (.claude/rules/no-fabric-dependency.md). Purview Atlas
 *     tagging is a pure enrichment layered on top when available.
 *
 * Per-cloud behaviour for the optional Atlas enrichment:
 *   - Commercial / GCC : Data Map on `*.purview.azure.com`.
 *   - GCC-High         : Data Map on `*.purview.azure.us`.
 *   - IL5              : Purview not deployed (LOOM_PURVIEW_ACCOUNT unset) →
 *                        Cosmos-only; purviewStatus 'skipped:purview_not_configured'.
 */
import { NextRequest, NextResponse } from 'next/server';
import crypto from 'node:crypto';
import { getSession } from '@/lib/auth/session';
import {
  itemsContainer,
  workspacesContainer,
  auditLogContainer,
  tenantSettingsContainer,
} from '@/lib/azure/cosmos-client';
import {
  isPurviewConfigured,
  ensureClassificationDefs,
  addAssetClassification,
} from '@/lib/azure/purview-client';
import { isGovCloud } from '@/lib/azure/cloud-endpoints';
import type { Workspace, WorkspaceItem } from '@/lib/types/workspace';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Atlas classification typedef name for a Loom taxonomy label (valid, stable). */
const CLASSIFICATION_TYPEDEF_PREFIX = 'LOOM.CLASSIFICATION.';
export function classificationTypedefName(name: string): string {
  return CLASSIFICATION_TYPEDEF_PREFIX + name.trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

interface TaxonomyEntry { name: string; sensitivity?: string; color?: string; description?: string; }
interface TypesDoc { items?: Array<{ name: string; sensitivity?: string; color?: string; description?: string }>; }

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
 * Read the tenant's classification taxonomy from the same Cosmos doc the
 * Governance → Classifications admin page writes (`classification-types:<tid>`).
 * Read-only here (the admin route owns seeding); returns [] when unset so the
 * pane shows an honest empty state deep-linking to the admin page.
 */
async function loadTaxonomy(tenantId: string): Promise<TaxonomyEntry[]> {
  const c = await tenantSettingsContainer();
  try {
    const { resource } = await c.item(`classification-types:${tenantId}`, tenantId).read<TypesDoc>();
    const items = resource?.items || [];
    return items
      .filter((t) => t && typeof t.name === 'string' && t.name.trim())
      .map((t) => ({ name: t.name, sensitivity: t.sensitivity, color: t.color, description: t.description }));
  } catch (e: any) {
    if (e?.code === 404) return [];
    throw e;
  }
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

    const taxonomy = await loadTaxonomy(session.claims.oid);
    const current = Array.isArray(item.state?.classifications)
      ? (item.state!.classifications as unknown[]).map(String)
      : [];

    return NextResponse.json({
      ok: true,
      classifications: current,
      taxonomy,
      purviewConfigured: isPurviewConfigured(),
      hasPurviewAsset: !!item.state?.purviewAssetGuid,
      gov: isGovCloud(),
    });
  } catch (e: any) {
    return err(e?.message || 'Failed to load classifications', 500, 'cosmos_error');
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
  if (!Array.isArray(body?.classifications)) {
    return err('classifications must be an array of label names', 400, 'bad_request');
  }
  const requested = [
    ...new Set((body.classifications as unknown[]).map((c) => String(c).trim()).filter(Boolean)),
  ];

  try {
    const item = await loadItem(params.id, params.type, session.claims.oid);
    if (!item) return err('Item not found', 404, 'not_found');

    // --- Enforce "not free-text": every value must be in the tenant taxonomy.
    const taxonomy = await loadTaxonomy(session.claims.oid);
    const byLower = new Map(taxonomy.map((t) => [t.name.toLowerCase(), t.name]));
    const unknown = requested.filter((r) => !byLower.has(r.toLowerCase()));
    if (unknown.length) {
      return err(
        `These values are not in the tenant classification taxonomy: ${unknown.join(', ')}. ` +
          'Add them in Governance → Classifications first.',
        400,
        'unknown_classification',
        { unknown, taxonomy: taxonomy.map((t) => t.name) },
      );
    }
    // Normalise to the taxonomy's canonical casing.
    const normalized = requested.map((r) => byLower.get(r.toLowerCase())!);

    const items = await itemsContainer();
    const nextState = { ...(item.state || {}) };
    if (normalized.length) (nextState as any).classifications = normalized;
    else delete (nextState as any).classifications;

    await items.item(item.id, item.workspaceId).replace<WorkspaceItem>({
      ...item,
      state: nextState,
      updatedAt: new Date().toISOString(),
    });

    // --- Best-effort Purview Atlas enrichment (Azure-native default already
    // persisted above). Skipped + honestly reported when there is no bound
    // asset, no classifications, or Purview is not configured (e.g. IL5).
    let purviewStatus = 'skipped:no-classifications';
    const assetGuid = item.state?.purviewAssetGuid as string | undefined;
    if (!normalized.length) {
      purviewStatus = 'skipped:cleared';
    } else if (!isPurviewConfigured()) {
      purviewStatus = 'skipped:purview_not_configured';
    } else if (!assetGuid) {
      purviewStatus = 'skipped:no-asset';
    } else {
      const typedefs = normalized.map(classificationTypedefName);
      try {
        await ensureClassificationDefs(typedefs);
        await addAssetClassification(assetGuid, typedefs);
        purviewStatus = 'written';
      } catch (e: any) {
        purviewStatus = `error:${(e?.message || String(e)).slice(0, 120)}`;
      }
    }

    await writeAudit(
      params,
      item,
      session,
      'classifications-updated',
      normalized.length ? normalized.join(', ') : '(none)',
    );

    return NextResponse.json({ ok: true, classifications: normalized, purviewStatus });
  } catch (e: any) {
    return err(e?.message || 'Failed to update classifications', 500, 'cosmos_error');
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
