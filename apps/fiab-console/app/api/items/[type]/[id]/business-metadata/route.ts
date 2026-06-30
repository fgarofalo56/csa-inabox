/**
 * Item-level free-form CUSTOM TAGS, modeled as Microsoft Purview Atlas
 * BUSINESS METADATA (a.k.a. managed attributes — the classic Data Map's
 * structured key/value bag on an asset).
 *
 *   GET  /api/items/[type]/[id]/business-metadata
 *        → { ok, configured, hasAsset, name, attributes: Record<string,string>, gov }
 *        Reads the item's Atlas entity (resolved from
 *        item.state.purviewAssetGuid / purviewGuid) and returns the custom-tag
 *        bag stored under the `LoomCustomTags` business-metadata namespace.
 *
 *   POST /api/items/[type]/[id]/business-metadata   body { attributes: Record<string,string> }
 *        → ensureBusinessMetadataDef(keys) (grows the typedef with any new keys)
 *          then setBusinessMetadata(guid, attributes) (isOverwrite=true), then
 *          re-reads the entity so the response reflects backend truth.
 *
 * Why a dedicated route (mirrors ./classifications/route.ts):
 *   - Custom tags are Atlas business metadata — a distinct surface from
 *     classifications (label typedefs) and the glossary (term assignments).
 *   - Unlike classifications, business metadata has NO Loom-catalog (Cosmos)
 *     analogue: it is a pure Microsoft Purview Data Map enrichment. So this
 *     surface is an HONEST infra-gate when Purview is not configured
 *     (LOOM_PURVIEW_ACCOUNT unset) or the item is not yet cataloged (no bound
 *     Atlas GUID). That's an Azure-side requirement, not a Microsoft Fabric one
 *     (.claude/rules/no-fabric-dependency.md / no-vaporware.md).
 *
 * Per-cloud behaviour:
 *   - Commercial / GCC : Data Map on `*.purview.azure.com`.
 *   - GCC-High         : Data Map on `*.purview.azure.us`.
 *   - IL5              : Purview not deployed (LOOM_PURVIEW_ACCOUNT unset) →
 *                        honest gate, configured:false.
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
  getAssetDetail,
  ensureBusinessMetadataDef,
  setBusinessMetadata,
  LOOM_BUSINESS_METADATA_NAME,
} from '@/lib/azure/purview-client';
import { isGovCloud } from '@/lib/azure/cloud-endpoints';
import type { Workspace, WorkspaceItem } from '@/lib/types/workspace';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const PURVIEW_HINT =
  'Custom tags are stored on the asset in Microsoft Purview. Set LOOM_PURVIEW_ACCOUNT ' +
  '(admin-plane/main.bicep apps[] env list) to the deployed account short name and grant the ' +
  'Console UAMI "Data Curator" on the root collection. See docs/fiab/purview-setup.md.';

function err(error: string, status: number, code?: string, extra?: Record<string, unknown>) {
  return NextResponse.json({ ok: false, error, code, ...(extra || {}) }, { status });
}

/** Resolve the item's bound Atlas entity GUID (set at catalog onboarding/scan). */
function assetGuidOf(item: WorkspaceItem): string | null {
  const s = item.state || {};
  return (
    ((s as any).purviewAssetGuid as string | undefined) ||
    ((s as any).purviewGuid as string | undefined) ||
    null
  );
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

/** Pull the custom-tag bag out of an Atlas entity's businessAttributes map. */
function tagsFromDetail(detail: any): Record<string, string> {
  const bag = detail?.entity?.businessAttributes?.[LOOM_BUSINESS_METADATA_NAME];
  const out: Record<string, string> = {};
  if (bag && typeof bag === 'object') {
    for (const [k, v] of Object.entries(bag)) {
      if (k) out[k] = v == null ? '' : String(v);
    }
  }
  return out;
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

    const gov = isGovCloud();
    // Honest gate — Purview not configured in this deployment (no Cosmos fallback
    // for business metadata; it is a pure Data Map enrichment).
    if (!isPurviewConfigured()) {
      return NextResponse.json({
        ok: false,
        configured: false,
        hasAsset: false,
        name: LOOM_BUSINESS_METADATA_NAME,
        attributes: {},
        hint: PURVIEW_HINT,
        gov,
      });
    }

    const guid = assetGuidOf(item);
    if (!guid) {
      return NextResponse.json({
        ok: true,
        configured: true,
        hasAsset: false,
        name: LOOM_BUSINESS_METADATA_NAME,
        attributes: {},
        gov,
      });
    }

    let attributes: Record<string, string> = {};
    try {
      const detail = await getAssetDetail(guid);
      attributes = tagsFromDetail(detail);
    } catch (e: any) {
      // Asset may not be scanned yet, or the GUID is stale — surface honestly
      // but do not 500 the pane.
      return NextResponse.json({
        ok: true,
        configured: true,
        hasAsset: true,
        name: LOOM_BUSINESS_METADATA_NAME,
        attributes: {},
        warning: (e?.message || String(e)).slice(0, 200),
        gov,
      });
    }

    return NextResponse.json({
      ok: true,
      configured: true,
      hasAsset: true,
      name: LOOM_BUSINESS_METADATA_NAME,
      attributes,
      gov,
    });
  } catch (e: any) {
    return err(e?.message || 'Failed to load custom tags', 500, 'cosmos_error');
  }
}

