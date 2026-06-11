/**
 * unified-domain-mapper — one Loom "domain" concept, written through to BOTH
 * governance back-ends in parallel:
 *
 *   • Microsoft Purview (classic Data Map) — a Loom domain ⇄ a Purview
 *     COLLECTION; a subdomain ⇄ a CHILD collection (parentCollection). Create,
 *     rename, re-describe, REPARENT (move), and delete all map to the idempotent
 *     `PUT /collections/{name}` (+ DELETE). Guarded by isPurviewConfigured().
 *
 *   • Databricks Unity Catalog — a root domain ⇄ a UC CATALOG; a subdomain ⇄ a
 *     UC SCHEMA under the parent domain's catalog (the natural 1:1 for the
 *     two-level domain/subdomain hierarchy onto UC's catalog→schema namespace).
 *     Create, rename (`new_name`), re-comment, and delete map to the UC REST
 *     write surface. Guarded by databricksConfigGate().
 *
 * Cosmos remains AUTHORITATIVE — the caller (the admin/domains BFF) persists the
 * domain to the `tenant-settings` doc first and is never blocked by either
 * mirror. This module performs ONLY the best-effort dual-cloud mirror and
 * returns a precise per-cloud result so the UI can show link status / honest
 * gates. NOTHING here reads or requires a Fabric workspace — both mirrors are
 * Azure-native and each is independently optional (no-fabric-dependency rule).
 *
 * IMPORTANT — what is NOT possible in UC, surfaced honestly:
 *   Unity Catalog has NO "move catalog" and NO "move schema to another catalog"
 *   (a catalog is top-level; the catalog.schema.table namespace is fixed). So a
 *   domain MOVE mirrors to Purview (collection reparent) only; for UC the mapper
 *   returns `{ ok:true, moveSupported:false, detail }` rather than faking it.
 */

import {
  createBusinessDomain,
  updateBusinessDomain,
  deleteBusinessDomain,
  domainCollectionName,
  isPurviewConfigured,
} from './purview-client';
import {
  databricksConfigGate,
  createUcCatalog,
  createUcSchema,
  patchUcCatalog,
  patchUcSchema,
  deleteUcCatalog,
  deleteUcSchema,
  listUcCatalogs,
  listUcSchemas,
} from './databricks-client';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The canonical inputs the mapper needs to mirror a Loom domain. */
export interface UnifiedDomainSpec {
  /** Loom domain id (immutable, lowercase-hyphen slug). */
  id: string;
  /** Display name (the friendlyName / comment). */
  name: string;
  description?: string;
  /** Loom parent domain id when this is a subdomain (else root). */
  parentId?: string;
}

export interface MirrorOutcome {
  ok: boolean;
  /** True when the back-end is unconfigured — not an error, just inactive. */
  skipped?: boolean;
  /** Human-readable note (e.g. the UC catalog/schema touched, or why skipped). */
  detail?: string;
  error?: string;
}

export interface UnityMirrorOutcome extends MirrorOutcome {
  /** UC catalog this domain maps to (root) or the parent catalog (subdomain). */
  catalog?: string;
  /** UC schema this subdomain maps to (subdomains only). */
  schema?: string;
  /** False for a MOVE — UC cannot reparent a catalog/schema (honest, not faked). */
  moveSupported?: boolean;
}

export interface UnifiedMirrorResult {
  purview: MirrorOutcome;
  unity: UnityMirrorOutcome;
}

// ---------------------------------------------------------------------------
// Identifier mapping
// ---------------------------------------------------------------------------

/**
 * Derive a stable Unity Catalog identifier (catalog or schema name) from a Loom
 * domain id. UC identifiers are lowercase letters/digits/underscores; the Loom
 * id is already a lowercase-hyphen slug, so we map hyphens → underscores and
 * strip anything else. Keyed off the IMMUTABLE id (not the display name) so the
 * UC catalog/schema name never drifts when a domain is renamed.
 */
export function unityName(idOrName: string): string {
  const n = (idOrName || 'domain')
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 255);
  // UC identifiers may not start with a digit.
  return /^[0-9]/.test(n) ? `d_${n}` : (n || 'domain');
}

function unityConfigured(): boolean {
  return databricksConfigGate() === null;
}

