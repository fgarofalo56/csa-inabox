/**
 * Cross-replica SQL query cancel — the live-request registry and the TTL'd
 * cancel-intent store that carries a cancel across Container App replicas
 * (#3400).
 *
 * Split out of `azure-sql-client.ts` because it is a bounded context of its own
 * — replica-local request registry, an intent store, and a poll watcher — and
 * because keeping it there took that module past the 1500-LOC monolith-creep
 * warn line (`scripts/ci/check-file-size.mjs`). This is a pure MOVE: no logic,
 * no message string and no state changed, and `azure-sql-client.ts` re-exports
 * every symbol below, so every existing import path still resolves to the SAME
 * module instance. `liveRequests` in particular must stay a single map — the
 * watcher and the query path both mutate it.
 *
 * The credential chain is constructed here rather than imported from
 * `azure-sql-client.ts` so the two modules do not form an import cycle
 * (`scripts/check-circular-deps.mjs`). It is character-for-character the chain
 * that module builds, so the Cosmos AAD token this store mints is the one it
 * minted before the split.
 */

import sql from 'mssql';
import { ChainedTokenCredential, DefaultAzureCredential, ManagedIdentityCredential } from '@azure/identity';
import { AcaManagedIdentityCredential } from '@/lib/azure/aca-managed-identity';

const uamiClientId = process.env.LOOM_UAMI_CLIENT_ID || process.env.AZURE_CLIENT_ID;
const credential = uamiClientId
  ? new ChainedTokenCredential(new AcaManagedIdentityCredential(), new ManagedIdentityCredential({ clientId: uamiClientId }), new DefaultAzureCredential())
  : new DefaultAzureCredential();

/**
 * Registry of live mssql `Request` objects, keyed by a caller-supplied request
 * id. The cancel route (`/query/cancel`) looks the request up and calls
 * `.cancel()`, which makes tedious send a TDS ATTENTION packet on the same
 * connection — SQL Server acknowledges (error 3617 / SYS_ATTN) and the in-flight
 * `.query()` promise rejects with `RequestError('Canceled.', 'ECANCEL')`.
 *
 * This is in-process Node.js state scoped to ONE Container App replica, so a
 * cancel POST only lands when it reaches the replica that started the query.
 *
 * #3400/#3399 — DO NOT "FIX" THIS WITH SESSION AFFINITY. This comment used to
 * instruct the reader to set `ingress.stickySessions.affinity: 'sticky'` or run
 * a single replica. Both are false for this estate and one of them is actively
 * forbidden:
 *
 *   - `loom-console` is declared `multiRevision: true` with `minReplicas: 2`
 *     (admin-plane/main.bicep), and ACA REQUIRES `affinity:'none'` in
 *     multiple-revision mode. app-deployments.bicep now asserts that value on
 *     every deploy precisely so a sticky value set out-of-band cannot wedge
 *     blue-green rolls again — so a reader who followed this advice would have
 *     it reverted by the next deploy, after breaking the roll.
 *   - `lib/auth/msal.ts` documents the console as deliberately scaled out with
 *     affinity OFF: the MSAL token cache is Cosmos-persisted so a round-robin
 *     request finds a warm cache.
 *
 * The fix is a CROSS-REPLICA cancel signal — a TTL'd cancel-intent record keyed
 * by requestId that each replica polls for its OWN live keys — NOT affinity.
 * That store is implemented below ({@link recordCancelIntent} + the watcher);
 * the cancel route writes an intent when the id is not local, and the replica
 * that actually owns the request picks it up and calls `.cancel()`.
 *
 * Entries are removed on completion, error, or explicit cancel (in the `finally`
 * of `executeQuery` and in the cancel route after `.cancel()`).
 */
export const liveRequests: Map<string, sql.Request> = new Map();

// ============================================================
// Cross-replica cancel intents (#3400)
// ============================================================

/**
 * The cross-replica cancel signal.
 *
 * `liveRequests` is per-replica, and `loom-console` runs `multiRevision: true`
 * with `minReplicas: 2`, so a cancel POST routinely lands on a replica that
 * never started the query. Session affinity cannot be the answer — ACA REQUIRES
 * `affinity:'none'` in multiple-revision mode and app-deployments.bicep asserts
 * it on every deploy (#3399).
 *
 * So the cancel route writes a short-lived INTENT keyed by requestId, and every
 * replica polls for the intents matching the ids IT owns. The replica holding
 * the `sql.Request` sends the TDS ATTENTION packet; the requesting replica never
 * needs to reach it directly.
 *
 * WHAT THIS DOES NOT PROMISE. The intent is a request, not a receipt: writing it
 * establishes that the signal was persisted, NOT that a query was cancelled.
 * Only the `/query` response (`code: 'ECANCEL'`) establishes that, and the
 * cancel route's wording is chosen to say exactly that much and no more (R7).
 */
export interface CancelIntentStore {
  /** Persist a cancel intent for `requestId`. Throws if it could not be stored. */
  record(requestId: string): Promise<void>;
  /** True when an unexpired cancel intent exists for `requestId`. */
  has(requestId: string): Promise<boolean>;
  /** Best-effort removal once the intent has been acted on. */
  clear(requestId: string): Promise<void>;
}

