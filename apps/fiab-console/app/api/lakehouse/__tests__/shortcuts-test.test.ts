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
// The stored credential resolves as the row's creator; the mint record names them.
vi.mock('@/lib/azure/kv-secrets-client', () => ({ getShortcutSecretOwnerRecord: vi.fn(), getShortcutSecretValue: vi.fn() }));
vi.mock('@/lib/azure/shortcut-client', () => ({ parseAbfss: vi.fn(), listAdlsWithSas: vi.fn(), ShortcutSourceError: class extends Error {} }));
vi.mock('@/lib/azure/graph-drive-client', () => ({ headDriveItem: vi.fn(), parseSharepointUri: vi.fn(), graphDriveConfigGate: vi.fn(() => null) }));
vi.mock('../_lib/legacy-container-key', () => ({ legacyContainerKeyFor: vi.fn() }));

import { POST } from '../shortcuts/test/route';
import { getSession } from '@/lib/auth/session';
import { resolveItemAccessByOid } from '@/lib/auth/item-access';
import { getShortcut, updateShortcutStatus } from '@/lib/azure/lakehouse-shortcuts';
import { resolveAndTestAdls, testEngineObject, refreshDeltaSharingCredential } from '@/lib/azure/shortcut-engines';
import { getKeyVaultSecret } from '@/lib/azure/shortcut-credentials';
import { getShortcutSecretOwnerRecord } from '@/lib/azure/kv-secrets-client';
import { parseAbfss, listAdlsWithSas } from '@/lib/azure/shortcut-client';
import { headDriveItem, parseSharepointUri, graphDriveConfigGate } from '@/lib/azure/graph-drive-client';
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
  (getShortcutSecretOwnerRecord as any).mockResolvedValue({ exists: true, owner: { oid: 'oid-u', lakehouseId: 'bronze' } });
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

/**
 * Every status write-back, for a row stored under the earlier container key.
 *
 * Each branch of the route writes the status itself, so each is pinned on its
 * own: the FIRST argument of every updateShortcutStatus call must be 'bronze'
 * (the key the row was read from). Writing under 'lh' instead would leave the
 * stored row unchanged, and the Status chip would never move. That value --
 * 'lh' in argument 0 -- is what turns each of these red.
 */
