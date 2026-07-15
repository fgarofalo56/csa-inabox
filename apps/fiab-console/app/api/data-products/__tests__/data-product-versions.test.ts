/**
 * Backend contract tests for the DP-9 versioning routes.
 *   POST /api/data-products/[id]/versions   — append immutable version + diff
 *   POST /api/data-products/[id]/deprecate   — deprecation transition
 * session, item-crud, cosmos-client, and the search index are mocked.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/auth/session', () => ({ getSession: vi.fn() }));
vi.mock('@/app/api/items/_lib/item-crud', async () => {
  const { NextResponse } = await import('next/server');
  return {
    loadOwnedItem: vi.fn(),
    updateOwnedItem: vi.fn(),
    jerr: (error: string, status = 500) => NextResponse.json({ ok: false, error }, { status }),
  };
});
vi.mock('@/lib/azure/loom-data-products-search', () => ({
  upsertDataProductDoc: vi.fn(async () => {}),
  docForDataProduct: vi.fn(() => ({})),
}));
vi.mock('@/lib/events/webhook-emitter', () => ({ emitLoomEvent: vi.fn() }));

import { POST as versionsPOST } from '../[id]/versions/route';
import { POST as deprecatePOST } from '../[id]/deprecate/route';
import { getSession } from '@/lib/auth/session';
import { loadOwnedItem, updateOwnedItem } from '@/app/api/items/_lib/item-crud';

function ctx(id: string) { return { params: Promise.resolve({ id }) }; }
function req(body: any) { return { json: async () => body } as any; }
const C_V1 = { version: '1.0.0', schema: [{ name: 'id', type: 'string', primaryKey: true, nullable: false }, { name: 'amount', type: 'number', nullable: true }], slo: {}, quality: [] };

beforeEach(() => { vi.resetAllMocks(); });

describe('POST /versions', () => {
  it('401 unauthenticated', async () => {
    (getSession as any).mockReturnValue(null);
    expect((await versionsPOST(req({ contract: C_V1 }), ctx('dp-1'))).status).toBe(401);
  });

  it('appends the first version (patch level, no changes) and updates the current contract', async () => {
    (getSession as any).mockReturnValue({ claims: { oid: 'u', upn: 'u@x' } });
    const item = { id: 'dp-1', workspaceId: 'w', createdBy: 'u', state: {} } as any;
    (loadOwnedItem as any).mockResolvedValue(item);
    (updateOwnedItem as any).mockImplementation(async (_i: string, _t: string, _o: string, patch: any) => ({ ...item, state: patch.state }));
    const res = await versionsPOST(req({ contract: C_V1 }), ctx('dp-1'));
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.entry.version).toBe('1.0.0');
    const persisted = (updateOwnedItem as any).mock.calls[0][3].state;
    expect(persisted.versions).toHaveLength(1);
    expect(persisted.contract.version).toBe('1.0.0');
  });

  it('classifies a dropped column as a MAJOR breaking bump and appends v2', async () => {
    (getSession as any).mockReturnValue({ claims: { oid: 'u' } });
    const item = { id: 'dp-1', workspaceId: 'w', createdBy: 'u', state: { versions: [{ version: '1.0.0', level: 'patch', contract: C_V1, createdAt: 'x' }], contract: C_V1 } } as any;
    (loadOwnedItem as any).mockResolvedValue(item);
    (updateOwnedItem as any).mockImplementation(async (_i: string, _t: string, _o: string, patch: any) => ({ ...item, state: patch.state }));
    const dropped = { ...C_V1, schema: [C_V1.schema[0]] }; // remove 'amount'
    const res = await versionsPOST(req({ contract: dropped }), ctx('dp-1'));
    const j = await res.json();
    expect(j.breaking).toBe(true);
    expect(j.entry.level).toBe('major');
    expect(j.entry.version).toBe('2.0.0');
  });
});

describe('POST /deprecate', () => {
  it('deprecates with a sunset date + sets canonical lifecycle deprecated', async () => {
    (getSession as any).mockReturnValue({ claims: { oid: 'u', upn: 'u@x' } });
    const item = { id: 'dp-1', workspaceId: 'w', displayName: 'Sales', createdBy: 'u', state: { lifecycleState: 'published' } } as any;
    (loadOwnedItem as any).mockResolvedValue(item);
    (updateOwnedItem as any).mockImplementation(async (_i: string, _t: string, _o: string, patch: any) => ({ ...item, state: patch.state }));
    const res = await deprecatePOST(req({ action: 'deprecate', sunsetAt: '2999-01-01', noticeDays: 60, migrationNote: 'use v2' }), ctx('dp-1'));
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.lifecycleState).toBe('deprecated');
    const persisted = (updateOwnedItem as any).mock.calls[0][3].state;
    expect(persisted.deprecation.noticeDays).toBe(60);
    expect(persisted.deprecation.migrationNote).toBe('use v2');
  });

  it('rejects a deprecate with no sunset date', async () => {
    (getSession as any).mockReturnValue({ claims: { oid: 'u' } });
    (loadOwnedItem as any).mockResolvedValue({ id: 'dp-1', workspaceId: 'w', createdBy: 'u', state: {} });
    expect((await deprecatePOST(req({ action: 'deprecate' }), ctx('dp-1'))).status).toBe(400);
  });
});
