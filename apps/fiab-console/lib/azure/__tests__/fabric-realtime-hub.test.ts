/**
 * Backend contract tests for the Fabric Real-Time Hub client helpers:
 *   - buildSourceTopology       → single-source { sources, destinations, operators, streams }
 *   - connectEventstreamSource  → POST /workspaces/{ws}/eventstreams (definition-based)
 *   - isRthSourceType           → guards against unsupported source enum values
 *   - listKqlDatabases          → GET /workspaces/{ws}/kqlDatabases
 *
 * Stubs @azure/identity + global.fetch (no live tenant). Asserts URL +
 * method + payload against the REAL Fabric REST surface per no-vaporware.md.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';

vi.mock('@azure/identity', () => {
  class Cred { async getToken() { return { token: 'TOK', expiresOnTimestamp: Date.now() + 3600_000 }; } }
  return { DefaultAzureCredential: Cred, ManagedIdentityCredential: Cred, ChainedTokenCredential: Cred };
});

import {
  buildSourceTopology, connectEventstreamSource, isRthSourceType,
  listKqlDatabases, RTH_SOURCE_TYPES,
} from '../fabric-client';

const realFetch = global.fetch;
function mockFetch(handler: (url: string, init?: RequestInit) => any) {
  global.fetch = vi.fn(async (url: any, init?: any) => {
    const out = await handler(String(url), init);
    if (out instanceof Response) return out;
    const status = out?._status || 200;
    return new Response(out === undefined ? '' : JSON.stringify(out), { status });
  }) as any;
}
afterEach(() => { global.fetch = realFetch; });

describe('buildSourceTopology', () => {
  it('emits one source of the requested type + a DefaultStream wired to it', () => {
    const t = buildSourceTopology({ displayName: 'es', sourceName: 'eh1', sourceType: 'AzureEventHub', properties: { consumerGroupName: '$Default' } });
    expect(t.sources).toHaveLength(1);
    expect(t.sources[0].type).toBe('AzureEventHub');
    expect(t.sources[0].name).toBe('eh1');
    expect(t.sources[0].properties.consumerGroupName).toBe('$Default');
    expect(t.destinations).toEqual([]);
    expect(t.operators).toEqual([]);
    expect(t.streams[0].type).toBe('DefaultStream');
    expect((t.streams[0].properties as any).inputNodes[0].name).toBe('eh1');
  });
});

describe('isRthSourceType', () => {
  it('accepts documented Fabric source enum values', () => {
    expect(isRthSourceType('AzureEventHub')).toBe(true);
    expect(isRthSourceType('FabricJobEvents')).toBe(true);
    expect(isRthSourceType('FabricOneLakeEvents')).toBe(true);
    expect(RTH_SOURCE_TYPES.length).toBeGreaterThan(10);
  });
  it('rejects unknown source types', () => {
    expect(isRthSourceType('NotARealSource')).toBe(false);
  });
});

describe('connectEventstreamSource', () => {
  it('POSTs to /workspaces/{ws}/eventstreams with a Base64 eventstream.json definition', async () => {
    let url = ''; let method = ''; let body: any;
    mockFetch((u, init) => { url = u; method = (init?.method as string) || 'GET'; body = JSON.parse((init?.body as string) || '{}'); return { id: 'fes-new' }; });
    const res: any = await connectEventstreamSource('ws-9', {
      displayName: 'Orders CDC', sourceName: 's1', sourceType: 'AzureSQLDBCDC', properties: { tableName: 'dbo.Orders' },
    });
    expect(url).toContain('/workspaces/ws-9/eventstreams');
    expect(url).not.toContain('updateDefinition');
    expect(method).toBe('POST');
    expect(body.displayName).toBe('Orders CDC');
    expect(body.definition.parts[0].path).toBe('eventstream.json');
    // Decode the topology and confirm the source type round-trips.
    const topo = JSON.parse(Buffer.from(body.definition.parts[0].payload, 'base64').toString('utf-8'));
    expect(topo.sources[0].type).toBe('AzureSQLDBCDC');
    expect(topo.sources[0].properties.tableName).toBe('dbo.Orders');
    expect(res.id).toBe('fes-new');
  });

  it('throws (400) for an unsupported source type — no eventstream is created', async () => {
    let called = false;
    mockFetch(() => { called = true; return {}; });
    await expect(connectEventstreamSource('ws-1', { displayName: 'x', sourceName: 's', sourceType: 'Nope' as any }))
      .rejects.toMatchObject({ status: 400 });
    expect(called).toBe(false);
  });

  it('treats a 202 (long-running) as accepted', async () => {
    mockFetch(() => ({ _status: 202 }));
    const res: any = await connectEventstreamSource('ws-1', { displayName: 'x', sourceName: 's', sourceType: 'SampleData' });
    expect(res._accepted).toBe(true);
  });
});

describe('listKqlDatabases', () => {
  it('GETs /workspaces/{ws}/kqlDatabases and returns the value array', async () => {
    let url = '';
    mockFetch((u) => { url = u; return { value: [{ id: 'db1', displayName: 'Telemetry' }] }; });
    const dbs = await listKqlDatabases('ws-7');
    expect(url).toContain('/workspaces/ws-7/kqlDatabases');
    expect(dbs[0].displayName).toBe('Telemetry');
  });
});