// ---------------------------------------------------------------------------
// Purview mirror (best-effort)
// ---------------------------------------------------------------------------

async function purviewUpsert(spec: UnifiedDomainSpec, op: 'create' | 'update'): Promise<MirrorOutcome> {
  if (!isPurviewConfigured()) {
    return { ok: true, skipped: true, detail: 'Purview not configured (LOOM_PURVIEW_ACCOUNT unset).' };
  }
  const parentCol = spec.parentId ? domainCollectionName(spec.parentId) : undefined;
  try {
    if (op === 'create') {
      const m = await createBusinessDomain({
        id: spec.id, name: spec.name, description: spec.description, parentId: parentCol,
      });
      return { ok: true, detail: `Mirrored to Purview collection '${m.id}'.` };
    }
    await updateBusinessDomain(spec.id, {
      name: spec.name, description: spec.description, parentId: parentCol,
    });
    return { ok: true, detail: `Updated Purview collection '${domainCollectionName(spec.id)}'.` };
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) };
  }
}

// ---------------------------------------------------------------------------
// Unity Catalog mirror (best-effort)
// ---------------------------------------------------------------------------

/**
 * A root domain becomes a UC CATALOG; a subdomain becomes a UC SCHEMA under the
 * parent domain's catalog. Create is idempotent-by-intent: a pre-existing
 * catalog/schema (UC 409) is treated as already-mirrored, not a failure.
 */
