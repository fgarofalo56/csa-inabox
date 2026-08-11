/**
 * Server-side Synapse Spark pool resolver — AUTO-BIND for notebook compute.
 *
 * Why this exists (#3171). The three notebook execute/session/run-cell routes
 * read the pool from the REQUEST BODY only and 400'd with "pool is required"
 * when it was absent. A freshly created notebook has no `properties.bigDataPool`,
 * so the editor's `attachedPool` was `null` and every first Run cell 400'd —
 * a straight `auto-bind-by-default.md` §1 violation (creating a Loom item must
 * bind its backing resource; the user must never perform the plumbing).
 *
 * The naive fix — adopt the pre-existing `defaultSparkPool()` from
 * synapse-livy-client — is WRONG here, because its terminal fallback is the
 * LITERAL `'loompool'`, and the live estate moved to `loompool2` after the
 * 2026-07-14 Spark capacity incident. Binding to a name that resolves to no
 * ARM resource trades a 400 for a 502 later in the flow, which is worse: the
 * failure moves away from the cause. So this resolver:
 *
 *   1. resolves against the workspace's ACTUAL `Microsoft.Synapse/workspaces/
 *      {ws}/bigDataPools` list (ARM), with the LOOM_* env vars as a HINT, not
 *      as an answer, and
 *   2. NEVER emits a literal pool name that it did not observe in that list or
 *      receive from the caller/operator, and
 *   3. records HOW the binding was made (`source` + `note`) so the mapping is
 *      inspectable rather than guessed (`auto-bind-by-default.md` §2), and
 *   4. self-heals a stale binding: a requested/hinted pool that is positively
 *      ABSENT from the workspace list is re-bound to a real pool (§3).
 *
 * deploy-integrity R7 — the messages here assert only what the code
 * ESTABLISHED. When the ARM list call fails, this module does NOT claim "no
 * pools exist"; it says the listing failed, quotes the error, and either uses
 * an operator-supplied hint UNVERIFIED (`verified:false`) or refuses and says
 * it does not know. "Empty list" and "could not read the list" are different
 * answers and are reported differently.
 *
 * Cloud parity — this is ARM `bigDataPools` + the Synapse dev/Livy endpoint,
 * both GA in Commercial, GCC, GCC-High and IL5, and all four param files set
 * `loomSynapseEnabled = true`. There is no Commercial-only branch in here: the
 * sovereign hosts are handled by `synapse-dev-client`'s cloud-aware ARM base
 * and `synapse-livy-client`'s LOOM_SYNAPSE_DEV_SUFFIX. Nothing in this file
 * reads a cloud tier, so every boundary takes the identical code path.
 *
 * Learn:
 *   https://learn.microsoft.com/rest/api/synapse/big-data-pools/list-by-workspace
 *   https://learn.microsoft.com/rest/api/synapse/data-plane/spark-session/create-spark-session
 */

import { listSparkPools, type SparkPool } from '@/lib/azure/synapse-dev-client';

/** Where the bound pool name came from. */
export type SparkPoolSource = 'request' | 'env' | 'workspace';

export interface ResolvedSparkPool {
  ok: true;
  /** The pool to talk to. */
  pool: string;
  source: SparkPoolSource;
  /** TRUE only when this exact pool was OBSERVED in the workspace's ARM list. */
  verified: boolean;
  /** Remaining workspace pools in pick order — self-heal candidates. */
  alternatives: string[];
  /** Honest record of how the binding was made. Absent when nothing notable happened. */
  note?: string;
}

export interface UnresolvedSparkPool {
  ok: false;
  code: 'no_spark_pool' | 'pool_unresolved';
  status: 503 | 502;
  error: string;
  hint: string;
}

export type SparkPoolResolution = ResolvedSparkPool | UnresolvedSparkPool;

