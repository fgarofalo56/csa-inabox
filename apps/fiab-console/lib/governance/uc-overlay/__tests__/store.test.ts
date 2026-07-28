/**
 * LU-5 — store.ts tests. This module had NO test file in the first pass, so
 * every Cosmos-shaped decision in it was uncovered: the partition keys, the
 * doc-id construction, the 404 swallow, and the prefix query.
 *
 * Bugs these catch:
 *   1. a read or write landing in the WRONG PARTITION (the route passes
 *      `tenantScopeId(session)`, but only this module names the partition key —
 *      a mistake here is a cross-tenant leak and nothing else covers it).
 *   2. `listOverlays('main.sales')` returning overlays from `main.salesops` /
 *      `main.salesforce_stg` — a bare STARTSWITH has no dot boundary.
 *   3. a table listing being polluted by `col:` column overlays.
 *   4. the vocabulary / attribute-group doc ids drifting away from the
 *      `<kind>:<tenantId>` shape the sibling routes own.
 *   5. a genuine Cosmos error being swallowed as "not found" (only 404 may be).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

interface Captured { id?: string; pk?: string; query?: string; parameters?: any[] }
const captured: Captured[] = [];

/** Docs the fake Cosmos holds, keyed `<container>|<pk>|<id>`. */
const DOCS = new Map<string, any>();
/** Rows the fake query returns, per container. */
const ROWS = new Map<string, any[]>();
/** Error to throw from the next point-read, if any. */
let readError: any = null;

function fakeContainer(name: string) {
  return {
    item: (id: string, pk: string) => ({
      read: async () => {
        captured.push({ id, pk });
        if (readError) throw readError;
        return { resource: DOCS.get(`${name}|${pk}|${id}`) };
      },
      delete: async () => {
        captured.push({ id, pk });
        if (readError) throw readError;
        DOCS.delete(`${name}|${pk}|${id}`);
        return {};
      },
    }),
    items: {
      upsert: async (doc: any) => {
        DOCS.set(`${name}|${doc.tenantId}|${doc.id}`, doc);
        return { resource: doc };
      },
      query: (spec: any) => ({
        fetchAll: async () => {
          captured.push({ query: spec.query, parameters: spec.parameters });
          const all = ROWS.get(name) || [];
          const params = Object.fromEntries(spec.parameters.map((p: any) => [p.name, p.value]));
          // Faithful evaluation of the two SQL shapes this module emits.
          const rows = all.filter((r) => {
            if (r.tenantId !== params['@t']) return false;
            if (params['@p'] !== undefined) return String(r.identity).startsWith(params['@p']);
            return r.identity === params['@exact'] || String(r.identity).startsWith(params['@under']);
          });
          return { resources: rows };
        },
      }),
    },
  };
}

vi.mock('@/lib/azure/cosmos-client', () => ({
  tenantSettingsContainer: async () => fakeContainer('tenant-settings'),
  ucGovernanceContainer: async () => fakeContainer('uc-governance'),
}));

import {
  deleteOverlay, governedTagsDocId, listColumnOverlays, listOverlays,
  readAttributeGroups, readGovernedTags, readOverlay, writeGovernedTags, writeOverlay,
} from '../store';
import { emptyOverlay } from '../model';

beforeEach(() => {
  captured.length = 0;
  DOCS.clear();
  ROWS.clear();
  readError = null;
});

describe('doc ids', () => {
  it('the vocabulary doc id mirrors attribute-groups:<tenantId>', () => {
    expect(governedTagsDocId('tenant-1')).toBe('uc-governed-tags:tenant-1');
  });
});

describe('partition keys (cross-tenant safety)', () => {
  it('readOverlay point-reads (identity, tenantId) — the id is the identity, the PK is the tenant', async () => {
    await readOverlay('tenant-1', { fullName: 'Main.Sales.Orders' });
    expect(captured[0]).toEqual({ id: 'uc:main.sales.orders', pk: 'tenant-1' });
  });

  it('readGovernedTags reads the CALLER tenant partition', async () => {
    await readGovernedTags('tenant-9');
    expect(captured[0]).toEqual({ id: 'uc-governed-tags:tenant-9', pk: 'tenant-9' });
  });

  it('readAttributeGroups reads the SAME doc /api/attribute-groups owns', async () => {
    await readAttributeGroups('tenant-9');
    expect(captured[0]).toEqual({ id: 'attribute-groups:tenant-9', pk: 'tenant-9' });
  });

  it('deleteOverlay deletes (identity, tenantId) — never a bare id', async () => {
    await deleteOverlay('tenant-2', 'uc:main.sales.orders');
    expect(captured[0]).toEqual({ id: 'uc:main.sales.orders', pk: 'tenant-2' });
  });

  it('every listing query filters on c.tenantId', async () => {
    await listOverlays('tenant-3');
    await listOverlays('tenant-3', 'main');
    await listColumnOverlays('tenant-3', 'main.sales.orders');
    for (const c of captured) {
      expect(c.query).toContain('c.tenantId = @t');
      expect(c.parameters!.find((p) => p.name === '@t').value).toBe('tenant-3');
    }
  });

  it('a document written for tenant A is invisible to tenant B', async () => {
    const o = { ...emptyOverlay({ tenantId: 'tenant-A', fullName: 'main.sales.orders' }), tags: [{ key: 'x', value: 'y' }] };
    await writeOverlay(o);
    expect((await readOverlay('tenant-A', { fullName: 'main.sales.orders' })).tags).toHaveLength(1);
    expect((await readOverlay('tenant-B', { fullName: 'main.sales.orders' })).tags).toHaveLength(0);
  });
});

