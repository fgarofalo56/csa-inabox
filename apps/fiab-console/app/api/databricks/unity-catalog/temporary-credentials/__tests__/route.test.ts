/**
 * BFF tests for the backend-aware UC temporary-credential vending route.
 * Both backends (databricks + oss): auth, validation, kind dispatch, and the
 * per-backend remediation hint on vending failures.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/auth/session', () => ({ getSession: vi.fn() }));
vi.mock('@/lib/azure/databricks-client', () => ({ databricksConfigGate: vi.fn() }));
vi.mock('@/lib/azure/uc-backend', () => ({ isOssUc: vi.fn(() => false) }));
vi.mock('@/lib/azure/unity-catalog-client', () => ({
  primaryWorkspaceHost: vi.fn(),
  vendTableCredentials: vi.fn(),
  vendVolumeCredentials: vi.fn(),
  vendPathCredentials: vi.fn(),
}));

import { POST } from '../route';
import { getSession } from '@/lib/auth/session';
import { databricksConfigGate } from '@/lib/azure/databricks-client';
import { isOssUc } from '@/lib/azure/uc-backend';
import {
  primaryWorkspaceHost, vendTableCredentials, vendVolumeCredentials, vendPathCredentials,
} from '@/lib/azure/unity-catalog-client';

const SESSION = { claims: { upn: 'u@contoso.com', oid: 'oid-1' }, exp: 9_999_999_999 };
function postReq(body: any) { return { json: async () => body } as any; }

beforeEach(() => {
  vi.resetAllMocks();
  (getSession as any).mockReturnValue(SESSION);
  (databricksConfigGate as any).mockReturnValue(null);
  (isOssUc as any).mockReturnValue(false);
  (primaryWorkspaceHost as any).mockResolvedValue('adb-1.7.azuredatabricks.net');
});

describe('POST /temporary-credentials', () => {
  it('401 without session', async () => {
    (getSession as any).mockReturnValue(null);
    expect((await POST(postReq({ kind: 'table', table_id: 't1', operation: 'READ' }))).status).toBe(401);
  });

  it('400 on a bad kind or operation', async () => {
    expect((await POST(postReq({ kind: 'nope' }))).status).toBe(400);
    expect((await POST(postReq({ kind: 'table', table_id: 't1', operation: 'DELETE' }))).status).toBe(400);
    expect((await POST(postReq({ kind: 'volume', volume_id: 'v1', operation: 'READ' }))).status).toBe(400);
  });

  it('vends table credentials (databricks payload shape)', async () => {
    (vendTableCredentials as any).mockResolvedValue({ expiration_time: 1, azure_user_delegation_sas: { sas_token: 's' } });
    const j = await (await POST(postReq({ kind: 'table', table_id: 't1', operation: 'READ_WRITE' }))).json();
    expect(j.ok).toBe(true);
    expect(vendTableCredentials).toHaveBeenCalledWith('adb-1.7.azuredatabricks.net', 't1', 'READ_WRITE');
  });

  it('vends volume + path credentials on the OSS backend (config gate skipped)', async () => {
    (isOssUc as any).mockReturnValue(true);
    (databricksConfigGate as any).mockReturnValue({ missing: 'LOOM_DATABRICKS_HOSTNAME' });
    (primaryWorkspaceHost as any).mockResolvedValue('loom-unity.internal');
    (vendVolumeCredentials as any).mockResolvedValue({ expiration_time: 1 });
    const j1 = await (await POST(postReq({ kind: 'volume', volume_id: 'v1', operation: 'READ_VOLUME' }))).json();
    expect(j1.ok).toBe(true);
    (vendPathCredentials as any).mockResolvedValue({ expiration_time: 1 });
    const j2 = await (await POST(postReq({ kind: 'path', url: 'abfss://c@a.dfs.core.windows.net/p', operation: 'PATH_READ' }))).json();
    expect(j2.ok).toBe(true);
  });

  it('names the OSS remediation on a vending failure', async () => {
    (isOssUc as any).mockReturnValue(true);
    (primaryWorkspaceHost as any).mockResolvedValue('loom-unity.internal');
    (vendTableCredentials as any).mockRejectedValue(Object.assign(new Error('vending not configured'), { status: 501 }));
    const res = await POST(postReq({ kind: 'table', table_id: 't1', operation: 'READ' }));
    const j = await res.json();
    expect(res.status).toBe(501);
    expect(j.error).toMatch(/LOOM_UNITY_ADLS_ACCOUNT/);
  });
});