/** Cosmos container backing the intent store. Created lazily (createIfNotExists). */
export const CANCEL_INTENT_CONTAINER = 'sql-cancel-intents';

/**
 * Intent lifetime (seconds). Long enough to outlive the poll interval and a
 * slow replica, short enough that a stale intent can never cancel a LATER query
 * — ids are client-minted `crypto.randomUUID()`, so reuse is not a real risk,
 * but a bounded TTL keeps the container self-evicting with no sweeper.
 */
export const CANCEL_INTENT_TTL_SECONDS = 120;

/** How often a replica with live requests checks for intents on its own keys. */
function cancelPollMs(): number {
  const n = Number(process.env.LOOM_SQL_CANCEL_POLL_MS);
  return Number.isFinite(n) && n >= 250 ? n : 1_000;
}

/**
 * Default-ON wherever Cosmos is configured (auto-bind-by-default: the platform
 * wires its own backing store, the operator sets nothing). Off with no Cosmos
 * endpoint (local dev / unit tests) so the in-process path still works with zero
 * infra, and opt-out with `LOOM_SQL_CANCEL_INTENTS_DISABLED=1`.
 */
export function cancelIntentStoreConfigured(): boolean {
  if (_injectedIntentStore) return true;
  if (process.env.LOOM_SQL_CANCEL_INTENTS_DISABLED === '1') return false;
  return !!process.env.LOOM_COSMOS_ENDPOINT;
}

let _injectedIntentStore: CancelIntentStore | null = null;
let _cosmosIntentStore: CancelIntentStore | null = null;
/** Epoch ms of the last FAILED store init; 0 when the last attempt succeeded. */
let _cosmosIntentInitFailedAt = 0;
/** Message from the last FAILED store init; null when the last attempt succeeded. */
let _lastIntentInitError: string | null = null;
/** Message from the last `record()` that threw, cleared at the start of each attempt. */
let _lastIntentWriteError: string | null = null;

/**
 * How long a FAILED store init is remembered before it is retried.
 *
 * Not a one-shot memo. Memoising a failure for the lifetime of the process
 * would turn a single 429 / cold start / DNS blip on the first call into a
 * replica that never publishes and never consumes an intent again — i.e. the
 * permanent cross-replica no-op #3400 exists to remove, re-introduced through a
 * different door and invisible from the outside. Bounded backoff instead: don't
 * hammer a failing endpoint, but always re-arm.
 */
const CANCEL_INTENT_INIT_RETRY_MS = 30_000;

/**
 * TEST HOOK — swap the intent store, reset the watcher, and drop the memoised
 * Cosmos store so the REAL Cosmos init path can be driven more than once in a
 * suite. Not part of the runtime contract; the production path always resolves
 * the Cosmos-backed store and never calls this.
 */
export function _setCancelIntentStore(store: CancelIntentStore | null): void {
  _injectedIntentStore = store;
  _cosmosIntentStore = null;
  _cosmosIntentInitFailedAt = 0;
  _lastIntentInitError = null;
  _lastIntentWriteError = null;
  stopCancelWatcher();
}

async function cancelIntentStore(): Promise<CancelIntentStore | null> {
  if (_injectedIntentStore) return _injectedIntentStore;
  if (!cancelIntentStoreConfigured()) return null;
  if (_cosmosIntentStore) return _cosmosIntentStore;
  // Back off from a recent failure, but never permanently (see the constant).
  if (_cosmosIntentInitFailedAt && Date.now() - _cosmosIntentInitFailedAt < CANCEL_INTENT_INIT_RETRY_MS) {
    return null;
  }
  try {
    const { CosmosClient } = await import('@azure/cosmos');
    const client = new CosmosClient({
      endpoint: process.env.LOOM_COSMOS_ENDPOINT!,
      aadCredentials: credential as any,
    });
    const { database } = await client.databases.createIfNotExists({
      id: process.env.LOOM_COSMOS_DATABASE || 'loom',
    });
    // createIfNotExists so a fresh estate needs no extra ARM step
    // (no-vaporware.md bicep-sync #4 permits the lazy-create path).
    const { container } = await database.containers.createIfNotExists({
      id: CANCEL_INTENT_CONTAINER,
      partitionKey: { paths: ['/requestId'] },
      defaultTtl: CANCEL_INTENT_TTL_SECONDS,
    });
    _cosmosIntentStore = {
      async record(requestId: string) {
        await container.items.upsert({
          id: requestId,
          requestId,
          requestedAt: Date.now(),
          ttl: CANCEL_INTENT_TTL_SECONDS,
        });
      },
      async has(requestId: string) {
        const { resource } = await container.item(requestId, requestId).read<any>();
        return !!resource;
      },
      async clear(requestId: string) {
        try {
          await container.item(requestId, requestId).delete();
        } catch {
          /* already gone or TTL'd — the intent is spent either way */
        }
      },
    };
    _cosmosIntentInitFailedAt = 0;
    return _cosmosIntentStore;
  } catch (e: any) {
    // R7 — the caller must not read this as "no intent"; `recordCancelIntent`
    // returns false so the route reports that it could not persist the signal,
    // rather than claiming a cancellation was requested. Record WHY, both so the
    // route's reason string can name it and so the failure is not silent
    // (deploy-integrity R3 — it was observable nowhere before).
    _cosmosIntentInitFailedAt = Date.now();
    _lastIntentInitError = e?.message || String(e);
    console.warn(
      `[azure-sql-client] cross-replica cancel-intent store init failed; retrying in ${CANCEL_INTENT_INIT_RETRY_MS}ms: ${_lastIntentInitError}`,
    );
    return null;
  }
}

