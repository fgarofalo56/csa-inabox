/**
 * #3695 — the eventstream provisioner must not report `created` when the
 * backend refs never reached the Cosmos item.
 *
 * WHAT THIS PINS, AND WHY IT IS NOT COVERED BY `eventstream-provisioner.test.ts`.
 * That suite mocks `replace` as an always-resolving `vi.fn()`, so it exercises
 * only the happy path of `persistBackendRefs`. The defect lived on the OTHER
 * branch: the write was wrapped in a swallowing try/catch and
 * `provisionEventHubs` returned `status:'created'` unconditionally, so an
 * install could report success while the record the editor reads never landed.
 * Every assertion below is written so that restoring the old shape (a swallow
 * plus an unconditional `created`) turns it RED — that is the mutation this
 * file exists to catch, and it was measured, not assumed.
 *
 * The false comment is covered too: the swallow was justified in-code by
 * "editor will re-provision on open", which
 * `app/api/items/eventstream/[id]/route.ts` contradicts — with no `state.ehId`
 * it reports `runtimeStatus:'draft'` and asks the user to press Provision.
 * deploy-integrity.md R7 applies to comments that license a behaviour, so the
 * string is asserted absent from the source.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// Same module stubs as the sibling suite: the real @azure/identity and its
// transitive deps are not resolvable in the test store.
vi.mock('@azure/identity', () => ({
  ChainedTokenCredential: class {},
  DefaultAzureCredential: class {},
  ManagedIdentityCredential: class {},
}));
vi.mock('@/lib/azure/aca-managed-identity', () => ({ AcaManagedIdentityCredential: class {} }));
vi.mock('@/lib/azure/fabric-client', () => ({
  FabricError: class extends Error { status: number; constructor(m: string, s = 500) { super(m); this.status = s; } },
  fabricHint: vi.fn(() => 'hint'),
}));
vi.mock('@/lib/azure/fetch-with-timeout', () => ({ fetchWithTimeout: vi.fn() }));
vi.mock('@/lib/azure/eventhubs-client', () => ({
  EventHubsArmError: class extends Error { status: number; constructor(s: number, m?: string) { super(m); this.status = s; } },
}));
vi.mock('@/lib/azure/eventstream-standup', () => {
  class EventstreamConfigGateError extends Error { missing: string; constructor(missing: string) { super('gate'); this.missing = missing; } }
  return {
    EventstreamConfigGateError,
    bundleContentToTopology: vi.fn((content: any) => ({
      sources: content?.sources || [],
      sinks: content?.destinations || content?.sinks || [],
      transforms: content?.transforms || [],
    })),
    standUpEventstreamAzure: vi.fn(),
  };
});

const replace = vi.fn(async () => ({}));
const read = vi.fn(async () => ({ resource: { id: 'es-1', workspaceId: 'w', state: { content: {} } } }));
const itemFn = vi.fn(() => ({ read, replace }));
vi.mock('@/lib/azure/cosmos-client', () => ({
  itemsContainer: vi.fn(async () => ({ item: itemFn })),
}));

import { eventstreamProvisioner } from '../eventstream';
import { standUpEventstreamAzure } from '@/lib/azure/eventstream-standup';

const STANDUP_OK = {
  ehId: '/subscriptions/s/resourceGroups/rg/providers/Microsoft.EventHub/namespaces/ns/eventhubs/orders-stream',
  transportHub: 'orders-stream',
  asaJobId: '/subscriptions/s/resourceGroups/rg/providers/Microsoft.StreamAnalytics/streamingjobs/asa-loom-es-1',
  asaJobName: 'asa-loom-es-1',
  provisionedAt: '2026-08-29T00:00:00.000Z',
  partial: false,
  steps: ['Created Event Hub'],
};

function input(overrides: any = {}) {
  return {
    session: { claims: { oid: 'o' } } as any,
    target: { mode: 'shared', eventBackend: 'eventhubs' },
    cosmosItemId: 'es-1',
    workspaceId: 'w',
    displayName: 'Orders Stream',
    content: { kind: 'eventstream', sources: [{ type: 'eventhub' }], destinations: [{ type: 'kusto' }], transforms: [] },
    appId: 'app-x',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  read.mockResolvedValue({ resource: { id: 'es-1', workspaceId: 'w', state: { content: {} } } });
  replace.mockResolvedValue({});
  (standUpEventstreamAzure as any).mockResolvedValue(STANDUP_OK);
});

/** Run the provisioner with the retry backoff timers driven to completion. */
async function runWithTimers(args: any) {
  const p = eventstreamProvisioner(args);
  // Three attempts, two sleeps. Draining repeatedly is safe and keeps the
  // helper independent of the exact backoff schedule.
  for (let i = 0; i < 8; i++) {
    await Promise.resolve();
    await vi.runAllTimersAsync();
  }
  return p;
}

