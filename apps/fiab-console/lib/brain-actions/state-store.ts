/**
 * LOOM BRAIN ACTIONS — the per-finding recommendation STATE store (#4242).
 *
 * Two jobs, one document per finding:
 *
 *   1. CURE THE DECISION-AMNESIA the design investigation named: approve /
 *      dismiss used to be a fire-and-forget audit event, so a page reload
 *      forgot every review. Decisions now persist here (the proposals route
 *      writes through), and the read-back route ships them.
 *   2. CARRY THE STAGED TWO-STEP CONFIRM for destructive performs, modeled on
 *      `lib/perf/auto-tune.ts`'s ARM_CLASSES two-tick gate: the first perform
 *      call STAGES (mints a bounded, single-use confirm token and writes
 *      `state: 'staged'`); only a second call presenting that token executes.
 *      The raw token is returned to the caller once and NEVER stored — the
 *      document keeps its SHA-256, so a read of the store cannot mint a
 *      confirmation.
 *
 * Pattern: `lib/brain/run/cosmos-finding-store.ts` — reversible base64url
 * document ids (a hash would introduce a collision class; an encoding cannot
 * collide), `/estateId` partition key, `createIfNotExists` as the sanctioned
 * idempotent fallback (`no-vaporware.md` §Bicep sync item 4). Credential:
 * `uamiArmCredential()`, the factory the ws-credential-adoption ratchet
 * requires — never a hand-rolled chain.
 *
 * Cloud parity: the endpoint arrives as `LOOM_COSMOS_ENDPOINT` from the
 * deploy; nothing here names a cloud-specific host.
 */

import { Buffer } from 'node:buffer';
import { createHash, randomBytes } from 'node:crypto';
import { CosmosClient, type Container } from '@azure/cosmos';
import { uamiArmCredential } from '@/lib/azure/arm-credential';
import type {
  GuardRefusal,
  PerformReceipt,
  RecommendationStateRecord,
  RecommendationStateValue,
  StagedConfirm,
} from './types';

/** The container. Provisioned lazily below (createIfNotExists — the sanctioned
 * Cosmos-init path per no-vaporware.md §Bicep sync item 4). */
export const BRAIN_RECOMMENDATION_STATE_CONTAINER = 'brain-recommendation-state';

/** Partition key path — states are scoped per ESTATE, like brain-findings. */
export const BRAIN_RECOMMENDATION_STATE_PARTITION_KEY = '/estateId';

/** How long a staged confirm stays honourable. Stale stagings re-stage. */
export const STAGED_CONFIRM_TTL_MS = 10 * 60_000;

/** Raised when the deployment has no Cosmos endpoint. The perform gate FAILS
 * CLOSED on this: without the store there is no staged confirm, and a
 * destructive perform without its two-step gate must not run. */
export class BrainActionsNotConfiguredError extends Error {
  constructor() {
    super(
      'LOOM_COSMOS_ENDPOINT is not set, so recommendation states (approved / dismissed / ' +
        'staged / performed / failed) have nowhere to persist and the staged confirm gate ' +
        'cannot operate. This value is emitted by the platform bicep for every boundary; ' +
        'its absence means the console is running outside a completed deploy. NOTHING was ' +
        'read and NOTHING was written.',
    );
    this.name = 'BrainActionsNotConfiguredError';
  }
}

/** Reversible, collision-free document id (same argument as the finding store:
 * an encoding cannot collide; a hash can). */
export function stateDocumentId(findingId: string): string {
  return `rs:${Buffer.from(findingId, 'utf8').toString('base64url')}`;
}