/** Env hints, in precedence order. All three are emitted by admin-plane/main.bicep. */
const ENV_HINTS = ['LOOM_SYNAPSE_SPARK_POOL', 'LOOM_SPARK_POOL', 'LOOM_DEFAULT_SPARK_POOL'] as const;

function envHint(): { name: string; varName: string } | null {
  for (const varName of ENV_HINTS) {
    const v = (process.env[varName] || '').trim();
    if (v) return { name: v, varName };
  }
  return null;
}

function workspaceName(): string {
  return (process.env.LOOM_SYNAPSE_WORKSPACE || '').trim() || '(LOOM_SYNAPSE_WORKSPACE unset)';
}

// ── ARM pool list, memoized briefly ──────────────────────────────────────────
// The list is consulted on every session create and on cold execute/poll calls.
// A short TTL keeps that off the hot path without letting a rename go unnoticed
// for long. Only SUCCESSFUL lists are cached — a failure must be re-attempted,
// never remembered as a fact.
const LIST_TTL_MS = 60_000;
let listCache: { at: number; ws: string; pools: SparkPool[] } | null = null;

/** Test hook — drop the memoized ARM pool list. */
export function resetSparkPoolListCache(): void {
  listCache = null;
}

type ListOutcome = { pools: SparkPool[] } | { listError: string };

async function listPoolsCached(): Promise<ListOutcome> {
  const ws = workspaceName();
  const now = Date.now();
  if (listCache && listCache.ws === ws && now - listCache.at < LIST_TTL_MS) {
    return { pools: listCache.pools };
  }
  try {
    const pools = await listSparkPools();
    listCache = { at: now, ws, pools };
    return { pools };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { listError: msg || 'unknown error' };
  }
}

// ── Deterministic pick order ─────────────────────────────────────────────────
/**
 * Rank the workspace's pools for auto-bind. Deterministic, and recorded in the
 * note so the choice is inspectable:
 *   1. a name that starts with the hint  — the `loompool` → `loompool2` drift
 *      after the capacity incident lands on the successor, not on a stranger;
 *   2. ARM provisioningState 'Succeeded' — never prefer a Failed/Deleting pool;
 *   3. name ascending — a stable tie-break.
 * A non-Succeeded pool is still eligible (excluding it would let this module
 * claim "no pools" when pools demonstrably exist); it is only deprioritized,
 * and the caller is told its state.
 */
export function rankSparkPools(pools: SparkPool[], hint: string): SparkPool[] {
  const h = hint.trim().toLowerCase();
  const score = (p: SparkPool): [number, number, string] => {
    const lower = (p.name || '').toLowerCase();
    const hintRank = h && lower.startsWith(h) ? 0 : 1;
    const state = (p.properties?.provisioningState || '').toLowerCase();
    const healthRank = state === 'succeeded' ? 0 : 1;
    return [hintRank, healthRank, lower];
  };
  return [...pools]
    .filter((p) => typeof p?.name === 'string' && p.name.trim())
    .sort((a, b) => {
      const [ah, aHealth, an] = score(a);
      const [bh, bHealth, bn] = score(b);
      if (ah !== bh) return ah - bh;
      if (aHealth !== bHealth) return aHealth - bHealth;
      return an < bn ? -1 : an > bn ? 1 : 0;
    });
}

function stateSuffix(p: SparkPool | undefined): string {
  const state = (p?.properties?.provisioningState || '').trim();
  if (!state || state.toLowerCase() === 'succeeded') return '';
  return ` (ARM reports its provisioning state as "${state}")`;
}

function noPools(preamble: string): UnresolvedSparkPool {
  const ws = workspaceName();
  return {
    ok: false,
    code: 'no_spark_pool',
    status: 503,
    error:
      `${preamble} Loom enumerated Microsoft.Synapse/workspaces/${ws}/bigDataPools and the list came back empty, ` +
      'so there is no Spark pool to attach this notebook to.',
    hint:
      'Deploy one with platform/fiab/bicep/modules/landing-zone/synapse.bicep (deploySparkPool=true, sparkPoolName=<name>) ' +
      '— loomSynapseEnabled=true in the commercial-full, gcc, gcc-high and il5 param files, so an empty list means the pool ' +
      'was not deployed or was deleted out of band. Alternatively point LOOM_SYNAPSE_SPARK_POOL at an existing pool.',
  };
}

