/**
 * Item-level free-form CUSTOM TAGS, modeled as Microsoft Purview Atlas
 * BUSINESS METADATA (a.k.a. managed attributes — the classic Data Map's
 * structured key/value bag on an asset).
 *
 *   GET  /api/items/[type]/[id]/business-metadata
 *        → { ok, configured, hasAsset, name, attributes: Record<string,string>, gov }
 *        Reads the item's Atlas entity (resolved from
 *        item.state.purviewAssetGuid / purviewGuid) and returns the custom-tag
 *        bag stored under this TENANT's `LoomCustomTags_<t8>` namespace, with
 *        the legacy account-global `LoomCustomTags` bag merged UNDERNEATH it.
 *
 *   POST /api/items/[type]/[id]/business-metadata   body { attributes: Record<string,string> }
 *        → ensureBusinessMetadataDef(keys, bag) (grows the TENANT bag with any
 *          new keys) then setBusinessMetadata(guid, attributes, bag)
 *          (isOverwrite=true), then re-reads the entity so the response
 *          reflects backend truth.
 *
 * WHY THE BAG IS TENANT-NAMESPACED (issue #2633)
 * ---------------------------------------------------------------------------
 * An Atlas business-metadata typedef is ACCOUNT-GLOBAL, while a Loom "tenant"
 * is only a Cosmos partition. This route used to write the bare `LoomCustomTags`
 * bag with `isOverwrite=true`, which REPLACES the whole bag on the entity — so
 * on a Purview account shared by two Loom tenants, tenant B saving a tag on an
 * asset silently destroyed tenant A's tags on that same asset, and every
 * tenant-authored key was added PERMANENTLY to the shared typedef where every
 * other tenant could see it. It now writes `LoomCustomTags_<t8>`, the same
 * per-tenant bag the LU-5 governance overlay already uses
 * (`model.tenantBusinessMetadataName`), minted through the typedef-namespace
 * authority so the account-global bag is not even expressible here.
 *
 * MIGRATION — READ BOTH, TENANT BAG WINS, DELETES TOMBSTONE
 * ---------------------------------------------------------------------------
 * Values written before this change live in the bare bag, so a bare rename
 * would orphan them. Instead:
 *   - GET merges `{...legacyBag, ...tenantBag}` — the tenant bag wins per key.
 *   - POST writes the caller's full set to the tenant bag AND an explicit `''`
 *     for every legacy key the caller dropped. Without that tombstone, deleting
 *     a pre-migration tag would appear to work and then be resurrected by the
 *     legacy fallback on the very next read (the legacy bag is not writable, so
 *     the key cannot be removed at the source). `''` in the tenant bag over a
 *     key that exists in the legacy bag therefore reads as "deleted" — which
 *     also means a pre-migration key cannot be kept with a deliberately EMPTY
 *     value; blanking it deletes it. That trade is deliberate: a governance
 *     surface may not silently un-delete a tag.
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
import type { SessionPayload } from '@/lib/auth/session';
import { tenantScopeId } from '@/lib/auth/session';
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
  businessMetadataAttrName,
  LOOM_BUSINESS_METADATA_NAME,
} from '@/lib/azure/purview-client';
import {
  loomTenantBusinessMetadataName,
  type AtlasBusinessMetadataName,
} from '@/lib/azure/purview-typedef-namespace';
import { isGovCloud } from '@/lib/azure/cloud-endpoints';
import { safeRecord, toSafeStringMap, safeGet } from '@/lib/security/safe-object';
import { withSession } from '@/lib/api/route-toolkit';
import type { Workspace, WorkspaceItem } from '@/lib/types/workspace';
import { safeRecordFrom, UnsafeKeyError } from '@/lib/util/safe-keys';

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

/**
 * One business-metadata bag off an Atlas entity, null-prototype coerced.
 * These keys are the tag names a caller previously wrote, echoed back by
 * Purview, so they are caller-authored too and must not be able to shadow an
 * inherited member of the returned map — hence `safeGet` + `toSafeStringMap`.
 */
function bagOf(detail: any, name: string): Record<string, string> {
  return toSafeStringMap(safeGet<unknown>(detail?.entity?.businessAttributes, name)) ?? safeRecord<string>();
}

/**
 * The item's custom tags = the TENANT bag laid over the LEGACY account-global
 * bag (#2633). The tenant bag wins per key, and a `''` there over a key that
 * exists in the legacy bag is a TOMBSTONE (the POST writes one for every legacy
 * key the caller dropped) — see the module header.
 */
