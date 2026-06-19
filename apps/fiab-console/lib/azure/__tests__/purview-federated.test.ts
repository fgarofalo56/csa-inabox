/**
 * Unit tests for the CLASSIC Data Map federated catalog surface:
 *   - searchPurview          (POST /datamap/api/search/query — classic host)
 *   - getLineageSubgraph     (GET  /datamap/api/atlas/v2/lineage)
 *   - registerAtlasEntity    (POST /datamap/api/atlas/v2/entity)
 *   - createAtlasGlossaryTerm / applyGlossaryTerm
 *   - listCollections        (GET  /collections — account data plane)
 *   - business domains       (HONEST GATE — unified-catalog-only on classic)
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@azure/identity', () => {
  class Cred { async getToken() { return { token: 'TOK', expiresOnTimestamp: Date.now() + 3600_000 }; } }
  return { DefaultAzureCredential: Cred, ManagedIdentityCredential: Cred, ChainedTokenCredential: Cred };
});

import {
  listBusinessDomains, createBusinessDomain, deleteBusinessDomain,
  searchPurview, getLineageSubgraph, listCollections,
  registerAtlasEntity, createAtlasGlossaryTerm, applyGlossaryTerm,
  PurviewNotConfiguredError,
} from '../purview-client';

const realFetch = global.fetch;

function mockFetch(handler: (url: string, init?: RequestInit) => any) {
  global.fetch = vi.fn(async (url: any, init?: any) => {
    const out = await handler(String(url), init);
    if (out instanceof Response) return out;
    const status = out?._status || 200;
    return new Response(JSON.stringify(out), { status });
  }) as any;
}

beforeEach(() => {
  process.env.LOOM_PURVIEW_ACCOUNT = 'purview-test';
});
afterEach(() => {
  delete process.env.LOOM_PURVIEW_ACCOUNT;
  global.fetch = realFetch;
});

describe('NotConfigured gate', () => {
  it('throws PurviewNotConfiguredError when account is missing (searchPurview)', async () => {
    delete process.env.LOOM_PURVIEW_ACCOUNT;
    await expect(searchPurview('x')).rejects.toBeInstanceOf(PurviewNotConfiguredError);
  });
});

describe('business domains (classic Data Map collection mirror)', () => {
  // Business domains are mirrored 1:1 onto classic Data Map collections (a
  // Loom domain ⇄ a non-root collection), so these surfaces are REAL on a
  // classic account rather than gated to unified-catalog only. See
  // purview-client.ts listBusinessDomains / createBusinessDomain / delete.
  it('listBusinessDomains mirrors non-root collections as domains', async () => {
    mockFetch(() => ({
      value: [
        { name: 'root', friendlyName: 'Root', parentCollection: null },
        { name: 'finance', friendlyName: 'Finance', description: 'Books', parentCollection: { referenceName: 'root' } },
      ],
    }));
    const out = await listBusinessDomains();
    // The root collection is excluded; the child surfaces as a domain.
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ id: 'finance', name: 'Finance', description: 'Books', parentId: 'root' });
  });
  it('createBusinessDomain PUTs a classic collection; deleteBusinessDomain DELETEs it', async () => {
    const calls: { url: string; method: string }[] = [];
    mockFetch((u, init) => {
      calls.push({ url: u, method: (init?.method as string) || 'GET' });
      // listCollections() lookup for the root collection during create.
      if (u.includes('/collections?') || /\/collections\?api-version/.test(u)) {
        return { value: [{ name: 'root', friendlyName: 'Root', parentCollection: null }] };
      }
      return { name: 'x', friendlyName: 'X' };
    });
    const created = await createBusinessDomain({ name: 'X' });
    expect(created.name).toBe('X');
    expect(calls.some((c) => c.method === 'PUT' && c.url.includes('/collections/'))).toBe(true);

    calls.length = 0;
    await deleteBusinessDomain('d1');
    expect(calls.some((c) => c.method === 'DELETE' && c.url.includes('/collections/d1'))).toBe(true);
  });
  it('still throws NotConfigured when the account env is unset (before any fetch)', async () => {
    delete process.env.LOOM_PURVIEW_ACCOUNT;
    await expect(listBusinessDomains()).rejects.toBeInstanceOf(PurviewNotConfiguredError);
  });
});

describe('listCollections', () => {
  it('GETs /collections (account data plane) and shapes the rows', async () => {
    let url = '';
    mockFetch((u) => {
      url = u;
      return { value: [{ name: 'abc123', friendlyName: 'Finance', description: 'Books', parentCollection: { referenceName: 'root' } }] };
    });
    const out = await listCollections();
    expect(url).toContain('/collections');
    expect(url).toContain('purview-test.purview.azure.com');
    expect(url).not.toContain('-api.purview.azure.com');
    expect(url).toContain('api-version=2019-11-01-preview');
    expect(out[0]).toMatchObject({ name: 'abc123', friendlyName: 'Finance', parentCollection: 'root' });
  });
});

describe('searchPurview', () => {
  it('POSTs keywords to /datamap/api/search/query and unwraps `value`', async () => {
    let body: any;
    let url = '';
    mockFetch((u, init) => {
      url = u;
      body = JSON.parse((init?.body as string) || '{}');
      return { value: [{ id: 'e1', name: 'customers', entityType: 'Table' }] };
    });
    const hits = await searchPurview('customers');
    expect(url).toContain('/datamap/api/search/query');
    expect(url).toContain('purview-test.purview.azure.com');
    expect(url).not.toContain('-api.purview.azure.com');
    expect(body.keywords).toBe('customers');
    expect(hits).toEqual([{ source: 'purview', id: 'e1', name: 'customers', qualifiedName: undefined, entityType: 'Table', classification: undefined, description: undefined, owner: undefined, domain: undefined, updatedAt: undefined }]);
  });
});

describe('getLineageSubgraph', () => {
  it('GETs /datamap/api/atlas/v2/lineage and reshapes the graph', async () => {
    let url = '';
    mockFetch((u) => {
      url = u;
      return {
        baseEntityGuid: 'g1',
        guidEntityMap: {
          g1: { typeName: 'Table', displayText: 'customers', attributes: { qualifiedName: 'q1' } },
          g2: { typeName: 'Table', attributes: { name: 'orders', qualifiedName: 'q2' } },
        },
        relations: [{ fromEntityId: 'g2', toEntityId: 'g1', relationshipId: 'process' }],
      };
    });
    const graph = await getLineageSubgraph('g1');
    expect(url).toContain('/datamap/api/atlas/v2/lineage/g1');
    expect(graph.baseEntityGuid).toBe('g1');
    expect(graph.relations).toEqual([{ fromEntityId: 'g2', toEntityId: 'g1', relationshipType: 'process' }]);
    expect(graph.guidEntityMap['g1'].displayText).toBe('customers');
  });
});

describe('registerAtlasEntity', () => {
  it('POSTs an Atlas entity with the right typeName + qualifiedName and extracts the assigned guid', async () => {
    let body: any;
    let url = '';
    mockFetch((u, init) => {
      url = u;
      body = JSON.parse((init?.body as string) || '{}');
      return { guidAssignments: { '-1': 'abcd-1234' }, mutatedEntities: {} };
    });
    const out = await registerAtlasEntity({
      typeName: 'databricks_table',
      qualifiedName: 'https://adb.workspace/api/2.1/unity-catalog/tables/main.bronze.customers',
      displayName: 'customers',
      comment: 'PII data',
      owner: 'user@contoso.com',
      classifications: ['MICROSOFT.PERSONAL.NAME'],
    });
    expect(url).toContain('/datamap/api/atlas/v2/entity');
    expect(body.entity.typeName).toBe('databricks_table');
    expect(body.entity.attributes.qualifiedName).toContain('main.bronze.customers');
    expect(body.entity.attributes.name).toBe('customers');
    expect(body.entity.classifications).toEqual([{ typeName: 'MICROSOFT.PERSONAL.NAME' }]);
    expect(body.entity.contacts?.Expert?.[0]?.id).toBe('user@contoso.com');
    expect(out.primaryGuid).toBe('abcd-1234');
  });

  it('validates required fields', async () => {
    await expect(registerAtlasEntity({ typeName: '', qualifiedName: 'q', displayName: 'n' } as any))
      .rejects.toThrow(/typeName/);
    await expect(registerAtlasEntity({ typeName: 'T', qualifiedName: '', displayName: 'n' } as any))
      .rejects.toThrow(/qualifiedName/);
  });
});

describe('createAtlasGlossaryTerm + applyGlossaryTerm', () => {
  it('creates a term and applies it via Atlas v2 glossary API', async () => {
    const calls: { url: string; method: string }[] = [];
    mockFetch((u, init) => {
      calls.push({ url: u, method: (init?.method as string) || 'GET' });
      if (u.includes('/glossary/term') && !u.includes('assignedEntities')) {
        return { guid: 'term-1', name: 'PII' };
      }
      // 204 must carry a null body — undici rejects `''` with a non-null body.
      return new Response(null, { status: 204 });
    });
    const term = await createAtlasGlossaryTerm({ name: 'PII', longDescription: 'Personally identifiable info' });
    expect(term.guid).toBe('term-1');
    expect(calls[0].url).toContain('/datamap/api/atlas/v2/glossary/term');
    expect(calls[0].method).toBe('POST');
    await applyGlossaryTerm('term-1', 'entity-99');
    expect(calls[1].url).toContain('/glossary/terms/term-1/assignedEntities');
    expect(calls[1].method).toBe('POST');
  });
});
