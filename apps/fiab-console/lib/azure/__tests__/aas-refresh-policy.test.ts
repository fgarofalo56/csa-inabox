/**
 * BFF route tests for /api/items/semantic-model/[id]/refresh-policy.
 *
 * Imports the route handlers directly, stubs getSession + AAS XMLA fetch, and
 * asserts: backend honest-gate (503), input validation (400), and the happy PUT
 * path (Alter + Refresh + TMSCHEMA_PARTITIONS Discover → partition receipt).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/auth/session', () => ({
  getSession: vi.fn(() => ({ claims: { oid: 'oid-test', upn: 'u@t.com' }, exp: Date.now() / 1000 + 3600 })),
}));

vi.mock('@azure/identity', () => {
  class Cred { async getToken() { return { token: 'tk', expiresOnTimestamp: Date.now() + 3600_000 }; } }
  return { DefaultAzureCredential: Cred, ManagedIdentityCredential: Cred, ChainedTokenCredential: Cred };
});

const ENDPOINT = 'https://eastus2.asazure.windows.net/servers/loom-aas/models/FiabModel';

beforeEach(() => {
  process.env.LOOM_SEMANTIC_BACKEND = 'analysis-services';
  process.env.LOOM_AAS_XMLA_ENDPOINT = ENDPOINT;
  delete process.env.LOOM_AAS_DATABASE;
});

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.resetModules(); });

function req(method: string, url: string, body?: unknown) {
  return new NextRequest(url, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

const URL_BASE = `http://x/api/items/semantic-model/ds-1/refresh-policy?workspaceId=ws-1`;
const ctx = { params: Promise.resolve({ id: 'ds-1' }) };

function stubXmla(partitionsXml: string) {
  const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
    const body = String(init?.body || '');
    const xml = body.includes('TMSCHEMA_PARTITIONS') ? partitionsXml : '<return/>';
    return new Response(xml, { status: 200, headers: { 'content-type': 'text/xml' } });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const GOOD_POLICY = {
  tableName: 'FactSales',
  policy: { rollingWindowGranularity: 'year', rollingWindowPeriods: 3, incrementalGranularity: 'day', incrementalPeriods: 10, mode: 'Hybrid' },
};

describe('refresh-policy backend gate', () => {
  it('503 when LOOM_SEMANTIC_BACKEND is not analysis-services', async () => {
    process.env.LOOM_SEMANTIC_BACKEND = 'loom-native';
    const { PUT } = await import('@/app/api/items/semantic-model/[id]/refresh-policy/route');
    const r = await PUT(req('PUT', URL_BASE, GOOD_POLICY), ctx);
    expect(r.status).toBe(503);
    const j = await r.json();
    expect(j.ok).toBe(false);
    expect(j.error).toContain('analysis-services');
  });

  it('503 when LOOM_AAS_XMLA_ENDPOINT is unset', async () => {
    delete process.env.LOOM_AAS_XMLA_ENDPOINT;
    const { GET } = await import('@/app/api/items/semantic-model/[id]/refresh-policy/route');
    const r = await GET(req('GET', URL_BASE), ctx);
    expect(r.status).toBe(503);
    expect((await r.json()).error).toContain('LOOM_AAS_XMLA_ENDPOINT');
  });
});

describe('refresh-policy PUT validation', () => {
  it('400 on invalid granularity', async () => {
    stubXmla('<root/>');
    const { PUT } = await import('@/app/api/items/semantic-model/[id]/refresh-policy/route');
    const bad = { tableName: 'T', policy: { ...GOOD_POLICY.policy, rollingWindowGranularity: 'fortnight' } };
    const r = await PUT(req('PUT', URL_BASE, bad), ctx);
    expect(r.status).toBe(400);
  });

  it('400 on non-positive incrementalPeriods', async () => {
    stubXmla('<root/>');
    const { PUT } = await import('@/app/api/items/semantic-model/[id]/refresh-policy/route');
    const bad = { tableName: 'T', policy: { ...GOOD_POLICY.policy, incrementalPeriods: 0 } };
    const r = await PUT(req('PUT', URL_BASE, bad), ctx);
    expect(r.status).toBe(400);
  });
});

describe('refresh-policy PUT happy path', () => {
  it('runs Alter + Refresh + Discover and returns the partition receipt with a DirectQuery partition', async () => {
    const partXml =
      '<root><row><Name>FactSales_2024</Name><Mode>0</Mode></row>' +
      '<row><Name>FactSales_DirectQuery</Name><Mode>1</Mode></row></root>';
    const fetchMock = stubXmla(partXml);
    const { PUT } = await import('@/app/api/items/semantic-model/[id]/refresh-policy/route');
    const r = await PUT(req('PUT', URL_BASE, GOOD_POLICY), ctx);
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.ok).toBe(true);
    expect(j.partitions).toHaveLength(2);
    expect(j.partitions.some((p: any) => p.storageMode === 'DirectQuery')).toBe(true);
    // 3 XMLA calls: Alter, Refresh, Discover.
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const bodies = fetchMock.mock.calls.map((c) => String((c[1] as RequestInit)?.body));
    expect(bodies.some((b) => b.includes('"refreshPolicy"'))).toBe(true);
    expect(bodies.some((b) => b.includes('"applyRefreshPolicy":true'))).toBe(true);
    expect(bodies.some((b) => b.includes('TMSCHEMA_PARTITIONS'))).toBe(true);
  });
});
