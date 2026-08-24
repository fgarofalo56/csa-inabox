/**
 * LOOM BRAIN W10 — the Cosmos-backed finding store (#3936).
 *
 * THE ONLY MODULE IN `lib/brain/run` (outside `./azure/`) PERMITTED AN AZURE
 * IMPORT. `./__tests__/purity.test.ts` asserts that with an embedded control,
 * because the value of the rest of this lane being pure is that every property
 * it claims — the regression transition, the suppression expiry, "absence is not
 * a fix" — is provable without a tenant.
 *
 * ── WHY FINDING DOCUMENTS CARRY NO TTL ─────────────────────────────────────
 * This is the single most load-bearing decision in the file, and it is the
 * opposite of the one W9 made for graph versions.
 *
 * A `fixed` finding is the ONLY thing that makes its next occurrence a
 * REGRESSION. If a fixed record expires, the next run finds no prior record and
 * mints a `new` one — and the loudest signal this lane produces is silently
 * downgraded to the quietest, by a retention policy, with nothing in any log to
 * show for it. So the container is declared `defaultTtl: -1` (TTL enabled, NO
 * blanket expiry) and finding documents carry no per-document `ttl`.
 *
 * RUN documents do carry one ({@link RUN_RECORD_TTL_SECONDS}, 90 days): a run
 * record is operational telemetry, and losing an old one costs nothing.
 *
 * ── THE DOCUMENT ID IS REVERSIBLE, NOT A HASH ──────────────────────────────
 * A fingerprint is `detector#<ARM id>`, which contains `/` and is therefore not
 * a legal Cosmos id. It is base64url-encoded rather than hashed: a hash
 * introduces a collision class in which two different findings share a document
 * and one of them silently leaves the backlog — the population-shrinking failure
 * this repo measures as its dominant evasion. Encoding cannot collide. The
 * decoded value is asserted on read anyway, so a hand-edited document cannot
 * masquerade as a different finding.
 *
 * ── CLOUD PARITY ───────────────────────────────────────────────────────────
 * The endpoint arrives as `LOOM_COSMOS_ENDPOINT` from the deploy, so nothing
 * here contains a cloud-specific host and the same code runs in Commercial, GCC,
 * GCC-High, IL5 and DoD. NOTE HONESTLY: that is an argument from construction,
 * not a receipt. This module has NOT been executed against a live Cosmos account
 * in either boundary — see the PR body.
 */

import { Buffer } from 'node:buffer';
import { CosmosClient, type Container } from '@azure/cosmos';
import {
  ChainedTokenCredential,
  DefaultAzureCredential,
  ManagedIdentityCredential,
  type TokenCredential,
} from '@azure/identity';
import type { FindingRecord, ScanRunRecord } from './model';
import type { FindingStore } from './ports';

/** The container. Also declared in both cosmos bicep modules — keep in step. */
export const BRAIN_FINDINGS_CONTAINER = 'brain-findings';

/** Partition key path. Findings are scoped per ESTATE, not per tenant. */
export const BRAIN_FINDINGS_PARTITION_KEY = '/estateId';

/**
 * Container-level TTL setting: `-1` means TTL is ENABLED but there is no blanket
 * expiry — each document opts in with its own `ttl`. Finding documents do not.
 * Must stay in step with the two bicep declarations.
 */
export const BRAIN_FINDINGS_DEFAULT_TTL = -1;

/**
 * Raised when the deployment has no Cosmos endpoint.
 *
 * An HONEST gate, and the only one this lane has: the value is emitted by the
 * platform deploy, so a run that reaches this state is mis-deployed rather than
 * under-configured. The message says which, because R7 forbids asserting a cause
 * the code did not establish.
 */
export class BrainFindingsNotConfiguredError extends Error {
  constructor() {
    super(
      'LOOM_COSMOS_ENDPOINT is not set for this run, so the Brain findings have nowhere to ' +
        'persist. This value is emitted by the platform bicep for every boundary; its ' +
        'absence means the run is executing outside a completed deploy, not that an operator ' +
        'forgot a setting. NOTHING was read and NOTHING was written.',
    );
    this.name = 'BrainFindingsNotConfiguredError';
  }
}

/** A stored document whose id and fingerprint disagree. Fails closed. */
export class FindingDocumentIntegrityError extends Error {
  constructor(id: string, storedFingerprint: string) {
    super(
      `finding document '${id}' decodes to a different fingerprint than the one it stores ` +
        `('${storedFingerprint}'). REFUSING to reconcile against it: a document whose ` +
        'identity cannot be trusted would either close the wrong finding or reset one that ' +
        'has a repair history, and a reset destroys the regression signal.',
    );
    this.name = 'FindingDocumentIntegrityError';
  }
}

/** Reversible, collision-free document id. */
export function documentId(fingerprint: string): string {
  return `f:${Buffer.from(fingerprint, 'utf8').toString('base64url')}`;
}

