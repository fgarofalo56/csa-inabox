/**
 * databricks-client — SQL Warehouse CREATE / DELETE REST contract test.
 *
 * Real test (per .claude/rules/no-vaporware.md): proves createWarehouse and
 * deleteWarehouse issue the *actual* Databricks REST calls with the right
 * method, URL, and body — advanced options (enable_photon / channel / tags /
 * spot_instance_policy / serverless) threaded through, not a stub. We mock only:
 *   - @azure/identity → fake credential (module instantiates without real AAD)
 *   - global.fetch    → captures the exact request the client makes.
 *
 * Endpoints (Microsoft Learn `workspaces/warehouses`):
 *   - Create : POST   https://<host>/api/2.0/sql/warehouses
 *   - Delete : DELETE https://<host>/api/2.0/sql/warehouses/{id}
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

process.env.LOOM_DATABRICKS_HOSTNAME = 'adb-1234567890.7.azuredatabricks.net';

vi.mock('@azure/identity', () => {
  class FakeCred {
    async getToken() {
      return { token: 'fake-aad-token', expiresOnTimestamp: Date.now() + 3_600_000 };
    }
  }
  return { DefaultAzureCredential: FakeCred, ManagedIdentityCredential: FakeCred, ChainedTokenCredential: FakeCred };
});

import { createWarehouse, deleteWarehouse } from '../databricks-client';

const HOST = 'adb-1234567890.7.azuredatabricks.net';

function okResponse(body: unknown = {}): Response {
  return {
    ok: true, status: 200, statusText: 'OK',
    text: async () => JSON.stringify(body),
    json: async () => body,
  } as unknown as Response;
}

describe('databricks-client — createWarehouse', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => { fetchMock = vi.fn(async () => okResponse({ id: 'wh-new-1' })); vi.stubGlobal('fetch', fetchMock); });
  afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

  it('POSTs /api/2.0/sql/warehouses with advanced options and returns the new id', async () => {
    const out = await createWarehouse({
      name: 'loom-test-wh',
      cluster_size: 'Small',
      warehouse_type: 'PRO',
      min_num_clusters: 1,
      max_num_clusters: 2,
      auto_stop_mins: 10,
      enable_photon: true,
      channel: { name: 'CHANNEL_NAME_CURRENT' },
      tags: { custom_tags: [{ key: 'team', value: 'analytics' }] },
      spot_instance_policy: 'COST_OPTIMIZED',
    });
    expect(out.id).toBe('wh-new-1');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`https://${HOST}/api/2.0/sql/warehouses`);
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer fake-aad-token');
    const sent = JSON.parse(init.body as string);
    expect(sent.name).toBe('loom-test-wh');
    expect(sent.cluster_size).toBe('Small');
    expect(sent.warehouse_type).toBe('PRO');
    expect(sent.enable_photon).toBe(true);
    expect(sent.channel).toEqual({ name: 'CHANNEL_NAME_CURRENT' });
    expect(sent.tags).toEqual({ custom_tags: [{ key: 'team', value: 'analytics' }] });
    expect(sent.spot_instance_policy).toBe('COST_OPTIMIZED');
  });

  it('threads enable_serverless_compute=true with warehouse_type PRO', async () => {
    await createWarehouse({ name: 'srvless', warehouse_type: 'PRO', enable_serverless_compute: true });
    const sent = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(sent.enable_serverless_compute).toBe(true);
    expect(sent.warehouse_type).toBe('PRO');
  });

  it('omits advanced options that were not supplied', async () => {
    await createWarehouse({ name: 'minimal' });
    const sent = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(sent.name).toBe('minimal');
    expect('enable_photon' in sent).toBe(false);
    expect('channel' in sent).toBe(false);
    expect('tags' in sent).toBe(false);
    expect('spot_instance_policy' in sent).toBe(false);
  });

  it('surfaces the real API error verbatim when create is rejected', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false, status: 400, statusText: 'Bad Request',
      text: async () => JSON.stringify({ error_code: 'INVALID_PARAMETER_VALUE', message: 'cluster_size is invalid' }),
    } as unknown as Response);
    await expect(createWarehouse({ name: 'bad', cluster_size: 'Nope' }))
      .rejects.toThrow(/createWarehouse failed 400/);
  });
});

describe('databricks-client — deleteWarehouse', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => { fetchMock = vi.fn(async () => okResponse({})); vi.stubGlobal('fetch', fetchMock); });
  afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

  it('issues DELETE /api/2.0/sql/warehouses/{id} with the auth header', async () => {
    await deleteWarehouse('wh-new-1');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`https://${HOST}/api/2.0/sql/warehouses/wh-new-1`);
    expect(init.method).toBe('DELETE');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer fake-aad-token');
  });

  it('surfaces the real API error verbatim when delete is rejected', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false, status: 400, statusText: 'Bad Request',
      text: async () => 'RESOURCE_DOES_NOT_EXIST: no such warehouse',
    } as unknown as Response);
    await expect(deleteWarehouse('missing')).rejects.toThrow(/deleteWarehouse failed 400/);
  });
});
