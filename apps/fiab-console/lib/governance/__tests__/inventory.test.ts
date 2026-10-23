/**
 * inventory - workspace_list / item_list / governance_inventory (W1).
 *
 * Mocks sit at the Cosmos + auth boundary; the fake containers INTERPRET the
 * queries the code sends (IN lists, @t filter, `c.state[..] AS kN` projections,
 * @tid), so a query that reads the wrong workspaces or projects the wrong path
 * returns the wrong rows. Each test names the input that breaks it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const h = vi.hoisted(() => ({
  checkCapability: vi.fn(),
  ambientAccessOptsFor: vi.fn(),
  listAccessibleWorkspaces: vi.fn(),
  resolveWorkspaceAccessByOid: vi.fn(),
  emitAuditEvent: vi.fn(),
  itemQueries: [] as Array<{ query: string; parameters: Array<{ name: string; value: string }>; options?: unknown }>,
  wsQueries: [] as Array<{ query: string; parameters: Array<{ name: string; value: string }> }>,
  items: [] as any[],
  workspaces: [] as any[],
  itemsFail: null as Error | null,
  wsFail: null as Error | null,
}));

vi.mock('@/lib/auth/feature-gate', () => ({ checkCapability: (...a: any[]) => h.checkCapability(...a) }));
vi.mock('@/lib/auth/workspace-access', () => ({
  ambientAccessOptsFor: (...a: any[]) => h.ambientAccessOptsFor(...a),
  listAccessibleWorkspaces: (...a: any[]) => h.listAccessibleWorkspaces(...a),
  resolveWorkspaceAccessByOid: (...a: any[]) => h.resolveWorkspaceAccessByOid(...a),
}));
vi.mock('@/lib/admin/audit-stream', () => ({ emitAuditEvent: (...a: any[]) => h.emitAuditEvent(...a) }));
vi.mock('@/lib/azure/cosmos-client', () => ({
  itemsContainer: async () => ({
    items: {
      query: (spec: any, options?: any) => ({
        fetchAll: async () => {
          h.itemQueries.push({ query: spec.query, parameters: spec.parameters, options });
          if (h.itemsFail) throw h.itemsFail;
          const p = new Map<string, string>(spec.parameters.map((x: any) => [x.name, x.value]));
          const inList = /IN \(([^)]*)\)/.exec(spec.query)![1].split(',').map((s: string) => p.get(s.trim()));
          const projections = [...spec.query.matchAll(/c\.state((?:\["[^"]+"\])+) AS (k\d+)/g)].map((m) => ({
            alias: m[2],
            segs: [...m[1].matchAll(/\["([^"]+)"\]/g)].map((s) => s[1]),
          }));
          const wantType = p.get('@t');
          const out = h.items
            .filter((it) => inList.includes(it.workspaceId))
            .filter((it) => !it.state?._recycled)
            .filter((it) => (wantType ? it.itemType === wantType : true))
            .map((it) => {
              const row: any = { id: it.id, workspaceId: it.workspaceId, itemType: it.itemType, displayName: it.displayName };
              for (const pr of projections) {
                let v: any = it.state;
                for (const s of pr.segs) v = v?.[s];
                if (v !== undefined) row[pr.alias] = v;
              }
              return row;
            });
          return { resources: out };
        },
      }),
    },
  }),
  workspacesContainer: async () => ({
    items: {
      query: (spec: any) => ({
        fetchAll: async () => {
          h.wsQueries.push({ query: spec.query, parameters: spec.parameters });
          if (h.wsFail) throw h.wsFail;
          const tid = spec.parameters.find((x: any) => x.name === '@tid')?.value;
          return { resources: h.workspaces.filter((w) => w.tid === tid) };
        },
      }),
    },
  }),
}));

import { governanceInventoryTool, itemListTool, workspaceListTool, NOT_RECYCLED_SQL } from '../inventory';
import { registerGovernanceInventoryTool } from '../inventory-tool';
import { TOOL_LOOP_CHAR_CAP } from '../inventory-envelope';

const ME = 'oid-me';
const TID = 'tid-1';
const ctx = { userOid: ME, session: { claims: { oid: ME, upn: 'me@example.test' } } };

const ws = (id: string, name: string, owner: string, tid = TID, domain?: string) => ({
  id, name, tenantId: owner, ownerOid: owner, tid, ...(domain ? { domain } : {}),
});
const WS_OWNED = ws('ws-owned', 'Owned', ME, TID, 'dom-a');
const WS_SHARED = ws('ws-shared', 'Shared', 'oid-other', TID);
const WS_OTHER_USER = ws('ws-other-user', 'Other user private', 'oid-other', TID); // same tenant, not accessible to ME
const WS_FOREIGN_TENANT = ws('ws-foreign', 'Foreign tenant', 'oid-x', 'tid-FOREIGN');

const item = (id: string, workspaceId: string, itemType = 'lakehouse', displayName = `Item ${id}`, state: any = {}) => ({
  id, workspaceId, itemType, displayName, state,
});

beforeEach(() => {
  vi.clearAllMocks();
  h.emitAuditEvent.mockReset(); // clearAllMocks keeps implementations; one test makes it throw
  h.itemQueries.length = 0;
  h.wsQueries.length = 0;
  h.items = [];
  h.workspaces = [WS_OWNED, WS_SHARED, WS_OTHER_USER, WS_FOREIGN_TENANT];
  h.itemsFail = null;
  h.wsFail = null;
  h.checkCapability.mockResolvedValue({ allow: false });
  h.ambientAccessOptsFor.mockResolvedValue({ callerTid: TID, tenantAdmin: false });
  h.listAccessibleWorkspaces.mockResolvedValue([WS_OWNED, WS_SHARED]);
  h.resolveWorkspaceAccessByOid.mockResolvedValue(null);
});

const asAdmin = () => h.checkCapability.mockResolvedValue({ allow: true });

describe('workspace_list - visibility (the owner-only defect)', () => {
  it('default scope returns owned AND shared workspaces, and not another user\'s private one', async () => {
    const r: any = await workspaceListTool(ctx, {});
    // Break value: the old listOwnedWorkspaces(oid) returns only WS_OWNED (tenantId === oid).
    expect(r.workspaces.map((w: any) => w.id).sort()).toEqual(['ws-owned', 'ws-shared']);
    expect(r.workspaces.find((w: any) => w.id === 'ws-owned')).toMatchObject({ relationship: 'owned', domainId: 'dom-a' });
    expect(r.workspaces.find((w: any) => w.id === 'ws-shared').relationship).toBe('shared');
    expect(r).toMatchObject({ ok: true, scope: 'mine', total: 2, returned: 2, truncated: false, nextCursor: null });
    expect(h.wsQueries).toHaveLength(0); // the tenant fan-out did not run
  });

  it('scope:tenant for a tenant admin returns workspaces the caller does not own, bounded to the caller tenant', async () => {
    asAdmin();
    const r: any = await workspaceListTool(ctx, { scope: 'tenant' });
    const ids = r.workspaces.map((w: any) => w.id).sort();
    // Break value: dropping the tid predicate would add ws-foreign.
    expect(ids).toEqual(['ws-other-user', 'ws-owned', 'ws-shared']);
    expect(ids).not.toContain('ws-foreign');
    expect(h.wsQueries).toHaveLength(1);
    expect(h.wsQueries[0].parameters).toEqual([{ name: '@tid', value: TID }]);
    expect(r.workspaces.find((w: any) => w.id === 'ws-other-user')).toMatchObject({ relationship: 'tenant', ownerOid: 'oid-other' });
    expect(r.scopeNote).toContain('excluded');
  });

  it('the default scope does NOT widen for an admin who did not ask for tenant (admin default is still "mine")', async () => {
    asAdmin();
    const r: any = await workspaceListTool(ctx, {});
    expect(r.workspaces.map((w: any) => w.id)).not.toContain('ws-other-user');
    expect(h.wsQueries).toHaveLength(0);
    expect(h.emitAuditEvent).not.toHaveBeenCalled();
  });
});

describe('scope:tenant authorization (D10)', () => {
  it('a non-admin asking for tenant is REFUSED - no rows, no silent downgrade to mine - and the refusal is audited', async () => {
    const r: any = await workspaceListTool(ctx, { scope: 'tenant' });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('admin_only');
    expect(r.error).toMatch(/tenant admins only/);
    // Break value: a downgrade-to-mine implementation would return workspaces here.
    expect(r.workspaces).toBeUndefined();
    expect(h.listAccessibleWorkspaces).not.toHaveBeenCalled();
    expect(h.wsQueries).toHaveLength(0);
    expect(h.emitAuditEvent).toHaveBeenCalledTimes(1);
    expect(h.emitAuditEvent.mock.calls[0][0]).toMatchObject({ actorOid: ME, outcome: 'denied', action: 'copilot.workspace_list.tenant' });
  });

  it('item_list and governance_inventory refuse a non-admin the same way, with their own action names', async () => {
    const a: any = await itemListTool(ctx, { scope: 'tenant' });
    const b: any = await governanceInventoryTool(ctx, { scope: 'tenant' });
    expect(a.code).toBe('admin_only');
    expect(b.code).toBe('admin_only');
    expect(a.items).toBeUndefined();
    expect(b.items).toBeUndefined();
    expect(h.itemQueries).toHaveLength(0);
    expect(h.emitAuditEvent.mock.calls.map((c) => c[0].action)).toEqual(['copilot.item_list.tenant', 'governance.inventory']);
  });

  it('an admin tenant call writes exactly ONE audit event carrying the caller oid, tenant and counts, without webhook egress', async () => {
    asAdmin();
    await workspaceListTool(ctx, { scope: 'tenant' });
    // The gate is the Admin role on admin.workspaces; a weaker role ('Reader')
    // would admit every signed-in user to the tenant-wide listing.
    expect(h.checkCapability).toHaveBeenCalledWith(ctx.session, 'admin.workspaces', 'Admin');
    expect(h.emitAuditEvent).toHaveBeenCalledTimes(1);
    const [ev, opts] = h.emitAuditEvent.mock.calls[0];
    expect(ev).toMatchObject({
      actorOid: ME,
      actorUpn: 'me@example.test',
      action: 'copilot.workspace_list.tenant',
      outcome: 'success',
      tenantId: TID,
      detail: { scope: 'tenant', total: 3, returned: 3 },
    });
    expect(opts).toEqual({ webhook: false });
  });

  it('governance_inventory tenant call is audited as governance.inventory; a mine call writes none', async () => {
    asAdmin();
    await governanceInventoryTool(ctx, { scope: 'tenant' });
    expect(h.emitAuditEvent).toHaveBeenCalledTimes(1);
    expect(h.emitAuditEvent.mock.calls[0][0]).toMatchObject({ action: 'governance.inventory', actorOid: ME, outcome: 'success' });
    h.emitAuditEvent.mockClear();
    h.checkCapability.mockResolvedValue({ allow: false });
    await governanceInventoryTool(ctx, {});
    expect(h.emitAuditEvent).not.toHaveBeenCalled();
  });

  it('a tenant call that FAILS to read is audited as failure (not silently unaudited)', async () => {
    asAdmin();
    h.wsFail = new Error('cosmos 503');
    const r: any = await workspaceListTool(ctx, { scope: 'tenant' });
    expect(r.ok).toBe(false);
    expect(h.emitAuditEvent).toHaveBeenCalledTimes(1);
    expect(h.emitAuditEvent.mock.calls[0][0]).toMatchObject({ outcome: 'failure', actorOid: ME });
  });

  it('group-based admin: the ambient request session (which carries groups) is honoured when the tool context cannot see them', async () => {
    h.checkCapability.mockResolvedValue({ allow: false }); // tool-context session has no groups
    h.ambientAccessOptsFor.mockResolvedValue({ callerTid: TID, tenantAdmin: true });
    const r: any = await workspaceListTool(ctx, { scope: 'tenant' });
    expect(r.ok).toBe(true);
  });

  it('admin whose session has NO tid fails closed: no tenant query, refused, audited', async () => {
    asAdmin();
    h.ambientAccessOptsFor.mockResolvedValue({ callerTid: undefined, tenantAdmin: true });
    const r: any = await workspaceListTool(ctx, { scope: 'tenant' });
    // Break value: scoping by `undefined` (or by the oid) would run the fan-out.
    expect(r).toMatchObject({ ok: false, code: 'tenant_unconfirmed' });
    expect(h.wsQueries).toHaveLength(0);
    expect(h.emitAuditEvent.mock.calls[0][0].outcome).toBe('denied');
  });

  it('rejects an unknown scope value instead of treating it as mine', async () => {
    const r: any = await workspaceListTool(ctx, { scope: 'everything' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/scope must be/);
  });
});

describe('item_list - access resolution once per request, not per row', () => {
  it('500 items across 5 workspaces: listAccessibleWorkspaces x1, resolveWorkspaceAccessByOid x0, only visible workspaces read', async () => {
    const wsIds = ['ws-owned', 'ws-shared'];
    for (let i = 0; i < 500; i++) h.items.push(item(`i${i}`, wsIds[i % 2]));
    h.items.push(item('hidden-1', 'ws-other-user'), item('hidden-2', 'ws-foreign')); // not visible to ME
    h.listAccessibleWorkspaces.mockResolvedValue([WS_OWNED, WS_SHARED]);

    const r: any = await itemListTool(ctx, { pageSize: 500 });

    // Break value: the old per-row/per-workspace resolve makes this 500 (or 5).
    expect(h.listAccessibleWorkspaces).toHaveBeenCalledTimes(1);
    expect(h.resolveWorkspaceAccessByOid).toHaveBeenCalledTimes(0);
    expect(r.total).toBe(500);
    // Hidden workspaces' items never returned, and never even read:
    expect(r.items.map((i: any) => i.id)).not.toContain('hidden-1');
    expect(r.items.map((i: any) => i.id)).not.toContain('hidden-2');
    for (const q of h.itemQueries) {
      expect(q.parameters.filter((p) => p.name.startsWith('@w')).map((p) => p.value).sort()).toEqual(['ws-owned', 'ws-shared']);
      expect(q.query).not.toMatch(/SELECT \*/); // the old unbounded SELECT * over the whole container
    }
  });

  it('with workspaceId: exactly ONE point resolution, a partition-keyed read, zero enumeration', async () => {
    for (let i = 0; i < 40; i++) h.items.push(item(`i${i}`, 'ws-shared'));
    h.resolveWorkspaceAccessByOid.mockResolvedValue({ workspace: WS_SHARED, role: 'Viewer', via: 'acl', canWrite: false });
    const r: any = await itemListTool(ctx, { workspaceId: 'ws-shared' });
    expect(h.resolveWorkspaceAccessByOid).toHaveBeenCalledTimes(1);
    expect(h.resolveWorkspaceAccessByOid.mock.calls[0].slice(0, 2)).toEqual([ME, 'ws-shared']);
    expect(h.listAccessibleWorkspaces).not.toHaveBeenCalled();
    expect(r.total).toBe(40);
    expect(h.itemQueries[0].options).toEqual({ partitionKey: 'ws-shared' });
  });

  it('with a workspaceId the caller cannot access: zero items, zero item reads, and the message does not claim the workspace is missing', async () => {
    h.items.push(item('secret', 'ws-other-user'));
    h.resolveWorkspaceAccessByOid.mockResolvedValue(null);
    const r: any = await itemListTool(ctx, { workspaceId: 'ws-other-user' });
    expect(r.items).toEqual([]);
    expect(r.total).toBe(0);
    expect(h.itemQueries).toHaveLength(0); // a read-then-filter implementation would have queried
    expect(r.scopeNote).toMatch(/does not exist, or you hold no role/);
  });

  it('itemType filter reaches the query; recycled items are excluded by the same predicate item-crud uses', async () => {
    h.items.push(item('a', 'ws-owned', 'lakehouse'), item('b', 'ws-owned', 'warehouse'), item('c', 'ws-owned', 'lakehouse', 'gone', { _recycled: { at: 'x' } }));
    const r: any = await itemListTool(ctx, { itemType: 'lakehouse' });
    expect(r.items.map((i: any) => i.id)).toEqual(['a']);
    expect(h.itemQueries[0].query).toContain(NOT_RECYCLED_SQL);
    expect(r.items[0]).toMatchObject({ workspaceName: 'Owned', workspaceId: 'ws-owned' });
  });

  it('tenant scope reads items of workspaces the caller does not own (the admin whole-estate question)', async () => {
    asAdmin();
    h.items.push(item('mine', 'ws-owned'), item('theirs', 'ws-other-user'), item('foreign', 'ws-foreign'));
    const r: any = await itemListTool(ctx, { scope: 'tenant' });
    expect(r.items.map((i: any) => i.id).sort()).toEqual(['mine', 'theirs']);
    expect(h.listAccessibleWorkspaces).not.toHaveBeenCalled();
  });
});

