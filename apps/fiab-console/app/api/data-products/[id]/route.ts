/**
 * Data-product BFF — partial-field GET + PATCH for ONE marketplace data product.
 *
 *   GET   /api/data-products/[id]   → { ok, item, doc } (+ ETag response header)
 *   PATCH /api/data-products/[id]   → merge ONLY the supplied recognised fields
 *                                     into the Cosmos WorkspaceItem and persist.
 *                                     Returns { ok, item, doc, patched } (+ ETag).
 *
 * Two consumers share this surface, against the SAME `items` Cosmos record
 * (itemType 'data-product') the marketplace lists and the create wizard writes —
 * so an edit here changes exactly what the marketplace shows (no separate copy):
 *
 *   1. Attribute right-rail (F5/F11): { updateFrequency }, { termsOfUse[] },
 *      { documentation[] } — merged into item.state without clobbering siblings.
 *   2. Edit dialog (F4 + F7 Endorse): { name, description, type, audience[],
 *      owners[], endorsed, governanceDomainId, useCase, customAttributes } —
 *      name → displayName, description → item.description, the rest → item.state.
 *
 * Unlike the generic /api/cosmos-items PATCH (which REPLACES the whole state),
 * this route MERGES, so a caller sends only the field it changed. Azure-native
 * default: persists to the Cosmos `items` container — no Fabric / Power BI
 * workspace required (.claude/rules/no-fabric-dependency.md). Real Cosmos
 * data-plane, never mocks (.claude/rules/no-vaporware.md).
 *
 * Optimistic concurrency: when the caller sends an `If-Match` header (the edit
 * dialog passes the `_etag` from its last GET), the replace is conditioned on
 * it; a stale ETag (concurrent write) returns HTTP 409 instead of silently
 * clobbering. The attribute right-rail omits the header → a plain merge-replace.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { itemsContainer, workspacesContainer } from '@/lib/azure/cosmos-client';
import type { Workspace, WorkspaceItem } from '@/lib/types/workspace';
import { isUpdateFrequency, sanitizeExternalLinks } from '@/lib/dataproducts/attributes';
import type { DataProductDoc } from '@/lib/dataproducts/edit-model';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ITEM_TYPE = 'data-product';

function err(error: string, status: number, code?: string) {
  return NextResponse.json({ ok: false, error, code }, { status });
}

/** Cosmos stamps `_etag` on every read; it isn't on the WorkspaceItem type. */
type WithEtag = WorkspaceItem & { _etag?: string };

/** A stored owner can be a plain string or the rich { id, upn, displayName }. */
type OwnerRecord = string | { id?: string; upn?: string; displayName?: string };

function ownerToString(o: OwnerRecord): string {
  if (typeof o === 'string') return o;
  return (o?.upn || o?.displayName || o?.id || '').toString();
}

/**
 * Map incoming owner strings (the dialog edits owners as comma-separated text)
 * back onto stored owner records — reusing an existing rich record when the
 * string matches its upn/displayName/id, so unchanged owners keep their fidelity
 * and only genuinely new owners become { upn, displayName }.
 */
function mergeOwners(incoming: string[], existing: unknown): OwnerRecord[] {
  const existArr: OwnerRecord[] = Array.isArray(existing) ? (existing as OwnerRecord[]) : [];
  return incoming.map((s) => {
    const match = existArr.find(
      (o) => o && typeof o === 'object' && (o.upn === s || o.displayName === s || o.id === s),
    );
    return match ?? { upn: s, displayName: s };
  });
}

/** Project a WorkspaceItem to the editable DataProductDoc the edit dialog reads. */
function toDoc(item: WithEtag): DataProductDoc {
  const st = (item.state ?? {}) as Record<string, unknown>;
  const owners = Array.isArray(st.owners) ? (st.owners as OwnerRecord[]) : [];
  return {
    id: item.id,
    governanceDomainId: (st.governanceDomainId as string) ?? '',
    name: item.displayName,
    description: item.description ?? '',
    type: st.type as string | undefined,
    audience: Array.isArray(st.audience) ? (st.audience as string[]) : [],
    owners: owners.map(ownerToString).filter(Boolean),
    endorsed: !!st.endorsed,
    useCase: (st.useCase as string) ?? '',
    customAttributes: (st.customAttributes as DataProductDoc['customAttributes']) ?? {},
    status: (st.status as DataProductDoc['status']) ?? 'Draft',
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    createdBy: item.createdBy,
    _etag: item._etag,
  };
}

