/**
 * Backend contract tests for the Fabric Eventstream client helpers used by
 * the Eventstream editor:
 *   - buildEventstreamDefinition  → Base64 eventstream.json part
 *   - publishEventstream          → POST /workspaces/{ws}/eventstreams (create)
 *                                   or .../{id}/updateDefinition (update)
 *   - getEventstreamDefinition    → POST /workspaces/{ws}/eventstreams/{id}/getDefinition
 *
 * Stubs @azure/identity + global.fetch — no live tenant. Asserts URL + method
 * against the REAL Fabric REST surface per no-vaporware.md.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';

vi.mock('@azure/identity', () => {
  class Cred { async getToken() { return { token: 'TOK', expiresOnTimestamp: Date.now() + 3600_000 }; } }
  return { DefaultAzureCredential: Cred, ManagedIdentityCredential: Cred, ChainedTokenCredential: Cred };
});

import { buildEventstreamDefinition, publishEventstream, getEventstreamDefinition } from '../fabric-client';

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

describe('buildEventstreamDefinition', () => {
  it('Base64-encodes the topology under eventstream.json (round-trippable)', () => {
    const topo = { sources: [{ name: 's', type: 'AzureEventHub' }], destinations: [], operators: [], streams: [] };
    const def = buildEventstreamDefinition(topo);
    expect(def.parts).toHaveLength(1);
    expect(def.parts[0].path).toBe('eventstream.json');
    expect(def.parts[0].payloadType).toBe('InlineBase64');
    const decoded = JSON.parse(Buffer.from(def.parts[0].payload, 'base64').toString('utf-8'));
    expect(decoded.sources[0].type).toBe('AzureEventHub');
  });
});

describe('publishEventstream', () => {
  it('POSTs to /workspaces/{ws}/eventstreams on create (no id)', async () => {
    let url = ''; let method = ''; let body: any;
    mockFetch((u, init) => { url = u; method = (init?.method as string) || 'GET'; body = JSON.parse((init?.body as string) || '{}'); return { id: 'fes-1' }; });
    await publishEventstream('ws-1', { displayName: 'My ES', topology: { sources: [], destinations: [], operators: [], streams: [] } });
    expect(url).toContain('/workspaces/ws-1/eventstreams');
    expect(url).not.toContain('updateDefinition');
    expect(method).toBe('POST');
    expect(body.displayName).toBe('My ES');
    expect(body.definition.parts[0].path).toBe('eventstream.json');
  });

  it('POSTs to /eventstreams/{id}/updateDefinition when an id is supplied', async () => {
    let url = '';
    mockFetch((u) => { url = u; return { _status: 202 }; });
    await publishEventstream('ws-1', { id: 'fes-9', displayName: 'My ES', topology: {} });
    expect(url).toContain('/workspaces/ws-1/eventstreams/fes-9/updateDefinition');
  });
});

describe('getEventstreamDefinition', () => {
  it('POSTs to /eventstreams/{id}/getDefinition', async () => {
    let url = ''; let method = '';
    mockFetch((u, init) => { url = u; method = (init?.method as string) || 'GET'; return { definition: { parts: [] } }; });
    await getEventstreamDefinition('ws-1', 'fes-1');
    expect(url).toContain('/workspaces/ws-1/eventstreams/fes-1/getDefinition');
    expect(method).toBe('POST');
  });
});
