/**
 * BFF tests for the backend-aware UC grants route — the same pane serves
 * Databricks UC (Commercial) and OSS UC (loom-unity, Gov). Covers auth (401),
 * the Databricks config gate (503, skipped on OSS), validation (400), privilege
 * spelling normalization per backend (underscores ↔ spaces), the
 * REGISTERED_MODEL securable, and the OSS effective→direct fallback.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/auth/session', () => ({ getSession: vi.fn() }));
vi.mock('@/lib/azure/databricks-client', () => ({ databricksConfigGate: vi.fn() }));
vi.mock('@/lib/azure/uc-backend', () => ({ isOssUc: vi.fn(() => false) }));
vi.mock('@/lib/azure/unity-catalog-client', () => ({
  primaryWorkspaceHost: vi.fn(async () => 'adb-1.7.azuredatabricks.net'),
  listPermissions: vi.fn(),
  listEffectivePermissions: vi.fn(),
  updatePermissions: vi.fn(),
}));

import { GET, PATCH } from '../route';
import { getSession } from '@/lib/auth/session';
import { databricksConfigGate } from '@/lib/azure/databricks-client';
import { isOssUc } from '@/lib/azure/uc-backend';
import { listPermissions, listEffectivePermissions, updatePermissions, primaryWorkspaceHost } from '@/lib/azure/unity-catalog-client';

const SESSION = { claims: { upn: 'u@contoso.com', oid: 'oid-1' }, exp: 9_999_999_999 };
function getReq(qs = '') { return { nextUrl: new URL(`http://x/api/databricks/unity-catalog/grants${qs}`) } as any; }
function patchReq(body: any) { return { json: async () => body } as any; }

beforeEach(() => {
  vi.resetAllMocks();
  (getSession as any).mockReturnValue(SESSION);
  (databricksConfigGate as any).mockReturnValue(null);
  (isOssUc as any).mockReturnValue(false);
  (primaryWorkspaceHost as any).mockResolvedValue('adb-1.7.azuredatabricks.net');
});

describe('GET /grants', () => {
  it('401 without session', async () => {
    (getSession as any).mockReturnValue(null);
    const res = await GET(getReq('?securable_type=CATALOG&full_name=sales'));
    expect(res.status).toBe(401);
  });

  it('503 config gate on databricks when the workspace is unset', async () => {
    (databricksConfigGate as any).mockReturnValue({ missing: 'LOOM_DATABRICKS_HOSTNAME' });
    const res = await GET(getReq('?securable_type=CATALOG&full_name=sales'));
    expect(res.status).toBe(503);
  });

  it('SKIPS the databricks config gate on the OSS backend', async () => {
    (isOssUc as any).mockReturnValue(true);
    (databricksConfigGate as any).mockReturnValue({ missing: 'LOOM_DATABRICKS_HOSTNAME' });
    (listPermissions as any).mockResolvedValue({ privilege_assignments: [{ principal: 'g', privileges: ['USE CATALOG'] }] });
    const res = await GET(getReq('?securable_type=CATALOG&full_name=sales'));
    const j = await res.json();
    expect(j.ok).toBe(true);
    // OSS space-spelled privileges are normalized to the UI's underscore form.
    expect(j.grants).toEqual([{ principal: 'g', privileges: ['USE_CATALOG'] }]);
  });

  it('400 on an unknown securable', async () => {
    const res = await GET(getReq('?securable_type=PIPELINE&full_name=x'));
    expect(res.status).toBe(400);
  });

  it('accepts the REGISTERED_MODEL securable', async () => {
    (listPermissions as any).mockResolvedValue({ privilege_assignments: [] });
    const res = await GET(getReq('?securable_type=REGISTERED_MODEL&full_name=main.sales.churn'));
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(listPermissions).toHaveBeenCalledWith('adb-1.7.azuredatabricks.net', 'REGISTERED_MODEL', 'main.sales.churn');
  });

  it('effective=true uses the effective-permissions API on databricks', async () => {
    (listEffectivePermissions as any).mockResolvedValue({
      privilege_assignments: [{ principal: 'g', privileges: [{ privilege: 'SELECT', inherited_from_type: 'CATALOG' }] }],
    });
    const res = await GET(getReq('?securable_type=TABLE&full_name=main.sales.orders&effective=true'));
    const j = await res.json();
    expect(j.effective).toBe(true);
    expect(j.grants[0].privileges).toEqual(['SELECT (inherited)']);
  });

  it('effective=true falls back to direct grants on OSS with an honest note', async () => {
    (isOssUc as any).mockReturnValue(true);
    (listPermissions as any).mockResolvedValue({ privilege_assignments: [] });
    const res = await GET(getReq('?securable_type=TABLE&full_name=main.sales.orders&effective=true'));
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.effective).toBe(false);
    expect(j.note).toMatch(/Databricks-only/);
    expect(listEffectivePermissions).not.toHaveBeenCalled();
  });
});

describe('PATCH /grants', () => {
  it('normalizes privileges to underscores for databricks', async () => {
    (updatePermissions as any).mockResolvedValue({ privilege_assignments: [] });
    const res = await PATCH(patchReq({
      securable_type: 'CATALOG', full_name: 'sales',
      changes: [{ principal: 'g', add: ['use catalog', 'CREATE_SCHEMA'] }],
    }));
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(updatePermissions).toHaveBeenCalledWith('adb-1.7.azuredatabricks.net', 'CATALOG', 'sales', {
      add: [{ principal: 'g', privileges: ['USE_CATALOG', 'CREATE_SCHEMA'] }],
      remove: [],
    });
  });

  it('normalizes privileges to spaces for the OSS server', async () => {
    (isOssUc as any).mockReturnValue(true);
    (updatePermissions as any).mockResolvedValue({ privilege_assignments: [] });
    await PATCH(patchReq({
      securable_type: 'SCHEMA', full_name: 'main.sales',
      changes: [{ principal: 'g', add: ['USE_SCHEMA'], remove: ['SELECT'] }],
    }));
    expect(updatePermissions).toHaveBeenCalledWith(expect.any(String), 'SCHEMA', 'main.sales', {
      add: [{ principal: 'g', privileges: ['USE SCHEMA'] }],
      remove: [{ principal: 'g', privileges: ['SELECT'] }],
    });
  });

  it('400 when no valid changes', async () => {
    const res = await PATCH(patchReq({ securable_type: 'CATALOG', full_name: 'sales', changes: [{ principal: '' }] }));
    expect(res.status).toBe(400);
  });
});
