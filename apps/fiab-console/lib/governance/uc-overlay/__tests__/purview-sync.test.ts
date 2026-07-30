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
 *   6. THE ADD-ONLY DEFECT — an asset accumulating contradictory, unrevocable
 *      signals (`…_pii_yes` AND `…_pii_no`), or keeping `loom_certification:
 *      certified` after Loom de-certified it. Every removal case below FAILS
 *      against an add-only implementation.
 *   7. a stale cached guid being pushed to after the Atlas entity was
 *      re-registered (reports `synced: true`, changes nothing).
 *   8. one tenant's vocabulary creating account-global typedefs that collide
 *      with another tenant's.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/azure/purview-client', () => ({
  isPurviewConfigured: vi.fn(),
  ensureClassificationDefs: vi.fn(),
  addAssetClassification: vi.fn(),
  removeAssetClassification: vi.fn(),
  setBusinessMetadata: vi.fn(),
}));
vi.mock('@/lib/azure/asset-identity', () => ({ resolveAssetIdentities: vi.fn() }));
vi.mock('@/lib/azure/unity-catalog-client', () => ({ resolveWorkspaceHostnames: vi.fn() }));

import { syncOverlayToPurview, provenanceFromSync } from '../purview-sync';
import {
  isPurviewConfigured, ensureClassificationDefs, addAssetClassification,
  removeAssetClassification, setBusinessMetadata,
} from '@/lib/azure/purview-client';
import { resolveAssetIdentities } from '@/lib/azure/asset-identity';
import { resolveWorkspaceHostnames } from '@/lib/azure/unity-catalog-client';
import { tenantBusinessMetadataName, tenantTypedefPrefix, type UcGovernanceOverlay } from '../model';

const mock = (fn: unknown) => fn as unknown as ReturnType<typeof vi.fn>;
const T1 = tenantTypedefPrefix('t1');
const PII_YES = `Loom_${T1}_pii_yes`;
const PII_NO = `Loom_${T1}_pii_no`;
const BM_T1 = tenantBusinessMetadataName('t1');

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
  mock(isPurviewConfigured).mockReturnValue(true);
  mock(resolveWorkspaceHostnames).mockResolvedValue(['adb-1.azuredatabricks.net']);
  mock(resolveAssetIdentities).mockResolvedValue({ purviewGuid: 'guid-1' });
});

