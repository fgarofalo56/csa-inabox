/**
 * Unit tests for the @loom chat participant core (Phase 4). Pure logic, no VS
 * Code host. Cover routing, and the two behaviours the task calls out:
 *   • honest-gate when unconfigured / signed out — NO backend call, NO
 *     fabricated answer (the mutation-proof), and
 *   • grounded results derived from the REAL backend response.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  routeChatRequest,
  parseItemRef,
  runChatTurn,
  renderGrid,
  type ChatApi,
  type ChatStream,
} from '../src/chat/chat-core';
import type { CatalogSearchResult, Item, QueryResult } from '@csa-loom/sdk';

function collector(): ChatStream & { md: string[]; progressMsgs: string[]; buttons: Array<{ command: string }> } {
  const md: string[] = [];
  const progressMsgs: string[] = [];
  const buttons: Array<{ command: string }> = [];
  return {
    md,
    progressMsgs,
    buttons,
    markdown: (m) => md.push(m),
    progress: (m) => progressMsgs.push(m),
    button: (a) => buttons.push({ command: a.command }),
  } as never;
}

const DEP = { id: 'a', name: 'Commercial', cloud: 'commercial' };

describe('routeChatRequest', () => {
  it('maps commands to intents', () => {
    expect(routeChatRequest('help', '')).toEqual({ kind: 'help' });
    expect(routeChatRequest('find', 'sales')).toEqual({ kind: 'find', query: 'sales' });
    expect(routeChatRequest('item', 'lakehouse/abc')).toEqual({ kind: 'item', itemType: 'lakehouse', itemId: 'abc' });
    expect(routeChatRequest('preview', 'dataset/xyz')).toEqual({ kind: 'preview', itemType: 'dataset', itemId: 'xyz' });
  });

  it('parses a /query with :: separator', () => {
    expect(routeChatRequest('query', 'warehouse/w1 :: SELECT 1')).toEqual({
      kind: 'query',
      itemType: 'warehouse',
      itemId: 'w1',
      sql: 'SELECT 1',
    });
  });

  it('freeform text → catalog find; empty → help', () => {
    expect(routeChatRequest(undefined, 'what lakehouses do I have')).toEqual({
      kind: 'find',
      query: 'what lakehouses do I have',
    });
    expect(routeChatRequest(undefined, '   ')).toEqual({ kind: 'help' });
  });

  it('malformed args → usage (not a backend error)', () => {
    expect(routeChatRequest('item', 'not-a-known-type/abc').kind).toBe('usage');
    expect(routeChatRequest('query', 'warehouse/w1').kind).toBe('usage'); // no SQL
  });
});

describe('parseItemRef', () => {
  it('accepts type/id and type id, validating the type', () => {
    expect(parseItemRef('lakehouse/abc')).toEqual({ itemType: 'lakehouse', itemId: 'abc', rest: '' });
    expect(parseItemRef('warehouse w1 SELECT 1')).toEqual({ itemType: 'warehouse', itemId: 'w1', rest: 'SELECT 1' });
    expect(parseItemRef('bogustype/abc')).toBeUndefined();
    expect(parseItemRef('')).toBeUndefined();
  });
});

describe('runChatTurn — honest gate (no backend call, no fabrication)', () => {
  it('no configured deployment → Add-deployment gate, resolver never called', async () => {
    const s = collector();
    const resolveApi = vi.fn(async () => undefined);
    const res = await runChatTurn({ prompt: 'anything', deployment: undefined, resolveApi, stream: s });
    expect(res.kind).toBe('gate');
    expect(res.grounded).toBe(false);
    expect(resolveApi).not.toHaveBeenCalled();
    expect(s.buttons.map((b) => b.command)).toContain('loom.addDeployment');
    expect(s.md.join('\n')).toMatch(/Add one|configured/i);
  });

  it('MUTATION-PROOF: signed-out deployment → Sign-in gate, backend NEVER called', async () => {
    const s = collector();
    // resolveApi yields undefined (no session). If the `if(!api) return gate`
    // guard were removed, the code would call api.catalogSearch on `undefined`
    // and throw — the assertions below (gate kind + "Sign in" text) would FAIL.
    const resolveApi = vi.fn(async () => undefined);
    const res = await runChatTurn({ prompt: 'sales', deployment: DEP, resolveApi, stream: s });
    expect(res.kind).toBe('gate');
    expect(res.grounded).toBe(false);
    expect(s.buttons.map((b) => b.command)).toContain('loom.signIn');
    expect(s.md.join('\n')).toMatch(/Sign in|live data/i);
  });
});

describe('runChatTurn — grounded on the real backend', () => {
  const findResult: CatalogSearchResult = {
    ok: true,
    total: 1,
    hits: [
      { source: 'purview', id: 'lk1', display_name: 'Bronze Lakehouse', type: 'lakehouse', workspace_name: 'Analytics' },
    ],
  };

  function apiWith(overrides: Partial<ChatApi> = {}): ChatApi {
    return {
      catalogSearch: vi.fn(async () => findResult),
      getItem: vi.fn(async () => ({ id: 'i1', workspaceId: 'w1', itemType: 'lakehouse', displayName: 'X' }) as Item),
      querySql: vi.fn(async () => ({ ok: true, columns: ['n'], rows: [{ n: 1 }], rowCount: 1 }) as QueryResult),
      preview: vi.fn(async () => ({ ok: true, columns: ['c'], rows: [{ c: 'v' }] }) as QueryResult),
      ...overrides,
    };
  }

  it('MUTATION-PROOF: freeform question streams data DERIVED from the backend hit', async () => {
    const s = collector();
    const api = apiWith();
    const res = await runChatTurn({ prompt: 'lakehouses', deployment: DEP, resolveApi: async () => api, stream: s });
    expect(res).toEqual({ kind: 'find', grounded: true });
    expect(api.catalogSearch).toHaveBeenCalledWith('lakehouses', { limit: 25 });
    // The streamed answer must contain the backend-returned name — proving it is
    // grounded, not fabricated. If the handler ignored `res` and printed canned
    // text, "Bronze Lakehouse" would be absent and this FAILS.
    expect(s.md.join('\n')).toContain('Bronze Lakehouse');
  });

  it('empty catalog result → honest "no matches", still grounded', async () => {
    const s = collector();
    const api = apiWith({ catalogSearch: vi.fn(async () => ({ ok: true, hits: [] }) as CatalogSearchResult) });
    const res = await runChatTurn({ command: 'find', prompt: 'zzz', deployment: DEP, resolveApi: async () => api, stream: s });
    expect(res.grounded).toBe(true);
    expect(s.md.join('\n')).toMatch(/No catalog matches/i);
  });

  it('/item renders backend metadata and offers Open in Console', async () => {
    const s = collector();
    const item: Item = { id: 'i1', workspaceId: 'w1', itemType: 'lakehouse', displayName: 'Bronze', state: { foo: 1, secretRef: 'x' } };
    const api = apiWith({ getItem: vi.fn(async () => item) });
    const res = await runChatTurn({ command: 'item', prompt: 'lakehouse/i1', deployment: DEP, resolveApi: async () => api, stream: s });
    expect(res.kind).toBe('item');
    expect(api.getItem).toHaveBeenCalledWith('lakehouse', 'i1');
    const out = s.md.join('\n');
    expect(out).toContain('Bronze');
    expect(out).toContain('foo'); // definition KEY listed…
    expect(s.buttons.map((b) => b.command)).toContain('loom.openInConsole');
  });

  it('/query renders a grid grounded on the query result', async () => {
    const s = collector();
    const api = apiWith({
      querySql: vi.fn(async () => ({ ok: true, columns: [{ name: 'amt', type: 'int' }], rows: [{ amt: 42 }], rowCount: 1 }) as QueryResult),
    });
    const res = await runChatTurn({ command: 'query', prompt: 'warehouse/w1 :: SELECT amt', deployment: DEP, resolveApi: async () => api, stream: s });
    expect(res.kind).toBe('query');
    expect(api.querySql).toHaveBeenCalledWith('warehouse', 'w1', 'SELECT amt');
    expect(s.md.join('\n')).toContain('42');
  });

  it('backend error surfaces honestly, never a fabricated answer', async () => {
    const s = collector();
    const err = Object.assign(new Error('AI Search not provisioned'), { status: 503, hint: 'set LOOM_AI_SEARCH_SERVICE' });
    const api = apiWith({ catalogSearch: vi.fn(async () => { throw err; }) });
    const res = await runChatTurn({ prompt: 'x', deployment: DEP, resolveApi: async () => api, stream: s });
    expect(res.grounded).toBe(true);
    const out = s.md.join('\n');
    expect(out).toContain('503');
    expect(out).toContain('set LOOM_AI_SEARCH_SERVICE');
  });
});

describe('renderGrid', () => {
  it('renders columns (with type badge), caps rows, and shows timing', () => {
    const res: QueryResult = { ok: true, columns: [{ name: 'a', type: 'int' }], rows: [{ a: 1 }, { a: 2 }, { a: 3 }], rowCount: 3 };
    const md = renderGrid(res, 12, 2);
    expect(md).toContain('a `int`');
    expect(md).toContain('12 ms');
    expect(md).toMatch(/capped/); // 3 rows, cap 2 → truncated note
  });
});
