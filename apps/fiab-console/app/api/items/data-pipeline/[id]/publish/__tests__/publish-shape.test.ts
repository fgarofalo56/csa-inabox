/**
 * #3700 — EVERY write boundary that hands a pipeline definition to ADF must hand
 * over the ADF WIRE shape. There are three, and all three are pinned here:
 *
 *   - `POST /api/items/data-pipeline/[id]/publish`  (the Publish button)
 *   - `PUT  /api/items/data-pipeline/[id]`          ("Save = publish")
 *   - `GET  /api/items/data-pipeline/[id]/export`   (the SERIALIZE step)
 *
 * WHY ALL THREE AND NOT JUST PUBLISH. An independent review reverted the PUT
 * boundary by hand — `properties: props` instead of `properties: toAdfWireShape(props)`
 * — and measured `RC=0, 47 passed` across the whole data-pipeline suite plus
 * `pipeline-binding.test.ts`. The "Save = publish" path, which this change calls
 * a first-class defect, could be silently un-fixed with everything green, and no
 * test file imported the export route at all. A fix whose boundary has no test
 * is a fix that lasts until the next refactor.
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
 * with (and, for export, on the bytes handed to the archiver), which is what
 * reaches ARM and the customer's disk. Only Cosmos, auth, the ADF client, the
 * rate limiter, the zip writer and the deploy-target resolver are stubbed.
 *
 * WHAT THESE DO **NOT** ESTABLISH. That ADF then executes the pipeline, or that
 * ADF Studio imports the archive. Those are live-estate receipts (publish from
 * the editor, `GET` the ADF pipeline, read back `typeProperties`) and are called
 * out as unverified in the PR body rather than implied by a green suite here.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const upsertPipeline = vi.fn();
const getPipeline = vi.fn();
vi.mock('@/lib/azure/adf-client', () => ({
  upsertPipeline: (...a: any[]) => upsertPipeline(...a),
  getPipeline: (...a: any[]) => getPipeline(...a),
  deletePipeline: vi.fn(),
  adfConfigGate: () => null,
}));

vi.mock('@/lib/auth/session', () => ({ getSession: () => ({ claims: { oid: 'oid-1' } }) }));
vi.mock('@/lib/auth/workspace-guard', () => ({
  authorizeItemWorkspace: async () => null,
  authorizeWorkspace: async () => null,
}));
vi.mock('@/lib/azure/rate-limiter', () => ({ enforceRateLimit: async () => null }));
vi.mock('@/lib/azure/topology', () => ({
  prepareItemCreate: async () => ({ subscriptionId: 'sub', resourceGroup: 'rg' }),
  isDeployTargetGate: () => false,
}));

/** The entries the export handed to the archiver — asserting on these is
 *  asserting on the file the customer receives, without unzipping in a test. */