describe('syncOverlayToPurview', () => {
  it('names LOOM_PURVIEW_ACCOUNT when Purview is not configured — and writes nothing', async () => {
    mock(isPurviewConfigured).mockReturnValue(false);
    const r = await syncOverlayToPurview(overlay());
    expect(r.synced).toBe(false);
    expect(r.reason).toMatch(/LOOM_PURVIEW_ACCOUNT/);
    expect(addAssetClassification).not.toHaveBeenCalled();
    expect(setBusinessMetadata).not.toHaveBeenCalled();
    expect(removeAssetClassification).not.toHaveBeenCalled();
  });

  it('refuses to sync a COLUMN overlay (its Atlas entity is owned by the lineage path)', async () => {
    const r = await syncOverlayToPurview(overlay({ securableType: 'column', column: 'email' }));
    expect(r.synced).toBe(false);
    expect(r.reason).toMatch(/Column overlays are not mirrored/);
    expect(addAssetClassification).not.toHaveBeenCalled();
  });

  it('does not claim success when no Atlas entity is registered', async () => {
    mock(resolveAssetIdentities).mockResolvedValue({});
    const r = await syncOverlayToPurview(overlay());
    expect(r.synced).toBe(false);
    expect(r.reason).toMatch(/No Purview asset is registered for main\.sales\.orders/);
    expect(setBusinessMetadata).not.toHaveBeenCalled();
  });

  it('short-circuits an overlay with nothing to say AND nothing ever pushed', async () => {
    const r = await syncOverlayToPurview(overlay({ tags: [], certification: { rung: 'none' } }));
    expect(r.synced).toBe(false);
    expect(r.reason).toMatch(/Nothing to sync/);
    expect(resolveAssetIdentities).not.toHaveBeenCalled();
  });

  it('creates the classification typedef BEFORE attaching it, and routes free tags to business metadata', async () => {
    const order: string[] = [];
    mock(ensureClassificationDefs).mockImplementation(async () => { order.push('ensure'); });
    mock(addAssetClassification).mockImplementation(async () => { order.push('attach'); });

    const r = await syncOverlayToPurview(overlay());

    expect(order).toEqual(['ensure', 'attach']);
    expect(ensureClassificationDefs).toHaveBeenCalledWith([PII_YES]);
    expect(addAssetClassification).toHaveBeenCalledWith('guid-1', [PII_YES]);
    expect(setBusinessMetadata).toHaveBeenCalledWith(
      'guid-1', expect.objectContaining({ cost_center: 'CC-42' }), BM_T1,
    );
    expect(r).toMatchObject({ synced: true, guid: 'guid-1', classifications: [PII_YES] });
  });

  it('ATTACK: free tags + certification go to a TENANT-NAMESPACED business-metadata bag, never the account-global default', async () => {
    // The classification half of projectOverlayToPurview was namespaced first;
    // this pins the OTHER half of the same function. `LoomCustomTags` is ONE
    // account-global Atlas typedef, grown permanently with tenant-authored
    // free-tag keys and written with isOverwrite=true — so on a shared Purview
    // account tenant B syncing the same asset would clobber tenant A's
    // cost_center / loom_certification / loom_certified_by.
    await syncOverlayToPurview(overlay({ tenantId: 't1' }));
    await syncOverlayToPurview(overlay({ tenantId: 't2' }));

    const bagA = mock(setBusinessMetadata).mock.calls[0][2];
    const bagB = mock(setBusinessMetadata).mock.calls[1][2];
    expect(bagA).toBe(BM_T1);
    expect(bagB).toBe(tenantBusinessMetadataName('t2'));
    expect(bagA).not.toBe(bagB);
    // and neither is the account-global default the client would otherwise use
    expect(bagA).not.toBe('LoomCustomTags');
    expect(bagB).not.toBe('LoomCustomTags');
  });

  it('the provenance stamp records WHICH tenant bag was written (auditable on a shared account)', async () => {
    const r = await syncOverlayToPurview(overlay());
    expect(r.businessMetadataName).toBe(BM_T1);
    expect(provenanceFromSync(r)?.businessMetadataName).toBe(BM_T1);
  });

  it('surfaces a Purview transport failure instead of swallowing it', async () => {
    mock(addAssetClassification)
      .mockRejectedValue(Object.assign(new Error('UAMI lacks Data Curator'), { status: 403 }));
    await expect(syncOverlayToPurview(overlay())).rejects.toThrow(/Data Curator/);
  });
});

// ===========================================================================
// SUPERSEDE — every case here fails against the add-only implementation
// ===========================================================================
describe('syncOverlayToPurview — supersede (stale signals are REVOKED)', () => {
  it('ATTACK: flipping pii=yes → pii=no REMOVES the old classification (no contradictory pair)', async () => {
    const r = await syncOverlayToPurview(overlay({
      tags: [{ key: 'pii', value: 'no', governed: true }],
      purview: { guid: 'guid-1', classifications: [PII_YES], businessMetadataKeys: [] },
    }));
    expect(removeAssetClassification).toHaveBeenCalledWith('guid-1', [PII_YES]);
    expect(addAssetClassification).toHaveBeenCalledWith('guid-1', [PII_NO]);
    expect(r.removedClassifications).toEqual([PII_YES]);
    // The asset must NOT end up carrying both.
    expect(r.classifications).toEqual([PII_NO]);
  });

  it('ATTACK: removing the last governed tag revokes its classification instead of leaving it', async () => {
    const r = await syncOverlayToPurview(overlay({
      tags: [],
      purview: { guid: 'guid-1', classifications: [PII_YES], businessMetadataKeys: [] },
    }));
    expect(removeAssetClassification).toHaveBeenCalledWith('guid-1', [PII_YES]);
    expect(addAssetClassification).not.toHaveBeenCalled();
    expect(r.synced).toBe(true);
  });

  it('ATTACK: DE-certifying clears loom_certification in Purview (a stale "certified" label is dangerous)', async () => {
    await syncOverlayToPurview(overlay({
      tags: [],
      certification: { rung: 'none' },
      purview: { guid: 'guid-1', classifications: [], businessMetadataKeys: ['loom_certification', 'loom_certified_by'] },
    }));
    const pushed = mock(setBusinessMetadata).mock.calls[0][1];
    expect(pushed.loom_certification).toBe('none');
    expect(pushed.loom_certified_by).toBe('');
    expect(pushed.loom_certified_at).toBe('');
  });

  it('ATTACK: a removed FREE tag is blanked in business metadata, not left behind', async () => {
    await syncOverlayToPurview(overlay({
      tags: [{ key: 'pii', value: 'yes', governed: true }],
      purview: { guid: 'guid-1', classifications: [PII_YES], businessMetadataKeys: ['cost_center'] },
    }));
    expect(mock(setBusinessMetadata).mock.calls[0][1].cost_center).toBe('');
  });

  it('a fully stripped overlay STILL syncs when Loom has something to revoke', async () => {
    const r = await syncOverlayToPurview(overlay({
      tags: [],
      certification: { rung: 'none' },
      purview: { guid: 'guid-1', classifications: [PII_YES], businessMetadataKeys: ['cost_center'] },
    }));
    expect(r.synced).toBe(true);
    expect(r.reason).toBeUndefined();
    expect(removeAssetClassification).toHaveBeenCalled();
  });

  it('provenance records only keys that still carry a value (a blanked key is not re-blanked forever)', async () => {
    const r = await syncOverlayToPurview(overlay({
      tags: [],
      purview: { guid: 'guid-1', classifications: [], businessMetadataKeys: ['cost_center'] },
    }));
    expect(r.businessMetadataKeys).not.toContain('cost_center');
    expect(r.businessMetadataKeys).toContain('loom_certification');
  });
});