export async function POST(req: NextRequest, props: { params: Promise<{ type: string; id: string }> }) {
  const params = await props.params;
  const session = getSession();
  if (!session) return err('Unauthorized', 401, 'unauthorized');

  let body: any;
  try {
    body = await req.json();
  } catch {
    return err('Invalid JSON', 400, 'bad_json');
  }
  if (!body || typeof body.attributes !== 'object' || body.attributes === null || Array.isArray(body.attributes)) {
    return err('attributes must be an object of { key: value } string pairs', 400, 'bad_request');
  }

  // Normalise to a clean { key: string-value } map; drop blank keys.
  const attributes: Record<string, string> = {};
  for (const [k, v] of Object.entries(body.attributes as Record<string, unknown>)) {
    const key = String(k).trim();
    if (!key) continue;
    attributes[key] = v == null ? '' : String(v);
  }

  try {
    const item = await loadItem(params.id, params.type, session.claims.oid);
    if (!item) return err('Item not found', 404, 'not_found');

    if (!isPurviewConfigured()) {
      return NextResponse.json({
        ok: false,
        configured: false,
        hasAsset: false,
        hint: PURVIEW_HINT,
      });
    }

    const guid = assetGuidOf(item);
    if (!guid) {
      return NextResponse.json({
        ok: false,
        configured: true,
        hasAsset: false,
        hint:
          'This item is not yet cataloged in Microsoft Purview, so custom tags cannot be ' +
          'written. The asset GUID is registered after the item is onboarded/scanned.',
      });
    }

    const keys = Object.keys(attributes);
    // Grow the LoomCustomTags business-metadata typedef with any new keys, then
    // overwrite the asset's tag bag. (setBusinessMetadata also ensures the def,
    // but we call it explicitly per the route contract.)
    await ensureBusinessMetadataDef(keys);
    await setBusinessMetadata(guid, attributes);

    // Re-read so the response reflects backend truth (e.g. an all-empty save is
    // a no-op on the existing bag — the UI must see what actually persisted).
    let saved: Record<string, string> = attributes;
    try {
      const detail = await getAssetDetail(guid);
      saved = tagsFromDetail(detail);
    } catch {
      /* re-read best-effort; fall back to the requested map */
    }

    await writeAudit(
      params,
      item,
      session,
      'custom-tags-updated',
      keys.length ? keys.join(', ') : '(none)',
    );

    return NextResponse.json({
      ok: true,
      configured: true,
      hasAsset: true,
      name: LOOM_BUSINESS_METADATA_NAME,
      attributes: saved,
    });
  } catch (e: any) {
    return err(e?.message || 'Failed to save custom tags', 500, 'purview_error');
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
