/**
 * BFF tests for /api/catalog/unity/capabilities — the cloud-aware Unity Catalog
 * capability discovery route that drives every /catalog/unity pane's honest
 * per-backend notes. Both backend shapes covered (databricks + oss).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@/lib/auth/session', () => ({ getSession: vi.fn() }));
vi.mock('@/lib/azure/databricks-client', () => ({ databricksConfigGate: vi.fn() }));
vi.mock('@/lib/azure/cloud-endpoints', () => ({
  isGovCloud: vi.fn(() => false),
  cloudBoundaryLabel: vi.fn(() => 'GCC-High'),
}));

import { GET } from '../capabilities/route';
import { getSession } from '@/lib/auth/session';
import { databricksConfigGate } from '@/lib/azure/databricks-client';
import { isGovCloud } from '@/lib/azure/cloud-endpoints';

const SESSION = { claims: { upn: 'u@contoso.com', oid: 'oid-1' }, exp: 9_999_999_999 };
const UC_ENV = ['LOOM_UC_BACKEND', 'LOOM_UNITY_URL', 'LOOM_DATABRICKS_HOSTNAME', 'LOOM_DATABRICKS_HOSTNAMES'];

beforeEach(() => {
  vi.resetAllMocks();
  (getSession as any).mockReturnValue(SESSION);
  (databricksConfigGate as any).mockReturnValue(null);
  (isGovCloud as any).mockReturnValue(false);
  for (const k of UC_ENV) delete process.env[k];
});
afterEach(() => { for (const k of UC_ENV) delete process.env[k]; });

describe('GET /api/catalog/unity/capabilities', () => {
  it('401 without session', async () => {
    (getSession as any).mockReturnValue(null);
    expect((await GET()).status).toBe(401);
  });

  it('databricks backend: full capability set, configured', async () => {
    process.env.LOOM_DATABRICKS_HOSTNAME = 'adb-1.7.azuredatabricks.net';
    const j = await (await GET()).json();
    expect(j.ok).toBe(true);
    expect(j.backend).toBe('databricks');
    expect(j.configured).toBe(true);
    const grants = j.capabilities.find((c: any) => c.id === 'grants');
    expect(grants.supported).toBe(true);
    const sharing = j.capabilities.find((c: any) => c.id === 'delta-sharing');
    expect(sharing.supported).toBe(true);
  });

  it('databricks backend: gate names the env var when unconfigured', async () => {
    (databricksConfigGate as any).mockReturnValue({ missing: 'LOOM_DATABRICKS_HOSTNAME' });
    const j = await (await GET()).json();
    expect(j.configured).toBe(false);
    expect(j.gate.envVar).toBe('LOOM_DATABRICKS_HOSTNAME');
  });

  it('oss backend: grants supported, sharing/lineage marked Loom-native', async () => {
    process.env.LOOM_UC_BACKEND = 'oss';
    process.env.LOOM_UNITY_URL = 'https://loom-unity.internal';
    const j = await (await GET()).json();
    expect(j.backend).toBe('oss');
    expect(j.configured).toBe(true);
    const byId = Object.fromEntries(j.capabilities.map((c: any) => [c.id, c]));
    expect(byId.grants.supported).toBe(true);
    expect(byId['external-locations'].supported).toBe(true);
    expect(byId['storage-credentials'].supported).toBe(true);
    expect(byId.models.supported).toBe(true);
    expect(byId.functions.supported).toBe(true);
    expect(byId['delta-sharing'].supported).toBe(false);
    expect(byId.lineage.supported).toBe(false);
    // Every unsupported capability names a fallback/note (no dead gates).
    for (const c of j.capabilities.filter((x: any) => !x.supported)) {
      expect(c.note, `capability ${c.id} must carry an honest note`).toBeTruthy();
    }
  });

  it('oss backend: structured gate when LOOM_UNITY_URL is unset', async () => {
    process.env.LOOM_UC_BACKEND = 'oss';
    const j = await (await GET()).json();
    expect(j.backend).toBe('oss');
    expect(j.configured).toBe(false);
    expect(j.gate.envVar).toBe('LOOM_UNITY_URL');
    expect(j.gate.bicepModule).toMatch(/loom-unity-app\.bicep/);
  });
});
