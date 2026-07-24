/**
 * fault-injection — the CH1 dependency-fault chaos substrate.
 *
 * A13's chaos harness is Spark-only (it kills Livy sessions / arms a pool's
 * FAULTED breaker). The other three first-class dependencies — Cosmos, Azure
 * OpenAI, ADX, and Key Vault — had breakers/retries/serve-stale wired piecemeal
 * (`redis-cache-client.ts` breaker, `getOrComputeCached`'s `serveStaleOnError`,
 * `aoai-chat-client`'s APIM→direct fallback, `fetchWithTimeout`'s per-request
 * deadline) but NO way to *prove* those paths degrade to an honest gate /
 * stale-serve instead of a crash. This module is that proof harness: an
 * in-process registry of ARMED faults that real client chokepoints consult and,
 * when a matching fault is armed, fail EXACTLY as the real dependency would
 * (Cosmos 429 `TooManyRequests`, AOAI 429 / timeout, ADX cold-start 503, KV 429)
 * so the existing resilience code runs end-to-end.
 *
 * NEVER ACTIVE BY DEFAULT — three independent guarantees:
 *   1. The registry starts EMPTY. Only the triple-gated admin route
 *      (`app/api/admin/chaos/dependency`) can arm a fault (tenant admin +
 *      `ch1-dependency-chaos` runtime flag ON + a valid `LOOM_INTERNAL_TOKEN`).
 *   2. `dependencyChaosEnabled()` — every injection chokepoint is a hard no-op
 *      unless `LOOM_DEPENDENCY_CHAOS_ENABLED` is truthy in the environment, so
 *      in production (the var unset) the injection code path is PROVABLY DEAD
 *      regardless of registry contents. This mirrors A13's `LOOM_SPARK_CHAOS_ENABLED`.
 *   3. Every armed fault AUTO-EXPIRES (bounded TTL, default 60s, max 5min) and is
 *      occurrence-capped, so a forgotten drill self-heals — a fault can never
 *      outlive the drill window.
 *
 * Every injection is audited: it is recorded in a per-fault in-process ring
 * (surfaced on the admin chaos tab) and fanned out through `emitAuditEvent`
 * (SIEM/webhooks) via a lazy import so this module stays free of the heavy audit
 * graph (keeping `fetch-with-timeout.ts`'s static import surface tiny).
 *
 * Per-replica state: the registry is module-scoped, so a fault armed on one ACA
 * replica only injects on that replica — matching the redis breaker + warm-pool
 * breaker model (a drill targets the replica it is dispatched to).
 */

// ── Fault taxonomy ───────────────────────────────────────────────────────────

/** The injectable dependency-fault points (one per real degradation class). */
export type FaultPoint =
  | 'cosmos-429' // Cosmos throttling — the RU-exhaustion 429 (`TooManyRequests`)
  | 'aoai-429' // Azure OpenAI token-rate-limit 429 (Retry-After)
  | 'aoai-timeout' // Azure OpenAI inference hang → the LLM fetch deadline trips
  | 'adx-cold' // ADX cluster cold-start — 503 while the engine is warming
  | 'kv-throttle'; // Key Vault request throttling — 429

export const FAULT_POINTS: readonly FaultPoint[] = [
  'cosmos-429',
  'aoai-429',
  'aoai-timeout',
  'adx-cold',
  'kv-throttle',
];

/** Human labels + what each fault PROVES, for the admin surface + audit. */
export const FAULT_META: Record<FaultPoint, { label: string; dependency: string; proves: string }> = {
  'cosmos-429': {
    label: 'Cosmos 429 (throttling)',
    dependency: 'Azure Cosmos DB',
    proves:
      'Every Cosmos read gates on ensure(); an injected 429 forces reads to throw so a getOrComputeCached serveStaleOnError surface serves the last-good copy + an honest banner instead of 5xx.',
  },
  'aoai-429': {
    label: 'Azure OpenAI 429 (token rate limit)',
    dependency: 'Azure OpenAI',
    proves:
      'A 429 from the model endpoint is surfaced as an honest AoaiResponseError → the Copilot dock shows a rate-limit message, never a dark render.',
  },
  'aoai-timeout': {
    label: 'Azure OpenAI timeout (inference hang)',
    dependency: 'Azure OpenAI',
    proves:
      'A hung inference call trips the LLM_FETCH_TIMEOUT_MS deadline (FetchTimeoutError) instead of pinning the worker — the caller degrades gracefully.',
  },
  'adx-cold': {
    label: 'ADX cold-start (503)',
    dependency: 'Azure Data Explorer',
    proves:
      'A cold ADX cluster returns 503; the Kusto client surfaces an honest KustoError and the cached query path degrades rather than crashing the RTI surface.',
  },
  'kv-throttle': {
    label: 'Key Vault throttle (429)',
    dependency: 'Azure Key Vault',
    proves:
      'A throttled Key Vault returns 429; the KV client surfaces an honest KeyVaultError with the status, not an unhandled crash.',
  },
};