function resolvedFrom(
  ordered: SparkPool[],
  source: SparkPoolSource,
  note?: string,
): ResolvedSparkPool {
  const chosen = ordered[0];
  const extra = stateSuffix(chosen);
  return {
    ok: true,
    pool: chosen.name,
    source,
    verified: true,
    alternatives: ordered.slice(1).map((p) => p.name),
    note: note ? `${note}${extra}` : extra ? `Bound to "${chosen.name}"${extra}.` : undefined,
  };
}

export interface ResolveSparkPoolOptions {
  /**
   * Confirm a caller-supplied pool against the workspace's ARM list and
   * re-bind when it is positively absent. TRUE on the BIND points (session
   * create / run-cell create) where a stale name would produce a dead session;
   * FALSE on hot poll paths, where the pool is already bound to a live session
   * id and swapping it would poll the wrong pool.
   */
  verifyRequested?: boolean;
}

/**
 * Resolve the Synapse Spark pool for a notebook operation.
 *
 * @param requested pool supplied by the caller (request body / query param).
 *                  Empty / null means "the platform picks" — the #3171 case.
 */
export async function resolveSparkPool(
  requested?: string | null,
  opts: ResolveSparkPoolOptions = {},
): Promise<SparkPoolResolution> {
  const req = typeof requested === 'string' ? requested.trim() : '';

  // Hot path: an already-bound pool on a poll/keepalive/kill call is honoured
  // verbatim — it is paired with a live Livy session id.
  if (req && !opts.verifyRequested) {
    return { ok: true, pool: req, source: 'request', verified: false, alternatives: [] };
  }

  const hint = envHint();
  const listed = await listPoolsCached();

  // ── The list could not be read. Say so; never invent "no pools exist". ──
  if ('listError' in listed) {
    if (req) {
      return {
        ok: true, pool: req, source: 'request', verified: false, alternatives: [],
        note:
          `Could not confirm Spark pool "${req}" against workspace "${workspaceName()}" — listing its pools failed ` +
          `(${listed.listError}). Using the requested pool as supplied; Loom does not know whether it exists.`,
      };
    }
    if (hint) {
      return {
        ok: true, pool: hint.name, source: 'env', verified: false, alternatives: [],
        note:
          `Could not confirm Spark pool "${hint.name}" against workspace "${workspaceName()}" — listing its pools failed ` +
          `(${listed.listError}). Using the ${hint.varName} hint as supplied; Loom does not know whether it exists.`,
      };
    }
    return {
      ok: false,
      code: 'pool_unresolved',
      status: 502,
      error:
        'Could not determine which Synapse Spark pool to use: no pool was supplied, none of ' +
        `${ENV_HINTS.join(' / ')} is set, and listing the pools of workspace "${workspaceName()}" failed ` +
        `(${listed.listError}). Loom does not know whether a pool exists.`,
      hint:
        `Set ${ENV_HINTS[0]} to a deployed Synapse Spark pool, or grant the Console UAMI Reader on ` +
        `Microsoft.Synapse/workspaces/${workspaceName()} so Loom can enumerate bigDataPools and auto-bind.`,
    };
  }

  const pools = listed.pools.filter((p) => typeof p?.name === 'string' && p.name.trim());
  const names = pools.map((p) => p.name);
  const present = names.length ? names.join(', ') : '(none)';

  // ── A caller-supplied pool, at a BIND point. ──
  if (req) {
    const match = pools.find((p) => p.name.toLowerCase() === req.toLowerCase());
    if (match) {
      const ordered = [match, ...rankSparkPools(pools.filter((p) => p !== match), req)];
      return resolvedFrom(ordered, 'request');
    }
    if (!pools.length) {
      return noPools(`Spark pool "${req}" was requested, but workspace "${workspaceName()}" has no Spark (Big Data) pools.`);
    }
    const ordered = rankSparkPools(pools, req);
    return resolvedFrom(
      ordered, 'workspace',
      `Requested Spark pool "${req}" is not in workspace "${workspaceName()}" (pools present: ${present}); ` +
      `auto-bound to "${ordered[0].name}" instead.`,
    );
  }

  // ── No caller pool: the env hint is a HINT, checked against reality. ──
  if (hint) {
    const match = pools.find((p) => p.name.toLowerCase() === hint.name.toLowerCase());
    if (match) {
      const ordered = [match, ...rankSparkPools(pools.filter((p) => p !== match), hint.name)];
      return resolvedFrom(ordered, 'env');
    }
    if (!pools.length) {
      return noPools(`${hint.varName}="${hint.name}" names a Spark pool, but workspace "${workspaceName()}" has no Spark (Big Data) pools.`);
    }
    const ordered = rankSparkPools(pools, hint.name);
    return resolvedFrom(
      ordered, 'workspace',
      `${hint.varName}="${hint.name}" does not match any pool in workspace "${workspaceName()}" ` +
      `(pools present: ${present}); auto-bound to "${ordered[0].name}" instead.`,
    );
  }

  // ── Nothing supplied, nothing hinted: pick from what the workspace has. ──
  if (!pools.length) {
    return noPools(`No Spark pool was supplied and none of ${ENV_HINTS.join(' / ')} is set.`);
  }
  const ordered = rankSparkPools(pools, '');
  return resolvedFrom(
    ordered, 'workspace',
    `No Spark pool was supplied and none of ${ENV_HINTS.join(' / ')} is set; auto-bound to "${ordered[0].name}" ` +
    `(pools in workspace "${workspaceName()}": ${present}). Set ${ENV_HINTS[0]} to pin a different one.`,
  );
}

