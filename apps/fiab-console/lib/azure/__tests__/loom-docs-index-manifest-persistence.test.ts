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

import { reindex, corpusFreshness, __testInternals } from '../loom-docs-index';

const { encodeFiles, decodeFiles, SEARCH_MAX_TERM_BYTES, MANIFEST_SHARD_CHARS, MANIFEST_KEY, manifestShardKey } =
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
