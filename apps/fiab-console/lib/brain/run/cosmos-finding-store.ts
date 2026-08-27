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
import type { TokenCredential } from '@azure/identity';
import { scanCredential } from './azure/scan-credential';
import type { FindingRecord, ScanRunRecord } from './model';
import type { FindingStore } from './ports';
import { validateFindingDocument } from './record-validation';

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

/** How far back {@link CosmosFindingStore.scannedRunAgeRuns} will look. */
export const RUN_AGE_SCAN_LIMIT = 200;

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

/**
 * The credential.
 *
 * ── WHY THIS IS NOT A HAND-ROLLED CHAIN (ws-credential-adoption) ──────────
 * `scripts/ci/check-workspace-credential-adoption.mjs` is a shrink-only ratchet
 * on `new ChainedTokenCredential(`, and the first version of this lane added two
 * — taking the repo from 130 to 131 and failing the gate. The gate's stated
 * remedy is the per-workspace factory, or `uamiArmCredential()` for admin/ARM
 * clients.
 *
 * NEITHER IS AVAILABLE HERE, and the reason is structural rather than a
 * preference: `lib/azure/arm-credential.ts` imports
 * `@/lib/azure/aca-managed-identity`, which imports `./fetch-with-timeout`,
 * which imports `@/lib/resilience/fault-injection`. This module is inside the
 * CLI's emit closure, and `tsconfig.cli.json` declares NO `paths` mapping on
 * purpose — tsc resolves `@/` for typechecking but does not rewrite it on emit,
 * so an alias anywhere in that closure compiles and then dies at 04:11 UTC with
 * `Cannot find module '@/lib/...'`. Adopting the factory would trade a lint gate
 * for a runtime failure.
 *
 * So the chain is not hand-rolled AT ALL — it is the SDK's own.
 * `DefaultAzureCredential` already composes Environment -> WorkloadIdentity ->
 * ManagedIdentity -> AzureCLI, and `managedIdentityClientId` selects WHICH
 * managed identity, which is precisely what the two-leg chain was written to do.
 * One documented constructor replaces a bespoke composition — the same
 * centralisation argument the gate itself makes.
 *
 * On the in-VNet ACA runner the selected identity is the console UAMI, which
 * already holds Cosmos Data Contributor on this account.
 *
 * ── AND IT IS NOW ASSERTED, NOT ASSUMED (review of #4014, B1) ─────────────
 * The paragraph above was TRUE about what was constructed and WRONG about what
 * ran. `EnvironmentCredential` is FIRST in that chain (measured:
 * @azure/identity 4.13.1, defaultAzureCredential.js:78-80), the workflow set
 * AZURE_CLIENT_ID/SECRET/TENANT_ID at job level, and nothing in this repo sets
 * `AZURE_TOKEN_CREDENTIALS` — so the deploy service principal won every time and
 * the managed-identity leg was never evaluated. The SP holds no
 * `sqlRoleAssignments` anywhere in the platform bicep, and `disableLocalAuth`
 * makes AAD-RBAC the only data-plane path, so every call here would have
 * returned 403 on the first scheduled run in both boundaries.
 *
 * The shadowing env vars are gone from both jobs, and this now goes through
 * `./azure/scan-credential.ts`, which decodes the minted token and FAILS CLOSED
 * if the principal is not the one the run declared. Constructing the right
 * credential is not evidence that the right credential was used.
 *
 * `AZURE_CLIENT_ID` is deliberately NOT consulted: in Actions that is the
 * service principal's app id, and handing it to a managed-identity credential
 * asks IMDS for an identity that is not attached to anything.
 */
