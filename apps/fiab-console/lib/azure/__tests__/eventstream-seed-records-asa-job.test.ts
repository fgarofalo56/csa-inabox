/**
 * #5046 finding 4 - the auto-bind eventstream seed must RECORD the Stream
 * Analytics job its stand-up created, so `state.asaJobName` exists for teardown.
 *
 * Breaking inputs:
 *   - seed with a stand-up result that created job 'asa-loom-abc'  -> the seed
 *     result must carry statePatch {asaJobName:'asa-loom-abc'}; fails if the
 *     seed goes back to discarding the stand-up result.
 *   - seed with a PARTIAL stand-up (asaJobName null)                -> NO
 *     asaJobName key (and seeded:false); fails if a null/derived name is
 *     recorded for a job that was never created.
 *   - ensureAutoBinding with a seed that returns a statePatch       -> the key
 *     must reach the outcome's statePatch (what the caller persists); fails if
 *     the engine's `finish()` keeps dropping it. Also: a provider key beats a
 *     colliding seed key, so a seed cannot overwrite the binding.
 */
import { describe, it, expect, vi } from 'vitest';

const standUp = vi.fn();
vi.mock('@/lib/azure/eventstream-standup', () => ({
  standUpEventstreamAzure: (...a: any[]) => standUp(...a),
  bundleContentToTopology: () => ({ sources: [], sinks: [{ name: 'd' }], transforms: [] }),
}));

import { seedEventstreamFromContent } from '@/lib/azure/auto-bind-seed';
import { ensureAutoBinding, type AutoBindContext, type AutoBindProvider } from '@/lib/azure/auto-bind';

const ctx: AutoBindContext = {
  itemId: 'abc12345-0000',
  itemType: 'eventstream',
  displayName: 'ES',
  workspaceId: 'ws',
  state: { content: { kind: 'eventstream', sources: [{ id: 's' }], destinations: [{ id: 'd' }], transforms: [] } },
};

describe('seedEventstreamFromContent records the created job', () => {
  it('returns statePatch.asaJobName from the stand-up result', async () => {
    standUp.mockResolvedValueOnce({ partial: false, asaJobName: 'asa-loom-abc12345' });
    const r = await seedEventstreamFromContent('ES', ctx);
    expect(r.seeded).toBe(true);
    expect(r.statePatch).toEqual({ asaJobName: 'asa-loom-abc12345' });
    // the stand-up was invoked with THIS item's id (the tag/derivation input)
    expect(standUp.mock.calls.at(-1)?.[1]).toBe('abc12345-0000');
  });

  it('records NOTHING when the stand-up was partial (no job was created)', async () => {
    standUp.mockResolvedValueOnce({ partial: true, asaJobName: null, hint: 'ASA not configured' });
    const r = await seedEventstreamFromContent('ES', ctx);
    expect(r.seeded).toBe(false);
    expect(r.statePatch).toBeUndefined();
  });
});

describe('ensureAutoBinding forwards a seed statePatch', () => {
  const objects = new Set<string>();
  const provider = (seedPatch: Record<string, unknown>): AutoBindProvider => ({
    provider: 'fake',
    itemTypes: ['eventstream'],
    backingNameFor: (c) => ({ name: c.displayName, sanitized: false }),
    preflight: async () => ({ ok: true, coords: {} }),
    probe: async (n) => objects.has(n),
    create: async (n) => { objects.add(n); },
    stateKeys: (n) => ({ transportHub: n }),
    existingBinding: () => null,
    seedFromContent: async () => ({ seeded: true, statePatch: seedPatch }),
  });

  it('the created-path outcome carries the seed key next to the provider key', async () => {
    objects.clear();
    const out = await ensureAutoBinding(ctx, { providers: [provider({ asaJobName: 'asa-loom-x' })] });
    if (out.status !== 'bound') throw new Error('expected bound');
    expect(out.statePatch.asaJobName).toBe('asa-loom-x');
    expect(out.statePatch.transportHub).toBe('ES');
  });

  it('a provider-owned key wins over a colliding seed key', async () => {
    objects.clear();
    const out = await ensureAutoBinding(ctx, { providers: [provider({ transportHub: 'HIJACK' })] });
    if (out.status !== 'bound') throw new Error('expected bound');
    expect(out.statePatch.transportHub).toBe('ES');
  });
});
