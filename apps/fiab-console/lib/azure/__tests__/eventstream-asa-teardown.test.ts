/**
 * Leak fix: an eventstream's Stream Analytics job must be found and deleted
 * even when `state.asaJobName` was never recorded (the auto-bind seed path
 * discards the stand-up result), because the name is a pure function of the
 * item id. 526 `asa-loom-<8hex>` jobs were stranded in Created state.
 *
 * Each load-bearing assertion names the input that breaks it:
 *   - "derives the job from item.id" fails if the fallback is removed (no
 *     recorded ref + ASA configured -> deleteStreamingJob never called).
 *   - "does not derive when ASA is unconfigured" fails if the readAsaConfig
 *     guard is removed (an unconfigured deploy would get an error row).
 *   - "recorded ref wins" fails if the fallback overrides the recorded name.
 *   - the name test pins stand-up and teardown to the SAME function: a drifted
 *     slug rule in either changes the expected literal.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const deleteStreamingJob = vi.fn(async (_n: string) => undefined);
const readAsaConfig = vi.fn(() => ({ subscriptionId: 's', resourceGroup: 'rg' }));
const deleteEventHub = vi.fn(async (_n: string) => undefined);

vi.mock('@/lib/azure/stream-analytics-client', () => ({
  deleteStreamingJob: (n: string) => deleteStreamingJob(n),
  readAsaConfig: () => readAsaConfig(),
}));
vi.mock('@/lib/azure/eventhubs-client', () => ({ deleteEventHub: (n: string) => deleteEventHub(n) }));
vi.mock('@/lib/azure/adls-client', () => ({ deletePath: vi.fn() }));
vi.mock('@/lib/azure/synapse-dev-client', () => ({ deleteDedicatedSqlPool: vi.fn(), deletePipeline: vi.fn() }));
vi.mock('@/lib/azure/kusto-arm-client', () => ({ deleteKustoDatabase: vi.fn() }));
vi.mock('@/lib/azure/activator-monitor', () => ({ deleteMonitorActivatorRule: vi.fn() }));
vi.mock('@/lib/azure/adf-client', () => ({ deletePipeline: vi.fn(), deleteAdfCdc: vi.fn() }));
vi.mock('@/lib/azure/databricks-client', () => ({
  deleteUcCatalog: vi.fn(), deleteJob: vi.fn(), deleteWarehouse: vi.fn(), permanentDeleteCluster: vi.fn(),
  deleteWorkspaceObject: vi.fn(), deleteRegisteredModel: vi.fn(), deleteServingEndpoint: vi.fn(),
}));
vi.mock('@/lib/azure/synapse-artifacts-client', () => ({ deleteNotebook: vi.fn() }));
vi.mock('@/lib/azure/search-index-client', () => ({ deleteIndex: vi.fn() }));
vi.mock('@/lib/azure/foundry-client', () => ({ deletePromptFlow: vi.fn() }));
vi.mock('@/lib/azure/synapse-sql-client', () => ({ executeQuery: vi.fn(), serverlessTarget: vi.fn() }));

import { teardownItemBackend } from '../resource-teardown';
import { asaJobNameForItem } from '../asa-job-name';

const ITEM_ID = '3f9a1c2e-aaaa-bbbb-cccc-111122223333';

beforeEach(() => {
  deleteStreamingJob.mockClear();
  deleteEventHub.mockClear();
  readAsaConfig.mockReset();
  readAsaConfig.mockReturnValue({ subscriptionId: 's', resourceGroup: 'rg' });
});

describe('asaJobNameForItem', () => {
  it('is the first 8 id chars, lowercased, slug-safe (stand-up and teardown share it)', () => {
    expect(asaJobNameForItem(ITEM_ID)).toBe('asa-loom-3f9a1c2e');
    expect(asaJobNameForItem('ABCDEF12-x')).toBe('asa-loom-abcdef12');
    // 8 chars are taken BEFORE stripping, so illegal chars shrink the slug.
    // 'ab_cd!ef-123'.slice(0,8) === 'ab_cd!ef' -> 'abcdef' (the '-123' tail is cut first).
    expect(asaJobNameForItem('ab_cd!ef-123')).toBe('asa-loom-abcdef');
  });
});

describe('teardownItemBackend(eventstream) ASA job', () => {
  it('derives the job from item.id when no asaJobName was recorded', async () => {
    const out = await teardownItemBackend(
      { id: ITEM_ID, workspaceId: 'w', itemType: 'eventstream', displayName: 'es', state: { transportHub: 'es-hub' } },
      't',
    );
    expect(deleteStreamingJob).toHaveBeenCalledTimes(1);
    expect(deleteStreamingJob).toHaveBeenCalledWith('asa-loom-3f9a1c2e');
    expect(out.resources.map((r) => `${r.kind}:${r.result}`)).toContain('stream-analytics-job:deleted');
  });

  it('recorded ref wins over the derived name', async () => {
    await teardownItemBackend(
      { id: ITEM_ID, workspaceId: 'w', itemType: 'eventstream', state: { transportHub: 'h', asaJobName: 'asa-loom-recorded' } },
      't',
    );
    expect(deleteStreamingJob).toHaveBeenCalledTimes(1);
    expect(deleteStreamingJob).toHaveBeenCalledWith('asa-loom-recorded');
  });

  it('does not derive when ASA is unconfigured (no error row for a deploy without ASA)', async () => {
    readAsaConfig.mockImplementation(() => { throw new Error('not configured'); });
    const out = await teardownItemBackend(
      { id: ITEM_ID, workspaceId: 'w', itemType: 'eventstream', state: { transportHub: 'h' } },
      't',
    );
    expect(deleteStreamingJob).not.toHaveBeenCalled();
    expect(out.resources.some((r) => r.kind === 'stream-analytics-job')).toBe(false);
    // positive pair: the Event Hub half still ran.
    expect(deleteEventHub).toHaveBeenCalledWith('h');
  });

  it('surfaces a failed ASA delete as an error row (never silent)', async () => {
    deleteStreamingJob.mockRejectedValueOnce(new Error('ASA deleteStreamingJob failed 403'));
    const out = await teardownItemBackend(
      { id: ITEM_ID, workspaceId: 'w', itemType: 'eventstream', state: {} },
      't',
    );
    const row = out.resources.find((r) => r.kind === 'stream-analytics-job');
    expect(row?.result).toBe('error');
    expect(row?.error).toContain('403');
  });
});
