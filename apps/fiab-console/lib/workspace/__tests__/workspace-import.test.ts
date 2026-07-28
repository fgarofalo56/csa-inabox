/**
 * EXP1 — workspace-import pure validate/plan tests: bundle validation,
 * collision strategies (new-ids default / skip-existing / overwrite),
 * folder merge-by-(name,parent), and cross-item reference remapping.
 */
import { describe, it, expect } from 'vitest';
import { buildWorkspaceBundle } from '../workspace-export';
import {
  validateLoomWsBundle,
  planWorkspaceImport,
  remapStateRefs,
  summarizePlan,
  MAX_BUNDLE_ITEMS,
} from '../workspace-import';
import type { Workspace, WorkspaceItem, WorkspaceFolder } from '@/lib/types/workspace';

const ws: Workspace = {
  id: 'ws-src', tenantId: 'oid-1', name: 'Source', createdBy: 'a',
  createdAt: '2026-07-01T00:00:00Z', updatedAt: '2026-07-01T00:00:00Z',
};

const folders: WorkspaceFolder[] = [
  { id: 'f-1', workspaceId: 'ws-src', name: 'Gold', parent: null, createdBy: 'a', createdAt: '2026-07-01T00:00:00Z' },
];

const items: WorkspaceItem[] = [
  {
    id: 'aaaaaaaa-0000-0000-0000-000000000001', workspaceId: 'ws-src', itemType: 'lakehouse',
    displayName: 'Lake', folderId: 'f-1', state: {},
    createdBy: 'a', createdAt: '2026-07-01T00:00:00Z', updatedAt: '2026-07-01T00:00:00Z',
  },
  {
    id: 'aaaaaaaa-0000-0000-0000-000000000002', workspaceId: 'ws-src', itemType: 'warehouse',
    displayName: 'Lake (SQL endpoint)', folderId: null,
    state: { sqlEndpointFor: 'aaaaaaaa-0000-0000-0000-000000000001' },
    createdBy: 'a', createdAt: '2026-07-01T00:00:00Z', updatedAt: '2026-07-01T00:00:00Z',
  },
];

const bundle = buildWorkspaceBundle(ws, items, folders, [], {
  exportedBy: 'a@contoso.com', now: '2026-07-24T00:00:00Z',
});

/** Deterministic id factory for stable assertions. */
const seqIds = () => {
  let n = 0;
  return () => `new-${++n}`;
};

describe('validateLoomWsBundle', () => {
  it('accepts a real exported bundle', () => {
    const v = validateLoomWsBundle(JSON.parse(JSON.stringify(bundle)));
    expect(v.ok).toBe(true);
  });

  it('rejects non-bundles with precise errors', () => {
    expect(validateLoomWsBundle(null)).toMatchObject({ ok: false });
    expect(validateLoomWsBundle({ loomapp: 1 })).toMatchObject({ ok: false });
    expect(validateLoomWsBundle({ loomws: 1 })).toMatchObject({ ok: false, error: expect.stringContaining('items') });
    expect(validateLoomWsBundle({ loomws: 1, items: [{ id: 'x' }], workspace: { name: 'n' } }))
      .toMatchObject({ ok: false, error: expect.stringContaining('itemType') });
  });

  it('enforces the item ceiling', () => {
    const big = {
      loomws: 1,
      workspace: { name: 'n' },
      items: Array.from({ length: MAX_BUNDLE_ITEMS + 1 }, (_, i) => ({
        id: `i${i}`, itemType: 'notebook', displayName: `n${i}`,
      })),
    };
    expect(validateLoomWsBundle(big)).toMatchObject({ ok: false, error: expect.stringContaining('ceiling') });
  });
});

describe('remapStateRefs', () => {
  it('rewrites embedded old ids everywhere in the state JSON', () => {
    const { state, replaced } = remapStateRefs(
      { a: 'old-id-1', deep: { list: ['old-id-1', 'other'] } },
      { 'old-id-1': 'new-id-9' },
    );
    expect(replaced).toBe(2);
    expect(state).toEqual({ a: 'new-id-9', deep: { list: ['new-id-9', 'other'] } });
  });
});

