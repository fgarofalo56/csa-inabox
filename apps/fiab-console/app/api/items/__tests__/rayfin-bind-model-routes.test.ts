/**
 * BFF tests for the Rayfin data-app semantic-model binding route:
 *   GET  /api/items/rayfin-app/[id]/bind-model
 *   POST /api/items/rayfin-app/[id]/bind-model   (live DAX probe)
 *   PUT  /api/items/rayfin-app/[id]/bind-model   (persist binding)
 *
 * Asserts the auth gate (401), the Azure-native DEFAULT path (Loom-native +
 * AAS models listed with NO workspace), the honest probe gate (200 with
 * probeUnavailable when no AAS server is configured), DAX input validation,
 * and that the AAS probe delegates to executeDaxQuery on the happy path. All
 * Azure/Cosmos clients are stubbed — these verify the route contract + the
 * no-fabric-dependency / no-vaporware behavior, not the network call.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/auth/session', () => ({ getSession: vi.fn() }));
vi.mock('../_lib/item-crud', () => ({
  loadOwnedItem: vi.fn(),
  updateOwnedItem: vi.fn(),
}));
vi.mock('../_lib/pbi-content-fallback', async () => {
  const actual: any = await vi.importActual('../_lib/pbi-content-fallback');
  return {
    ...actual,
    listContentBackedItems: vi.fn(),
    semanticModelDetailFromContent: vi.fn(),
  };
});
vi.mock('@/lib/azure/aas-server-client', async () => {
  const actual: any = await vi.importActual('@/lib/azure/aas-server-client');
  return {
    ...actual,
    listDatabases: vi.fn(),
    aasServerConfigGate: vi.fn(),
    envAasServerName: vi.fn(),
    envAasServerRegion: vi.fn(),
  };
});
vi.mock('@/lib/azure/aas-client', async () => {
  const actual: any = await vi.importActual('@/lib/azure/aas-client');
  return {
    ...actual,
    executeDaxQuery: vi.fn(),
    aasConfigGate: vi.fn(() => null),
  };
});
vi.mock('@/lib/azure/powerbi-client', async () => {
  const actual: any = await vi.importActual('@/lib/azure/powerbi-client');
  return {
    ...actual,
    listDatasets: vi.fn(),
    executeDatasetQueries: vi.fn(),
  };
});

import { GET, POST, PUT } from '../rayfin-app/[id]/bind-model/route';
import { getSession } from '@/lib/auth/session';
import { loadOwnedItem, updateOwnedItem } from '../_lib/item-crud';
import { listContentBackedItems, semanticModelDetailFromContent } from '../_lib/pbi-content-fallback';
import { listDatabases, aasServerConfigGate, envAasServerName, envAasServerRegion } from '@/lib/azure/aas-server-client';
import { executeDaxQuery } from '@/lib/azure/aas-client';

function getReq(url: string) {
  const u = new URL(url);
  return { nextUrl: u, url } as any;
}
function bodyReq(url: string, body: any) {
  const u = new URL(url);
  return { nextUrl: u, url, json: async () => body } as any;
}
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  vi.resetAllMocks();
  (envAasServerName as any).mockReturnValue('');
  (envAasServerRegion as any).mockReturnValue('');
  (aasServerConfigGate as any).mockReturnValue({ missing: 'LOOM_AAS_SERVER_NAME', detail: 'set it' });
  (listContentBackedItems as any).mockResolvedValue([]);
  (semanticModelDetailFromContent as any).mockReturnValue(null);
});

describe('GET bind-model', () => {
  it('401 without session', async () => {
    (getSession as any).mockReturnValue(null);
    const res = await GET(getReq('http://x/'), ctx('new'));
    expect(res.status).toBe(401);
  });

  it('lists Loom-native models with NO workspace (Azure-native default, no Fabric)', async () => {
    (getSession as any).mockReturnValue({ claims: { oid: 't1' } });
    (listContentBackedItems as any).mockResolvedValue([{ id: 'm1', displayName: 'Sales' }]);
    (semanticModelDetailFromContent as any).mockReturnValue({ tables: [{ name: 'Fact' }, { name: 'Date' }] });
    const res = await GET(getReq('http://x/'), ctx('new'));
    const j = await res.json();
    expect(res.status).toBe(200);
    expect(j.ok).toBe(true);
    expect(j.models).toHaveLength(1);
    expect(j.models[0]).toMatchObject({ id: 'loom:m1', name: 'Sales', source: 'loom', tableCount: 2 });
    // No AAS server, no workspace -> probe is not available and gives an honest hint.
    expect(j.probe.aasAvailable).toBe(false);
    expect(j.probe.powerbiAvailable).toBe(false);
    expect(j.probe.hint).toContain('LOOM_AAS_SERVER_NAME');
  });

  it('lists AAS databases when the server is configured', async () => {
    (getSession as any).mockReturnValue({ claims: { oid: 't1' } });
    (aasServerConfigGate as any).mockReturnValue(null);
    (envAasServerName as any).mockReturnValue('aas-loom');
    (envAasServerRegion as any).mockReturnValue('eastus2');
    (listDatabases as any).mockResolvedValue([{ name: 'AdventureWorks', storageMode: 'InMemory', state: 'Succeeded' }]);
    const res = await GET(getReq('http://x/'), ctx('new'));
    const j = await res.json();
    expect(j.models.some((m: any) => m.id === 'aas:AdventureWorks' && m.source === 'aas')).toBe(true);
    expect(j.probe.aasAvailable).toBe(true);
  });
});

describe('POST bind-model (live DAX probe)', () => {
  it('401 without session', async () => {
    (getSession as any).mockReturnValue(null);
    const res = await POST(bodyReq('http://x/', { modelId: 'aas:db', dax: 'EVALUATE x' }), ctx('a1'));
    expect(res.status).toBe(401);
  });

  it('400 when DAX does not start with EVALUATE/DEFINE', async () => {
    (getSession as any).mockReturnValue({ claims: { oid: 't1' } });
    const res = await POST(bodyReq('http://x/', { modelId: 'aas:db', dax: 'SELECT 1' }), ctx('a1'));
    expect(res.status).toBe(400);
    const j = await res.json();
    expect(j.error).toContain('EVALUATE');
  });

  it('honest gate (200 probeUnavailable) when no AAS server is configured', async () => {
    (getSession as any).mockReturnValue({ claims: { oid: 't1' } });
    const res = await POST(bodyReq('http://x/', { modelId: 'loom:m1', dax: 'EVALUATE INFO.TABLES()' }), ctx('a1'));
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.ok).toBe(false);
    expect(j.probeUnavailable).toBe(true);
    expect(j.missing).toBe('LOOM_AAS_SERVER_NAME');
  });

  it('runs the AAS DAX probe on the happy path', async () => {
    (getSession as any).mockReturnValue({ claims: { oid: 't1' } });
    (aasServerConfigGate as any).mockReturnValue(null);
    (envAasServerName as any).mockReturnValue('aas-loom');
    (envAasServerRegion as any).mockReturnValue('eastus2');
    (executeDaxQuery as any).mockResolvedValue({ columns: ['n'], rows: [[1], [2]] });
    const res = await POST(bodyReq('http://x/', { modelId: 'aas:AdventureWorks', dax: 'EVALUATE ROW("n", 1)' }), ctx('a1'));
    const j = await res.json();
    expect(res.status).toBe(200);
    expect(j.ok).toBe(true);
    expect(j.source).toBe('aas');
    expect(j.rowCount).toBe(2);
    expect(executeDaxQuery).toHaveBeenCalledWith(
      { region: 'eastus2', server: 'aas-loom', database: 'AdventureWorks' },
      'EVALUATE ROW("n", 1)',
    );
  });
});

describe('PUT bind-model (persist binding)', () => {
  it('400 for an unsaved app (id=new)', async () => {
    (getSession as any).mockReturnValue({ claims: { oid: 't1' } });
    const res = await PUT(bodyReq('http://x/', { modelId: 'loom:m1' }), ctx('new'));
    expect(res.status).toBe(400);
  });

  it('merges the binding with the existing spec (no clobber)', async () => {
    (getSession as any).mockReturnValue({ claims: { oid: 't1' } });
    (loadOwnedItem as any).mockResolvedValue({ id: 'a1', state: { spec: { appName: 'keep' } } });
    (updateOwnedItem as any).mockImplementation(async (_id: string, _t: string, _o: string, patch: any) => ({ id: 'a1', updatedAt: 'now', state: patch.state }));
    const res = await PUT(bodyReq('http://x/', { modelId: 'loom:m1', name: 'Sales', source: 'loom', queries: [{ name: 'q', dax: 'EVALUATE x' }] }), ctx('a1'));
    const j = await res.json();
    expect(res.status).toBe(200);
    expect(j.ok).toBe(true);
    expect(j.binding.modelId).toBe('loom:m1');
    // The previously-saved spec must still be present in the persisted state.
    const persisted = (updateOwnedItem as any).mock.calls[0][3].state;
    expect(persisted.spec).toEqual({ appName: 'keep' });
    expect(persisted.modelBinding.queries).toHaveLength(1);
  });
});
