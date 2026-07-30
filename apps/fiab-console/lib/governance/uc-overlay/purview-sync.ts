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
 *   free tags +    →  Atlas BUSINESS METADATA (a TENANT-NAMESPACED
 *   certification     `LoomCustomTags_<t8>` bag, setBusinessMetadata, which
 *                     grows the typedef on demand) — classic Atlas has no
 *                     endorsement concept, so the rung rides along as an
 *                     attribute. The bag is namespaced for the same reason the
 *                     classification names are: Atlas typedefs are
 *                     ACCOUNT-GLOBAL and this write is `isOverwrite=true`.
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
  removeAssetClassification, setBusinessMetadata,
} from '@/lib/azure/purview-client';
import { asAtlasClassificationTypedefName } from '@/lib/azure/purview-typedef-namespace';
import { resolveAssetIdentities } from '@/lib/azure/asset-identity';
import { resolveWorkspaceHostnames } from '@/lib/azure/unity-catalog-client';
import {
  projectOverlayToPurview, UcOverlayError,
  type UcGovernanceOverlay, type UcPurviewProvenance,
} from './model';

export interface UcPurviewSyncResult {
  synced: boolean;
  /** Populated when `synced` is false — the exact, actionable reason. */
  reason?: string;
  guid?: string;
  classifications: string[];
  /** Stale classifications this sync REMOVED from the asset (supersede). */
  removedClassifications: string[];
  businessMetadataKeys: string[];
  /** The tenant-namespaced Atlas business-metadata bag those keys were written
   *  under (`LoomCustomTags_<t8>`). */
  businessMetadataName?: string;
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
 * Push one overlay into the classic Purview Data Map — as a SUPERSEDE, not an
 * append.
 *
 * WHY SUPERSEDE (this is a security property, not tidiness): an add-only sync
 * lets an asset accumulate contradictory, unrevocable signals — carrying both
 * `…_pii_yes` and `…_pii_no`, or keeping `loom_certification: certified` after
 * Loom de-certified it. Purview classifications and business metadata feed
 * downstream labelling / DLP / access decisions, so a stale "certified" or
 * "not PII" claim is actively dangerous. Every sync therefore:
 *   1. computes the DESIRED classification set from the current overlay,
 *   2. removes every classification a previous Loom sync recorded in
 *      `overlay.purview.classifications` that is no longer desired,
 *   3. writes the full business-metadata map with `isOverwrite=true`, blanking
 *      any key a previous sync wrote that the overlay no longer carries, and
 *      always emitting `loom_certification` (`none` when de-certified).
 * An overlay stripped back to nothing therefore still syncs — it CLEARS.
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
  const empty = { classifications: [], removedClassifications: [], businessMetadataKeys: [] };
  const priorClassifications = overlay.purview?.classifications || [];
  const priorBmKeys = overlay.purview?.businessMetadataKeys || [];

  let projection;
  try {
    projection = projectOverlayToPurview(overlay);
  } catch (e) {
    if (e instanceof UcOverlayError) return { synced: false, reason: e.message, ...empty };
    throw e;
  }

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

  const stale = priorClassifications.filter((n) => !projection.classifications.includes(n));
  // Keys a PREVIOUS sync wrote that this overlay no longer carries must be
  // blanked, or a removed free tag survives in Purview forever.
  const clearedBmKeys = priorBmKeys.filter((k) => !(k in projection.businessMetadata));
  for (const k of clearedBmKeys) projection.businessMetadata[k] = '';

  const nothingDesired = !projection.classifications.length
    && !Object.values(projection.businessMetadata).some((v) => v !== '' && v !== 'none');
  const nothingToClear = !stale.length && !clearedBmKeys.length && !priorClassifications.length && !priorBmKeys.length;
  if (nothingDesired && nothingToClear) {
    return { synced: false, reason: 'Nothing to sync: this securable has no tags and no certification, and Loom has never pushed anything for it.', ...empty };
  }

  const ucHost = opts.ucHost || (await firstUcHost());
  const ids = await resolveAssetIdentities({ ucFullName: overlay.fullName, ucHost });
  // A LIVE resolve wins over the cached provenance guid: if the Atlas entity was
  // re-registered it has a NEW guid, and pushing to the recorded-but-dead one
  // would report `synced: true` while changing nothing.
  const guid = ids.purviewGuid || overlay.purview?.guid;
  if (!guid) {
    return {
      synced: false,
      reason: `No Purview asset is registered for ${overlay.fullName}. Register it first (Catalog → Register, POST /api/catalog/register with source=unity-catalog) so the Atlas entity exists, then re-run the sync.`,
      ...empty,
    };
  }

  if (stale.length) {
    await removeAssetClassification(guid, stale);
  }
  if (projection.classifications.length) {
    // `model.atlasClassificationName` already puts the tenant discriminator
    // first; funnel it through the authority so the branded type — not this
    // file's good intentions — is what lets it reach the account-global
    // typedef API. `model.ts` cannot import the authority itself (the authority
    // imports model, and model must stay client-importable), so the mint
    // happens here, on the server side of the projection.
    await ensureClassificationDefs(projection.classifications.map(asAtlasClassificationTypedefName));
    await addAssetClassification(guid, projection.classifications);
  }
  const bmKeys = Object.keys(projection.businessMetadata);
  if (bmKeys.length) {
    // TENANT-NAMESPACED bag (`LoomCustomTags_<t8>`), not the account-global
    // `LoomCustomTags` default — see model.tenantBusinessMetadataName. Atlas
    // business-metadata typedefs are account-global and this is written with
    // isOverwrite=true, so the default would let one tenant clobber another's
    // cost_center / loom_certification on a shared Purview account.
    await setBusinessMetadata(guid, projection.businessMetadata, projection.businessMetadataName);
  }

  return {
    synced: true,
    guid,
    classifications: projection.classifications,
    removedClassifications: stale,
    // Record only the keys that still carry a value — the blanked ones are gone
    // and must not be re-blanked (nor counted as "pushed") on the next sync.
    businessMetadataKeys: bmKeys.filter((k) => projection.businessMetadata[k] !== ''),
    businessMetadataName: projection.businessMetadataName,
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
    ...(result.businessMetadataName ? { businessMetadataName: result.businessMetadataName } : {}),
  };
}
