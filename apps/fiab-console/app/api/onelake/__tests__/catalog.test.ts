/**
 * Contract tests for GET /api/onelake/catalog (OneLake catalog Explore tab).
 *
 *   1. unauthenticated                       → 401
 *   2. AI Search configured (default)        → backend 'aisearch', workspace
 *                                              tree + domain list from Cosmos,
 *                                              items from searchGovernanceCatalog,
 *                                              q forwarded to opts
 *   3. AI Search NOT configured              → Cosmos fallback, backend 'cosmos',
 *                                              filtered to catalog data types,
 *                                              searchGate names LOOM_AI_SEARCH_SERVICE
 *   4. LOOM_CATALOG_BACKEND=fabric + Commercial
 *                                            → backend 'fabric' via OneLake REST
 *   5. LOOM_CATALOG_BACKEND=fabric + GCC-High
 *                                            → assertFabricFamilyAvailable throws → 500
 *   6. empty workspace list (AI Search off)  → empty items, no crash, searchGate
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@/lib/auth/session', () => ({ getSession: vi.fn() }));
vi.mock('@/lib/azure/cosmos-client', () => ({
  workspacesContainer: vi.fn(),
  itemsContainer: vi.fn(),
}));
vi.mock('@/lib/azure/governance-catalog-index', async () => {
  const actual: any = await vi.importActual('@/lib/azure/governance-catalog-index');
  return {
    ...actual,
    isGovernanceCatalogSearchConfigured: vi.fn(),
    searchGovernanceCatalog: vi.fn(),
    // keep the real isCatalogDataType predicate
  };
});
vi.mock('@/lib/azure/onelake-catalog-client', () => ({
  listOneLakeWorkspaces: vi.fn(),
  listAllOneLakeItems: vi.fn(),
}));
vi.mock('@/lib/azure/cloud-endpoints', () => ({
  assertFabricFamilyAvailable: vi.fn(),
}));
vi.mock('@/lib/azure/domains-client', () => ({
  getDomainsStore: vi.fn(),
}));

import { GET } from '../catalog/route';
import { getSession } from '@/lib/auth/session';
import { workspacesContainer, itemsContainer } from '@/lib/azure/cosmos-client';
import {
  isGovernanceCatalogSearchConfigured,
  searchGovernanceCatalog,
} from '@/lib/azure/governance-catalog-index';
import {
  listOneLakeWorkspaces,
  listAllOneLakeItems,
} from '@/lib/azure/onelake-catalog-client';
import { assertFabricFamilyAvailable } from '@/lib/azure/cloud-endpoints';
import { getDomainsStore } from '@/lib/azure/domains-client';

const SESSION = { claims: { oid: 'oid-1', upn: 'alice@contoso.com', name: 'Alice' } };

function req(qs = ''): Request {
  return new Request(`http://localhost/api/onelake/catalog${qs}`);
}

function queryReturning(resources: any[]) {
  return { query: () => ({ fetchAll: vi.fn().mockResolvedValue({ resources }) }) };
}

const WORKSPACES = [
  { id: 'ws-1', name: 'Analytics', domain: 'finance' },
  { id: 'ws-2', name: 'Sales', domain: undefined },
];
const DOMAINS = [{ id: 'finance', name: 'Finance' }, { id: 'sales', name: 'Sales' }];

// Cosmos items: 2 catalog data types + 1 non-catalog (notebook must be dropped).
const COSMOS_ITEMS = [
  {
    id: 'lh-1', workspaceId: 'ws-1', itemType: 'lakehouse', displayName: 'Gold LH',
    createdBy: 'alice@contoso.com', updatedAt: '2026-06-07T00:00:00Z',
    state: { sensitivityLabel: 'Confidential', endorsement: 'Certified', domainId: 'finance' },
  },
  {
    id: 'wh-1', workspaceId: 'ws-2', itemType: 'warehouse', displayName: 'Sales WH',
    createdBy: 'bob@contoso.com', updatedAt: '2026-06-06T00:00:00Z', state: {},
  },
  {
    id: 'nb-1', workspaceId: 'ws-1', itemType: 'notebook', displayName: 'Scratch NB',
    createdBy: 'alice@contoso.com', updatedAt: '2026-06-05T00:00:00Z', state: {},
  },
];

beforeEach(() => {
  vi.resetAllMocks();
  (getSession as any).mockReturnValue(SESSION);
  (workspacesContainer as any).mockResolvedValue({ items: queryReturning(WORKSPACES) });
  (itemsContainer as any).mockResolvedValue({ items: queryReturning(COSMOS_ITEMS) });
  (getDomainsStore as any).mockReturnValue({
    listDomains: vi.fn().mockResolvedValue(DOMAINS),
  });
  delete process.env.LOOM_CATALOG_BACKEND;
});

afterEach(() => {
  delete process.env.LOOM_CATALOG_BACKEND;
});

describe('GET /api/onelake/catalog', () => {
  it('401 when unauthenticated', async () => {
    (getSession as any).mockReturnValue(null);
    const res = await GET(req());
    expect(res.status).toBe(401);
  });

  it('AI Search default: backend=aisearch, Cosmos tree + domains, q forwarded', async () => {
    (isGovernanceCatalogSearchConfigured as any).mockReturnValue(true);
    (searchGovernanceCatalog as any).mockResolvedValue({
      total: 1,
      hits: [
        {
          id: 'lh-1', workspaceId: 'ws-1', workspaceName: 'Analytics', itemType: 'lakehouse',
          displayName: 'Gold LH', ownerUpn: 'alice@contoso.com', updatedAt: '2026-06-07T00:00:00Z',
          endorsement: 'Certified', sensitivity: 'Confidential', domainId: 'finance', isDiscoverable: true,
        },
      ],
      facets: {
        itemType: [{ value: 'lakehouse', count: 1 }],
        endorsement: [{ value: 'Certified', count: 1 }],
        sensitivity: [{ value: 'Confidential', count: 1 }],
        domainId: [{ value: 'finance', count: 1 }],
      },
    });

    const res = await GET(req('?q=gold'));
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.backend).toBe('aisearch');
    expect(body.total).toBe(1);
    expect(body.items[0].id).toBe('lh-1');
    expect(body.items[0].owner).toBe('alice@contoso.com');
    // workspace tree from Cosmos
    expect(body.workspaces.map((w: any) => w.id)).toEqual(['ws-1', 'ws-2']);
    // domains from the DomainStore + (All) prepended? No — route returns raw list.
    expect(body.domains.map((d: any) => d.id)).toEqual(['finance', 'sales']);
    expect(body.facets.itemType[0].value).toBe('lakehouse');
    expect(body.searchConfigured).toBe(true);

    // q forwarded into search opts
    const opts = (searchGovernanceCatalog as any).mock.calls[0][0];
    expect(opts.q).toBe('gold');
    expect(opts.tenantId).toBe('oid-1');
    expect(opts.callerWorkspaceIds).toEqual(['ws-1', 'ws-2']);
  });

  it('Cosmos fallback when AI Search unconfigured: drops non-catalog types + searchGate', async () => {
    (isGovernanceCatalogSearchConfigured as any).mockReturnValue(false);

    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.backend).toBe('cosmos');
    // notebook dropped — only lakehouse + warehouse remain
    expect(body.total).toBe(2);
    const ids = body.items.map((i: any) => i.id).sort();
    expect(ids).toEqual(['lh-1', 'wh-1']);
    // lakehouse endorsement derived from state
    const lh = body.items.find((i: any) => i.id === 'lh-1');
    expect(lh.endorsement).toBe('Certified');
    expect(lh.workspaceName).toBe('Analytics');
    // honest gate names the env var + bicep module
    expect(body.searchGate.missingEnvVar).toBe('LOOM_AI_SEARCH_SERVICE');
    expect(body.searchGate.bicepModule).toContain('ai-search.bicep');
    expect(body.searchConfigured).toBe(false);
    // local facets computed
    expect(body.facets.itemType.length).toBeGreaterThan(0);
  });

  it('Fabric opt-in (Commercial): backend=fabric via OneLake REST', async () => {
    process.env.LOOM_CATALOG_BACKEND = 'fabric';
    (assertFabricFamilyAvailable as any).mockReturnValue(undefined); // Commercial: reachable
    (listOneLakeWorkspaces as any).mockResolvedValue([
      { id: 'fw-1', displayName: 'Fabric WS', capacityId: 'cap-1' },
    ]);
    (listAllOneLakeItems as any).mockResolvedValue([
      { id: 'fi-1', workspaceId: 'fw-1', workspaceName: 'Fabric WS', displayName: 'Lake', type: 'Lakehouse' },
    ]);

    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.backend).toBe('fabric');
    expect(body.items[0].id).toBe('fi-1');
    expect(body.workspaces[0].name).toBe('Fabric WS');
    expect(assertFabricFamilyAvailable).toHaveBeenCalledWith('fabric');
  });

  it('Fabric opt-in (GCC-High): gate throws → 500 with honest error', async () => {
    process.env.LOOM_CATALOG_BACKEND = 'fabric';
    (assertFabricFamilyAvailable as any).mockImplementation(() => {
      throw new Error('Microsoft Fabric / Activator APIs have no GCC-High endpoint.');
    });

    const res = await GET(req());
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toContain('GCC-High');
    expect(listOneLakeWorkspaces).not.toHaveBeenCalled();
  });

  it('empty workspace list (AI Search off): empty items, no crash, searchGate', async () => {
    (isGovernanceCatalogSearchConfigured as any).mockReturnValue(false);
    (workspacesContainer as any).mockResolvedValue({ items: queryReturning([]) });

    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.backend).toBe('cosmos');
    expect(body.items).toEqual([]);
    expect(body.total).toBe(0);
    expect(body.searchGate.missingEnvVar).toBe('LOOM_AI_SEARCH_SERVICE');
  });
});
