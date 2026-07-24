/**
 * POST /api/internal/assets/reconcile — N5 ASSET-RECONCILER pass.
 *
 * The window the in-VNet `loom-asset-reconciler` Container App Job calls once
 * per schedule. Per the estate constraint (Y1 Linux Consumption Functions are
 * structurally broken on this estate — policy seals the storage data-plane) the
 * scheduled runner is an ACA Job, NOT a Function; it is a thin
 * `node e2e/run-asset-reconcile.mjs` that POSTs here with the shared internal
 * token, and ALL the real work runs in the console process where the lineage,
 * Cosmos, ADLS, Synapse, Databricks, transform-runner and alert clients already
 * live. One code path, one source of truth with the Assets canvas.
 *
 * What one pass does, per tenant that has at least one asset policy:
 *   1. Rebuild the DERIVED asset graph (unified-lineage + the N4 model DAG).
 *   2. Observe REAL data signals — Delta commit versions from `_delta_log` in
 *      the customer's own ADLS Gen2, and Event Hubs Capture landing watermarks
 *      (lib/assets/asset-signals.ts). No agent, no polling of a SaaS API.
 *   3. Ask the PURE decision engine (lib/assets/reconciler-core.ts) which assets
 *      to materialize — data-aware first (an upstream committed new data), then
 *      freshness (overdue past cadence + grace). Every thrash guard lives there:
 *      in-flight suppression, per-cadence cooldown, exponential failure backoff,
 *      and a hard per-pass dispatch bound. The reconciler CANNOT tight-loop.
 *   4. Dispatch the REAL backing job through lib/assets/materialize.ts (SQLMesh
 *      / dbt runner, Synapse pipeline, Databricks job) and stamp the outcome on
 *      the sidecar via the SAME recordMaterialization the manual button uses.
 *   5. Alert overdue assets through the O1 shared action group
 *      (lib/azure/alert-dispatch.dispatchAlert → LOOM_ALERT_ACTION_GROUP_ID),
 *      deduped by the asset's own `lastAlertAt` watermark.
 *
 * IDEMPOTENT: re-running a pass immediately re-decides from the SAME watermarks
 * and produces zero dispatches (the cooldown guard). BOUNDED: tenants, signal
 * reads and dispatches are all capped per pass.
 *
 * Auth: machine-to-machine internal token (LOOM_INTERNAL_TOKEN; fail-closed when
 * unset) — the proven /api/internal/cost-anomaly/run pattern. Not a user API.
 * Kill switch: the `n5-asset-reconciler` runtime flag (FLAG0) turns the pass into
 * a no-op in seconds, with no revision roll.
 *
 * Real backends only (no-vaporware). Azure-native (no Fabric dependency).
 * IL5: every hop is in-boundary — Cosmos, ADLS, Synapse/Databricks/transform
 * runner, and the Azure Monitor action group.
 */
import { NextRequest } from 'next/server';
import { apiError, apiOk, apiServerError } from '@/lib/api/respond';
import { isValidInternalToken, INTERNAL_TOKEN_HEADER } from '@/lib/auth/internal-token';
import { runtimeFlag } from '@/lib/admin/runtime-flags';
import { dispatchAlert, type AlertSeverity } from '@/lib/azure/alert-dispatch';
import type { SessionPayload } from '@/lib/auth/session';
import { getAssetRegistry, invalidateAssetRegistry, type RegisteredAsset } from '@/lib/assets/asset-registry';
import { observeAssetSignals } from '@/lib/assets/asset-signals';
import {
  listAllAssetDocs, recordAssetAlert, recordMaterialization, recordObservedVersion,
} from '@/lib/assets/asset-store';
import { materializeAsset } from '@/lib/assets/materialize';
import {
  DEFAULT_MAX_TRIGGERS, planReconcile, type ReconcileCandidate,
} from '@/lib/assets/reconciler-core';
import { CADENCE_MINUTES } from '@/lib/azure/asset-registry-model';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Max tenants reconciled in ONE pass (bounded work per execution). */
const MAX_TENANTS_PER_PASS = 20;
/** Max ADLS signal reads per tenant per pass. */
const MAX_SIGNALS_PER_TENANT = 40;

function authed(req: NextRequest): boolean {
  const bearer = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
  const header = req.headers.get(INTERNAL_TOKEN_HEADER);
  return isValidInternalToken(bearer || null) || isValidInternalToken(header);
}

