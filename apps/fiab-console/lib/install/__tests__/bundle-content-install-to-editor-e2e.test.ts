/**
 * #3549 / #3551 — END-TO-END TRACE: real bundle → install state → provisioner →
 * the editor's read path, over ONE in-memory Cosmos document.
 *
 * WHY THIS EXISTS ALONGSIDE THE UNIT TESTS. Every other test in this fix mocks
 * one seam and asserts on the module either side of it, which is how the defect
 * survived in the first place: the install wrote correct content, the provisioner
 * counted it correctly, the editor read correctly from where IT looked — three
 * modules each right in isolation and a product that shipped an empty model.
 * Only a test that carries ONE document through ALL of them can see that.
 *
 * WHAT IS REAL HERE
 *   • the content — `resolveBundleItem('app-azure-realtime-analytics', …)`, the
 *     same call `app/api/apps/[id]/install/route.ts` makes. Not a fixture: if
 *     the bundle is re-authored, this test moves with it.
 *   • the install's state shape — assembled exactly as the route assembles it,
 *     from that resolved content.
 *   • `semanticModelProvisioner` — the real provisioner, unmodified.
 *   • `loadModelContext` — the real function `GET /api/items/semantic-model/
 *     [id]/model` calls, which is what `LoomNativeModelView` renders.
 *
 * WHAT IS NOT REAL (stated, not implied): Cosmos is an in-memory double, and
 * there is no browser. This proves the CHAIN is continuous and that the numbers
 * the receipt reports are the numbers the editor can read. It does not discharge
 * the G1 in-browser receipt that `ux-baseline.md` requires before #3549/#3551
 * may be closed.
 *
 * THE ASSERTION THAT MATTERS: the table/measure counts on the install receipt
 * and the table/measure counts the editor reads are compared to EACH OTHER, not
 * to hard-coded numbers. That is precisely the equality the live estate
 * violated — a banner reading "2 tables · 4 measures" over an editor reading
 * "no tables yet" — and it holds no matter what the bundle is re-authored to say.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const TENANT = 'tenant-oid-1';
const WORKSPACE = 'ws-uat-1';
const ITEM_ID = 'sm-e2e-1';

/** A single in-memory Cosmos document — the ONE seam both halves share. */
const store = new Map<string, any>();

vi.mock('@/lib/azure/cosmos-client', () => ({
  itemsContainer: vi.fn(async () => ({
    // Point read — what the provisioner's read-back uses.
    item: (id: string, _pk: string) => ({
      read: async () => ({ resource: store.get(id) }),
      replace: async (doc: any) => { store.set(doc.id, doc); return { resource: doc }; },
    }),
    // Cross-partition query — what the editor's read path uses.
    items: {
      query: (spec: any) => ({
        fetchAll: async () => {
          const wanted = (spec.parameters || []).find((p: any) => p.name === '@id')?.value;
          const doc = store.get(wanted);
          return { resources: doc ? [doc] : [] };
        },
      }),
    },
  })),
  workspacesContainer: vi.fn(async () => ({
    item: (id: string, tenantId: string) => ({
      read: async () => ({ resource: { id, tenantId } }),
    }),
  })),
}));

// No Power BI anywhere on this path (no-fabric-dependency.md). Any call is a
// failure of the test's premise, so they throw loudly rather than return [].
vi.mock('@/lib/azure/powerbi-client', () => ({
  getDataset: vi.fn(async () => { throw new Error('Power BI must not be reached on the Azure-native default path'); }),
  listDatasetTables: vi.fn(async () => { throw new Error('Power BI must not be reached on the Azure-native default path'); }),
  listDatasetRelationships: vi.fn(async () => { throw new Error('Power BI must not be reached on the Azure-native default path'); }),
  createPushDataset: vi.fn(), listWorkspaces: vi.fn(), postPushRows: vi.fn(),
  PowerBiError: class extends Error { status = 500; },
  POWERBI_SP_HINT: 'hint',
}));
vi.mock('@/lib/azure/fabric-client', () => ({
  FabricError: class extends Error { status = 500; },
  fabricHint: () => 'hint',
}));
vi.mock('@azure/identity', () => ({
  ChainedTokenCredential: class {}, DefaultAzureCredential: class {}, ManagedIdentityCredential: class {},
}));
vi.mock('@/lib/azure/aca-managed-identity', () => ({ AcaManagedIdentityCredential: class {} }));
vi.mock('@/lib/azure/aas-client', () => ({
  buildModelBimTmsl: vi.fn(() => ({})), buildCreateOrReplaceRelationshipTmsl: vi.fn(() => ({})),
  buildDeleteRelationshipTmsl: vi.fn(() => ({})), buildAlterTableHierarchyTmsl: vi.fn(() => ({})),
  executeAasXmla: vi.fn(async () => ({})), updateFabricSemanticModelTmsl: vi.fn(async () => ({})),
  aasConfig: vi.fn(() => ({ configured: false })), fabricWriteEnabled: vi.fn(() => false),
}));

import { resolveBundleItem } from '@/lib/apps/content-bundles';
import { semanticModelProvisioner } from '../provisioners/semantic-model';
import { loadModelContext } from '@/lib/semantic-model/model-context';

const APP_ID = 'app-azure-realtime-analytics';

