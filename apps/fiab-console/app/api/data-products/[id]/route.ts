/**
 * Data-product attribute BFF — partial-field PATCH + GET for the inline
 * right-rail attributes on the data-product details page.
 *
 *   GET   /api/data-products/[id]   → { ok, item } (Cosmos record)
 *   PATCH /api/data-products/[id]   → merge ONLY the supplied recognised
 *                                     attribute fields into item.state and
 *                                     persist. Returns { ok, item }.
 *
 * Unlike the generic /api/cosmos-items/[type]/[id] PATCH (which REPLACES the
 * whole state blob), this route does a server-side MERGE so a caller can send
 * just `{ updateFrequency: "Monthly" }` (F5) or `{ termsOfUse: [...] }` (F11)
 * without clobbering the other fields. Azure-native default: persists to the
 * Cosmos `items` container — no Fabric / Power BI workspace required. The T18
 * Unified Catalog adapter (opt-in) would forward these into the Purview REST
 * PUT /datagovernance/catalog/dataProducts/{id} when LOOM_DATAPRODUCTS_BACKEND
 * selects it.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { itemsContainer, workspacesContainer } from '@/lib/azure/cosmos-client';
import type { Workspace, WorkspaceItem } from '@/lib/types/workspace';
import { isUpdateFrequency, sanitizeExternalLinks } from '@/lib/dataproducts/attributes';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ITEM_TYPE = 'data-product';

function err(error: string, status: number, code?: string) {
  return NextResponse.json({ ok: false, error, code }, { status });
}

/** Load the data-product item and verify it belongs to the caller's tenant. */
async function loadItem(itemId: string, tenantId: string): Promise<WorkspaceItem | null> {
  const items = await itemsContainer();
  const { resources } = await items.items
    .query<WorkspaceItem>({
      query: 'SELECT * FROM c WHERE c.id = @id AND c.itemType = @t',
      parameters: [
        { name: '@id', value: itemId },
        { name: '@t', value: ITEM_TYPE },
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

export async function GET(_req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  const session = getSession();
  if (!session) return err('Unauthorized', 401, 'unauthorized');
  try {
    const item = await loadItem(id, session.claims.oid);
    if (!item) return err('Data product not found', 404, 'not_found');
    return NextResponse.json({ ok: true, item });
  } catch (e: any) {
    return err(e?.message || 'Failed to fetch data product', 500, 'cosmos_error');
  }
}

/**
 * Merge only the recognised attribute fields. Each is independently optional so
 * the client sends just the field it changed. Validation rejects bad shapes so
 * the Cosmos doc never holds an invalid frequency / malformed link.
 */
export async function PATCH(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  const session = getSession();
  if (!session) return err('Unauthorized', 401, 'unauthorized');

  let body: any;
  try {
    body = await req.json();
  } catch {
    return err('Invalid JSON', 400, 'bad_json');
  }
  if (!body || typeof body !== 'object') return err('Body must be an object', 400, 'bad_body');

  // Build the validated partial-state patch from only the keys present.
  const patch: Record<string, unknown> = {};

  if ('updateFrequency' in body) {
    if (body.updateFrequency === null || body.updateFrequency === '') {
      patch.updateFrequency = undefined;
    } else if (isUpdateFrequency(body.updateFrequency)) {
      patch.updateFrequency = body.updateFrequency;
    } else {
      return err('updateFrequency must be one of the supported values', 400, 'bad_frequency');
    }
  }

  if ('termsOfUse' in body) {
    const links = sanitizeExternalLinks(body.termsOfUse);
    if (!links) return err('termsOfUse must be an array of { label, url, assetId? }', 400, 'bad_terms');
    patch.termsOfUse = links;
  }

  if ('documentation' in body) {
    const links = sanitizeExternalLinks(body.documentation);
    if (!links) return err('documentation must be an array of { label, url, assetId? }', 400, 'bad_docs');
    patch.documentation = links;
  }

  if (Object.keys(patch).length === 0) {
    return err('No recognised attribute fields to update', 400, 'no_fields');
  }

  try {
    const item = await loadItem(id, session.claims.oid);
    if (!item) return err('Data product not found', 404, 'not_found');

    const mergedState: Record<string, unknown> = { ...(item.state ?? {}) };
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) delete mergedState[k];
      else mergedState[k] = v;
    }

    const next: WorkspaceItem = {
      ...item,
      state: mergedState,
      updatedAt: new Date().toISOString(),
    };
    const items = await itemsContainer();
    const { resource } = await items.item(item.id, item.workspaceId).replace<WorkspaceItem>(next);
    return NextResponse.json({ ok: true, item: resource });
  } catch (e: any) {
    return err(e?.message || 'Failed to update data product', 500, 'cosmos_error');
  }
}
