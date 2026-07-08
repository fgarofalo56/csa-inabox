/**
 * Vitest for lineage-gc (LIN-GC) — delete-time metadata cleanup, orphan
 * reconciliation, and the render-side deleted-node annotation.
 *
 * Everything here is best-effort + fire-and-forget: a cleanup captures an
 * outcome for logging but NEVER throws, so a failing primitive can't block a
 * delete. Reconciliation diffs Loom-provisioned Purview entities (the
 * `loom://…` qualifiedName scheme) against live Cosmos items.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const h = vi.hoisted(() => ({
  offboardFromPurview: vi.fn(),
  loomTypeToAtlasTypeName: vi.fn((t: string) => (t === 'lakehouse' ? 'fabric_lakehouse' : 'DataSet')),
  reconcileThreadEdgesOnDelete: vi.fn(),
  isPurviewConfigured: vi.fn(() => true),
  searchDataMapAssets: vi.fn(),
  deleteAtlasEntityByQualifiedName: vi.fn(),
  itemsContainer: vi.fn(),
  query: vi.fn(),
}));

vi.mock('../purview-autoonboard', () => ({
  offboardFromPurview: h.offboardFromPurview,
  loomTypeToAtlasTypeName: h.loomTypeToAtlasTypeName,
}));
vi.mock('@/lib/thread/thread-edges', () => ({
  reconcileThreadEdgesOnDelete: h.reconcileThreadEdgesOnDelete,
}));
vi.mock('../purview-client', () => ({
  isPurviewConfigured: h.isPurviewConfigured,
  searchDataMapAssets: h.searchDataMapAssets,
  deleteAtlasEntityByQualifiedName: h.deleteAtlasEntityByQualifiedName,
}));
vi.mock('../cosmos-client', () => ({
  itemsContainer: h.itemsContainer,
}));

import {
  cleanupItemMetadata,
  cleanupWorkspaceMetadata,
  parseLoomQualifiedName,
  findLineageOrphans,
  purgeLineageOrphans,
  annotateDeletedLoomNodes,
} from '../lineage-gc';

const item = (id: string, itemType = 'lakehouse') => ({ id, workspaceId: 'ws1', itemType, state: {} });

/** Mock itemsContainer so its cross-partition query returns `liveIds` as rows. */
function mockLiveIds(liveIds: string[]) {
  h.query.mockReturnValue({ fetchAll: async () => ({ resources: liveIds.map((id) => ({ id })) }) });
  h.itemsContainer.mockResolvedValue({ items: { query: h.query } });
}

beforeEach(() => {
  Object.values(h).forEach((fn: any) => typeof fn?.mockReset === 'function' && fn.mockReset());
  h.isPurviewConfigured.mockReturnValue(true);
  h.loomTypeToAtlasTypeName.mockImplementation((t: string) => (t === 'lakehouse' ? 'fabric_lakehouse' : 'DataSet'));
});

// ── cleanupItemMetadata ──────────────────────────────────────────────────────

describe('cleanupItemMetadata', () => {
  it('calls both primitives and reports ok', async () => {
    h.offboardFromPurview.mockResolvedValue(undefined);
    h.reconcileThreadEdgesOnDelete.mockResolvedValue(undefined);
    const out = await cleanupItemMetadata(item('i1'), 'tenant-1');
    expect(h.offboardFromPurview).toHaveBeenCalledWith(expect.objectContaining({ id: 'i1' }), 'tenant-1');
    expect(h.reconcileThreadEdgesOnDelete).toHaveBeenCalledWith('tenant-1', 'i1', { mode: 'remove' });
    expect(out).toEqual({ itemId: 'i1', purview: 'ok', edges: 'ok' });
  });

  it('reports purview skipped when Purview is unconfigured', async () => {
    h.isPurviewConfigured.mockReturnValue(false);
    const out = await cleanupItemMetadata(item('i1'), 'tenant-1');
    expect(out.purview).toBe('skipped');
  });

  it('never throws and records error when a primitive throws', async () => {
    h.offboardFromPurview.mockRejectedValue(new Error('atlas 500'));
    h.reconcileThreadEdgesOnDelete.mockRejectedValue(new Error('cosmos down'));
    const out = await cleanupItemMetadata(item('i1'), 'tenant-1');
    expect(out).toEqual({ itemId: 'i1', purview: 'error', edges: 'error' });
  });
});

describe('cleanupWorkspaceMetadata', () => {
  it('reconciles every item and returns per-item outcomes', async () => {
    h.offboardFromPurview.mockResolvedValue(undefined);
    h.reconcileThreadEdgesOnDelete.mockResolvedValue(undefined);
    const out = await cleanupWorkspaceMetadata([item('a'), item('b'), item('c')], 'tenant-1');
    expect(out).toHaveLength(3);
    expect(h.offboardFromPurview).toHaveBeenCalledTimes(3);
    expect(out.map((o) => o.itemId)).toEqual(['a', 'b', 'c']);
  });
});