/**
 * Phase 1 of the install, transcribed from
 * `app/api/apps/[id]/install/route.ts` — the `state` object it hands to
 * `createOwnedItem`.
 *
 * THIS IS A TRANSCRIPTION, NOT THE ROUTE. The route assembles this inline
 * inside `runInstallJob`, which is not exported and cannot be driven without a
 * Cosmos job document, a session and an app doc. So this function alone would
 * NOT notice the route dropping its `content` stamp — an earlier revision of
 * this docstring claimed it would, which was the same unverified assertion this
 * PR exists to close. The claim is made true by the SOURCE PIN below instead,
 * which is honest about being a source pin rather than a behavioural one.
 */
function installPhase1(bundle: { displayName: string; content: unknown }) {
  const state: Record<string, unknown> = {
    sourceApp: APP_ID,
    ...(bundle.content ? { content: bundle.content } : {}),
  };
  return {
    id: ITEM_ID,
    workspaceId: WORKSPACE,
    itemType: 'semantic-model',
    displayName: bundle.displayName,
    state,
  };
}

beforeEach(() => {
  store.clear();
  vi.clearAllMocks();
});

describe('#3549/#3551 install → provision → editor, end to end on one Cosmos document', () => {
  it('the install route still STAMPS state.content (source pin for the transcription above)', () => {
    // The whole trace below rests on the route writing `content` at item
    // creation. `runInstallJob` is not exported and needs a Cosmos job doc, a
    // session and an app doc to drive, so this is pinned at the SOURCE — a
    // weaker check than behaviour, stated as such rather than implied.
    // Comments are stripped first so the prose in this repo's heavily-commented
    // routes cannot satisfy the assertion (the exact "presence not enforcement"
    // shape #3549's own guard had to be hardened against).
    const src = readFileSync(
      resolve(__dirname, '..', '..', '..', 'app', 'api', 'apps', '[id]', 'install', 'route.ts'),
      'utf8',
    );
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');

    expect(code).toMatch(/\.\.\.\(\s*bundle\?\.content\s*\?\s*\{\s*content:\s*bundle\.content\s*\}/);
    // …and the dedup path backfills it onto a name-matched item that has none,
    // which is what makes the provisioner's remediation text true.
    expect(code).toMatch(/content:\s*bundle\.content,\s*sourceApp:\s*app\.id/);
  });

  it('the receipt counts and the editor counts are THE SAME numbers', async () => {
    const bundle = await resolveBundleItem(APP_ID, 'semantic-model');
    expect(bundle, `${APP_ID} must still ship a semantic-model item`).toBeTruthy();

    // ── Phase 1: the install creates the item WITH its content.
    store.set(ITEM_ID, installPhase1(bundle!));

    // ── Phase 2: the real provisioner runs against that item.
    const receipt = await semanticModelProvisioner({
      session: { claims: { oid: TENANT } } as any,
      target: { mode: 'shared', semanticBackend: 'loom-native', warehouseServer: 'wh.sql.azuresynapse.net' } as any,
      cosmosItemId: ITEM_ID,
      workspaceId: WORKSPACE,
      displayName: bundle!.displayName,
      content: bundle!.content,
      appId: APP_ID,
    });
    expect(receipt.status).toBe('created');
    expect(receipt.secondaryIds?.contentReadable).toBe('true');

    // ── Open: the editor's read path, by the BARE item id and with NO
    // ?workspaceId= — exactly how LoomNativeModelView calls it.
    const mctx = await loadModelContext(ITEM_ID, null, TENANT);

    // THE EQUALITY THE LIVE ESTATE VIOLATED.
    expect(mctx.tables.length).toBe(Number(receipt.secondaryIds!.tables));
    expect(mctx.measures!.length).toBe(Number(receipt.secondaryIds!.measures));

    // …and both are a real, non-empty model, so the equality is not 0 === 0.
    expect(mctx.tables.length).toBeGreaterThan(0);
    expect(mctx.measures!.length).toBeGreaterThan(0);
    expect(mctx.tables.every((t) => t.columns.length > 0)).toBe(true);
    expect(mctx.modelName).toBe(bundle!.displayName);
  });

  it('nothing on this path touches Power BI', async () => {
    const bundle = await resolveBundleItem(APP_ID, 'semantic-model');
    store.set(ITEM_ID, installPhase1(bundle!));
    // The powerbi-client mocks throw; reaching one fails the test by exception.
    await loadModelContext(ITEM_ID, null, TENANT);
  });

  it('if the install stops stamping content, the install FAILS instead of lying', async () => {
    // The counterfactual: same bundle, but Phase 1 drops `content`. Before this
    // fix the provisioner still reported `created` with the bundle's counts.
    const bundle = await resolveBundleItem(APP_ID, 'semantic-model');
    store.set(ITEM_ID, { ...installPhase1(bundle!), state: { sourceApp: APP_ID } });

    const receipt = await semanticModelProvisioner({
      session: { claims: { oid: TENANT } } as any,
      target: { mode: 'shared', semanticBackend: 'loom-native' } as any,
      cosmosItemId: ITEM_ID,
      workspaceId: WORKSPACE,
      displayName: bundle!.displayName,
      content: bundle!.content,
      appId: APP_ID,
    });

    expect(receipt.status).not.toBe('created');
    expect(receipt.secondaryIds?.contentReadable).toBe('false');

    // And the editor genuinely has nothing — i.e. the receipt is telling the truth.
    const mctx = await loadModelContext(ITEM_ID, null, TENANT);
    expect(mctx.tables).toHaveLength(0);
  });
});
