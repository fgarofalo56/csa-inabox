/**
 * LOOM BRAIN W10 — the COSMOS store (#3936, G10 from the review).
 *
 * ── WHY THIS FILE EXISTS ───────────────────────────────────────────────────
 * The only reference to `CosmosFindingStore` anywhere under `__tests__` was
 * `purity.test.ts`'s allowlist. `list`, `put`, `recordRun`, `lastRun`,
 * `lastScannedRun`, the `documentId` round trip and
 * `FindingDocumentIntegrityError` were all unproven — in the exact layer
 * `ports.ts` itself calls out as "one level down, where no type can catch it".
 * The in-memory store was mutation-tested; the one that will actually run was
 * not.
 *
 * The container is faked at the `@azure/cosmos` `Container` seam rather than
 * mocked at the module level, so the QUERY TEXT and the DOCUMENT SHAPE — the two
 * things that decide whether this works against a real account — are both
 * asserted.
 */

import { describe, expect, it } from 'vitest';
import {
  BRAIN_FINDINGS_DEFAULT_TTL,
  CosmosFindingStore,
  FindingDocumentIntegrityError,
  documentId,
  fingerprintFromDocumentId,
} from '../cosmos-finding-store';
import { RUN_RECORD_TTL_SECONDS, type ScanRunRecord } from '../model';
import { ESTATE, record } from './fixtures';

interface Query {
  query: string;
  parameters: { name: string; value: unknown }[];
}

/** A fake `Container` that records queries and answers from a fixed doc list. */
function fakeContainer(docs: Record<string, unknown>[]) {
  const queries: Query[] = [];
  const upserts: Record<string, unknown>[] = [];
  const container = {
    items: {
      query<T>(q: Query) {
        queries.push(q);
        return {
          async fetchAll(): Promise<{ resources: T[] }> {
            const estate = q.parameters.find((p) => p.name === '@estateId')?.value;
            const docType = q.parameters.find((p) => p.name === '@docType')?.value;
            let rows = docs.filter((d) => d.estateId === estate && d.docType === docType);
            if (q.query.includes('NOT IS_NULL(c.detectorPopulations)')) {
              rows = rows.filter(
                (d) => d.detectorPopulations !== null && d.detectorPopulations !== undefined,
              );
            }
            if (q.query.includes('ORDER BY c.startedAt DESC')) {
              rows = [...rows].sort((a, b) =>
                String(b.startedAt).localeCompare(String(a.startedAt)),
              );
            }
            const top = q.query.match(/SELECT TOP (\d+)/);
            if (top) rows = rows.slice(0, Number(top[1]));
            return { resources: rows as T[] };
          },
        };
      },
      async upsert(doc: Record<string, unknown>) {
        upserts.push(doc);
        return { resource: doc };
      },
    },
  };
  return { container, queries, upserts };
}

function storeOver(docs: Record<string, unknown>[]) {
  const fake = fakeContainer(docs);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const store = new CosmosFindingStore(async () => fake.container as any);
  return { store, ...fake };
}

function runDoc(args: {
  runId: string;
  startedAt: string;
  populations: unknown;
}): Record<string, unknown> {
  const r: ScanRunRecord = {
    schemaVersion: 1,
    docType: 'scan-run',
    id: `run:${args.runId}`,
    estateId: ESTATE,
    runId: args.runId,
    startedAt: args.startedAt,
    finishedAt: args.startedAt,
    cloud: 'AzureCloud',
    verdict: args.populations === null ? 'paused' : 'ok',
    verdictMessage: 'm',
    graphVersionId: null,
    counts: null,
    detectorPopulations: args.populations as ScanRunRecord['detectorPopulations'],
    graphSubjectsDigest: null,
    observed: [],
    notes: [],
    ttl: RUN_RECORD_TTL_SECONDS,
  };
  return r as unknown as Record<string, unknown>;
}

