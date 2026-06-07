/**
 * Unit tests for the Pylance/pylsp bridge framing + the browser LSP client's
 * pure mappers. The framing round-trip is the load-bearing correctness
 * guarantee: the bridge converts one-JSON-per-WS-frame <-> Content-Length
 * framed stdio, and a bug there silently breaks every completion.
 */
import { describe, it, expect } from 'vitest';
// @ts-ignore — plain-JS bridge module (excluded from the TS program).
import { __test as bridge } from '@/lib/lsp/pylsp-bridge.mjs';
// @ts-ignore — plain-JS client module.
import { __test as client } from '@/lib/lsp/notebook-lsp-client.mjs';

describe('pylsp-bridge framing', () => {
  it('round-trips a single JSON-RPC message through Content-Length framing', () => {
    const msg = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { x: 1 } });
    const got: string[] = [];
    const parse = bridge.makeStdoutParser((b: string) => got.push(b));
    parse(bridge.frame(msg));
    expect(got).toEqual([msg]);
  });

  it('reassembles a message split across multiple chunks', () => {
    const msg = JSON.stringify({ jsonrpc: '2.0', result: { items: [{ label: 'read_csv' }] } });
    const framed = bridge.frame(msg);
    const got: string[] = [];
    const parse = bridge.makeStdoutParser((b: string) => got.push(b));
    parse(framed.subarray(0, 10));
    expect(got).toEqual([]);            // header incomplete — nothing yet
    parse(framed.subarray(10));
    expect(got).toEqual([msg]);
  });

  it('emits two messages from a single coalesced chunk', () => {
    const a = JSON.stringify({ id: 1 });
    const b = JSON.stringify({ id: 2 });
    const got: string[] = [];
    const parse = bridge.makeStdoutParser((m: string) => got.push(m));
    parse(Buffer.concat([bridge.frame(a), bridge.frame(b)]));
    expect(got).toEqual([a, b]);
  });

  it('parses the loom_session cookie out of a Cookie header', () => {
    const header = 'foo=bar; loom_session=abc123; other=z';
    expect(bridge.readCookie(header, 'loom_session')).toBe('abc123');
    expect(bridge.readCookie(header, 'missing')).toBeNull();
    expect(bridge.readCookie('', 'loom_session')).toBeNull();
  });
});

describe('notebook-lsp-client mappers', () => {
  it('maps LSP completion kinds by name', () => {
    expect(client.LSP_COMPLETION_KIND[3]).toBe('Function');
    expect(client.LSP_COMPLETION_KIND[7]).toBe('Class');
    expect(client.LSP_COMPLETION_KIND[10]).toBe('Property');
  });

  it('normalizes LSP documentation (string + MarkupContent) for Monaco', () => {
    expect(client.lspToMonacoMarkdown('hello')).toEqual({ value: 'hello' });
    expect(client.lspToMonacoMarkdown({ kind: 'markdown', value: '**docstring**' }))
      .toMatchObject({ value: '**docstring**' });
    expect(client.lspToMonacoMarkdown(undefined)).toBeUndefined();
  });
});
