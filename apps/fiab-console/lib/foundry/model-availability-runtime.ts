/**
 * model-availability-runtime — the cached, NON-BLOCKING runtime wiring that
 * degrades a resolved AOAI target to a model that is actually deployed
 * (model-strategy M5).
 *
 * The pure matrix + fallback logic lives in `model-availability-matrix.ts`. This
 * module adds the ONE side-effect that module deliberately avoids: reading the
 * account's LIVE deployment list (via `foundry-cs-client.listModelDeployments`)
 * so `ensureDeploymentAvailable` has real data to resolve against.
 *
 * DESIGN — "never block a chat on the check" (PRP §4c):
 *   • The deployment list is CACHED with a TTL and refreshed in the BACKGROUND
 *     (fire-and-forget). {@link applyAvailabilityFallback} itself is SYNCHRONOUS
 *     and never awaits a network call, so wiring it into `resolveAoaiTarget` adds
 *     zero latency to the hot path.
 *   • The FIRST call (cold cache) returns the configured target UNCHANGED and
 *     kicks off a background refresh — byte-identical to pre-M5 behaviour, no
 *     new 404 surface. Subsequent calls, once the cache is warm, swap a
 *     configured-but-missing deployment down to a supported one.
 *   • Every failure is swallowed (non-fatal): a refresh that throws (no
 *     subscription, no credential, ARM error) simply leaves the cache empty and
 *     the target unchanged. It can NEVER take a Copilot down.
 *
 * Opt-out: `LOOM_AOAI_AVAILABILITY_CHECK=false` disables the swap entirely
 * (default-ON per loom_default_on_opt_out). `LOOM_AOAI_AVAILABILITY_TTL_MS`
 * tunes the cache TTL (default 5 min).
 */

import type { AoaiTarget } from '../azure/copilot-orchestrator';
import { detectLoomCloud } from '../azure/cloud-endpoints';
import {
  ensureDeploymentAvailable,
  type AvailableDeployment,
  type DeploymentAvailabilityResult,
} from './model-availability-matrix';

interface DeploymentCache {
  at: number;
  region: string;
  deployments: AvailableDeployment[];
}

let _cache: DeploymentCache | null = null;
let _inflight: Promise<void> | null = null;

/** Cache TTL for the live deployment list (ms). Default 5 minutes. */
function ttlMs(): number {
  const v = Number(process.env.LOOM_AOAI_AVAILABILITY_TTL_MS);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : 5 * 60 * 1000;
}

/** Default-ON: only the literal `false` disables the availability swap. */
export function availabilityCheckEnabled(): boolean {
  return String(process.env.LOOM_AOAI_AVAILABILITY_CHECK ?? '').trim().toLowerCase() !== 'false';
}

/**
 * Whether it is worth attempting a live deployment read. Skips when no
 * subscription is configured (unit-test / unconfigured context) so we never
 * spawn a doomed credential/ARM attempt. `listModelDeployments` resolves the
 * account from `LOOM_AOAI_SUB` / `LOOM_FOUNDRY_SUB` / `LOOM_SUBSCRIPTION_ID`.
 */
function canRefresh(): boolean {
  return !!(
    process.env.LOOM_AOAI_SUB ||
    process.env.LOOM_FOUNDRY_SUB ||
    process.env.LOOM_SUBSCRIPTION_ID
  );
}

/**
 * Fire-and-forget background refresh of the deployment cache. Deduped via a
 * single in-flight promise. All errors are swallowed — a failed refresh leaves
 * the previous cache (or none) in place. Imported lazily so the pure matrix +
 * this module stay free of the foundry-cs-client (ARM/identity) load until a
 * refresh actually runs.
 */
function refresh(): void {
  if (_inflight || !canRefresh()) return;
  _inflight = (async () => {
    try {
      const { listModelDeployments } = await import('../azure/foundry-cs-client');
      const { account, deployments } = await listModelDeployments();
      _cache = {
        at: Date.now(),
        region: account?.location ?? process.env.LOOM_REGION ?? '',
        deployments: deployments.map((d) => ({ name: d.name, modelName: d.modelName })),
      };
    } catch {
      // Non-fatal: leave the existing cache (or null) untouched.
    } finally {
      _inflight = null;
    }
  })();
  // Prevent an unhandled-rejection warning; the promise already catches inside.
  void _inflight.catch(() => {});
}

/** Test/diagnostic seam: inspect or reset the module cache. */
export function _peekAvailabilityCache(): DeploymentCache | null {
  return _cache;
}
export function _resetAvailabilityCache(seed?: DeploymentCache | null): void {
  _cache = seed ?? null;
  _inflight = null;
}

/**
 * Degrade `target.deployment` to a model that is actually deployed when the
 * configured one is missing (the Gov-lag 404 class). SYNCHRONOUS + non-blocking:
 *   • disabled or cold cache → returns `target` unchanged (and kicks off a
 *     background refresh so the NEXT call can resolve),
 *   • warm cache → runs the pure {@link ensureDeploymentAvailable} and swaps ONLY
 *     the deployment segment when a supported fallback is found.
 *
 * Only ever swaps to a model the account already has; never invents one and
 * never throws.
 */
export function applyAvailabilityFallback(target: AoaiTarget): AoaiTarget {
  if (!availabilityCheckEnabled() || !target?.deployment) return target;

  const fresh = _cache && Date.now() - _cache.at < ttlMs();
  if (!fresh) refresh(); // background; does not block this call.
  if (!_cache || _cache.deployments.length === 0) return target;

  const res: DeploymentAvailabilityResult = ensureDeploymentAvailable(
    target.deployment,
    _cache.deployments,
    detectLoomCloud(),
    _cache.region,
    'chat',
  );
  if (res.available && res.fallback && res.deployment && res.deployment !== target.deployment) {
    return { ...target, deployment: res.deployment };
  }
  return target;
}