describe('documentId — reversible, not a hash', () => {
  it('round-trips a fingerprint containing ARM-id characters', () => {
    const fp = 'unreachable-service#/subscriptions/x/resourceGroups/rg/providers/A/b/c';
    expect(fingerprintFromDocumentId(documentId(fp))).toBe(fp);
  });

  it('produces a Cosmos-legal id — no / \\ # or ?', () => {
    const id = documentId('detector#/a/b#c?d\\e');
    expect(id).not.toMatch(/[/\\#?]/);
  });

  it('DIFFERENT fingerprints give DIFFERENT ids — encoding cannot collide', () => {
    // A hash introduces a collision class in which two findings share a document
    // and one silently leaves the backlog. Encoding cannot.
    const a = documentId('d#/a');
    const b = documentId('d#/b');
    expect(a).not.toBe(b);
  });

  it('returns empty for an id that is not one of ours', () => {
    expect(fingerprintFromDocumentId('run:123')).toBe('');
  });
});

describe('CosmosFindingStore.list', () => {
  it('returns EVERY record including fixed ones, and strips Cosmos metadata', async () => {
    const fixed = record({ detector: 'd', subject: '/a', state: 'fixed' });
    const { store } = storeOver([
      {
        ...fixed,
        id: documentId(fixed.fingerprint),
        docType: 'finding',
        _rid: 'r',
        _self: 's',
        _etag: 'e',
        _attachments: 'a',
        _ts: 1,
      },
    ]);
    const out = await store.list(ESTATE);
    expect(out).toHaveLength(1);
    expect(out[0].state).toBe('fixed');
    const asRecord = out[0] as unknown as Record<string, unknown>;
    for (const k of ['docType', '_rid', '_self', '_etag', '_attachments', '_ts']) {
      expect(asRecord[k], `${k} leaked into the record`).toBeUndefined();
    }
  });

  it('scopes to the estate and the finding docType', async () => {
    const { store, queries } = storeOver([]);
    await store.list(ESTATE);
    expect(queries[0].query).toContain('c.estateId = @estateId');
    expect(queries[0].query).toContain('c.docType = @docType');
    expect(queries[0].parameters).toEqual([
      { name: '@estateId', value: ESTATE },
      { name: '@docType', value: 'finding' },
    ]);
  });

  it('THROWS when a document id and its stored fingerprint disagree', async () => {
    const r = record({ detector: 'd', subject: '/a', state: 'new' });
    const { store } = storeOver([
      { ...r, id: documentId('a-completely-different-fingerprint'), docType: 'finding' },
    ]);
    await expect(store.list(ESTATE)).rejects.toThrow(FindingDocumentIntegrityError);
  });
});

describe('CosmosFindingStore.put', () => {
  it('writes finding documents with NO ttl — a fixed finding must never expire', async () => {
    // The single most load-bearing property of this store. A `fixed` record that
    // expired would make its next occurrence read as `new`, silently destroying
    // the regression signal.
    const { store, upserts } = storeOver([]);
    await store.put([record({ detector: 'd', subject: '/a', state: 'fixed' })]);
    expect(upserts).toHaveLength(1);
    expect(upserts[0].docType).toBe('finding');
    expect('ttl' in upserts[0]).toBe(false);
  });

  it('keys the document by the reversible id', async () => {
    const r = record({ detector: 'd', subject: '/a', state: 'new' });
    const { store, upserts } = storeOver([]);
    await store.put([r]);
    expect(upserts[0].id).toBe(documentId(r.fingerprint));
    expect(upserts[0].fingerprint).toBe(r.fingerprint);
  });
});

describe('CosmosFindingStore.recordRun', () => {
  it('CONTRAST: a run document DOES carry a ttl', async () => {
    const { store, upserts } = storeOver([]);
    await store.recordRun(
      runDoc({ runId: 'r1', startedAt: '2026-08-24T00:00:00.000Z', populations: null }) as unknown as ScanRunRecord,
    );
    expect(upserts[0].ttl).toBe(RUN_RECORD_TTL_SECONDS);
    expect(upserts[0].docType).toBe('scan-run');
  });
});

describe('CosmosFindingStore.lastScannedRun — S3', () => {
  const scanned = runDoc({
    runId: 'scan-1',
    startedAt: '2026-08-20T00:00:00.000Z',
    populations: [
      {
        detector: 'd',
        examined: 33,
        blind: false,
        findings: 0,
        maxExamined: 33,
        maxExaminedAt: '2026-08-20T00:00:00.000Z',
        reportedStepAt: null,
        decayRebases: 0,
      },
    ],
  });
  const paused1 = runDoc({ runId: 'p1', startedAt: '2026-08-21T00:00:00.000Z', populations: null });
  const paused2 = runDoc({ runId: 'p2', startedAt: '2026-08-22T00:00:00.000Z', populations: null });

  it('SKIPS paused/unreachable runs and returns the last one that SCANNED', async () => {
    // The blocker: `lastRun` returns `p2`, whose populations are null, and the
    // comparator then reports NO BASIS. Under the standing estate-pause mandate
    // that is the NORMAL case, so the P0 comparator would be off almost always.
    const { store } = storeOver([scanned, paused1, paused2]);
    expect((await store.lastScannedRun(ESTATE))?.runId).toBe('scan-1');
    expect((await store.lastRun(ESTATE))?.runId).toBe('p2');
  });

  it('filters in the QUERY, not in a page of results', async () => {
    // A long stretch of paused nights must not push the last real scan off the
    // end of whatever page size a caller happened to pick.
    const { store, queries } = storeOver([scanned, paused1]);
    await store.lastScannedRun(ESTATE);
    expect(queries[0].query).toContain('IS_DEFINED(c.detectorPopulations)');
    expect(queries[0].query).toContain('NOT IS_NULL(c.detectorPopulations)');
    expect(queries[0].query).toContain('ORDER BY c.startedAt DESC');
  });

  it('returns null when nothing has ever scanned — NO BASIS, not "no regression"', async () => {
    const { store } = storeOver([paused1, paused2]);
    expect(await store.lastScannedRun(ESTATE)).toBeNull();
  });

  it('reports how many runs back the basis is', async () => {
    const { store } = storeOver([scanned, paused1, paused2]);
    expect(await store.scannedRunAgeRuns(ESTATE)).toBe(3);
  });

  it('reports 0 when there are no runs at all', async () => {
    const { store } = storeOver([]);
    expect(await store.scannedRunAgeRuns(ESTATE)).toBe(0);
  });

  it('reports 1 when the most recent run scanned', async () => {
    const { store } = storeOver([scanned]);
    expect(await store.scannedRunAgeRuns(ESTATE)).toBe(1);
  });
});

describe('the container settings match the bicep', () => {
  it('declares defaultTtl -1 — TTL on, no blanket expiry', () => {
    // Must stay in step with both cosmos modules;
    // `bicep-containers.test.ts` asserts the other side of that pair.
    expect(BRAIN_FINDINGS_DEFAULT_TTL).toBe(-1);
  });
});

/**
 * #4120 — the `<ScanRunRecord>` generic was a CLAIM, not a fact.
 *
 * `.query<ScanRunRecord>(...)` then `return resources[0] ?? null` types whatever
 * Cosmos persisted as a ScanRunRecord, because the generic is erased at runtime.
 * Same class as #4119 and #4116: a deserialisation boundary that trusts a
 * generic instead of validating.
 *
 * EVERY FIXTURE BELOW DELIBERATELY VIOLATES `ScanRunRecord`, which is the
 * load-bearing requirement — a type-correct fixture cannot reach a lie told to
 * the compiler, so each is built as a plain object and cast at the boundary the
 * store itself sits on. They FAIL against main: there, `lastScannedRun` returns
 * the malformed document (or `null`, or throws a raw TypeError) with nothing
 * saying so, and the anti-ratchet quietly stops enforcing.
 *
 * MUTATION-PROVEN: delete the `assertScanRunRecord` call in `lastScannedRun`
 * and the first four go RED; delete it in `recentRuns` and the last two do.
 */
describe('#4120: a persisted run document is VALIDATED, not coerced', () => {
  /** A run doc with one field removed or replaced. Deliberately not a ScanRunRecord. */
  function malformed(mutate: (d: Record<string, unknown>) => void): Record<string, unknown> {
    const d = runDoc({ runId: 'r1', startedAt: '2026-08-20T00:00:00.000Z', populations: [] });
    d.detectorPopulations = [
      {
        detector: 'd',
        examined: 10,
        blind: false,
        findings: 0,
        maxExamined: 10,
        maxExaminedAt: '2026-08-20T00:00:00.000Z',
        reportedStepAt: null,
        decayRebases: 0,
      },
    ];
    mutate(d);
    return d;
  }

  it('a snapshot missing maxExamined is REJECTED, not returned as a basis', async () => {
    // THE MEASURED CASE. Carried forward, `examined >= undefined` is false for
    // every finite number and `Date.parse(undefined)` is NaN, so the mark is
    // "kept" as undefined forever: the anti-ratchet is on paper and enforces
    // nothing, with no throw, no log and no failing test.
    const doc = malformed((d) => {
      delete (d.detectorPopulations as Record<string, unknown>[])[0].maxExamined;
    });
    const { store } = storeOver([doc]);
    await expect(store.lastScannedRun(ESTATE)).rejects.toThrow(/maxExamined is not a finite number/);
  });

  it('the rejection says it is NOT reading the document as "no scanned run"', async () => {
    // Because that is the whole defect: `null` is a legitimate state the caller
    // renders as "no basis" and moves past.
    const doc = malformed((d) => {
      delete (d.detectorPopulations as Record<string, unknown>[])[0].maxExaminedAt;
    });
    const { store } = storeOver([doc]);
    await expect(store.lastScannedRun(ESTATE)).rejects.toThrow(/silently disable the population anti-ratchet/);
  });

  it('an ABSENT nullable key is rejected — absent is not null', async () => {
    // `graphVersionId: null` is written on PAUSED/UNREACHABLE and is fine.
    // A MISSING key reads as `undefined`, which walks through every `=== null`
    // guard in this module.
    const doc = malformed((d) => {
      delete d.graphVersionId;
    });
    const { store } = storeOver([doc]);
    await expect(store.lastScannedRun(ESTATE)).rejects.toThrow(/graphVersionId is ABSENT/);
  });

  it('names the offending document id, so the repair is possible', async () => {
    const doc = malformed((d) => {
      d.verdict = 'sideways';
    });
    const { store } = storeOver([doc]);
    await expect(store.lastScannedRun(ESTATE)).rejects.toThrow(/id 'run:r1'/);
  });

  it('a WELL-FORMED document still comes back — the check is not a blanket refusal', async () => {
    // POPULATION FLOOR for this block. Without it every assertion above is
    // satisfied by a store that rejects everything, which would be a worse bug
    // than the one being fixed.
    const doc = malformed(() => {});
    const { store } = storeOver([doc]);
    const got = await store.lastScannedRun(ESTATE);
    expect(got?.runId).toBe('r1');
    expect(got?.detectorPopulations?.[0].maxExamined).toBe(10);
  });

  it('an empty result is still null — "nothing has ever scanned" is a real state', async () => {
    const { store } = storeOver([]);
    expect(await store.lastScannedRun(ESTATE)).toBeNull();
  });

  it('recentRuns rejects a malformed element instead of handing it to the caller', async () => {
    // `lastRun` and `scannedRunAgeRuns` both read through `recentRuns`; the
    // latter dereferenced `runs[i].detectorPopulations` with no guard at all.
    const bad = runDoc({ runId: 'r2', startedAt: '2026-08-21T00:00:00.000Z', populations: null });
    delete bad.startedAt;
    const { store } = storeOver([bad]);
    await expect(store.lastRun(ESTATE)).rejects.toThrow(/startedAt is not a string \(got absent\)/);
  });

  it('recentRuns rejects a NULL element rather than dereferencing it', async () => {
    // A null in `resources` reached `runs[i].detectorPopulations` in
    // `scannedRunAgeRuns` as an unhandled TypeError with no document named.
    // `fakeContainer` filters on `d.estateId` and so cannot carry a null row —
    // the container is stubbed directly here so the null actually reaches the
    // store, which is the only way this input shape is testable at all.
    const direct = new CosmosFindingStore(
      async () =>
        ({
          items: {
            query: () => ({ fetchAll: async () => ({ resources: [null] }) }),
          },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        }) as any,
    );
    await expect(direct.lastRun(ESTATE)).rejects.toThrow(/document is not an object \(got null\)/);
    await expect(direct.scannedRunAgeRuns(ESTATE)).rejects.toThrow(/document is not an object \(got null\)/);
  });
});