let zipEntries: { name: string; data: Buffer }[] = [];
vi.mock('@/lib/azure/zip', () => ({
  writeZip: (entries: { name: string; data: Buffer }[]) => {
    zipEntries = entries;
    return Buffer.from('PKfake');
  },
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
import { PUT } from '../../route';
import { GET as EXPORT_GET } from '../../export/route';
import { GET as DETAIL_GET } from '../../route';

const req = (body: any) => ({
  nextUrl: { searchParams: new URLSearchParams({ workspaceId: 'ws-1' }) },
  json: async () => body,
}) as any;
const ctx = { params: Promise.resolve({ id: 'item-1' }) } as any;

/** The properties object the ARM PUT actually carried. */
const putProperties = () => upsertPipeline.mock.calls[0][1].properties;
/** The pipeline spec inside the archive the export streamed. */
const exportedDefinition = () =>
  JSON.parse(zipEntries.find((e) => e.name === 'pipeline-content.json')!.data.toString('utf-8'));

beforeEach(() => {
  vi.clearAllMocks();
  replaced = null;
  zipEntries = [];
  getPipeline.mockRejectedValue(Object.assign(new Error('not found'), { code: 404 }));
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

/**
 * BOUNDARY 2 — `PUT /api/items/data-pipeline/[id]`, the "Save = publish" path.
 *
 * This is the boundary review reverted by hand with the entire suite still
 * green. It is a SEPARATE `upsertPipeline` call site from publish: the editor's
 * Save writes here, so a canvas-shaped PUT authors the same do-nothing ADF
 * pipeline even if Publish is never pressed.
 */
describe('boundary 2 — PUT [id] ("Save = publish")', () => {
  it('nests the activity body under typeProperties before the ARM PUT', async () => {
    const res = await PUT(
      req({
        definition: {
          properties: {
            activities: [{ name: 'a', type: 'DatabricksNotebook', notebookPath: '/saved-via-put' }],
          },
        },
      }),
      ctx,
    );
    expect(res.status).toBe(200);
    expect(upsertPipeline).toHaveBeenCalledTimes(1);
    const act = putProperties().activities[0];
    expect(act.typeProperties.notebookPath).toBe('/saved-via-put');
    expect(act.notebookPath).toBeUndefined();
  });

  it('keeps the CANVAS shape in state.definition — that is what the editor reloads', async () => {
    // The translation is a WIRE concern. Persisting the wire shape would break
    // `extractActivities()` and empty the designer, so the two shapes must
    // diverge here on purpose — asserted so a later "just normalize everything"
    // cannot quietly take the canvas with it.
    await PUT(
      req({
        definition: {
          properties: {
            activities: [{ name: 'a', type: 'DatabricksNotebook', notebookPath: '/saved-via-put' }],
          },
        },
      }),
      ctx,
    );
    expect(replaced.state.definition.properties.activities[0].notebookPath).toBe('/saved-via-put');
    expect(replaced.state.definition.properties.activities[0].typeProperties).toBeUndefined();
  });

  it('mints the ADF name and still wire-shapes it on the FIRST save of an unbound pipeline', async () => {
    // The branch that creates the ADF backing. It builds `adfName` itself, so it
    // is a distinct code path from the re-save above and had no coverage at all.
    delete itemDoc.state.adfPipelineName;
    await PUT(
      req({
        definition: { properties: { activities: [{ name: 'a', type: 'DatabricksNotebook', notebookPath: '/first' }] } },
      }),
      ctx,
    );
    expect(upsertPipeline).toHaveBeenCalledTimes(1);
    expect(upsertPipeline.mock.calls[0][0]).toBe('My Pipeline_item1');
    expect(putProperties().activities[0].typeProperties.notebookPath).toBe('/first');
  });
});

/**
 * BOUNDARY 3 — `GET /api/items/data-pipeline/[id]/export`, the SERIALIZE step.
 *
 * No test file imported this route before. Its docblock promises the archive is
 * "importable … directly into ADF Studio", and branch 2 (`state.definition`,
 * i.e. whatever the editor last saved — the canvas shape) is the branch most
 * exports actually take, so the promise was false for the common case.
 */
describe('boundary 3 — GET [id]/export (the archive handed to the customer)', () => {
  it('serializes the ADF wire shape, not the canvas shape, from state.definition', async () => {
    itemDoc.state.definition = {
      name: 'My_Pipeline_item1',
      properties: { activities: [{ name: 'a', type: 'DatabricksNotebook', notebookPath: '/exported' }] },
    };
    const res = await EXPORT_GET(req({}), ctx);
    expect(res.status).toBe(200);
    const act = exportedDefinition().properties.activities[0];
    expect(act.typeProperties.notebookPath).toBe('/exported');
    expect(act.notebookPath).toBeUndefined();
  });

  it('round-trips a definition read LIVE from ADF without moving its root keys', async () => {
    // The idempotence claim, on the branch where it matters most: a live ADF
    // activity already carries `typeProperties`, plus root keys this repo does
    // not enumerate (`state`, `onInactiveMarkAs`). Moving one of those into
    // `typeProperties` would corrupt an archive built from a WORKING pipeline.
    getPipeline.mockResolvedValue({
      name: 'My_Pipeline_item1',
      properties: {
        activities: [{
          name: 'a', type: 'DatabricksNotebook',
          state: 'Inactive', onInactiveMarkAs: 'Succeeded',
          typeProperties: { notebookPath: '/live' },
        }],
      },
    });
    const res = await EXPORT_GET(req({}), ctx);
    expect(res.status).toBe(200);
    const act = exportedDefinition().properties.activities[0];
    expect(act.typeProperties).toEqual({ notebookPath: '/live' });
    expect(act.state).toBe('Inactive');
    expect(act.onInactiveMarkAs).toBe('Succeeded');
  });

  it('404s rather than shipping an empty archive when nothing is recoverable', async () => {
    // CONTROL — without it the assertions above would also be satisfied by an
    // export that always produced a file, regardless of what it found.
    const res = await EXPORT_GET(req({}), ctx);
    expect(res.status).toBe(404);
    expect(zipEntries).toEqual([]);
  });
});

/**
 * boundary 0 — `GET /api/items/data-pipeline/[id]`, the READ that decides which
 * shape the editor holds. This is where the MIXED shape was born.
 *
 * WHY A READ IS PINNED IN A FILE ABOUT WRITE BOUNDARIES. `toAdfWireShape` uses
 * "has a `typeProperties` object" to mean "already wire-shaped, preserve every
 * root key" — the rule that keeps a live-ADF `state`/`onInactiveMarkAs` at the
 * root. When this route handed the editor a CANVAS-shaped activity, one
 * inspector edit added a `typeProperties` beside the root config
 * (`activity-forms.tsx:545` through the shallow merge in
 * `data-pipeline-editor.tsx:582`), and every write boundary below then took the
 * preserve branch and shipped ADF `{ name, type, notebookPath, typeProperties }`
 * — `notebookPath` where the service does not look. Green suite, dead activity:
 * #3700's own symptom surviving #3700's fix.
 *
 * These cases FAIL on the pre-fix route (they assert the root key is GONE, and
 * the pre-fix route returned it at the root for both non-ADF branches), and
 * they are DISJOINT-KEY cases on purpose: the pre-existing mixed-shape test
 * only covers a same-key collision, which the preserve branch happens to get
 * right, so it could not see this.
 *
 * TWO OF THREE BRANCHES, AND THE THIRD IS PINNED AS A RESIDUAL. The live-ADF
 * branch is deliberately NOT repaired, so the population #3700 itself created —
 * pipelines pre-fix Loom published into ADF in the canvas shape — still reaches
 * the editor unrepaired. The last case below asserts exactly that, so the
 * decision is a red test away from being reversed rather than a claim in a
 * comment. Round-2 review asked for either the repair or this case.
 */
describe('boundary 0 — GET [id] (the shape the editor is handed)', () => {
  it('hands the editor the WIRE shape for a bundle-installed pipeline', async () => {
    itemDoc.state = {
      content: {
        kind: 'adf-pipeline',
        activities: [{
          name: 'nb1',
          type: 'DatabricksNotebook',
          config: { notebookPath: '/Shared/loom/ingest', baseParameters: { env: 'dev' } },
        }],
      },
    };
    const res = await DETAIL_GET(req({}), ctx);
    expect(res.status).toBe(200);
    const act = (await res.json()).definition.properties.activities[0];
    expect(act.typeProperties.notebookPath).toBe('/Shared/loom/ingest');
    expect(act.typeProperties.baseParameters).toEqual({ env: 'dev' });
    expect(act.notebookPath).toBeUndefined();
    expect(act.baseParameters).toBeUndefined();
  });

  it('repairs a LEGACY canvas-shaped state.definition on the way out', async () => {
    // The ~13 items persisted in the root shape before #3700. Without this the
    // editor still receives the flat form and can still mint the mixed shape.
    itemDoc.state = {
      definition: {
        properties: {
          activities: [{ name: 'nb1', type: 'DatabricksNotebook', notebookPath: '/legacy' }],
        },
      },
    };
    const res = await DETAIL_GET(req({}), ctx);
    const act = (await res.json()).definition.properties.activities[0];
    expect(act.typeProperties).toEqual({ notebookPath: '/legacy' });
    expect(act.notebookPath).toBeUndefined();
  });

  it('leaves a definition read LIVE from ADF byte-identical, unknown root keys and all', async () => {
    // CONTROL for the two above: the repair must not become "rewrite everything
    // the editor is shown", or it re-introduces the defect the discriminator
    // exists to prevent — a deactivated ADF activity silently re-activated.
    const live = {
      name: 'My_Pipeline_item1',
      properties: {
        activities: [{
          name: 'copy1', type: 'Copy',
          state: 'Inactive', onInactiveMarkAs: 'Skipped',
          policy: { timeout: '7.00:00:00' },
          typeProperties: { source: { type: 'DelimitedTextSource' }, sink: { type: 'ParquetSink' } },
        }],
      },
    };
    getPipeline.mockResolvedValue(structuredClone(live));
    const res = await DETAIL_GET(req({}), ctx);
    expect((await res.json()).definition).toEqual(live);
  });

  it('RESIDUAL, PINNED — a CANVAS-shaped definition read live from ADF is handed over UNREPAIRED', async () => {
    // THE DECISION, MADE VISIBLE INSTEAD OF ASSERTED IN PROSE. Round-2 review
    // measured this exact population and asked for either a repair or a pinned
    // case; the repair is declined, so this is the case. #3700's premise is that
    // three write paths PUT the CANVAS shape, so for every pipeline Loom
    // published pre-fix ADF itself holds `notebookPath` at the activity root,
    // `getPipeline` returns it, and this branch passes it straight through. ONE
    // inspector patch then mints the mixed activity, which the preserve branch
    // ships back to ADF unmoved — #3700's symptom surviving #3700's fix on the
    // items that have it.
    //
    // WHY NOT REPAIRED HERE. Normalizing this branch would take
    // `normalizeActivity`'s CANVAS branch on any live activity lacking
    // `typeProperties` and move root keys ADF owns — `state` /
    // `onInactiveMarkAs`, absent from both `ADF_ACTIVITY_ROOT_KEYS` and the
    // published ARM schema — which is the regression the control above exists
    // for. The tie is not breakable from the document.
    //
    // ASSERTED AS A FACT ABOUT TODAY, NOT AS A DESIRED OUTCOME: if someone later
    // decides the repair IS worth its risk, this test goes red and they have to
    // say so, rather than the docblock and the code drifting apart again.
    const liveCanvas = {
      name: 'My_Pipeline_item1',
      properties: {
        activities: [{
          name: 'nb1', type: 'DatabricksNotebook',
          notebookPath: '/Shared/legacy', baseParameters: { env: 'prod' },
        }],
      },
    };
    getPipeline.mockResolvedValue(structuredClone(liveCanvas));
    const res = await DETAIL_GET(req({}), ctx);
    const act = (await res.json()).definition.properties.activities[0];
    expect(act.notebookPath).toBe('/Shared/legacy');
    expect(act.typeProperties).toBeUndefined();
  });

  it('CONTROL — an item with no content and no definition still yields null, not a fabricated one', async () => {
    itemDoc.state = { adfPipelineName: 'My_Pipeline_item1' };
    const res = await DETAIL_GET(req({}), ctx);
    expect(res.status).toBe(200);
    expect((await res.json()).definition).toBeNull();
  });
});
