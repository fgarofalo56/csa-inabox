/**
 * LOOM BRAIN W9 — the Cosmos-backed history store.
 *
 * THE ONLY MODULE IN `lib/brain/history` PERMITTED AN AZURE IMPORT.
 * `./__tests__/purity.test.ts` asserts that, with an embedded control, because
 * the value of the rest of this layer being pure is that every property it
 * claims is provable without a tenant.
 *
 * ── WHY COSMOS, AND WHY IT SATISFIES cloud-parity ──────────────────────────
 * The Console already owns a Cosmos account in every boundary Loom deploys to
 * (`platform/fiab/bicep/modules/admin-plane/loom-console-cosmos.bicep`): private
 * endpoint, `disableLocalAuth: true`, AAD-only via the Console UAMI, serverless.
 * The endpoint arrives as `LOOM_COSMOS_ENDPOINT` from the deploy, so nothing
 * here contains a cloud-specific host and the same code runs in Commercial, GCC,
 * GCC-High, IL5 and DoD. NOTE HONESTLY: that is an argument from construction.
 * This module has NOT been executed against Azure Government — see the PR body.
 *
 * ── ATOMICITY ──────────────────────────────────────────────────────────────
 * One version is ONE item. Cosmos writes an item atomically, so there is no
 * state in which half a graph is readable — which is the requirement, because a
 * truncated diff base reports a mass of removals that looks exactly like an
 * outage. There is deliberately no chunking path; `./capture` fails a capture
 * that would exceed the document budget rather than splitting it.
 *
 * ── WHY THIS DOES NOT LIVE IN `lib/azure/cosmos-client.ts` ─────────────────
 * That module's `ensure()` createIfNotExists's ~60 containers on the first
 * access of ANY container. This one is estate-scoped rather than tenant-scoped,
 * carries a TTL none of the others do, and is read by exactly one admin surface.
 * A dedicated accessor keeps the Brain's read off that path and keeps the
 * retention policy next to the code that depends on it. It uses the same
 * endpoint env var and the same credential chain, so there is one Cosmos
 * identity story, not two.
 *
 * ── EVERY READ IS VERIFIED ─────────────────────────────────────────────────
 * `load` and `loadRecent` run `verifyGraphVersion` and THROW on failure. A
 * corrupt document never reaches the comparator, so the "mass deletion" failure
 * mode cannot be produced by a bad read — the route turns the throw into an
 * honest error naming the version id.
 */

import { CosmosClient, type Container } from '@azure/cosmos';
import {
  ChainedTokenCredential,
  DefaultAzureCredential,
  ManagedIdentityCredential,
} from '@azure/identity';
// RELATIVE, NOT `@/` — DELIBERATE (#4040). This module is inside the emit
// closure of `lib/brain/run/tsconfig.cli.json`, which declares no `paths`
// mapping on purpose: `tsc` resolves `@/` for typechecking but does NOT rewrite
// the specifier on emit, so an alias here compiles green and then dies at
// 04:11 UTC with `Cannot find module '@/lib/...'`. Inside Next both spellings
// resolve to the same file, so this is behaviour-neutral for the console.
import { AcaManagedIdentityCredential } from '../../azure/aca-managed-identity';
import { verifyGraphVersion } from './digest';
import {
  GraphVersionIntegrityError,
  type GraphVersion,
  type GraphVersionSummary,
} from './model';
import { DEFAULT_RETENTION_POLICY, type RetentionPolicy } from './retention';
import { toSummary, type GraphHistoryStore } from './store';

/** The container. Also declared in `loom-console-cosmos.bicep` — keep in step. */
export const BRAIN_HISTORY_CONTAINER = 'brain-graph-versions';

/** Partition key path. History is scoped per ESTATE, not per tenant. */
export const BRAIN_HISTORY_PARTITION_KEY = '/estateId';

/**
 * Raised when the deployment has no Cosmos endpoint.
 *
 * An HONEST gate, and the only one this feature has: the value is emitted by the
 * platform deploy (`LOOM_COSMOS_ENDPOINT`), so a console that reaches this state
 * is mis-deployed rather than under-configured. The message says which, because
 * R7 forbids asserting a cause the code did not establish.
 */
