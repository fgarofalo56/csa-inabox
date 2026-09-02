/**
 * read-warmer — keeps the EXPENSIVE deployment-scoped dashboard reads warm so
 * no user ever pays the cold aggregation.
 *
 * WHY (perf directive 2026-07-15): the cold Cost Management aggregation takes
 * longer than Front Door's ~30s edge budget even in a small estate — measured
 * live: the first /api/monitor/cost read 504s at the edge while the server is
 * still aggregating, and because the request dies the cache stays empty for
 * the next user. SWR only helps once a copy EXISTS. This warmer populates and
 * re-populates the shared tier from the server side, off the request path:
 *
 *   • at startup (after a settle delay so boot isn't slowed), then
 *   • every WARM_INTERVAL_MS (default 10 min — inside every route TTL's
 *     stale-floor so served copies stay fresh-ish).
 *
 * The warm list mirrors the ROUTE cache keys exactly (same buildScopedCacheKey
 * inputs + modelId) — keep them in sync when a route's key changes. Failures
 * are logged and swallowed: warming is an optimization, never a fault source.
 * Escape hatch: LOOM_READ_WARMER_DISABLED=1.
 *
 * ── #4244 — WHY THIS FILE NOW HAS A BUDGET, PACING AND A CIRCUIT BREAKER ────
 *
 * Measured live 2026-08-31/09-01: ~1,700 ARM throttle lines per 30 minutes,
 * SUSTAINED over a 7-hour window, attributed to this warmer under the console
 * UAMI — verbatim from the control plane:
 *
 *   {"error":{"code":"SubscriptionRequestsThrottled","message":"Number of
 *    'read' requests for subscription 'e093f4fd-…' actor '85e5d083-…'
 *    exceeded. Please try again after '10' seconds…"}}
 *
 * ARM's read limit is per (subscription, principal). Every interactive console
 * read runs as the SAME principal, so whatever the warmer spends, an operator
 * action does not have. On 2026-09-01, with the estate PAUSED and IDLE,
 * `/api/admin/estate/state` could not read one resource's power state for this
 * exact reason and reported `confirmed: 2 of 3` — the warmer had eaten the
 * quota that the operator's own action needed.
 *
 * The defect was not the volume of one cycle. It was that NOTHING stopped:
 * `warmOnce` caught each failure, logged it, and moved straight on to the next
 * target — so a throttled cycle kept issuing reads into a control plane that
 * had already said "stop", and ten minutes later did it all again, forever.
 *
 * So the warmer is now explicitly a STRICTLY-BACKGROUND consumer that yields:
 *
 *   1. BUDGET — a per-subscription, per-window ceiling on warm reads it cannot
 *      exceed, no matter how it is triggered (see `ReadWarmerBudget`).
 *   2. PACING — a minimum gap between two warm reads, so a cycle can never
 *      land as one burst against the per-principal limit.
 *   3. CIRCUIT BREAKER — the FIRST 429 aborts the whole cycle (it does not
 *      "log and continue") and puts that subscription into a cooldown that is
 *      never shorter than the Retry-After ARM asked for, escalating while
 *      throttling persists. The breaker trips on a warm read that THREW a 429
 *      AND on one that RESOLVED while its payload records the 429 its client
 *      caught — see `findSwallowedThrottle` and the measurement below.
 *   4. OBSERVABILITY — `getReadWarmerState()` reports what ran, what was
 *      skipped and WHY, so the next incident is diagnosable without a live log
 *      pull. Because nothing SERVES that accessor yet (see the scope note
 *      below), a cycle that skipped/failed/aborted anything also emits ONE
 *      structured `[read-warmer] cycle summary` line — a clean cycle stays
 *      silent, so this costs nothing in the healthy case and is guaranteed to
 *      exist in the incident case.
 *
 * deploy-integrity R7: every reason string states only what was established.
 * When ARM sent no Retry-After, the state says so rather than inventing one.
 *
 * ── MEASURED LIMIT OF THE BREAKER — READ THIS BEFORE TRUSTING IT ────────────
 *
 * STATE THE TRANSPORT OR THE RESULT IS NOT A FACT. An earlier revision of this
 * block asserted flatly that `getDiagnosticsCoverage()` throws and "the breaker
 * works". A post-merge review (issue #4244, 2026-09-01) showed that conclusion
 * held only for the transport it was measured on, which is exactly the R7
 * mistake this file is about. Both measurements, each with its transport named:
 *
 *   TOTAL 429 (every ARM call 429s, incl. the `listResources()` inventory GET):
 *     listResourceHealth()      -> did NOT throw; resolved {}
 *     getDiagnosticsCoverage()  -> THREW ('throttled')
 *
 *   PARTIAL 429 (inventory SUCCEEDS, the per-resource `diagnosticSettings` GETs
 *   429 — the live shape behind `confirmed: 2 of 3` on 2026-09-01):
 *     getDiagnosticsCoverage()  -> did NOT throw; resolved a normal array whose
 *                                  failed rows carry ARM's 429 as a FIELD.
 *
 * `_getDiagnosticsCoverage` (monitor-client.ts) catches per resource and returns
 * `{...base, note: message}` for any status that is not 404/400/405, so a 429
 * becomes a field instead of a failure. `listResourceHealth` catches bare (the
 * `resourceHealthViaResourceGraph` -> `resourceHealthViaCrawl` fallback) and
 * degrades to `{}`.
 *
 * WHAT THAT `note` ACTUALLY CONTAINS — the correction that forced this rewrite.
 * A first attempt at the breaker below grepped the note for `failed 429` and for
 * `SubscriptionRequestsThrottled`. A review (PR #4271, findings 1-2) measured
 * that neither can appear. `monitor-arm.ts` builds its message as
 * `json?.error?.message || text || 'ARM GET failed (<status>)'`, so:
 *
 *   real ARM 429 -> `json.error.message` is truthy, and the note is ONLY ARM's
 *                   prose ("Number of 'read' requests for subscription '…'
 *                   exceeded. Please try again after '10' seconds."). ARM's own
 *                   verdict lives in `json.error.code` and was DISCARDED.
 *   empty-body    -> the note is `ARM GET failed (429)`, whose parenthesis
 *     429         defeats a `\bfailed 429\b` word boundary anyway.
 *
 * The `ARM GET … failed 429: …` prefix belongs to `arm-client.ts`, which no warm
 * target uses (see the closing note). So the whole textual approach was reading
 * for a string production does not emit — the recorded "a bare substring signal
 * misclassifies and blocks" defect class, committed a second time.
 *
 * WHAT THIS FILE CAN AND CANNOT DO ABOUT THAT, stated precisely:
 *
 *   • CLOSED HERE, STRUCTURALLY — the transport now PRESERVES what ARM said.
 *     `monitor-arm.MonitorError` carries `status`, `code` and `retryAfterSeconds`
 *     as fields, and the degrading catch in `_getDiagnosticsCoverage` attaches
 *     them to the row it keeps, under the `SWALLOWED_ARM_ERROR` marker key
 *     (`lib/azure/swallowed-arm-error.ts`). `findSwallowedThrottle` reads that
 *     FIELD — same structural test the thrown path already used — so it covers
 *     the PARTIAL-429 diagnostics shape the review measured as the production
 *     one, and it does so without depending on any sentence ARM chooses to
 *     write. Text is a bounded LAST-RESORT fallback for degrading clients that
 *     have not been taught the marker yet, scoped to error-bearing keys only.
 *   • NOT CLOSED HERE — `listResourceHealth` resolving `{}` destroys the
 *     evidence, so nothing downstream can recover it, and an empty estate is
 *     indistinguishable from a throttled one. Worse, a 429 on the cheap Resource
 *     Graph path makes it ESCALATE to the more expensive paginated crawl, i.e.
 *     spend MORE ARM budget while ARM is saying stop. That repair belongs in
 *     `monitor-client.ts` (propagate the 429; do not escalate on a throttle) and
 *     is outside this file's ownership — tracked on #4244.
 *   • ALSO NOT CLOSED HERE — the scan runs AFTER a target resolves, so the
 *     amplification WITHIN one target (diagnostics' unbounded `Promise.all` of
 *     one ARM GET per estate resource) still happens once. What the scan stops
 *     is the rest of the cycle, and every cycle for the cooldown's duration.
 *
 * `budget` + `pacing` bound every target unconditionally, including the two the
 * breaker cannot see.
 *
 * Note for anyone reaching for `armGetWithRetry` / `ArmThrottledError`
 * (arm-client.ts, added for #4243): monitor-client and defender-client do NOT
 * use arm-client — they carry their own transport in `lib/azure/monitor-arm.ts`
 * over `fetchWithTimeout` — so that helper covers NO warm target today.
 */

