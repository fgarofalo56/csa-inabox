/**
 * LU-5 — Cosmos persistence for the Loom Unity governance overlay.
 *
 * Two stores, both Azure-native (no Fabric, no Databricks, no Purview required
 * for any of this to work — Purview is an OPTIONAL fold-in, see purview-sync.ts):
 *
 *   1. VOCABULARY — the tenant's governed-tag definitions, ONE document in the
 *      existing `tenant-settings` container under `uc-governed-tags:<tenantId>`.
 *      Deliberately the same container + one-doc-per-tenant shape as
 *      `attribute-groups:<tenantId>` (lib/types/attribute-groups) and
 *      `policies:<tenantId>` (lib/governance/policy-store) so the tenant's three
 *      governance vocabularies live side by side and back up together.
 *
 *   2. ASSIGNMENTS — one row per securable in the `uc-governance` container
 *      (PK /tenantId, id = the `uc:<fqn>` identity). Partitioning by tenant makes
 *      "every overlay under catalog X" a single-partition STARTSWITH query, and
 *      keying by the identity makes an overlay read a point-read.
 *
 * The attribute SCHEMA is NOT duplicated here: {@link readAttributeGroups} reads
 * the SAME `attribute-groups:<tenantId>` document the `/api/attribute-groups`
 * route owns. The overlay stores values only.
 *
 * Cosmos-not-configured is surfaced, never swallowed — the routes turn it into
 * the honest gate named in the gate registry (`svc-*` / cosmos).
 */
import {
  tenantSettingsContainer, ucGovernanceContainer,
} from '@/lib/azure/cosmos-client';
import type { AttributeGroup, AttributeGroupsDoc } from '@/lib/types/attribute-groups';
import {
  emptyOverlay, normalizeGovernedTagDefs, ucSecurableIdentity,
  type UcGovernanceOverlay, type UcGovernedTagDef, type UcGovernedTagsDoc,
  type UcSecurableType,
} from './model';

/** Vocabulary doc id — mirrors `attribute-groups:<tenantId>`. */
export function governedTagsDocId(tenantId: string): string {
  return `uc-governed-tags:${tenantId}`;
}

/** True when a Cosmos error means "no such document" (safe to treat as empty). */
function isNotFound(e: unknown): boolean {
  return (e as { code?: number })?.code === 404;
}

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/** Read the tenant's governed-tag vocabulary. Empty array when never authored. */
export async function readGovernedTags(tenantId: string): Promise<UcGovernedTagDef[]> {
  const c = await tenantSettingsContainer();
  try {
    const { resource } = await c.item(governedTagsDocId(tenantId), tenantId).read<UcGovernedTagsDoc>();
    return resource?.tags || [];
  } catch (e) {
    if (isNotFound(e)) return [];
    throw e;
  }
}

/** Upsert the tenant's governed-tag vocabulary (normalized before persist). */
export async function writeGovernedTags(
  tenantId: string,
  tags: UcGovernedTagDef[],
  updatedBy: string,
): Promise<UcGovernedTagsDoc> {
  const c = await tenantSettingsContainer();
  const doc: UcGovernedTagsDoc = {
    id: governedTagsDocId(tenantId),
    tenantId,
    kind: 'uc-governed-tags',
    tags: normalizeGovernedTagDefs(tags),
    updatedAt: new Date().toISOString(),
    updatedBy,
  };
  await c.items.upsert(doc);
  return doc;
}

// ---------------------------------------------------------------------------
// Attribute-group SCHEMA (read-only reuse of the existing tenant document)
// ---------------------------------------------------------------------------

/**
 * The tenant's attribute-group schema — the SAME `attribute-groups:<tenantId>`
 * document authored by `/api/attribute-groups` and rendered by the data-product
 * wizard. Read-only here: the overlay never writes the schema, only values.
 */
