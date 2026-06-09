/**
 * Unit tests for the Loom-native deployment-pipeline compare engine.
 * Pure transform — no Azure / Cosmos. Asserts the four diff statuses and that
 * buildTmsl-based serialization detects a real model change.
 */
import { describe, it, expect, vi } from 'vitest';

// buildTmsl lives in semantic-model.ts which imports @azure/identity at module
// top; the real ESM package has an unresolved transitive in this test env, so
// stub it (the compare engine never uses a credential).
vi.mock('@azure/identity', () => {
  class Cred { async getToken() { return { token: 'tk', expiresOnTimestamp: Date.now() + 3600_000 }; } }
  return { DefaultAzureCredential: Cred, ManagedIdentityCredential: Cred, ChainedTokenCredential: Cred };
});

import { computePipelineDiff, serializeItemDef, pairKey } from '../pipeline-compare';
import type { WorkspaceItem } from '@/lib/types/workspace';

function item(partial: Partial<WorkspaceItem> & { itemType: string; displayName: string; content?: unknown }): WorkspaceItem {
  return {
    id: partial.id || `id-${Math.random().toString(36).slice(2)}`,
    workspaceId: partial.workspaceId || 'ws',
    itemType: partial.itemType,
    displayName: partial.displayName,
    state: { content: partial.content ?? null },
    createdBy: 'u', createdAt: 'now', updatedAt: 'now',
  };
}

const model = (tables: any[]) => ({
  tables, measures: [], relationships: [],
});

describe('serializeItemDef', () => {
  it('semantic-model serializes through buildTmsl deterministically', () => {
    const a = item({ id: 'a', itemType: 'semantic-model', displayName: 'Sales', content: model([{ name: 'Fact', columns: [{ name: 'Id', dataType: 'int64' }] }]) });
    const b = item({ id: 'b', itemType: 'semantic-model', displayName: 'Sales', content: model([{ name: 'Fact', columns: [{ name: 'Id', dataType: 'int64' }] }]) });
    expect(serializeItemDef(a)).toBe(serializeItemDef(b));
  });

  it('report serializes via stable JSON regardless of key order', () => {
    const a = item({ itemType: 'report', displayName: 'R', content: { a: 1, b: 2 } });
    const b = item({ itemType: 'report', displayName: 'R', content: { b: 2, a: 1 } });
    expect(serializeItemDef(a)).toBe(serializeItemDef(b));
  });

  it('pairKey is type + lowercased name', () => {
    expect(pairKey(item({ itemType: 'report', displayName: 'Sales Report' }))).toBe('report::sales report');
  });
});

describe('computePipelineDiff', () => {
  it('labels identical semantic-model content Same', () => {
    const src = [item({ id: 's', itemType: 'semantic-model', displayName: 'Sales', content: model([{ name: 'F', columns: [{ name: 'Id', dataType: 'int64' }] }]) })];
    const tgt = [item({ id: 't', itemType: 'semantic-model', displayName: 'Sales', content: model([{ name: 'F', columns: [{ name: 'Id', dataType: 'int64' }] }]) })];
    const { pairs, summary } = computePipelineDiff(src, tgt);
    expect(summary).toEqual({ same: 1, different: 0, onlyInSource: 0, notInSource: 0 });
    expect(pairs[0].status).toBe('Same');
  });

  it('labels a changed model Different (extra table)', () => {
    const src = [item({ id: 's', itemType: 'semantic-model', displayName: 'Sales', content: model([{ name: 'F', columns: [{ name: 'Id', dataType: 'int64' }] }, { name: 'Dim', columns: [{ name: 'Id', dataType: 'int64' }] }]) })];
    const tgt = [item({ id: 't', itemType: 'semantic-model', displayName: 'Sales', content: model([{ name: 'F', columns: [{ name: 'Id', dataType: 'int64' }] }]) })];
    const { pairs, summary } = computePipelineDiff(src, tgt);
    expect(summary.different).toBe(1);
    expect(pairs[0].status).toBe('Different');
    expect(pairs[0].diffSummary).toMatch(/TMSL changed/);
  });

  it('labels a source-only item OnlyInSource', () => {
    const src = [item({ id: 's', itemType: 'notebook', displayName: 'Prep' })];
    const { summary, pairs } = computePipelineDiff(src, []);
    expect(summary.onlyInSource).toBe(1);
    expect(pairs[0].status).toBe('OnlyInSource');
    expect(pairs[0].sourceItemId).toBe('s');
  });

  it('labels a target-only item NotInSource', () => {
    const tgt = [item({ id: 't', itemType: 'report', displayName: 'Legacy' })];
    const { summary, pairs } = computePipelineDiff([], tgt);
    expect(summary.notInSource).toBe(1);
    expect(pairs[0].status).toBe('NotInSource');
    expect(pairs[0].targetItemId).toBe('t');
  });

  it('handles a mixed set across all four statuses', () => {
    const src = [
      item({ itemType: 'report', displayName: 'Same', content: { x: 1 } }),
      item({ itemType: 'report', displayName: 'Changed', content: { x: 1 } }),
      item({ itemType: 'notebook', displayName: 'NewOne' }),
    ];
    const tgt = [
      item({ itemType: 'report', displayName: 'Same', content: { x: 1 } }),
      item({ itemType: 'report', displayName: 'Changed', content: { x: 2 } }),
      item({ itemType: 'report', displayName: 'OldOne' }),
    ];
    const { summary } = computePipelineDiff(src, tgt);
    expect(summary).toEqual({ same: 1, different: 1, onlyInSource: 1, notInSource: 1 });
  });
});