// ── Hard production gate ─────────────────────────────────────────────────────

/**
 * The hard, provable production-safety gate: injection is a no-op unless
 * `LOOM_DEPENDENCY_CHAOS_ENABLED` is truthy. With the var unset (the production
 * default) every chokepoint returns immediately — the fault code is dead. Pure;
 * `env` is injectable for tests.
 */
export function dependencyChaosEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = String(env.LOOM_DEPENDENCY_CHAOS_ENABLED ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on' || v === 'yes';
}

// ── Bounds (a fault can never outlive its drill window) ──────────────────────

/** Default arm TTL when the caller does not specify one. */
export const DEFAULT_FAULT_TTL_MS = 60_000;
/** Hard ceiling on an arm TTL — a fault self-heals within 5 minutes, always. */
export const MAX_FAULT_TTL_MS = 5 * 60_000;
/** Hard ceiling on the per-fault occurrence budget. */
export const MAX_FAULT_OCCURRENCES = 1_000;
/** How many recent injections each fault keeps for the audit surface. */
const INJECTION_RING = 25;

// ── Registry ─────────────────────────────────────────────────────────────────

/** One recorded fault injection (audit ring entry). */
export interface InjectionRecord {
  at: number;
  point: FaultPoint;
  detail: string;
}

interface ArmedFault {
  point: FaultPoint;
  armedAt: number;
  expiresAt: number;
  /** Remaining injections; null = unbounded within the TTL window. */
  remaining: number | null;
  reason: string;
  armedBy: string;
  injectedCount: number;
  injections: InjectionRecord[];
}

/** A read-only view of one armed fault for the admin surface. */
export interface ArmedFaultView {
  point: FaultPoint;
  label: string;
  dependency: string;
  armedAt: number;
  expiresAt: number;
  msRemaining: number;
  remaining: number | null;
  reason: string;
  armedBy: string;
  injectedCount: number;
  recentInjections: InjectionRecord[];
}

/** Module-scoped registry (per ACA replica). Empty by default. */
const registry = new Map<FaultPoint, ArmedFault>();

/** True when `point` is a known fault point (route input validation). */
export function isFaultPoint(v: unknown): v is FaultPoint {
  return typeof v === 'string' && (FAULT_POINTS as readonly string[]).includes(v);
}

function view(f: ArmedFault): ArmedFaultView {
  return {
    point: f.point,
    label: FAULT_META[f.point].label,
    dependency: FAULT_META[f.point].dependency,
    armedAt: f.armedAt,
    expiresAt: f.expiresAt,
    msRemaining: Math.max(0, f.expiresAt - Date.now()),
    remaining: f.remaining,
    reason: f.reason,
    armedBy: f.armedBy,
    injectedCount: f.injectedCount,
    recentInjections: f.injections.slice(-INJECTION_RING),
  };
}

/**
 * Return the still-live armed fault for `point`, pruning it if it has expired or
 * exhausted its occurrence budget. Consults the hard env gate first so a fault
 * is never considered live in production. Pure w.r.t. time (uses Date.now()).
 */
function liveFault(point: FaultPoint): ArmedFault | null {
  if (!dependencyChaosEnabled()) return null;
  const f = registry.get(point);
  if (!f) return null;
  if (Date.now() >= f.expiresAt || (f.remaining !== null && f.remaining <= 0)) {
    registry.delete(point);
    return null;
  }
  return f;
}

/**
 * Consume one injection of `point` if it is armed + live: decrement its budget,
 * record it in the audit ring, and fan the injection out to the audit stream.
 * Returns true when the caller should inject the fault. Never throws.
 */