describe('envelope behaviour through the tools', () => {
  it('500 rows over the budget: the serialized tool result parses, is under the loop cap, truncated:true with nextCursor, total 500 vs returned < 500', async () => {
    for (let i = 0; i < 500; i++) h.items.push(item(`i${String(i).padStart(4, '0')}`, 'ws-owned', 'lakehouse', `Item with a long display name number ${i} ${'x'.repeat(60)}`));
    const r: any = await itemListTool(ctx, { pageSize: 500 });
    const text = JSON.stringify(r);
    // Break value: the old path serialized all 500 rows (~60 KB) and the 16,000 cut produced invalid JSON.
    expect(text.length).toBeLessThan(TOOL_LOOP_CHAR_CAP);
    expect(() => JSON.parse(text)).not.toThrow();
    expect(r.truncated).toBe(true);
    expect(r.nextCursor).toEqual(expect.any(String));
    expect(r.total).toBe(500);
    expect(r.returned).toBeLessThan(500);
    expect(r.returned).toBe(r.items.length);
    expect(r.hint).toMatch(/cursor=/);
  });

  it('cursor pagination returns every item exactly once across pages', async () => {
    for (let i = 0; i < 500; i++) h.items.push(item(`i${String(i).padStart(4, '0')}`, i % 2 ? 'ws-owned' : 'ws-shared', 'lakehouse', `Item ${i} ${'y'.repeat(40)}`));
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const r: any = await itemListTool(ctx, { cursor, pageSize: 500 });
      expect(r.ok).toBe(true);
      expect(r.total).toBe(500);
      seen.push(...r.items.map((i: any) => i.id));
      cursor = r.nextCursor ?? undefined;
      pages += 1;
      expect(pages).toBeLessThan(50);
    } while (cursor);
    expect(pages).toBeGreaterThan(1);
    expect(seen).toHaveLength(500);
    expect(new Set(seen).size).toBe(500);
  });

  it('a bad cursor is an error, not a silent restart from page one', async () => {
    h.items.push(item('a', 'ws-owned'));
    const r: any = await itemListTool(ctx, { cursor: 'definitely-not-a-cursor' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/invalid cursor/);
    expect(r.items).toBeUndefined();
  });

  it('workspace_list paginates too: 600 workspaces, pageSize 500 -> nextCursor, then the remainder', async () => {
    const many = Array.from({ length: 600 }, (_, i) => ws(`w${String(i).padStart(4, '0')}`, `WS ${String(i).padStart(4, '0')}`, ME));
    h.listAccessibleWorkspaces.mockResolvedValue(many);
    const first: any = await workspaceListTool(ctx, { pageSize: 500 });
    expect(first.total).toBe(600);
    expect(first.truncated).toBe(true);
    expect(first.nextCursor).not.toBeNull();
    expect(JSON.stringify(first).length).toBeLessThan(TOOL_LOOP_CHAR_CAP);
    const seen = new Set<string>(first.workspaces.map((w: any) => w.id));
    let cursor = first.nextCursor;
    while (cursor) {
      const nxt: any = await workspaceListTool(ctx, { cursor, pageSize: 500 });
      nxt.workspaces.forEach((w: any) => seen.add(w.id));
      cursor = nxt.nextCursor;
    }
    expect(seen.size).toBe(600);
  });
});