describe('planWorkspaceImport — new-ids (default)', () => {
  const plan = planWorkspaceImport(bundle, {
    workspaceId: 'ws-target',
    existingItems: [{ id: 'exist-1', itemType: 'lakehouse', displayName: 'Lake' }],
    existingFolders: [],
  }, { createdBy: 'b@contoso.com', now: '2026-07-24T01:00:00Z', newId: seqIds() });

  it('creates everything fresh even when names collide', () => {
    expect(plan.strategy).toBe('new-ids');
    expect(plan.items.every((i) => i.action === 'create')).toBe(true);
    expect(plan.foldersToCreate).toHaveLength(1);
    const lake = plan.items.find((i) => i.sourceId === 'aaaaaaaa-0000-0000-0000-000000000001')!;
    expect(lake.doc!.id).not.toBe(lake.sourceId);
    expect(lake.doc!.workspaceId).toBe('ws-target');
    expect(lake.doc!.createdBy).toBe('b@contoso.com');
  });

  it('remaps folderId and cross-item state refs onto the new ids', () => {
    const lake = plan.items.find((i) => i.sourceId === 'aaaaaaaa-0000-0000-0000-000000000001')!;
    const sql = plan.items.find((i) => i.sourceId === 'aaaaaaaa-0000-0000-0000-000000000002')!;
    expect(lake.doc!.folderId).toBe(plan.idMap['f-1']);
    expect(sql.doc!.state!.sqlEndpointFor).toBe(lake.doc!.id);
    expect(plan.refsRemapped).toBeGreaterThanOrEqual(1);
  });
});

describe('planWorkspaceImport — skip-existing', () => {
  const plan = planWorkspaceImport(bundle, {
    workspaceId: 'ws-target',
    existingItems: [{ id: 'exist-lake', itemType: 'lakehouse', displayName: 'lake' }], // case-insensitive match
    existingFolders: [],
  }, { strategy: 'skip-existing', createdBy: 'b', newId: seqIds() });

  it('skips colliding items and remaps references onto the EXISTING item', () => {
    const lake = plan.items.find((i) => i.sourceId === 'aaaaaaaa-0000-0000-0000-000000000001')!;
    expect(lake.action).toBe('skip');
    expect(lake.existingId).toBe('exist-lake');
    const sql = plan.items.find((i) => i.sourceId === 'aaaaaaaa-0000-0000-0000-000000000002')!;
    expect(sql.action).toBe('create');
    expect(sql.doc!.state!.sqlEndpointFor).toBe('exist-lake');
  });

  it('summarizes correctly', () => {
    expect(summarizePlan(plan)).toMatchObject({ created: 1, skipped: 1, overwritten: 0 });
  });
});

describe('planWorkspaceImport — overwrite', () => {
  const plan = planWorkspaceImport(bundle, {
    workspaceId: 'ws-target',
    existingItems: [{ id: 'exist-lake', itemType: 'lakehouse', displayName: 'Lake' }],
    existingFolders: [],
  }, { strategy: 'overwrite', createdBy: 'b', newId: seqIds() });

  it('overwrites the colliding item in place (existing id kept)', () => {
    const lake = plan.items.find((i) => i.sourceId === 'aaaaaaaa-0000-0000-0000-000000000001')!;
    expect(lake.action).toBe('overwrite');
    expect(lake.existingId).toBe('exist-lake');
    expect(lake.overwrite!.displayName).toBe('Lake');
    const sql = plan.items.find((i) => i.sourceId === 'aaaaaaaa-0000-0000-0000-000000000002')!;
    expect(sql.doc!.state!.sqlEndpointFor).toBe('exist-lake');
  });
});

describe('planWorkspaceImport — folder merge', () => {
  it('reuses a target folder with the same (name, parent) instead of duplicating it', () => {
    const plan = planWorkspaceImport(bundle, {
      workspaceId: 'ws-target',
      existingItems: [],
      existingFolders: [{ id: 'tgt-gold', name: 'Gold', parent: null }],
    }, { createdBy: 'b', newId: seqIds() });
    expect(plan.foldersToCreate).toHaveLength(0);
    expect(plan.foldersReused).toBe(1);
    expect(plan.idMap['f-1']).toBe('tgt-gold');
    const lake = plan.items.find((i) => i.sourceId === 'aaaaaaaa-0000-0000-0000-000000000001')!;
    expect(lake.doc!.folderId).toBe('tgt-gold');
  });

  it('creates nested folders parent-first with remapped parents', () => {
    const nested = {
      ...bundle,
      folders: [
        { id: 'f-b', name: 'Child', parent: 'f-a' }, // child listed FIRST — planner must topo-sort
        { id: 'f-a', name: 'Parent', parent: null },
      ],
      items: [],
    };
    const plan = planWorkspaceImport(nested, {
      workspaceId: 'ws-target', existingItems: [], existingFolders: [],
    }, { createdBy: 'b', newId: seqIds() });
    expect(plan.foldersToCreate).toHaveLength(2);
    const parent = plan.foldersToCreate.find((f) => f.name === 'Parent')!;
    const child = plan.foldersToCreate.find((f) => f.name === 'Child')!;
    expect(child.parent).toBe(parent.id);
  });
});
