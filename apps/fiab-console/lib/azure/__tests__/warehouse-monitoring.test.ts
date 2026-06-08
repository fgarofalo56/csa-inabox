/**
 * Unit tests for the warehouse-monitoring shaping helpers. These cover the
 * chart/table math the Monitoring tab depends on — windowing + carry-forward
 * of the running-clusters line, query-row mapping for both engines, Synapse
 * DMV bucket parsing, and the generated T-SQL — all without a live backend.
 */
import { describe, it, expect } from 'vitest';
import {
  buildClusterTimeline,
  mapDbxQueries,
  buildSynapseTimeline,
  mapSynapseQueries,
  synapseTimelineSql,
  synapseRecentRequestsSql,
} from '../warehouse-monitoring';
import type { WarehouseEvent, DbxQueryHistoryEntry } from '../databricks-client';

const NOW = Date.UTC(2026, 5, 8, 12, 0, 0); // fixed reference

describe('buildClusterTimeline', () => {
  it('drops events older than the window', () => {
    const events: WarehouseEvent[] = [
      { event_type: 'RUNNING', cluster_count: 1, timestamp: NOW - 7200_000 }, // 2h ago — out
      { event_type: 'SCALED_UP', cluster_count: 2, timestamp: NOW - 1800_000 }, // 30m ago — in
    ];
    const points = buildClusterTimeline(events, 3600, NOW);
    expect(points).toHaveLength(1);
    expect(points[0].count).toBe(2);
  });

  it('carries the last cluster_count forward across events that omit it', () => {
    const events: WarehouseEvent[] = [
      { event_type: 'SCALED_UP', cluster_count: 3, timestamp: NOW - 1200_000 },
      { event_type: 'STOPPING', timestamp: NOW - 600_000 }, // no count → carry 3
      { event_type: 'STOPPED', timestamp: NOW - 300_000 }, // pins to 0
    ];
    const points = buildClusterTimeline(events, 3600, NOW);
    expect(points.map((p) => p.count)).toEqual([3, 3, 0]);
  });

  it('sorts ascending by timestamp regardless of input order', () => {
    const events: WarehouseEvent[] = [
      { event_type: 'SCALED_DOWN', cluster_count: 1, timestamp: NOW - 100_000 },
      { event_type: 'SCALED_UP', cluster_count: 4, timestamp: NOW - 500_000 },
    ];
    const points = buildClusterTimeline(events, 3600, NOW);
    expect(points.map((p) => p.ts)).toEqual([NOW - 500_000, NOW - 100_000]);
    expect(points.map((p) => p.count)).toEqual([4, 1]);
  });
});

describe('mapDbxQueries', () => {
  it('maps history entries to uniform rows with ISO submittedAt', () => {
    const entries: DbxQueryHistoryEntry[] = [
      { query_id: 'q1', status: 'FINISHED', query_text: 'SELECT 1', duration: 1234, query_start_time_ms: NOW, user_name: 'a@b.com' },
    ];
    const rows = mapDbxQueries(entries);
    expect(rows[0]).toMatchObject({ id: 'q1', status: 'FINISHED', durationMs: 1234, user: 'a@b.com' });
    expect(rows[0].submittedAt).toBe(new Date(NOW).toISOString());
    expect(rows[0].text).toBe('SELECT 1');
  });

  it('falls back to error_message for text and null for missing duration', () => {
    const rows = mapDbxQueries([{ query_id: 'q2', status: 'FAILED', error_message: 'boom' } as DbxQueryHistoryEntry]);
    expect(rows[0].text).toBe('boom');
    expect(rows[0].durationMs).toBeNull();
    expect(rows[0].submittedAt).toBe('');
  });
});

describe('buildSynapseTimeline', () => {
  it('parses Date + numeric/string counts and sorts ascending', () => {
    const rows = [
      { bucket: new Date(NOW - 300_000), query_count: 5 },
      { bucket: new Date(NOW - 600_000).toISOString(), query_count: '2' },
    ];
    const points = buildSynapseTimeline(rows);
    expect(points.map((p) => p.count)).toEqual([2, 5]);
    expect(points[0].ts).toBeLessThan(points[1].ts);
  });

  it('skips rows with an unparseable bucket', () => {
    const points = buildSynapseTimeline([{ bucket: null, query_count: 9 }]);
    expect(points).toHaveLength(0);
  });
});

describe('mapSynapseQueries', () => {
  it('maps DMV rows to uniform query rows', () => {
    const rows = [
      { request_id: 'QID1', status: 'Running', command: 'SELECT TOP 10 *', total_elapsed_time: 4200, submit_time: new Date(NOW), login_name: 'svc' },
    ];
    const out = mapSynapseQueries(rows);
    expect(out[0]).toMatchObject({ id: 'QID1', status: 'Running', durationMs: 4200, user: 'svc', text: 'SELECT TOP 10 *' });
    expect(out[0].submittedAt).toBe(new Date(NOW).toISOString());
  });
});

describe('synapse T-SQL generators', () => {
  it('clamps the window and targets sys.dm_pdw_exec_requests', () => {
    const sql = synapseTimelineSql(3600);
    expect(sql).toContain('sys.dm_pdw_exec_requests');
    expect(sql).toContain('DATEADD(SECOND, -3600, GETUTCDATE())');
    expect(sql).toContain('GROUP BY');
  });

  it('clamps absurd windows into [60, 86400]', () => {
    expect(synapseTimelineSql(10_000_000)).toContain('-86400,');
    expect(synapseRecentRequestsSql(1)).toContain('-60,');
  });

  it('recent-requests query selects the table columns and orders by submit_time desc', () => {
    const sql = synapseRecentRequestsSql(3600);
    expect(sql).toContain('SELECT TOP 50');
    expect(sql).toContain('request_id');
    expect(sql).toContain('ORDER BY submit_time DESC');
  });
});