describe('unreadable Cosmos is an error, never []', () => {
  it('item read failure -> ok:false with the cause, no items key (an empty list would read as an empty estate)', async () => {
    h.items.push(item('a', 'ws-owned'));
    h.itemsFail = new Error('Request rate is large (429)');
    for (const tool of [itemListTool, governanceInventoryTool]) {
      const r: any = await tool(ctx, {});
      expect(r.ok).toBe(false);
      expect(r.error).toContain('Request rate is large (429)');
      expect(r.error).toMatch(/NOT an empty estate/);
      expect(r.items).toBeUndefined();
      expect(r.remediation).toBeTruthy();
    }
  });

  it('workspace enumeration failure -> ok:false for all three tools', async () => {
    h.listAccessibleWorkspaces.mockRejectedValue(new Error('workspaces container unreachable'));
    for (const tool of [workspaceListTool, itemListTool, governanceInventoryTool]) {
      const r: any = await tool(ctx, {});
      expect(r.ok).toBe(false);
      expect(r.error).toContain('workspaces container unreachable');
      expect(r.workspaces).toBeUndefined();
      expect(r.items).toBeUndefined();
    }
  });
});

describe('governance_inventory rows', () => {
  it('one row per item with the W0 key, null governance, domain + workspace name; gap types are listed in the summary', async () => {
    h.items.push(
      item('lh1', 'ws-owned', 'lakehouse', 'Sales LH', { provisioning: { secondaryIds: { adlsRoot: 'abfss://bronze@acct.dfs.core.windows.net/lakehouses/Sales', container: 'bronze' } } }),
      item('es1', 'ws-owned', 'eventstream', 'Clicks', { ehId: 'es-hub-1' }),
      item('sm1', 'ws-owned', 'semantic-model', 'Model', { content: { tables: [] } }),
      item('wh1', 'ws-shared', 'warehouse', 'WH without a db', {}),
      item('dash1', 'ws-shared', 'dashboard', 'Plain'),
    );
    const r: any = await governanceInventoryTool(ctx, {});
    expect(r.ok).toBe(true);
    const byId = Object.fromEntries(r.items.map((i: any) => [i.itemId, i]));

    expect(byId.lh1).toEqual({
      itemId: 'lh1', itemType: 'lakehouse', workspaceId: 'ws-owned', workspaceName: 'Owned', domainId: 'dom-a',
      resolverStatus: 'resolved', backingService: 'ADLS Gen2',
      backingResourceId: 'abfss://bronze@acct.dfs.core.windows.net/lakehouses/Sales',
      backingIdKind: 'url', backingKeyPath: 'state.provisioning.secondaryIds.adlsRoot', reason: null,
      governance: { registered: null, scanned: null },
    });
    expect(byId.es1).toMatchObject({ resolverStatus: 'resolved', backingKeyPath: 'state.ehId', backingResourceId: 'es-hub-1', domainId: 'dom-a' });
    expect(byId.wh1.domainId).toBeNull(); // ws-shared has no domain: null, not undefined/invented
    expect(byId.sm1).toMatchObject({ resolverStatus: 'no-backing-key', reason: 'type-has-no-documented-key', backingResourceId: null });
    expect(byId.wh1).toMatchObject({ resolverStatus: 'no-backing-key', reason: 'key-absent-on-item', backingService: 'Synapse dedicated SQL pool' });
    expect(byId.dash1).toMatchObject({ resolverStatus: 'not-applicable', backingService: null });
    // null means NOT MEASURED, on every row, never an invented false/true:
    for (const row of r.items) expect(row.governance).toEqual({ registered: null, scanned: null });

    expect(r.summary.byResolverStatus).toEqual({ resolved: 2, 'no-backing-key': 2, 'not-applicable': 1 });
    expect(r.summary.noBackingKey).toEqual(
      expect.arrayContaining([
        { itemType: 'semantic-model', reason: 'type-has-no-documented-key', count: 1 },
        { itemType: 'warehouse', reason: 'key-absent-on-item', count: 1 },
      ]),
    );
  });

  it('the projection sends bracket-notation paths (a key named "database" must not be parsed as a SQL keyword)', async () => {
    h.items.push(item('wh', 'ws-owned', 'warehouse', 'WH', { provisioning: { secondaryIds: { database: 'loompool' } } }));
    const r: any = await governanceInventoryTool(ctx, {});
    expect(h.itemQueries[0].query).toContain('c.state["provisioning"]["secondaryIds"]["database"] AS k');
    expect(h.itemQueries[0].query).not.toMatch(/c\.state\.[A-Za-z]/);
    // Break value: a mis-built projection leaves every row 'key-absent-on-item'.
    expect(r.items[0]).toMatchObject({ resolverStatus: 'resolved', backingResourceId: 'loompool' });
  });

  it('resolverStatus filter narrows rows and total; an unknown status is rejected', async () => {
    h.items.push(item('es1', 'ws-owned', 'eventstream', 'Clicks', { ehId: 'h' }), item('d', 'ws-owned', 'dashboard'));
    const only: any = await governanceInventoryTool(ctx, { resolverStatus: 'not-applicable' });
    expect(only.items.map((i: any) => i.itemId)).toEqual(['d']);
    expect(only.total).toBe(1);
    const bad: any = await governanceInventoryTool(ctx, { resolverStatus: 'maybe' });
    expect(bad.ok).toBe(false);
  });

  it('worst case: 500 rows with the longest ids and every gap type in the summary still serializes under the loop cap', async () => {
    const types = ['lakehouse', 'warehouse', 'kql-database', 'eventhouse', 'kql-dashboard', 'eventstream', 'data-pipeline', 'adf-pipeline', 'synapse-pipeline', 'mirrored-database', 'mirrored-databricks', 'materialized-lake-view', 'synapse-serverless-sql-pool', 'ai-search-index', 'ml-model', 'notebook', 'databricks-job', 'databricks-notebook', 'databricks-sql-warehouse', 'logic-app', 'stream-analytics-job', 'data-product', 'activator', 'semantic-model', 'report', 'prompt-flow', 'evaluation', 'spark-job-definition', 'spark-environment', 'kql-queryset', 'workspace-monitor'];
    for (let i = 0; i < 500; i++) {
      h.items.push(item(`${'9'.repeat(30)}${i}`, 'ws-owned', types[i % types.length], 'N'.repeat(200), { ehId: 'h'.repeat(500), indexName: 'i'.repeat(500) }));
    }
    const r: any = await governanceInventoryTool(ctx, { pageSize: 500 });
    const text = JSON.stringify(r);
    expect(text.length).toBeLessThan(TOOL_LOOP_CHAR_CAP);
    expect(() => JSON.parse(text)).not.toThrow();
    expect(r.truncated).toBe(true);
  });
});

