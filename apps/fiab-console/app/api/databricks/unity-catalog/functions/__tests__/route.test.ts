/**
 * BFF tests for the backend-aware UC functions route — same pane, databricks +
 * oss payload shapes. Auth (401), config gate skipped on OSS, validation (400),
 * list/get/delete delegation to the backend-aware client.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/auth/session', () => ({ getSession: vi.fn() }));
vi.mock('@/lib/azure/databricks-client', () => ({ databricksConfigGate: vi.fn() }));
vi.mock('@/lib/azure/uc-backend', () => ({ isOssUc: vi.fn(() => false) }));
vi.mock('@/lib/azure/unity-catalog-client', () => ({
  primaryWorkspaceHost: vi.fn(),
  listFunctionsUc: vi.fn(),
  getFunctionUc: vi.fn(),
  deleteFunctionUc: vi.fn(),
}));

import { GET, DELETE } from '../route';
import { getSession } from '@/lib/auth/session';
import { databricksConfigGate } from '@/lib/azure/databricks-client';
import { isOssUc } from '@/lib/azure/uc-backend';
import { primaryWorkspaceHost, listFunctionsUc, getFunctionUc, deleteFunctionUc } from '@/lib/azure/unity-catalog-client';

const SESSION = { claims: { upn: 'u@contoso.com', oid: 'oid-1' }, exp: 9_999_999_999 };
function getReq(qs = '') { return { nextUrl: new URL(`http://x/api/databricks/unity-catalog/functions${qs}`) } as any; }

beforeEach(() => {
  vi.resetAllMocks();
  (getSession as any).mockReturnValue(SESSION);
  (databricksConfigGate as any).mockReturnValue(null);
  (isOssUc as any).mockReturnValue(false);
  (primaryWorkspaceHost as any).mockResolvedValue('adb-1.7.azuredatabricks.net');
});

describe('GET /functions', () => {
  it('401 without session', async () => {
    (getSession as any).mockReturnValue(null);
    expect((await GET(getReq('?catalog=main&schema=sec'))).status).toBe(401);
  });

  it('503 config gate on databricks, skipped on OSS', async () => {
    (databricksConfigGate as any).mockReturnValue({ missing: 'LOOM_DATABRICKS_HOSTNAME' });
    expect((await GET(getReq('?catalog=main&schema=sec'))).status).toBe(503);
    (isOssUc as any).mockReturnValue(true);
    (primaryWorkspaceHost as any).mockResolvedValue('loom-unity.internal');
    (listFunctionsUc as any).mockResolvedValue([{ name: 'mask_ssn' }]);
    const res = await GET(getReq('?catalog=main&schema=sec'));
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.backend).toBe('oss');
    expect(j.functions).toHaveLength(1);
  });

  it('400 without catalog/schema or full_name', async () => {
    expect((await GET(getReq('?catalog=main'))).status).toBe(400);
  });

  it('lists functions on the databricks happy path', async () => {
    (listFunctionsUc as any).mockResolvedValue([{ name: 'to_upper', full_data_type: 'STRING' }]);
    const j = await (await GET(getReq('?catalog=main&schema=util'))).json();
    expect(j.ok).toBe(true);
    expect(j.backend).toBe('databricks');
    expect(listFunctionsUc).toHaveBeenCalledWith('adb-1.7.azuredatabricks.net', 'main', 'util');
  });

  it('gets a single function by full_name', async () => {
    (getFunctionUc as any).mockResolvedValue({ name: 'to_upper', full_name: 'main.util.to_upper' });
    const j = await (await GET(getReq('?full_name=main.util.to_upper'))).json();
    expect(j.ok).toBe(true);
    expect(j.function.full_name).toBe('main.util.to_upper');
  });
});

describe('DELETE /functions', () => {
  it('400 on a malformed full_name', async () => {
    expect((await DELETE(getReq('?full_name=nope'))).status).toBe(400);
  });

  it('drops a function', async () => {
    (deleteFunctionUc as any).mockResolvedValue(undefined);
    const j = await (await DELETE(getReq('?full_name=main.util.to_upper&force=true'))).json();
    expect(j.ok).toBe(true);
    expect(deleteFunctionUc).toHaveBeenCalledWith('adb-1.7.azuredatabricks.net', 'main.util.to_upper', true);
  });
});
