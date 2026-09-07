/**
 * Contract tests for the pipeline resource-binding model — the fix for the
 * 404 PipelineNotFound bug (Loom GUID was sent as the Azure pipeline name).
 *
 * These assert that:
 *   - resolveBinding() returns state.pipelineName, NOT the route id
 *   - an unbound item throws UnboundPipelineError (→ 412)
 *   - a missing item throws ItemNotFoundError (→ 404)
 *   - persistBinding() writes pipelineName into item.state via Cosmos replace
 *   - bindingErrorResponse() maps the errors to the right HTTP status + body
 *
 * The Cosmos container is mocked so the test runs offline (no Azure).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// ---- Cosmos mock ----------------------------------------------------------
const state = {
  itemDoc: null as any,
  workspaceDoc: null as any,
  replaced: null as any,
};

vi.mock('@/lib/azure/cosmos-client', () => {
  return {
    itemsContainer: async () => ({
      items: {
        // Honor the real query's parameterized filter: match c.id = @id AND
        // c.itemType IN (@t0, @t1, ...). This lets tests prove the alias fix —
        // a 'data-pipeline'-typed doc resolves when the route asks for
        // ['adf-pipeline','data-pipeline'], and a foreign type does NOT.
        query: (spec: any) => ({
          fetchAll: async () => {
            const doc = state.itemDoc;
            if (!doc) return { resources: [] };
            const params: Array<{ name: string; value: any }> = spec?.parameters || [];
            const idParam = params.find((p) => p.name === '@id');
            const typeValues = params.filter((p) => p.name.startsWith('@t')).map((p) => p.value);
            const idOk = idParam ? doc.id === idParam.value : true;
            const typeOk = typeValues.length ? typeValues.includes(doc.itemType) : true;
            return { resources: idOk && typeOk ? [doc] : [] };
          },
        }),
      },
      item: (id: string, pk: string) => ({
        replace: async (doc: any) => {
          state.replaced = { id, pk, doc };
          return { resource: doc };
        },
      }),
    }),
    workspacesContainer: async () => ({
      // #2942 — this mock USED TO return `state.workspaceDoc` for ANY partition
      // key, which does not model real Cosmos: `workspaces` is partitioned by
      // `/tenantId`, so a point read with a partition key other than the doc's
      // own `tenantId` resolves to `undefined`. That fixture modelled the buggy
      // code's assumption rather than the service, which is exactly how an
      // owner-only guard shipped past its own test file. It is now
      // partition-accurate, plus the cross-partition `items.query` that
      // `readWorkspaceById` uses on the non-owner path.
      item: (id: string, pk: string) => ({
        read: async () => {
          const doc = state.workspaceDoc;
          return { resource: doc && doc.id === id && doc.tenantId === pk ? doc : undefined };
        },
      }),
      items: {
        query: (spec: any) => ({
          fetchAll: async () => {
            const doc = state.workspaceDoc;
            const idParam = (spec?.parameters || []).find((p: any) => p.name === '@id');
            return { resources: doc && (!idParam || doc.id === idParam.value) ? [doc] : [] };
          },
        }),
      },
    }),
    // Reached only on the non-owner ACL path; no grants exist in these fixtures.
    workspaceRolesContainer: async () => ({
      items: { query: () => ({ fetchAll: async () => ({ resources: [] }) }) },
    }),
  };
});

// The ACL leg of the access ladder. These are binding-resolution tests, not
// sharing tests: nobody holds a workspace role, so a non-owner is refused.
vi.mock('@/lib/azure/workspace-roles-client', () => ({
  resolveEffectiveRole: vi.fn(async () => null),
}));
// No ambient request session in a unit test → no tenant-admin bypass, which is
// the pre-existing behavior these fixtures assert.
vi.mock('@/lib/auth/feature-gate', () => ({ isTenantAdmin: () => false }));

const TENANT = 'tenant-oid-1';

function makeItem(over: Partial<any> = {}) {
  return {
    id: 'guid-aaaa-bbbb',
    workspaceId: 'ws-1',
    itemType: 'adf-pipeline',
    displayName: 'My Pipeline',
    state: { pipelineName: 'ingest_orders' },
    createdBy: 'u', createdAt: 't', updatedAt: 't',
    ...over,
  };
}

beforeEach(() => {
  state.itemDoc = makeItem();
  state.workspaceDoc = { id: 'ws-1', tenantId: TENANT };
  state.replaced = null;
});

describe('resolveBinding', () => {
  it('returns the Azure pipeline name from item.state, NOT the route id', async () => {
    const { resolveBinding } = await import('../pipeline-binding');
    const b = await resolveBinding('guid-aaaa-bbbb', 'adf-pipeline', TENANT);
    expect(b.pipelineName).toBe('ingest_orders');
    expect(b.pipelineName).not.toBe('guid-aaaa-bbbb');
  });

  it('throws UnboundPipelineError when state.pipelineName is missing', async () => {
    state.itemDoc = makeItem({ state: {} });
    const { resolveBinding, UnboundPipelineError } = await import('../pipeline-binding');
    await expect(resolveBinding('guid-aaaa-bbbb', 'adf-pipeline', TENANT)).rejects.toBeInstanceOf(UnboundPipelineError);
  });

  it('throws ItemNotFoundError when the item is absent', async () => {
    state.itemDoc = null;
    const { resolveBinding, ItemNotFoundError } = await import('../pipeline-binding');
    await expect(resolveBinding('nope', 'adf-pipeline', TENANT)).rejects.toBeInstanceOf(ItemNotFoundError);
  });

  it('throws ItemNotFoundError when the workspace belongs to another tenant', async () => {
    state.workspaceDoc = { id: 'ws-1', tenantId: 'someone-else' };
    const { resolveBinding, ItemNotFoundError } = await import('../pipeline-binding');
    await expect(resolveBinding('guid-aaaa-bbbb', 'adf-pipeline', TENANT)).rejects.toBeInstanceOf(ItemNotFoundError);
  });

  it('carries optional factory/workspace overrides from state', async () => {
    state.itemDoc = makeItem({ state: { pipelineName: 'p1', factory: 'adf-other', workspace: 'syn-other' } });
    const { resolveBinding } = await import('../pipeline-binding');
    const b = await resolveBinding('guid-aaaa-bbbb', 'adf-pipeline', TENANT);
    expect(b.factory).toBe('adf-other');
    expect(b.workspace).toBe('syn-other');
  });
});

describe('itemType aliasing — adf/synapse routes accept data-pipeline-typed items', () => {
  // The real 'Bind failed' 404: interactively-created pipeline tiles persist as
  // itemType:'data-pipeline' (catalog aliasOf), but the ADF/Synapse routes used
  // to filter on their own type only → zero rows → ItemNotFoundError. The routes
  // now pass ['adf-pipeline','data-pipeline'] (or synapse variant) and BOTH must
  // resolve. Bundle-installed items may genuinely carry the native type.
  it('resolves a data-pipeline-typed item when the route asks for adf-pipeline+data-pipeline', async () => {
    state.itemDoc = makeItem({ itemType: 'data-pipeline' });
    const { loadPipelineItem, resolveBinding } = await import('../pipeline-binding');
    const loaded = await loadPipelineItem('guid-aaaa-bbbb', ['adf-pipeline', 'data-pipeline'], TENANT);
    expect(loaded?.itemType).toBe('data-pipeline');
    const b = await resolveBinding('guid-aaaa-bbbb', ['adf-pipeline', 'data-pipeline'], TENANT);
    expect(b.pipelineName).toBe('ingest_orders');
  });

  it('still resolves a natively adf-pipeline-typed (bundle-installed) item', async () => {
    state.itemDoc = makeItem({ itemType: 'adf-pipeline' });
    const { loadPipelineItem } = await import('../pipeline-binding');
    const loaded = await loadPipelineItem('guid-aaaa-bbbb', ['adf-pipeline', 'data-pipeline'], TENANT);
    expect(loaded?.itemType).toBe('adf-pipeline');
  });

  it('resolves a data-pipeline-typed item for the synapse-pipeline route list too', async () => {
    state.itemDoc = makeItem({ itemType: 'data-pipeline' });
    const { loadPipelineItem } = await import('../pipeline-binding');
    const loaded = await loadPipelineItem('guid-aaaa-bbbb', ['synapse-pipeline', 'data-pipeline'], TENANT);
    expect(loaded?.itemType).toBe('data-pipeline');
  });

  it('does NOT resolve a foreign itemType (still tenant/type scoped)', async () => {
    state.itemDoc = makeItem({ itemType: 'lakehouse' });
    const { loadPipelineItem } = await import('../pipeline-binding');
    const loaded = await loadPipelineItem('guid-aaaa-bbbb', ['adf-pipeline', 'data-pipeline'], TENANT);
    expect(loaded).toBeNull();
  });

  it('still rejects a data-pipeline-typed item from a foreign tenant', async () => {
    state.itemDoc = makeItem({ itemType: 'data-pipeline' });
    state.workspaceDoc = { id: 'ws-1', tenantId: 'someone-else' };
    const { resolveBinding, ItemNotFoundError } = await import('../pipeline-binding');
    await expect(
      resolveBinding('guid-aaaa-bbbb', ['adf-pipeline', 'data-pipeline'], TENANT),
    ).rejects.toBeInstanceOf(ItemNotFoundError);
  });

  it('UnboundPipelineError reports the item ACTUAL type (data-pipeline) when found unbound', async () => {
    state.itemDoc = makeItem({ itemType: 'data-pipeline', state: {} });
    const { resolveBinding, UnboundPipelineError } = await import('../pipeline-binding');
    await expect(
      resolveBinding('guid-aaaa-bbbb', ['adf-pipeline', 'data-pipeline'], TENANT),
    ).rejects.toMatchObject({ itemType: 'data-pipeline' });
    // sanity: it is the right error class
    await expect(
      resolveBinding('guid-aaaa-bbbb', ['adf-pipeline', 'data-pipeline'], TENANT),
    ).rejects.toBeInstanceOf(UnboundPipelineError);
  });

  it('ItemNotFoundError keeps the primary requested type (adf-pipeline) when absent', async () => {
    state.itemDoc = null;
    const { resolveBinding } = await import('../pipeline-binding');
    await expect(
      resolveBinding('nope', ['adf-pipeline', 'data-pipeline'], TENANT),
    ).rejects.toMatchObject({ itemType: 'adf-pipeline' });
  });

  it('persistBinding preserves the stored itemType (does not rewrite it to adf-pipeline)', async () => {
    state.itemDoc = makeItem({ itemType: 'data-pipeline', state: { existing: 'keep' } });
    const { persistBinding } = await import('../pipeline-binding');
    const updated = await persistBinding('guid-aaaa-bbbb', ['adf-pipeline', 'data-pipeline'], TENANT, { pipelineName: 'p2' });
    expect(updated.itemType).toBe('data-pipeline');
    expect(state.replaced.doc.itemType).toBe('data-pipeline');
    expect(updated.state?.pipelineName).toBe('p2');
  });
});

describe('persistBinding', () => {
  it('writes pipelineName into item.state and replaces the Cosmos doc', async () => {
    state.itemDoc = makeItem({ state: { existing: 'keep' } });
    const { persistBinding } = await import('../pipeline-binding');
    const updated = await persistBinding('guid-aaaa-bbbb', 'adf-pipeline', TENANT, { pipelineName: 'new_pipe' });
    expect(updated.state?.pipelineName).toBe('new_pipe');
    expect(updated.state?.existing).toBe('keep'); // preserves other state
    expect(state.replaced.doc.state.pipelineName).toBe('new_pipe');
    expect(state.replaced.pk).toBe('ws-1'); // partition key = workspaceId
  });

  it('rejects an empty pipelineName', async () => {
    const { persistBinding } = await import('../pipeline-binding');
    await expect(persistBinding('guid-aaaa-bbbb', 'adf-pipeline', TENANT, { pipelineName: '  ' })).rejects.toThrow();
  });
});

describe('bindingErrorResponse', () => {
  it('maps UnboundPipelineError → 412 with code "unbound"', async () => {
    const { bindingErrorResponse, UnboundPipelineError } = await import('../pipeline-binding');
    const r = bindingErrorResponse(new UnboundPipelineError('adf-pipeline', 'guid'));
    expect(r.status).toBe(412);
    expect(r.body.code).toBe('unbound');
    expect(r.body.ok).toBe(false);
  });

  it('maps ItemNotFoundError → 404 with code "not_found"', async () => {
    const { bindingErrorResponse, ItemNotFoundError } = await import('../pipeline-binding');
    const r = bindingErrorResponse(new ItemNotFoundError('adf-pipeline', 'guid'));
    expect(r.status).toBe(404);
    expect(r.body.code).toBe('not_found');
  });

  it('maps any other error → 502', async () => {
    const { bindingErrorResponse } = await import('../pipeline-binding');
    const r = bindingErrorResponse(new Error('ARM 500'));
    expect(r.status).toBe(502);
    expect(r.body.error).toContain('ARM 500');
  });
});

// ---------------------------------------------------------------------------
// #3700 — toAdfWireShape: the WRITE-BOUNDARY translator.
//
// The canvas shape (activity config spread onto the activity ROOT) is what the
// designer reads and what ADF IGNORES. Three write paths PUT it verbatim, so a
// publish returned 200 and authored a pipeline that did nothing. These pin the
// translation AND the idempotence the write boundaries rely on — a definition
// read back FROM ADF must survive it unchanged, or export/round-trip corrupts.
// ---------------------------------------------------------------------------
describe('toAdfWireShape (#3700)', () => {
  const load = () => import('../pipeline-binding');

  it('moves a non-root activity key under typeProperties and leaves nothing at the root', async () => {
    const { toAdfWireShape } = await load();
    const out: any = toAdfWireShape({
      properties: { activities: [{ name: 'a', type: 'DatabricksNotebook', notebookPath: '/x' }] },
    });
    const act = out.properties.activities[0];
    expect(act.typeProperties.notebookPath).toBe('/x');
    expect(act.notebookPath).toBeUndefined();
    expect(act.name).toBe('a');
    expect(act.type).toBe('DatabricksNotebook');
  });

  it('keeps the well-known ADF activity-root siblings AT the root', async () => {
    const { toAdfWireShape } = await load();
    const out: any = toAdfWireShape({
      activities: [{
        name: 'copy', type: 'Copy',
        description: 'd',
        policy: { timeout: '7.00:00:00' },
        linkedServiceName: { referenceName: 'ls', type: 'LinkedServiceReference' },
        inputs: [{ referenceName: 'in' }],
        outputs: [{ referenceName: 'out' }],
        userProperties: [{ name: 'u', value: 'v' }],
        dependsOn: [{ activity: 'prev', dependencyConditions: ['Succeeded'] }],
        source: { type: 'DelimitedTextSource' },
      }],
    });
    const act = out.activities[0];
    for (const k of ['description', 'policy', 'linkedServiceName', 'inputs', 'outputs', 'userProperties', 'dependsOn']) {
      expect(act[k]).toBeDefined();
    }
    // …and only the type body moved.
    expect(act.typeProperties).toEqual({ source: { type: 'DelimitedTextSource' } });
  });

  it('IS IDEMPOTENT — wire-shaped input comes back byte-identical', async () => {
    // The write boundaries call this unconditionally, including on branch 3
    // (which already asked for target:'adf') and on a definition read live FROM
    // ADF in the export route. A non-idempotent translator would corrupt both.
    const { toAdfWireShape } = await load();
    const wire = {
      name: 'p',
      properties: {
        activities: [{
          name: 'a', type: 'DatabricksNotebook',
          policy: { timeout: '7.00:00:00' },
          typeProperties: { notebookPath: '/x', baseParameters: { k: 'v' } },
        }],
        parameters: { p1: { type: 'String' } },
      },
    };
    const once = toAdfWireShape(wire);
    const twice = toAdfWireShape(once);
    expect(once).toEqual(wire);
    expect(twice).toEqual(once);
  });

  it('an EXISTING typeProperties wins over a stray root key of the same name', async () => {
    // A half-migrated document must not silently DOWNGRADE to the stale root
    // value; the wire side is already authoritative for that key.
    const { toAdfWireShape } = await load();
    const out: any = toAdfWireShape({
      activities: [{ name: 'a', type: 'X', notebookPath: '/stale', typeProperties: { notebookPath: '/live' } }],
    });
    expect(out.activities[0].typeProperties.notebookPath).toBe('/live');
  });

  it('recurses into control-flow children (ForEach / If / Switch)', async () => {
    const { toAdfWireShape } = await load();
    const out: any = toAdfWireShape({
      activities: [
        {
          name: 'each', type: 'ForEach',
          items: { value: '@pipeline().parameters.list', type: 'Expression' },
          activities: [{ name: 'inner', type: 'DatabricksNotebook', notebookPath: '/deep' }],
        },
        {
          name: 'sw', type: 'Switch',
          on: { value: '@x', type: 'Expression' },
          cases: [{ value: 'a', activities: [{ name: 'c1', type: 'Wait', waitTimeInSeconds: 3 }] }],
        },
      ],
    });
    const each = out.activities[0];
    expect(each.items).toBeUndefined();
    expect(each.typeProperties.items.value).toBe('@pipeline().parameters.list');
    expect(each.typeProperties.activities[0].typeProperties.notebookPath).toBe('/deep');
    expect(each.typeProperties.activities[0].notebookPath).toBeUndefined();
    const sw = out.activities[1];
    expect(sw.typeProperties.cases[0].activities[0].typeProperties.waitTimeInSeconds).toBe(3);
  });

  it('does not invent an empty typeProperties on an activity that had none', async () => {
    const { toAdfWireShape } = await load();
    const out: any = toAdfWireShape({ activities: [{ name: 'a', type: 'Wait' }] });
    expect(out.activities[0]).toEqual({ name: 'a', type: 'Wait' });
    expect('typeProperties' in out.activities[0]).toBe(false);
  });

  it('passes through anything that is not activity-shaped', async () => {
    const { toAdfWireShape } = await load();
    expect(toAdfWireShape(null as any)).toBeNull();
    expect(toAdfWireShape({ properties: { parameters: {} } } as any)).toEqual({ properties: { parameters: {} } });
  });
});
