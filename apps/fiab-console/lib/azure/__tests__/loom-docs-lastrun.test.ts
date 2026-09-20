/**
 * The PRODUCER half of the durable last-run record (#4497).
 *
 * WHY THIS FILE EXISTS — AND WHY IT IS SEPARATE
 * --------------------------------------------
 * A reviewer measured that deleting BOTH `saveLastRun` calls from `reindex()`
 * left the entire tree green: every vitest addition for #4497 exercised the
 * pure `evaluateFreshness`, and the 40 shell tests feed a hand-written fixture.
 * So the one thing the roll actually depends on — that a rebuild's outcome
 * reaches a store every replica can read — had no test at all. That is the same
 * defect shape the fix is about: a signal believed durable, never measured.
 *
 * It is a separate file because these cases need `collectSources` STUBBED (to
 * force an empty corpus and to force a THROW), and the incremental round-trip
 * suite needs the real walker. One `vi.mock` per module per file, so: two files.
 *
 * Every case here asserts on the bytes in the store, not on the return value —
 * a return value is this replica's view, and this replica's view is what the
 * roll already had.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// A PERSISTENT in-memory corpus container, plus a per-id write failure switch so
// a manifest write can fail while the last-run write is still allowed to land
// (the exact correlation the reviewer's third failure class describes).
vi.mock('@/lib/azure/cosmos-client', () => {
  const items = new Map<string, any>();
  const corpus = {
    items: {
      create: async (d: any) => { items.set(d.id, d); return { resource: d }; },
      upsert: async (d: any) => {
        const fail = (globalThis as any).__failWritesForId as string | undefined;
        if (fail && d.id === fail) throw new Error(`cosmos rejected ${d.id}`);
        items.set(d.id, d);
        return { resource: d };
      },
      query: () => ({ fetchAll: async () => ({ resources: [] }) }),
    },
    item: (id: string) => ({
      read: async () => ({ resource: items.get(id) || null }),
      replace: async (d: any) => { items.set(id, d); return { resource: d }; },
      delete: async () => { items.delete(id); return {}; },
    }),
  };
  const cs = { database: { containers: { createIfNotExists: async () => ({ container: corpus }) } } };
  (globalThis as any).__corpusItems = items;
  return { copilotSessionsContainer: async () => cs };
});

vi.mock('@azure/identity', async () => {
  const real = await vi.importActual<any>('@azure/identity');
  class StubCred { async getToken() { return { token: 'stub', expiresOnTimestamp: Date.now() + 60_000 }; } }
  return { ...real, DefaultAzureCredential: StubCred, ManagedIdentityCredential: StubCred };
});

// The walker is stubbed so a case can hand `reindexInner` an empty corpus or a
// raised exception. Everything else in the module is the REAL implementation —
// `loom-docs-index` imports ~12 names from here and none of the others are what
// is under test.
vi.mock('../loom-docs-corpus', async () => {
  const real = await vi.importActual<any>('../loom-docs-corpus');
  return {
    ...real,
    collectSources: () => {
      const behaviour = (globalThis as any).__collectBehaviour as string | undefined;
      if (behaviour === 'throw') throw new Error('walker exploded reading docs/');
      if (behaviour === 'empty') {
        return { chunks: [], files: {}, statFingerprint: 'fp-empty', contentFingerprint: 'cfp-empty' };
      }
      const chunks = [
        { id: 'docs:a.md#0', kind: 'docs', path: 'a.md', content: 'alpha', touchedAt: '2026-09-14T00:00:00.000Z' },
        { id: 'docs:b.md#0', kind: 'docs', path: 'b.md', content: 'bravo', touchedAt: '2026-09-14T00:00:00.000Z' },
      ];
      return {
        chunks,
        files: {
          'a.md': { kind: 'docs', hash: 'h-a', chunks: 1 },
          'b.md': { kind: 'docs', hash: 'h-b', chunks: 1 },
        },
        statFingerprint: 'fp-two-docs',
        contentFingerprint: 'cfp-two-docs',
      };
    },
  };
});

import { reindex, __testInternals } from '../loom-docs-index';
import { startReindexJob, __resetReindexJob, __awaitReindexJob } from '../reindex-job';

const { LAST_RUN_KEY } = __testInternals;

/** Read what a DIFFERENT replica would read: the persisted document, parsed. */
function readLastRun(): any | null {
  const doc = (globalThis as any).__corpusItems.get(LAST_RUN_KEY);
  return doc ? JSON.parse(doc.content) : null;
}

