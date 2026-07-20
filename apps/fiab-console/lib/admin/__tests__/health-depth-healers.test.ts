/**
 * W-B healer tests — the two new runtime-safe fixes (task #21):
 *   ensure-eventhub-consumer-group, ensure-adx-default-db.
 * Proves: dry-run is demonstrable (no I/O), a real apply calls the idempotent
 * createIfNotExists client fns (payload-asserted), and a 401/403 is reported as
 * NOT runtime-fixable. Mock boundary = the Azure client modules (the network edge).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const ehMock = {
  eventhubsConfigGate: vi.fn(() => null as { missing: string } | null),
  readEventHubsConfig: vi.fn(() => ({ namespace: 'ns', sub: 's', rg: 'rg' } as any)),
  ensureEventHub: vi.fn(async (_cfg: any, spec: any) => ({ name: spec.name })),
  ensureConsumerGroup: vi.fn(async (_cfg: any, hub: string, name: string) => ({ name, eventHub: hub })),
};
vi.mock('@/lib/azure/eventhubs-client', () => ehMock);

const kustoMock = {
  defaultDatabase: vi.fn(() => 'loomdb-default'),
  createDatabase: vi.fn(async (_name: string) => ({ provisioningState: 'Succeeded', id: '/db/loomdb-default' })),
};
vi.mock('@/lib/azure/kusto-client', () => kustoMock);

import { applyFix } from '../self-audit';

describe('W-B healers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ehMock.eventhubsConfigGate.mockReturnValue(null);
    process.env.LOOM_KUSTO_CLUSTER_URI = 'https://adx.example.kusto.windows.net';
    delete process.env.LOOM_EVENTHUB_DEFAULT_HUB;
    delete process.env.LOOM_EVENTSTREAM_HUB;
  });

  it('dry-run describes ensure-eventhub-consumer-group without any I/O', async () => {
    const r = await applyFix('ensure-eventhub-consumer-group', { dryRun: true });
    expect(r.ok).toBe(true); expect(r.dryRun).toBe(true);
    expect(r.detail).toMatch(/consumer group/i);
    expect(ehMock.ensureConsumerGroup).not.toHaveBeenCalled();
  });

  it('dry-run describes ensure-adx-default-db without any I/O', async () => {
    const r = await applyFix('ensure-adx-default-db', { dryRun: true });
    expect(r.ok).toBe(true); expect(r.dryRun).toBe(true);
    expect(r.detail).toMatch(/database/i);
    expect(kustoMock.createDatabase).not.toHaveBeenCalled();
  });

  it('apply ensure-eventhub-consumer-group ensures the hub + group (idempotent)', async () => {
    const r = await applyFix('ensure-eventhub-consumer-group');
    expect(r.ok).toBe(true);
    expect(ehMock.ensureEventHub).toHaveBeenCalledTimes(1);
    expect(ehMock.ensureConsumerGroup).toHaveBeenCalledTimes(1);
    const [, hub, group] = ehMock.ensureConsumerGroup.mock.calls[0];
    expect(hub).toBe('loom-eventstream');
    expect(group).toBe('loom');
  });

  it('ensure-eventhub-consumer-group gates (not runtime-fixable) when EH env is unset', async () => {
    ehMock.eventhubsConfigGate.mockReturnValue({ missing: 'LOOM_EVENTHUB_NAMESPACE' });
    const r = await applyFix('ensure-eventhub-consumer-group');
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/not runtime-fixable/i);
    expect(ehMock.ensureEventHub).not.toHaveBeenCalled();
  });

  it('apply ensure-adx-default-db creates the default database (idempotent)', async () => {
    const r = await applyFix('ensure-adx-default-db');
    expect(r.ok).toBe(true);
    expect(kustoMock.createDatabase).toHaveBeenCalledWith('loomdb-default');
    expect(r.detail).toMatch(/loomdb-default/);
  });

  it('ensure-adx-default-db reports a 403 as NOT runtime-fixable', async () => {
    kustoMock.createDatabase.mockRejectedValueOnce(new Error('403 Forbidden'));
    const r = await applyFix('ensure-adx-default-db');
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/not runtime-fixable/i);
  });
});
