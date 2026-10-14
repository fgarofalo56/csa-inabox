/**
 * databricks-estate-client - the workspace data-plane calls the estate
 * Pause/Resume uses. Each test names the input that would break it.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const getToken = vi.fn();
vi.mock('@/lib/azure/aca-managed-identity', () => ({
  loomServerCredential: { getToken: (...a: unknown[]) => getToken(...a) },
}));
const fetchWithTimeout = vi.fn();
vi.mock('@/lib/azure/fetch-with-timeout', () => ({
  fetchWithTimeout: (...a: unknown[]) => fetchWithTimeout(...a),
}));

import {
  assertDatabricksHost,
  getCluster,
  getWarehouse,
  listUserClusters,
  listWarehouses,
  startCluster,
  startWarehouse,
  stopWarehouse,
  terminateCluster,
} from '../databricks-estate-client';

const COM = 'adb-123.4.azuredatabricks.net';
const GOV = 'adb-9.2.databricks.azure.us';

function reply(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, text: async () => (body === undefined ? '' : JSON.stringify(body)) };
}

beforeEach(() => {
  vi.resetAllMocks();
  getToken.mockResolvedValue({ token: 'tok' });
  fetchWithTimeout.mockResolvedValue(reply(200, {}));
  process.env.LOOM_DATABRICKS_HOSTNAME = 'adb-FROM-ENV.4.azuredatabricks.net';
});

describe('assertDatabricksHost', () => {
  // Breaks if: the suffix check is dropped or loosened to includes() - the evil rows would pass.
  it.each([
    ['evil.example.com'],
    ['azuredatabricks.net'], // bare suffix, no workspace label
    ['adb-1.azuredatabricks.net.evil.com'], // suffix not at the end
    ['adb-1.azuredatabricks.net/path'],
    ['https://adb-1.azuredatabricks.net'],
    ['user@adb-1.azuredatabricks.net'],
    [''],
    [undefined],
  ])('refuses %s', (raw) => {
    expect(() => assertDatabricksHost(raw)).toThrow();
  });

  // Breaks if: Gov or Commercial hosts are rejected (cloud parity), or case is not normalised.
  it('accepts Commercial, Gov and China workspace hosts, lower-cased', () => {
    expect(assertDatabricksHost(COM)).toBe(COM);
    expect(assertDatabricksHost(GOV)).toBe(GOV);
    expect(assertDatabricksHost('ADB-5.6.databricks.azure.cn')).toBe('adb-5.6.databricks.azure.cn');
  });
});

describe('calls address the EXPLICIT host, never the env one', () => {
  // Breaks if: any function falls back to LOOM_DATABRICKS_HOSTNAME (set to a different host in beforeEach).
  it('every verb hits the host it was given', async () => {
    await listWarehouses(GOV);
    await listUserClusters(GOV);
    await getWarehouse(GOV, 'w1');
    await getCluster(GOV, 'c1');
    await stopWarehouse(GOV, 'w1');
    await startWarehouse(GOV, 'w1');
    await terminateCluster(GOV, 'c1');
    await startCluster(GOV, 'c1');
    const urls = fetchWithTimeout.mock.calls.map((c) => String(c[0]));
    expect(urls).toHaveLength(8);
    for (const u of urls) {
      expect(u.startsWith(`https://${GOV}/`)).toBe(true);
      expect(u).not.toContain('FROM-ENV');
    }
  });

  // Breaks if: the wrong endpoint is used (e.g. permanent-delete for terminate).
  it('uses the documented stop/start/terminate endpoints; terminate is clusters/delete, never permanent-delete', async () => {
    await stopWarehouse(COM, 'w 1');
    await startWarehouse(COM, 'w1');
    await terminateCluster(COM, 'c1');
    await startCluster(COM, 'c1');
    const calls = fetchWithTimeout.mock.calls.map((c) => [String(c[0]).replace(`https://${COM}`, ''), (c[1] as any).method, (c[1] as any).body]);
    expect(calls).toEqual([
      ['/api/2.0/sql/warehouses/w%201/stop', 'POST', '{}'],
      ['/api/2.0/sql/warehouses/w1/start', 'POST', '{}'],
      ['/api/2.0/clusters/delete', 'POST', '{"cluster_id":"c1"}'],
      ['/api/2.0/clusters/start', 'POST', '{"cluster_id":"c1"}'],
    ]);
    expect(calls.some((c) => String(c[0]).includes('permanent'))).toBe(false);
  });

  // Breaks if: the bearer token is not sent or is minted for the wrong audience.
  it('sends a bearer token minted for the Azure Databricks application id', async () => {
    await listWarehouses(COM);
    expect(getToken).toHaveBeenCalledWith('2ff814a6-3304-4ab8-85cb-cd0e6f879c1d/.default');
    expect((fetchWithTimeout.mock.calls[0][1] as any).headers.authorization).toBe('Bearer tok');
  });

  // Breaks if: a bad host still reaches fetch (the token would be sent to it).
  it('a non-Databricks host throws BEFORE any token is minted or request sent', async () => {
    await expect(listWarehouses('evil.example.com')).rejects.toThrow(/known Azure Databricks domain/);
    expect(getToken).not.toHaveBeenCalled();
    expect(fetchWithTimeout).not.toHaveBeenCalled();
  });
});

describe('normalisation', () => {
  // Breaks if: job/pipeline clusters are returned (they would be terminated under their run).
  it('listUserClusters keeps only UI/API clusters and records autotermination', async () => {
    fetchWithTimeout.mockResolvedValue(reply(200, {
      clusters: [
        { cluster_id: 'a', cluster_name: 'adhoc', state: 'RUNNING', cluster_source: 'UI', autotermination_minutes: 30 },
        { cluster_id: 'j', cluster_name: 'job-run', state: 'RUNNING', cluster_source: 'JOB' },
        { cluster_id: 'p', cluster_name: 'dlt', state: 'RUNNING', cluster_source: 'PIPELINE' },
        { cluster_id: 'x', cluster_name: 'api', state: 'terminated', cluster_source: 'API' },
      ],
    }));
    const cs = await listUserClusters(COM);
    expect(cs.map((c) => c.id)).toEqual(['a', 'x']);
    expect(cs[0]).toEqual({ kind: 'cluster', id: 'a', name: 'adhoc', state: 'RUNNING', autoStopMins: 30 });
    expect(cs[1].state).toBe('TERMINATED');
  });

  // Breaks if: auto_stop_mins is dropped (the pre-pause configuration could not be recorded).
  it('listWarehouses records state and auto_stop_mins', async () => {
    fetchWithTimeout.mockResolvedValue(reply(200, { warehouses: [{ id: 'w1', name: 'loom-default', state: 'RUNNING', auto_stop_mins: 10 }] }));
    expect(await listWarehouses(COM)).toEqual([{ kind: 'sql-warehouse', id: 'w1', name: 'loom-default', state: 'RUNNING', autoStopMins: 10 }]);
  });

  // Breaks if: an HTTP error is swallowed into an empty list / success.
  it('a 403 throws with the status, the body, and the remediation', async () => {
    fetchWithTimeout.mockResolvedValue(reply(403, { message: 'denied' }));
    await expect(stopWarehouse(COM, 'w1')).rejects.toThrow(/failed 403.*denied.*CAN MANAGE/s);
  });
});
