/**
 * Vitest for the Purview auto-onboard / offboard hooks.
 *
 * Both hooks are best-effort + non-blocking and a cheap no-op when
 * LOOM_PURVIEW_ACCOUNT is unset. offboardFromPurview is the symmetric delete
 * counterpart wired into item-crud's hard-delete + purge paths so the external
 * Atlas graph reconciles in lock-step with Loom's own Weave edges.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const h = vi.hoisted(() => ({
  registerAtlasEntity: vi.fn(),
  ensureClassificationDefs: vi.fn(),
  deleteAtlasEntityByQualifiedName: vi.fn(),
}));

vi.mock('../purview-client', () => ({
  registerAtlasEntity: h.registerAtlasEntity,
  ensureClassificationDefs: h.ensureClassificationDefs,
  deleteAtlasEntityByQualifiedName: h.deleteAtlasEntityByQualifiedName,
}));

import { autoOnboardToPurview, offboardFromPurview } from '../purview-autoonboard';

const item = {
  id: 'i1', workspaceId: 'ws1', itemType: 'lakehouse',
  displayName: 'Sales LH', state: {}, createdBy: 'alice@contoso.com',
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
} as any;

const ORIG = { ...process.env };
beforeEach(() => {
  Object.values(h).forEach((fn) => fn.mockReset());
  process.env = { ...ORIG };
});

describe('offboardFromPurview', () => {
  it('is a no-op (no network) when LOOM_PURVIEW_ACCOUNT is unset', async () => {
    delete process.env.LOOM_PURVIEW_ACCOUNT;
    await offboardFromPurview(item, 'tenant-1');
    expect(h.deleteAtlasEntityByQualifiedName).not.toHaveBeenCalled();
  });

  it('soft-deletes the DataSet entity on the SAME loom:// qualifiedName as onboard', async () => {
    process.env.LOOM_PURVIEW_ACCOUNT = 'pv-test';
    const expectedQn = 'loom://tenant-1/ws1/lakehouse/i1';
    // onboard + offboard must address exactly the same entity.
    await autoOnboardToPurview(item, 'tenant-1');
    expect(h.registerAtlasEntity).toHaveBeenCalledWith(expect.objectContaining({ qualifiedName: expectedQn }));
    await offboardFromPurview(item, 'tenant-1');
    expect(h.deleteAtlasEntityByQualifiedName).toHaveBeenCalledWith('DataSet', expectedQn);
  });

  it('swallows backend errors (best-effort — never blocks the delete)', async () => {
    process.env.LOOM_PURVIEW_ACCOUNT = 'pv-test';
    h.deleteAtlasEntityByQualifiedName.mockRejectedValue(new Error('403'));
    await expect(offboardFromPurview(item, 'tenant-1')).resolves.toBeUndefined();
  });
});
