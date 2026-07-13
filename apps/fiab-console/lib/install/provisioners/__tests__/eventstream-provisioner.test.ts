/**
 * Install-time provisioner tests for the Azure-native Eventstream backend.
 *
 * The provisioner delegates the real stand-up to standUpEventstreamAzure() (the
 * SAME shared code path the editor's Provision-to-Azure button uses) and then
 * persists the returned backend refs onto the Cosmos item so the editor opens
 * 'live', not 'draft'. Here the shared stand-up + Cosmos are mocked; the tests
 * pin the provisioner contract:
 *   - deploy path → status 'created', ehId/asaJobName persisted + in secondaryIds
 *   - honest gate ONLY when Event Hubs namespace is genuinely unset (named)
 *   - Fabric backend opt-in with no bound workspace → falls back to Event Hubs
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Top-level imports that pull in @azure/identity must be mocked so the module
// loads under vitest (the shared pnpm store can't resolve identity in-test).
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
import { standUpEventstreamAzure, EventstreamConfigGateError } from '@/lib/azure/eventstream-standup';

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
  read.mockResolvedValue({ resource: { id: 'es-1', workspaceId: 'w', state: { content: {} } } });
  replace.mockResolvedValue({});
});

describe('eventstreamProvisioner (Azure-native Event Hubs default)', () => {
  it('stands up the backend and persists ehId/asaJobName onto the item', async () => {
    (standUpEventstreamAzure as any).mockResolvedValue({
      ehId: '/subscriptions/s/.../eventhubs/orders-stream',
      transportHub: 'orders-stream',
      asaJobId: '/subscriptions/s/.../streamingjobs/asa-loom-es-1',
      asaJobName: 'asa-loom-es-1',
      provisionedAt: '2026-07-13T00:00:00.000Z',
      partial: false,
      steps: ['Created Event Hub'],
    });

    const res = await eventstreamProvisioner(input());
    expect(res.status).toBe('created');
    expect(res.resourceId).toBe('orders-stream');
    expect(res.secondaryIds?.ehId).toContain('/eventhubs/orders-stream');
    expect(res.secondaryIds?.asaJobName).toBe('asa-loom-es-1');

    // Persisted the refs onto the Cosmos item so the editor opens live.
    expect(replace).toHaveBeenCalledTimes(1);
    const persisted = (replace as any).mock.calls[0][0];
    expect(persisted.state.ehId).toContain('/eventhubs/orders-stream');
    expect(persisted.state.provisionedAt).toBe('2026-07-13T00:00:00.000Z');
    expect(persisted.state.asaJobName).toBe('asa-loom-es-1');
  });

  it('honest gate ONLY when Event Hubs namespace is unset (names the exact env)', async () => {
    (standUpEventstreamAzure as any).mockRejectedValue(new (EventstreamConfigGateError as any)('LOOM_EVENTHUB_NAMESPACE'));
    const res = await eventstreamProvisioner(input());
    expect(res.status).toBe('remediation');
    expect(res.gate?.remediation).toContain('LOOM_EVENTHUB_NAMESPACE');
    expect(res.gate?.remediation).toContain('No Microsoft Fabric');
    expect(replace).not.toHaveBeenCalled();
  });

  it('Fabric backend selected but no workspace bound → falls back to Event Hubs stand-up', async () => {
    (standUpEventstreamAzure as any).mockResolvedValue({
      ehId: '/subscriptions/s/.../eventhubs/orders-stream', transportHub: 'orders-stream',
      asaJobId: null, asaJobName: null, provisionedAt: '2026-07-13T00:00:00.000Z', partial: false, steps: [],
    });
    const res = await eventstreamProvisioner(input({ target: { mode: 'shared', eventBackend: 'fabric', fabricWorkspaceId: undefined } }));
    expect(res.status).toBe('created');
    expect(standUpEventstreamAzure).toHaveBeenCalledTimes(1);
    expect(res.steps?.some((s) => /falling back to the Azure-native Event Hubs/.test(s))).toBe(true);
  });
});
