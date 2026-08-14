/**
 * Server-side composition of an AI Search indexer's HEALTH (#3384).
 *
 * ONE implementation, so no surface can pick its own field. The pure decision
 * core lives in `search-indexer-shapes.ts::classifyIndexerHealth` (server-free,
 * unit-tested); this module only does the reads and feeds them in.
 *
 * THE INCIDENT THIS CLOSES (measured 2026-08-13, re-verified 2026-08-14 against
 * dlz-aisearch-dev-eastus2, indexer `research-knowledge-indexer`):
 *
 *     status            : "running"                      <-- read as HEALTHY
 *     lastResult.status : "transientFailure"
 *     lastResult.error  : "Could not connect to Annotation Cache Index
 *                          Storage Acount."
 *     executionHistory  : 50 runs, ALL transientFailure, itemsProcessed 0
 *     target index      : 0 documents, schedule P1D, disabled=false
 *
 * Every consumer that reached for the top-level `status` field saw a healthy
 * pipeline. Nothing asserted on `executionHistory`, so 50 consecutive failures
 * and an empty index were invisible.
 *
 * FAIL CLOSED: when a read throws, the failure is carried into the verdict as
 * `unknown` WITH the real error text — never dropped into a `catch {}` that
 * lets the caller infer success (deploy-integrity R6/R7).
 */
import {
  getIndexer,
  getIndexerStatus,
  getIndexStats,
  listIndexers,
} from './search-index-client';
import {
  classifyIndexerHealth,
  type IndexerHealth,
} from './search-indexer-shapes';

/** The raw status payload plus the derived, non-optimistic health verdict. */
export interface IndexerStatusWithHealth {
  /** Verbatim `GET /indexers/{n}/status`, or null when it could not be read. */
  status: any | null;
  health: IndexerHealth;
}

/**
 * Read one indexer's status + definition + target-index document count and
 * classify it.
 *
 * The definition and the document count are BEST-EFFORT enrichments: when
 * either read fails the verdict is still produced, just without that signal.
 * The status read is NOT best-effort — its failure becomes an `unknown`
 * verdict carrying the error, because "I could not look" must never render the
 * same as "I looked and it was fine".
 */
export async function readIndexerHealth(name: string, service?: string): Promise<IndexerStatusWithHealth> {
  let status: any = null;
  let unreadableReason: string | undefined;
  try {
    status = await getIndexerStatus(name, service);
  } catch (e: any) {
    unreadableReason = e?.message ? String(e.message) : String(e);
  }

  let disabled: boolean | undefined;
  let scheduled: boolean | undefined;
  let targetIndexName: string | undefined;
  try {
    const def: any = await getIndexer(name, service);
    if (def) {
      disabled = def.disabled === true;
      scheduled = !!def.schedule?.interval;
      targetIndexName = typeof def.targetIndexName === 'string' ? def.targetIndexName : undefined;
    }
  } catch {
    // Enrichment only: an unreadable definition costs the schedule/disabled
    // signals, it does not change whether the runs failed.
  }

  let documentCount: number | undefined;
  if (targetIndexName) {
    try {
      documentCount = (await getIndexStats(targetIndexName, service)).documentCount;
    } catch {
      // Enrichment only — see above.
    }
  }

  return {
    status,
    health: classifyIndexerHealth(status, { disabled, scheduled, documentCount, unreadableReason }),
  };
}

/** One indexer's health, as reported by the service-wide sweep. */
export interface IndexerHealthRow {
  name: string;
  targetIndexName?: string;
  health: IndexerHealth;
}

/**
 * Classify EVERY indexer on the service. This is the sweep the readiness probe
 * runs: a per-indexer verdict is only useful if someone looks at it, and before
 * #3384 nothing did.
 */
export async function sweepIndexerHealth(service?: string): Promise<IndexerHealthRow[]> {
  const indexers = await listIndexers(service);
  return Promise.all(
    indexers.map(async (ix) => {
      const { health } = await readIndexerHealth(ix.name, service);
      return { name: ix.name, targetIndexName: ix.targetIndexName, health };
    }),
  );
}
