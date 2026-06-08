/**
 * databricks-client — getQueryProfile REST contract test.
 *
 * Real test (per .claude/rules/no-vaporware.md): proves the query-profile path
 * issues the *actual* Databricks Query History single-query REST call with the
 * right URL (include_metrics=true) and returns the live metrics + plan fields —
 * not a stub or mock array. We mock only the two external dependencies the
 * client wraps:
 *   - @azure/identity → fake credential so the module instantiates without AAD.
 *   - global.fetch    → captures the exact request and returns a live-shaped body.
 *
 * Endpoint asserted (Microsoft / Databricks docs):
 *   GET https://<host>/api/2.0/sql/history/queries/{statement_id}?include_metrics=true
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

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

import { getQueryProfile } from '../databricks-client';

const HOST = 'adb-1234567890.7.azuredatabricks.net';

function okResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    text: async () => JSON.stringify(body),
    json: async () => body,
  } as unknown as Response;
}

describe('databricks-client — getQueryProfile', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn(async () => okResponse({}));
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

  it('GETs /api/2.0/sql/history/queries/{id}?include_metrics=true and maps metrics + plan fields', async () => {
    fetchMock.mockResolvedValueOnce(okResponse({
      query_id: '01ef-abc',
      status: 'FINISHED',
      query_text: 'SELECT * FROM t',
      duration: 4200,
      statement_type: 'SELECT',
      spark_ui_url: 'https://adb.example/sparkui/01ef-abc',
      plans_state: 'EXISTS',
      metrics: {
        compilation_time_ms: 120,
        execution_time_ms: 4000,
        photon_total_time_ms: 3600,
        read_bytes: 1_048_576,
        rows_produced_count: 42,
      },
    }));

    const profile = await getQueryProfile('01ef-abc');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`https://${HOST}/api/2.0/sql/history/queries/01ef-abc?include_metrics=true`);
    expect((init?.headers as Record<string, string>).authorization).toBe('Bearer fake-aad-token');

    expect(profile.query_id).toBe('01ef-abc');
    expect(profile.status).toBe('FINISHED');
    expect(profile.spark_ui_url).toBe('https://adb.example/sparkui/01ef-abc');
    expect(profile.plans_state).toBe('EXISTS');
    expect(profile.metrics?.photon_total_time_ms).toBe(3600);
    expect(profile.metrics?.read_bytes).toBe(1_048_576);
  });

  it('unwraps a body nested under `res` (workspace version variance)', async () => {
    fetchMock.mockResolvedValueOnce(okResponse({
      res: { query_id: '02ff-xyz', status: 'FAILED', error_message: 'boom' },
    }));
    const profile = await getQueryProfile('02ff-xyz');
    expect(profile.query_id).toBe('02ff-xyz');
    expect(profile.status).toBe('FAILED');
    expect(profile.error_message).toBe('boom');
  });

  it('throws the real API error when Databricks rejects the lookup', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 403,
      statusText: 'Forbidden',
      text: async () => 'PERMISSION_DENIED: requires CAN MONITOR on the warehouse',
    } as unknown as Response);
    await expect(getQueryProfile('nope')).rejects.toThrow(/getQueryProfile failed 403/);
  });
});
