/**
 * Backend contract tests for /api/lakehouse/shortcuts — Azure-native lakehouse
 * shortcuts (NO Fabric dependency).
 *
 *   GET    list: 401 / 400 / happy-path returns registry rows
 *   POST   create: 401 / 400 validation / ADLS happy path / external honest-gate
 *   DELETE: 401 / 400 / happy path drops engine obj + row
 *   Item scope: GET needs read access to the lakehouse item, POST and DELETE
 *   need edit rights; a refusal reads the probe / engine / registry call rows.
 *   Earlier rows: rows under the container key are listed and deleted only
 *   when `legacyContainerKeyFor` names that key for the item.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/auth/session', () => ({ getSession: vi.fn() }));
vi.mock('@/lib/azure/adls-client', () => ({ getAccountName: vi.fn(() => 'loomacct') }));
vi.mock('@/lib/azure/lakehouse-shortcuts', () => ({
  listShortcuts: vi.fn(),
  createShortcut: vi.fn(),
  deleteShortcut: vi.fn(),
  getShortcut: vi.fn(),
}));
vi.mock('@/lib/azure/shortcut-engines', () => ({
  resolveAndTestAdls: vi.fn(),
  createTablesShortcut: vi.fn(),
  dropShortcutObject: vi.fn(),
  dropExternalBinding: vi.fn(),
  dropDeltaSharingCredential: vi.fn(),
  bindExternalSource: vi.fn(),
  externalSourceGate: vi.fn(() => null),
}));
vi.mock('@/lib/auth/item-access', () => ({ resolveItemAccessByOid: vi.fn() }));
vi.mock('../_lib/legacy-container-key', () => ({ legacyContainerKeyFor: vi.fn() }));

import { GET, POST, DELETE } from '../shortcuts/route';
import { getSession } from '@/lib/auth/session';
import { resolveItemAccessByOid } from '@/lib/auth/item-access';
import { legacyContainerKeyFor } from '../_lib/legacy-container-key';
import {
  listShortcuts, createShortcut, deleteShortcut, getShortcut,
} from '@/lib/azure/lakehouse-shortcuts';
import {
  resolveAndTestAdls, createTablesShortcut, dropShortcutObject, externalSourceGate, bindExternalSource,
  dropDeltaSharingCredential,
} from '@/lib/azure/shortcut-engines';

function getReq(qs: string) { return { nextUrl: new URL(`http://x/api/lakehouse/shortcuts?${qs}`) } as any; }
function postReq(body: any) { return { json: async () => body } as any; }
function delReq(qs: string) { return { nextUrl: new URL(`http://x/api/lakehouse/shortcuts?${qs}`) } as any; }

const sess = { claims: { upn: 'u@x', tid: 't1' } };
function access(canWrite = true) {
  return { item: { id: 'lh', workspaceId: 'ws-1', itemType: 'lakehouse' }, role: canWrite ? 'Member' : 'Viewer', via: 'workspace', canWrite };
}

beforeEach(() => {
  vi.resetAllMocks();
  (externalSourceGate as any).mockReturnValue(null);
  (resolveItemAccessByOid as any).mockResolvedValue(access(true));
  (legacyContainerKeyFor as any).mockResolvedValue(null);
});

describe('GET /api/lakehouse/shortcuts', () => {
  it('401 without session', async () => {
    (getSession as any).mockReturnValue(null);
    expect((await GET(getReq('lakehouseId=lh'))).status).toBe(401);
  });
  it('400 without lakehouseId', async () => {
    (getSession as any).mockReturnValue(sess);
    expect((await GET(getReq(''))).status).toBe(400);
  });
  it('returns registry rows', async () => {
    (getSession as any).mockReturnValue(sess);
    (listShortcuts as any).mockResolvedValue([{ id: 'lh:files::a', name: 'a', kind: 'files' }]);
    const res = await GET(getReq('lakehouseId=lh'));
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.data).toHaveLength(1);
    expect(j.data[0].name).toBe('a');
  });
});

describe('POST /api/lakehouse/shortcuts', () => {
  it('401 without session', async () => {
    (getSession as any).mockReturnValue(null);
    expect((await POST(postReq({}))).status).toBe(401);
  });
  it('400 on missing/invalid fields', async () => {
    (getSession as any).mockReturnValue(sess);
    expect((await POST(postReq({ lakehouseId: 'lh' }))).status).toBe(400); // no name
    expect((await POST(postReq({ lakehouseId: 'lh', name: 'a', kind: 'bogus', targetType: 'adls', targetUri: 'x' }))).status).toBe(400);
    expect((await POST(postReq({ lakehouseId: 'lh', name: 'a', kind: 'files', targetType: 'nope', targetUri: 'x' }))).status).toBe(400);
  });
  it('creates an ADLS Files shortcut on the happy path', async () => {
    (getSession as any).mockReturnValue(sess);
    (resolveAndTestAdls as any).mockResolvedValue({ abfssUri: 'abfss://c@loomacct.dfs.core.windows.net/p', reachable: true });
    (createShortcut as any).mockImplementation(async (d: any) => ({ ...d, id: 'lh:files::a', fullPath: 'Files/a', status: 'active' }));
    const res = await POST(postReq({
      lakehouseId: 'lh', name: 'a', kind: 'files', targetType: 'adls',
      targetUri: 'abfss://c@loomacct.dfs.core.windows.net/p',
    }));
    const j = await res.json();
    expect(res.status).toBe(200);
    expect(j.ok).toBe(true);
    expect(j.data.fullPath).toBe('Files/a');
    expect(resolveAndTestAdls).toHaveBeenCalledTimes(1);
  });
  it('registers a Tables shortcut via the engine', async () => {
    (getSession as any).mockReturnValue(sess);
    (resolveAndTestAdls as any).mockResolvedValue({ abfssUri: 'abfss://c@loomacct.dfs.core.windows.net/p', reachable: true });
    (createTablesShortcut as any).mockResolvedValue({ engine: 'synapse', engineObject: 'shortcuts.a' });
    (createShortcut as any).mockImplementation(async (d: any) => ({ ...d, id: 'lh:tables::a', fullPath: 'Tables/a' }));
    const res = await POST(postReq({
      lakehouseId: 'lh', name: 'a', kind: 'tables', targetType: 'adls',
      targetUri: 'abfss://c@loomacct.dfs.core.windows.net/p', format: 'delta',
    }));
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.data.engine).toBe('synapse');
    expect(j.data.engineObject).toBe('shortcuts.a');
  });
  it('honest-gates an external (S3) source with 503', async () => {
    (getSession as any).mockReturnValue(sess);
    (externalSourceGate as any).mockReturnValue({ gated: true, code: 'needs_credential', hint: 'set KV secret' });
    const res = await POST(postReq({ lakehouseId: 'lh', name: 'a', kind: 'files', targetType: 's3', targetUri: 's3://b/p' }));
    expect(res.status).toBe(503);
    const j = await res.json();
    expect(j.ok).toBe(false);
    expect(j.code).toBe('needs_credential');
  });
  it('honest-gates a Delta Sharing source with no credential (503)', async () => {
    (getSession as any).mockReturnValue(sess);
    (externalSourceGate as any).mockReturnValue({ gated: true, code: 'needs_credential', hint: 'store the Delta Sharing credential file' });
    const res = await POST(postReq({
      lakehouseId: 'lh', name: 'ds', kind: 'files', targetType: 'delta_sharing',
      targetUri: 'delta-sharing://share/schema/table',
    }));
    expect(res.status).toBe(503);
    const j = await res.json();
    expect(j.code).toBe('needs_credential');
  });
  it('creates a Delta Sharing Files shortcut via bindExternalSource', async () => {
    (getSession as any).mockReturnValue(sess);
    (bindExternalSource as any).mockResolvedValue({
      readUri: 'delta-sharing://share/schema/table',
      deltaSharing: { profile: { endpoint: 'https://x/', bearerToken: 't' }, share: 'share', schema: 'schema', table: 'table' },
    });
    (createShortcut as any).mockImplementation(async (d: any) => ({ ...d, id: 'lh:files::ds', fullPath: 'Files/ds', status: 'active' }));
    const res = await POST(postReq({
      lakehouseId: 'lh', name: 'ds', kind: 'files', targetType: 'delta_sharing',
      targetUri: 'delta-sharing://share/schema/table',
      credentialRef: { kind: 'deltaSharing', keyVaultSecret: 'ds-cred' },
    }));
    const j = await res.json();
    expect(res.status).toBe(200);
    expect(j.ok).toBe(true);
    expect(j.data.targetType).toBe('delta_sharing');
    expect(bindExternalSource).toHaveBeenCalledTimes(1);
  });
});

describe('DELETE /api/lakehouse/shortcuts', () => {
  it('401 without session', async () => {
    (getSession as any).mockReturnValue(null);
    expect((await DELETE(delReq('lakehouseId=lh&id=x'))).status).toBe(401);
  });
  it('400 without id', async () => {
    (getSession as any).mockReturnValue(sess);
    expect((await DELETE(delReq('lakehouseId=lh'))).status).toBe(400);
  });
  it('drops the engine object then deletes the row', async () => {
    (getSession as any).mockReturnValue(sess);
    (getShortcut as any).mockResolvedValue({ id: 'lh:tables::a', engine: 'synapse', engineObject: 'shortcuts.a' });
    (dropShortcutObject as any).mockResolvedValue(undefined);
    (deleteShortcut as any).mockResolvedValue({ ok: true });
    const res = await DELETE(delReq('lakehouseId=lh&id=lh:tables::a'));
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(dropShortcutObject).toHaveBeenCalledWith({ engine: 'synapse', engineObject: 'shortcuts.a' });
    expect(deleteShortcut).toHaveBeenCalledTimes(1);
  });
});

describe('/api/lakehouse/shortcuts — item scope', () => {
  const adlsBody = { lakehouseId: 'lh', name: 'a', kind: 'files', targetType: 'adls', targetUri: 'abfss://c@loomacct.dfs.core.windows.net/p' };

  it('GET requires access to the lakehouse item (404; registry not read)', async () => {
    (getSession as any).mockReturnValue(sess);
    (resolveItemAccessByOid as any).mockResolvedValue(null);
    expect((await GET(getReq('lakehouseId=lh'))).status).toBe(404);
    expect(listShortcuts).not.toHaveBeenCalled();
  });

  it('GET lists for a read-only role (positive arm)', async () => {
    (getSession as any).mockReturnValue(sess);
    (resolveItemAccessByOid as any).mockResolvedValue(access(false));
    (listShortcuts as any).mockResolvedValue([]);
    expect((await GET(getReq('lakehouseId=lh'))).status).toBe(200);
    expect((listShortcuts as any).mock.calls).toEqual([['lh']]);
  });

  it('POST requires edit rights (403 for a read-only role; nothing probed or saved)', async () => {
    (getSession as any).mockReturnValue(sess);
    (resolveItemAccessByOid as any).mockResolvedValue(access(false));
    const res = await POST(postReq(adlsBody));
    expect(res.status).toBe(403);
    expect(resolveAndTestAdls).not.toHaveBeenCalled();
    expect(bindExternalSource).not.toHaveBeenCalled();
    expect(createShortcut).not.toHaveBeenCalled();
  });

  it('POST requires access to the lakehouse item (404; nothing probed or saved)', async () => {
    (getSession as any).mockReturnValue(sess);
    (resolveItemAccessByOid as any).mockResolvedValue(null);
    const res = await POST(postReq(adlsBody));
    expect(res.status).toBe(404);
    expect(resolveAndTestAdls).not.toHaveBeenCalled();
    expect(createShortcut).not.toHaveBeenCalled();
  });

  it('POST authorizes before an external credential is bound', async () => {
    (getSession as any).mockReturnValue(sess);
    (resolveItemAccessByOid as any).mockResolvedValue(access(false));
    const res = await POST(postReq({
      lakehouseId: 'lh', name: 'ds', kind: 'files', targetType: 'delta_sharing',
      targetUri: 'delta-sharing://share/schema/table', credentialRef: { kind: 'deltaSharing', keyVaultSecret: 'ds-cred' },
    }));
    expect(res.status).toBe(403);
    expect(bindExternalSource).not.toHaveBeenCalled();
  });

  it('DELETE requires edit rights (403; nothing dropped or deleted)', async () => {
    (getSession as any).mockReturnValue(sess);
    (resolveItemAccessByOid as any).mockResolvedValue(access(false));
    (getShortcut as any).mockResolvedValue({ id: 'lh:tables::a', engine: 'synapse', engineObject: 'shortcuts.a' });
    const res = await DELETE(delReq('lakehouseId=lh&id=lh:tables::a'));
    expect(res.status).toBe(403);
    expect(dropShortcutObject).not.toHaveBeenCalled();
    expect(deleteShortcut).not.toHaveBeenCalled();
  });

  it('DELETE requires access to the lakehouse item (404)', async () => {
    (getSession as any).mockReturnValue(sess);
    (resolveItemAccessByOid as any).mockResolvedValue(null);
    const res = await DELETE(delReq('lakehouseId=lh&id=lh:tables::a'));
    expect(res.status).toBe(404);
    expect(deleteShortcut).not.toHaveBeenCalled();
  });
});

describe('/api/lakehouse/shortcuts — refusal codes', () => {
  it('400s carry bad_request and a remediation', async () => {
    (getSession as any).mockReturnValue(sess);
    for (const res of [
      await GET(getReq('')),
      await POST(postReq({ lakehouseId: 'lh' })),
      await POST(postReq({ lakehouseId: 'lh', name: 'a', kind: 'bogus', targetType: 'adls', targetUri: 'x' })),
      await DELETE(delReq('lakehouseId=lh')),
    ]) {
      const j = await res.json();
      // Breaks if any 400 above is returned without its code or remediation.
      expect([res.status, j.code, typeof j.remediation]).toEqual([400, 'bad_request', 'string']);
    }
  });

  it('a caller without access to the item gets item_not_found', async () => {
    (getSession as any).mockReturnValue(sess);
    (resolveItemAccessByOid as any).mockResolvedValue(null);
    const j = await (await GET(getReq('lakehouseId=lh'))).json();
    expect(j.code).toBe('item_not_found');
    expect(j.remediation).toMatch(/workspace/);
  });

  it('a read-only role deleting gets read_only', async () => {
    (getSession as any).mockReturnValue(sess);
    (resolveItemAccessByOid as any).mockResolvedValue(access(false));
    const res = await DELETE(delReq('lakehouseId=lh&id=lh:files::a'));
    const j = await res.json();
    expect([res.status, j.code]).toEqual([403, 'read_only']);
    expect(j.remediation).toMatch(/Member or Admin/);
  });
});

describe('/api/lakehouse/shortcuts — rows saved under the container key', () => {
  const OWN = { id: 'lh:files::a', lakehouseId: 'lh', name: 'a', kind: 'files', parentPath: '' };
  const OLD_SAME_SLOT = { id: 'bronze:files::a', lakehouseId: 'bronze', name: 'a', kind: 'files', parentPath: '' };
  const OLD = { id: 'bronze:tables::orders_ext', lakehouseId: 'bronze', name: 'orders_ext', kind: 'tables', parentPath: '' };

  function listBy(rows: Record<string, unknown[]>) {
    (listShortcuts as any).mockImplementation(async (key: string) => rows[key] ?? []);
  }

  it('lists them, marked legacy, when the item is the one lakehouse on that container', async () => {
    (getSession as any).mockReturnValue(sess);
    (legacyContainerKeyFor as any).mockResolvedValue('bronze');
    listBy({ lh: [OWN], bronze: [OLD_SAME_SLOT, OLD] });
    const j = await (await GET(getReq('lakehouseId=lh'))).json();
    // Breaks if the fallback is not read (OLD missing), if the item row is
    // shadowed by the older row in the same slot, or if the marker is dropped.
    expect(j.data.map((r: any) => [r.id, !!r.legacy])).toEqual([
      ['lh:files::a', false],
      ['bronze:tables::orders_ext', true],
    ]);
    expect(legacyContainerKeyFor).toHaveBeenCalledWith('lh', 'ws-1');
  });

  it('does not read the container key when no key is attributed to the item', async () => {
    (getSession as any).mockReturnValue(sess);
    (legacyContainerKeyFor as any).mockResolvedValue(null);
    listBy({ lh: [OWN], bronze: [OLD] });
    const j = await (await GET(getReq('lakehouseId=lh'))).json();
    // Breaks if the container rows are listed without the attribution check.
    expect(j.data.map((r: any) => r.id)).toEqual(['lh:files::a']);
    expect((listShortcuts as any).mock.calls).toEqual([['lh']]);
  });

  it('deletes an earlier row under the key that holds it', async () => {
    (getSession as any).mockReturnValue(sess);
    (legacyContainerKeyFor as any).mockResolvedValue('bronze');
    const row = { ...OLD, id: 'bronze:tables::ds', name: 'ds', targetType: 'delta_sharing', engine: 'databricks', engineObject: 'loom.x.ds' };
    (getShortcut as any).mockImplementation(async (key: string) => (key === 'bronze' ? row : null));
    (dropShortcutObject as any).mockResolvedValue(undefined);
    (dropDeltaSharingCredential as any).mockResolvedValue(undefined);
    (deleteShortcut as any).mockResolvedValue({ ok: true });
    const res = await DELETE(delReq('lakehouseId=lh&id=bronze:tables::ds'));
    expect(res.status).toBe(200);
    // Breaks if the delete still targets the item key (the row would stay).
    expect((deleteShortcut as any).mock.calls).toEqual([['bronze', 'bronze:tables::ds']]);
    expect((dropDeltaSharingCredential as any).mock.calls).toEqual([['bronze', 'ds']]);
    expect(dropShortcutObject).toHaveBeenCalledWith({ engine: 'databricks', engineObject: 'loom.x.ds' });
  });

  it('does not touch the container key for a delete when no key is attributed', async () => {
    (getSession as any).mockReturnValue(sess);
    (legacyContainerKeyFor as any).mockResolvedValue(null);
    (getShortcut as any).mockResolvedValue(null);
    (deleteShortcut as any).mockResolvedValue({ ok: true });
    await DELETE(delReq('lakehouseId=lh&id=bronze:tables::ds'));
    expect((getShortcut as any).mock.calls).toEqual([['lh', 'bronze:tables::ds']]);
    expect((deleteShortcut as any).mock.calls).toEqual([['lh', 'bronze:tables::ds']]);
    expect(dropShortcutObject).not.toHaveBeenCalled();
  });
});