beforeEach(() => {
  (globalThis as any).__corpusItems.clear();
  delete (globalThis as any).__collectBehaviour;
  delete (globalThis as any).__failWritesForId;
  delete process.env.LOOM_AI_SEARCH_SERVICE; // force the Cosmos backend
  process.env.LOOM_BUILD_SHA = 'dcabe1dd02af';
  __resetReindexJob();
});

afterEach(() => {
  delete process.env.LOOM_BUILD_SHA;
});

describe('the last-run record is PRODUCED, not just readable (#4497)', () => {
  it('pins the document id, because other replicas and older images read it', () => {
    // A rename here is a silent break: the writer stops being visible to every
    // reader that has not been redeployed. Changing it is a migration, not an
    // edit, so it costs a test failure.
    expect(LAST_RUN_KEY).toBe('corpus-last-run');
  });

  it('a SUCCEEDED rebuild lands in the shared store', async () => {
    const result = await reindex({ jobId: 'job-success' });
    expect(result.ok).toBe(true);

    const run = readLastRun();
    expect(run).not.toBeNull();
    expect(run.outcome).toBe('succeeded');
    expect(run.error).toBeNull();
    expect(run.jobId).toBe('job-success');
    expect(run.backend).toBe('cosmos');
    expect(run.chunkCount).toBe(result.totalChunks);
    expect(run.sourceCommit).toBe('dcabe1dd02af');
    expect(Date.parse(run.finishedAt)).not.toBeNaN();
  });

  it('a FAILED rebuild lands too, carrying the reason', async () => {
    // This is the arm `classify-reindex-result.mjs` reads for `rebuild_failed`.
    // A record written only on success could never explain a failure, which is
    // precisely the state the roll was in.
    (globalThis as any).__collectBehaviour = 'empty';
    const result = await reindex({ jobId: 'job-empty' });
    expect(result.ok).toBe(false);

    const run = readLastRun();
    expect(run.outcome).toBe('failed');
    expect(run.error).toContain('No corpus chunks discovered');
    expect(run.jobId).toBe('job-empty');
    expect(run.chunkCount).toBe(0);
  });

  it('a THROWN rebuild is recorded BEFORE it propagates', async () => {
    // The least visible outcome of all, and the reason the record is a wrapper
    // rather than an edit to each `return`: the job went `failed` in ONE
    // replica's memory while every other replica kept answering `idle` over an
    // unchanged manifest. The throw must still reach the caller.
    (globalThis as any).__collectBehaviour = 'throw';
    await expect(reindex({ jobId: 'job-throw' })).rejects.toThrow('walker exploded');

    const run = readLastRun();
    expect(run).not.toBeNull();
    expect(run.outcome).toBe('failed');
    expect(run.error).toContain('reindex threw');
    expect(run.error).toContain('walker exploded');
    expect(run.jobId).toBe('job-throw');
    expect(run.chunkCount).toBe(0);
  });

  it('survives the MANIFEST write failing — the case it exists to explain', async () => {
    // A rebuild that cannot persist its manifest reports ok:false and freshness
    // never flips, so the poller times out. Without this record the poller's
    // only output is "900s elapsed"; with it, the operator gets the cause. The
    // record must therefore not share the manifest's fate.
    (globalThis as any).__failWritesForId = __testInternals.MANIFEST_KEY;
    const result = await reindex({ jobId: 'job-manifest-dead' });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('freshness manifest could not be persisted');

    const run = readLastRun();
    expect(run).not.toBeNull();
    expect(run.outcome).toBe('failed');
    expect(run.error).toContain('freshness manifest could not be persisted');
    expect(run.jobId).toBe('job-manifest-dead');
  });

  it('records the jobId the POST handed back, end to end', async () => {
    // The whole correlation chain: `startReindexJob` mints the id, returns it to
    // the caller in the 202, hands it to the runner, and the runner persists it.
    // `reindex-loom-docs.sh` then gates on `LAST_JOB_ID = POST_JOB_ID` — which
    // is only sound if these are the same id. Correlating on TIME instead (what
    // this replaced) both misses sub-second failures and lets an unrelated
    // concurrent run's failure red a healthy one.
    const { jobId } = startReindexJob((id) => reindex({ jobId: id }));
    await __awaitReindexJob();

    expect(jobId).toMatch(/^[0-9a-f-]{36}$/);
    expect(readLastRun().jobId).toBe(jobId);
  });

  it('records a null jobId rather than inventing one when none was supplied', async () => {
    // The health probe and the admin button call `reindex()` bare. The record
    // must say "no job id" instead of fabricating a value the poller could
    // match against.
    await reindex();
    expect(readLastRun().jobId).toBeNull();
  });
});
