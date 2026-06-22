/**
 * Data-product BFF — adaptive consumer + owner surface for ONE marketplace data
 * product, against the SAME `items` Cosmos record (itemType 'data-product') the
 * marketplace lists and the create wizard writes — so an edit here changes
 * exactly what the marketplace shows (no separate copy). No Fabric / Power BI
 * workspace required (.claude/rules/no-fabric-dependency.md); real Cosmos
 * data-plane, never mocks (.claude/rules/no-vaporware.md).
 *
 *   GET   /api/data-products/[id]
 *     → { ok, item, doc, ownerTenantId, isOwner,
 *         product, dqScore, dqGate, subscriberCount,
 *         displayName, workspaceId, preconditions, current }  (+ ETag header)
 *
 *     `item`/`doc`/`isOwner` drive the F15 consumer read view and the owner edit
 *     dialog. `product` is the owner details (F3) projection of the same record,
 *     plus two best-effort derived fields:
 *       - dqScore : real data-quality score from the tenant's DQ rules
 *                   (tenant-settings doc id `dq-rules:<tenantId>`); null when no
 *                   rules are configured — the UI shows an honest-gate instead
 *                   of a fabricated number (per no-vaporware.md).
 *       - subscriberCount : real count of approved access-requests.
 *
 *     `preconditions`/`current` (F13) are the four destructive-delete gates,
 *     mirroring the Microsoft Purview Unified Catalog "Delete data products"
 *     procedure — see DELETE below. They drive the delete-dialog preflight.
 *
 *     GET is NOT ownership gated — published data products are discoverable to
 *     any catalog reader (Purview Unified Catalog model). It resolves the owning
 *     workspace's tenantId so the caller is told whether they own it (isOwner).
 *
 *   PATCH /api/data-products/[id]   → owner-only merge of the supplied fields
 *     into the same Cosmos WorkspaceItem. Loads via the tenant-scoped path
 *     (404s for non-owners) so a consumer can never write. Recognised callers:
 *       1. Attribute right-rail (F5/F11): { updateFrequency }, { termsOfUse[] },
 *          { documentation[] }.
 *       2. Edit dialog (F4 + F7 Endorse): { name, description, type, audience[],
 *          owners[], endorsed, governanceDomainId, useCase, customAttributes }.
 *       3. Owner details page (F3): { ownerLabels: { <ownerKey>: <label> } } —
 *          sets a per-owner contact label in place.
 *       4. Marketplace editor (lib/editors/data-marketplace.tsx): { publishStatus }
 *          (Draft/Published/Deprecated toggle) and the marketplace metadata
 *          fields { domain, productType, owner, sla, glossaryTerms[], CDEs[] }.
 *          Flipping publishStatus Draft → Published is what makes a product
 *          appear in consumer search; the re-save re-mirrors it into the
 *          loom-data-products AI Search index.
 *     Returns { ok, item, doc, product, patched } (+ ETag). Optimistic
 *     concurrency: an `If-Match` header conditions the replace; a stale ETag
 *     (concurrent write) returns HTTP 409 instead of clobbering.
 *
 *   DELETE /api/data-products/[id]  — F13 precondition-gated delete of the
 *     Cosmos doc. Preconditions mirror the Microsoft Purview Unified Catalog
 *     "Delete data products" procedure
 *     (https://learn.microsoft.com/purview/unified-catalog-data-products-create-manage):
 *       1. lifecycleStatus must be 'Draft' or 'Expired' (NOT 'Published').
 *       2. Zero data assets attached  (state.datasets empty).
 *       3. Zero glossary terms linked  (state.glossaryLinks empty).
 *       4. Zero open access requests   (no audit-log `access-requested` rows).
 *     Only when ALL four hold may the data product be deleted. The Cosmos delete
 *     is authoritative; Purview Unified Catalog cleanup is best-effort — on the
 *     deployed CLASSIC Data Map account it honestly gates and never blocks the
 *     Cosmos delete, per .claude/rules/no-vaporware.md.
 *     DELETE : 200 { ok, workspaceId, purviewDeleted, purviewNote? }
 *              422 { ok:false, error, code:'precondition_failed', blockers, current }
 *              401 unauthenticated · 404 not found · 500 unexpected.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  itemsContainer,
  workspacesContainer,
  tenantSettingsContainer,
  accessRequestsContainer,
  auditLogContainer,
} from '@/lib/azure/cosmos-client';
import {
  upsertDataProductDoc, deleteDataProductDoc, docForDataProduct,
} from '@/lib/azure/loom-data-products-search';
import { deleteOwnedItem } from '../../items/_lib/item-crud';
import {
  deleteDataProductBestEffort,
  PurviewUnifiedCatalogGateError,
  PurviewNotConfiguredError,
} from '@/lib/azure/purview-client';
import { PUBLISH_STATUSES, type PublishStatus } from '@/lib/azure/loom-data-products-search';
import type { Workspace, WorkspaceItem } from '@/lib/types/workspace';
import { isUpdateFrequency, sanitizeExternalLinks } from '@/lib/dataproducts/attributes';
import type { DataProductDoc as EditDoc } from '@/lib/dataproducts/edit-model';
import type {
  DataProductDoc, DataProductOwner, DataProductCustomAttribute,
  DataProductLink, DataProductStatus,
} from '@/lib/types/data-product';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ITEM_TYPE = 'data-product';

function err(error: string, status: number, code?: string) {
  return NextResponse.json({ ok: false, error, code }, { status });
}

/** Cosmos stamps `_etag` on every read; it isn't on the WorkspaceItem type. */
type WithEtag = WorkspaceItem & { _etag?: string };