describe('credential hygiene through the tool output', () => {
  it('a SAS token and URL userinfo stored on items never appear in the serialized result; scheme/host/path still do', async () => {
    h.items.push(
      item('sas', 'ws-owned', 'lakehouse', 'SAS LH', { provisioning: { secondaryIds: { adlsRoot: 'https://acct.dfs.core.windows.net/bronze/Sales?sv=2022&sig=SECRETSENTINEL' } } }),
      item('ui', 'ws-owned', 'synapse-serverless-sql-pool', 'UI pool', { provisioning: { secondaryIds: { endpoint: 'https://user:pass@syn-host.example/x' } } }),
      item('cs', 'ws-owned', 'lakehouse', 'CS LH', { provisioning: { secondaryIds: { adlsRoot: 'DefaultEndpointsProtocol=https;AccountKey=SECRETSENTINEL==' } } }),
    );
    const r: any = await governanceInventoryTool(ctx, {});
    const text = JSON.stringify(r);
    // Break value: the unsanitized resolver emits all three of these.
    expect(text).not.toContain('SECRETSENTINEL');
    expect(text).not.toContain('user:pass');
    expect(text).not.toContain('pass@');
    const by = Object.fromEntries(r.items.map((i: any) => [i.itemId, i]));
    expect(by.sas.backingResourceId).toBe('https://acct.dfs.core.windows.net/bronze/Sales');
    expect(by.ui.backingResourceId).toBe('https://syn-host.example/x');
    expect(by.cs).toMatchObject({ resolverStatus: 'no-backing-key', backingResourceId: null });
  });
});