import { buildScopedCacheKey, getOrComputeCached, resolveBackendTtl } from '@/lib/azure/query-result-cache';
import type { ArmThrottledError } from '@/lib/azure/arm-client';
// A zero-dependency leaf module ON PURPOSE: reading the marker must not pull in
// `monitor-arm.ts`, which builds an `@azure/identity` credential chain at module
// scope. The warmer stays free of that edge.
import { readSwallowedArmError, type SwallowedArmError } from '@/lib/azure/swallowed-arm-error';

const SETTLE_MS = 90_000;
const WARM_INTERVAL_MS = Number(process.env.LOOM_READ_WARMER_INTERVAL_MS) || 10 * 60_000;

// ---------------------------------------------------------------------------
// Budget configuration
// ---------------------------------------------------------------------------

/**
 * The warmer's self-imposed ceiling.
 *
 * UNIT, stated precisely so the number is not read as something it is not:
 * one budget unit is ONE WARM TARGET EXECUTION. A target fans out to a
 * client-defined number of ARM requests (`monitor/health` walks whole-
 * subscription Resource Health; `monitor/defender` crawls secure score), and
 * this module cannot count those without instrumenting every client. So the
 * budget bounds warm READS AND CYCLES — it is not a claim about the raw ARM
 * request count. Pacing bounds the instantaneous rate; the circuit breaker
 * bounds what happens once ARM pushes back.
 */
export interface ReadWarmerBudget {
  /** Rolling window the read ceiling is measured over. */
  windowMs: number;
  /** Max warm target executions per subscription per window. */
  maxReadsPerWindow: number;
  /** Minimum gap between two warm reads inside a cycle. */
  paceMs: number;
  /** Floor on the post-429 cooldown. Never shortens ARM's Retry-After. */
  minCooldownMs: number;
  /** Ceiling on the escalated cooldown. Never shortens ARM's Retry-After. */
  maxCooldownMs: number;
}

