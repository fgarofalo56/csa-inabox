/**
 * LU-5 — Purview FOLD-IN for the Loom Unity governance overlay.
 *
 * WHICH PURVIEW API SURFACE (verified in this tree, not assumed)
 * -------------------------------------------------------------
 * The account CSA Loom provisions via ARM (`Microsoft.Purview/accounts`) is a
 * CLASSIC Data Map account: Atlas v2 under `{account}.purview.azure.{com|us}
 * /datamap/api/atlas/v2/...`. It does NOT expose the new unified-catalog host
 * (`{account}-api...`) or the `/datagovernance` surface — calling those is what
 * broke Loom's governance surfaces before (see the header of
 * `lib/azure/purview-client.ts`, and `PurviewUnifiedCatalogGateError`). So this
 * module targets ONLY Atlas v2 primitives that already exist in that client:
 *
 *   governed tags  →  Atlas CLASSIFICATIONS   (ensureClassificationDefs +
 *                     addAssetClassification) — a classification is a typedef
 *                     that must exist before it can be attached, the exact
 *                     structural analogue of a controlled vocabulary.
 *   free tags +    →  Atlas BUSINESS METADATA (`LoomCustomTags` namespace,
 *   certification     setBusinessMetadata, which grows the typedef on demand) —
 *                     classic Atlas has no endorsement concept, so the rung
 *                     rides along as an attribute.
 *
 * The pure projection (which fact goes where, and the Atlas-safe naming) lives
 * in `model.projectOverlayToPurview` so it is unit-testable with no account.
 *
 * HONESTY (`.claude/rules/no-vaporware.md`): every non-sync path returns a
 * REASON naming the exact missing piece — `LOOM_PURVIEW_ACCOUNT`, a missing
 * Atlas entity (register the securable first), or the verbatim Purview error.
 * Nothing here is required for the overlay itself to work: the overlay is
 * Cosmos-backed and fully functional with no Purview account at all.
 */
import {
  addAssetClassification, ensureClassificationDefs, isPurviewConfigured,
  setBusinessMetadata,
} from '@/lib/azure/purview-client';
import { resolveAssetIdentities } from '@/lib/azure/asset-identity';
import { resolveWorkspaceHostnames } from '@/lib/azure/unity-catalog-client';
import { projectOverlayToPurview, type UcGovernanceOverlay, type UcPurviewProvenance } from './model';

export interface UcPurviewSyncResult {
  synced: boolean;
  /** Populated when `synced` is false — the exact, actionable reason. */
  reason?: string;
  guid?: string;
  classifications: string[];
  businessMetadataKeys: string[];
}

/** Best-effort UC host for the Atlas qualifiedName (both backends). */
async function firstUcHost(): Promise<string | undefined> {
  try {
    const hosts = await resolveWorkspaceHostnames();
    return hosts[0];
  } catch {
    return undefined;
  }
}

/**
 * Push one overlay into the classic Purview Data Map.
 *
 * Column overlays are NOT synced: their Atlas counterpart is a column entity
 * that has to be materialised first (`ensureColumnEntities`), which is the
 * lineage path's job — so this returns an honest reason rather than pretending.
 *
 * Returns a result; only a genuine Purview transport failure throws
 * (`PurviewError` with the upstream status, surfaced verbatim by the route per
 * no-vaporware).
 */
export async function syncOverlayToPurview(
  overlay: UcGovernanceOverlay,
  opts: { ucHost?: string } = {},
): Promise<UcPurviewSyncResult> {
  const projection = projectOverlayToPurview(overlay);
  const empty = { classifications: [], businessMetadataKeys: [] };

  if (overlay.securableType === 'column') {
    return {
      synced: false,
      reason: 'Column overlays are not mirrored into Purview: the Atlas column entity is created by the lineage register path (/api/catalog/register), not by the governance overlay.',
      ...empty,
    };
  }
  if (!isPurviewConfigured()) {
    return {
      synced: false,
      reason: 'Microsoft Purview is not configured in this deployment. Set LOOM_PURVIEW_ACCOUNT on the Console Container App (platform/fiab/bicep/modules/admin-plane/catalog.bicep deploys the Purview account) and grant the Console UAMI the Data Curator role on the root collection.',
      ...empty,
    };
  }
  if (!projection.classifications.length && !Object.keys(projection.businessMetadata).length) {
    return { synced: false, reason: 'Nothing to sync: this securable has no tags and no certification.', ...empty };
  }

  const ucHost = opts.ucHost || (await firstUcHost());
  const ids = await resolveAssetIdentities({ ucFullName: overlay.fullName, ucHost });
  const guid = overlay.purview?.guid || ids.purviewGuid;
  if (!guid) {
    return {
      synced: false,
      reason: `No Purview asset is registered for ${overlay.fullName}. Register it first (Catalog → Register, POST /api/catalog/register with source=unity-catalog) so the Atlas entity exists, then re-run the sync.`,
      ...empty,
    };
  }

  if (projection.classifications.length) {
    await ensureClassificationDefs(projection.classifications);
    await addAssetClassification(guid, projection.classifications);
  }
  const bmKeys = Object.keys(projection.businessMetadata);
  if (bmKeys.length) {
    await setBusinessMetadata(guid, projection.businessMetadata);
  }

  return {
    synced: true,
    guid,
    classifications: projection.classifications,
    businessMetadataKeys: bmKeys,
  };
}

/** Provenance stamp to persist on the overlay after a successful sync. */
export function provenanceFromSync(result: UcPurviewSyncResult): UcPurviewProvenance | undefined {
  if (!result.synced) return undefined;
  return {
    ...(result.guid ? { guid: result.guid } : {}),
    syncedAt: new Date().toISOString(),
    classifications: result.classifications,
    businessMetadataKeys: result.businessMetadataKeys,
  };
}