/** Inverse of {@link documentId}. */
export function fingerprintFromDocumentId(id: string): string {
  if (!id.startsWith('f:')) return '';
  return Buffer.from(id.slice(2), 'base64url').toString('utf8');
}

function credential(): TokenCredential {
  const clientId = process.env.LOOM_UAMI_CLIENT_ID || process.env.AZURE_CLIENT_ID;
  const chain: ManagedIdentityCredential[] = [];
  if (clientId) chain.push(new ManagedIdentityCredential({ clientId }));
  return new ChainedTokenCredential(...chain, new DefaultAzureCredential());
}

let _client: CosmosClient | null = null;
let _container: Container | null = null;

/**
 * The container, created on first access.
 *
 * `createIfNotExists` is the idempotent fallback the repo's bicep rule sanctions,
 * and it is what makes this work on an estate whose Cosmos account predates this
 * container. The bicep declaration is still the PRIMARY path —
 * `auto-bind-by-default.md` §5: infra is DEPLOYED, not requested.
 */
export async function brainFindingsContainer(): Promise<Container> {
  if (_container) return _container;
  const endpoint = process.env.LOOM_COSMOS_ENDPOINT;
  if (!endpoint) throw new BrainFindingsNotConfiguredError();
  if (!_client) _client = new CosmosClient({ endpoint, aadCredentials: credential() });
  const databaseId = process.env.LOOM_COSMOS_DATABASE || 'loom';
  const { database } = await _client.databases.createIfNotExists({ id: databaseId });
  const { container } = await database.containers.createIfNotExists({
    id: BRAIN_FINDINGS_CONTAINER,
    partitionKey: { paths: [BRAIN_FINDINGS_PARTITION_KEY] },
    defaultTtl: BRAIN_FINDINGS_DEFAULT_TTL,
  });
  _container = container;
  return container;
}

/** Reset the cached client. Test seam only. */
export function resetBrainFindingsClient(): void {
  _client = null;
  _container = null;
}

interface FindingDoc extends Record<string, unknown> {
  id: string;
  docType: 'finding';
  estateId: string;
  fingerprint: string;
}

export class CosmosFindingStore implements FindingStore {
  constructor(private readonly getContainer: () => Promise<Container> = brainFindingsContainer) {}

  /**
   * EVERY record for the estate, including `fixed` ones.
   *
   * Deliberately unfiltered. A store that helpfully hid fixed findings would
   * make the next recurrence look brand new — the regression property defeated
   * at the persistence layer, one level below where any type can catch it.
   */
  async list(estateId: string): Promise<readonly FindingRecord[]> {
    const container = await this.getContainer();
    const { resources } = await container.items
      .query<FindingDoc>({
        query: 'SELECT * FROM c WHERE c.estateId = @estateId AND c.docType = @docType',
        parameters: [
          { name: '@estateId', value: estateId },
          { name: '@docType', value: 'finding' },
        ],
      })
      .fetchAll();

    const out: FindingRecord[] = [];
    for (const doc of resources) {
      const decoded = fingerprintFromDocumentId(doc.id);
      if (decoded !== doc.fingerprint) {
        throw new FindingDocumentIntegrityError(doc.id, doc.fingerprint);
      }
      const { docType: _docType, _rid, _self, _etag, _attachments, _ts, ...record } = doc as
        FindingDoc & Record<string, unknown>;
      void _rid;
      void _self;
      void _etag;
      void _attachments;
      void _ts;
      out.push(record as unknown as FindingRecord);
    }
    return out;
  }

  async put(records: readonly FindingRecord[]): Promise<void> {
    const container = await this.getContainer();
    for (const r of records) {
      // NOTE: no `ttl` field. See the header — a fixed finding that expired
      // would make its next occurrence read as `new`.
      await container.items.upsert({
        ...r,
        id: documentId(r.fingerprint),
        docType: 'finding',
      });
    }
  }

  async recordRun(run: ScanRunRecord): Promise<void> {
    const container = await this.getContainer();
    // Run records DO carry a ttl — operational telemetry, not evidence.
    await container.items.upsert({ ...run });
  }

  /**
   * The most recent run for this estate.
   *
   * Ordered by `startedAt` DESC. `null` means NO BASIS — the population
   * comparator renders that as "cannot tell", never as "no regression".
   */
  async lastRun(estateId: string): Promise<ScanRunRecord | null> {
    const container = await this.getContainer();
    const { resources } = await container.items
      .query<ScanRunRecord>({
        query:
          'SELECT TOP 1 * FROM c WHERE c.estateId = @estateId AND c.docType = @docType ' +
          'ORDER BY c.startedAt DESC',
        parameters: [
          { name: '@estateId', value: estateId },
          { name: '@docType', value: 'scan-run' },
        ],
      })
      .fetchAll();
    return resources[0] ?? null;
  }
}