export async function readAttributeGroups(tenantId: string): Promise<AttributeGroup[]> {
  const c = await tenantSettingsContainer();
  try {
    const { resource } = await c.item(`attribute-groups:${tenantId}`, tenantId).read<AttributeGroupsDoc>();
    return resource?.groups || [];
  } catch (e) {
    if (isNotFound(e)) return [];
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Overlay assignments
// ---------------------------------------------------------------------------

/**
 * Point-read one overlay by identity. Returns a fresh empty overlay (NOT null)
 * when the securable has never been annotated, so callers always have a
 * well-formed document to reduce over.
 */
export async function readOverlay(
  tenantId: string,
  p: { fullName: string; column?: string; securableType?: UcSecurableType },
): Promise<UcGovernanceOverlay> {
  const blank = emptyOverlay({ tenantId, fullName: p.fullName, column: p.column, securableType: p.securableType });
  const c = await ucGovernanceContainer();
  try {
    const { resource } = await c.item(blank.id, tenantId).read<UcGovernanceOverlay>();
    if (!resource) return blank;
    // Persisted rows predate nothing yet, but defend the reducer's invariants.
    return {
      ...resource,
      tags: resource.tags || [],
      certification: resource.certification || { rung: 'none' },
      attributes: resource.attributes || {},
    };
  } catch (e) {
    if (isNotFound(e)) return blank;
    throw e;
  }
}

/**
 * Every overlay in the tenant whose identity is `uc:<prefix>` or sits UNDER it —
 * i.e. every annotated securable in a catalog (`main`) or schema (`main.sales`).
 *
 * The prefix is matched on a DOT BOUNDARY, not as a bare string prefix: a plain
 * `STARTSWITH(identity, 'uc:main.sales')` also matches `uc:main.salesops.orders`
 * and `uc:main.salesforce_stg.x`, so a schema-scoped listing would leak overlays
 * from unrelated sibling schemas (and a catalog-scoped one from unrelated
 * catalogs). The query therefore asks for the exact identity OR the identity
 * plus a trailing `.`.
 *
 * Column overlays carry a `col:uc:` identity and are returned by
 * {@link listColumnOverlays} instead, so a table listing is not polluted.
 */
export async function listOverlays(
  tenantId: string,
  prefix?: string,
): Promise<UcGovernanceOverlay[]> {
  const c = await ucGovernanceContainer();
  if (!prefix) {
    const { resources } = await c.items
      .query<UcGovernanceOverlay>({
        query: 'SELECT * FROM c WHERE c.tenantId = @t AND STARTSWITH(c.identity, @p) ORDER BY c.identity',
        parameters: [{ name: '@t', value: tenantId }, { name: '@p', value: 'uc:' }],
      })
      .fetchAll();
    return resources || [];
  }
  const exact = ucSecurableIdentity(prefix);
  const { resources } = await c.items
    .query<UcGovernanceOverlay>({
      query: 'SELECT * FROM c WHERE c.tenantId = @t AND (c.identity = @exact OR STARTSWITH(c.identity, @under)) ORDER BY c.identity',
      parameters: [
        { name: '@t', value: tenantId },
        { name: '@exact', value: exact },
        { name: '@under', value: `${exact}.` },
      ],
    })
    .fetchAll();
  return resources || [];
}

/** Column overlays for one table (identity `col:uc:<fqn>::<column>`). */
export async function listColumnOverlays(
  tenantId: string,
  fullName: string,
): Promise<UcGovernanceOverlay[]> {
  const c = await ucGovernanceContainer();
  const { resources } = await c.items
    .query<UcGovernanceOverlay>({
      query: 'SELECT * FROM c WHERE c.tenantId = @t AND STARTSWITH(c.identity, @p) ORDER BY c.identity',
      parameters: [
        { name: '@t', value: tenantId },
        { name: '@p', value: `col:${ucSecurableIdentity(fullName)}::` },
      ],
    })
    .fetchAll();
  return resources || [];
}

/** Upsert one overlay document. */
export async function writeOverlay(overlay: UcGovernanceOverlay): Promise<UcGovernanceOverlay> {
  const c = await ucGovernanceContainer();
  const { resource } = await c.items.upsert<UcGovernanceOverlay>(overlay);
  return (resource as UcGovernanceOverlay) || overlay;
}

/** Delete an overlay row entirely (used when the last annotation is removed). */
export async function deleteOverlay(tenantId: string, identity: string): Promise<void> {
  const c = await ucGovernanceContainer();
  try {
    await c.item(identity, tenantId).delete();
  } catch (e) {
    if (!isNotFound(e)) throw e;
  }
}