describe('listOverlays prefix boundary', () => {
  beforeEach(() => {
    ROWS.set('uc-governance', [
      { tenantId: 't', identity: 'uc:main.sales' },
      { tenantId: 't', identity: 'uc:main.sales.orders' },
      { tenantId: 't', identity: 'uc:main.salesops.orders' },
      { tenantId: 't', identity: 'uc:main.salesforce_stg.x' },
      { tenantId: 't', identity: 'uc:other.sales.orders' },
    ]);
  });

  it('ATTACK on the old bare STARTSWITH: main.sales does NOT match main.salesops / main.salesforce_stg', async () => {
    const rows = await listOverlays('t', 'main.sales');
    expect(rows.map((r) => r.identity)).toEqual(['uc:main.sales', 'uc:main.sales.orders']);
  });

  it('a catalog prefix scopes to that catalog only', async () => {
    const rows = await listOverlays('t', 'main');
    expect(rows.every((r) => r.identity.startsWith('uc:main.') || r.identity === 'uc:main')).toBe(true);
    expect(rows.map((r) => r.identity)).not.toContain('uc:other.sales.orders');
  });

  it('no prefix lists every securable overlay (and nothing column-scoped)', async () => {
    ROWS.get('uc-governance')!.push({ tenantId: 't', identity: 'col:uc:main.sales.orders::email' });
    const rows = await listOverlays('t');
    expect(rows.map((r) => r.identity)).not.toContain('col:uc:main.sales.orders::email');
  });

  it('listColumnOverlays returns only that table’s columns', async () => {
    ROWS.set('uc-governance', [
      { tenantId: 't', identity: 'col:uc:main.sales.orders::email' },
      { tenantId: 't', identity: 'col:uc:main.sales.orders2::email' },
      { tenantId: 't', identity: 'uc:main.sales.orders' },
    ]);
    const rows = await listColumnOverlays('t', 'main.sales.orders');
    expect(rows.map((r) => r.identity)).toEqual(['col:uc:main.sales.orders::email']);
  });
});

describe('not-found handling', () => {
  it('a 404 point-read yields a blank overlay, not a throw', async () => {
    readError = { code: 404 };
    const o = await readOverlay('t', { fullName: 'main.sales.orders' });
    expect(o.identity).toBe('uc:main.sales.orders');
    expect(o.tags).toEqual([]);
  });

  it('a 404 vocabulary read yields [] and a 404 attribute-group read yields []', async () => {
    readError = { code: 404 };
    expect(await readGovernedTags('t')).toEqual([]);
    expect(await readAttributeGroups('t')).toEqual([]);
  });

  it('a 404 delete is idempotent', async () => {
    readError = { code: 404 };
    await expect(deleteOverlay('t', 'uc:main.sales.orders')).resolves.toBeUndefined();
  });

  it('a NON-404 Cosmos error is NOT swallowed (403/429/500 must surface)', async () => {
    for (const code of [403, 429, 500]) {
      readError = { code };
      await expect(readOverlay('t', { fullName: 'main.sales.orders' })).rejects.toBeTruthy();
      await expect(readGovernedTags('t')).rejects.toBeTruthy();
      await expect(deleteOverlay('t', 'uc:main.sales.orders')).rejects.toBeTruthy();
    }
  });
});

describe('writeGovernedTags', () => {
  it('normalizes the vocabulary before persisting and stamps the writer', async () => {
    const doc = await writeGovernedTags(
      'tenant-1',
      [{ key: 'PII Level', allowedValues: [' yes ', 'yes', 'no'] }],
      'ana@contoso.com',
    );
    expect(doc.id).toBe('uc-governed-tags:tenant-1');
    expect(doc.tenantId).toBe('tenant-1');
    expect(doc.updatedBy).toBe('ana@contoso.com');
    expect(doc.tags).toEqual([{ key: 'pii-level', allowedValues: ['yes', 'no'] }]);
  });
});
