/**
 * POST /api/lakehouse/shortcuts/test — item scope and the row key.
 *
 * The test re-probes a shortcut's target and writes the row's status back, so
 * it needs edit rights on the lakehouse item. A row saved under the earlier
 * container key is tested, and its status written, under that same key when
 * `legacyContainerKeyFor` attributes the key to the item.
 *
 * What breaks these: the route reading the row before (or without) the item
 * check, a read-only role reaching the probe, or the status being written under
 * the item id for a row stored under the container key.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/auth/session', () => ({ getSession: vi.fn() }));
vi.mock('@/lib/auth/item-access', () => ({ resolveItemAccessByOid: vi.fn() }));
vi.mock('@/lib/azure/adls-client', () => ({ getAccountName: vi.fn(() => 'loomacct') }));
vi.mock('@/lib/azure/lakehouse-shortcuts', () => ({ getShortcut: vi.fn(), updateShortcutStatus: vi.fn(), listShortcuts: vi.fn() }));
vi.mock('@/lib/azure/shortcut-engines', () => ({
  resolveAndTestAdls: vi.fn(), testEngineObject: vi.fn(), refreshDeltaSharingCredential: vi.fn(),
}));
vi.mock('@/lib/azure/shortcut-credentials', () => ({ getKeyVaultSecret: vi.fn() }));
vi.mock('@/lib/azure/shortcut-client', () => ({ parseAbfss: vi.fn(), listAdlsWithSas: vi.fn(), ShortcutSourceError: class extends Error {} }));
vi.mock('@/lib/azure/graph-drive-client', () => ({ headDriveItem: vi.fn(), parseSharepointUri: vi.fn(), graphDriveConfigGate: vi.fn(() => null) }));
vi.mock('../_lib/legacy-container-key', () => ({ legacyContainerKeyFor: vi.fn() }));

import { POST } from '../shortcuts/test/route';
import { getSession } from '@/lib/auth/session';
import { resolveItemAccessByOid } from '@/lib/auth/item-access';
import { getShortcut, updateShortcutStatus } from '@/lib/azure/lakehouse-shortcuts';
import { resolveAndTestAdls } from '@/lib/azure/shortcut-engines';
import { legacyContainerKeyFor } from '../_lib/legacy-container-key';

const sess = { claims: { upn: 'u@x', tid: 't1' } };
function access(canWrite = true) {
  return { item: { id: 'lh', workspaceId: 'ws-1', itemType: 'lakehouse' }, role: canWrite ? 'Member' : 'Viewer', via: 'workspace', canWrite };
}
const ADLS_ROW = { id: 'lh:files::a', name: 'a', kind: 'files', targetType: 'adls', targetUri: 'abfss://c@loomacct.dfs.core.windows.net/p' };
const postReq = (body: any) => ({ json: async () => body }) as any;

beforeEach(() => {
  vi.resetAllMocks();
  (getSession as any).mockReturnValue(sess);
  (resolveItemAccessByOid as any).mockResolvedValue(access(true));
  (legacyContainerKeyFor as any).mockResolvedValue(null);
  (resolveAndTestAdls as any).mockResolvedValue({ abfssUri: ADLS_ROW.targetUri, reachable: true });
  (updateShortcutStatus as any).mockImplementation(async (_k: string, id: string, status: string) => ({ id, status }));
});

describe('POST /api/lakehouse/shortcuts/test', () => {
  it('re-tests an item row and writes its status under the item id (positive arm)', async () => {
    (getShortcut as any).mockImplementation(async (key: string) => (key === 'lh' ? ADLS_ROW : null));
    const res = await POST(postReq({ lakehouseId: 'lh', id: 'lh:files::a' }));
    expect(res.status).toBe(200);
    expect(resolveAndTestAdls).toHaveBeenCalledTimes(1);
    expect((updateShortcutStatus as any).mock.calls).toEqual([['lh', 'lh:files::a', 'active', undefined]]);
  });

  it('requires access to the lakehouse item (404 item_not_found; row not read)', async () => {
    (resolveItemAccessByOid as any).mockResolvedValue(null);
    const res = await POST(postReq({ lakehouseId: 'lh', id: 'lh:files::a' }));
    const j = await res.json();
    expect([res.status, j.code]).toEqual([404, 'item_not_found']);
    expect(getShortcut).not.toHaveBeenCalled();
    expect(resolveAndTestAdls).not.toHaveBeenCalled();
    expect(updateShortcutStatus).not.toHaveBeenCalled();
  });

  it('requires edit rights (403 read_only; nothing probed or written)', async () => {
    (resolveItemAccessByOid as any).mockResolvedValue(access(false));
    (getShortcut as any).mockResolvedValue(ADLS_ROW);
    const res = await POST(postReq({ lakehouseId: 'lh', id: 'lh:files::a' }));
    const j = await res.json();
    expect([res.status, j.code]).toEqual([403, 'read_only']);
    expect(j.remediation).toMatch(/Member or Admin/);
    expect(resolveAndTestAdls).not.toHaveBeenCalled();
    expect(updateShortcutStatus).not.toHaveBeenCalled();
  });

  it('400 carries bad_request and a remediation', async () => {
    const res = await POST(postReq({ lakehouseId: 'lh' }));
    const j = await res.json();
    expect([res.status, j.code, typeof j.remediation]).toEqual([400, 'bad_request', 'string']);
  });

  it('tests an earlier row and writes its status under the container key', async () => {
    (legacyContainerKeyFor as any).mockResolvedValue('bronze');
    const row = { ...ADLS_ROW, id: 'bronze:files::a' };
    (getShortcut as any).mockImplementation(async (key: string) => (key === 'bronze' ? row : null));
    const res = await POST(postReq({ lakehouseId: 'lh', id: 'bronze:files::a' }));
    expect(res.status).toBe(200);
    // Breaks if the status is written under the item id (the row would never update).
    expect((updateShortcutStatus as any).mock.calls).toEqual([['bronze', 'bronze:files::a', 'active', undefined]]);
    expect(legacyContainerKeyFor).toHaveBeenCalledWith('lh', 'ws-1');
  });

  it('404s an earlier row when no container key is attributed to the item', async () => {
    (getShortcut as any).mockImplementation(async (key: string) => (key === 'bronze' ? { ...ADLS_ROW, id: 'bronze:files::a' } : null));
    const res = await POST(postReq({ lakehouseId: 'lh', id: 'bronze:files::a' }));
    const j = await res.json();
    expect([res.status, j.code]).toEqual([404, 'not_found']);
    expect((getShortcut as any).mock.calls).toEqual([['lh', 'bronze:files::a']]);
    expect(resolveAndTestAdls).not.toHaveBeenCalled();
  });
});