function tagsFromDetail(detail: any, bmName: AtlasBusinessMetadataName): Record<string, string> {
  const legacy = bagOf(detail, LOOM_BUSINESS_METADATA_NAME);
  const mine = bagOf(detail, bmName);
  const out = safeRecord<string>();
  for (const [k, v] of Object.entries(legacy)) out[k] = v;
  for (const [k, v] of Object.entries(mine)) {
    if (v === '' && Object.prototype.hasOwnProperty.call(legacy, k)) delete out[k];
    else out[k] = v;
  }
  return out;
}

export const GET = withSession<{ type: string; id: string }>(async (_req, { session, params }) => {
  const bmName = loomTenantBusinessMetadataName(tenantScopeId(session));
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
        name: bmName,
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
        name: bmName,
        attributes: {},
        gov,
      });
    }

    let attributes: Record<string, string> = {};
    try {
      const detail = await getAssetDetail(guid);
      attributes = tagsFromDetail(detail, bmName);
    } catch (e: any) {
      // Asset may not be scanned yet, or the GUID is stale — surface honestly
      // but do not 500 the pane.
      return NextResponse.json({
        ok: true,
        configured: true,
        hasAsset: true,
        name: bmName,
        attributes: {},
        warning: (e?.message || String(e)).slice(0, 200),
        gov,
      });
    }

    return NextResponse.json({
      ok: true,
      configured: true,
      hasAsset: true,
      name: bmName,
      attributes,
      gov,
    });
  } catch (e: any) {
    return err(e?.message || 'Failed to load custom tags', 500, 'cosmos_error');
  }
});

export const POST = withSession<{ type: string; id: string }>(async (req, { session, params }) => {
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
  // #2657 — the keys here come straight from the request body, and a raw
  // `attributes[key] = ...` would let `__proto__` REPLACE this object's prototype
  // instead of storing an attribute. safeRecordFrom refuses the three reserved
  // names and returns a null-prototype bag that cannot be polluted later.
  const pairs: Array<[string, string]> = [];
  for (const [k, v] of Object.entries(body.attributes as Record<string, unknown>)) {
    const key = String(k).trim();
    if (!key) continue;
    pairs.push([key, v == null ? '' : String(v)]);
  }
  let attributes: Record<string, string>;
  try {
    attributes = safeRecordFrom(pairs);
  } catch (e) {
    if (e instanceof UnsafeKeyError) {
      return err(e.message, 400, 'invalid_attribute_key');
    }
    throw e;
  }

  const bmName = loomTenantBusinessMetadataName(tenantScopeId(session));
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
    // #2633 — write the TENANT bag (`LoomCustomTags_<t8>`), never the
    // account-global one. `isOverwrite=true` replaces the whole bag, so writing
    // the shared one would destroy every other tenant's tags on this asset.
    //
    // Tombstones: the legacy bag is read-only now, so a pre-migration key the
    // caller dropped cannot be removed at its source. Write `''` for it in the
    // tenant bag instead — `tagsFromDetail` reads that as "deleted". Without
    // this, deleting a pre-migration tag would appear to succeed and then be
    // resurrected by the legacy fallback on the very next read.
    const toWrite = safeRecord<string>();
    for (const [k, v] of Object.entries(attributes)) toWrite[k] = v;
    try {
      const before = await getAssetDetail(guid);
      const kept = new Set(keys.map(businessMetadataAttrName));
      for (const legacyKey of Object.keys(bagOf(before, LOOM_BUSINESS_METADATA_NAME))) {
        if (!kept.has(legacyKey)) toWrite[legacyKey] = '';
      }
    } catch {
      // Pre-read is best-effort: on failure we simply write no tombstones. The
      // caller's tags still land; a dropped pre-migration key may reappear.
    }

    const writeKeys = Object.keys(toWrite);
    // Grow the tenant bag's typedef with any new keys, then overwrite it.
    // (setBusinessMetadata also ensures the def, but we call it explicitly per
    // the route contract.)
    await ensureBusinessMetadataDef(writeKeys, bmName);
    await setBusinessMetadata(guid, toWrite, bmName);

    // Re-read so the response reflects backend truth (e.g. an all-empty save is
    // a no-op on the existing bag — the UI must see what actually persisted).
    let saved: Record<string, string> = attributes;
    try {
      const detail = await getAssetDetail(guid);
      saved = tagsFromDetail(detail, bmName);
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
      name: bmName,
      attributes: saved,
    });
  } catch (e: any) {
    return err(e?.message || 'Failed to save custom tags', 500, 'purview_error');
  }
});

async function writeAudit(
  params: { type: string; id: string },
  item: WorkspaceItem,
  session: SessionPayload,
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