/** A stored owner can be a plain string or the rich { id, upn, displayName, label }. */
type OwnerRecord = string | { id?: string; upn?: string; displayName?: string; label?: string };

function ownerToString(o: OwnerRecord): string {
  if (typeof o === 'string') return o;
  return (o?.upn || o?.displayName || o?.id || '').toString();
}

/** Stable identity key for an owner record (id → upn → displayName → string). */
function ownerKey(o: OwnerRecord): string {
  if (typeof o === 'string') return o;
  return (o?.id || o?.upn || o?.displayName || '').toString();
}

/** Coerce a comma/semicolon/newline-delimited string or array to a clean string[]. */
function asArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
  if (typeof v === 'string') return v.split(/[,;\n]/).map((x) => x.trim()).filter(Boolean);
  return [];
}

/**
 * Map incoming owner strings (the dialog edits owners as comma-separated text)
 * back onto stored owner records — reusing an existing rich record when the
 * string matches its upn/displayName/id, so unchanged owners keep their fidelity
 * (including any contact label) and only genuinely new owners become
 * { upn, displayName }.
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

/**
 * Apply { <ownerKey>: <label> } from the F3 owner details page onto the stored
 * owner records, promoting plain-string owners to rich records so they can hold
 * a label. Owners whose key isn't in the map are left untouched.
 */
function applyOwnerLabels(existing: unknown, labels: Record<string, string>): OwnerRecord[] {
  const existArr: OwnerRecord[] = Array.isArray(existing) ? (existing as OwnerRecord[]) : [];
  return existArr.map((o) => {
    const key = ownerKey(o);
    if (!Object.prototype.hasOwnProperty.call(labels, key)) return o;
    const label = String(labels[key] ?? '').trim() || undefined;
    if (typeof o === 'string') return { id: o, upn: o, displayName: o, label };
    return { ...o, label };
  });
}

/** Project a WorkspaceItem to the editable EditDoc the edit dialog reads. */
function toDoc(item: WithEtag): EditDoc {
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
    customAttributes: (st.customAttributes as EditDoc['customAttributes']) ?? {},
    status: (st.status as EditDoc['status']) ?? 'Draft',
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    createdBy: item.createdBy,
    _etag: item._etag,
  };
}

/** Project stored owner records to the rich DataProductOwner shape (F3 view). */
function toProductOwners(existing: unknown): DataProductOwner[] {
  const arr: OwnerRecord[] = Array.isArray(existing) ? (existing as OwnerRecord[]) : [];
  return arr.map((o) => {
    if (typeof o === 'string') return { id: o, upn: o, displayName: o };
    return { id: ownerKey(o), upn: o.upn, displayName: o.displayName, label: o.label };
  });
}