export class BrainHistoryNotConfiguredError extends Error {
  constructor() {
    super(
      // WHAT THE CODE ESTABLISHED, THEN THE INFERENCE LABELLED AS ONE (#4021
      // item 5). The old wording said the absence "MEANS the console is running
      // outside a completed deploy" — a defensible inference from the bicep
      // contract, stated as a fact. A console running against a partially rolled
      // revision, or one whose env was edited out of band, reaches this same
      // state without being outside a completed deploy. R7: if the code does not
      // know, the message says it does not know.
      'LOOM_COSMOS_ENDPOINT is not set in this deployment, so the Brain graph history has ' +
        'nowhere to persist. The platform bicep emits this value for every boundary, so the ' +
        'likely cause is an incomplete or partially rolled deploy rather than a setting an ' +
        'operator forgot — but this code established only that the variable is unset. ' +
        'No history was read and none was written.',
    );
    this.name = 'BrainHistoryNotConfiguredError';
  }
}

let _client: CosmosClient | null = null;
let _container: Container | null = null;

function credential() {
  const clientId = process.env.LOOM_UAMI_CLIENT_ID || process.env.AZURE_CLIENT_ID;
  const chain: ManagedIdentityCredential[] = [];
  if (clientId) chain.push(new ManagedIdentityCredential({ clientId }));
  return new ChainedTokenCredential(
    new AcaManagedIdentityCredential(),
    ...chain,
    new DefaultAzureCredential(),
  );
}

/**
 * The container, created on first access.
 *
 * `createIfNotExists` with the TTL is the idempotent fallback the repo's bicep
 * rule sanctions, and it is what makes this work on an estate whose Cosmos
 * account predates this container. The bicep declaration is still the primary
 * path — `auto-bind-by-default.md` §5: infra is DEPLOYED, not requested.
 */
export async function brainHistoryContainer(
  policy: RetentionPolicy = DEFAULT_RETENTION_POLICY,
): Promise<Container> {
  if (_container) return _container;
  const endpoint = process.env.LOOM_COSMOS_ENDPOINT;
  if (!endpoint) throw new BrainHistoryNotConfiguredError();
  if (!_client) _client = new CosmosClient({ endpoint, aadCredentials: credential() });
  const databaseId = process.env.LOOM_COSMOS_DATABASE || 'loom';
  const { database } = await _client.databases.createIfNotExists({ id: databaseId });
  const { container } = await database.containers.createIfNotExists({
    id: BRAIN_HISTORY_CONTAINER,
    partitionKey: { paths: [BRAIN_HISTORY_PARTITION_KEY] },
    defaultTtl: policy.ttlSeconds,
    // `/content/*` IS NOT INDEXED (#4018). Kept in step with BOTH bicep
    // declarations — `admin-plane/loom-console-cosmos.bicep` and the
    // `loomContainers` row in `landing-zone/cosmos.bicep` — exactly as the TTL
    // above is. Without it this fallback took the service default, which indexes
    // every property including `content`: the full node/edge graph, sized at
    // 60-100 KB per version in `docs/fiab/brain/graph-history.md`.
    //
    // NOTHING QUERIES INSIDE `content`. The store implements exactly two access
    // patterns — a partition-scoped list ordered by `capturedAt`, and a point
    // read by id + partition key — so the index over the blob is paid for on
    // every write (write RU, plus index storage on top of document storage) and
    // never read.
    indexingPolicy: {
      indexingMode: 'consistent',
      automatic: true,
      includedPaths: [{ path: '/*' }],
      excludedPaths: [{ path: '/content/*' }],
    },
  });
  _container = container;
  return container;
}

/** Reset the memoized client. Tests only; never called by the route. */
export function __resetBrainHistoryContainer(): void {
  _client = null;
  _container = null;
}

/** The persisted shape. Identical to {@link GraphVersion} — no envelope, no drift. */
type VersionDocument = GraphVersion & { readonly _etag?: string };

function assertVerified(v: GraphVersion): GraphVersion {
  const verdict = verifyGraphVersion(v);
  if (!verdict.ok) throw new GraphVersionIntegrityError(v.id, verdict.check, verdict.detail);
  return v;
}

/** Strip the Cosmos system properties so a round-trip re-hashes identically. */
function toVersion(doc: Record<string, unknown>): GraphVersion {
  const {
    id,
    estateId,
    capturedAt,
    formatVersion,
    digest,
    counts,
    collectedProvenances,
    source,
    observedCount,
    lastObservedAt,
    content,
  } = doc as unknown as GraphVersion;
  return {
    id,
    estateId,
    capturedAt,
    formatVersion,
    digest,
    counts,
    collectedProvenances,
    source,
    observedCount,
    lastObservedAt,
    content,
  };
}

