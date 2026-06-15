/**
 * Cross-source asset-identity RESOLUTION for the unified-lineage merge.
 *
 * `unified-lineage.ts` *normalizes* identities (UC full_name / abfss path /
 * Atlas qualifiedName → a canonical join key), but the merge only overlays a
 * second source when the caller already holds that source's key. For the common
 * case — a Unity Catalog table with no Atlas guid stored on its Loom item, or a
 * Purview asset with no UC full_name — the "merge" silently degraded to a single
 * source. This module closes that gap: given ONE key for the focus asset it
 * discovers the OTHERS so the fan-out reaches every source.
 *
 *   UC full_name  ──getEntityByQualifiedName('databricks_table', qn)──▶ Atlas guid
 *   UC full_name  ──getTable().storage_location───────────────────────▶ abfss path
 *                    (bridges an external table to the Purview/ADLS node)
 *   Atlas guid    ──getAssetDetail().attributes.qualifiedName──────────▶ UC full_name / path
 *
 * Every probe is best-effort: a missing Purview / Databricks config, a 404, or a
 * permission error is swallowed and the original keys are returned unchanged
 * (per no-vaporware.md — degrade, never fabricate). The Atlas qualifiedName
 * convention used here is the SAME one Loom's `/api/catalog/register` route
 * writes and `normalizeIdentity()` round-trips, so the discovered keys collapse
 * onto the focus node in `mergeGraphs()`.
 */
import { normalizeIdentity } from './unified-lineage';

export interface AssetIdentityInput {
  /** Unity Catalog catalog.schema.table for the focus, when known. */
  ucFullName?: string;
  /** Databricks workspace hostname for the UC ⇄ Atlas qualifiedName + getTable. */
  ucHost?: string;
  /** Atlas / Purview entity guid for the focus, when known. */
  purviewGuid?: string;
}

export interface ResolvedAssetIdentities {
  ucFullName?: string;
  purviewGuid?: string;
  /** abfss/wasbs storage path discovered for the focus (UC storage_location or
   *  the Atlas ADLS qualifiedName) — added as a `path:` focus identity so an
   *  external table bridges to the Purview/ADLS node. */
  storagePath?: string;
}

/** The Atlas qualifiedName Loom registers a UC table under (matches
 *  registerAtlasEntity + normalizeIdentity's `/unity-catalog/tables/` rule). */
function ucAtlasQualifiedName(host: string, fullName: string): string {
  return `https://${host.replace(/^https?:\/\//, '').replace(/\/$/, '')}/api/2.1/unity-catalog/tables/${fullName}`;
}

/** Discover the cross-source identities of the focus asset from whichever key
 *  the caller already holds. Never throws — returns the inputs on any failure. */
export async function resolveAssetIdentities(
  input: AssetIdentityInput,
): Promise<ResolvedAssetIdentities> {
  const out: ResolvedAssetIdentities = {
    ucFullName: input.ucFullName,
    purviewGuid: input.purviewGuid,
  };

  // --- UC full_name → Atlas guid + storage path ---
  if (input.ucFullName && input.ucHost) {
    // guid: only worth probing when Purview is actually configured.
    if (!out.purviewGuid) {
      try {
        const { isPurviewConfigured, getEntityByQualifiedName } = await import('./purview-client');
        if (isPurviewConfigured()) {
          const qn = ucAtlasQualifiedName(input.ucHost, input.ucFullName);
          const ent = await getEntityByQualifiedName('databricks_table', qn);
          const guid = ent?.entity?.guid || ent?.guid || ent?.entities?.[0]?.guid;
          if (typeof guid === 'string' && guid) out.purviewGuid = guid;
        }
      } catch { /* best-effort */ }
    }
    // storage path for the ADLS bridge.
    if (!out.storagePath) {
      try {
        const { getTable } = await import('./unity-catalog-client');
        const t = await getTable(input.ucHost, input.ucFullName);
        if (t?.storage_location) out.storagePath = t.storage_location;
      } catch { /* best-effort */ }
    }
  }

  // --- Atlas guid → UC full_name / storage path ---
  if (input.purviewGuid && (!out.ucFullName || !out.storagePath)) {
    try {
      const { isPurviewConfigured, getAssetDetail } = await import('./purview-client');
      if (isPurviewConfigured()) {
        const detail = await getAssetDetail(input.purviewGuid);
        const attrs = detail?.entity?.attributes || detail?.attributes || {};
        const qn: string | undefined = attrs.qualifiedName || attrs.qualified_name;
        if (qn) {
          const ident = normalizeIdentity(qn);
          if (!out.ucFullName && ident.startsWith('uc:')) out.ucFullName = ident.slice(3);
          if (!out.storagePath && ident.startsWith('path:')) out.storagePath = qn;
        }
      }
    } catch { /* best-effort */ }
  }

  return out;
}

/** Convenience: the canonical `path:` identity for a discovered storage path,
 *  or undefined. Re-exported so the focus can add it to its identity set. */
export function storagePathIdentity(path: string | undefined): string | undefined {
  if (!path) return undefined;
  const ident = normalizeIdentity(path);
  return ident.startsWith('path:') ? ident : undefined;
}
