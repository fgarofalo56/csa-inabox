/**
 * Unit tests for the WS-G incremental corpus index (G1) + freshness guard (G2).
 *
 * Covers the pure logic (content hashing, manifest diff, freshness evaluation)
 * and a full end-to-end round-trip: a first reindex does a FULL build + persists
 * the manifest into a persistent (in-memory) Cosmos corpus container; a second
 * reindex with no source changes runs INCREMENTAL and skips every doc.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Persistent in-memory Cosmos corpus container so the manifest round-trips
// across the two reindex calls (the real fake in help-copilot.test creates a
// fresh container per createIfNotExists, which cannot round-trip a manifest).
vi.mock('@/lib/azure/cosmos-client', () => {
  const items = new Map<string, any>();
  const corpus = {
    items: {
      create: async (d: any) => { items.set(d.id, d); return { resource: d }; },
      upsert: async (d: any) => { items.set(d.id, d); return { resource: d }; },
      query: (_q: any) => ({
        fetchAll: async () => ({
          resources: Array.from(items.values()).filter((d) => d.kind !== '__meta__'),
        }),
      }),
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
  return {
    ...real,
    DefaultAzureCredential: StubCred,
    ManagedIdentityCredential: StubCred,
    ChainedTokenCredential: class { async getToken() { return { token: 'stub', expiresOnTimestamp: Date.now() + 60_000 }; } },
  };
});

import {
  reindex,
  corpusFreshness,
  evaluateFreshness,
  __testInternals,
} from '../loom-docs-index';

const { hashContent, docKey, diffManifest } = __testInternals;

beforeEach(() => {
  (globalThis as any).__corpusItems?.clear();
  delete process.env.LOOM_AI_SEARCH_SERVICE; // force Cosmos backend
});

describe('content hashing (G1)', () => {
  it('is deterministic and distinguishes content', () => {
    expect(hashContent('hello')).toBe(hashContent('hello'));
    expect(hashContent('hello')).not.toBe(hashContent('hello!'));
    expect(hashContent('')).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe('diffManifest (G1 skip / delete logic)', () => {
  it('classifies new, changed, removed, and unchanged docs', () => {
    const prev = {
      'a.md': { kind: 'docs' as const, hash: 'h1', chunks: 2 },
      'b.md': { kind: 'prp' as const, hash: 'h2', chunks: 1 },
      'c.md': { kind: 'docs' as const, hash: 'h3', chunks: 3 },
    };
    const next = {
      'a.md': { kind: 'docs' as const, hash: 'h1', chunks: 2 },      // unchanged
      'b.md': { kind: 'prp' as const, hash: 'h2-new', chunks: 1 },   // changed (same count)
      'd.md': { kind: 'adr' as const, hash: 'h4', chunks: 1 },       // new
      // c.md removed
    };
    const diff = diffManifest(prev, next);
    expect(diff.changed).toBe(2);
    expect(diff.removed).toBe(1);
    expect(diff.unchanged).toBe(1);
    expect(diff.changedPaths.has('b.md')).toBe(true);
    expect(diff.changedPaths.has('d.md')).toBe(true);
    expect(diff.changedPaths.has('a.md')).toBe(false);
    // c.md removed → all 3 of its chunk ids are queued for deletion
    for (const i of [0, 1, 2]) expect(diff.deleteIds).toContain(docKey('docs', 'c.md', i));
  });

  it('deletes orphaned tail chunks when a doc shrinks', () => {
    const prev = { 'x.md': { kind: 'docs' as const, hash: 'old', chunks: 4 } };
    const next = { 'x.md': { kind: 'docs' as const, hash: 'new', chunks: 2 } };
    const diff = diffManifest(prev, next);
    expect(diff.changedPaths.has('x.md')).toBe(true);
    // chunks 2 and 3 are orphaned and must be deleted; 0 and 1 are re-uploaded.
    expect(diff.deleteIds).toContain(docKey('docs', 'x.md', 2));
    expect(diff.deleteIds).toContain(docKey('docs', 'x.md', 3));
    expect(diff.deleteIds).not.toContain(docKey('docs', 'x.md', 0));
  });

  it('a no-change diff produces zero work', () => {
    const same = { 'a.md': { kind: 'docs' as const, hash: 'h', chunks: 2 } };
    const diff = diffManifest(same, { ...same });
    expect(diff.changed).toBe(0);
    expect(diff.removed).toBe(0);
    expect(diff.unchanged).toBe(1);
    expect(diff.deleteIds).toHaveLength(0);
  });
});

describe('evaluateFreshness (G2)', () => {
  it('reports never-indexed when there is no manifest', () => {
    expect(evaluateFreshness('fp', null).state).toBe('never-indexed');
  });
  it('reports fresh when fingerprints match', () => {
    expect(evaluateFreshness('fp', { statFingerprint: 'fp' }).state).toBe('fresh');
  });
  it('reports stale when fingerprints differ', () => {
    expect(evaluateFreshness('fp-new', { statFingerprint: 'fp-old' }).state).toBe('stale');
  });
});

describe('reindex incremental round-trip (G1 + G2)', () => {
  it('first build is full, second build skips every unchanged doc', async () => {
    const first = await reindex();
    expect(first.ok).toBe(true);
    expect(first.backend).toBe('cosmos');
    expect(first.mode).toBe('full');
    expect(first.totalChunks).toBeGreaterThan(0);

    const total = first.totalChunks;
    const second = await reindex();
    expect(second.ok).toBe(true);
    expect(second.mode).toBe('incremental');
    expect(second.skipped).toBe(total);
    expect(second.uploaded).toBe(0);
    expect(second.changed).toBe(0);
    expect(second.deleted).toBe(0);
  }, 60_000);

  it('an explicit full request rebuilds even with a manifest present', async () => {
    await reindex();
    const forced = await reindex({ full: true });
    expect(forced.mode).toBe('full');
    expect(forced.uploaded).toBe(forced.totalChunks);
  }, 60_000);

  it('corpusFreshness is never-indexed before a build and fresh after', async () => {
    const before = await corpusFreshness();
    expect(before.state).toBe('never-indexed');
    expect(before.backend).toBe('cosmos');

    await reindex();
    const after = await corpusFreshness();
    expect(after.state).toBe('fresh');
    expect(after.indexedChunkCount).toBeGreaterThan(0);
    expect(after.indexedAt).toBeTruthy();
  }, 60_000);
});