/** The estate partition this console instance writes into. */
export function estateScope(): string {
  return (process.env.LOOM_ESTATE_ID || 'unscoped').trim() || 'unscoped';
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

interface StateDoc extends RecommendationStateRecord {
  id: string;
  docType: 'recommendation-state';
}

let _client: CosmosClient | null = null;
let _container: Container | null = null;

async function defaultContainer(): Promise<Container> {
  if (_container) return _container;
  const endpoint = process.env.LOOM_COSMOS_ENDPOINT;
  if (!endpoint) throw new BrainActionsNotConfiguredError();
  if (!_client) _client = new CosmosClient({ endpoint, aadCredentials: uamiArmCredential() });
  const databaseId = process.env.LOOM_COSMOS_DATABASE || 'loom';
  const { database } = await _client.databases.createIfNotExists({ id: databaseId });
  const { container } = await database.containers.createIfNotExists({
    id: BRAIN_RECOMMENDATION_STATE_CONTAINER,
    partitionKey: { paths: [BRAIN_RECOMMENDATION_STATE_PARTITION_KEY] },
  });
  _container = container;
  return container;
}

/** Test seam — drop the cached client/container. */
export function resetRecommendationStateClient(): void {
  _client = null;
  _container = null;
}

export interface StateActor {
  readonly oid: string;
  readonly upn: string;
}

export class RecommendationStateStore {
  constructor(private readonly getContainer: () => Promise<Container> = defaultContainer) {}

  /**
   * Read the recorded states for this estate — every finding with no document
   * is implicitly `open`. Optionally narrowed to one findingId.
   */
  async read(findingId?: string): Promise<readonly RecommendationStateRecord[]> {
    const container = await this.getContainer();
    const parameters = [
      { name: '@estateId', value: estateScope() },
      { name: '@docType', value: 'recommendation-state' },
      ...(findingId ? [{ name: '@findingId', value: findingId }] : []),
    ];
    const { resources } = await container.items
      .query<StateDoc>({
        query:
          'SELECT * FROM c WHERE c.estateId = @estateId AND c.docType = @docType' +
          (findingId ? ' AND c.findingId = @findingId' : ''),
        parameters,
      })
      .fetchAll();
    return resources.map((doc) => this.toRecord(doc));
  }

  /** Persist a human review decision (the decision-amnesia fix). */
  async recordDecision(
    findingId: string,
    decision: 'approved' | 'dismissed',
    actor: StateActor,
    note?: string,
  ): Promise<RecommendationStateRecord> {
    return this.write(findingId, {
      state: decision,
      actorOid: actor.oid,
      actorUpn: actor.upn,
      ...(note ? { note } : {}),
    });
  }

  /**
   * Stage a destructive perform: mint the single-use confirm token, persist
   * `staged` with its SHA-256 + expiry, and hand the RAW token back exactly
   * once. The second perform call must present it.
   */
  async stage(
    findingId: string,
    detector: string,
    subjectNodeId: string,
    actor: StateActor,
  ): Promise<{ confirmToken: string; expiresAt: string }> {
    const confirmToken = randomBytes(32).toString('base64url');
    const now = Date.now();
    const staging: StagedConfirm = {
      tokenSha256: sha256Hex(confirmToken),
      detector,
      subjectNodeId,
      mintedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + STAGED_CONFIRM_TTL_MS).toISOString(),
    };
    await this.write(findingId, {
      state: 'staged',
      actorOid: actor.oid,
      actorUpn: actor.upn,
      staging,
    });
    return { confirmToken, expiresAt: staging.expiresAt };
  }

  /**
   * Validate + CONSUME a staged confirm. Single-use by construction: a
   * successful consume clears the staging envelope, so replaying the same
   * token refuses. Returns `null` on success, a `GuardRefusal` otherwise —
   * every refusal states what was established, never what was guessed (R7).
   */
  async consumeStagedToken(
    findingId: string,
    detector: string,
    subjectNodeId: string,
    confirmToken: string,
    actor: StateActor,
  ): Promise<GuardRefusal | null> {
    const records = await this.read(findingId);
    const record = records[0];
    if (!record || record.state !== 'staged' || !record.staging) {
      return {
        guard: 'staged-confirm',
        reason:
          `REFUSED: no live staging exists for finding '${findingId}'. A confirm token is ` +
          'honoured only against the staging that minted it; stage the perform again. ' +
          'Nothing was changed in Azure.',
      };
    }
    const s = record.staging;
    if (Date.parse(s.expiresAt) < Date.now()) {
      return {
        guard: 'staged-confirm',
        reason:
          `REFUSED: the staged confirm for '${findingId}' expired at ${s.expiresAt}. A ` +
          'stale staging is re-staged, never honoured — the two-step gate exists so the ' +
          'second affirmation is contemporaneous with the change. Nothing was changed in Azure.',
      };
    }
    if (s.detector !== detector || s.subjectNodeId !== subjectNodeId) {
      return {
        guard: 'staged-confirm',
        reason:
          `REFUSED: the staging for '${findingId}' was minted for detector ` +
          `'${s.detector}' on subject '${s.subjectNodeId}', which does not match this ` +
          'request. A confirm token authorizes exactly the change it staged. Nothing was ' +
          'changed in Azure.',
      };
    }
    if (s.tokenSha256 !== sha256Hex(confirmToken)) {
      return {
        guard: 'staged-confirm',
        reason:
          `REFUSED: the confirm token does not match the staging for '${findingId}'. ` +
          'Nothing was changed in Azure.',
      };
    }
    // Consume: clear the staging so the token can never be honoured twice. The
    // state advances to performed/failed by the caller; between consume and
    // that write the document honestly says a confirm was consumed.
    await this.write(findingId, {
      state: 'staged',
      actorOid: actor.oid,
      actorUpn: actor.upn,
      note: 'confirm token consumed; execution in progress',
    });
    return null;
  }

  /** Record a completed perform with its receipt. */
  async recordPerformed(
    findingId: string,
    receipt: PerformReceipt,
    actor: StateActor,
  ): Promise<RecommendationStateRecord> {
    return this.write(findingId, {
      state: 'performed',
      actorOid: actor.oid,
      actorUpn: actor.upn,
      receipt,
    });
  }

  /** Record a failed perform with the REAL error, verbatim. */
  async recordFailed(
    findingId: string,
    error: string,
    actor: StateActor,
  ): Promise<RecommendationStateRecord> {
    return this.write(findingId, {
      state: 'failed',
      actorOid: actor.oid,
      actorUpn: actor.upn,
      error,
    });
  }

  private async write(
    findingId: string,
    fields: {
      state: RecommendationStateValue;
      actorOid: string;
      actorUpn: string;
      note?: string;
      error?: string;
      staging?: StagedConfirm;
      receipt?: PerformReceipt;
    },
  ): Promise<RecommendationStateRecord> {
    const container = await this.getContainer();
    const doc: StateDoc = {
      id: stateDocumentId(findingId),
      docType: 'recommendation-state',
      estateId: estateScope(),
      findingId,
      state: fields.state,
      updatedAt: new Date().toISOString(),
      actorOid: fields.actorOid,
      actorUpn: fields.actorUpn,
      ...(fields.note !== undefined ? { note: fields.note } : {}),
      ...(fields.error !== undefined ? { error: fields.error } : {}),
      ...(fields.staging !== undefined ? { staging: fields.staging } : {}),
      ...(fields.receipt !== undefined ? { receipt: fields.receipt } : {}),
    };
    await container.items.upsert(doc);
    return this.toRecord(doc);
  }

  private toRecord(doc: StateDoc): RecommendationStateRecord {
    return {
      findingId: doc.findingId,
      estateId: doc.estateId,
      state: doc.state,
      updatedAt: doc.updatedAt,
      actorOid: doc.actorOid,
      actorUpn: doc.actorUpn,
      ...(doc.note !== undefined ? { note: doc.note } : {}),
      ...(doc.error !== undefined ? { error: doc.error } : {}),
      ...(doc.staging !== undefined ? { staging: doc.staging } : {}),
      ...(doc.receipt !== undefined ? { receipt: doc.receipt } : {}),
    };
  }
}

let _store: RecommendationStateStore | null = null;

/** The default store singleton. */
export function recommendationStateStore(): RecommendationStateStore {
  if (!_store) _store = new RecommendationStateStore();
  return _store;
}

/** Test seam — drop the singleton (and the cached Cosmos client). */
export function resetRecommendationStateStore(): void {
  _store = null;
  resetRecommendationStateClient();
}
