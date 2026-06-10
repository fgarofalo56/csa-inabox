/**
 * Unit tests for the folders service layer (F10).
 *
 * The Cosmos `folders` + `items` containers are replaced with an in-memory
 * stub that mimics the @azure/cosmos query / item / create / replace / delete
 * surface the client uses. No network. Verifies list filtering, create
 * defaults, the delete cascade (items + child folders reparent to root), and
 * move-item validation.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// In-memory stores keyed by container.
let folderDocs: any[] = [];
let itemDocs: any[] = [];

function makeContainer(store: () => any[], pkField: string) {
  return {
    items: {
      query(spec: any) {
        const q: string = spec.query || '';
        const params: Record<string, any> = {};
        for (const p of spec.parameters || []) params[p.name] = p.value;
        return {
          async fetchAll() {
            let rows = store().slice();
            // Very small SQL-ish matcher for the queries this client issues.
            if (q.includes('c.workspaceId = @w')) rows = rows.filter((r) => r.workspaceId === params['@w']);
            if (q.includes('c.folderId = @f')) rows = rows.filter((r) => r.folderId === params['@f']);
            if (q.includes('c.parent = @p')) rows = rows.filter((r) => r.parent === params['@p']);
            return { resources: rows };
          },
        };
      },
      async create(doc: any) {
        store().push(doc);
        return { resource: doc };
      },
    },
    item(id: string, _pk: string) {
      return {
        async read() {
          const r = store().find((d) => d.id === id) || null;
          return { resource: r };
        },
        async replace(next: any) {
          const i = store().findIndex((d) => d.id === id);
          if (i >= 0) store()[i] = next;
          return { resource: next };
        },
        async delete() {
          const i = store().findIndex((d) => d.id === id);
          if (i < 0) { const e: any = new Error('not found'); e.code = 404; throw e; }
          store().splice(i, 1);
          return {};
        },
      };
    },
  };
}

vi.mock('@/lib/azure/cosmos-client', () => ({
  foldersContainer: async () => makeContainer(() => folderDocs, '/workspaceId'),
  itemsContainer: async () => makeContainer(() => itemDocs, '/workspaceId'),
}));

import {
  dbListFolders, dbCreateFolder, dbRenameFolder, dbDeleteFolder, dbMoveItem,
} from '../folders-client';

beforeEach(() => {
  folderDocs = [];
  itemDocs = [];
});

describe('dbListFolders', () => {
  it('returns only the workspace folders', async () => {
    folderDocs = [
      { id: 'f1', workspaceId: 'w1', name: 'A' },
      { id: 'f2', workspaceId: 'w2', name: 'B' },
      { id: 'f3', workspaceId: 'w1', name: 'C' },
    ];
    const out = await dbListFolders('w1');
    expect(out.map((f) => f.id).sort()).toEqual(['f1', 'f3']);
  });
});

describe('dbCreateFolder', () => {
  it('defaults parent to null and sets metadata', async () => {
    const f = await dbCreateFolder('w1', 'My Folder', null, 'me@x.com');
    expect(f.workspaceId).toBe('w1');
    expect(f.name).toBe('My Folder');
    expect(f.parent).toBeNull();
    expect(f.createdBy).toBe('me@x.com');
    expect(folderDocs).toHaveLength(1);
  });
  it('rejects an empty name', async () => {
    await expect(dbCreateFolder('w1', '   ', null, 'me')).rejects.toThrow(/name required/);
  });
});

describe('dbRenameFolder', () => {
  it('renames an existing folder', async () => {
    folderDocs = [{ id: 'f1', workspaceId: 'w1', name: 'Old' }];
    const f = await dbRenameFolder('w1', 'f1', 'New');
    expect(f.name).toBe('New');
    expect(folderDocs[0].name).toBe('New');
  });
  it('throws when the folder is missing', async () => {
    await expect(dbRenameFolder('w1', 'nope', 'x')).rejects.toThrow(/folder not found/);
  });
});

describe('dbDeleteFolder cascade', () => {
  it('reparents items and child folders to root then deletes', async () => {
    folderDocs = [
      { id: 'f1', workspaceId: 'w1', name: 'Parent', parent: null },
      { id: 'f2', workspaceId: 'w1', name: 'Child', parent: 'f1' },
    ];
    itemDocs = [
      { id: 'i1', workspaceId: 'w1', folderId: 'f1', displayName: 'X', updatedAt: 't0' },
      { id: 'i2', workspaceId: 'w1', folderId: null, displayName: 'Y', updatedAt: 't0' },
    ];
    await dbDeleteFolder('w1', 'f1');
    // f1 gone
    expect(folderDocs.find((f) => f.id === 'f1')).toBeUndefined();
    // child folder reparented to root
    expect(folderDocs.find((f) => f.id === 'f2')!.parent).toBeNull();
    // item that lived in f1 reparented to root
    expect(itemDocs.find((i) => i.id === 'i1')!.folderId).toBeNull();
    // untouched item stays
    expect(itemDocs.find((i) => i.id === 'i2')!.folderId).toBeNull();
  });
  it('is idempotent on a missing folder', async () => {
    await expect(dbDeleteFolder('w1', 'ghost')).resolves.toBeUndefined();
  });
});

describe('dbMoveItem', () => {
  it('moves an item into a valid folder', async () => {
    folderDocs = [{ id: 'f1', workspaceId: 'w1', name: 'A' }];
    itemDocs = [{ id: 'i1', workspaceId: 'w1', folderId: null, displayName: 'X', updatedAt: 't0' }];
    const out = await dbMoveItem('w1', 'i1', 'f1');
    expect(out.folderId).toBe('f1');
    expect(itemDocs[0].folderId).toBe('f1');
  });
  it('moves an item back to root with null', async () => {
    itemDocs = [{ id: 'i1', workspaceId: 'w1', folderId: 'f1', displayName: 'X', updatedAt: 't0' }];
    const out = await dbMoveItem('w1', 'i1', null);
    expect(out.folderId).toBeNull();
  });
  it('throws on a missing item', async () => {
    await expect(dbMoveItem('w1', 'nope', null)).rejects.toThrow(/item not found/);
  });
  it('throws on a missing target folder', async () => {
    itemDocs = [{ id: 'i1', workspaceId: 'w1', folderId: null, displayName: 'X' }];
    await expect(dbMoveItem('w1', 'i1', 'ghost')).rejects.toThrow(/folder not found/);
  });
});
