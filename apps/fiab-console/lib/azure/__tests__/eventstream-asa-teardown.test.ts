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

const ITEM_ID = '3f9a1c2e-aaaa-bbbb-cccc-111122223333';
const deleteStreamingJob = vi.fn(async (_n: string) => undefined);
const readAsaConfig = vi.fn(() => ({ subscriptionId: 's', resourceGroup: 'rg' }));
const deleteEventHub = vi.fn(async (_n: string) => undefined);

const getJobTags = vi.fn(async (_n: string): Promise<Record<string, string> | null> => ({ loomItemId: ITEM_ID }));

vi.mock('@/lib/azure/stream-analytics-client', () => ({
  getJobTags: (n: string) => getJobTags(n),
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

beforeEach(() => {
  getJobTags.mockReset();
  getJobTags.mockResolvedValue({ loomItemId: ITEM_ID });
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

/**
 * #5046 finding 3 - a DERIVED job name is only 8 id chars, so the name alone is
 * not proof of ownership. Each case names the input that breaks it:
 *   - tag absent (a pre-tag legacy job)  -> fails if the check is removed (the
 *     job would be deleted blind, which is exactly what we must not do).
 *   - tag names a DIFFERENT item          -> fails if the check only tests for
 *     "a loomItemId tag exists" instead of equality with THIS item's id.
 *   - tag READ fails                      -> fails if an unverifiable job is
 *     deleted anyway, or if the message claims the job is not ours (it states
 *     only that ownership could not be verified).
 *   - job absent (null)                   -> not_found, no delete issued.
 *   - recorded asaJobName                 -> no tag read at all (recorded state
 *     is the proof); fails if a tag lookup were required for recorded jobs.
 */
describe('teardownItemBackend(eventstream) derived-name ownership check', () => {
  const es = (state: Record<string, unknown> = {}) => ({ id: ITEM_ID, workspaceId: 'w', itemType: 'eventstream', state });
  const jobRow = (out: Awaited<ReturnType<typeof teardownItemBackend>>) => out.resources.find((r) => r.kind === 'stream-analytics-job');

  it('deletes the derived job when its loomItemId tag equals THIS item id', async () => {
    const out = await teardownItemBackend(es(), 't');
    expect(getJobTags).toHaveBeenCalledWith('asa-loom-3f9a1c2e');
    expect(deleteStreamingJob).toHaveBeenCalledWith('asa-loom-3f9a1c2e');
    expect(jobRow(out)?.result).toBe('deleted');
  });

  it('SKIPS (does not delete) a derived job that carries no loomItemId tag', async () => {
    getJobTags.mockResolvedValue({});
    const out = await teardownItemBackend(es(), 't');
    expect(deleteStreamingJob).not.toHaveBeenCalled();
    expect(jobRow(out)?.result).toBe('skipped');
    expect(jobRow(out)?.error).toContain('absent');
  });

  it('SKIPS a derived job tagged for a DIFFERENT item (8-char collision)', async () => {
    getJobTags.mockResolvedValue({ loomItemId: '3f9a1c2e-0000-0000-0000-999999999999' });
    const out = await teardownItemBackend(es(), 't');
    expect(deleteStreamingJob).not.toHaveBeenCalled();
    expect(jobRow(out)?.result).toBe('skipped');
    expect(jobRow(out)?.error).toContain('3f9a1c2e-0000-0000-0000-999999999999');
  });

  it('reports an error (and deletes nothing) when the tag read fails, without claiming the job is not ours', async () => {
    getJobTags.mockRejectedValue(new Error('ASA get tags failed 403'));
    const out = await teardownItemBackend(es(), 't');
    expect(deleteStreamingJob).not.toHaveBeenCalled();
    const row = jobRow(out);
    expect(row?.result).toBe('error');
    expect(row?.error).toContain('Could not verify ownership');
    expect(row?.error).toContain('403');
    expect(row?.error).not.toMatch(/not (ours|this item)/i);
  });

  it('is not_found, with no delete issued, when the derived job does not exist', async () => {
    getJobTags.mockResolvedValue(null);
    const out = await teardownItemBackend(es(), 't');
    expect(deleteStreamingJob).not.toHaveBeenCalled();
    expect(jobRow(out)?.result).toBe('not_found');
  });

  it('a RECORDED asaJobName is deleted without any tag lookup', async () => {
    getJobTags.mockResolvedValue({});
    await teardownItemBackend(es({ asaJobName: 'asa-loom-recorded' }), 't');
    expect(getJobTags).not.toHaveBeenCalled();
    expect(deleteStreamingJob).toHaveBeenCalledWith('asa-loom-recorded');
  });
});