function credential(): TokenCredential {
  const clientId = (process.env.LOOM_UAMI_CLIENT_ID || '').trim();
  return scanCredential({
    expectedClientId: clientId,
    cloud: (process.env.LOOM_CLOUD || 'unknown-boundary').trim() || 'unknown-boundary',
  });
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
   *
   * ── AND EVERY RECORD IS VALIDATED HERE (review of #4014, S1) ─────────────
   * This is the READ boundary, and until this fix it was the only boundary that
   * did not have one. `acceptFinding()` validates at CONSTRUCTION; nothing
   * validated what Cosmos handed back, so `doc as unknown as FindingRecord` was
   * a lie told to the compiler that `reconcile()` then dereferenced. See
   * `./record-validation.ts` for the two input shapes that had no fixture — one
   * kills the lane permanently, the other suppresses a finding forever in
   * silence.
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
      // FAIL CLOSED on a shape this build cannot reconcile. Never skipped — a
      // record that silently leaves the backlog is the population-shrinking
      // failure this lane exists to detect.
      out.push(validateFindingDocument(record, doc.id));
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
   * The most recent run for this estate, WHATEVER its verdict.
   *
   * Ordered by `startedAt` DESC. NOT the population basis — see
   * {@link lastScannedRun}.
   */
  async lastRun(estateId: string): Promise<ScanRunRecord | null> {
    const runs = await this.recentRuns(estateId, 1);
    return runs[0] ?? null;
  }

  /**
   * The most recent run that actually SCANNED.
   *
   * `IS_DEFINED` + `NOT IS_NULL` because a PAUSED or UNREACHABLE run persists
   * `detectorPopulations: null`, and taking the basis from one of those erases
   * the baseline — measured in review as a blocker, since the standing
   * estate-pause mandate makes PAUSED the normal operating mode.
   *
   * The filter is in the QUERY rather than applied to a page of results, so a
   * long stretch of paused nights cannot push the last real scan off the end of
   * whatever page size a caller happened to pick.
   */
  async lastScannedRun(estateId: string): Promise<ScanRunRecord | null> {
    const container = await this.getContainer();
    const { resources } = await container.items
      .query<ScanRunRecord>({
        query:
          'SELECT TOP 1 * FROM c WHERE c.estateId = @estateId AND c.docType = @docType ' +
          'AND IS_DEFINED(c.detectorPopulations) AND NOT IS_NULL(c.detectorPopulations) ' +
          'ORDER BY c.startedAt DESC',
        parameters: [
          { name: '@estateId', value: estateId },
          { name: '@docType', value: 'scan-run' },
        ],
      })
      .fetchAll();
    return resources[0] ?? null;
  }

  /**
   * How many runs back the last SCANNED run is, counting itself as 1.
   *
   * Bounded: it reads at most {@link RUN_AGE_SCAN_LIMIT} recent runs.
   *
   * ── `0` MEANS "NOT FOUND", NEVER "ONE RUN AGO" (review of #4014, N5) ─────
   * The two `FindingStore` implementations disagreed for the case "runs exist,
   * none of them scanned": the in-memory one returned `0` and this one returned
   * {@link RUN_AGE_SCAN_LIMIT}. Harmless while the value was only read when
   * `previousRun !== null` — and NOT harmless now, because the S5 staleness axis
   * reads it on the PAUSED path, which is exactly the case where a lane may have
   * run for weeks without ever scanning. A contract divergence between the
   * implementation that is TESTED and the one that will RUN is the gap
   * `cosmos-store.test.ts`'s own header was written about.
   *
   * So both now return `0` for "no scanned run inside the window", and the
   * authoritative answer to "has anything EVER scanned?" is
   * {@link lastScannedRun}, whose filter is IN THE QUERY and therefore unbounded.
   * `./staleness.ts` uses exactly that split.
   */
  async scannedRunAgeRuns(estateId: string): Promise<number> {
    const runs = await this.recentRuns(estateId, RUN_AGE_SCAN_LIMIT);
    for (let i = 0; i < runs.length; i += 1) {
      if (runs[i].detectorPopulations !== null && runs[i].detectorPopulations !== undefined) {
        return i + 1;
      }
    }
    return 0;
  }

  private async recentRuns(estateId: string, top: number): Promise<ScanRunRecord[]> {
    // `TOP @n` is PARAMETERISED, not interpolated. Cosmos SQL supports a
    // parameter in TOP, so there is no reason to build this by concatenation —
    // and `top` reaching a query string at all is the shape
    // `scripts/ci/check-sql-quoting.mjs` exists to keep out of the codebase,
    // even when the value is a local constant today.
    if (!Number.isSafeInteger(top) || top < 1) {
      throw new RangeError(
        `recentRuns: top must be a positive safe integer (got ${String(top)}). Refusing to ` +
          'issue a query whose bound cannot be established.',
      );
    }
    const container = await this.getContainer();
    const { resources } = await container.items
      .query<ScanRunRecord>({
        query:
          'SELECT TOP @top * FROM c WHERE c.estateId = @estateId AND c.docType = @docType ' +
          'ORDER BY c.startedAt DESC',
        parameters: [
          { name: '@top', value: top },
          { name: '@estateId', value: estateId },
          { name: '@docType', value: 'scan-run' },
        ],
      })
      .fetchAll();
    return resources;
  }
}
