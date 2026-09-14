/**
 * Corpus-manifest persistence on the AI SEARCH backend (issue #2964).
 *
 * WHY THIS SUITE EXISTS
 * ---------------------
 * The pre-existing round-trip test (`loom-docs-index-incremental.test.ts`)
 * deletes `LOOM_AI_SEARCH_SERVICE` to force the COSMOS backend. The live
 * console runs on AI SEARCH — so the backend that actually ships had no
 * manifest round-trip coverage at all, and it was broken from the day the
 * incremental index landed:
 *
 *   POST /indexes/loom-docs/docs/index   (one doc, `content` = the ~480 KB
 *                                         manifest JSON for 2,604 files)
 *   -> HTTP 207, value[0].status = false,
 *      "Field 'content' contains a term that is too large to process.
 *       The max length for UTF-8 encoded terms is 32766 bytes."
 *
 * 207 is a 2xx, so `response.ok` was TRUE; the rejection lived only in the
 * response body, which `saveManifest` never read and never returned. Result:
 * `reindex()` reported `ok:true, uploaded:50089`, `job.state:'succeeded'`, and
 * `freshness.state` stayed `never-indexed` forever — so the CI reindex gate
 * (which correctly waits on the durable freshness signal) could only ever time
 * out at 900s with no reason, and the incremental path could never engage.
 *
 * THE FIXTURE MODELS THE SERVICE, NOT THE CODE
 * --------------------------------------------
 * The emulator below enforces the SAME ceiling and the SAME 207 semantics, and
 * both numbers were measured against a live Azure AI Search service before this
 * fixture was written:
 *
 *   content = 32,766 bytes -> HTTP 200, status:true
 *   content = 32,770 bytes -> HTTP 207, status:false, term-too-large
 *
 * The first test asserts the emulator actually enforces that, so this suite can
 * never degrade into a fixture that agrees with whatever the code happens to do.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@azure/identity', async () => {
  const real = await vi.importActual<any>('@azure/identity');
  class StubCred { async getToken() { return { token: 'stub', expiresOnTimestamp: Date.now() + 60_000 }; } }
  return {
    ...real,
    DefaultAzureCredential: StubCred,
    ManagedIdentityCredential: StubCred,
    ChainedTokenCredential: class { async getToken() { return { token: 'stub', expiresOnTimestamp: Date.now() + 60_000 }; } },
  };
});
vi.mock('@/lib/azure/aca-managed-identity', () => ({
  AcaManagedIdentityCredential: class {
    async getToken() { return { token: 'stub', expiresOnTimestamp: Date.now() + 60_000 }; }
  },
}));

// A Cosmos container, so the CROSS-STORE FALLBACK in `saveLastRun` has a second
// store to actually reach (#4497). Every test in this file runs with AI Search
// configured, so this is only exercised when the AI Search write refuses —
// which is exactly the arm under test.
vi.mock('@/lib/azure/cosmos-client', () => {
  const items = new Map<string, any>();
  const corpus = {
    items: {
      create: async (d: any) => { items.set(d.id, d); return { resource: d }; },
      upsert: async (d: any) => {
        if ((globalThis as any).__cosmosRefuses) throw new Error('cosmos unreachable');
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
  (globalThis as any).__cosmosDocs = items;
  return { copilotSessionsContainer: async () => cs };
});

import { reindex, corpusFreshness, __testInternals } from '../loom-docs-index';

const { encodeFiles, decodeFiles, SEARCH_MAX_TERM_BYTES, MANIFEST_SHARD_CHARS, MANIFEST_KEY, manifestShardKey, LAST_RUN_KEY } =
  __testInternals as any;

// ---------------------------------------------------------------------------
// A faithful-enough Azure AI Search emulator.
// ---------------------------------------------------------------------------

/** Keys whose write the harness should force-reject (failure-injection). */
const rejectKeys = new Set<string>();
let docs = new Map<string, any>();

