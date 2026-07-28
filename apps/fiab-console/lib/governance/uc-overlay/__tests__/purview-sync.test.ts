/**
 * LU-5 — Purview fold-in tests.
 *
 * Bugs these catch:
 *   1. a silent no-op when Purview isn't configured (must return an actionable
 *      reason naming LOOM_PURVIEW_ACCOUNT — no-vaporware).
 *   2. syncing a column overlay against a table guid (wrong asset annotated).
 *   3. classifying an asset without first creating the typedef (Atlas 404) or
 *      calling the wrong Atlas primitive for governed vs free tags.
 *   4. claiming `synced: true` when no Atlas entity exists for the securable.
 *   5. a provenance stamp being written after a FAILED sync.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/azure/purview-client', () => ({
  isPurviewConfigured: vi.fn(),
  ensureClassificationDefs: vi.fn(),
  addAssetClassification: vi.fn(),
  setBusinessMetadata: vi.fn(),
}));
vi.mock('@/lib/azure/asset-identity', () => ({ resolveAssetIdentities: vi.fn() }));
vi.mock('@/lib/azure/unity-catalog-client', () => ({ resolveWorkspaceHostnames: vi.fn() }));

import { syncOverlayToPurview, provenanceFromSync } from '../purview-sync';
import {
  isPurviewConfigured, ensureClassificationDefs, addAssetClassification, setBusinessMetadata,
} from '@/lib/azure/purview-client';
import { resolveAssetIdentities } from '@/lib/azure/asset-identity';
import { resolveWorkspaceHostnames } from '@/lib/azure/unity-catalog-client';
import type { UcGovernanceOverlay } from '../model';

function overlay(patch: Partial<UcGovernanceOverlay> = {}): UcGovernanceOverlay {
  return {
    id: 'uc:main.sales.orders',
    tenantId: 't1',
    kind: 'uc-governance-overlay',
    identity: 'uc:main.sales.orders',
    fullName: 'main.sales.orders',
    securableType: 'table',
    tags: [
      { key: 'pii', value: 'yes', governed: true },
      { key: 'cost-center', value: 'CC-42', governed: false },
    ],
    certification: { rung: 'none' },
    attributes: {},
    updatedAt: '2026-07-28T00:00:00.000Z',
    updatedBy: 'ana@contoso.com',
    ...patch,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  (isPurviewConfigured as unknown as ReturnType<typeof vi.fn>).mockReturnValue(true);
  (resolveWorkspaceHostnames as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(['adb-1.azuredatabricks.net']);
  (resolveAssetIdentities as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ purviewGuid: 'guid-1' });
});

describe('syncOverlayToPurview', () => {
  it('names LOOM_PURVIEW_ACCOUNT when Purview is not configured — and writes nothing', async () => {
    (isPurviewConfigured as unknown as ReturnType<typeof vi.fn>).mockReturnValue(false);
    const r = await syncOverlayToPurview(overlay());
    expect(r.synced).toBe(false);
    expect(r.reason).toMatch(/LOOM_PURVIEW_ACCOUNT/);
    expect(addAssetClassification).not.toHaveBeenCalled();
    expect(setBusinessMetadata).not.toHaveBeenCalled();
  });

  it('refuses to sync a COLUMN overlay (its Atlas entity is owned by the lineage path)', async () => {
    const r = await syncOverlayToPurview(overlay({ securableType: 'column', column: 'email' }));
    expect(r.synced).toBe(false);
    expect(r.reason).toMatch(/Column overlays are not mirrored/);
    expect(addAssetClassification).not.toHaveBeenCalled();
  });

  it('does not claim success when no Atlas entity is registered', async () => {
    (resolveAssetIdentities as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({});
    const r = await syncOverlayToPurview(overlay());
    expect(r.synced).toBe(false);
    expect(r.reason).toMatch(/No Purview asset is registered for main\.sales\.orders/);
    expect(setBusinessMetadata).not.toHaveBeenCalled();
  });

  it('short-circuits an overlay with nothing to say', async () => {
    const r = await syncOverlayToPurview(overlay({ tags: [], certification: { rung: 'none' } }));
    expect(r.synced).toBe(false);
    expect(r.reason).toMatch(/Nothing to sync/);
    expect(resolveAssetIdentities).not.toHaveBeenCalled();
  });

  it('creates the classification typedef BEFORE attaching it, and routes free tags to business metadata', async () => {
    const order: string[] = [];
    (ensureClassificationDefs as unknown as ReturnType<typeof vi.fn>).mockImplementation(async () => { order.push('ensure'); });
    (addAssetClassification as unknown as ReturnType<typeof vi.fn>).mockImplementation(async () => { order.push('attach'); });

    const r = await syncOverlayToPurview(overlay());

    expect(order).toEqual(['ensure', 'attach']);
    expect(ensureClassificationDefs).toHaveBeenCalledWith(['Loom_pii_yes']);
    expect(addAssetClassification).toHaveBeenCalledWith('guid-1', ['Loom_pii_yes']);
    expect(setBusinessMetadata).toHaveBeenCalledWith('guid-1', { cost_center: 'CC-42' });
    expect(r).toMatchObject({ synced: true, guid: 'guid-1', classifications: ['Loom_pii_yes'] });
  });

  it('prefers the guid already recorded on the overlay over a re-resolve', async () => {
    await syncOverlayToPurview(overlay({ purview: { guid: 'guid-cached' } }));
    expect(addAssetClassification).toHaveBeenCalledWith('guid-cached', ['Loom_pii_yes']);
  });

  it('surfaces a Purview transport failure instead of swallowing it', async () => {
    (addAssetClassification as unknown as ReturnType<typeof vi.fn>)
      .mockRejectedValue(Object.assign(new Error('UAMI lacks Data Curator'), { status: 403 }));
    await expect(syncOverlayToPurview(overlay())).rejects.toThrow(/Data Curator/);
  });
});

describe('provenanceFromSync', () => {
  it('returns nothing for a failed sync (no false "last synced" stamp)', () => {
    expect(provenanceFromSync({ synced: false, reason: 'x', classifications: [], businessMetadataKeys: [] }))
      .toBeUndefined();
  });

  it('records the guid + what was pushed on success', () => {
    const p = provenanceFromSync({
      synced: true, guid: 'g', classifications: ['Loom_pii_yes'], businessMetadataKeys: ['cost-center'],
    });
    expect(p).toMatchObject({ guid: 'g', classifications: ['Loom_pii_yes'], businessMetadataKeys: ['cost-center'] });
    expect(typeof p!.syncedAt).toBe('string');
  });
});