/** Normalise stored custom attributes (array OR record) to the F3 array shape. */
function toCustomAttributes(raw: unknown): DataProductCustomAttribute[] {
  if (Array.isArray(raw)) {
    return raw
      .filter((a) => a && typeof a === 'object')
      .map((a: any) => ({
        groupName: String(a.groupName ?? ''),
        name: String(a.name ?? ''),
        value: a.value ?? null,
      }));
  }
  if (raw && typeof raw === 'object') {
    return Object.entries(raw as Record<string, unknown>).map(([name, value]) => ({
      groupName: '',
      name,
      value: (value ?? null) as DataProductCustomAttribute['value'],
    }));
  }
  return [];
}

function toLinks(raw: unknown): DataProductLink[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  return raw
    .filter((l) => l && typeof l === 'object' && (l as any).url)
    .map((l: any) => ({ label: String(l.label ?? l.url), url: String(l.url), assetId: l.assetId }));
}

/** Project a WorkspaceItem to the owner details (F3) DataProductDoc. */
function itemToProduct(item: WithEtag, tenantId: string | null): DataProductDoc {
  const st = (item.state ?? {}) as Record<string, unknown>;
  return {
    id: item.id,
    tenantId: tenantId ?? '',
    governanceDomainId: (st.governanceDomainId as string) ?? '',
    governanceDomainName: st.governanceDomainName as string | undefined,
    name: item.displayName,
    description: item.description ?? '',
    useCase: (st.useCase as string) ?? undefined,
    type: st.type as string | undefined,
    audience: Array.isArray(st.audience) ? (st.audience as string[]) : undefined,
    status: ((st.status as DataProductStatus) ?? 'Draft'),
    endorsed: !!st.endorsed,
    updateFrequency: st.updateFrequency as string | undefined,
    owners: toProductOwners(st.owners),
    customAttributes: toCustomAttributes(st.customAttributes),
    termsOfUse: toLinks(st.termsOfUse),
    documentation: toLinks(st.documentation),
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    _etag: item._etag,
  };
}

/**
 * Find the data-product item by id+itemType (cross-partition). NOT ownership
 * gated — the F15 consumer view returns any discoverable data product.
 */
async function findItem(itemId: string): Promise<WithEtag | null> {
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
  return resources[0] ?? null;
}

/** Resolve the owning workspace's tenantId (best-effort) for the isOwner flag. */
async function resolveOwnerTenantId(workspaceId: string): Promise<string | null> {
  try {
    const ws = await workspacesContainer();
    const { resources } = await ws.items
      .query<{ tenantId: string }>({
        query: 'SELECT c.tenantId FROM c WHERE c.id = @id',
        parameters: [{ name: '@id', value: workspaceId }],
      })
      .fetchAll();
    return resources[0]?.tenantId ?? null;
  } catch {
    // Owner resolution is best-effort; the consumer view still renders.
    return null;
  }
}