function indexAction(action: any): { key: string; status: boolean; errorMessage: string | null; statusCode: number } {
  const key = action.id;
  if (action['@search.action'] === 'delete') {
    docs.delete(key);
    return { key, status: true, errorMessage: null, statusCode: 200 };
  }
  if (rejectKeys.has(key)) {
    return { key, status: false, errorMessage: 'Injected rejection for this key.', statusCode: 400 };
  }
  // THE REAL CEILING — measured against a live service, not inferred from code.
  for (const [field, value] of Object.entries(action)) {
    if (field.startsWith('@') || typeof value !== 'string') continue;
    if (Buffer.byteLength(value, 'utf-8') > 32_766) {
      return {
        key,
        status: false,
        errorMessage: `Field '${field}' contains a term that is too large to process. `
          + 'The max length for UTF-8 encoded terms is 32766 bytes.',
        statusCode: 400,
      };
    }
  }
  const { '@search.action': _a, ...doc } = action;
  docs.set(key, doc);
  return { key, status: true, errorMessage: null, statusCode: 201 };
}

function respond(url: string, init?: any): Response {
  const p = new URL(url).pathname;
  const method = init?.method || 'GET';
  if (p === '/indexes/loom-docs' && method === 'GET') {
    return new Response(JSON.stringify({ name: 'loom-docs' }), { status: 200 });
  }
  if (p === '/indexes/loom-docs/docs/index' && method === 'POST') {
    const results = JSON.parse(init.body).value.map(indexAction);
    // Partial failure => 207 Multi-Status, which IS a 2xx. This is the whole
    // trap: `response.ok` cannot be the success signal for this API.
    const status = results.some((r: any) => !r.status) ? 207 : 200;
    return new Response(JSON.stringify({ value: results }), { status });
  }
  const m = p.match(/^\/indexes\/loom-docs\/docs\/(.+)$/);
  if (m && method === 'GET') {
    const doc = docs.get(decodeURIComponent(m[1]));
    if (!doc) return new Response(JSON.stringify({ error: { message: 'not found' } }), { status: 404 });
    return new Response(JSON.stringify(doc), { status: 200 });
  }
  return new Response(`unhandled ${method} ${p}`, { status: 500 });
}

beforeEach(() => {
  docs = new Map();
  rejectKeys.clear();
  (globalThis as any).__cosmosDocs?.clear();
  delete (globalThis as any).__cosmosRefuses;
  process.env.LOOM_AI_SEARCH_SERVICE = 'search-emulated';
  process.env.LOOM_BUILD_SHA = 'abc12345';
  vi.stubGlobal('fetch', vi.fn(async (input: any, init: any) => respond(String(input), init)));
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.LOOM_AI_SEARCH_SERVICE;
  delete process.env.LOOM_BUILD_SHA;
});

describe('the emulator enforces the REAL AI Search term ceiling', () => {
  it('accepts 32,766 bytes and rejects 32,770 with a 207 + per-document error', async () => {
    const at = indexAction({ '@search.action': 'mergeOrUpload', id: 'a', content: 'x'.repeat(32_766) });
    const over = indexAction({ '@search.action': 'mergeOrUpload', id: 'b', content: 'x'.repeat(32_770) });
    expect(at.status).toBe(true);
    expect(over.status).toBe(false);
    expect(over.errorMessage).toMatch(/32766 bytes/);
    // …and the transport status for a partial failure is a 2xx.
    const r = respond('https://s.search.windows.net/indexes/loom-docs/docs/index?api-version=2024-07-01', {
      method: 'POST',
      body: JSON.stringify({ value: [{ '@search.action': 'mergeOrUpload', id: 'c', content: 'x'.repeat(40_000) }] }),
    });
    expect(r.status).toBe(207);
    expect(r.ok).toBe(true); // <- the trap this whole fix is about
  });
});

