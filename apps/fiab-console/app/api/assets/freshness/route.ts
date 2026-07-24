/**
 * /api/assets/freshness — N5 per-asset FRESHNESS POLICY.
 *
 * GET  → every saved policy (the `loom-assets` sidecars) plus the dropdown
 *        option sets the editor renders, so the client never hard-codes them.
 * PUT  → save ONE asset's policy (and optionally its materializer binding).
 *
 * The payload is dropdown-only by construction: `coerceAssetPolicy` /
 * `coerceMaterializer` reject anything outside the declared option sets, so a
 * hand-crafted request can never write a free-form cadence
 * (loom_no_freeform_config). Every save writes an `_auditLog` row (ATO).
 */
import { apiError, apiOk, apiServerError } from '@/lib/api/respond';
import { withSession } from '@/lib/api/route-toolkit';
import { getAssetDoc, listAssetDocs, saveAssetPolicy } from '@/lib/assets/asset-store';
import { findAsset, getAssetRegistry, invalidateAssetRegistry } from '@/lib/assets/asset-registry';
import { evaluateFreshness } from '@/lib/assets/freshness';
import {
  ALERT_OPTIONS, CADENCE_OPTIONS, GRACE_OPTIONS, MODE_OPTIONS,
  coerceAssetPolicy, coerceMaterializer, normalizeAssetKey,
} from '@/lib/azure/asset-registry-model';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withSession(async (req, { session }) => {
  try {
    const url = new URL(req.url);
    const key = normalizeAssetKey(url.searchParams.get('assetKey') || '');
    if (key) {
      const doc = await getAssetDoc(session, key);
      return apiOk({
        assetKey: key,
        policy: doc?.policy ?? null,
        materializer: doc?.materializer ?? null,
        freshness: doc
          ? evaluateFreshness({ policy: doc.policy, lastMaterializedAt: doc.lastMaterializedAt })
          : null,
        options: { cadence: CADENCE_OPTIONS, grace: GRACE_OPTIONS, mode: MODE_OPTIONS, alert: ALERT_OPTIONS },
      });
    }
    const docs = await listAssetDocs(session);
    return apiOk({
      policies: docs.map((d) => ({
        assetKey: d.assetKey,
        name: d.name,
        policy: d.policy,
        materializer: d.materializer,
        lastMaterializedAt: d.lastMaterializedAt,
        freshness: evaluateFreshness({ policy: d.policy, lastMaterializedAt: d.lastMaterializedAt }),
      })),
      options: { cadence: CADENCE_OPTIONS, grace: GRACE_OPTIONS, mode: MODE_OPTIONS, alert: ALERT_OPTIONS },
    });
  } catch (e) {
    return apiServerError(e, 'freshness policy read failed', 'asset_policy_read_failed');
  }
});

export const PUT = withSession(async (req, { session }) => {
  try {
    const body = (await req.json().catch(() => ({}))) as {
      assetKey?: unknown; policy?: unknown; materializer?: unknown;
    };
    const key = normalizeAssetKey(body.assetKey);
    if (!key) return apiError('assetKey is required', 400, { code: 'missing_asset_key' });

    // Enrich the sidecar with the DERIVED identity so a policy row stays
    // readable even if lineage later changes shape.
    // Tenant scope declared explicitly + asserted in the registry (defence in
    // depth); the sidecar write below lands in this principal's own partition.
    const snapshot = await getAssetRegistry(session, { tenantId: session.claims.oid });
    const derived = findAsset(snapshot, key);

    const doc = await saveAssetPolicy(session, {
      assetKey: derived?.key ?? key,
      policy: coerceAssetPolicy(body.policy),
      ...(body.materializer !== undefined ? { materializer: coerceMaterializer(body.materializer) } : {}),
      ...(derived?.name ? { name: derived.name } : {}),
      ...(derived?.kind ? { kind: derived.kind } : {}),
      ...(derived?.group ? { group: derived.group } : {}),
    });
    invalidateAssetRegistry();

    return apiOk({
      assetKey: doc.assetKey,
      policy: doc.policy,
      materializer: doc.materializer,
      freshness: evaluateFreshness({ policy: doc.policy, lastMaterializedAt: doc.lastMaterializedAt }),
    });
  } catch (e) {
    return apiServerError(e, 'freshness policy save failed', 'asset_policy_save_failed');
  }
});