function consume(point: FaultPoint, detail: string): boolean {
  const f = liveFault(point);
  if (!f) return false;
  if (f.remaining !== null) f.remaining -= 1;
  f.injectedCount += 1;
  const rec: InjectionRecord = { at: Date.now(), point, detail };
  f.injections.push(rec);
  if (f.injections.length > INJECTION_RING) f.injections.splice(0, f.injections.length - INJECTION_RING);
  if (f.remaining !== null && f.remaining <= 0) {
    // Budget exhausted — self-heal immediately (do not wait for the TTL).
    registry.delete(point);
  }
  void auditInjection(rec, f.armedBy);
  return true;
}

/** Best-effort per-injection audit (SIEM/webhooks) via a lazy import — keeps the
 *  transport chokepoints free of the heavy audit-stream static graph. */
async function auditInjection(rec: InjectionRecord, armedBy: string): Promise<void> {
  try {
    const { emitAuditEvent } = await import('@/lib/admin/audit-stream');
    emitAuditEvent({
      actorOid: 'system:dependency-chaos',
      actorUpn: `dependency-chaos-harness (armed by ${armedBy})`,
      action: 'chaos.fault.injected',
      targetType: 'resilience-fault',
      targetId: rec.point,
      tenantId: 'system',
      detail: { at: rec.at, detail: rec.detail },
    });
  } catch {
    /* audit is best-effort; a drill injection is never blocked by it */
  }
}

// ── Arm / disarm (the ONLY way to activate a fault — called by the gated route)

/** Options for {@link armFault}. */
export interface ArmFaultOpts {
  /** Time-to-live in ms (clamped to (0, MAX_FAULT_TTL_MS]; default 60s). */
  ttlMs?: number;
  /** Max injections before self-heal (clamped to [1, 1000]); omit = unbounded within the TTL. */
  occurrences?: number;
  /** Operator note for the audit trail. */
  reason?: string;
  /** UPN/oid of the admin arming the fault (audit). */
  armedBy?: string;
}

/**
 * Arm a fault. Bounded by construction: the TTL is clamped so the fault
 * self-heals, and the occurrence budget (if given) is capped. Overwrites any
 * existing arm for the same point. Returns the armed view.
 *
 * The route is responsible for the gates (admin + flag + internal token); this
 * function additionally refuses to arm anything unless the hard env gate is on,
 * so `armFault` is inert in production even if called directly.
 */
export function armFault(point: FaultPoint, opts: ArmFaultOpts = {}): ArmedFaultView | null {
  if (!dependencyChaosEnabled()) return null;
  const now = Date.now();
  const ttl = Math.min(MAX_FAULT_TTL_MS, Math.max(1, Math.floor(opts.ttlMs ?? DEFAULT_FAULT_TTL_MS)));
  const remaining =
    opts.occurrences === undefined || opts.occurrences === null
      ? null
      : Math.min(MAX_FAULT_OCCURRENCES, Math.max(1, Math.floor(opts.occurrences)));
  const f: ArmedFault = {
    point,
    armedAt: now,
    expiresAt: now + ttl,
    remaining,
    reason: (opts.reason ?? '').slice(0, 300) || 'dependency chaos drill',
    armedBy: (opts.armedBy ?? 'unknown').slice(0, 200),
    injectedCount: 0,
    injections: [],
  };
  registry.set(point, f);
  return view(f);
}

/** Disarm one fault. Returns true if it was armed. */
export function disarmFault(point: FaultPoint): boolean {
  return registry.delete(point);
}

/** Disarm every armed fault. Returns the count removed. */
export function disarmAllFaults(): number {
  const n = registry.size;
  registry.clear();
  return n;
}

/** Every currently-armed (live) fault, pruning any that have expired. */
export function listArmedFaults(): ArmedFaultView[] {
  const out: ArmedFaultView[] = [];
  for (const point of FAULT_POINTS) {
    const f = liveFault(point);
    if (f) out.push(view(f));
  }
  return out;
}

/** Test-only: clear the registry (state leaks across `it`s otherwise). */
export function _resetFaultRegistryForTest(): void {
  registry.clear();
}

// ── Injection chokepoints ────────────────────────────────────────────────────