/**
 * Why the intent could not be published, in terms the cancel route is allowed to
 * state as fact (R7).
 *
 * Call ONLY after `recordCancelIntent` returned false. The previous wording
 * asserted "no Cosmos endpoint configured, or the write failed" — but two other
 * paths reach that branch (a deliberate opt-out, and a store init that failed
 * and is backing off), so that sentence named a cause the code had not
 * established. This enumerates the branches that actually exist and says so
 * explicitly when none of them can be distinguished.
 */
export function cancelIntentUnavailableReason(): string {
  if (!_injectedIntentStore && process.env.LOOM_SQL_CANCEL_INTENTS_DISABLED === '1') {
    return 'the cross-replica cancel-intent store is switched off in this deployment '
      + '(LOOM_SQL_CANCEL_INTENTS_DISABLED=1), so the signal was not carried to any other replica';
  }
  if (!_injectedIntentStore && !process.env.LOOM_COSMOS_ENDPOINT) {
    return 'no Cosmos endpoint is configured (LOOM_COSMOS_ENDPOINT), so this deployment has no '
      + 'cross-replica cancel-intent store to carry the signal';
  }
  if (_lastIntentWriteError) {
    return `the cross-replica cancel-intent write failed: ${_lastIntentWriteError}`;
  }
  if (_cosmosIntentInitFailedAt) {
    return 'the cross-replica cancel-intent store could not be opened on this replica'
      + (_lastIntentInitError ? ` (${_lastIntentInitError})` : '')
      + `, and this replica is backing off for up to ${Math.round(CANCEL_INTENT_INIT_RETRY_MS / 1000)}s before retrying`;
  }
  return 'the cross-replica cancel-intent store was not available on this replica, and the specific '
    + 'cause was not recorded';
}

/**
 * Persist a cross-replica cancel intent.
 *
 * Returns TRUE only when the intent was actually stored — the cancel route keys
 * its response off this so it never claims a request it did not make. On FALSE,
 * `cancelIntentUnavailableReason()` names which branch was taken.
 */
export async function recordCancelIntent(requestId: string): Promise<boolean> {
  _lastIntentWriteError = null;
  const store = await cancelIntentStore();
  if (!store) return false;
  try {
    await store.record(requestId);
    return true;
  } catch (e: any) {
    _lastIntentWriteError = e?.message || String(e);
    return false;
  }
}

let _cancelWatcher: ReturnType<typeof setInterval> | null = null;

/**
 * Poll ONCE for intents on this replica's own live keys.
 *
 * Reads are point-reads bounded by `liveRequests.size` (normally 0–2 per
 * replica: a human runs one query at a time), so the watcher costs nothing when
 * idle and next to nothing when busy. Exported for tests.
 */
export async function _pollCancelIntentsOnce(): Promise<void> {
  if (liveRequests.size === 0) return;
  const store = await cancelIntentStore();
  if (!store) return;
  for (const [requestId, request] of [...liveRequests]) {
    let wanted = false;
    try {
      wanted = await store.has(requestId);
    } catch {
      continue; // unknown, not "no" — try again next tick
    }
    if (!wanted) continue;
    try {
      request.cancel(); // tedious: TDS ATTENTION → the /query promise rejects ECANCEL
    } catch {
      /* the request may have completed between the read and here */
    }
    liveRequests.delete(requestId);
    void store.clear(requestId);
  }
}

/** Start the watcher only while this replica actually holds live requests. */
function startCancelWatcher(): void {
  if (_cancelWatcher || !cancelIntentStoreConfigured()) return;
  _cancelWatcher = setInterval(() => {
    void _pollCancelIntentsOnce().finally(stopCancelWatcherIfIdle);
  }, cancelPollMs());
  // Never hold the event loop open (tests, graceful shutdown).
  (_cancelWatcher as any)?.unref?.();
}

function stopCancelWatcher(): void {
  if (_cancelWatcher) {
    clearInterval(_cancelWatcher);
    _cancelWatcher = null;
  }
}

function stopCancelWatcherIfIdle(): void {
  if (liveRequests.size === 0) stopCancelWatcher();
}

/** Register an in-flight request and make sure this replica is watching for intents. */
export function registerLiveRequest(requestId: string, request: sql.Request): void {
  liveRequests.set(requestId, request);
  startCancelWatcher();
}

/** Drop an in-flight request; stops the watcher once the replica goes idle. */
export function unregisterLiveRequest(requestId: string): void {
  liveRequests.delete(requestId);
  stopCancelWatcherIfIdle();
}
