/**
 * `probe-copilot-corpus` — the readiness verdict for the Help Copilot docs-RAG
 * corpus (`health-probes.ts:981-1036`).
 *
 * Reviewer 2's FINDING 6 on #4498: this probe had NO test file at all, and this
 * PR changes what an operator sees on `/admin/readiness` for two inputs —
 * `unknown` (the state this PR adds to `CorpusFreshnessState`) and any state
 * outside the union. Before the change both fell through to `pass`: a green
 * tick over a corpus whose manifest could not be read. That is the R7 defect
 * relocated from a CI log onto the readiness page, so the branch that prevents
 * it is worth a test of its own rather than inference from the freshness unit
 * tests, which stop at `evaluateFreshness` and never reach the probe.
 *
 * `corpusFreshness` is mocked at the module boundary — it is the network edge
 * here (AI Search / Cosmos). Nothing above that edge is faked.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const corpusMock = { corpusFreshness: vi.fn() };
vi.mock('@/lib/azure/loom-docs-index', () => corpusMock);

// Keep the OTHER probes in `runExtraProbes` off the network. This file asserts
// on exactly one result id; the rest are allowed to land wherever they land.
vi.mock('@/lib/azure/arm-client', () => ({
  armGet: vi.fn(async () => ({ value: [], name: 'rg', properties: { provisioningState: 'Succeeded' } })),
}));

import { runExtraProbes, type ProbeHelpers } from '../health-probes';

const h: ProbeHelpers = {
  ctx: { app: 'loom-console', adminRg: 'rg-admin', dlzRg: 'rg-dlz', sub: 'sub-1', uamiClientId: 'uami-1', tenant: 'tid', cosmosAccount: 'cosmos' },
  envVarFix: () => ({ portalSteps: [], fixScript: '' }),
};

/** A full `CorpusFreshness` with the state swapped in — the probe reads
 *  `backend`, `reason`, `indexedAt` and `indexedChunkCount` off the same
 *  object, so a partial fixture would test different code than production. */
function freshness(state: string, over: Record<string, unknown> = {}) {
  return {
    state,
    reason: 'because the fixture says so.',
    backend: 'ai-search' as const,
    indexedAt: '2026-09-14T00:00:00.000Z',
    indexedChunkCount: 51079,
    currentStatFingerprint: 'fp-now',
    indexedStatFingerprint: 'fp-then',
    sourceCommit: 'acdd462503d',
    indexedCommit: 'acdd462503d',
    lastRun: null,
    ...over,
  };
}

async function corpusResult() {
  const results = await runExtraProbes(h);
  const r = results.find((x) => x.id === 'probe-copilot-corpus');
  expect(r, 'probe-copilot-corpus is not wired into runExtraProbes').toBeTruthy();
  return r!;
}

