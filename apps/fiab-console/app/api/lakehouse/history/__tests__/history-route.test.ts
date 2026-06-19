/**
 * Backend contract tests for /api/lakehouse/history — Delta time travel (F20).
 *
 * GET (version list, ADLS _delta_log):
 *   1. unauthenticated → 401
 *   2. missing params → 400
 *   3. unknown container → 404
 *   4. path traversal rejected → 400
 *   5. happy path parses commitInfo from _delta_log/*.json → sorted versions
 *
 * POST (restore / preview, Databricks):
 *   6. unauthenticated → 401
 *   7. bad action → 400
 *   8. negative/non-int version → 400
 *   9. honest gate (LOOM_DATABRICKS_HOSTNAME unset) → 503 + named env var
 *  10. no warehouse → 503 gated
 *  11. preview happy path runs SELECT … VERSION AS OF and returns rows
 *  12. restore happy path runs RESTORE TABLE … TO VERSION AS OF
 *  13. backend throw → 502 structured error
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@/lib/auth/session', () => ({ getSession: vi.fn() }));
vi.mock('@/lib/azure/adls-client', async () => {
  const actual: any = await vi.importActual('@/lib/azure/adls-client');
  return {
    ...actual,
    listPaths: vi.fn(),
    downloadFile: vi.fn(),
    getAccountName: vi.fn(() => 'loomdlz'),
  };
});
vi.mock('@/lib/azure/databricks-client', async () => {
  const actual: any = await vi.importActual('@/lib/azure/databricks-client');
  return {
    ...actual,
    databricksConfigGate: vi.fn(),
    listWarehouses: vi.fn(),
    executeStatement: vi.fn(),
  };
});

import { GET, POST } from '../route';
import { getSession } from '@/lib/auth/session';
import { listPaths, downloadFile, getAccountName } from '@/lib/azure/adls-client';
import { databricksConfigGate, listWarehouses, executeStatement } from '@/lib/azure/databricks-client';

function getReq(params: Record<string, string>) {
  const sp = new URLSearchParams(params);
  return { nextUrl: { searchParams: sp } } as any;
}
function postReq(body: any) {
  return { json: async () => body } as any;
}

beforeEach(() => {
  vi.resetAllMocks();
  // vi.resetAllMocks() clears the factory's getAccountName implementation
  // (() => 'loomdlz'), leaving it returning undefined — which would make the
  // route build an `abfss://…@undefined.dfs…` path. Re-assert it each test so
  // the ADLS account resolves to the expected DLZ account name.
  (getAccountName as any).mockReturnValue('loomdlz');
});
afterEach(() => {
  delete process.env.LOOM_DATABRICKS_HOSTNAME;
});

describe('GET /api/lakehouse/history', () => {
  it('401 when no session', async () => {
    (getSession as any).mockReturnValue(null);
    const res = await GET(getReq({ container: 'bronze', tablePath: 'Tables/x' }));
    expect(res.status).toBe(401);
  });

  it('400 when params missing', async () => {
    (getSession as any).mockReturnValue({ claims: { upn: 'u' } });
    const res = await GET(getReq({ container: 'bronze' }));
    expect(res.status).toBe(400);
  });

  it('404 on unknown container', async () => {
    (getSession as any).mockReturnValue({ claims: { upn: 'u' } });
    const res = await GET(getReq({ container: 'nope', tablePath: 'Tables/x' }));
    expect(res.status).toBe(404);
  });

  it('400 on path traversal', async () => {
    (getSession as any).mockReturnValue({ claims: { upn: 'u' } });
    const res = await GET(getReq({ container: 'bronze', tablePath: '../etc' }));
    expect(res.status).toBe(400);
  });

  it('parses commitInfo and returns versions sorted desc', async () => {
    (getSession as any).mockReturnValue({ claims: { upn: 'u' } });
    (listPaths as any).mockResolvedValue([
      { name: 'Tables/x/_delta_log/00000000000000000000.json', isDirectory: false, size: 10 },
      { name: 'Tables/x/_delta_log/00000000000000000001.json', isDirectory: false, size: 10 },
      { name: 'Tables/x/_delta_log/00000000000000000000.checkpoint.parquet', isDirectory: false, size: 99 },
      { name: 'Tables/x/_delta_log/_commits', isDirectory: true, size: 0 },
    ]);
    (downloadFile as any).mockImplementation(async (_c: string, path: string) => {
      const ver = path.includes('0001') ? 1 : 0;
      const op = ver === 1 ? 'MERGE' : 'WRITE';
      const commit = JSON.stringify({
        commitInfo: {
          timestamp: 1714000000000 + ver,
          operation: op,
          userName: 'alice@contoso.com',
          operationMetrics: { numOutputRows: String(100 * (ver + 1)), numFiles: '2' },
        },
      });
      const meta = JSON.stringify({ metaData: { id: 'abc' } });
      return { body: Buffer.from(`${meta}\n${commit}\n`, 'utf8') };
    });
    const res = await GET(getReq({ container: 'bronze', tablePath: 'Tables/x' }));
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.versions.map((v: any) => v.version)).toEqual([1, 0]);
    expect(j.versions[0].operation).toBe('MERGE');
    expect(j.versions[0].metrics.numOutputRows).toBe(200);
    expect(j.versions[1].userName).toBe('alice@contoso.com');
    // checkpoint.parquet and directory entries excluded
    expect(j.versions.length).toBe(2);
  });
});

describe('POST /api/lakehouse/history', () => {
  it('401 when no session', async () => {
    (getSession as any).mockReturnValue(null);
    const res = await POST(postReq({ container: 'bronze', tablePath: 'Tables/x', version: 0, action: 'preview' }));
    expect(res.status).toBe(401);
  });

  it('400 on bad action', async () => {
    (getSession as any).mockReturnValue({ claims: { upn: 'u' } });
    const res = await POST(postReq({ container: 'bronze', tablePath: 'Tables/x', version: 0, action: 'frobnicate' }));
    expect(res.status).toBe(400);
  });

  it('400 on negative version', async () => {
    (getSession as any).mockReturnValue({ claims: { upn: 'u' } });
    const res = await POST(postReq({ container: 'bronze', tablePath: 'Tables/x', version: -1, action: 'preview' }));
    expect(res.status).toBe(400);
  });

  it('503 honest gate when LOOM_DATABRICKS_HOSTNAME unset', async () => {
    (getSession as any).mockReturnValue({ claims: { upn: 'u' } });
    (databricksConfigGate as any).mockReturnValue({ missing: 'LOOM_DATABRICKS_HOSTNAME' });
    const res = await POST(postReq({ container: 'bronze', tablePath: 'Tables/x', version: 0, action: 'preview' }));
    expect(res.status).toBe(503);
    const j = await res.json();
    expect(j.gated).toBe(true);
    expect(j.code).toBe('no_databricks');
    expect(j.hint).toContain('LOOM_DATABRICKS_HOSTNAME');
  });

  it('503 gated when no warehouse', async () => {
    (getSession as any).mockReturnValue({ claims: { upn: 'u' } });
    (databricksConfigGate as any).mockReturnValue(null);
    (listWarehouses as any).mockResolvedValue([]);
    const res = await POST(postReq({ container: 'bronze', tablePath: 'Tables/x', version: 0, action: 'preview' }));
    expect(res.status).toBe(503);
    const j = await res.json();
    expect(j.code).toBe('no_warehouse');
  });

  it('preview runs SELECT … VERSION AS OF and returns rows', async () => {
    (getSession as any).mockReturnValue({ claims: { upn: 'u' } });
    (databricksConfigGate as any).mockReturnValue(null);
    (listWarehouses as any).mockResolvedValue([{ id: 'wh1', name: 'w', state: 'RUNNING' }]);
    (executeStatement as any).mockResolvedValue({ columns: ['id'], rows: [[1]], rowCount: 1, executionMs: 7, truncated: false });
    const res = await POST(postReq({ container: 'bronze', tablePath: 'Tables/x', version: 3, action: 'preview' }));
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.action).toBe('preview');
    expect(j.columns).toEqual(['id']);
    const sql = (executeStatement as any).mock.calls[0][1] as string;
    expect(sql).toContain('VERSION AS OF 3');
    expect(sql).toContain('abfss://bronze@loomdlz.dfs.core.windows.net/Tables/x');
  });

  it('restore runs RESTORE TABLE … TO VERSION AS OF', async () => {
    (getSession as any).mockReturnValue({ claims: { upn: 'u' } });
    (databricksConfigGate as any).mockReturnValue(null);
    (listWarehouses as any).mockResolvedValue([{ id: 'wh1', name: 'w', state: 'STOPPED' }]);
    (executeStatement as any).mockResolvedValue({ columns: ['num_restored_files'], rows: [[5]], rowCount: 1, executionMs: 20, truncated: false });
    const res = await POST(postReq({ container: 'bronze', tablePath: 'Tables/x', version: 2, action: 'restore' }));
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.action).toBe('restore');
    const sql = (executeStatement as any).mock.calls[0][1] as string;
    expect(sql).toContain('RESTORE TABLE delta.');
    expect(sql).toContain('TO VERSION AS OF 2');
  });

  it('502 structured error when backend throws', async () => {
    (getSession as any).mockReturnValue({ claims: { upn: 'u' } });
    (databricksConfigGate as any).mockReturnValue(null);
    (listWarehouses as any).mockResolvedValue([{ id: 'wh1', name: 'w', state: 'RUNNING' }]);
    (executeStatement as any).mockRejectedValue(Object.assign(new Error('VACUUM removed files'), { code: 'DELTA_VERSION' }));
    const res = await POST(postReq({ container: 'bronze', tablePath: 'Tables/x', version: 0, action: 'restore' }));
    expect(res.status).toBe(502);
    const j = await res.json();
    expect(j.ok).toBe(false);
    expect(j.error).toContain('VACUUM removed files');
    expect(j.code).toBe('DELTA_VERSION');
  });
});
