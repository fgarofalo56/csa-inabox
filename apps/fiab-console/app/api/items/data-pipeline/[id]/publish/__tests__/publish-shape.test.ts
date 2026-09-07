/**
 * #3700 — `POST /api/items/data-pipeline/[id]/publish` must PUT the ADF WIRE
 * shape, on EVERY branch of its definition-resolution chain.
 *
 * THE DEFECT THESE PIN. The editor's canvas holds each activity's config spread
 * onto the activity ROOT — that is what `extractActivities()` and the node
 * inspectors read, and it is correct for the canvas. Publish POSTed that spec
 * (branch 1), persisted it to `state.definition`, and re-published it from there
 * on the next call (branch 2) — and both went to `upsertPipeline` untranslated.
 * ADF reads `typeProperties` and IGNORES root-level keys, so the ARM PUT
 * returned 200 and authored a `DatabricksNotebook` activity whose `notebookPath`
 * sat where the service never looks: publishes successfully, does nothing.
 * Only branch 3 (bundle `state.content`) asked for `target: 'adf'`.
 *
 * WHAT IS NOT MOCKED. `toAdfWireShape` and the whole resolution chain RUN FOR
 * REAL — the assertion is on the ARGUMENT `upsertPipeline` was actually called
 * with, which is the byte that reaches ARM. Only Cosmos, auth, the ADF client
 * and the deploy-target resolver are stubbed.
 *
 * WHAT THESE DO **NOT** ESTABLISH. That ADF then executes the pipeline. That is
 * a live-estate receipt (publish from the editor, `GET` the ADF pipeline, read
 * back `typeProperties`) and is called out as unverified in the PR body rather
 * than implied by a green suite here.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const upsertPipeline = vi.fn();
vi.mock('@/lib/azure/adf-client', () => ({
  upsertPipeline: (...a: any[]) => upsertPipeline(...a),
  adfConfigGate: () => null,
}));

vi.mock('@/lib/auth/session', () => ({ getSession: () => ({ claims: { oid: 'oid-1' } }) }));
vi.mock('@/lib/auth/workspace-guard', () => ({ authorizeItemWorkspace: async () => null }));
vi.mock('@/lib/azure/topology', () => ({
  prepareItemCreate: async () => ({ subscriptionId: 'sub', resourceGroup: 'rg' }),
  isDeployTargetGate: () => false,
}));

let itemDoc: any = null;
let replaced: any = null;
vi.mock('@/lib/azure/cosmos-client', () => ({
  itemsContainer: async () => ({
    item: () => ({
      read: async () => ({ resource: itemDoc }),
      replace: async (doc: any) => { replaced = doc; return { resource: doc }; },
    }),
  }),
}));

import { POST } from '../route';

const req = (body: any) => ({
  nextUrl: { searchParams: new URLSearchParams({ workspaceId: 'ws-1' }) },
  json: async () => body,
}) as any;
const ctx = { params: Promise.resolve({ id: 'item-1' }) } as any;

/** The properties object the ARM PUT actually carried. */
const putProperties = () => upsertPipeline.mock.calls[0][1].properties;

beforeEach(() => {
  vi.clearAllMocks();
  replaced = null;
  itemDoc = {
    id: 'item-1',
    itemType: 'data-pipeline',
    workspaceId: 'ws-1',
    displayName: 'My Pipeline',
    state: { adfPipelineName: 'My_Pipeline_item1' },
  };
});

describe('branch 1 — the canvas spec POSTed by the editor Publish button', () => {
  it('nests the activity body under typeProperties before the ARM PUT', async () => {
    const res = await POST(
      req({
        definition: {
          properties: {
            activities: [{ name: 'a', type: 'DatabricksNotebook', notebookPath: '/x' }],
          },
        },
      }),
      ctx,
    );
    expect(res.status).toBe(200);
    expect(upsertPipeline).toHaveBeenCalledTimes(1);
    const act = putProperties().activities[0];
    expect(act.typeProperties.notebookPath).toBe('/x');
    // The root-level key is what ADF ignored — it must be GONE, not merely
    // duplicated, or the document still carries the shape that misled review.
    expect(act.notebookPath).toBeUndefined();
  });

  it('does not disturb the well-known root siblings or the parameters block', async () => {
    await POST(
      req({
        definition: {
          properties: {
            activities: [{
              name: 'copy', type: 'Copy',
              policy: { timeout: '7.00:00:00' },
              linkedServiceName: { referenceName: 'ls', type: 'LinkedServiceReference' },
              dependsOn: [{ activity: 'prev', dependencyConditions: ['Succeeded'] }],
              source: { type: 'DelimitedTextSource' },
            }],
            parameters: { p1: { type: 'String' } },
          },
        },
      }),
      ctx,
    );
    const props = putProperties();
    const act = props.activities[0];
    expect(act.policy).toEqual({ timeout: '7.00:00:00' });
    expect(act.linkedServiceName.referenceName).toBe('ls');
    expect(act.dependsOn[0].activity).toBe('prev');
    expect(act.typeProperties).toEqual({ source: { type: 'DelimitedTextSource' } });
    expect(props.parameters).toEqual({ p1: { type: 'String' } });
  });
});

describe('branch 2 — the definition a previous save persisted to state.definition', () => {
  it('is translated too (this is the branch a re-publish takes)', async () => {
    itemDoc.state.definition = {
      properties: { activities: [{ name: 'a', type: 'DatabricksNotebook', notebookPath: '/saved' }] },
    };
    await POST(req({}), ctx);
    const act = putProperties().activities[0];
    expect(act.typeProperties.notebookPath).toBe('/saved');
    expect(act.notebookPath).toBeUndefined();
  });
});

describe('branch 3 — bundle state.content, which already asked for target:adf', () => {
  it('still lands wire-shaped (the translator is idempotent, so it is unharmed)', async () => {
    itemDoc.state.content = {
      kind: 'adf-pipeline',
      activities: [{ name: 'a', type: 'DatabricksNotebook', config: { notebookPath: '/bundle' } }],
    };
    await POST(req({}), ctx);
    const act = putProperties().activities[0];
    expect(act.typeProperties.notebookPath).toBe('/bundle');
    expect(act.notebookPath).toBeUndefined();
  });
});

describe('the honest refusals are unchanged', () => {
  it('400s when there is no activity definition anywhere, without calling ARM', async () => {
    const res = await POST(req({}), ctx);
    expect(res.status).toBe(400);
    expect(upsertPipeline).not.toHaveBeenCalled();
  });

  it('stamps the binding on success so Run/Debug resolve the live pipeline', async () => {
    // CONTROL. Without this, every assertion above would equally be satisfied by
    // a publish path that stopped short of doing its actual job.
    await POST(
      req({ definition: { properties: { activities: [{ name: 'a', type: 'Wait' }] } } }),
      ctx,
    );
    expect(replaced?.state?.adfPipelineName).toBe('My_Pipeline_item1');
  });
});