/**
 * The machine identity the pass acts as for ONE tenant. The reconciler runs
 * outside a user request, so it reconstructs the owner principal from the
 * sidecar's partition key — the same shape /api/internal/copilot/tools uses so
 * every downstream ownership check (loadOwnedItem, listThreadEdges) still runs
 * for real. A tenant with no asset policy is never touched.
 */
function tenantSession(tenantId: string): SessionPayload {
  return {
    claims: { oid: tenantId, upn: tenantId, name: 'asset-reconciler' },
    exp: Math.floor(Date.now() / 1000) + 300,
  };
}

/**
 * An asset alerts only when it declared a severity AND is genuinely overdue
 * (past cadence + grace). 'stale' — inside the grace window — deliberately does
 * NOT page: that is what the grace allowance is for.
 */
function alertSeverityFor(asset: RegisteredAsset): AlertSeverity | null {
  if (asset.freshness.status !== 'overdue') return null;
  const s = asset.policy.alertSeverity;
  return s === 'P1' || s === 'P2' || s === 'P3' ? s : null;
}

interface TenantReceipt {
  tenantId: string;
  assets: number;
  observed: number;
  changed: number;
  dispatched: number;
  deferred: number;
  alerted: number;
  failures: number;
  notes: string[];
}

export async function POST(req: NextRequest) {
  if (!authed(req)) return apiError('invalid internal token', 401, { code: 'bad_internal_token' });

  // FLAG0 kill switch — default-ON, flips in seconds with no revision roll.
  if (!(await runtimeFlag('n5-asset-reconciler', { default: true }))) {
    return apiOk({
      enabled: false, tenants: 0, dispatched: 0, receipts: [],
      note: 'The n5-asset-reconciler runtime flag is OFF — the pass is a no-op. Freshness policies and the Assets canvas are unaffected.',
    });
  }

  let body: { trigger?: string; maxTriggers?: number; tenantIds?: string[] } = {};
  try {
    body = await req.json();
  } catch {
    /* a bare scheduled tick has no body */
  }
  const trigger = String(body?.trigger || 'scheduled');
  const maxTriggers = Number.isFinite(Number(body?.maxTriggers))
    ? Math.max(0, Math.min(200, Number(body!.maxTriggers)))
    : DEFAULT_MAX_TRIGGERS;
  const tenantFilter = Array.isArray(body?.tenantIds) ? new Set(body!.tenantIds!.map(String)) : null;

  try {
    // Only tenants that DECLARED at least one policy are reconciled — a derived
    // graph with no declared expectations has nothing to reconcile, and this is
    // what bounds the pass on a large estate.
    const docs = await listAllAssetDocs();
    const tenantIds = [...new Set(docs.map((d) => d.tenantId))]
      .filter((t) => !tenantFilter || tenantFilter.has(t))
      .sort()
      .slice(0, MAX_TENANTS_PER_PASS);

    const now = new Date();
    const nowMs = now.getTime();
    const receipts: TenantReceipt[] = [];
    let dispatchedTotal = 0;
    let alertedTotal = 0;

    for (const tenantId of tenantIds) {
      const receipt: TenantReceipt = {
        tenantId, assets: 0, observed: 0, changed: 0, dispatched: 0, deferred: 0,
        alerted: 0, failures: 0, notes: [],
      };
      const session = tenantSession(tenantId);

      let snapshot;
      try {
        snapshot = await getAssetRegistry(session, { bypass: true });
      } catch (e) {
        receipt.notes.push(`asset graph unavailable: ${(e as Error)?.message || String(e)}`);
        receipts.push(receipt);
        continue;
      }
      receipt.assets = snapshot.assets.length;
      for (const s of snapshot.sources) {
        if (!s.ok && s.gate) receipt.notes.push(`${s.source}: ${s.gate}`);
      }

      // ── 2. REAL data signals (Delta commit versions / Capture watermarks) ──
      const byKey = new Map(snapshot.assets.map((a) => [a.key, a]));
      const signals = await observeAssetSignals(
        snapshot.assets.map((a) => a.key),
        MAX_SIGNALS_PER_TENANT,
      );
      receipt.observed = signals.size;

      const changed = new Set<string>();
      for (const [key, signal] of signals) {
        const asset = byKey.get(key);
        if (!asset) continue;
        const prior = asset.observedVersion;
        if (typeof prior !== 'number' || signal.version > prior) {
          changed.add(key);
          await recordObservedVersion(session, key, signal.version).catch(() => undefined);
        }
      }
      receipt.changed = changed.size;

      // ── 3. PURE decision (all thrash guards live here) ────────────────────
      const candidates: ReconcileCandidate[] = snapshot.assets.map((a): ReconcileCandidate => ({
        assetKey: a.key,
        policy: a.policy,
        materializer: a.materializer.kind,
        deps: a.upstream,
        ...(a.lastMaterializedAt ? { lastMaterializedAt: a.lastMaterializedAt } : {}),
        ...(a.lastTriggerAt ? { lastTriggerAt: a.lastTriggerAt } : {}),
        ...(a.lastRunOutcome ? { lastRunOutcome: a.lastRunOutcome } : {}),
        ...(typeof a.consecutiveFailures === 'number' ? { consecutiveFailures: a.consecutiveFailures } : {}),
        ...(signals.has(a.key) ? { observedVersion: signals.get(a.key)!.version } : {}),
        ...(typeof a.materializedVersion === 'number' ? { materializedVersion: a.materializedVersion } : {}),
      }));

      const plan = planReconcile({ candidates, changed, now: nowMs, maxTriggers });
      receipt.deferred = plan.deferred.length;

      // ── 4. Dispatch the REAL backing job for each trigger ─────────────────
      for (const decision of plan.triggers) {
        const asset = byKey.get(decision.assetKey);
        if (!asset) continue;
        try {
          const result = await materializeAsset(session, asset.materializer, { assetKey: asset.key });
          await recordMaterialization(session, {
            assetKey: asset.key,
            outcome: result.ok ? 'succeeded' : 'failed',
            runId: result.runId,
            detail: result.detail,
            reason: `reconcile:${decision.reason} — ${decision.detail}`,
            ...(signals.has(asset.key) ? { version: signals.get(asset.key)!.version } : {}),
          });
          if (result.ok) receipt.dispatched += 1;
          else {
            receipt.failures += 1;
            receipt.notes.push(`${asset.key}: ${result.gated ? 'gate' : 'failed'} — ${result.detail.slice(0, 200)}`);
          }
        } catch (e) {
          receipt.failures += 1;
          await recordMaterialization(session, {
            assetKey: asset.key,
            outcome: 'failed',
            detail: (e as Error)?.message || String(e),
            reason: `reconcile:${decision.reason}`,
          }).catch(() => undefined);
        }
      }
      dispatchedTotal += receipt.dispatched;

      // ── 5. Overdue alerts through the O1 shared action group ──────────────
      for (const asset of snapshot.assets) {
        const severity = alertSeverityFor(asset);
        if (!severity) continue;
        const cadenceMinutes = CADENCE_MINUTES[asset.policy.cadence] ?? 0;
        // Dedup: never re-alert inside one cadence period.
        const doc = docs.find((d) => d.tenantId === tenantId && d.assetKey === asset.key);
        const lastAlert = doc?.lastAlertAt ? Date.parse(doc.lastAlertAt) : NaN;
        if (Number.isFinite(lastAlert) && nowMs - lastAlert < cadenceMinutes * 60_000) continue;

        await dispatchAlert({
          source: 'asset-reconciler',
          severity,
          title: `Asset overdue — ${asset.name}`,
          body:
            `${asset.key} is ${asset.freshness.overdueByMinutes} min past its freshness policy ` +
            `(cadence ${asset.freshness.cadenceMinutes} min + ${asset.freshness.graceMinutes} min grace). ` +
            `Materializer: ${asset.materializer.kind}; mode: ${asset.policy.mode}. ` +
            `Open /assets and select the asset for its upstream chain and last run detail.`,
          dedupKey: `asset-freshness:${asset.key}`,
        });
        await recordAssetAlert(session, asset.key).catch(() => undefined);
        receipt.alerted += 1;
      }
      alertedTotal += receipt.alerted;

      // The next canvas read must see this pass's watermarks.
      invalidateAssetRegistry();
      receipts.push(receipt);
    }

    return apiOk({
      enabled: true,
      trigger,
      tenants: tenantIds.length,
      dispatched: dispatchedTotal,
      alerted: alertedTotal,
      maxTriggers,
      receipts,
      ranAt: now.toISOString(),
    });
  } catch (e) {
    return apiServerError(e, 'asset reconcile failed', 'asset_reconcile_failed');
  }
}