/**
 * Did the Livy/ARM client report an HTTP 404 for a URL naming THIS pool?
 *
 * deploy-integrity R7 — this only returns true on an established 404 emitted by
 * synapse-livy-client / synapse-dev-client's own `${label} failed ${status}:`
 * formatting, where the label carries the pool name. Any other failure (403,
 * 429, timeout, DNS) is NOT classified as "pool does not exist", because we did
 * not establish that.
 */
export function isPoolNotFoundError(e: unknown, pool: string): boolean {
  const msg = e instanceof Error ? e.message : typeof e === 'string' ? e : '';
  if (!msg || !pool) return false;
  return / failed 404\b/.test(msg) && msg.includes(pool);
}

/**
 * Create a Livy session on the resolved pool and PROVE the pool accepts it:
 * when the create comes back as an established 404 for that pool name, re-bind
 * once to the next-ranked workspace pool and retry. Bounded to a single retry
 * and FAILS CLOSED — a second failure propagates verbatim (deploy-integrity R6:
 * retry what is retryable, never a retry that cannot fail).
 *
 * Returns the session plus the pool it actually landed on and an honest note
 * about the swap when one happened.
 */
export async function createSessionOnResolvedPool<T>(
  resolution: ResolvedSparkPool,
  create: (pool: string) => Promise<T>,
): Promise<{ session: T; pool: string; note?: string }> {
  const first = resolution.pool;
  try {
    return { session: await create(first), pool: first, note: resolution.note };
  } catch (e: unknown) {
    const alt = resolution.alternatives[0];
    if (!alt || !isPoolNotFoundError(e, first)) throw e;
    const swap =
      `Spark pool "${first}" returned HTTP 404 from the Livy session API; re-bound to "${alt}" and retried.`;
    const session = await create(alt); // fail closed — a second failure propagates
    return { session, pool: alt, note: resolution.note ? `${resolution.note} ${swap}` : swap };
  }
}
