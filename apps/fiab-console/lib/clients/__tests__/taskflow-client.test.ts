/**
 * Unit tests for the task-flow service layer (F11).
 *
 * The Cosmos `task-flows` container is replaced with an in-memory stub mimicking
 * the @azure/cosmos surface the client uses (query / item.read / create /
 * replace / delete). No network. Verifies list ordering scope, create defaults
 * (empty steps/edges), upsert merge semantics, get/404, and idempotent delete.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

let flowDocs: any[] = [];

function makeContainer() {
  return {
    items: {
      query(spec: any) {
        const params: Record<string, any> = {};
        for (const p of spec.parameters || []) params[p.name] = p.value;
        return {
          async fetchAll() {
            const rows = flowDocs.filter((r) => r.workspaceId === params['@w']);
            rows.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
            return { resources: rows };
          },
        };
      },
      async create(doc: any) {
        flowDocs.push(doc);
        return { resource: doc };
      },
    },
    item(id: string, _pk: string) {
      return {
        async read() {
          const r = flowDocs.find((d) => d.id === id);
          if (!r) { const e: any = new Error('not found'); e.code = 404; throw e; }
          return { resource: r };
        },
        async replace(next: any) {
          const i = flowDocs.findIndex((d) => d.id === id);
          if (i >= 0) flowDocs[i] = next;
          return { resource: next };
        },
        async delete() {
          const i = flowDocs.findIndex((d) => d.id === id);
          if (i < 0) { const e: any = new Error('not found'); e.code = 404; throw e; }
          flowDocs.splice(i, 1);
          return {};
        },
      };
    },
  };
}

vi.mock('@/lib/azure/cosmos-client', () => ({
  taskFlowsContainer: async () => makeContainer(),
}));

import {
  dbListTaskFlows, dbGetTaskFlow, dbCreateTaskFlow, dbUpsertTaskFlow, dbDeleteTaskFlow,
} from '../taskflow-client';

beforeEach(() => { flowDocs = []; });

describe('dbCreateTaskFlow', () => {
  it('creates with empty steps/edges and trimmed name', async () => {
    const f = await dbCreateTaskFlow('w1', { displayName: '  Flow A  ', description: '' }, 'me@x.com');
    expect(f.displayName).toBe('Flow A');
    expect(f.steps).toEqual([]);
    expect(f.edges).toEqual([]);
    expect(f.workspaceId).toBe('w1');
    expect(f.createdBy).toBe('me@x.com');
    expect(flowDocs).toHaveLength(1);
  });
  it('rejects an empty name', async () => {
    await expect(dbCreateTaskFlow('w1', { displayName: '   ', description: '' }, 'me')).rejects.toThrow(/displayName required/);
  });
});

describe('dbListTaskFlows', () => {
  it('returns workspace flows newest-updated first', async () => {
    flowDocs = [
      { id: 'a', workspaceId: 'w1', updatedAt: '2026-01-01' },
      { id: 'b', workspaceId: 'w1', updatedAt: '2026-03-01' },
      { id: 'c', workspaceId: 'w2', updatedAt: '2026-05-01' },
    ];
    const out = await dbListTaskFlows('w1');
    expect(out.map((f) => f.id)).toEqual(['b', 'a']);
  });
});

describe('dbGetTaskFlow', () => {
  it('returns null on a missing flow', async () => {
    expect(await dbGetTaskFlow('w1', 'ghost')).toBeNull();
  });
});

describe('dbUpsertTaskFlow', () => {
  it('merges steps/edges and preserves identity fields', async () => {
    flowDocs = [{
      id: 'a', workspaceId: 'w1', displayName: 'A', steps: [], edges: [],
      createdBy: 'me', createdAt: 't0', updatedAt: 't0',
    }];
    const steps = [{ id: 's1', label: 'Step 1', x: 10, y: 20 }];
    const edges = [{ id: 'e1', source: 's1', target: 's1' }];
    const out = await dbUpsertTaskFlow('w1', 'a', { steps, edges }, 't1');
    expect(out.steps).toHaveLength(1);
    expect(out.edges).toHaveLength(1);
    expect(out.createdBy).toBe('me');
    expect(out.createdAt).toBe('t0');
    expect(out.updatedAt).toBe('t1');
    expect(flowDocs[0].steps).toHaveLength(1);
  });
  it('throws when the flow is missing', async () => {
    await expect(dbUpsertTaskFlow('w1', 'ghost', { steps: [] }, 't1')).rejects.toThrow(/not found/);
  });
});

describe('dbDeleteTaskFlow', () => {
  it('deletes an existing flow', async () => {
    flowDocs = [{ id: 'a', workspaceId: 'w1' }];
    await dbDeleteTaskFlow('w1', 'a');
    expect(flowDocs).toHaveLength(0);
  });
  it('is idempotent on a missing flow (no throw)', async () => {
    await expect(dbDeleteTaskFlow('w1', 'ghost')).resolves.toBeUndefined();
  });
});
