/**
 * The corpus container handle is acquired ONCE per process (#4498 round 4).
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * `helpCorpusContainer()` ends in `containers.createIfNotExists(...)`, a Cosmos
 * CONTROL-PLANE call, and it sits under `readLastRunFrom` — which `loadLastRun`
 * invokes for BOTH stores on every `corpusFreshness()`. `corpusFreshness` is a
 * poll: the roll's reindex step waits on it in a loop for up to ~15 minutes, and
 * `/admin/readiness` calls it per request. Unmemoised, that is a control-plane
 * round trip per poll — on the AI Search backend too, which never stores a
 * corpus chunk in Cosmos at all.
 *
 * A comment claiming "memoised" is not a memo. These cases COUNT the calls, so
 * deleting the memo fails the suite instead of quietly restoring the cost.
 *
 * It is a separate file because it needs the Cosmos stub to be a COUNTER with a
 * failure switch, and one `vi.mock` per module per file.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

/** Bumped by the stub on every control-plane call; read by the assertions. */
const state = {
  createCalls: 0,
  failNextCreate: false,
};

vi.mock('@/lib/azure/cosmos-client', () => {
  const items = new Map<string, any>();
  const corpus = {
    items: {
      create: async (d: any) => { items.set(d.id, d); return { resource: d }; },
      upsert: async (d: any) => { items.set(d.id, d); return { resource: d }; },
      query: () => ({ fetchAll: async () => ({ resources: [] }) }),
    },
    item: (id: string) => ({
      read: async () => ({ resource: items.get(id) || null }),
      replace: async (d: any) => { items.set(id, d); return { resource: d }; },
      delete: async () => { items.delete(id); return {}; },
    }),
  };
  const cs = {
    database: {
      containers: {
        createIfNotExists: async () => {
          state.createCalls += 1;
          if (state.failNextCreate) {
            state.failNextCreate = false;
            throw new Error('cosmos control plane unreachable');
          }
          return { container: corpus };
        },
      },
    },
  };
  (globalThis as any).__corpusItems = items;
  return { copilotSessionsContainer: async () => cs };
});

vi.mock('@azure/identity', async () => {
  const real = await vi.importActual<any>('@azure/identity');
  class StubCred { async getToken() { return { token: 'stub', expiresOnTimestamp: Date.now() + 60_000 }; } }
  return { ...real, DefaultAzureCredential: StubCred, ManagedIdentityCredential: StubCred };
});

// Stubbed so a case gets a small, deterministic corpus without walking the real
// source tree. Every other export is the real implementation.
vi.mock('../loom-docs-corpus', async () => {
  const real = await vi.importActual<any>('../loom-docs-corpus');
  return {
    ...real,
    collectSources: () => ({
      chunks: [
        { id: 'docs:a.md#0', kind: 'docs', path: 'a.md', content: 'alpha', touchedAt: '2026-09-14T00:00:00.000Z' },
        { id: 'docs:b.md#0', kind: 'docs', path: 'b.md', content: 'bravo', touchedAt: '2026-09-14T00:00:00.000Z' },
      ],
      files: {
        'a.md': { kind: 'docs', hash: 'h-a', chunks: 1 },
        'b.md': { kind: 'docs', hash: 'h-b', chunks: 1 },
      },
      statFingerprint: 'fp-two-docs',
      contentFingerprint: 'cfp-two-docs',
    }),
  };
});

import { reindex, __testInternals } from '../loom-docs-index';

beforeEach(() => {
  (globalThis as any).__corpusItems.clear();
  state.createCalls = 0;
  state.failNextCreate = false;
  delete process.env.LOOM_AI_SEARCH_SERVICE; // force the Cosmos backend
  process.env.LOOM_BUILD_SHA = 'dcabe1dd02af';
  __testInternals.__resetCorpusContainerForTests();
});

describe('the corpus container handle is memoised (#4498 round 4)', () => {
  it('costs ONE control-plane call across two full rebuilds', async () => {
    // A single `reindex` touches the container several times on its own — it
    // pushes chunks, writes the manifest head and shards, and writes the
    // last-run record. Two rebuilds is therefore comfortably more than two
    // touches, and the memo is the only reason the count is 1. Deleting it
    // makes this number grow, which is exactly the regression to catch.
    const first = await reindex({ jobId: 'memo-1' });
    expect(first.ok).toBe(true);
    const second = await reindex({ jobId: 'memo-2' });
    expect(second.ok).toBe(true);

    expect(state.createCalls).toBe(1);
  });

  it('does NOT cache a rejection — a transient control-plane failure is retried', async () => {
    // Memoising the PROMISE is what makes concurrent callers share one call; it
    // is also what would cache a failure forever if the memo were not cleared on
    // reject. One unreachable moment must not leave the process permanently
    // unable to reach the corpus.
    //
    // The recovery is fast enough to happen INSIDE one rebuild: the first
    // container acquisition is the manifest-head read, which fails, and the
    // chunk push that follows acquires a fresh handle and succeeds. So the
    // measurement is TWO control-plane calls in a single `reindex` that still
    // reports ok — a cached rejection would give one call and a dead rebuild.
    state.failNextCreate = true;
    const recovered = await reindex({ jobId: 'memo-recover' });
    expect(recovered.ok).toBe(true);
    expect(state.createCalls).toBe(2);
  });

  it('shares ONE in-flight call between concurrent callers', async () => {
    // `loadLastRun` issues both store reads with `Promise.all`, so two callers
    // can arrive before the first has resolved. Memoising the resolved handle
    // instead of the promise would let both race and both call.
    const [a, b] = await Promise.all([
      reindex({ jobId: 'memo-par-a' }),
      reindex({ jobId: 'memo-par-b' }),
    ]);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(state.createCalls).toBe(1);
  });
});
