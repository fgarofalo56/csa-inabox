/**
 * databricks-client — edit / scale REST contract test.
 *
 * Real test (per .claude/rules/no-vaporware.md): proves the Cluster EDIT and
 * SQL Warehouse EDIT/scale paths issue the *actual* Databricks REST calls with
 * the right method, URL, and body — not a stub or a mock array. We mock only
 * the two external dependencies the client wraps:
 *   - @azure/identity   → a fake credential whose getToken() returns a token,
 *                         so the module instantiates without real AAD.
 *   - global.fetch      → captures the exact request the client makes.
 *
 * Assertions are against the live endpoints documented on Microsoft Learn:
 *   - Cluster edit   : POST https://<host>/api/2.0/clusters/edit
 *   - Warehouse edit : POST https://<host>/api/2.0/sql/warehouses/{id}/edit
 *     (preceded by a GET to read name + warehouse_type the edit endpoint
 *      requires even when unchanged).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Pin the hostname BEFORE importing the client (host() reads it lazily, but the
// credential is built at import time).
process.env.LOOM_DATABRICKS_HOSTNAME = 'adb-1234567890.7.azuredatabricks.net';

vi.mock('@azure/identity', () => {
  class FakeCred {
    async getToken() {
      return { token: 'fake-aad-token', expiresOnTimestamp: Date.now() + 3_600_000 };
    }
  }
  return {
    DefaultAzureCredential: FakeCred,
    ManagedIdentityCredential: FakeCred,
    ChainedTokenCredential: FakeCred,
  };
});

import { editCluster, editWarehouse, type ClusterSpec } from '../databricks-client';

const HOST = 'adb-1234567890.7.azuredatabricks.net';

function okResponse(body: unknown = {}): Response {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    text: async () => JSON.stringify(body),
    json: async () => body,
  } as unknown as Response;
}

describe('databricks-client — Cluster EDIT', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn(async () => okResponse({}));
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

  it('POSTs /api/2.0/clusters/edit with cluster_id + full spec', async () => {
    const spec: ClusterSpec = {
      cluster_name: 'etl-prod',
      spark_version: '15.4.x-scala2.12',
      node_type_id: 'Standard_DS4_v2',
      autoscale: { min_workers: 2, max_workers: 8 },
      autotermination_minutes: 45,
    };
    await editCluster('0101-clusterid', spec);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`https://${HOST}/api/2.0/clusters/edit`);
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer fake-aad-token');
    const sent = JSON.parse(init.body as string);
    // cluster_id MUST be in the body, alongside the edited spec fields.
    expect(sent.cluster_id).toBe('0101-clusterid');
    expect(sent.cluster_name).toBe('etl-prod');
    expect(sent.node_type_id).toBe('Standard_DS4_v2');
    expect(sent.spark_version).toBe('15.4.x-scala2.12');
    expect(sent.autoscale).toEqual({ min_workers: 2, max_workers: 8 });
    expect(sent.autotermination_minutes).toBe(45);
  });

  it('throws the real API error when Databricks rejects the edit (INVALID_STATE)', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 400,
      statusText: 'Bad Request',
      text: async () => JSON.stringify({ error_code: 'INVALID_STATE', message: 'Clusters in state PENDING cannot be edited.' }),
    } as unknown as Response);
    await expect(editCluster('0101-clusterid', {
      cluster_name: 'x', spark_version: 'v', node_type_id: 'n',
    } as ClusterSpec)).rejects.toThrow(/editCluster failed 400/);
  });
});

describe('databricks-client — SQL Warehouse EDIT / scale', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    // First call = GET the existing warehouse (to preserve name + type);
    // second call = POST the edit. Default both to ok; the test overrides
    // the GET body so name/type are preserved.
    fetchMock = vi.fn(async () => okResponse({}));
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

  it('reads the warehouse then POSTs /api/2.0/sql/warehouses/{id}/edit with size + scaling', async () => {
    // 1) getWarehouse → existing config (name + warehouse_type preserved)
    fetchMock.mockResolvedValueOnce(okResponse({
      id: 'wh123', name: 'analytics-wh', state: 'RUNNING',
      cluster_size: 'X-Small', warehouse_type: 'PRO',
    }));
    // 2) edit → 200
    fetchMock.mockResolvedValueOnce(okResponse({}));

    await editWarehouse('wh123', {
      cluster_size: 'Large',
      min_num_clusters: 1,
      max_num_clusters: 4,
      auto_stop_mins: 20,
      enable_serverless_compute: true,
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);

    // GET first
    const [getUrl, getInit] = fetchMock.mock.calls[0];
    expect(getUrl).toBe(`https://${HOST}/api/2.0/sql/warehouses/wh123`);
    expect(getInit?.method ?? 'GET').toBe('GET');

    // POST edit second — exact endpoint + body
    const [editUrl, editInit] = fetchMock.mock.calls[1];
    expect(editUrl).toBe(`https://${HOST}/api/2.0/sql/warehouses/wh123/edit`);
    expect(editInit.method).toBe('POST');
    expect((editInit.headers as Record<string, string>).authorization).toBe('Bearer fake-aad-token');
    const sent = JSON.parse(editInit.body as string);
    // name + warehouse_type preserved from the GET; new scaling applied.
    expect(sent.name).toBe('analytics-wh');
    expect(sent.warehouse_type).toBe('PRO');
    expect(sent.cluster_size).toBe('Large');
    expect(sent.min_num_clusters).toBe(1);
    expect(sent.max_num_clusters).toBe(4);
    expect(sent.auto_stop_mins).toBe(20);
    expect(sent.enable_serverless_compute).toBe(true);
  });

  it('surfaces the real API error when the edit endpoint rejects the size', async () => {
    fetchMock.mockResolvedValueOnce(okResponse({
      id: 'wh123', name: 'analytics-wh', state: 'RUNNING', cluster_size: 'X-Small', warehouse_type: 'PRO',
    }));
    fetchMock.mockResolvedValueOnce({
      ok: false, status: 400, statusText: 'Bad Request',
      text: async () => 'INVALID_PARAMETER_VALUE: cluster_size is invalid',
    } as unknown as Response);

    await expect(editWarehouse('wh123', { cluster_size: 'Nope' }))
      .rejects.toThrow(/editWarehouse failed 400/);
  });
});
