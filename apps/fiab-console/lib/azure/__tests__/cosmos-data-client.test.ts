/**
 * Contract tests for the Cosmos DB **data-plane** client (Items Data Explorer).
 *
 * Per .claude/rules/no-vaporware.md these assert the EXACT data-plane REST the
 * client sends to https://<account>.documents.azure.com — URL, the AAD
 * Authorization header SHAPE (type=aad&ver=1.0&sig=<token>, URL-encoded — NOT
 * the HMAC master-key scheme), the query headers + body, the partition-key
 * header, and that a 403 throws the typed data-plane-RBAC error. No behavior is
 * faked beyond stubbing global.fetch + the AAD credential.
 *
 * Grounding:
 *   Auth header   — https://learn.microsoft.com/rest/api/cosmos-db/access-control-on-cosmosdb-resources#authorization-header
 *   Query docs    — https://learn.microsoft.com/rest/api/cosmos-db/query-documents#request
 *   Get document  — https://learn.microsoft.com/rest/api/cosmos-db/get-a-document
 *   Delete doc    — https://learn.microsoft.com/rest/api/cosmos-db/delete-a-document
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@azure/identity', () => {
  class Cred { async getToken() { return { token: 'AAD.ACCESS.TOKEN', expiresOnTimestamp: Date.now() + 3600_000 }; } }
  return {
    DefaultAzureCredential: Cred,
    ManagedIdentityCredential: Cred,
    ChainedTokenCredential: Cred,
  };
});

import {
  queryItems, getItem, upsertItem, deleteItem,
  buildAadAuthHeader, cosmosDataEndpoint,
  CosmosDataPlaneRbacError, CosmosDataError,
} from '../cosmos-data-client';

const realFetch = global.fetch;
const ACCOUNT = 'loomcosmos';
const ENDPOINT = `https://${ACCOUNT}.documents.azure.com`;

interface Call { url: string; init?: any }

function mockFetch(
  handler: (url: string, init?: any) => any,
  calls?: Call[],
) {
  global.fetch = vi.fn(async (url: any, init?: any) => {
    calls?.push({ url: String(url), init });
    const out = await handler(String(url), init);
    if (out instanceof Response) return out;
    const status = out?._status ?? 200;
    const headers = new Headers(out?._headers || {});
    const body = out?._body !== undefined ? out._body : out;
    return new Response(status === 204 ? null : JSON.stringify(body), { status, headers });
  }) as any;
}

beforeEach(() => {
  process.env.LOOM_COSMOS_ACCOUNT = ACCOUNT;
  delete process.env.LOOM_COSMOS_ACCOUNT_ENDPOINT;
});
afterEach(() => {
  global.fetch = realFetch;
  delete process.env.LOOM_COSMOS_ACCOUNT;
  delete process.env.LOOM_COSMOS_ACCOUNT_ENDPOINT;
});

describe('endpoint + AAD auth header scheme', () => {
  it('derives the documents.azure.com endpoint from LOOM_COSMOS_ACCOUNT', () => {
    expect(cosmosDataEndpoint()).toBe(ENDPOINT);
  });

  it('honors an explicit LOOM_COSMOS_ACCOUNT_ENDPOINT (sovereign clouds), trimming trailing slash', () => {
    process.env.LOOM_COSMOS_ACCOUNT_ENDPOINT = 'https://loom.documents.azure.us/';
    expect(cosmosDataEndpoint()).toBe('https://loom.documents.azure.us');
  });

  it('builds the URL-encoded type=aad&ver=1.0&sig=<token> header (NOT the HMAC scheme)', () => {
    const h = buildAadAuthHeader('AAD.ACCESS.TOKEN');
    // URL-encoded form per Learn — decode and assert the canonical string.
    expect(decodeURIComponent(h)).toBe('type=aad&ver=1.0&sig=AAD.ACCESS.TOKEN');
    // It must be the aad token type, not master/HMAC.
    expect(decodeURIComponent(h).startsWith('type=aad&ver=1.0&sig=')).toBe(true);
    expect(decodeURIComponent(h)).not.toContain('type=master');
  });
});

describe('queryItems', () => {
  it('POSTs to /dbs/{db}/colls/{coll}/docs with the isquery + query+json headers, AAD auth, and { query, parameters } body', async () => {
    const calls: Call[] = [];
    mockFetch(() => ({
      _headers: { 'x-ms-request-charge': '2.89', 'x-ms-continuation': 'TOKEN_PAGE_2' },
      Documents: [{ id: 'a', _partitionKey: 'p1' }, { id: 'b' }],
      _count: 2,
    }), calls);

    const out = await queryItems('SalesDb', 'Orders', 'SELECT * FROM c', { maxItems: 50 });

    expect(calls).toHaveLength(1);
    const { url, init } = calls[0];
    // Exact data-plane docs URL on the account endpoint.
    expect(url).toBe(`${ENDPOINT}/dbs/SalesDb/colls/Orders/docs`);
    expect(init.method).toBe('POST');
    // Query headers — grounded in Query Documents reference.
    expect(init.headers['x-ms-documentdb-isquery']).toBe('true');
    expect(init.headers['content-type']).toBe('application/query+json');
    expect(init.headers['x-ms-max-item-count']).toBe('50');
    expect(init.headers['x-ms-documentdb-query-enablecrosspartition']).toBe('true');
    // AAD auth header shape (URL-encoded type=aad&ver=1.0&sig=<token>).
    expect(decodeURIComponent(init.headers['authorization'])).toBe('type=aad&ver=1.0&sig=AAD.ACCESS.TOKEN');
    // Common required headers.
    expect(init.headers['x-ms-version']).toBeTruthy();
    expect(init.headers['x-ms-date']).toBeTruthy();
    // Body is { query, parameters }.
    const body = JSON.parse(init.body);
    expect(body.query).toBe('SELECT * FROM c');
    expect(body.parameters).toEqual([]);
    // Shaped result: documents + RU charge + continuation.
    expect(out.documents).toHaveLength(2);
    expect(out.requestCharge).toBeCloseTo(2.89);
    expect(out.continuation).toBe('TOKEN_PAGE_2');
    expect(out.count).toBe(2);
  });

  it('forwards a continuation token and bound parameters; omits cross-partition when disabled', async () => {
    const calls: Call[] = [];
    mockFetch(() => ({ Documents: [], _count: 0 }), calls);
    await queryItems('Db', 'C', 'SELECT * FROM c WHERE c.id = @id', {
      crossPartition: false,
      continuation: 'PREV_TOKEN',
      parameters: [{ name: '@id', value: 'x1' }],
    });
    const { init } = calls[0];
    expect(init.headers['x-ms-documentdb-query-enablecrosspartition']).toBeUndefined();
    expect(init.headers['x-ms-continuation']).toBe('PREV_TOKEN');
    expect(JSON.parse(init.body).parameters).toEqual([{ name: '@id', value: 'x1' }]);
  });

  it('throws the typed CosmosDataPlaneRbacError on 403 (UAMI missing data-plane RBAC role)', async () => {
    mockFetch(() => ({
      _status: 403,
      _headers: { 'x-ms-substatus': '5300' },
      message: 'The given request cannot be authorized by AAD token in data plane.',
    }));
    let caught: unknown;
    try {
      await queryItems('Db', 'C', 'SELECT * FROM c');
    } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(CosmosDataPlaneRbacError);
    const err = caught as CosmosDataPlaneRbacError;
    expect(err.status).toBe(403);
    expect(err.substatus).toBe(5300);
    // The honest gate names the exact data-plane role to grant.
    expect(err.role).toBe('Cosmos DB Built-in Data Contributor');
    expect(err.hint).toContain('sqlRoleAssignments');
  });
});

describe('getItem', () => {
  it('GETs /docs/{id} with the single-element JSON-array partition-key header', async () => {
    const calls: Call[] = [];
    mockFetch(() => ({ _headers: { 'x-ms-request-charge': '1.0' }, id: 'a', name: 'Ann', tenantId: 'p1' }), calls);
    const out = await getItem('Db', 'C', 'a', 'p1');
    const { url, init } = calls[0];
    expect(url).toBe(`${ENDPOINT}/dbs/Db/colls/C/docs/a`);
    expect(init.method).toBe('GET');
    expect(init.headers['x-ms-documentdb-partitionkey']).toBe('["p1"]');
    expect(decodeURIComponent(init.headers['authorization'])).toContain('type=aad&ver=1.0&sig=');
    expect((out.document as any)?.id).toBe('a');
    expect(out.requestCharge).toBeCloseTo(1.0);
  });

  it('returns null document on 404 rather than throwing', async () => {
    mockFetch(() => ({ _status: 404, message: 'NotFound' }));
    const out = await getItem('Db', 'C', 'missing', 'p1');
    expect(out.document).toBeNull();
  });
});

describe('upsertItem', () => {
  it('POSTs /docs with is-upsert + partition-key headers and the doc body', async () => {
    const calls: Call[] = [];
    mockFetch(() => ({ _headers: { 'x-ms-request-charge': '7.43' }, id: 'a', name: 'Bob', tenantId: 'p2' }), calls);
    const out = await upsertItem('Db', 'C', { id: 'a', name: 'Bob', tenantId: 'p2' }, 'p2');
    const { url, init } = calls[0];
    expect(url).toBe(`${ENDPOINT}/dbs/Db/colls/C/docs`);
    expect(init.method).toBe('POST');
    expect(init.headers['x-ms-documentdb-is-upsert']).toBe('true');
    expect(init.headers['content-type']).toBe('application/json');
    expect(init.headers['x-ms-documentdb-partitionkey']).toBe('["p2"]');
    expect(JSON.parse(init.body)).toEqual({ id: 'a', name: 'Bob', tenantId: 'p2' });
    expect(out.requestCharge).toBeCloseTo(7.43);
  });
});

describe('deleteItem', () => {
  it('DELETEs /docs/{id} with the partition-key header and returns the RU charge', async () => {
    const calls: Call[] = [];
    mockFetch(() => ({ _status: 204, _headers: { 'x-ms-request-charge': '5.0' } }), calls);
    const out = await deleteItem('Db', 'C', 'a', 'p1');
    const { url, init } = calls[0];
    expect(url).toBe(`${ENDPOINT}/dbs/Db/colls/C/docs/a`);
    expect(init.method).toBe('DELETE');
    expect(init.headers['x-ms-documentdb-partitionkey']).toBe('["p1"]');
    expect(out.requestCharge).toBeCloseTo(5.0);
  });

  it('swallows a 404 (already gone) so deletes are idempotent', async () => {
    mockFetch(() => ({ _status: 404, message: 'NotFound' }));
    await expect(deleteItem('Db', 'C', 'gone', 'p1')).resolves.toEqual({ requestCharge: 0 });
  });
});

describe('non-403 errors surface as CosmosDataError', () => {
  it('throws CosmosDataError with status + parsed body on a 400 bad query', async () => {
    mockFetch(() => ({ _status: 400, message: 'Syntax error, incorrect syntax near FROM.' }));
    let caught: unknown;
    try { await queryItems('Db', 'C', 'SELCT * FROM c'); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(CosmosDataError);
    expect((caught as CosmosDataError).status).toBe(400);
    expect((caught as CosmosDataError).message).toContain('Syntax error');
  });
});