/** Load the data-product item and verify it belongs to the caller's tenant. */
async function loadItem(itemId: string, tenantId: string): Promise<WithEtag | null> {
  const items = await itemsContainer();
  const { resources } = await items.items
    .query<WithEtag>({
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
    return NextResponse.json(
      { ok: true, item, doc: toDoc(item) },
      { headers: { ETag: item._etag ?? '' } },
    );
  } catch (e: any) {
    return err(e?.message || 'Failed to fetch data product', 500, 'cosmos_error');
  }
}

/**
 * Merge only the recognised fields. Each is independently optional so the client
 * sends just what it changed. Validation rejects bad shapes so the Cosmos doc
 * never holds an invalid frequency / malformed link.
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

  // state-level partial patch (set undefined → delete key); collected logical
  // field names for the edit-dialog success message + onSaved.
  const statePatch: Record<string, unknown> = {};
  const patched: string[] = [];
  let nextDisplayName: string | undefined;
  let nextDescription: string | undefined;

  // ---- F5/F11 attribute right-rail fields ----------------------------------
  if ('updateFrequency' in body) {
    if (body.updateFrequency === null || body.updateFrequency === '') {
      statePatch.updateFrequency = undefined;
    } else if (isUpdateFrequency(body.updateFrequency)) {
      statePatch.updateFrequency = body.updateFrequency;
    } else {
      return err('updateFrequency must be one of the supported values', 400, 'bad_frequency');
    }
    patched.push('updateFrequency');
  }
  if ('termsOfUse' in body) {
    const links = sanitizeExternalLinks(body.termsOfUse);
    if (!links) return err('termsOfUse must be an array of { label, url, assetId? }', 400, 'bad_terms');
    statePatch.termsOfUse = links;
    patched.push('termsOfUse');
  }
  if ('documentation' in body) {
    const links = sanitizeExternalLinks(body.documentation);
    if (!links) return err('documentation must be an array of { label, url, assetId? }', 400, 'bad_docs');
    statePatch.documentation = links;
    patched.push('documentation');
  }

  // ---- F4 edit-dialog fields (Basic / Business / Custom) -------------------
  if ('name' in body) {
    if (typeof body.name !== 'string' || !body.name.trim()) {
      return err('name must be a non-empty string', 400, 'bad_name');
    }
    nextDisplayName = body.name.trim();
    patched.push('name');
  }
  if ('description' in body) {
    if (typeof body.description !== 'string') return err('description must be a string', 400, 'bad_desc');
    nextDescription = body.description;
    patched.push('description');
  }
  if ('type' in body) {
    if (body.type !== undefined && body.type !== null && typeof body.type !== 'string') {
      return err('type must be a string', 400, 'bad_type');
    }
    statePatch.type = body.type || undefined;
    patched.push('type');
  }
  if ('audience' in body) {
    if (!Array.isArray(body.audience) || body.audience.some((a: unknown) => typeof a !== 'string')) {
      return err('audience must be an array of strings', 400, 'bad_audience');
    }
    statePatch.audience = body.audience;
    patched.push('audience');
  }
  if ('endorsed' in body) {
    if (typeof body.endorsed !== 'boolean') return err('endorsed must be a boolean', 400, 'bad_endorsed');
    statePatch.endorsed = body.endorsed;
    patched.push('endorsed');
  }
  if ('governanceDomainId' in body) {
    if (body.governanceDomainId !== undefined && body.governanceDomainId !== null && typeof body.governanceDomainId !== 'string') {
      return err('governanceDomainId must be a string', 400, 'bad_domain');
    }
    statePatch.governanceDomainId = body.governanceDomainId || null;
    patched.push('governanceDomainId');
  }
  if ('useCase' in body) {
    if (typeof body.useCase !== 'string') return err('useCase must be a string', 400, 'bad_usecase');
    statePatch.useCase = body.useCase;
    patched.push('useCase');
  }
  if ('customAttributes' in body) {
    if (!body.customAttributes || typeof body.customAttributes !== 'object' || Array.isArray(body.customAttributes)) {
      return err('customAttributes must be an object', 400, 'bad_custom');
    }
    statePatch.customAttributes = body.customAttributes;
    patched.push('customAttributes');
  }
  // owners handled after the item loads (needs the existing records to merge).
  const ownersProvided = 'owners' in body;
  if (ownersProvided && (!Array.isArray(body.owners) || body.owners.some((o: unknown) => typeof o !== 'string'))) {
    return err('owners must be an array of strings', 400, 'bad_owners');
  }

  if (
    patched.length === 0 &&
    !ownersProvided &&
    nextDisplayName === undefined &&
    nextDescription === undefined
  ) {
    return err('No recognised fields to update', 400, 'no_fields');
  }

  try {
    const item = await loadItem(id, session.claims.oid);
    if (!item) return err('Data product not found', 404, 'not_found');

    const mergedState: Record<string, unknown> = { ...(item.state ?? {}) };
    for (const [k, v] of Object.entries(statePatch)) {
      if (v === undefined) delete mergedState[k];
      else mergedState[k] = v;
    }
    if (ownersProvided) {
      mergedState.owners = mergeOwners(body.owners as string[], mergedState.owners);
      patched.push('owners');
    }
    // Changing the governance domain invalidates any cached domain name.
    if ('governanceDomainId' in statePatch && mergedState.governanceDomainName) {
      delete mergedState.governanceDomainName;
    }

    const next: WorkspaceItem = {
      ...item,
      ...(nextDisplayName !== undefined ? { displayName: nextDisplayName } : {}),
      ...(nextDescription !== undefined ? { description: nextDescription } : {}),
      state: mergedState,
      updatedAt: new Date().toISOString(),
    };

    const ifMatch = req.headers.get('if-match') || '';
    const items = await itemsContainer();
    try {
      const { resource } = await items
        .item(item.id, item.workspaceId)
        .replace<WorkspaceItem>(
          next,
          ifMatch ? { accessCondition: { type: 'IfMatch', condition: ifMatch } } : undefined,
        );
      const saved = resource as WithEtag;
      return NextResponse.json(
        { ok: true, item: saved, doc: toDoc(saved), patched },
        { headers: { ETag: saved._etag ?? '' } },
      );
    } catch (e: any) {
      // Cosmos returns 412 Precondition Failed when the If-Match ETag is stale.
      if (e?.code === 412 || e?.statusCode === 412 || e?.status === 412) {
        return err('document changed since last read — re-open the dialog to reload', 409, 'etag_conflict');
      }
      throw e;
    }
  } catch (e: any) {
    return err(e?.message || 'Failed to update data product', 500, 'cosmos_error');
  }
}
