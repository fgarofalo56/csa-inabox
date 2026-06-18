/**
 * mcp-client unit tests — Streamable HTTP transport correctness.
 *
 * Verifies the client speaks the current MCP transport (per Microsoft Learn
 * "Troubleshoot MCP servers on Azure Container Apps" + the MCP spec):
 *   • POSTs every request to the SINGLE configured endpoint URL — never a
 *     `/tools/list` or `/tools/call` sub-path.
 *   • Sends `initialize` FIRST, then tools/list | tools/call.
 *   • Echoes the `Mcp-Session-Id` the server returns on initialize.
 *   • Parses both `application/json` and `text/event-stream` (SSE) bodies.
 *
 * The module builds an @azure/identity credential at import; stub it. All HTTP
 * goes through fetchWithTimeout, which we mock per-call.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@azure/identity', () => ({
  ChainedTokenCredential: class { async getToken() { return { token: 'tok' }; } },
  DefaultAzureCredential: class { async getToken() { return { token: 'tok' }; } },
  ManagedIdentityCredential: class { async getToken() { return { token: 'tok' }; } },
}));
vi.mock('@/lib/azure/aca-managed-identity', () => ({
  AcaManagedIdentityCredential: class { async getToken() { return { token: 'tok' }; } },
}));
vi.mock('@/lib/azure/cloud-endpoints', () => ({
  kvScope: () => 'https://vault.azure.net/.default',
  kvSuffix: () => 'vault.azure.net',
}));

const fetchMock = vi.fn();
vi.mock('@/lib/azure/fetch-with-timeout', () => ({
  fetchWithTimeout: (...a: unknown[]) => fetchMock(...a),
  LLM_FETCH_TIMEOUT_MS: 30_000,
}));

import { listMcpTools, callMcpTool } from '../mcp-client';

/** Build a Response-like stub with a JSON body. */
function jsonRes(obj: unknown, headers: Record<string, string> = {}) {
  const h = new Map(Object.entries({ 'content-type': 'application/json', ...headers }).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    ok: true,
    status: 200,
    headers: { get: (k: string) => h.get(k.toLowerCase()) ?? null },
    text: async () => JSON.stringify(obj),
  };
}

/** Build a Response-like stub with an SSE (text/event-stream) body. */
function sseRes(obj: unknown, headers: Record<string, string> = {}) {
  const h = new Map(Object.entries({ 'content-type': 'text/event-stream', ...headers }).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    ok: true,
    status: 200,
    headers: { get: (k: string) => h.get(k.toLowerCase()) ?? null },
    text: async () => `event: message\ndata: ${JSON.stringify(obj)}\n\n`,
  };
}

beforeEach(() => fetchMock.mockReset());

describe('listMcpTools — Streamable HTTP handshake', () => {
  it('initializes first, posts to the single endpoint, returns the tool list', async () => {
    const ENDPOINT = 'https://mcp.example.com/mcp';
    fetchMock
      // initialize → returns a session id
      .mockResolvedValueOnce(jsonRes({ jsonrpc: '2.0', id: 'init', result: { protocolVersion: '2025-06-18' } }, { 'mcp-session-id': 'sess-123' }))
      // notifications/initialized → 202 no body
      .mockResolvedValueOnce(jsonRes({}, {}))
      // tools/list
      .mockResolvedValueOnce(jsonRes({ jsonrpc: '2.0', id: 'x', result: { tools: [{ name: 'get_invoice', description: 'd' }] } }));

    const tools = await listMcpTools(ENDPOINT, 'header', 'Bearer abc', 5000);
    expect(tools).toEqual([{ name: 'get_invoice', description: 'd' }]);

    // Every call targets the endpoint URL itself — no /tools/list sub-path.
    for (const call of fetchMock.mock.calls) {
      expect(call[0]).toBe(ENDPOINT);
    }
    // First JSON-RPC method must be initialize.
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).method).toBe('initialize');
    // tools/list (3rd call) echoes the session id + advertises SSE accept.
    const listInit = fetchMock.mock.calls[2][1];
    expect(JSON.parse(listInit.body).method).toBe('tools/list');
    expect(listInit.headers['mcp-session-id']).toBe('sess-123');
    expect(listInit.headers.accept).toContain('text/event-stream');
    expect(listInit.headers.authorization).toBe('Bearer abc');
  });

  it('parses an SSE-framed tools/list response', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonRes({ jsonrpc: '2.0', id: 'init', result: {} }))
      .mockResolvedValueOnce(jsonRes({}))
      .mockResolvedValueOnce(sseRes({ jsonrpc: '2.0', id: 'x', result: { tools: [{ name: 'search' }] } }));
    const tools = await listMcpTools('https://mcp.example.com/mcp', 'header', undefined, 5000);
    expect(tools).toEqual([{ name: 'search' }]);
  });

  it('surfaces a JSON-RPC error from tools/list', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonRes({ jsonrpc: '2.0', id: 'init', result: {} }))
      .mockResolvedValueOnce(jsonRes({}))
      .mockResolvedValueOnce(jsonRes({ jsonrpc: '2.0', id: 'x', error: { code: -32601, message: 'Method not found' } }));
    await expect(listMcpTools('https://mcp.example.com/mcp', 'header', undefined, 5000))
      .rejects.toThrow(/Method not found/);
  });

  it('surfaces a transport failure on initialize (e.g. 404 from a wrong path)', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false, status: 404,
      headers: { get: () => null },
      text: async () => 'Not Found',
    });
    await expect(listMcpTools('https://mcp.example.com/wrong', 'header', undefined, 5000))
      .rejects.toThrow(/initialize failed — HTTP 404/);
  });
});

describe('callMcpTool — Streamable HTTP', () => {
  it('initializes then calls the tool, returning the result', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonRes({ jsonrpc: '2.0', id: 'init', result: {} }, { 'mcp-session-id': 's1' }))
      .mockResolvedValueOnce(jsonRes({}))
      .mockResolvedValueOnce(jsonRes({ jsonrpc: '2.0', id: 'x', result: { content: [{ type: 'text', text: 'ok' }] } }));
    const out = await callMcpTool('https://mcp.example.com/mcp', 'do_thing', { a: 1 }, 'header', 'Bearer t', 30000);
    expect(out).toEqual({ content: [{ type: 'text', text: 'ok' }] });
    const callBody = JSON.parse(fetchMock.mock.calls[2][1].body);
    expect(callBody.method).toBe('tools/call');
    expect(callBody.params).toEqual({ name: 'do_thing', arguments: { a: 1 } });
    expect(fetchMock.mock.calls[2][1].headers['mcp-session-id']).toBe('s1');
  });
});
