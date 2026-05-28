/**
 * Unit tests for /api/catalog/register BFF route.
 *
 *   1. unauthenticated → 401
 *   2. missing source → 400
 *   3. unity-catalog source → calls getTable + registerAtlasEntity with the
 *      derived qualifiedName + typeName, returns guid + deep-link.
 *   4. onelake source → calls getFabricItem + registerAtlasEntity with the
 *      OneLake-format qualifiedName.
 *   5. PurviewNotConfigured surfaces as 501 with hint payload.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/auth/session', () => ({ getSession: vi.fn() }));
vi.mock('@/lib/azure/purview-client', async () => {
  const actual: any = await vi.importActual('@/lib/azure/purview-client');
  return { ...actual, registerAtlasEntity: vi.fn() };
});
vi.mock('@/lib/azure/unity-catalog-client', async () => {
  const actual: any = await vi.importActual('@/lib/azure/unity-catalog-client');
  return { ...actual, getTable: vi.fn() };
});
vi.mock('@/lib/azure/fabric-client', async () => {
  const actual: any = await vi.importActual('@/lib/azure/fabric-client');
  return { ...actual, getFabricItem: vi.fn() };
});

import { POST } from '../register/route';
import { getSession } from '@/lib/auth/session';
import { registerAtlasEntity, PurviewNotConfiguredError } from '@/lib/azure/purview-client';
import { getTable } from '@/lib/azure/unity-catalog-client';
import { getFabricItem } from '@/lib/azure/fabric-client';

function req(body: any) {
  return { json: async () => body } as any;
}

beforeEach(() => {
  vi.resetAllMocks();
  process.env.LOOM_PURVIEW_ACCOUNT = 'purview-test';
});

describe('POST /api/catalog/register', () => {
  it('returns 401 when no session', async () => {
    (getSession as any).mockReturnValue(null);
    const res = await POST(req({ source: 'unity-catalog' }));
    expect(res.status).toBe(401);
  });

  it('returns 400 if source missing', async () => {
    (getSession as any).mockReturnValue({ claims: { oid: 'u' } });
    const res = await POST(req({}));
    expect(res.status).toBe(400);
  });

  it('registers a UC table in Purview with the right qualifiedName + typeName', async () => {
    (getSession as any).mockReturnValue({ claims: { oid: 'u' } });
    (getTable as any).mockResolvedValue({ full_name: 'main.bronze.customers', name: 'customers', comment: 'PII' });
    (registerAtlasEntity as any).mockResolvedValue({ primaryGuid: 'guid-abc' });

    const res = await POST(req({ source: 'unity-catalog', host: 'adb.host', fullName: 'main.bronze.customers' }));
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.typeName).toBe('databricks_table');
    expect(j.qualifiedName).toContain('main.bronze.customers');
    expect(j.guid).toBe('guid-abc');
    expect(j.purviewDeepLink).toContain('purview-test.purview.azure.com');
    expect(registerAtlasEntity).toHaveBeenCalledWith(expect.objectContaining({
      typeName: 'databricks_table', displayName: 'customers', comment: 'PII',
    }));
  });

  it('registers a OneLake Lakehouse with fabric_lakehouse typeName', async () => {
    (getSession as any).mockReturnValue({ claims: { oid: 'u' } });
    (getFabricItem as any).mockResolvedValue({ id: 'item-1', displayName: 'Bronze LH', type: 'Lakehouse' });
    (registerAtlasEntity as any).mockResolvedValue({ primaryGuid: 'guid-xyz' });

    const res = await POST(req({ source: 'onelake', workspaceId: 'ws-1', itemId: 'item-1' }));
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.typeName).toBe('fabric_lakehouse');
    expect(j.qualifiedName).toContain('onelake.dfs.fabric.microsoft.com/ws-1/item-1');
    expect(j.guid).toBe('guid-xyz');
  });

  it('returns 501 + hint if Purview is not configured', async () => {
    (getSession as any).mockReturnValue({ claims: { oid: 'u' } });
    (getTable as any).mockResolvedValue({ full_name: 't', name: 't' });
    (registerAtlasEntity as any).mockRejectedValue(new PurviewNotConfiguredError({
      missingEnvVar: 'LOOM_PURVIEW_ACCOUNT',
      bicepModule: 'platform/x', bicepStatus: 's', rolesRequired: [], followUp: 'set env',
    }));
    const res = await POST(req({ source: 'unity-catalog', host: 'h', fullName: 'a.b.c' }));
    expect(res.status).toBe(501);
    const j = await res.json();
    expect(j.hint.missingEnvVar).toBe('LOOM_PURVIEW_ACCOUNT');
  });
});