async function unityUpsert(spec: UnifiedDomainSpec, op: 'create' | 'update'): Promise<UnityMirrorOutcome> {
  if (!unityConfigured()) {
    return { ok: true, skipped: true, detail: 'Databricks Unity Catalog not configured (LOOM_DATABRICKS_HOSTNAME unset).' };
  }
  const isSub = !!spec.parentId;
  const catalog = isSub ? unityName(spec.parentId as string) : unityName(spec.id);
  const schema = isSub ? unityName(spec.id) : undefined;
  try {
    if (op === 'create') {
      if (isSub) {
        await createUcSchema({ name: schema as string, catalog_name: catalog, comment: spec.description });
        return { ok: true, catalog, schema, detail: `Mirrored to UC schema '${catalog}.${schema}'.` };
      }
      await createUcCatalog({ name: catalog, comment: spec.description });
      return { ok: true, catalog, detail: `Mirrored to UC catalog '${catalog}'.` };
    }
    // Update: the UC identifier is derived from the immutable id, so a display-
    // name/description edit re-comments the securable (no rename needed).
    if (isSub) {
      await patchUcSchema(`${catalog}.${schema}`, { comment: spec.description ?? '' });
      return { ok: true, catalog, schema, detail: `Updated UC schema '${catalog}.${schema}'.` };
    }
    await patchUcCatalog(catalog, { comment: spec.description ?? '' });
    return { ok: true, catalog, detail: `Updated UC catalog '${catalog}'.` };
  } catch (e: any) {
    const msg = e?.message || String(e);
    // A pre-existing securable (already mirrored) is success, not a hard error.
    if (/already exists|409|RESOURCE_ALREADY_EXISTS/i.test(msg)) {
      return { ok: true, catalog, schema, detail: `UC ${isSub ? 'schema' : 'catalog'} already present.` };
    }
    return { ok: false, catalog, schema, error: msg };
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Mirror a domain create/update to BOTH Purview and Unity Catalog in parallel. */
export async function mirrorDomainUpsert(
  spec: UnifiedDomainSpec,
  op: 'create' | 'update',
): Promise<UnifiedMirrorResult> {
  const [purview, unity] = await Promise.all([purviewUpsert(spec, op), unityUpsert(spec, op)]);
  return { purview, unity };
}

/**
 * Mirror a domain MOVE (reparent). Purview reparents the collection (idempotent
 * PUT re-asserting parentCollection). Unity Catalog CANNOT reparent — reported
 * honestly via `moveSupported:false` (no fabricated success).
 */
export async function mirrorDomainMove(
  spec: UnifiedDomainSpec,
  newParentId: string | undefined,
): Promise<UnifiedMirrorResult> {
  const moved: UnifiedDomainSpec = { ...spec, parentId: newParentId };
  const purview = await purviewUpsert(moved, 'update');
  const unity: UnityMirrorOutcome = unityConfigured()
    ? {
        ok: true,
        moveSupported: false,
        detail:
          'Unity Catalog has no move operation — a catalog is top-level under the metastore and a ' +
          'schema cannot change its parent catalog. The Loom domain hierarchy moved; the UC ' +
          'catalog/schema mapping is unchanged. Rename via PATCH new_name if you need a different UC name.',
      }
    : { ok: true, skipped: true, moveSupported: false, detail: 'Databricks Unity Catalog not configured.' };
  return { purview, unity };
}

/** Mirror a domain delete to BOTH back-ends (best-effort, never throws). */
export async function mirrorDomainDelete(spec: UnifiedDomainSpec): Promise<UnifiedMirrorResult> {
  const isSub = !!spec.parentId;
  const purview: MirrorOutcome = isPurviewConfigured()
    ? await deleteBusinessDomain(domainCollectionName(spec.id)).then(
        () => ({ ok: true, detail: 'Deleted Purview collection mirror.' }),
        (e: any) => ({ ok: false, error: e?.message || String(e) }),
      )
    : { ok: true, skipped: true, detail: 'Purview not configured.' };

  let unity: UnityMirrorOutcome;
  if (!unityConfigured()) {
    unity = { ok: true, skipped: true, detail: 'Databricks Unity Catalog not configured.' };
  } else if (isSub) {
    const catalog = unityName(spec.parentId as string);
    const schema = unityName(spec.id);
    unity = await deleteUcSchema(`${catalog}.${schema}`).then(
      () => ({ ok: true, catalog, schema, detail: `Deleted UC schema '${catalog}.${schema}'.` }),
      (e: any) => ({ ok: false, catalog, schema, error: e?.message || String(e) }),
    );
  } else {
    const catalog = unityName(spec.id);
    unity = await deleteUcCatalog(catalog).then(
      () => ({ ok: true, catalog, detail: `Deleted UC catalog '${catalog}'.` }),
      (e: any) => ({ ok: false, catalog, error: e?.message || String(e) }),
    );
  }
  return { purview, unity };
}

// ---------------------------------------------------------------------------
// Link-status read (for the catalog Domains surface)
// ---------------------------------------------------------------------------

export interface UnityLinkStatus {
  configured: boolean;
  /** UC catalog names present in the metastore (lowercased). */
  catalogs: string[];
  /** Map of catalog → schema names present (lowercased). */
  schemasByCatalog: Record<string, string[]>;
  hint?: string;
}

/**
 * Read which UC catalogs/schemas exist so the Domains UI can show a per-domain
 * "Unity Catalog linked" badge. Never throws — an unconfigured workspace or a
 * 403 returns `configured:false` + an honest hint.
 */
export async function unityLinkStatus(): Promise<UnityLinkStatus> {
  if (!unityConfigured()) {
    return {
      configured: false,
      catalogs: [],
      schemasByCatalog: {},
      hint: 'Unity Catalog mirror inactive — set LOOM_DATABRICKS_HOSTNAME (admin-plane/main.bicep apps[] env) and grant the console UAMI CREATE CATALOG on the metastore to mirror domains as UC catalogs/schemas.',
    };
  }
  try {
    const catalogs = await listUcCatalogs();
    const names = catalogs.map((c) => (c.name || '').toLowerCase()).filter(Boolean);
    const schemasByCatalog: Record<string, string[]> = {};
    // Only fetch schemas for the catalogs that look domain-derived to keep this
    // cheap; the UI matches subdomains against their parent catalog's schemas.
    await Promise.all(
      names.map(async (cat) => {
        try {
          const schemas = await listUcSchemas(cat);
          schemasByCatalog[cat] = schemas
            .map((sc) => (sc.name || '').toLowerCase())
            .filter((n) => n && n !== 'information_schema' && n !== 'default');
        } catch {
          schemasByCatalog[cat] = [];
        }
      }),
    );
    return { configured: true, catalogs: names, schemasByCatalog };
  } catch (e: any) {
    return {
      configured: false,
      catalogs: [],
      schemasByCatalog: {},
      hint: `Unity Catalog unreachable: ${e?.message || String(e)}.`,
    };
  }
}
