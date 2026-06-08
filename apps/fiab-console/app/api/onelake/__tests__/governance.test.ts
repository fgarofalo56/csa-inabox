/**
 * Contract tests for GET /api/onelake/governance (OneLake catalog Govern tab).
 *
 *   1. unauthenticated                → 401
 *   2. Cosmos-only (Purview unset)    → real % math + purviewGate naming
 *                                       LOOM_PURVIEW_ACCOUNT + Cosmos
 *                                       classification table + deep-linked
 *                                       attention list (NO crash, NO empty body)
 *   3. Purview configured             → scan-based overlay merged into the
 *                                       classification table, NO purviewGate
 *   4. Purview configured but failing → still returns Cosmos-only metrics +
 *                                       an honest purviewGate (never a 500)
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/auth/session', () => ({ getSession: vi.fn() }));
vi.mock('@/lib/azure/cosmos-client', () => ({
  workspacesContainer: vi.fn(),
  itemsContainer: vi.fn(),
}));

class FakePurviewNotConfiguredError extends Error {
  hint: any;
  constructor(hint: any) {
    super('not configured');
    this.hint = hint;
  }
}
void FakePurviewNotConfiguredError;

vi.mock('@/lib/azure/purview-client', () => ({
  isPurviewConfigured: vi.fn(),
  getPurviewAccountName: vi.fn(),
  searchDataMapAssets: vi.fn(),
  PurviewNotConfiguredError: class PurviewNotConfiguredError extends Error {
    hint: any;
    constructor(hint: any) {
      super('not configured');
      this.hint = hint;
    }
  },
}));

import { GET } from '../governance/route';
import { getSession } from '@/lib/auth/session';
import { workspacesContainer, itemsContainer } from '@/lib/azure/cosmos-client';
import {
  isPurviewConfigured,
  getPurviewAccountName,
  searchDataMapAssets,
} from '@/lib/azure/purview-client';

const SESSION = { claims: { oid: 'oid-1', upn: 'alice@contoso.com', name: 'Alice' } };

function queryReturning(resources: any[]) {
  return { query: () => ({ fetchAll: vi.fn().mockResolvedValue({ resources }) }) };
}

// 4 catalog items: mix of label / owner / endorsement / classification coverage.
const WORKSPACES = [{ id: 'ws-1', name: 'Analytics' }];
const ITEMS = [
  {
    id: 'lh-1',
    workspaceId: 'ws-1',
    itemType: 'lakehouse',
    displayName: 'Gold LH',
    createdBy: 'alice@contoso.com',
    updatedAt: '2026-06-07T00:00:00Z',
    state: { sensitivityLabel: 'Confidential', endorsement: 'Certified', classifications: ['PII'] },
  },
  {
    id: 'wh-1',
    workspaceId: 'ws-1',
    itemType: 'warehouse',
    displayName: 'Sales WH',
    createdBy: 'alice@contoso.com',
    updatedAt: '2026-06-06T00:00:00Z',
    state: { certified: true, classifications: ['PII'] }, // no label
  },
  {
    id: 'mir-1',
    workspaceId: 'ws-1',
    itemType: 'mirrored-database',
    displayName: 'CDC Mirror',
    createdBy: '', // no owner
    updatedAt: '2026-06-05T00:00:00Z',
    state: {}, // no label, no endorsement, no classifications
  },
  // a non-OneLake type that must be ignored by the catalog filter
  {
    id: 'nb-1',
    workspaceId: 'ws-1',
    itemType: 'notebook',
    displayName: 'Scratch NB',
    createdBy: 'alice@contoso.com',
    updatedAt: '2026-06-04T00:00:00Z',
    state: {},
  },
];

beforeEach(() => {
  vi.resetAllMocks();
  (getSession as any).mockReturnValue(SESSION);
  (workspacesContainer as any).mockResolvedValue({ items: queryReturning(WORKSPACES) });
  (itemsContainer as any).mockResolvedValue({ items: queryReturning(ITEMS) });
});

describe('GET /api/onelake/governance', () => {
  it('401 when unauthenticated', async () => {
    (getSession as any).mockReturnValue(null);
    const res = await GET();
    expect(res.status).toBe(401);
  });

  it('Cosmos-only metrics + named purview gate when LOOM_PURVIEW_ACCOUNT is unset', async () => {
    (isPurviewConfigured as any).mockReturnValue(false);
    (getPurviewAccountName as any).mockReturnValue(null);

    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();

    // only the 3 OneLake catalog items count (notebook excluded)
    expect(body.totalItems).toBe(3);
    // labeled: 1/3, endorsed: 2/3, owned: 2/3
    expect(body.labeledPct).toBe(33);
    expect(body.endorsedPct).toBe(67);
    expect(body.ownedPct).toBe(67);

    // classification table from Cosmos (PII on 2 items), no purviewAssets column
    const pii = body.classificationTable.find((r: any) => r.classification === 'PII');
    expect(pii.count).toBe(2);
    expect(pii.purviewAssets).toBeUndefined();

    // honest gate present + names the env var
    expect(body.purviewGate).toBeTruthy();
    expect(body.purviewGate.missingEnvVar).toBe('LOOM_PURVIEW_ACCOUNT');

    // attention list deep-links; mirror (3 issues) + warehouse (no label) appear
    const hrefs = body.attention.map((a: any) => a.href);
    expect(hrefs).toContain('/items/mirrored-database/mir-1');
    expect(hrefs).toContain('/items/warehouse/wh-1');
    const mirror = body.attention.find((a: any) => a.id === 'mir-1');
    expect(mirror.issues).toEqual(
      expect.arrayContaining(['No sensitivity label', 'No owner', 'Not endorsed', 'No classifications']),
    );
    // the fully-governed lakehouse never needs attention
    expect(hrefs).not.toContain('/items/lakehouse/lh-1');
  });

  it('overlays Purview scan classifications and drops the gate when configured', async () => {
    (isPurviewConfigured as any).mockReturnValue(true);
    (getPurviewAccountName as any).mockReturnValue('purview-csa-loom-eastus2');
    (searchDataMapAssets as any).mockResolvedValue([
      { name: 'a', classification: ['PII', 'Financial'] },
      { name: 'b', classification: ['PII'] },
    ]);

    const res = await GET();
    const body = await res.json();

    expect(body.purviewGate).toBeUndefined();
    expect(body.purviewAssetCount).toBe(2);
    const pii = body.classificationTable.find((r: any) => r.classification === 'PII');
    expect(pii.count).toBe(2); // Cosmos items
    expect(pii.purviewAssets).toBe(2); // Purview scan hits
    // Purview-only classification appended (0 Cosmos items, 1 scan hit)
    const fin = body.classificationTable.find((r: any) => r.classification === 'Financial');
    expect(fin.count).toBe(0);
    expect(fin.purviewAssets).toBe(1);
  });

  it('keeps Cosmos metrics + an honest gate when the Data Map call fails', async () => {
    (isPurviewConfigured as any).mockReturnValue(true);
    (getPurviewAccountName as any).mockReturnValue('purview-csa-loom-eastus2');
    (searchDataMapAssets as any).mockRejectedValue(new Error('UAMI lacks Data Reader'));

    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.totalItems).toBe(3);
    expect(body.labeledPct).toBe(33);
    expect(body.purviewGate).toBeTruthy();
    expect(body.purviewGate.missingEnvVar).toBe('LOOM_PURVIEW_ACCOUNT');
  });
});