describe('POST /api/lakehouse/shortcuts/test — write-back key per target type', () => {
  const LEGACY = 'bronze';

  function legacyRow(row: Record<string, unknown>) {
    (legacyContainerKeyFor as any).mockResolvedValue(LEGACY);
    (getShortcut as any).mockImplementation(async (key: string) => (key === LEGACY ? row : null));
  }

  async function run(id: string) {
    const res = await POST(postReq({ lakehouseId: 'lh', id }));
    return { res, j: await res.json() };
  }

  /** Every write went to the legacy key, with this status. Breaks on 'lh' in arg 0. */
  function wroteUnderLegacy(id: string, status: string) {
    const calls = (updateShortcutStatus as any).mock.calls as unknown[][];
    expect(calls.length).toBe(1);
    expect(calls[0].slice(0, 3)).toEqual([LEGACY, id, status]);
  }

  const DS = {
    id: 'bronze:tables::ds', name: 'ds', kind: 'tables', targetType: 'delta_sharing',
    targetUri: 'https://sharing.example.test/delta-sharing', engine: 'databricks', engineObject: 'loom.sh.orders',
    credentialRef: { kind: 'bearer', keyVaultSecret: 'loom-sc-ds-profile' },
    lakehouseId: 'bronze', createdBy: 'u@x', createdByOid: 'oid-u',
  };
  // Low-entropy placeholders: not credentials, never sent anywhere but the mock.
  const PROFILE = JSON.stringify({ endpoint: 'https://sharing.example.test/delta-sharing/', bearerToken: 'fixture-bearer', shareCredentialsVersion: 1 });

  function stubFetch(status: number) {
    vi.stubGlobal('fetch', vi.fn(async () => ({ status, ok: status >= 200 && status < 300 })));
  }

  it('delta_sharing, Tables on Databricks: refreshes the credential and writes active under the legacy key', async () => {
    legacyRow(DS);
    (getKeyVaultSecret as any).mockResolvedValue(PROFILE);
    stubFetch(200);
    const { res, j } = await run(DS.id);
    vi.unstubAllGlobals();
    expect([res.status, j.ok]).toEqual([200, true]);
    // Breaks if the credential file is written for the item id instead of the row's key.
    expect((refreshDeltaSharingCredential as any).mock.calls[0][0]).toBe(LEGACY);
    expect((refreshDeltaSharingCredential as any).mock.calls[0][1]).toBe('ds');
    expect(testEngineObject).toHaveBeenCalledWith('databricks', 'loom.sh.orders');
    // route.ts:120 -- the active write-back.
    wroteUnderLegacy(DS.id, 'active');
  });

  it('delta_sharing with an expired token: writes error under the legacy key (502)', async () => {
    legacyRow(DS);
    (getKeyVaultSecret as any).mockResolvedValue(PROFILE);
    stubFetch(401);
    const { res, j } = await run(DS.id);
    vi.unstubAllGlobals();
    expect([res.status, j.code]).toEqual([502, 'delta_sharing_auth_failure']);
    expect(refreshDeltaSharingCredential).not.toHaveBeenCalled();
    wroteUnderLegacy(DS.id, 'error');
  });

  it('delta_sharing with no credential: writes pending under the legacy key', async () => {
    const row = { ...DS, credentialRef: undefined };
    legacyRow(row);
    const { res } = await run(DS.id);
    expect(res.status).toBe(200);
    wroteUnderLegacy(DS.id, 'pending');
  });

  const S3 = {
    id: 'bronze:tables::s3', name: 's3', kind: 'tables', targetType: 's3',
    targetUri: 's3://bucket/orders', engine: 'synapse', engineObject: 'loom_sc.s3_orders',
  };

  it('s3: proves the engine object and writes active under the legacy key', async () => {
    legacyRow(S3);
    const { res } = await run(S3.id);
    expect(res.status).toBe(200);
    expect(testEngineObject).toHaveBeenCalledWith('synapse', 'loom_sc.s3_orders');
    wroteUnderLegacy(S3.id, 'active');
  });

  it('gcs with an unreachable engine: writes error under the legacy key (502)', async () => {
    legacyRow({ ...S3, targetType: 'gcs', targetUri: 'gs://bucket/orders' });
    (testEngineObject as any).mockRejectedValue(Object.assign(new Error('object not found'), { code: 'engine_object_missing' }));
    const { res, j } = await run(S3.id);
    expect([res.status, j.code]).toEqual([502, 'engine_object_missing']);
    wroteUnderLegacy(S3.id, 'error');
  });

  it('s3 with no engine binding: writes pending under the legacy key', async () => {
    legacyRow({ ...S3, engine: 'none' });
    const { res } = await run(S3.id);
    expect(res.status).toBe(200);
    wroteUnderLegacy(S3.id, 'pending');
  });

  const SP = {
    id: 'bronze:files::sp', name: 'sp', kind: 'files', targetType: 'sharepoint',
    targetUri: 'sharepoint://drive-1/Shared/orders.csv',
  };

  it('sharepoint: re-reads the drive item and writes active under the legacy key', async () => {
    legacyRow(SP);
    (parseSharepointUri as any).mockReturnValue({ driveId: 'drive-1', path: 'Shared/orders.csv' });
    const { res } = await run(SP.id);
    expect(res.status).toBe(200);
    expect(headDriveItem).toHaveBeenCalledWith('drive-1', 'Shared/orders.csv');
    wroteUnderLegacy(SP.id, 'active');
  });

  it('sharepoint with Graph not configured: writes pending under the legacy key (503)', async () => {
    legacyRow(SP);
    (graphDriveConfigGate as any).mockReturnValue({ code: 'graph_not_configured', hint: { followUp: 'grant the Graph app role' } });
    const { res, j } = await run(SP.id);
    expect([res.status, j.code]).toEqual([503, 'graph_not_configured']);
    wroteUnderLegacy(SP.id, 'pending');
  });

  it('sharepoint with an unparseable target: writes error under the legacy key (400 bad_target)', async () => {
    legacyRow({ ...SP, targetUri: 'sharepoint://' });
    (parseSharepointUri as any).mockReturnValue(null);
    const { res, j } = await run(SP.id);
    expect([res.status, j.code]).toEqual([400, 'bad_target']);
    // The drive is never read for a target that does not parse.
    expect(headDriveItem).not.toHaveBeenCalled();
    // route.ts:159 -- breaks on 'lh' in arg 0 of the error write-back.
    wroteUnderLegacy(SP.id, 'error');
  });

  it.each([
    ['a Graph status (404, item moved)', { status: 404, code: 'drive_item_not_found' }, 404, 'drive_item_not_found'],
    ['no status and no code', {}, 502, 'graph_drive_error'],
  ])('sharepoint drive read failing with %s: writes error under the legacy key', async (_l, extra, status, code) => {
    legacyRow(SP);
    (parseSharepointUri as any).mockReturnValue({ driveId: 'drive-1', path: 'Shared/orders.csv' });
    (headDriveItem as any).mockRejectedValue(Object.assign(new Error('item not found'), extra));
    const { res, j } = await run(SP.id);
    // Breaks if the Graph status is not carried through (the 404 row reads 502),
    // or the fallbacks change (the second row reads another status / code).
    expect([res.status, j.code]).toEqual([status, code]);
    expect(headDriveItem).toHaveBeenCalledWith('drive-1', 'Shared/orders.csv');
    // route.ts:168 -- breaks on 'lh' in arg 0 of the error write-back.
    wroteUnderLegacy(SP.id, 'error');
  });

  const SAS = {
    id: 'bronze:files::ext', name: 'ext', kind: 'files', targetType: 'adls',
    targetUri: 'abfss://data@partneracct.dfs.core.windows.net/orders',
    credentialRef: { kind: 'sas', keyVaultSecret: 'loom-sc-partner-sas' },
    lakehouseId: 'bronze', createdBy: 'u@x', createdByOid: 'oid-u',
  };

  it('SAS-authenticated ADLS: probes with the SAS and writes active under the legacy key', async () => {
    legacyRow(SAS);
    (getKeyVaultSecret as any).mockResolvedValue('sas-fixture');
    (parseAbfss as any).mockReturnValue({ account: 'partneracct', container: 'data', path: 'orders' });
    const { res } = await run(SAS.id);
    expect(res.status).toBe(200);
    expect((listAdlsWithSas as any).mock.calls[0][0]).toMatchObject({ account: 'partneracct', container: 'data', path: 'orders' });
    expect(resolveAndTestAdls).not.toHaveBeenCalled();
    wroteUnderLegacy(SAS.id, 'active');
  });

  it('SAS-authenticated ADLS with an empty secret: writes error under the legacy key', async () => {
    legacyRow(SAS);
    (getKeyVaultSecret as any).mockResolvedValue('   ');
    const { res, j } = await run(SAS.id);
    expect([res.status, j.code]).toEqual([502, 'kv_secret_empty']);
    expect(listAdlsWithSas).not.toHaveBeenCalled();
    wroteUnderLegacy(SAS.id, 'error');
  });

  it('UAMI ADLS unreachable: writes error under the legacy key (502)', async () => {
    const row = { ...ADLS_ROW, id: 'bronze:files::a' };
    legacyRow(row);
    (resolveAndTestAdls as any).mockRejectedValue(Object.assign(new Error('403 AuthorizationPermissionMismatch'), { code: 'forbidden' }));
    const { res, j } = await run(row.id);
    expect([res.status, j.code]).toEqual([502, 'forbidden']);
    wroteUnderLegacy(row.id, 'error');
  });

  it('dataverse with no resolved path: writes pending under the legacy key', async () => {
    legacyRow({ id: 'bronze:files::dv', name: 'dv', kind: 'files', targetType: 'dataverse', targetUri: 'dataverse://org/table' });
    const { res } = await run('bronze:files::dv');
    expect(res.status).toBe(200);
    expect(resolveAndTestAdls).not.toHaveBeenCalled();
    wroteUnderLegacy('bronze:files::dv', 'pending');
  });
});
