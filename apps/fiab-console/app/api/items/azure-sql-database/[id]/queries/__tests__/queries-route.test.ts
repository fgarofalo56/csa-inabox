/**
 * BFF contract tests for the saved-queries route:
 *   GET/POST/DELETE /api/items/azure-sql-database/[id]/queries
 *
 * Verifies: auth gate (401), item-not-found (404), non-member gate (403),
 * private vs shared visibility by role, shared-write Viewer block (403),
 * upsert ownership gate, and the bulk-delete receipt (deleted/before/after)
 * with ownership filtering. Cosmos containers + workspace-roles are stubbed.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/auth/session', () => ({ getSession: vi.fn() }));
vi.mock('@/lib/azure/cosmos-client', () => ({
  itemsContainer: vi.fn(),
  workspacesContainer: vi.fn(),
  savedQueriesContainer: vi.fn(),
}));
vi.mock('@/lib/azure/workspace-roles-client', () => ({ resolveEffectiveRole: vi.fn() }));
// Mock the cosmos SDK so the route's `BulkOperationType` import does not pull
// in the real ESM package (its transitive @azure deps don't resolve through the
// worktree junction). The route only consumes the enum.
vi.mock('@azure/cosmos', () => ({
  BulkOperationType: { Create: 'Create', Upsert: 'Upsert', Read: 'Read', Delete: 'Delete', Replace: 'Replace', Patch: 'Patch' },
}));

import { GET, POST, DELETE } from '../route';
import { getSession } from '@/lib/auth/session';
import { itemsContainer, workspacesContainer, savedQueriesContainer } from '@/lib/azure/cosmos-client';
import { resolveEffectiveRole } from '@/lib/azure/workspace-roles-client';

const ITEM_ID = 'item-sql-1';
const WS_ID = 'ws-1';
const OWNER = 'owner-oid';
const MEMBER = 'member-oid';
const ctx = { params: Promise.resolve({ id: ITEM_ID }) };

function queryOnly(resources: any[]) {
  return { items: { query: () => ({ fetchAll: async () => ({ resources }) }) } };
}
function bodyReq(body: any) { return { json: async () => body } as any; }
const getReq = { url: `http://x/api/items/azure-sql-database/${ITEM_ID}/queries` } as any;

// A saved-queries container whose query() returns whatever the supplied
// resolver yields for the given SQL text (lets one mock serve the list query,
// the targeted-id query, and the before/after count queries).
function savedQueriesMock(opts: {
  rows: () => any[];
  onCreate?: (doc: any) => void;
  onUpsert?: (doc: any) => void;
  onRead?: (id: string) => any;
  onBulk?: (ops: any[]) => void;
}) {
  return {
    item: (id: string) => ({
      read: async () => ({ resource: opts.onRead ? opts.onRead(id) : undefined }),
    }),
    items: {
      query: (spec: any) => ({
        fetchAll: async () => {
          const text: string = typeof spec === 'string' ? spec : spec.query;
          // ARRAY_CONTAINS = the targeted-ids authorization query.
          if (text.includes('ARRAY_CONTAINS')) return { resources: opts.rows() };
          // SELECT c.id ... = before/after count query.
          if (text.includes('SELECT c.id')) return { resources: opts.rows() };
          // SELECT * ... = the GET list query.
          return { resources: opts.rows() };
        },
      }),
      create: async (doc: any) => { opts.onCreate?.(doc); return { resource: doc }; },
      upsert: async (doc: any) => { opts.onUpsert?.(doc); return { resource: doc }; },
      executeBulkOperations: async (ops: any[]) => { opts.onBulk?.(ops); return ops.map(() => ({ statusCode: 204 })); },
    },
  };
}

beforeEach(() => { vi.resetAllMocks(); });

describe('GET saved queries', () => {
  it('401 without a session', async () => {
    (getSession as any).mockReturnValue(null);
    const res = await GET(getReq, ctx);
    expect(res.status).toBe(401);
  });

  it('404 when the item is unknown', async () => {
    (getSession as any).mockReturnValue({ claims: { oid: OWNER } });
    (itemsContainer as any).mockResolvedValue(queryOnly([])); // no workspace
    const res = await GET(getReq, ctx);
    expect(res.status).toBe(404);
  });

  it('403 for a non-member (no role, not owner)', async () => {
    (getSession as any).mockReturnValue({ claims: { oid: 'stranger' } });
    (itemsContainer as any).mockResolvedValue(queryOnly([{ workspaceId: WS_ID }]));
    (workspacesContainer as any).mockResolvedValue(queryOnly([{ tenantId: OWNER }]));
    (resolveEffectiveRole as any).mockResolvedValue(null);
    const res = await GET(getReq, ctx);
    expect(res.status).toBe(403);
  });

  it('owner sees own private + shared (callerRole Admin)', async () => {
    (getSession as any).mockReturnValue({ claims: { oid: OWNER } });
    (itemsContainer as any).mockResolvedValue(queryOnly([{ workspaceId: WS_ID }]));
    (workspacesContainer as any).mockResolvedValue(queryOnly([{ tenantId: OWNER }]));
    const rows = [
      { id: 'q1', scope: 'private', ownerId: OWNER },
      { id: 'q2', scope: 'private', ownerId: MEMBER },   // someone else's private — hidden
      { id: 'q3', scope: 'shared', ownerId: MEMBER },
    ];
    (savedQueriesContainer as any).mockResolvedValue(savedQueriesMock({ rows: () => rows }));
    const res = await GET(getReq, ctx);
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.callerRole).toBe('Admin');
    expect(j.queries.map((q: any) => q.id).sort()).toEqual(['q1', 'q3']);
  });

  it('Viewer sees own private but NOT shared', async () => {
    (getSession as any).mockReturnValue({ claims: { oid: MEMBER } });
    (itemsContainer as any).mockResolvedValue(queryOnly([{ workspaceId: WS_ID }]));
    (workspacesContainer as any).mockResolvedValue(queryOnly([{ tenantId: OWNER }]));
    (resolveEffectiveRole as any).mockResolvedValue('Viewer');
    const rows = [
      { id: 'q1', scope: 'private', ownerId: MEMBER },
      { id: 'q3', scope: 'shared', ownerId: OWNER },
    ];
    (savedQueriesContainer as any).mockResolvedValue(savedQueriesMock({ rows: () => rows }));
    const res = await GET(getReq, ctx);
    const j = await res.json();
    expect(j.callerRole).toBe('Viewer');
    expect(j.queries.map((q: any) => q.id)).toEqual(['q1']);
  });

  it('second member (Member role) sees the shared query', async () => {
    (getSession as any).mockReturnValue({ claims: { oid: MEMBER } });
    (itemsContainer as any).mockResolvedValue(queryOnly([{ workspaceId: WS_ID }]));
    (workspacesContainer as any).mockResolvedValue(queryOnly([{ tenantId: OWNER }]));
    (resolveEffectiveRole as any).mockResolvedValue('Member');
    const rows = [{ id: 'q3', scope: 'shared', ownerId: OWNER }];
    (savedQueriesContainer as any).mockResolvedValue(savedQueriesMock({ rows: () => rows }));
    const res = await GET(getReq, ctx);
    const j = await res.json();
    expect(j.queries.map((q: any) => q.id)).toEqual(['q3']);
  });
});

describe('POST saved query', () => {
  it('400 when name/sql missing', async () => {
    (getSession as any).mockReturnValue({ claims: { oid: OWNER } });
    (itemsContainer as any).mockResolvedValue(queryOnly([{ workspaceId: WS_ID }]));
    (workspacesContainer as any).mockResolvedValue(queryOnly([{ tenantId: OWNER }]));
    const res = await POST(bodyReq({ name: '', sql: '', scope: 'private' }), ctx);
    expect(res.status).toBe(400);
  });

  it('Viewer cannot create a shared query (403)', async () => {
    (getSession as any).mockReturnValue({ claims: { oid: MEMBER } });
    (itemsContainer as any).mockResolvedValue(queryOnly([{ workspaceId: WS_ID }]));
    (workspacesContainer as any).mockResolvedValue(queryOnly([{ tenantId: OWNER }]));
    (resolveEffectiveRole as any).mockResolvedValue('Viewer');
    const res = await POST(bodyReq({ name: 'X', sql: 'SELECT 1', scope: 'shared' }), ctx);
    expect(res.status).toBe(403);
  });

  it('creates a private query (201) with sq: id + ownerId', async () => {
    (getSession as any).mockReturnValue({ claims: { oid: OWNER, upn: 'owner@contoso.com' } });
    (itemsContainer as any).mockResolvedValue(queryOnly([{ workspaceId: WS_ID }]));
    (workspacesContainer as any).mockResolvedValue(queryOnly([{ tenantId: OWNER }]));
    let created: any;
    (savedQueriesContainer as any).mockResolvedValue(savedQueriesMock({ rows: () => [], onCreate: (d) => { created = d; } }));
    const res = await POST(bodyReq({ name: 'Top', sql: 'SELECT 1', scope: 'private' }), ctx);
    expect(res.status).toBe(201);
    expect(created.id.startsWith('sq:')).toBe(true);
    expect(created.ownerId).toBe(OWNER);
    expect(created.scope).toBe('private');
    expect(created.itemId).toBe(ITEM_ID);
    expect(created.workspaceId).toBe(WS_ID);
  });

  it('non-owner non-admin cannot update someone else query (403)', async () => {
    (getSession as any).mockReturnValue({ claims: { oid: MEMBER } });
    (itemsContainer as any).mockResolvedValue(queryOnly([{ workspaceId: WS_ID }]));
    (workspacesContainer as any).mockResolvedValue(queryOnly([{ tenantId: OWNER }]));
    (resolveEffectiveRole as any).mockResolvedValue('Member');
    (savedQueriesContainer as any).mockResolvedValue(savedQueriesMock({
      rows: () => [],
      onRead: () => ({ id: 'q1', itemId: ITEM_ID, ownerId: OWNER, scope: 'private' }),
    }));
    const res = await POST(bodyReq({ queryId: 'q1', name: 'X', sql: 'SELECT 1', scope: 'private' }), ctx);
    expect(res.status).toBe(403);
  });
});

describe('DELETE saved queries (bulk)', () => {
  it('400 when queryIds is empty', async () => {
    (getSession as any).mockReturnValue({ claims: { oid: OWNER } });
    (itemsContainer as any).mockResolvedValue(queryOnly([{ workspaceId: WS_ID }]));
    (workspacesContainer as any).mockResolvedValue(queryOnly([{ tenantId: OWNER }]));
    const res = await DELETE(bodyReq({ queryIds: [] }), ctx);
    expect(res.status).toBe(400);
  });

  it('deletes exactly the owner-permitted rows; receipt before/after', async () => {
    (getSession as any).mockReturnValue({ claims: { oid: OWNER } });
    (itemsContainer as any).mockResolvedValue(queryOnly([{ workspaceId: WS_ID }]));
    (workspacesContainer as any).mockResolvedValue(queryOnly([{ tenantId: OWNER }]));
    // Partition holds 3 rows before; we target q1+q2 (both owned by OWNER).
    let phase: 'before' | 'after' = 'before';
    const all = [
      { id: 'q1', ownerId: OWNER },
      { id: 'q2', ownerId: OWNER },
      { id: 'q3', ownerId: MEMBER },
    ];
    let bulkOps: any[] = [];
    const mock = {
      item: () => ({ read: async () => ({ resource: undefined }) }),
      items: {
        query: (spec: any) => ({
          fetchAll: async () => {
            const text: string = spec.query;
            if (text.includes('ARRAY_CONTAINS')) {
              // targeted authorization rows (q1, q2)
              return { resources: [{ id: 'q1', ownerId: OWNER }, { id: 'q2', ownerId: OWNER }] };
            }
            // before/after count query
            if (phase === 'before') { phase = 'after'; return { resources: all }; }
            return { resources: [{ id: 'q3', ownerId: MEMBER }] };
          },
        }),
        executeBulkOperations: async (ops: any[]) => { bulkOps = ops; return ops.map(() => ({ statusCode: 204 })); },
      },
    };
    (savedQueriesContainer as any).mockResolvedValue(mock);
    const res = await DELETE(bodyReq({ queryIds: ['q1', 'q2'] }), ctx);
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.deleted).toBe(2);
    expect(j.before).toBe(3);
    expect(j.after).toBe(1);
    expect(bulkOps).toHaveLength(2);
    expect(bulkOps.every((o) => o.operationType === 'Delete')).toBe(true);
  });

  it('403 when none of the targeted rows are deletable by the caller', async () => {
    (getSession as any).mockReturnValue({ claims: { oid: MEMBER } });
    (itemsContainer as any).mockResolvedValue(queryOnly([{ workspaceId: WS_ID }]));
    (workspacesContainer as any).mockResolvedValue(queryOnly([{ tenantId: OWNER }]));
    (resolveEffectiveRole as any).mockResolvedValue('Member'); // not Admin
    const mock = {
      item: () => ({ read: async () => ({ resource: undefined }) }),
      items: {
        query: (spec: any) => ({
          fetchAll: async () => {
            const text: string = spec.query;
            if (text.includes('ARRAY_CONTAINS')) return { resources: [{ id: 'q1', ownerId: OWNER }] };
            return { resources: [{ id: 'q1', ownerId: OWNER }] };
          },
        }),
        executeBulkOperations: async () => { throw new Error('should not delete'); },
      },
    };
    (savedQueriesContainer as any).mockResolvedValue(mock);
    const res = await DELETE(bodyReq({ queryIds: ['q1'] }), ctx);
    expect(res.status).toBe(403);
  });
});
