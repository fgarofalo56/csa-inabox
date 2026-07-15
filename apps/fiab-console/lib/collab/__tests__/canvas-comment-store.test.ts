/**
 * Unit tests for the canvas-comment store (W4) against an in-memory container:
 *  - createCanvasComment: writes a doc + enforces the per-canvas cap
 *  - update/deleteCanvasComment: owner-guard (author-only), not_found, forbidden
 *  - listCanvasComments: filters by canvasKey within the item partition
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { CanvasCommentDoc } from '@/lib/collab/canvas-comment-model';

interface Doc extends CanvasCommentDoc { [k: string]: unknown }
let store: Doc[] = [];

const container = {
  items: {
    query: (spec: any, _opts: any) => ({
      fetchAll: async () => {
        const itemId = spec.parameters[0].value;
        return { resources: store.filter((d) => d.itemId === itemId) };
      },
    }),
    create: async (doc: Doc) => { store.push(doc); return { resource: doc }; },
  },
  item: (id: string, itemId: string) => ({
    read: async () => {
      const r = store.find((d) => d.id === id && d.itemId === itemId);
      if (!r) { const e: any = new Error('not found'); e.code = 404; throw e; }
      return { resource: r };
    },
    replace: async (doc: Doc) => {
      const i = store.findIndex((d) => d.id === id && d.itemId === itemId);
      if (i < 0) { const e: any = new Error('not found'); e.code = 404; throw e; }
      store[i] = doc;
      return { resource: doc };
    },
    delete: async () => {
      const i = store.findIndex((d) => d.id === id && d.itemId === itemId);
      if (i < 0) { const e: any = new Error('not found'); e.code = 404; throw e; }
      store.splice(i, 1);
      return {};
    },
  }),
};

vi.mock('@/lib/azure/cosmos-client', () => ({
  canvasCommentsContainer: async () => container,
}));

import {
  createCanvasComment,
  listCanvasComments,
  updateCanvasComment,
  deleteCanvasComment,
} from '@/lib/collab/canvas-comment-store';
import { normalizeCommentInput } from '@/lib/collab/canvas-comment-model';

const actor = { oid: 'oid-a', name: 'Ann' };
const fields = () => normalizeCommentInput({ text: 'note', x: 1, y: 2 })!;

beforeEach(() => { store = []; delete process.env.LOOM_CANVAS_COMMENT_CAP; });

describe('createCanvasComment', () => {
  it('writes a doc with author attribution', async () => {
    const doc = await createCanvasComment('i1', 'eventstream', 'default', fields(), actor);
    expect(doc.authorOid).toBe('oid-a');
    expect(doc.itemId).toBe('i1');
    expect(store).toHaveLength(1);
  });

  it('enforces the per-canvas cap (oldest evicted)', async () => {
    process.env.LOOM_CANVAS_COMMENT_CAP = '2';
    for (let i = 0; i < 4; i++) {
      // distinct createdAt so pruning is deterministic
      await createCanvasComment('i1', 'eventstream', 'default', fields(), actor);
      await new Promise((r) => setTimeout(r, 2));
    }
    const list = await listCanvasComments('i1', 'default');
    expect(list).toHaveLength(2);
  });
});

describe('listCanvasComments', () => {
  it('filters by canvasKey within the item partition', async () => {
    await createCanvasComment('i1', 'eventstream', 'default', fields(), actor);
    await createCanvasComment('i1', 'eventstream', 'other', fields(), actor);
    expect(await listCanvasComments('i1', 'default')).toHaveLength(1);
    expect(await listCanvasComments('i1', 'other')).toHaveLength(1);
  });
});

describe('owner guard', () => {
  it('lets the author edit + delete; blocks others; 404 on missing', async () => {
    const doc = await createCanvasComment('i1', 'eventstream', 'default', fields(), actor);

    const asOther = await updateCanvasComment('i1', doc.id, { text: 'hax' }, 'oid-b');
    expect(asOther).toEqual({ ok: false, reason: 'forbidden' });

    const asAuthor = await updateCanvasComment('i1', doc.id, { text: 'edited' }, 'oid-a');
    expect(asAuthor.ok).toBe(true);
    if (asAuthor.ok) expect(asAuthor.doc.text).toBe('edited');

    const missing = await deleteCanvasComment('i1', 'cc:i1:default:nope', 'oid-a');
    expect(missing).toEqual({ ok: false, reason: 'not_found' });

    const delOther = await deleteCanvasComment('i1', doc.id, 'oid-b');
    expect(delOther).toEqual({ ok: false, reason: 'forbidden' });

    const del = await deleteCanvasComment('i1', doc.id, 'oid-a');
    expect(del.ok).toBe(true);
    expect(store).toHaveLength(0);
  });
});