describe('manifest shard codec', () => {
  it('never emits a shard that could exceed the AI Search term ceiling', () => {
    const files: Record<string, any> = {};
    for (let i = 0; i < 4000; i++) {
      files[`docs/fiab/section-${i % 40}/a-fairly-long-document-name-${i}.md`] =
        { kind: 'docs', hash: 'f'.repeat(32), chunks: (i % 30) + 1 };
    }
    const shards = encodeFiles(files);
    expect(shards.length).toBeGreaterThan(1);
    for (const s of shards) {
      expect(Buffer.byteLength(s, 'utf-8')).toBeLessThanOrEqual(MANIFEST_SHARD_CHARS);
      expect(Buffer.byteLength(s, 'utf-8')).toBeLessThan(SEARCH_MAX_TERM_BYTES);
    }
    expect(decodeFiles(shards.join(''))).toEqual(files);
  });

  it('round-trips a map with non-ASCII paths (base64 keeps shards byte-safe)', () => {
    const files = { 'docs/fiab/ünïcødé-—-path.md': { kind: 'docs', hash: 'a'.repeat(32), chunks: 2 } } as any;
    expect(decodeFiles(encodeFiles(files).join(''))).toEqual(files);
  });
});

describe('reindex → corpusFreshness on the AI Search backend', () => {
  it('persists the manifest and reports fresh', async () => {
    const r = await reindex();
    expect(r.error).toBeUndefined();
    expect(r.ok).toBe(true);
    expect(r.backend).toBe('ai-search');
    expect(r.uploaded).toBeGreaterThan(0);

    const f = await corpusFreshness();
    expect(f.state).toBe('fresh');
    // The acceptance criteria from #2964, verbatim.
    expect(f.indexedChunkCount).toBe(r.uploaded);
    expect(f.indexedCommit).toBe(f.sourceCommit);
    expect(f.indexedCommit).toBe('abc12345');
    expect(f.indexedStatFingerprint).toBe(f.currentStatFingerprint);
    expect(f.indexedAt).toBeTruthy();
  }, 120_000);

  it('writes no single manifest document above the ceiling', async () => {
    await reindex();
    const metaDocs = [...docs.entries()].filter(([k]) => k.startsWith(MANIFEST_KEY));
    expect(metaDocs.length).toBeGreaterThan(1); // head + at least one shard
    for (const [, d] of metaDocs) {
      expect(Buffer.byteLength(d.content, 'utf-8')).toBeLessThanOrEqual(SEARCH_MAX_TERM_BYTES);
    }
  }, 120_000);

  it('engages the incremental path on a second, unchanged run', async () => {
    const first = await reindex();
    expect(first.mode).toBe('full');
    const second = await reindex();
    // Only possible if the manifest genuinely round-tripped through AI Search.
    expect(second.ok).toBe(true);
    expect(second.mode).toBe('incremental');
    expect(second.skipped).toBeGreaterThan(0);
    expect(second.uploaded).toBe(0);
  }, 240_000);
});

describe('a rejected manifest write FAILS the run (it can no longer pass silently)', () => {
  /**
   * MUTATION PROOF, as a test. Reject exactly the manifest head — every chunk
   * still uploads, so this is the pre-fix situation reproduced deliberately.
   * Before #2964 this produced `ok:true` / `job.state:'succeeded'` with
   * freshness pinned at `never-indexed`, and the CI poller could only time out.
   */
  it('reports ok:false naming the AI Search error, and freshness stays never-indexed', async () => {
    rejectKeys.add(MANIFEST_KEY);
    const r = await reindex();
    expect(r.ok).toBe(false);
    expect(r.uploaded).toBeGreaterThan(0); // the chunks DID land
    expect(r.error).toMatch(/freshness manifest could not be persisted/i);
    expect(r.error).toMatch(/Injected rejection/);

    const f = await corpusFreshness();
    expect(f.state).toBe('never-indexed');
  }, 120_000);

  it('fails when a files shard is rejected, and leaves no head to read as complete', async () => {
    rejectKeys.add(manifestShardKey(0));
    const r = await reindex();
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/manifest shard 0\//);
    expect(docs.has(MANIFEST_KEY)).toBe(false); // shards are written BEFORE the head
    expect((await corpusFreshness()).state).toBe('never-indexed');
  }, 120_000);

  it('treats a missing shard as never-indexed rather than a half manifest', async () => {
    await reindex();
    expect((await corpusFreshness()).state).toBe('fresh'); // head alone is enough…
    // …but the incremental path needs the file map, and a hole in it must force
    // a safe FULL rebuild rather than diffing against a partial manifest.
    docs.delete(manifestShardKey(0));
    const second = await reindex();
    expect(second.ok).toBe(true);
    expect(second.mode).toBe('full');
  }, 240_000);
});