/** Chaos-injected Cosmos throttling error — shaped like the SDK's 429. */
export class CosmosChaosError extends Error {
  readonly code = 429;
  readonly statusCode = 429;
  constructor() {
    super(
      'Request rate is large. More Request Units may be needed, so no changes were made. (429 TooManyRequests) [chaos-injected]',
    );
    this.name = 'CosmosChaosError';
  }
}

/**
 * Cosmos chokepoint — call at the top of the shared `ensure()` in cosmos-client.
 * Throws a 429-shaped {@link CosmosChaosError} when the `cosmos-429` fault is
 * armed; otherwise a no-op (and provably dead unless the env gate is on).
 */
export async function injectCosmosFault(): Promise<void> {
  if (consume('cosmos-429', 'Cosmos read/ensure gated by chaos harness')) {
    throw new CosmosChaosError();
  }
}

/** A directive for the fetch chokepoint: return a synthetic response, or throw a timeout. */
export type FetchFaultDirective =
  | { kind: 'status'; status: number; retryAfterSec: number; body: string; point: FaultPoint }
  | { kind: 'timeout'; point: FaultPoint }
  | null;

/**
 * Classify a request URL to its dependency-fault family, or null when the host
 * is not a chaos target. Pure — used by the fetch chokepoint and tested directly.
 *   • *.openai.azure.com / *.cognitiveservices.* / *.api.cognitive.* → AOAI
 *   • *.kusto.* / *.kustomfa.* / ADX data-plane                       → ADX
 *   • *.vault.azure.net / *.vault.* (KV data-plane)                   → KV
 */
export function classifyFetchHost(url: string): 'aoai' | 'adx' | 'kv' | null {
  let host = '';
  try {
    host = new URL(url).host.toLowerCase();
  } catch {
    return null;
  }
  if (/\.openai\.azure\.|cognitiveservices\.|\.api\.cognitive\./.test(host)) return 'aoai';
  if (/\.kusto\.|\.kustomfa\.|\.kusto\.windows\.net|\.kusto\.usgovcloudapi\.net/.test(host)) return 'adx';
  if (/\.vault\.azure\.net|\.vault\.usgovcloudapi\.net|\.vault\.microsoftazure\.de|\.vaultcore\./.test(host)) return 'kv';
  return null;
}

/**
 * The fetch chokepoint — call at the top of `fetchWithTimeout` with the request
 * URL. Returns a directive to inject a realistic failure for the matching armed
 * fault, or null to proceed with the real fetch. Never throws (a chaos bug must
 * never break real traffic). Provably a no-op unless the env gate is on AND a
 * matching fault is armed AND the host classifies to a chaos target.
 */
export function fetchFaultForUrl(url: string): FetchFaultDirective {
  if (!dependencyChaosEnabled()) return null;
  const family = classifyFetchHost(url);
  if (!family) return null;

  if (family === 'aoai') {
    // Timeout takes precedence over 429 when both are (unusually) armed.
    if (consume('aoai-timeout', `AOAI inference hang injected for ${short(url)}`)) {
      return { kind: 'timeout', point: 'aoai-timeout' };
    }
    if (consume('aoai-429', `AOAI 429 injected for ${short(url)}`)) {
      return {
        kind: 'status',
        status: 429,
        retryAfterSec: 30,
        point: 'aoai-429',
        body: JSON.stringify({
          error: { code: '429', message: 'Requests to the model deployment have exceeded the token rate limit. [chaos-injected]' },
        }),
      };
    }
    return null;
  }

  if (family === 'adx') {
    if (consume('adx-cold', `ADX cold-start 503 injected for ${short(url)}`)) {
      return {
        kind: 'status',
        status: 503,
        retryAfterSec: 10,
        point: 'adx-cold',
        body: JSON.stringify({
          error: { code: 'ServiceUnavailable', message: 'Kusto cluster is starting (cold start); please retry. [chaos-injected]' },
        }),
      };
    }
    return null;
  }

  // family === 'kv'
  if (consume('kv-throttle', `Key Vault 429 injected for ${short(url)}`)) {
    return {
      kind: 'status',
      status: 429,
      retryAfterSec: 5,
      point: 'kv-throttle',
      body: JSON.stringify({ error: { code: '429', message: 'Key Vault request was throttled. [chaos-injected]' } }),
    };
  }
  return null;
}

function short(url: string): string {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname}`.slice(0, 120);
  } catch {
    return url.slice(0, 120);
  }
}