// ── parseLoomQualifiedName ───────────────────────────────────────────────────

describe('parseLoomQualifiedName', () => {
  it('parses a loom:// qualifiedName into its parts', () => {
    expect(parseLoomQualifiedName('loom://t1/ws2/lakehouse/i3')).toEqual({
      tenantId: 't1', workspaceId: 'ws2', itemType: 'lakehouse', itemId: 'i3',
    });
  });
  it('rejects non-loom and malformed qualifiedNames', () => {
    expect(parseLoomQualifiedName('https://x/y')).toBeNull();
    expect(parseLoomQualifiedName('loom://t1/ws2/lakehouse')).toBeNull();
    expect(parseLoomQualifiedName('')).toBeNull();
  });
});

// ── findLineageOrphans ───────────────────────────────────────────────────────

describe('findLineageOrphans', () => {
  it('returns empty when Purview is unconfigured', async () => {
    h.isPurviewConfigured.mockReturnValue(false);
    const scan = await findLineageOrphans();
    expect(scan).toEqual({ purviewConfigured: false, scanned: 0, orphans: [] });
    expect(h.searchDataMapAssets).not.toHaveBeenCalled();
  });

  it('flags Loom entities whose item is not live as orphans', async () => {
    // One page of hits: two loom entities + one foreign asset (ignored).
    h.searchDataMapAssets
      .mockResolvedValueOnce([
        { qualifiedName: 'loom://t1/ws1/lakehouse/i1', entityType: 'fabric_lakehouse', name: 'LH one' },
        { qualifiedName: 'loom://t1/ws1/dataset/i2', entityType: 'DataSet', name: 'DS two' },
        { qualifiedName: 'mssql://server/db/dbo/customers', entityType: 'azure_sql_table', name: 'customers' },
      ])
      .mockResolvedValue([]); // paging stops
    mockLiveIds(['i1']); // i1 still live, i2 was deleted

    const scan = await findLineageOrphans();
    expect(scan.purviewConfigured).toBe(true);
    expect(scan.scanned).toBe(2); // only the two loom entities counted
    expect(scan.orphans).toHaveLength(1);
    expect(scan.orphans[0]).toMatchObject({ itemId: 'i2', itemType: 'dataset', typeName: 'DataSet' });
  });
});

// ── purgeLineageOrphans ──────────────────────────────────────────────────────

describe('purgeLineageOrphans', () => {
  it('deletes each orphan and reports per-entity outcome', async () => {
    h.deleteAtlasEntityByQualifiedName
      .mockResolvedValueOnce(true)   // deleted
      .mockResolvedValueOnce(false)  // already gone
      .mockRejectedValueOnce(new Error('403')); // error
    h.reconcileThreadEdgesOnDelete.mockResolvedValue(undefined);
    const orphans = [
      { qualifiedName: 'loom://t/w/lakehouse/i1', typeName: 'fabric_lakehouse', tenantId: 't', workspaceId: 'w', itemType: 'lakehouse', itemId: 'i1' },
      { qualifiedName: 'loom://t/w/dataset/i2', typeName: 'DataSet', tenantId: 't', workspaceId: 'w', itemType: 'dataset', itemId: 'i2' },
      { qualifiedName: 'loom://t/w/report/i3', typeName: 'DataSet', tenantId: 't', workspaceId: 'w', itemType: 'report', itemId: 'i3' },
    ];
    const out = await purgeLineageOrphans(orphans);
    expect(out.map((o) => o.result)).toEqual(['deleted', 'not_found', 'error']);
    // Edge reconcile attempted for every orphan (best-effort).
    expect(h.reconcileThreadEdgesOnDelete).toHaveBeenCalledTimes(3);
  });
});

// ── annotateDeletedLoomNodes (LIN-GC-3) ──────────────────────────────────────

describe('annotateDeletedLoomNodes', () => {
  it('marks loom:// nodes whose item is not live as deleted', async () => {
    mockLiveIds(['live1']);
    const nodes = [
      { id: 'g1', qualifiedName: 'loom://t/w/lakehouse/live1' },
      { id: 'g2', qualifiedName: 'loom://t/w/dataset/gone2' },
      { id: 'g3', qualifiedName: 'mssql://server/db/customers' }, // non-loom, untouched
    ] as Array<{ id: string; qualifiedName?: string; deleted?: boolean }>;
    await annotateDeletedLoomNodes(nodes);
    expect(nodes[0].deleted).toBeUndefined();
    expect(nodes[1].deleted).toBe(true);
    expect(nodes[2].deleted).toBeUndefined();
  });

  it('is a no-op with no loom nodes', async () => {
    const nodes = [{ id: 'g1', qualifiedName: 'mssql://x' }];
    await annotateDeletedLoomNodes(nodes as any);
    expect(h.itemsContainer).not.toHaveBeenCalled();
  });
});