describe('audit: at most one event per call', () => {
  it('emitAuditEvent throwing after a successful tenant read yields ONE attempted event, a successful result, and no second failure event', async () => {
    asAdmin();
    h.emitAuditEvent.mockImplementation(() => { throw new Error('siem down'); });
    const r: any = await workspaceListTool(ctx, { scope: 'tenant' });
    // Break value: without the guard the catch emits a second ('failure') event and returns ok:false.
    expect(r.ok).toBe(true);
    expect(h.emitAuditEvent).toHaveBeenCalledTimes(1);
    expect(h.emitAuditEvent.mock.calls[0][0].outcome).toBe('success');
  });

  it('a failed read emits exactly one (failure) event', async () => {
    asAdmin();
    h.wsFail = new Error('boom');
    await workspaceListTool(ctx, { scope: 'tenant' });
    expect(h.emitAuditEvent).toHaveBeenCalledTimes(1);
  });
});

describe('drift guards', () => {
  it('NOT_RECYCLED_SQL is byte-identical to the predicate in item-crud.ts (the string is duplicated on purpose)', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../../../app/api/items/_lib/item-crud.ts'), 'utf8');
    expect(src).toContain(`const NOT_RECYCLED = '${NOT_RECYCLED_SQL}';`);
  });

  it('registerGovernanceInventoryTool declares the tool the way item_list is declared, with an envelope-aware description and a pageSize bound', () => {
    const tools: any[] = [];
    registerGovernanceInventoryTool({ register: (t: any) => tools.push(t) } as any);
    expect(tools).toHaveLength(1);
    const t = tools[0];
    expect(t.name).toBe('governance_inventory');
    expect(t.service).toBe('Loom');
    expect(t.parameters.properties.scope.enum).toEqual(['mine', 'tenant']);
    expect(t.parameters.properties.pageSize.maximum).toBe(500);
    expect(t.parameters.additionalProperties).toBe(false);
    expect(t.description).toMatch(/truncated/);
    expect(t.description).toMatch(/nextCursor/);
    expect(t.description).toMatch(/null is NOT false/);
    expect(typeof t.handler).toBe('function');
  });

  it('the orchestrator registers governance_inventory and routes item_list / workspace_list to the new implementation', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../../azure/copilot-orchestrator.ts'), 'utf8');
    expect(src).toMatch(/registerGovernanceInventoryTool\(r\);/);
    expect(src).toMatch(/itemListTool\(ctx,/);
    expect(src).toMatch(/workspaceListTool\(ctx,/);
    // Both advertise the shared paging/scope schema (one pageSize bound for all three tools):
    expect(src.match(/listToolParameters\(/g)?.length).toBe(2);
    // The two defective calls are gone from the tool handlers:
    expect(src).not.toMatch(/listOwnedWorkspaces\(ctx\.userOid\)/);
    expect(src).not.toMatch(/listAllOwnedItems\(ctx\.userOid/);
  });
});