describe('syncOverlayToPurview — guid freshness + tenant namespacing', () => {
  it('ATTACK: a LIVE resolve beats a stale cached guid (a re-registered entity gets the write)', async () => {
    mock(resolveAssetIdentities).mockResolvedValue({ purviewGuid: 'guid-fresh' });
    await syncOverlayToPurview(overlay({ purview: { guid: 'guid-dead' } }));
    expect(addAssetClassification).toHaveBeenCalledWith('guid-fresh', [PII_YES]);
  });

  it('falls back to the recorded guid only when the live resolve finds nothing', async () => {
    mock(resolveAssetIdentities).mockResolvedValue({});
    await syncOverlayToPurview(overlay({ purview: { guid: 'guid-cached' } }));
    expect(addAssetClassification).toHaveBeenCalledWith('guid-cached', [PII_YES]);
  });

  it('ATTACK: two tenants with the SAME vocabulary word do not create the same account-global typedef', async () => {
    await syncOverlayToPurview(overlay({ tenantId: 't1' }));
    const first = mock(ensureClassificationDefs).mock.calls[0][0];
    mock(ensureClassificationDefs).mockClear();
    await syncOverlayToPurview(overlay({ tenantId: 'other-tenant' }));
    const second = mock(ensureClassificationDefs).mock.calls[0][0];
    expect(first).not.toEqual(second);
    expect(first[0]).toMatch(/^Loom_[0-9a-f]{8}_pii_yes$/);
    expect(second[0]).toMatch(/^Loom_[0-9a-f]{8}_pii_yes$/);
  });

  it('a tag key that cannot be expressed in Atlas returns an honest reason instead of throwing', async () => {
    const r = await syncOverlayToPurview(overlay({
      tags: [{ key: '???', value: 'x', governed: false }],
    }));
    expect(r.synced).toBe(false);
    expect(r.reason).toMatch(/cannot be expressed as Purview business metadata/);
    expect(setBusinessMetadata).not.toHaveBeenCalled();
  });

  it('two free tags that normalize to the same Purview attribute are refused, not silently merged', async () => {
    const r = await syncOverlayToPurview(overlay({
      tags: [
        { key: 'cost center', value: 'A', governed: false },
        { key: 'cost-center', value: 'B', governed: false },
      ],
    }));
    expect(r.synced).toBe(false);
    expect(r.reason).toMatch(/both normalize to the Purview attribute "cost_center"/);
    expect(setBusinessMetadata).not.toHaveBeenCalled();
  });
});

describe('provenanceFromSync', () => {
  it('returns nothing for a failed sync (no false "last synced" stamp)', () => {
    expect(provenanceFromSync({
      synced: false, reason: 'x', classifications: [], removedClassifications: [], businessMetadataKeys: [],
    })).toBeUndefined();
  });

  it('records the guid + what was pushed on success', () => {
    const p = provenanceFromSync({
      synced: true, guid: 'g', classifications: [PII_YES],
      removedClassifications: [], businessMetadataKeys: ['cost_center'],
    });
    expect(p).toMatchObject({ guid: 'g', classifications: [PII_YES], businessMetadataKeys: ['cost_center'] });
    expect(typeof p!.syncedAt).toBe('string');
  });
});