/**
 * The durable last-run record on the backend that actually ships (#4497).
 *
 * `loom-docs-lastrun.test.ts` covers the PRODUCER, but it forces the Cosmos
 * backend — so the AI Search write arm of `saveLastRun`, and the cross-store
 * fallback beside it, had no coverage on the path the live console takes.
 *
 * The fallback's own comment justifies itself with three measured failure
 * classes in which "the record died of the same cause as the thing it was meant
 * to explain". That is a durability claim, and an unmeasured durability claim is
 * the exact defect #4497 exists to fix. These cases measure it.
 */
describe('the last-run record on the AI Search path (#4497)', () => {
  it('is written into the SAME index as the chunks, under the pinned key', async () => {
    const r = await reindex({ jobId: 'job-ai-search' });
    expect(r.ok).toBe(true);
    expect(r.backend).toBe('ai-search');

    const doc = docs.get(LAST_RUN_KEY);
    expect(doc).toBeTruthy();
    const run = JSON.parse(doc.content);
    expect(run.outcome).toBe('succeeded');
    expect(run.jobId).toBe('job-ai-search');
    expect(run.backend).toBe('ai-search');
    expect(run.sourceCommit).toBe('abc12345');
    expect(run.chunkCount).toBe(r.totalChunks);
  }, 120_000);

  it('a rejected MANIFEST still records the failure — the roll case, on this backend', async () => {
    // The pairing that defeated the roll: the manifest write fails, freshness
    // never flips, and the poller's only output is "900s elapsed". The record
    // must survive the manifest's failure to be able to explain it, and the two
    // writes are independent documents precisely so that it can.
    rejectKeys.add(MANIFEST_KEY);
    const r = await reindex({ jobId: 'job-manifest-rejected' });
    expect(r.ok).toBe(false);

    const run = JSON.parse(docs.get(LAST_RUN_KEY).content);
    expect(run.outcome).toBe('failed');
    expect(run.error).toMatch(/freshness manifest could not be persisted/i);
    expect(run.jobId).toBe('job-manifest-rejected');
  }, 120_000);

  it('falls back to Cosmos when AI Search refuses the record itself', async () => {
    // The failure class the fallback was added for: the record cannot be written
    // to the same store that just failed. Rejecting the record's OWN key (rather
    // than the manifest's) is the only way to reach that arm, because
    // `indexBatch` reports per-document status — a rejection of one document
    // says nothing about the next.
    rejectKeys.add(LAST_RUN_KEY);
    const r = await reindex({ jobId: 'job-fallback' });
    expect(r.ok).toBe(true); // a diagnosis write must never fail a good rebuild

    expect(docs.has(LAST_RUN_KEY)).toBe(false); // AI Search really did refuse it
    const fallback = (globalThis as any).__cosmosDocs.get(LAST_RUN_KEY);
    expect(fallback).toBeTruthy();
    expect(JSON.parse(fallback.content).jobId).toBe('job-fallback');
  }, 120_000);

  it('a total outage of both stores warns and still returns the rebuild', async () => {
    // The honest limit of the claim, pinned so it is not overstated later: the
    // fallback removes the single-store correlation, it does not make the record
    // bulletproof. When neither store takes it there is nothing to read, and the
    // poller's timeout is the backstop — but the rebuild itself must not fail.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    rejectKeys.add(LAST_RUN_KEY);
    (globalThis as any).__cosmosRefuses = true;

    const r = await reindex({ jobId: 'job-no-store' });
    expect(r.ok).toBe(true);
    expect(docs.has(LAST_RUN_KEY)).toBe(false);
    expect((globalThis as any).__cosmosDocs.has(LAST_RUN_KEY)).toBe(false);
    expect(warn.mock.calls.flat().join(' ')).toMatch(/last-run record could not be persisted/);
    warn.mockRestore();
  }, 120_000);
});