export class CosmosGraphHistoryStore implements GraphHistoryStore {
  readonly policy: RetentionPolicy;

  constructor(policy: RetentionPolicy = DEFAULT_RETENTION_POLICY) {
    this.policy = policy;
  }

  private container(): Promise<Container> {
    return brainHistoryContainer(this.policy);
  }

  /**
   * Metadata only — the content is NOT projected.
   *
   * Listing 50 versions must not pull 50 graphs. The projection is written out
   * field by field rather than `SELECT *` for exactly that reason.
   */
  async listSummaries(estateId: string): Promise<readonly GraphVersionSummary[]> {
    const c = await this.container();
    const { resources } = await c.items
      .query<GraphVersionSummary>({
        query:
          'SELECT c.id, c.estateId, c.capturedAt, c.formatVersion, c.digest, c.counts, ' +
          'c.collectedProvenances, c.source, c.observedCount, c.lastObservedAt ' +
          'FROM c WHERE c.estateId = @estateId ORDER BY c.capturedAt ASC',
        parameters: [{ name: '@estateId', value: estateId }],
      })
      .fetchAll();
    return resources;
  }

  async loadRecent(estateId: string, n: number): Promise<readonly GraphVersion[]> {
    if (!Number.isInteger(n) || n < 0) {
      throw new RangeError(`loadRecent: n must be a non-negative integer (got ${n}).`);
    }
    if (n === 0) return [];
    const c = await this.container();
    // `TOP` is interpolated rather than parameterized. `n` is proven to be a
    // non-negative integer one line above, so there is no injection surface,
    // and parameterized TOP is not uniformly supported across Cosmos SQL
    // versions — a query that fails only in one boundary would be a
    // cloud-parity defect discovered in production.
    const { resources } = await c.items
      .query<Record<string, unknown>>({
        query: `SELECT TOP ${n} * FROM c WHERE c.estateId = @estateId ORDER BY c.capturedAt DESC`,
        parameters: [{ name: '@estateId', value: estateId }],
      })
      .fetchAll();
    // The query is newest-first (that is how TOP selects the newest); the
    // CONTRACT is oldest-first. Reversed here, once, rather than leaving every
    // caller to remember — "consecutive versions" and "prune the oldest" both
    // fail silently and catastrophically on a reversed list.
    return resources
      .map(toVersion)
      .map(assertVerified)
      .reverse();
  }

  async load(estateId: string, versionId: string): Promise<GraphVersion | null> {
    const c = await this.container();
    try {
      const { resource } = await c.item(versionId, estateId).read<Record<string, unknown>>();
      if (!resource) return null;
      return assertVerified(toVersion(resource));
    } catch (e) {
      if ((e as { code?: number }).code === 404) return null;
      throw e;
    }
  }

  /**
   * Write a version. ONE item, one atomic write.
   *
   * `create` rather than `upsert`: a version is immutable once written, and an
   * upsert would silently replace a version whose id collided instead of
   * surfacing the collision.
   */
  async append(version: GraphVersion): Promise<void> {
    const c = await this.container();
    await c.items.create<VersionDocument>(version);
  }

  async remove(estateId: string, versionId: string): Promise<void> {
    const c = await this.container();
    try {
      await c.item(versionId, estateId).delete();
    } catch (e) {
      // Already gone (TTL, or a concurrent prune) is the intended end state.
      if ((e as { code?: number }).code === 404) return;
      throw e;
    }
  }

  /**
   * Bump the observation counters on an existing version.
   *
   * Read-modify-write WITHOUT an etag precondition, deliberately: the only
   * fields that move are the two observation counters, and a lost update
   * UNDER-counts. Under-counting makes `nodeUnreachableForConsecutiveVersions`
   * more conservative, never less — the fail-safe direction for a predicate
   * whose output is a deletion proposal. A 412 retry loop here would buy a
   * counter's accuracy at the cost of RU on the hot read path.
   */
  async observe(estateId: string, versionId: string, at: string): Promise<void> {
    const c = await this.container();
    const item = c.item(versionId, estateId);
    try {
      const { resource } = await item.read<Record<string, unknown>>();
      if (!resource) return;
      const current = toVersion(resource);
      await item.replace<GraphVersion>({
        ...current,
        observedCount: current.observedCount + 1,
        lastObservedAt: at,
      });
    } catch (e) {
      if ((e as { code?: number }).code === 404) return;
      throw e;
    }
  }
}
