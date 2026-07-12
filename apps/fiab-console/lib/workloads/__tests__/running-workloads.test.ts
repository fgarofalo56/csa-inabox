import { describe, it, expect } from 'vitest';
import {
  collectRunningNotebooks,
  matchRunningPipelines,
  isPipelineRunActive,
  itemHref,
  orderWorkloads,
  type NotebookRunItem,
  type PipelineBindItem,
  type AdfRunLite,
} from '../running-workloads';

describe('running-workloads classifier', () => {
  describe('collectRunningNotebooks', () => {
    it('emits one workload per notebook with a live pending run (earliest start)', () => {
      const items: NotebookRunItem[] = [{
        id: 'nb1', workspaceId: 'ws1', itemType: 'notebook', displayName: 'ETL Notebook',
        pendingRuns: {
          'spark:pool:9': { startedAt: '2026-07-12T10:05:00Z' },
          'spark:pool:8': { startedAt: '2026-07-12T10:00:00Z' },
        },
      }];
      const out = collectRunningNotebooks(items);
      expect(out).toHaveLength(1);
      expect(out[0]).toMatchObject({
        itemId: 'nb1', workspaceId: 'ws1', kind: 'notebook',
        status: 'running', runId: 'spark:pool:8', startedAt: '2026-07-12T10:00:00Z',
        href: '/items/notebook/nb1',
      });
    });

    it('skips notebooks with an empty pendingRuns map', () => {
      const items: NotebookRunItem[] = [{ id: 'nb1', workspaceId: 'ws1', pendingRuns: {} }];
      expect(collectRunningNotebooks(items)).toHaveLength(0);
    });

    it('ignores zombie pending runs older than the staleness cutoff', () => {
      const items: NotebookRunItem[] = [{
        id: 'nb1', workspaceId: 'ws1',
        pendingRuns: { 'spark:pool:1': { startedAt: '2020-01-01T00:00:00Z' } },
      }];
      const cutoff = '2026-07-12T00:00:00Z';
      expect(collectRunningNotebooks(items, cutoff)).toHaveLength(0);
    });

    it('keeps a fresh run even when a stale one is present', () => {
      const items: NotebookRunItem[] = [{
        id: 'nb1', workspaceId: 'ws1',
        pendingRuns: {
          'spark:pool:old': { startedAt: '2020-01-01T00:00:00Z' },
          'spark:pool:new': { startedAt: '2026-07-12T10:00:00Z' },
        },
      }];
      const out = collectRunningNotebooks(items, '2026-07-12T00:00:00Z');
      expect(out).toHaveLength(1);
      expect(out[0].runId).toBe('spark:pool:new');
    });

    it('tolerates null/malformed entries', () => {
      const items = [
        null as any,
        { id: '', workspaceId: 'ws1', pendingRuns: { r: { startedAt: 'x' } } },
        { id: 'nb2', workspaceId: 'ws2', pendingRuns: { r: null } as any },
      ];
      expect(collectRunningNotebooks(items)).toHaveLength(0);
    });
  });

  describe('isPipelineRunActive', () => {
    it('treats Queued/InProgress/Cancelling as active', () => {
      expect(isPipelineRunActive('Queued')).toBe(true);
      expect(isPipelineRunActive('InProgress')).toBe(true);
      expect(isPipelineRunActive('Cancelling')).toBe(true);
    });
    it('treats terminal + unknown states as inactive', () => {
      expect(isPipelineRunActive('Succeeded')).toBe(false);
      expect(isPipelineRunActive('Failed')).toBe(false);
      expect(isPipelineRunActive('Cancelled')).toBe(false);
      expect(isPipelineRunActive(undefined)).toBe(false);
    });
  });

  describe('matchRunningPipelines', () => {
    const items: PipelineBindItem[] = [
      { id: 'p1', workspaceId: 'ws1', itemType: 'data-pipeline', displayName: 'Bronze load', adfPipelineName: 'adf_bronze' },
      { id: 'p2', workspaceId: 'ws1', itemType: 'adf-pipeline', displayName: 'Silver load', pipelineName: 'adf_silver' },
    ];

    it('matches only ACTIVE ADF runs back to their owning Loom item', () => {
      const runs: AdfRunLite[] = [
        { runId: 'r1', pipelineName: 'adf_bronze', status: 'InProgress', runStart: '2026-07-12T10:00:00Z' },
        { runId: 'r2', pipelineName: 'adf_silver', status: 'Succeeded' }, // terminal → skip
        { runId: 'r3', pipelineName: 'unbound_pipe', status: 'InProgress' }, // no owning item → skip
      ];
      const out = matchRunningPipelines(items, runs);
      expect(out).toHaveLength(1);
      expect(out[0]).toMatchObject({
        itemId: 'p1', kind: 'pipeline', runId: 'r1', status: 'InProgress',
        itemType: 'data-pipeline', href: '/items/data-pipeline/p1',
      });
    });

    it('surfaces multiple concurrent runs of the same pipeline as distinct rows', () => {
      const runs: AdfRunLite[] = [
        { runId: 'r1', pipelineName: 'adf_bronze', status: 'InProgress' },
        { runId: 'r2', pipelineName: 'adf_bronze', status: 'Queued' },
      ];
      const out = matchRunningPipelines(items, runs);
      expect(out.map((w) => w.runId).sort()).toEqual(['r1', 'r2']);
    });

    it('returns nothing when there are no bound pipeline items', () => {
      expect(matchRunningPipelines([], [{ runId: 'r1', pipelineName: 'x', status: 'InProgress' }])).toHaveLength(0);
    });
  });

  describe('itemHref + orderWorkloads', () => {
    it('builds an encoded editor deep link', () => {
      expect(itemHref('notebook', 'a b')).toBe('/items/notebook/a%20b');
    });

    it('orders most-recently-started first, undated last', () => {
      const ordered = orderWorkloads([
        { workspaceId: 'w', itemId: 'a', itemType: 'notebook', displayName: 'A', kind: 'notebook', runId: '1', status: 'running', startedAt: '2026-07-12T10:00:00Z', href: '' },
        { workspaceId: 'w', itemId: 'b', itemType: 'notebook', displayName: 'B', kind: 'notebook', runId: '2', status: 'running', startedAt: '2026-07-12T11:00:00Z', href: '' },
        { workspaceId: 'w', itemId: 'c', itemType: 'data-pipeline', displayName: 'C', kind: 'pipeline', runId: '3', status: 'InProgress', href: '' },
      ]);
      expect(ordered.map((w) => w.itemId)).toEqual(['b', 'a', 'c']);
    });
  });
});
