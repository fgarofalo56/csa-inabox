/**
 * POST /api/assets/materialize — N5 "Materialize" — run an asset's REAL job.
 *
 * body { assetKey, materializer?, dryRun? }
 *   → { ok, engine, runId, detail, asset }
 *
 * Dispatches to the client that already runs that engine (SQLMesh/dbt via the
 * loom-transform-runner Container App, Synapse via the Studio dev REST
 * createRun, Databricks via jobs/2.1 run-now). No mock queue, no fake receipt:
 * an unbound or unconfigured materializer returns an HONEST 503-class gate
 * naming exactly what to bind or set.
 *
 * The dispatch outcome is stamped onto the `loom-assets` sidecar through the
 * SAME `recordMaterialization` the reconciler uses, so the thrash-guard
 * watermarks (`lastTriggerAt`, `consecutiveFailures`) stay consistent across the
 * manual and automatic paths. Every dispatch writes an `_auditLog` row (ATO).
 */
import { apiError, apiOk, apiServerError } from '@/lib/api/respond';
import { withSession } from '@/lib/api/route-toolkit';
import { findAsset, getAssetRegistry, invalidateAssetRegistry } from '@/lib/assets/asset-registry';
import { materializeAsset } from '@/lib/assets/materialize';
import { recordMaterialization, saveAssetPolicy } from '@/lib/assets/asset-store';
import { coerceMaterializer, normalizeAssetKey } from '@/lib/azure/asset-registry-model';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withSession(async (req, { session }) => {
  try {
    const body = (await req.json().catch(() => ({}))) as {
      assetKey?: unknown; materializer?: unknown; dryRun?: unknown;
    };
    const key = normalizeAssetKey(body.assetKey);
    if (!key) return apiError('assetKey is required', 400, { code: 'missing_asset_key' });

    // Tenant scope declared explicitly + asserted in the registry (defence in
    // depth). The asset must exist in THIS principal's derived graph before any
    // job is dispatched, and materializeAsset re-checks item ownership itself.
    const snapshot = await getAssetRegistry(session, { tenantId: session.claims.oid });
    const asset = findAsset(snapshot, key);
    if (!asset) {
      return apiError(
        `No asset "${key}" in the derived graph. The asset plane is derived from lineage — materialize it from the Assets canvas so the binding resolves.`,
        404,
        { code: 'asset_not_found' },
      );
    }

    // An explicit binding in the request wins (the inspector's "bind & run") and
    // is PERSISTED through the audited policy save, so the reconciler sees the
    // same binding the operator just used — never a one-shot binding that
    // silently evaporates.
    let binding = asset.materializer;
    if (body.materializer !== undefined) {
      binding = coerceMaterializer(body.materializer);
      await saveAssetPolicy(session, {
        assetKey: asset.key,
        policy: asset.policy,
        materializer: binding,
        name: asset.name,
        kind: asset.kind,
        group: asset.group,
      });
      invalidateAssetRegistry();
    }
    const dryRun = body.dryRun === true;

    const result = await materializeAsset(session, binding, { assetKey: asset.key, dryRun });

    // A dry run is a preview — it must NOT move the freshness watermarks.
    if (!dryRun) {
      await recordMaterialization(session, {
        assetKey: asset.key,
        outcome: result.ok ? 'succeeded' : 'failed',
        runId: result.runId,
        detail: result.detail,
        reason: 'manual materialize',
        version: asset.observedVersion,
        seed: { policy: asset.policy, materializer: binding, name: asset.name },
      });
      invalidateAssetRegistry();
    }

    if (!result.ok && result.gated) {
      return apiError(result.detail, 503, {
        code: 'materializer_not_configured',
        gated: true,
        engine: result.engine,
        missing: result.missing,
      });
    }
    if (!result.ok) {
      return apiError(result.detail, 502, { code: 'materialize_failed', engine: result.engine });
    }
    return apiOk({
      assetKey: asset.key,
      engine: result.engine,
      runId: result.runId,
      dryRun,
      detail: result.detail,
    });
  } catch (e) {
    return apiServerError(e, 'materialize failed', 'materialize_error');
  }
});
