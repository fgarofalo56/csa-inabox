/**
 * #3549/#3551 — a promotion must write the promoted definition onto the target
 * item BEFORE it runs the provisioner.
 *
 * THE BUG THIS PINS (found in independent review of the #3549 fix, not by its
 * author). `runPromotion` resolved-or-created the target item, ran the
 * provisioner, and only THEN wrote the promoted definition. For a target item
 * that already existed — the normal case for every promotion after the first —
 * the provisioner therefore inspected the target's PREVIOUS content.
 *
 * That was harmless while no provisioner looked at the item. The moment
 * semantic-model's read-back landed, promoting a model whose table count had
 * changed since the last promotion made the provisioner compare the SOURCE
 * shape against the TARGET's stale document, return `remediation`, flip
 * `anyFailed`, and record the stage `failed`/`partial` — while the write that
 * came next landed the correct content, so the promotion had actually
 * SUCCEEDED and re-running it came back green. A green re-run of a "failed"
 * deploy is exactly the signal an operator cannot act on.
 *
 * The assertion is on ORDERING, taken from the item the provisioner is handed —
 * not on the final state, which was correct even with the bug.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const TENANT = 'tenant-1';
const SRC_WS = 'ws-dev';
const TGT_WS = 'ws-test';

/** The promoted (source) definition — 2 tables. */
const SOURCE_CONTENT = {
  kind: 'semantic-model',
  tables: [{ name: 'a', columns: [] }, { name: 'b', columns: [] }],
  measures: [],
};
/** What the target carried from a PREVIOUS promotion — 1 table. */
const STALE_TARGET_CONTENT = {
  kind: 'semantic-model',
  tables: [{ name: 'a', columns: [] }],
  measures: [],
};

const sourceItem = {
  id: 'src-1', workspaceId: SRC_WS, itemType: 'semantic-model',
  displayName: 'Revenue model', description: 'd',
  state: { content: SOURCE_CONTENT },
};
const targetItem = {
  id: 'tgt-1', workspaceId: TGT_WS, itemType: 'semantic-model',
  displayName: 'Revenue model', description: 'd',
  state: { content: STALE_TARGET_CONTENT },
};

/** The target document as the world currently sees it. */
let targetDoc: any;
/** Content the provisioner observed on the item when it ran. */
let contentSeenByProvisioner: any;

const updateOwnedItem = vi.fn(async (_id: string, _t: string, _tenant: string, patch: any) => {
  targetDoc = { ...targetDoc, state: patch.state };
  return targetDoc;
});
const createOwnedItem = vi.fn(async () => ({ ok: true, item: { id: 'tgt-new' } }));

vi.mock('@/app/api/items/_lib/item-crud', () => ({
  listAllOwnedItems: vi.fn(async (_tenant: string, ws: string) => (ws === SRC_WS ? [sourceItem] : [targetItem])),
  createOwnedItem: (...a: unknown[]) => createOwnedItem(...(a as [])),
  updateOwnedItem: (...a: unknown[]) => updateOwnedItem(...(a as [])),
}));

const semanticModelProvisioner = vi.fn(async () => {
  // Stand-in for the real read-back: record what is on the item RIGHT NOW.
  contentSeenByProvisioner = targetDoc?.state?.content ?? null;
  return { status: 'created', steps: [] };
});

vi.mock('@/lib/install/provisioning-engine', () => ({
  PROVISIONERS: { 'semantic-model': (...a: unknown[]) => semanticModelProvisioner(...(a as [])) },
  resolveTarget: vi.fn(() => ({ mode: 'shared' })),
}));
vi.mock('@/lib/install/pipeline-deploy', () => ({ applyStageRules: vi.fn((t: unknown) => ({ target: t, applied: [] })) }));
vi.mock('@/lib/install/pipeline-compare', () => ({
  computePipelineDiff: vi.fn(() => ({ pairs: [], summary: {} })),
  pairKey: (it: any) => `${it.itemType}::${it.displayName}`,
}));
vi.mock('@/lib/install/pipeline-variables', () => ({
  stageValueSet: vi.fn(() => 'default'),
  collectStageVariableValues: vi.fn(() => ({ values: {}, secretNames: new Set() })),
  rebindContent: vi.fn((c: unknown) => ({ content: c, substitutions: [], skippedSecrets: [], unresolved: [] })),
}));
vi.mock('@/lib/azure/cosmos-client', () => ({
  pipelineHistoryContainer: vi.fn(async () => ({ items: { create: vi.fn(async () => ({})) } })),
}));
vi.mock('../pipeline-store', () => ({
  loadStageRules: vi.fn(async () => []),
  stageWorkspaceId: vi.fn(() => SRC_WS),
}));

import { runPromotion } from '../promote';

function input() {
  return {
    tenantId: TENANT,
    session: { claims: { oid: TENANT } } as never,
    actor: 'tester',
    pipeline: { id: 'pipe-1', stages: [] } as never,
    srcWs: SRC_WS,
    tgtWs: TGT_WS,
    sourceStageId: 'dev',
    targetStageId: 'test',
    targetStage: { id: 'test' } as never,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  targetDoc = JSON.parse(JSON.stringify(targetItem));
  contentSeenByProvisioner = undefined;
});

describe('#3549/#3551 runPromotion — the provisioner sees the PROMOTED definition', () => {
  it('the target item carries the promoted content BEFORE the provisioner runs', async () => {
    await runPromotion(input());

    expect(semanticModelProvisioner).toHaveBeenCalledTimes(1);
    // The heart of it: 2 tables (the source), not 1 (the stale target).
    expect(contentSeenByProvisioner).toEqual(SOURCE_CONTENT);
    expect(contentSeenByProvisioner.tables).toHaveLength(2);
  });

  it('a successful promotion is reported as succeeded, not failed', async () => {
    const res = await runPromotion(input());
    expect(res.status).not.toBe('failed');
    expect(res.deployedItemIds).toContain('tgt-1');
  });

  it('the definition write happens before the provisioner call, and the receipt after', async () => {
    await runPromotion(input());

    // Two writes: the promoted definition, then the receipt.
    expect(updateOwnedItem).toHaveBeenCalledTimes(2);
    const first = updateOwnedItem.mock.calls[0][3] as any;
    const second = updateOwnedItem.mock.calls[1][3] as any;

    expect(first.state.content).toEqual(SOURCE_CONTENT);
    expect(first.state.provisionResult).toBeUndefined();
    expect(second.state.provisionResult).toBeTruthy();
    // The receipt write must not drop the definition it was promoted with.
    expect(second.state.content).toEqual(SOURCE_CONTENT);
    expect(second.state.deployedFromStage).toBe('dev');
  });
});