function envInt(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/**
 * Defaults are sized so ONE healthy cycle of the current target list fits
 * inside one warm interval with a little headroom, and a second cycle in the
 * same window cannot run. They are tunable, never required: with no env set at
 * all the warmer is already bounded (ux-baseline G2 — no day-one gate).
 */
export function resolveReadWarmerBudget(): ReadWarmerBudget {
  return {
    windowMs: envInt('LOOM_READ_WARMER_WINDOW_MS', WARM_INTERVAL_MS, 60_000, 6 * 60 * 60_000),
    maxReadsPerWindow: envInt('LOOM_READ_WARMER_MAX_READS', 16, 1, 500),
    paceMs: envInt('LOOM_READ_WARMER_PACE_MS', 2_000, 0, 60_000),
    // A throttled subscription stays out for at least one and a half warm
    // intervals — long enough that the next scheduled cycle is genuinely
    // skipped rather than immediately re-competing for the same quota.
    minCooldownMs: envInt('LOOM_READ_WARMER_MIN_COOLDOWN_MS', 15 * 60_000, 1_000, 24 * 60 * 60_000),
    maxCooldownMs: envInt('LOOM_READ_WARMER_MAX_COOLDOWN_MS', 60 * 60_000, 1_000, 24 * 60 * 60_000),
  };
}

/** The subscription whose ARM read budget a warm read spends from. */
function homeSubscription(): string {
  return process.env.LOOM_SUBSCRIPTION_ID || 'unknown-subscription';
}

// ---------------------------------------------------------------------------
// Failure classification (deploy-integrity R6)
// ---------------------------------------------------------------------------

// Structural contract shared with `ArmThrottledError` in lib/azure/arm-client.ts
// (added for #4243). Matched STRUCTURALLY rather than with `instanceof` on
// purpose: arm-client builds an @azure/identity credential chain at MODULE
// scope, and the warmer must not drag that construction into
// instrumentation.ts's (or a unit test's) import graph merely to name a class.
// The type import below is erased at runtime; the assignment is a compile-time
// drift guard, so if that error ever stops carrying `status` /
// `retryAfterSeconds` this file fails to build instead of silently missing 429s.
type ArmThrottleShape = { status: number; retryAfterSeconds?: number };
const _armThrottleShapeIsStable: (e: ArmThrottledError) => ArmThrottleShape = (e) => e;
void _armThrottleShapeIsStable;

/** ARM error codes that mean "you are over the read limit", verbatim. */
const ARM_THROTTLE_CODES = [
  'SubscriptionRequestsThrottled',
  'TenantRequestsThrottled',
  'ResourceRequestsThrottled',
  'RequestThrottled',
  'TooManyRequests',
];

/**
 * ARM's prose sentence for a read throttle, e.g.
 *
 *   Number of 'read' requests for subscription '<guid>' actor '<oid>' exceeded
 *   the limit of '<n>' for time interval '<t>'. Please try again after '10' seconds.
 *
 * This matters because it is the ONLY thing a degrading client that has not been
 * taught the structural marker can carry: `monitor-arm.ts` builds its message as
 * `json?.error?.message || …`, so for a real ARM 429 the code lives in a field
 * that message never sees. Bounded quantifier on purpose — an unbounded lazy gap
 * over an arbitrarily large payload is a backtracking hazard.
 */
const ARM_THROTTLE_SENTENCE =
  /Number of '[^']{1,40}' requests for (?:subscription|tenant|resource|resourcegroup)\b[\s\S]{0,240}?exceeded/i;

/**
 * The `ARM <VERB> failed (<status>)` fallback `monitor-arm.ts` emits when ARM
 * returned NO body at all. An empty-body 429 is real, and the parenthesis in
 * that string defeats a `\bfailed 429\b` word boundary — measured in the PR
 * #4271 review as finding 2.
 */
const ARM_EMPTY_BODY_429 = /\bfailed \(429\)/;

/** The `ARM GET <path> failed 429:` shape `arm-client.jsonOrThrow` produces. */
const ARM_CLIENT_FAILED_429 = /\bfailed 429\b/;

/**
 * Where does this text FIRST state, in ARM's own words, that ARM throttled a
 * read? Returns the index of the earliest such evidence, or -1 for none.
 *
 * Index rather than boolean so a caller can truncate AROUND the evidence
 * instead of from the front of the string — a 600-char prefix of a long payload
 * can drop the very sentence that proves the throttle and names the Retry-After,
 * which would leave `message` contradicting `kind` (PR #4271 finding 4, R7).
 *
 * Positive evidence only. The word "throttled" on its own is NOT evidence —
 * `ComputeBudgetExceededError`'s text contains it and is a local timeout, not an
 * ARM verdict.
 *
 * This is the LAST-RESORT half of the detector. The primary signal is the
 * structural `SWALLOWED_ARM_ERROR` marker; text only covers a degrading client
 * that has not been taught to attach it.
 */
function armThrottleIndex(text: string): number {
  let best = -1;
  const note = (at: number) => { if (at >= 0 && (best < 0 || at < best)) best = at; };
  note(text.search(ARM_CLIENT_FAILED_429));
  note(text.search(ARM_EMPTY_BODY_429));
  note(text.search(ARM_THROTTLE_SENTENCE));
  for (const code of ARM_THROTTLE_CODES) note(text.indexOf(code));
  return best;
}

/** Chars of context kept before the evidence when windowing a long payload. */
const EVIDENCE_LOOKBACK = 120;
/** Total window kept around the evidence. */
const EVIDENCE_WINDOW = 600;

/**
 * Truncate `text` to a window CENTERED on the throttle evidence at `at`.
 *
 * ARM writes `{"error":{"code":"…Throttled","message":"Number of 'read' … after
 * '10' seconds."}}`, so anchoring at the earliest evidence and reading forward
 * keeps both the verdict and the spoken Retry-After. A front-truncation loses
 * both whenever the payload has anything in front of the error.
 */
function armThrottleWindow(text: string, at: number): string {
  if (text.length <= EVIDENCE_WINDOW) return text;
  const start = Math.max(0, at - EVIDENCE_LOOKBACK);
  return text.slice(start, start + EVIDENCE_WINDOW);
}

export type WarmFailureKind = 'throttled' | 'other';

export interface WarmFailure {
  kind: WarmFailureKind;
  /**
   * How long ARM asked us to wait, in ms — or null when ARM did not say.
   * null is never silently replaced by a guess (R7).
   */
  retryAfterMs: number | null;
  /** The observed failure text, truncated. */
  message: string;
}