/** Load the data-product item and verify it belongs to the caller's tenant. */
async function loadOwnedItem(itemId: string, tenantId: string): Promise<WithEtag | null> {
  const item = await findItem(itemId);
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

/** Minimal shape of the DQ-rules document (see /api/admin/data-quality-rules). */
interface DqRule { id: string; name: string; enabled: boolean; check?: string; scope?: string }
interface DqRulesDoc { id: string; tenantId: string; items?: DqRule[] }

const DQ_GATE =
  'No data-quality rules configured for this tenant. Define rules in Admin › Data Quality Rules to compute a real score.';

/** Real DQ score from the caller's tenant rules; honest-gate when none exist. */
async function computeDqScore(tenantId: string): Promise<{ dqScore: number | null; dqGate: string | null }> {
  try {
    const ts = await tenantSettingsContainer();
    const { resource } = await ts.item(`dq-rules:${tenantId}`, tenantId).read<DqRulesDoc>();
    const rules = resource?.items ?? [];
    if (rules.length > 0) {
      const enabled = rules.filter((r) => r.enabled).length;
      return { dqScore: Math.round((enabled / rules.length) * 100), dqGate: null };
    }
  } catch {
    // 404 = no rules doc yet → honest-gate, not an error.
  }
  return { dqScore: null, dqGate: DQ_GATE };
}

/** Real count of approved subscribers (access-requests). Best-effort → 0. */
async function countSubscribers(dataProductId: string): Promise<number> {
  try {
    const ar = await accessRequestsContainer();
    const { resources } = await ar.items
      .query<{ id: string }>({
        query: 'SELECT c.id FROM c WHERE c.dataProductId = @id AND c.status = "approved"',
        parameters: [{ name: '@id', value: dataProductId }],
      })
      .fetchAll();
    return resources.length;
  } catch {
    return 0;
  }
}

interface DeletePreconditions {
  statusAllowed: boolean;
  datasetsEmpty: boolean;
  glossaryEmpty: boolean;
  noOpenAccessRequests: boolean;
  canDelete: boolean;
}
interface DeleteCurrent {
  lifecycleStatus: string;
  datasetCount: number;
  glossaryCount: number;
  openAccessRequestCount: number;
}

/**
 * Resolve the four destructive-delete preconditions (F13) from an already-loaded
 * item. Shared by the GET preflight and the DELETE enforcement so the checks can
 * never drift apart.
 */
async function computePreconditions(
  item: WithEtag,
  id: string,
): Promise<{ preconditions: DeletePreconditions; current: DeleteCurrent }> {
  const state = (item.state || {}) as Record<string, unknown>;
  const lifecycleStatus = (state.lifecycleStatus as string) || 'DRAFT';
  const datasets = Array.isArray(state.datasets) ? state.datasets : [];
  const glossaryLinks = Array.isArray(state.glossaryLinks) ? state.glossaryLinks : [];

  // Single-partition aggregate on audit-log (PK = /itemId) — counts the open
  // access requests recorded by POST /api/catalog/request-access. There is no
  // resolution tracking today, so every such row counts as "open".
  let openAccessRequestCount = 0;
  try {
    const audit = await auditLogContainer();
    const { resources: counts } = await audit.items
      .query<number>(
        {
          query: 'SELECT VALUE COUNT(1) FROM c WHERE c.action = @a',
          parameters: [{ name: '@a', value: 'access-requested' }],
        },
        { partitionKey: id },
      )
      .fetchAll();
    openAccessRequestCount = Number(counts?.[0] ?? 0);
  } catch {
    // Audit container is best-effort; absence of rows means zero open requests.
    openAccessRequestCount = 0;
  }

  const statusAllowed = lifecycleStatus !== 'PUBLISHED';
  const datasetsEmpty = datasets.length === 0;
  const glossaryEmpty = glossaryLinks.length === 0;
  const noOpenAccessRequests = openAccessRequestCount === 0;
  const canDelete = statusAllowed && datasetsEmpty && glossaryEmpty && noOpenAccessRequests;

  return {
    preconditions: { statusAllowed, datasetsEmpty, glossaryEmpty, noOpenAccessRequests, canDelete },
    current: {
      lifecycleStatus,
      datasetCount: datasets.length,
      glossaryCount: glossaryLinks.length,
      openAccessRequestCount,
    },
  };
}

export async function GET(_req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  const session = getSession();
  if (!session) return err('Unauthorized', 401, 'unauthorized');
  try {
    const item = await findItem(id);
    if (!item) return err('Data product not found', 404, 'not_found');
    const ownerTenantId = await resolveOwnerTenantId(item.workspaceId);
    const isOwner = ownerTenantId !== null && ownerTenantId === session.claims.oid;
    const [{ dqScore, dqGate }, subscriberCount, gates] = await Promise.all([
      computeDqScore(session.claims.oid),
      countSubscribers(id),
      computePreconditions(item, id),
    ]);
    return NextResponse.json(
      {
        ok: true,
        item,
        doc: toDoc(item),
        // Marketplace-shape projection so lib/editors/data-marketplace.tsx can
        // read a single product the same way it reads the list (state-based).
        product: itemToProduct(item, ownerTenantId),
        ownerTenantId,
        isOwner,
        dqScore,
        dqGate,
        subscriberCount,
        displayName: item.displayName,
        workspaceId: item.workspaceId,
        preconditions: gates.preconditions,
        current: gates.current,
      },
      { headers: { ETag: item._etag ?? '' } },
    );
  } catch (e: any) {
    return err(e?.message || 'Failed to fetch data product', 500, 'cosmos_error');
  }
}

/**
 * Merge only the recognised fields. Each is independently optional so the client
 * sends just what it changed. Validation rejects bad shapes so the Cosmos doc
 * never holds an invalid frequency / malformed link. Owner-only: loads the item
 * via the tenant-scoped path, so a consumer (non-owner) gets 404 and can't write.
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

  // The marketplace editor (data-marketplace.tsx) may nest its metadata under a
  // `state` object; the Purview callers send fields at the top level. Flatten a
  // nested `state` onto the body so both shapes hit the same field handlers.
  if (body.state && typeof body.state === 'object' && !Array.isArray(body.state)) {
    const { state, ...rest } = body;
    body = { ...state, ...rest };
  }

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

  // ---- Marketplace editor fields (data-marketplace.tsx) --------------------
  if ('publishStatus' in body) {
    const ps = String(body.publishStatus) as PublishStatus;
    statePatch.publishStatus = PUBLISH_STATUSES.includes(ps) ? ps : 'Draft';
    patched.push('publishStatus');
  }
  if ('domain' in body) {
    statePatch.domain = body.domain ? String(body.domain) : undefined;
    patched.push('domain');
  }
  if ('productType' in body) {
    statePatch.productType = body.productType ? String(body.productType) : undefined;
    patched.push('productType');
  }
  if ('owner' in body) {
    statePatch.owner = body.owner ? String(body.owner) : undefined;
    patched.push('owner');
  }
  if ('sla' in body) {
    statePatch.sla = body.sla ? String(body.sla) : undefined;
    patched.push('sla');
  }
  if ('glossaryTerms' in body) {
    statePatch.glossaryTerms = asArray(body.glossaryTerms);
    patched.push('glossaryTerms');
  }
  if ('CDEs' in body) {
    statePatch.CDEs = asArray(body.CDEs);
    patched.push('CDEs');
  }

  // ---- F4 edit-dialog fields (Basic / Business / Custom) -------------------
  if ('name' in body) {
    if (typeof body.name !== 'string' || !body.name.trim()) {
      return err('name must be a non-empty string', 400, 'bad_name');
    }
    nextDisplayName = body.name.trim();
    patched.push('name');
  }
  if ('displayName' in body && !('name' in body)) {
    if (typeof body.displayName !== 'string' || !body.displayName.trim()) {
      return err('displayName must be a non-empty string', 400, 'bad_name');
    }
    nextDisplayName = body.displayName.trim();
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
    if (!body.customAttributes || typeof body.customAttributes !== 'object') {
      return err('customAttributes must be an object or array', 400, 'bad_custom');
    }
    statePatch.customAttributes = body.customAttributes;
    patched.push('customAttributes');
  }
  // owners handled after the item loads (needs the existing records to merge).
  const ownersProvided = 'owners' in body;
  if (ownersProvided && (!Array.isArray(body.owners) || body.owners.some((o: unknown) => typeof o !== 'string'))) {
    return err('owners must be an array of strings', 400, 'bad_owners');
  }
  // F3 owner details page — per-owner contact labels.
  const ownerLabelsProvided = 'ownerLabels' in body;
  if (
    ownerLabelsProvided &&
    (!body.ownerLabels || typeof body.ownerLabels !== 'object' || Array.isArray(body.ownerLabels))
  ) {
    return err('ownerLabels must be an object of { <ownerKey>: <label> }', 400, 'bad_owner_labels');
  }

  if (
    patched.length === 0 &&
    !ownersProvided &&
    !ownerLabelsProvided &&
    nextDisplayName === undefined &&
    nextDescription === undefined
  ) {
    return err('No recognised fields to update', 400, 'no_fields');
  }

  try {
    const item = await loadOwnedItem(id, session.claims.oid);
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
    if (ownerLabelsProvided) {
      mergedState.owners = applyOwnerLabels(mergedState.owners, body.ownerLabels as Record<string, string>);
      patched.push('ownerLabels');
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
      // Re-mirror to the consumer-discovery index so publish / unpublish / edit
      // is reflected in Discover. Published → upserted + visible; Draft/Deprecated
      // → upserted but filtered out by the Published-only consumer search. This
      // was missing — the PATCH wrote Cosmos but never updated the index, so
      // publishing a draft never surfaced it. Best-effort (never throws).
      void upsertDataProductDoc(docForDataProduct(saved, session.claims.oid));
      return NextResponse.json(
        {
          ok: true,
          item: saved,
          doc: toDoc(saved),
          product: itemToProduct(saved, session.claims.oid),
          patched,
        },
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

/**
 * Precondition-gated delete (F13). Owner-only: loads the item via the
 * tenant-scoped path so a consumer (non-owner) gets 404 and can't delete. All
 * four preconditions must hold; otherwise 422 with the specific blockers. On
 * success the Cosmos record is the source of truth — Purview cleanup is
 * best-effort and never blocks.
 */
export async function DELETE(_req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  const session = getSession();
  if (!session) return err('Unauthorized', 401, 'unauthorized');
  try {
    const item = await loadOwnedItem(id, session.claims.oid);
    if (!item) return err('Data product not found', 404, 'not_found');

    const { preconditions, current } = await computePreconditions(item, id);
    if (!preconditions.canDelete) {
      const blockers: string[] = [];
      if (!preconditions.statusAllowed)
        blockers.push(
          `Status is '${current.lifecycleStatus}' — unpublish the data product first (set its lifecycle status to Draft or Expired).`,
        );
      if (!preconditions.datasetsEmpty)
        blockers.push(
          `${current.datasetCount} data asset(s) attached — remove all data assets (Datasets tab) before deleting.`,
        );
      if (!preconditions.glossaryEmpty)
        blockers.push(
          `${current.glossaryCount} glossary term(s) linked — unlink all terms (Glossary tab) before deleting.`,
        );
      if (!preconditions.noOpenAccessRequests)
        blockers.push(
          `${current.openAccessRequestCount} open access request(s) exist — delete all access requests (Governance → Policies) before deleting.`,
        );
      return NextResponse.json(
        {
          ok: false,
          error: 'Delete blocked: preconditions not met.',
          code: 'precondition_failed',
          blockers,
          current,
        },
        { status: 422 },
      );
    }

    // 1. Delete from Cosmos (authoritative). deleteOwnedItem also removes the
    //    AI Search mirror (deleteLoomDoc) on success.
    const deleted = await deleteOwnedItem(id, ITEM_TYPE, session.claims.oid);
    if (!deleted) return err('data-product not found or already deleted', 404, 'not_found');

    // 2. Best-effort: delete from the Purview Unified Catalog. The expected
    //    PurviewUnifiedCatalogGateError on the deployed classic Data Map account
    //    NEVER fails the Cosmos delete — the Cosmos record is the source of truth.
    const state = (item.state || {}) as Record<string, unknown>;
    const purviewId = state.purviewDataProductId as string | undefined;
    let purviewDeleted = false;
    let purviewNote: string | undefined;
    if (purviewId) {
      try {
        const r = await deleteDataProductBestEffort(purviewId);
        purviewDeleted = r.deleted;
        purviewNote = r.note;
      } catch (e: any) {
        if (e instanceof PurviewUnifiedCatalogGateError) {
          purviewNote =
            'Purview Unified Catalog delete skipped (classic Data Map account). If this product was registered via a unified-catalog account, delete it manually in the Purview portal.';
        } else if (e instanceof PurviewNotConfiguredError) {
          purviewNote = 'Purview not configured (LOOM_PURVIEW_ACCOUNT unset) — no catalog cleanup needed.';
        } else {
          purviewNote = `Purview cleanup failed (best-effort, ignored): ${e?.message || String(e)}`;
        }
      }
    }

    return NextResponse.json({
      ok: true,
      workspaceId: item.workspaceId,
      purviewDeleted,
      ...(purviewNote ? { purviewNote } : {}),
    });
  } catch (e: any) {
    return err(e?.message || 'Failed to delete data product', 500, 'cosmos_error');
  }
}