describe('#3695 — the returned status reflects whether the backend refs landed', () => {
  it('does NOT report a green `created` when the Cosmos write keeps failing', async () => {
    replace.mockRejectedValue(Object.assign(new Error('Request rate is large'), { code: 429, statusCode: 429 }));

    const res = await runWithTimers(input());

    // The whole point: Azure accepted the stand-up, the record did not land, so
    // the status must not be the unconditional 'created' the old code returned.
    expect(res.status).not.toBe('created');
    expect(res.secondaryIds?.refsPersisted).toBe('false');
    // The Event Hub genuinely exists and the receipt says so — it is carried,
    // not discarded, so a retry/triage has the id.
    expect(res.secondaryIds?.ehId).toContain('/eventhubs/orders-stream');
    expect(res.resourceId).toBe('orders-stream');
    // Bounded retry actually ran (3 attempts), rather than one swallowed try.
    expect(replace).toHaveBeenCalledTimes(3);
    expect(res.steps?.some((s) => /could not be written to the eventstream item after 3 attempt/.test(s))).toBe(true);
  });

  it('does NOT report `created` when the item cannot be read back at all', async () => {
    read.mockResolvedValue({ resource: undefined } as any);

    const res = await runWithTimers(input());

    expect(res.status).not.toBe('created');
    expect(res.secondaryIds?.refsPersisted).toBe('false');
    // R7 — the message states what was established (the read returned no
    // document) and never claims a permission or a deletion it did not observe.
    const text = JSON.stringify(res);
    expect(text).toContain('returned no document');
    expect(replace).not.toHaveBeenCalled();
  });

  it('retries a transient write and reports `created` once the record lands', async () => {
    replace
      .mockRejectedValueOnce(new Error('transient'))
      .mockResolvedValue({});

    const res = await runWithTimers(input());

    expect(res.status).toBe('created');
    expect(res.secondaryIds?.refsPersisted).toBe('true');
    expect(replace).toHaveBeenCalledTimes(2);
    const persisted = (replace as any).mock.calls[1][0];
    expect(persisted.state.ehId).toContain('/eventhubs/orders-stream');
    expect(persisted.state.provisionedAt).toBe('2026-08-29T00:00:00.000Z');
  });

  it('still reports `created` on the clean path, with the refs recorded', async () => {
    const res = await runWithTimers(input());

    expect(res.status).toBe('created');
    expect(res.secondaryIds?.refsPersisted).toBe('true');
    expect(replace).toHaveBeenCalledTimes(1);
  });
});

describe('#3695 — the comment that licensed the swallow is gone', () => {
  it('no longer claims the editor re-provisions on open', () => {
    // The route this sentence was about (`app/api/items/eventstream/[id]`)
    // computes azureLive from state.ehId and falls back to 'draft' + a
    // Provision button. Asserting the ABSENCE of the claim is the cheapest
    // durable guard against it being reinstated alongside a new swallow.
    const src = readFileSync(
      path.join(__dirname, '..', 'eventstream.ts'),
      'utf8',
    );
    expect(src).not.toMatch(/editor will re-provision on open/);
  });
});
