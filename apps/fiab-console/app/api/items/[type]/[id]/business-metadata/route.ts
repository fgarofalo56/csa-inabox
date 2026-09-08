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
import { authorizeItemWorkspace } from '@/lib/auth/workspace-guard';
import crypto from 'node:crypto';
import type { SessionPayload } from '@/lib/auth/session';
import { tenantScopeId } from '@/lib/auth/session';
import {
  itemsContainer,
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
import type { WorkspaceItem } from '@/lib/types/workspace';
import { safeRecordFrom, UnsafeKeyError } from '@/lib/util/safe-keys';

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
 * WHAT THIS DOES AND DOES NOT ESTABLISH (deploy-integrity.md R7): it DECLARES a
 * bound - it does not, on this deployment, enforce one, and the earlier wording
 * here ("it bounds the REQUEST") asserted an effect that was not established
 * (#4357 review item 3). `maxDuration` is a build-time segment config: measured
 * in next@15.5.21, every reference under `node_modules/next/dist` sits in
 * `build/` (segment-config collection, the build manifest, the types plugin) or
 * in typegen - nothing under `next/dist/server` reads it on the request path, so
 * the standalone server this console ships as does not cut the request off at
 * 60s. Enforcement belongs to the hosting platform, and that the console's
 * Container Apps runtime performs it was NOT established. What the line does buy
 * is the declared bound the house convention expects - 71 other console routes
 * carry one and not one of these ten did - so any platform that does read it
 * bounds these routes like the rest. It does not bound the group walk either
 * way: #3834 is still open.
 */
export const maxDuration = 60;

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

/**
 * Find an item by id (cross-partition) + AUTHORIZE the caller against its parent
 * workspace through the canonical ladder (#3941). Read-scoped for GET, write-
 * scoped for every mutating verb. This REPLACES an owner-only partition point
 * read that admitted only the workspace CREATOR, so for any item row carrying a
 * workspaceId the admitted set GROWS: tenant admins and shared-ACL members with
 * the right role now pass.
 *
 * ONE DIRECTION IS NOT MONOTONE, named because "strictly GROWS" was the wrong
 * word for it (#4357 review item 2). When an item row's `workspaceId` is FALSY,
 * `authorizeItemWorkspace` resolves no workspace and returns null — an ALLOW the
 * role resolver never sees (workspace-guard.ts, the `if (!workspaceId) return
 * null` prologue). The owner-only point read this replaced did
 * `ws.item(item.workspaceId, tenantId).read()`, which on a falsy id 404s or
 * throws, so the helper REFUSED. That one row shape therefore moves from refuse
 * to proceed. `items` is partitioned on `/workspaceId` (cosmos-client.ts), so a
 * row with a falsy one is close to unreachable, and the ALLOW is the shared
 * helper's own pre-existing, cross-cutting behaviour — not introduced here. It
 * is disclosed rather than smoothed over (deploy-integrity.md R7).
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
    const { item, denied } = await loadItem(params.id, params.type, session, { allowReadRoles: true });
    if (denied) return denied;
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
    const { item, denied } = await loadItem(params.id, params.type, session, { allowReadRoles: false });
    if (denied) return denied;
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