describe('probe-copilot-corpus', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    corpusMock.corpusFreshness.mockResolvedValue(freshness('fresh') as any);
    vi.stubGlobal('fetch', vi.fn(async () => ({ status: 200, ok: true, json: async () => ({}), text: async () => '' }) as any));
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('is wired into runExtraProbes and passes on a fresh corpus', async () => {
    const r = await corpusResult();
    expect(r.status).toBe('pass');
    expect(r.detail).toContain('51079');
    expect(r.category).toBe('ai-copilot');
  });

  it('never-indexed and stale both warn, and neither claims the corpus is usable', async () => {
    for (const state of ['never-indexed', 'stale']) {
      corpusMock.corpusFreshness.mockResolvedValue(freshness(state) as any);
      const r = await corpusResult();
      expect(r.status, state).toBe('warn');
      expect(r.remediation, state).toContain('/api/help-copilot/reindex');
    }
  });

  // ── the branch this PR adds ────────────────────────────────────────────────

  it('UNKNOWN warns, names the read failure, and does NOT assert anything about the corpus', async () => {
    // The operator-visible half of the R7 fix. `loadManifestHead` swallows every
    // exception, so an unreadable manifest used to arrive at this probe as
    // `never-indexed`; now it arrives as `unknown`, and before this diff
    // `unknown` fell through to `pass`. A green tick is the WORST of the three
    // answers — worse than the old wrong-but-loud `never-indexed` — because it
    // tells the operator the check ran and found nothing wrong.
    corpusMock.corpusFreshness.mockResolvedValue(
      freshness('unknown', { reason: 'The corpus manifest could not be READ: AI Search 503.' }) as any,
    );
    const r = await corpusResult();
    expect(r.status).toBe('warn');
    expect(r.detail).toContain('UNKNOWN');
    expect(r.detail).toContain('AI Search 503');          // the cause is carried, not swallowed
    expect(r.detail).toContain('says nothing about');     // …and explicitly not a claim about the corpus
    // The remediation must point at the STORE, not at a reindex — reindexing on
    // a failed read is acting on evidence the probe does not have.
    expect(r.remediation).toContain('reachability');
    expect(r.remediation).not.toContain('/api/help-copilot/reindex');

    // Measured, not reasoned: disabling the `f.state === 'unknown'` block alone
    // does NOT flip this status — the exhaustive guard below it catches
    // `unknown` and also warns. That run is 5 ✓ / 1 ×, and the × is this test,
    // on `expected 'Help Copilot corpus is in an unrecogn…' to contain
    // 'UNKNOWN'`. So the block is load-bearing for the WORDING and the
    // remediation, which is what is asserted here. Flipping the status to
    // `pass` takes BOTH blocks, which the next test records.
  });

  it('a state outside the union warns — the guard that stops the next added state becoming a green tick', async () => {
    // `f.state !== 'fresh'` at `:1015` is unreachable through the type today:
    // `CorpusFreshnessState` is exactly the four members, and the three above it
    // return, so TypeScript narrows `f.state` to `'fresh'` here. That is the
    // point of it — it is reachable the moment a FIFTH member is added, which is
    // exactly how `unknown` (added in `loom-docs-index.ts`, a different file)
    // silently became a `pass` in the first place.
    //
    // Only a mock can produce that input today, so this test is the measurement
    // of an otherwise-unmeasurable branch rather than a simulation of live data.
    corpusMock.corpusFreshness.mockResolvedValue(freshness('rebuilding') as any);
    const r = await corpusResult();
    expect(r.status).toBe('warn');
    expect(r.detail).toContain("unrecognised state 'rebuilding'");
    expect(r.remediation).toContain('CorpusFreshnessState');

    // Measured, three runs against this file:
    //   guard disabled alone            → 5 ✓ / 1 ×, the × is THIS test,
    //                                     `expected 'pass' to be 'warn'`
    //   `unknown` block disabled alone  → 5 ✓ / 1 ×, the × is the test above
    //   both disabled (the pre-diff shape)
    //                                   → 4 ✓ / 2 ×, both on
    //                                     `expected 'pass' to be 'warn'`
    // The last of those is the false green reproduced: `unknown` AND an
    // unrecognised state both returning `status: 'pass'` with the "corpus
    // fresh" detail.
  });

  it('a THROWN read failure warns rather than passing', async () => {
    corpusMock.corpusFreshness.mockRejectedValue(new Error('cosmus unreachable'));
    const r = await corpusResult();
    expect(r.status).toBe('warn');
    expect(r.detail).toContain('cosmus unreachable');
  });

  it('the probe is time-bounded — a hung read cannot hang readiness', async () => {
    // `withTimeout(corpusFreshness(), 8000)`. A never-settling read lands in the
    // catch as a timeout, not as a pending promise that stalls the whole page.
    vi.useFakeTimers();
    try {
      corpusMock.corpusFreshness.mockReturnValue(new Promise(() => {}) as any);
      const p = corpusResult();
      await vi.advanceTimersByTimeAsync(9_000);
      const r = await p;
      expect(r.status).toBe('warn');
      expect(r.detail).toContain('timed out');
    } finally {
      vi.useRealTimers();
    }
  }, 30_000);
});