function readNumber(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * Classify a warm-read failure. `throttled` is asserted ONLY on positive
 * evidence: a 429 status carried structurally, or ARM's own throttle words in
 * the body (`armThrottleIndex`). Everything else is `other` — never guessed
 * into `throttled`.
 */
export function classifyWarmFailure(err: unknown): WarmFailure {
  const e = (err ?? {}) as Record<string, unknown>;
  const raw = String((e as { message?: unknown }).message ?? err ?? '');

  const status =
    readNumber(e['status'])
    ?? readNumber(e['statusCode'])
    ?? readNumber((e['response'] as Record<string, unknown> | undefined)?.['status']);

  const at = armThrottleIndex(raw);
  const throttled = status === 429 || at >= 0;

  // Window around the evidence when there is any; otherwise a plain prefix.
  // Truncating from the front would let `message` drop the sentence that proves
  // `kind` and names the Retry-After, so the record would contradict itself (R7).
  const message = at >= 0 ? armThrottleWindow(raw, at) : raw.slice(0, EVIDENCE_WINDOW);

  if (!throttled) return { kind: 'other', retryAfterMs: null, message };

  // Retry-After, in order of how directly ARM stated it.
  const structural = readNumber(e['retryAfterSeconds']);
  if (structural !== null) {
    return { kind: 'throttled', retryAfterMs: Math.max(0, Math.round(structural * 1000)), message };
  }
  // The verbatim ARM body: "Please try again after '10' seconds".
  const spoken = /try again after '(\d+)' seconds/i.exec(message);
  if (spoken) {
    return { kind: 'throttled', retryAfterMs: Math.max(0, Number(spoken[1]) * 1000), message };
  }
  const header = /retry-after["'\s:]+(\d+)/i.exec(message);
  if (header) {
    return { kind: 'throttled', retryAfterMs: Math.max(0, Number(header[1]) * 1000), message };
  }
  return { kind: 'throttled', retryAfterMs: null, message };
}

// ---------------------------------------------------------------------------
// Swallowed-throttle detection (#4244 post-merge review)
// ---------------------------------------------------------------------------

/**
 * Node ceiling for the payload scan. The heaviest warm payload is one row per
 * estate resource, so a few thousand nodes is the realistic worst case; the cap
 * exists so an unexpectedly huge result can never turn a background optimization
 * into a CPU cost. Hitting the cap means "found no evidence in the part I read",
 * which is reported as no evidence — the honest reading (R7).
 */
const RESULT_SCAN_MAX_NODES = 20_000;

/**
 * Keys whose value is, by convention, an error report rather than user content.
 *
 * The text half of the scan is scoped to these. WHY: `listAlertRules` carries
 * operator-authored `name` and `description` for every rule in the subscription,
 * and a rule described "Fires when ARM returns TooManyRequests for the console
 * UAMI" would otherwise be read as ARM throttling us. That false positive is not
 * self-clearing — the string is PERSISTENT, so it would trip on every cycle, and
 * because a tripped cycle skips the escalation reset the cooldown would only
 * grow. Steady state: one cycle an hour warming `monitor/cost` and nothing else,
 * invisibly (PR #4271 finding 3).
 *
 * Operator prose does not live under these keys; ARM's error reports do.
 */
const ERROR_BEARING_KEYS = new Set([
  'note', 'error', 'errors', 'message', 'errormessage', 'detail', 'details',
  'reason', 'exception', 'code', 'errorcode', 'statusmessage', 'faultmessage',
]);

/** How the swallowed throttle was established. */
export type SwallowedThrottleSource = 'structured' | 'arm-words';

export interface SwallowedThrottle {
  /**
   * `structured` — read off the `SWALLOWED_ARM_ERROR` marker a degrading client
   * attached, i.e. ARM's own status/code/Retry-After as fields.
   * `arm-words` — inferred from ARM's prose under an error-bearing key, because
   * the client that swallowed it has not been taught the marker.
   */
  source: SwallowedThrottleSource;
  failure: WarmFailure;
}

/** Turn a structural marker into the same verdict shape the thrown path uses. */
function classifyArmMarker(m: SwallowedArmError): WarmFailure {
  return classifyWarmFailure({
    status: m.status,
    retryAfterSeconds: m.retryAfterSeconds,
    // Put ARM's code back in front of its prose. The code is what `monitor-arm`
    // used to discard, and it is what makes the recorded message self-explaining
    // instead of a bare sentence.
    message: m.code ? `${m.code}: ${m.message}` : m.message,
  });
}

/**
 * Find a 429 that a warm target's client CAUGHT and degraded into a normal
 * result, so `runTarget` resolved and the breaker never saw a failure.
 *
 * TWO signals, in strict priority order:
 *
 *  1. STRUCTURAL (authoritative). A degrading client attaches
 *     `SWALLOWED_ARM_ERROR` — ARM's status, code and Retry-After as FIELDS
 *     (`lib/azure/swallowed-arm-error.ts`). This is the same structural test the
 *     thrown path uses, and it is immune to whatever sentence ARM chooses to
 *     write. The scan always runs to completion looking for one, so a marker
 *     anywhere in the payload beats a textual hit found earlier in the walk.
 *
 *  2. ARM'S WORDS (last resort). For a client that degrades without the marker,
 *     ARM's prose under an ERROR-BEARING key still counts. Scoped to those keys
 *     precisely so operator-authored content cannot masquerade as an ARM verdict
 *     — see `ERROR_BEARING_KEYS`.
 *
 * Bounded in nodes AND in keys (each key tested charges the budget), and
 * cycle-safe via a `WeakSet`, so it cannot diverge on a self-referential result.
 * Hitting the cap is reported as "no evidence in the part I read" — which is
 * what it is, never as "no throttle" (R7).
 */
export function findSwallowedThrottle(
  value: unknown,
  opts?: { scanText?: boolean },
): SwallowedThrottle | null {
  // Structural detection is unconditional. Only ARM's PROSE can be somebody
  // else's history, so only the prose half is opt-out-able.
  const scanText = opts?.scanText !== false;
  const seen = new WeakSet<object>();
  // `errorField` marks a node reached through an error-bearing key. It is
  // inherited: everything under `error:` is error context, however deep.
  const stack: { node: unknown; errorField: boolean }[] = [{ node: value, errorField: false }];
  let visited = 0;
  let textual: SwallowedThrottle | null = null;

  while (stack.length > 0 && visited < RESULT_SCAN_MAX_NODES) {
    const { node, errorField } = stack.pop()!;
    visited += 1;

    if (typeof node === 'string') {
      if (scanText && errorField && textual === null) {
        const at = armThrottleIndex(node);
        if (at >= 0) {
          textual = {
            source: 'arm-words',
            failure: classifyWarmFailure({ message: armThrottleWindow(node, at) }),
          };
        }
      }
      continue;
    }
    if (node === null || typeof node !== 'object') continue;
    if (seen.has(node)) continue;
    seen.add(node);

    // Signal 1 — the structural marker wins outright, on any node.
    const marker = readSwallowedArmError(node);
    if (marker) {
      const failure = classifyArmMarker(marker);
      if (failure.kind === 'throttled') return { source: 'structured', failure };
    }

    if (Array.isArray(node)) {
      for (const item of node) stack.push({ node: item, errorField });
      continue;
    }
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      // Charge per key, not per object: a payload of few objects with very many
      // keys would otherwise scan far past the ceiling this cap exists to impose.
      visited += 1;
      if (visited >= RESULT_SCAN_MAX_NODES) break;
      // A map may be KEYED by the error (e.g. `{ errors: { …Throttled: 3 } }`),
      // so the keys of a node already in error context are evidence too.
      if (scanText && errorField && textual === null) {
        const at = armThrottleIndex(k);
        if (at >= 0) {
          textual = {
            source: 'arm-words',
            failure: classifyWarmFailure({ message: armThrottleWindow(k, at) }),
          };
        }
      }
      stack.push({ node: v, errorField: errorField || ERROR_BEARING_KEYS.has(k.toLowerCase()) });
    }
  }
  return textual;
}

// ---------------------------------------------------------------------------
// Observable state (#4244 requirement 4)
// ---------------------------------------------------------------------------

export type ReadWarmerEventKind = 'warmed' | 'skipped' | 'throttled' | 'failed';

export interface ReadWarmerEvent {
  at: string;
  kind: ReadWarmerEventKind;
  label: string;
  /** Human-readable, and only ever what was actually established. */
  detail: string;
}

export interface ReadWarmerSkip {
  label: string;
  reason: string;
}

export interface ReadWarmerCycleReport {
  startedAt: string;
  finishedAt: string;
  /** Targets the cycle actually executed (each spent one budget unit). */
  attempted: number;
  succeeded: number;
  skipped: ReadWarmerSkip[];
  failed: { label: string; kind: WarmFailureKind; message: string }[];
  /** Set when a 429 tripped the breaker and ended the cycle early. */
  abortedBy: { label: string; retryAfterMs: number | null; cooldownUntil: string } | null;
}

export interface ReadWarmerBucketState {
  subscriptionId: string;
  readsUsedInWindow: number;
  windowStartedAt: string;
  windowResetsAt: string;
  cooldownUntil: string | null;
  consecutiveThrottles: number;
  lastThrottle: { at: string; label: string; retryAfterMs: number | null; message: string } | null;
}

export interface ReadWarmerState {
  enabled: boolean;
  running: boolean;
  cyclesStarted: number;
  budget: ReadWarmerBudget;
  buckets: ReadWarmerBucketState[];
  lastCycle: ReadWarmerCycleReport | null;
  recentEvents: ReadWarmerEvent[];
}

const MAX_EVENTS = 50;

// ---------------------------------------------------------------------------
// Targets
// ---------------------------------------------------------------------------

export interface WarmTarget {
  label: string;
  key: string;
  modelId: string;
  ttlMs: number;
  produce: () => Promise<unknown>;
  /**
   * Which per-subscription budget bucket this read spends from. Omitted =
   * the console's home subscription. Cross-subscription targets are attributed
   * here too (see `chargebackTargets`) because the console's own subscription
   * is always in their fan-out, and over-attributing spends the budget SOONER,
   * which is the safe direction.
   */
  budgetKey?: string;
  /**
   * Opt OUT of the TEXTUAL half of `findSwallowedThrottle` for a target whose
   * payload legitimately QUOTES upstream error text it did not itself receive —
   * for that target an ARM throttle string is somebody else's history, not this
   * read's verdict, so reading it as one asserts a cause that was not
   * established (R7).
   *
   * The STRUCTURAL half still runs: the `SWALLOWED_ARM_ERROR` marker is attached
   * by the transport that actually made the call, so it cannot be somebody
   * else's history. Opting out therefore does not blind this target to a throttle
   * on its OWN transport — which the flag's first revision did.
   *
   * Default is opt-IN on purpose. Note the asymmetry is smaller than it looks
   * now that the text scan is scoped to `ERROR_BEARING_KEYS`: a false positive
   * used to be described here as "costs one skipped cycle, which is free", and
   * that was WRONG for a persistent string — a stored alert-rule description
   * would trip every cycle, and a tripped cycle skips the escalation reset, so
   * the cooldown only grows (PR #4271 finding 3). Scoping is what makes the
   * default safe; this flag is for the residual case.
   */
  resultQuotesUpstreamErrors?: boolean;
}

async function targets(): Promise<WarmTarget[]> {
  // Dynamic imports keep the warmer out of every route's module graph.
  const [{ computeLoomCostSummary, costKey, loomScopeLabel }, monitor, { getDefenderSummary }] = await Promise.all([
    import('@/lib/azure/cost-client'),
    import('@/lib/azure/monitor-client'),
    import('@/lib/azure/defender-client'),
  ]);
  return [
    {
      // C1: warm the CANONICAL cost-client cache key (the same key
      // getLoomCostSummaryCached reads) with the RAW compute — warming through
      // the cached wrapper would just read its own fresh copy back.
      label: 'monitor/cost MonthToDate',
      key: costKey(loomScopeLabel(), 'MonthToDate', 'summary'),
      modelId: 'cost-mgmt',
      ttlMs: 15 * 60_000,
      produce: () => computeLoomCostSummary({ timeframe: 'MonthToDate' }),
    },
    {
      label: 'monitor/alerts metric',
      key: buildScopedCacheKey('monitor/alerts', { kind: 'metric' }),
      modelId: 'monitor',
      ttlMs: 2 * 60_000,
      produce: () => monitor.listAlertRules(),
    },
    {
      label: 'monitor/diagnostics',
      key: buildScopedCacheKey('monitor/diagnostics', {}),
      modelId: 'monitor',
      ttlMs: 5 * 60_000,
      produce: () => monitor.getDiagnosticsCoverage(),
    },
    {
      label: 'monitor/action-groups',
      key: buildScopedCacheKey('monitor/action-groups', {}),
      modelId: 'monitor',
      ttlMs: 5 * 60_000,
      produce: () => monitor.listActionGroups(),
    },
    // 2026-07-16 live receipt: defender (secure score crawl) and health
    // (whole-subscription Resource Health, ~20 serial paginated calls) both
    // measured ~12s on a cache miss — the slowest monitor first-paints left.
    {
      label: 'monitor/defender',
      key: buildScopedCacheKey('monitor/defender', {}),
      modelId: 'monitor',
      ttlMs: 10 * 60_000,
      produce: () => getDefenderSummary(),
    },
    {
      label: 'monitor/health',
      key: buildScopedCacheKey('monitor/health', {}),
      modelId: 'monitor',
      ttlMs: 90_000,
      produce: async () => ({ statuses: Object.values(await monitor.listResourceHealth()) }),
    },
    {
      label: 'monitor/activities default',
      // Mirrors the route's DEFAULT param set (days=30, limit=200,
      // synapse on, arm off) — the shape the Monitor page first-paints with.
      // Rows carry ErrorCode/ErrorMessage copied out of pipeline-run history, so
      // an ARM throttle string here is a past pipeline's failure, not this
      // read's — the only target where the TEXT scan could misattribute. Its own
      // transport is still covered, structurally, by the marker.
      resultQuotesUpstreamErrors: true,
      key: buildScopedCacheKey('monitor/activities', { days: 30, limit: 200, includeSynapse: true, includeArmLog: false }),
      modelId: 'monitor',
      ttlMs: 3 * 60_000,
      produce: () => monitor.queryActivityFeed({ days: 30, limit: 200, includeSynapse: true, includeArmLog: false }),
    },
    ...(await chargebackTargets()),
  ];
}

/**
 * Chargeback warm targets (operator report 2026-07-17: the cross-subscription
 * Cost Management aggregation exceeds the 25s inline budget under QPU throttle,
 * so users kept landing on 202-"warming" — the cache only populated if someone
 * waited out the background compute). Warming server-side means the first user
 * click always finds a copy.
 *
 * The routes scope their keys AND modelId by tenantScopeId (= session tid) —
 * every real signed-in user shares the AAD tenant id, which the server knows as
 * AZURE_TENANT_ID. No tenant id → skip (keys would never match a real session).
 */
async function chargebackTargets(): Promise<WarmTarget[]> {
  const tenantId = process.env.AZURE_TENANT_ID;
  if (!tenantId) return [];
  const timeframe = 'MonthToDate';
  const [{ getChargebackModel }, { getDomainChargeback }, { loadOrSeedDomains }, { tenantSettingsContainer }] = await Promise.all([
    import('@/lib/azure/cost-management-client'),
    import('@/lib/azure/domain-chargeback'),
    import('@/lib/azure/domain-registry'),
    import('@/lib/azure/cosmos-client'),
  ]);
  return [
    {
      label: 'admin/capacity/chargeback MonthToDate',
      key: buildScopedCacheKey('admin/capacity/chargeback', { tenantId, timeframe }),
      modelId: tenantId,
      ttlMs: resolveBackendTtl('costmgmt', 10 * 60_000),
      produce: () => getChargebackModel({ timeframe }),
    },
    {
      label: 'admin/chargeback MonthToDate',
      key: buildScopedCacheKey('admin/chargeback', { tenantId, timeframe }),
      modelId: tenantId,
      ttlMs: resolveBackendTtl('costmgmt', 20 * 60_000),
      // Mirrors the route's closure shape { data, taggingEnabled } exactly.
      produce: async () => {
        const [domainDoc, tagging] = await Promise.all([
          loadOrSeedDomains(tenantId, 'system:read-warmer').catch(() => null),
          (async () => {
            try {
              const c = await tenantSettingsContainer();
              const { resource } = await c.item(tenantId, tenantId).read<{ settings?: Record<string, boolean> }>();
              return resource?.settings?.['billing.chargebackTagging'] === true;
            } catch { return false; }
          })(),
        ]);
        const domainNames: Record<string, string> = {};
        for (const d of domainDoc?.items || []) domainNames[d.id] = d.name;
        const data = await getDomainChargeback({ timeframe, domainNames });
        return { data, taggingEnabled: tagging };
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// The warmer
// ---------------------------------------------------------------------------

export interface ReadWarmerDeps {
  /** Injectable clock. Defaults to `Date.now`. */
  now?: () => number;
  /** Injectable sleep. Defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable target list. Defaults to the real warm list above. */
  loadTargets?: () => Promise<WarmTarget[]>;
  /** Injectable executor for ONE target. Defaults to the real cache write. */
  runTarget?: (t: WarmTarget) => Promise<unknown>;
  budget?: ReadWarmerBudget;
  /** Injectable logger so specs do not spam the reporter. */
  warn?: (message: string) => void;
}

interface BucketState {
  readsUsed: number;
  windowStartedAt: number;
  cooldownUntil: number;
  consecutiveThrottles: number;
  lastThrottle: { at: number; label: string; retryAfterMs: number | null; message: string } | null;
}

export interface ReadWarmer {
  runCycle: () => Promise<ReadWarmerCycleReport>;
  state: () => ReadWarmerState;
}

const iso = (ms: number): string => new Date(ms).toISOString();

export function createReadWarmer(deps: ReadWarmerDeps = {}): ReadWarmer {
  const now = deps.now ?? (() => Date.now());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => { setTimeout(r, ms); }));
  const loadTargets = deps.loadTargets ?? targets;
  const runTarget = deps.runTarget
    ?? ((t: WarmTarget) => getOrComputeCached(t.key, t.modelId, t.produce, { ttlMs: t.ttlMs, bypass: true }));
  const budget = deps.budget ?? resolveReadWarmerBudget();
  const warn = deps.warn ?? ((m: string) => { console.warn(m); });

  const buckets = new Map<string, BucketState>();
  const events: ReadWarmerEvent[] = [];
  let running = false;
  let cyclesStarted = 0;
  let lastCycle: ReadWarmerCycleReport | null = null;

  function record(kind: ReadWarmerEventKind, label: string, detail: string): void {
    events.push({ at: iso(now()), kind, label, detail });
    if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);
  }

  function bucketFor(t: WarmTarget): { id: string; b: BucketState } {
    const id = t.budgetKey || homeSubscription();
    let b = buckets.get(id);
    if (!b) {
      b = { readsUsed: 0, windowStartedAt: now(), cooldownUntil: 0, consecutiveThrottles: 0, lastThrottle: null };
      buckets.set(id, b);
    }
    // Roll the window forward. A window is a fixed-length slot, not a sliding
    // one: simple, and it can only ever be MORE restrictive than a sliding
    // window at the moment of a burst.
    if (now() - b.windowStartedAt >= budget.windowMs) {
      b.windowStartedAt = now();
      b.readsUsed = 0;
    }
    return { id, b };
  }

  /**
   * Cooldown after a 429. NEVER shorter than the Retry-After ARM asked for —
   * that is the honoring requirement — and escalated while throttling
   * persists, so a control plane that keeps saying "stop" gets progressively
   * more room rather than the same 10-minute re-attempt forever.
   */
  function cooldownMsFor(retryAfterMs: number | null, consecutiveThrottles: number): number {
    const escalated = budget.minCooldownMs * 2 ** Math.max(0, consecutiveThrottles - 1);
    const bounded = Math.min(budget.maxCooldownMs, escalated);
    return Math.max(bounded, retryAfterMs ?? 0);
  }

  /**
   * ONE structured line per NOTABLE cycle (requirement 4).
   *
   * `getReadWarmerState()` is the richer diagnostic, but nothing serves it yet,
   * so on its own it would leave a live incident exactly as hard to diagnose as
   * 2026-08-31 was. A clean cycle logs NOTHING — this only speaks when the
   * warmer actually withheld or lost a read, which is the case worth reading.
   *
   * Skip reasons are grouped by reason (every target in one cooldown shares one
   * reason) so the line stays bounded rather than repeating the same sentence
   * once per target.
   */
  function summarize(report: ReadWarmerCycleReport): void {
    if (!report.skipped.length && !report.failed.length && !report.abortedBy) return;
    const byReason = new Map<string, string[]>();
    for (const s of report.skipped) {
      const labels = byReason.get(s.reason);
      if (labels) labels.push(s.label);
      else byReason.set(s.reason, [s.label]);
    }
    const skips = [...byReason.entries()]
      .map(([reason, labels]) => `${labels.length}x [${labels.join(', ')}] ${reason}`)
      .join(' ; ');
    const parts = [
      `attempted ${report.attempted}`,
      `succeeded ${report.succeeded}`,
      `skipped ${report.skipped.length}`,
      `failed ${report.failed.length}`,
    ];
    if (report.abortedBy) {
      parts.push(`ABORTED by ${report.abortedBy.label} (cooldown until ${report.abortedBy.cooldownUntil})`);
    }
    warn(`[read-warmer] cycle summary — ${parts.join(', ')}${skips ? ` | skips: ${skips}` : ''}`);
  }

  async function runCycle(): Promise<ReadWarmerCycleReport> {
    const startedAt = now();
    const report: ReadWarmerCycleReport = {
      startedAt: iso(startedAt),
      finishedAt: iso(startedAt),
      attempted: 0,
      succeeded: 0,
      skipped: [],
      failed: [],
      abortedBy: null,
    };
    if (running) {
      const reason = 'a warm cycle was already running';
      report.skipped.push({ label: '(cycle)', reason });
      report.finishedAt = iso(now());
      // Deliberately NOT `lastCycle = report`: the cycle still in flight owns
      // that slot. Overwriting it would blank the last real cycle's evidence
      // (what it warmed, what it skipped) for as long as the in-flight cycle
      // runs — the opposite of what requirement 4 is for.
      record('skipped', '(cycle)', reason);
      return report;
    }
    running = true;
    cyclesStarted += 1;
    try {
      let list: WarmTarget[];
      try {
        list = await loadTargets();
      } catch (e) {
        const detail = `warm target list could not be built: ${(e as Error)?.message}`;
        report.failed.push({ label: '(targets)', kind: 'other', message: detail });
        record('failed', '(targets)', detail);
        warn(`[read-warmer] ${detail}`);
        report.finishedAt = iso(now());
        lastCycle = report;
        return report;
      }

      let executed = 0;
      let aborted = false;
      const cleanBuckets = new Set<string>();

      /**
       * ARM said stop; the warmer stops. Shared by all three ways a throttle can
       * reach us — the read that THREW, the read that RESOLVED carrying a
       * STRUCTURED record of the 429 its client caught, and the read whose
       * payload only carries ARM's throttle WORDS. `origin` names which was
       * actually observed, so the recorded state never implies a failure that
       * did not occur (R7).
       *
       * `inferential` marks the third case — a conclusion drawn from prose we
       * did not produce, not an observation. It changes two things:
       *
       *  1. **Escalation does not climb.** `Math.max(n, 1)` instead of `n + 1`.
       *     A textual match trips the breaker once, at the base cooldown, and
       *     stays there however many cycles it recurs. That matters because a
       *     text match CAN be persistent: an operator-authored alert-rule
       *     description containing ARM's throttle words would otherwise ratchet
       *     the cooldown every cycle until the warmer ran hourly, invisibly
       *     (PR #4271 review, finding 3). `max` and not `min`, so an inferential
       *     trip also never ERASES escalation an observed 429 earned.
       *  2. **The Retry-After sentence changes.** We cannot claim ARM sent no
       *     header when we never saw a response — only that none was recoverable
       *     from the text.
       */
      const trip = (
        t: WarmTarget,
        id: string,
        b: BucketState,
        failure: WarmFailure,
        origin: string,
        opts?: { inferential?: boolean },
      ): void => {
        b.consecutiveThrottles = opts?.inferential
          ? Math.max(b.consecutiveThrottles, 1)
          : b.consecutiveThrottles + 1;
        const cooldown = cooldownMsFor(failure.retryAfterMs, b.consecutiveThrottles);
        b.cooldownUntil = now() + cooldown;
        b.lastThrottle = { at: now(), label: t.label, retryAfterMs: failure.retryAfterMs, message: failure.message };
        const asked = failure.retryAfterMs !== null
          ? `ARM asked for ${Math.round(failure.retryAfterMs / 1000)}s`
          : opts?.inferential
            ? 'no Retry-After was recoverable from that text, so the configured minimum applies'
            : 'ARM did not state a Retry-After, so the configured minimum applies';
        const detail = `${origin}; ${asked}. Aborting the cycle and holding subscription ${id} out until ${iso(b.cooldownUntil)}.`;
        report.abortedBy = { label: t.label, retryAfterMs: failure.retryAfterMs, cooldownUntil: iso(b.cooldownUntil) };
        record('throttled', t.label, detail);
        warn(`[read-warmer] ${t.label} throttled: ${detail}`);
      };

      for (const t of list) {
        if (aborted) {
          report.skipped.push({ label: t.label, reason: 'cycle aborted after ARM throttled an earlier read' });
          continue;
        }
        const { id, b } = bucketFor(t);

        if (b.cooldownUntil > now()) {
          const reason = `subscription ${id} is in warm cooldown until ${iso(b.cooldownUntil)} after ARM throttled a warm read`;
          report.skipped.push({ label: t.label, reason });
          record('skipped', t.label, reason);
          continue;
        }
        if (b.readsUsed >= budget.maxReadsPerWindow) {
          const reason = `subscription ${id} spent its warm read budget (${b.readsUsed}/${budget.maxReadsPerWindow}) for the window starting ${iso(b.windowStartedAt)}`;
          report.skipped.push({ label: t.label, reason });
          record('skipped', t.label, reason);
          continue;
        }

        // Pace BEFORE every read after the first, so a cycle never lands as a
        // burst against the per-principal ARM limit.
        if (executed > 0 && budget.paceMs > 0) await sleep(budget.paceMs);

        b.readsUsed += 1;
        executed += 1;
        report.attempted += 1;
        try {
          // bypass:true recomputes + rewrites the tiers even when a fresh copy
          // exists — the warmer's job is keeping copies YOUNG, not reading them.
          const result = await runTarget(t);
          // A client that CAUGHT its own 429 resolves normally, so the throttle
          // never reaches the `catch` below — it survives only inside the
          // payload. `findSwallowedThrottle` looks for it two ways, in priority
          // order: the STRUCTURED marker a degrading client attaches
          // (`SWALLOWED_ARM_ERROR`: the status ARM returned, the code ARM sent,
          // the Retry-After ARM asked for) and, failing that, ARM's throttle
          // words in an error-bearing string. Reading it is what makes the
          // breaker cover the partial-429 shape measured live on 2026-09-01.
          //
          // `scanText` — not the whole scan — is what a target opts out of, so
          // a target that quotes OTHER services' errors is still covered
          // structurally on its own transport (review, finding 6).
          const swallowed = findSwallowedThrottle(result, { scanText: !t.resultQuotesUpstreamErrors });
          if (swallowed) {
            // Use the failure the scan already built. Re-classifying its
            // `message` here is what made the trip contradict itself: the
            // message is a WINDOW around the evidence, and re-running the
            // classifier over a window is at best a no-op and at worst a
            // second, lossier verdict (review, finding 4).
            const { failure, source } = swallowed;
            report.failed.push({ label: t.label, kind: failure.kind, message: failure.message });
            trip(
              t, id, b, failure,
              source === 'structured'
                ? 'this warm read RESOLVED, but its payload records the 429 its client caught'
                : "this warm read RESOLVED, but an error field in its payload carries ARM's throttle words, so its client most likely swallowed a 429",
              { inferential: source === 'arm-words' },
            );
            aborted = true;
            continue;
          }
          report.succeeded += 1;
          cleanBuckets.add(id);
          record('warmed', t.label, `warmed (${b.readsUsed}/${budget.maxReadsPerWindow} of the window budget for ${id})`);
        } catch (e) {
          const failure = classifyWarmFailure(e);
          report.failed.push({ label: t.label, kind: failure.kind, message: failure.message });
          if (failure.kind !== 'throttled') {
            record('failed', t.label, failure.message);
            warn(`[read-warmer] ${t.label} failed: ${failure.message}`);
            continue;
          }
          // ── The circuit breaker. ARM said stop; the warmer stops. ──
          trip(t, id, b, failure, 'ARM throttled this warm read');
          aborted = true;
        }
      }
      if (!aborted) {
        // Escalation is cleared ONLY for a bucket that actually completed a
        // warm read in this cycle — a bucket that was skipped (still cooling
        // down, or out of budget) established nothing, so its escalation
        // stands. Anything else would let a skipped cycle "prove" health.
        for (const id of cleanBuckets) {
          const b = buckets.get(id);
          if (b && b.cooldownUntil <= now()) b.consecutiveThrottles = 0;
        }
      }
      report.finishedAt = iso(now());
      lastCycle = report;
      summarize(report);
      return report;
    } finally {
      running = false;
    }
  }

  function state(): ReadWarmerState {
    return {
      enabled: process.env.LOOM_READ_WARMER_DISABLED !== '1',
      running,
      cyclesStarted,
      budget: { ...budget },
      buckets: [...buckets.entries()].map(([subscriptionId, b]) => ({
        subscriptionId,
        readsUsedInWindow: b.readsUsed,
        windowStartedAt: iso(b.windowStartedAt),
        windowResetsAt: iso(b.windowStartedAt + budget.windowMs),
        cooldownUntil: b.cooldownUntil > now() ? iso(b.cooldownUntil) : null,
        consecutiveThrottles: b.consecutiveThrottles,
        lastThrottle: b.lastThrottle
          ? {
              at: iso(b.lastThrottle.at),
              label: b.lastThrottle.label,
              retryAfterMs: b.lastThrottle.retryAfterMs,
              message: b.lastThrottle.message,
            }
          : null,
      })),
      lastCycle,
      recentEvents: [...events],
    };
  }

  return { runCycle, state };
}

const defaultWarmer = createReadWarmer();

/**
 * What the warmer is doing, what it skipped, and why — the diagnostic the
 * 2026-08-31 incident had to be reconstructed from a live log pull to answer.
 */
export function getReadWarmerState(): ReadWarmerState {
  return defaultWarmer.state();
}

/** Start the warmer loop (idempotent; called from instrumentation.ts). */
let started = false;
export function startReadWarmer(): void {
  if (started) return;
  if (process.env.LOOM_READ_WARMER_DISABLED === '1') return;
  started = true;
  const t1 = setTimeout(() => { void defaultWarmer.runCycle(); }, SETTLE_MS);
  const t2 = setInterval(() => { void defaultWarmer.runCycle(); }, WARM_INTERVAL_MS);
  // Never keep the process alive just for warming.
  t1.unref?.(); t2.unref?.();
}
