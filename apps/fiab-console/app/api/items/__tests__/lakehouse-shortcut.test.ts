/**
 * Backend contract tests for the standalone lakehouse-shortcut item route —
 * WS-3.2 zero-copy shortcuts engine. A Tables shortcut must register a REAL
 * external table/view (Synapse Serverless / Databricks UC) so the lakehouse SQL
 * endpoint queries it zero-copy; Files shortcuts stay pointers; DELETE drops the
 * engine object (never the source bytes); the `query` action reads in place.
 * No Fabric REST on any path.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/auth/session', () => ({ getSession: vi.fn() }));
vi.mock('@/lib/auth/workspace-guard', () => ({ assertOwner: vi.fn(async () => true) }));

const created: any[] = [];
const store = new Map<string, any>();
vi.mock('@/lib/azure/cosmos-client', () => ({
  workspacesContainer: vi.fn(async () => ({
    item: (id: string, pk: string) => ({ read: async () => ({ resource: { id, tenantId: pk } }) }),
  })),
  itemsContainer: vi.fn(async () => ({
    items: {
      create: vi.fn(async (doc: any) => { created.push(doc); store.set(doc.id, doc); return { resource: doc }; }),
      query: () => ({ fetchAll: async () => ({ resources: [...store.values()] }) }),
    },
    item: (id: string) => ({
      read: async () => ({ resource: store.get(id) }),
      delete: async () => { store.delete(id); return {}; },
    }),
  })),
}));
vi.mock('@/lib/azure/adls-client', () => ({
  getAccountName: vi.fn(() => 'loomlake'),
  hasConfiguredContainers: vi.fn(() => true),
}));
vi.mock('@/lib/azure/shortcut-client', () => {
  class ShortcutSourceError extends Error { code?: string; status?: number; }
  return {
    ShortcutSourceError,
    browseAdls: vi.fn(async () => ({ entries: [{ name: 'part-0.parquet', isDirectory: false, size: 10 }] })),
    listS3Objects: vi.fn(async () => ({ entries: [] })),
    listGcsObjects: vi.fn(async () => ({ entries: [] })),
    listAdlsWithSas: vi.fn(async () => ({ entries: [] })),
    listDataverseEntities: vi.fn(async () => ({ entries: [] })),
  };
});
vi.mock('@/lib/azure/kv-secrets-client', () => ({
  putShortcutSecret: vi.fn(async (name: string) => ({ name })),
  deleteShortcutSecret: vi.fn(async () => {}),
  shortcutKeyVaultConfigGate: vi.fn(() => null),
}));
vi.mock('@/lib/azure/shortcut-engines', () => ({
  pickTablesEngine: vi.fn(() => 'synapse'),
  createTablesShortcut: vi.fn(async () => ({ engine: 'synapse', engineObject: 'loom_lakehouse.shortcuts.sc_x' })),
  dropShortcutObject: vi.fn(async () => {}),
  dropExternalBinding: vi.fn(async () => {}),
  bindExternalSource: vi.fn(async () => ({ readUri: 's3://b/p', ucExternalLocation: 'loc', synapse: { dataSource: 'ds' } })),
}));
vi.mock('@/lib/azure/synapse-sql-client', () => ({
  serverlessTarget: vi.fn((db: string) => ({ db })),
  executeQuery: vi.fn(async () => ({ columns: ['id', 'name'], rows: [[1, 'a'], [2, 'b']], rowCount: 2 })),
}));

import { POST, DELETE } from '../lakehouse-shortcut/route';
import { getSession } from '@/lib/auth/session';
import { pickTablesEngine, createTablesShortcut, dropShortcutObject } from '@/lib/azure/shortcut-engines';
import { executeQuery } from '@/lib/azure/synapse-sql-client';

const sess = { claims: { oid: 'ws1', upn: 'u@x', email: 'u@x' } };
const req = (body: any, qs = 'workspaceId=ws1') => ({
  nextUrl: { searchParams: new URLSearchParams(qs) },
  json: async () => body,
} as any);
const delReq = (qs: string) => ({ nextUrl: { searchParams: new URLSearchParams(qs) } } as any);

beforeEach(() => {
  created.length = 0; store.clear();
  vi.clearAllMocks();
  (getSession as any).mockReturnValue(sess);
  (pickTablesEngine as any).mockReturnValue('synapse');
  (createTablesShortcut as any).mockResolvedValue({ engine: 'synapse', engineObject: 'loom_lakehouse.shortcuts.sc_x' });
  (executeQuery as any).mockResolvedValue({ columns: ['id', 'name'], rows: [[1, 'a'], [2, 'b']], rowCount: 2 });
  process.env.LOOM_SYNAPSE_WORKSPACE = 'syn-ws';
});

describe('POST create — Files vs Tables', () => {
  it('creates an internal Files shortcut (no engine object)', async () => {
    const res = await POST(req({ displayName: 'raw', sourceType: 'internal', kind: 'files', container: 'silver', path: 'orders/' }));
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.shortcut.kind).toBe('files');
    expect(j.shortcut.engineObject).toBeUndefined();
    expect(createTablesShortcut).not.toHaveBeenCalled();
  });

  it('creates an internal Tables shortcut → registers a zero-copy engine object', async () => {
    const res = await POST(req({ displayName: 'orders', sourceType: 'internal', kind: 'tables', format: 'delta', container: 'silver', path: 'orders/' }));
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(createTablesShortcut).toHaveBeenCalledTimes(1);
    expect(j.engineObject).toBe('loom_lakehouse.shortcuts.sc_x');
    expect(j.shortcut.kind).toBe('tables');
    expect(j.shortcut.engine).toBe('synapse');
    expect(created[0].state.engineObject).toBe('loom_lakehouse.shortcuts.sc_x');
    expect(created[0].state.engineStatus).toBe('active');
  });

  it('honest-gates a Tables shortcut with no query engine (503, pointer still created)', async () => {
    (pickTablesEngine as any).mockReturnValue(null);
    const res = await POST(req({ displayName: 'orders', sourceType: 'internal', kind: 'tables', format: 'delta', container: 'silver', path: 'orders/' }));
    expect(res.status).toBe(503);
    const j = await res.json();
    expect(j.code).toBe('no_tables_engine');
    expect(j.shortcut.engineStatus).toBe('pending');
    expect(createTablesShortcut).not.toHaveBeenCalled();
  });
});

describe('POST action=query — zero-copy read of a Tables shortcut', () => {
  it('runs SELECT over the engine object through the serverless endpoint', async () => {
    const c = await POST(req({ displayName: 'orders', sourceType: 'internal', kind: 'tables', format: 'delta', container: 'silver', path: 'orders/' }));
    const cj = await c.json();
    const id = cj.shortcut.id;
    const res = await POST(req({ action: 'query', id, top: 100 }));
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.engineObject).toBe('loom_lakehouse.shortcuts.sc_x');
    expect(j.columns).toEqual(['id', 'name']);
    expect(j.rows).toHaveLength(2);
    // the query is a SELECT over the 3-part engine object — read in place
    expect((executeQuery as any).mock.calls[0][1]).toContain('FROM loom_lakehouse.shortcuts.sc_x');
  });

  it('400 when the shortcut is a Files pointer (not queryable)', async () => {
    const c = await POST(req({ displayName: 'raw', sourceType: 'internal', kind: 'files', container: 'silver', path: 'orders/' }));
    const id = (await c.json()).shortcut.id;
    const res = await POST(req({ action: 'query', id }));
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('not_queryable');
  });
});

describe('DELETE — drops the engine object, never the source bytes', () => {
  it('drops the Synapse view then deletes the pointer', async () => {
    const c = await POST(req({ displayName: 'orders', sourceType: 'internal', kind: 'tables', format: 'delta', container: 'silver', path: 'orders/' }));
    const id = (await c.json()).shortcut.id;
    const res = await DELETE(delReq(`workspaceId=ws1&id=${id}`));
    expect((await res.json()).ok).toBe(true);
    expect(dropShortcutObject).toHaveBeenCalledWith({ engine: 'synapse', engineObject: 'loom_lakehouse.shortcuts.sc_x' });
    expect(store.has(id)).toBe(false);
  });
});
