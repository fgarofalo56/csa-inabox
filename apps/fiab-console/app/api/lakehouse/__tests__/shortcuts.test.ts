/**
 * Backend contract tests for /api/lakehouse/shortcuts — Azure-native lakehouse
 * shortcuts (NO Fabric dependency).
 *
 *   GET    list: 401 / 400 / happy-path returns registry rows
 *   POST   create: 401 / 400 validation / ADLS happy path / external honest-gate
 *   DELETE: 401 / 400 / happy path drops engine obj + row
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

import { GET, POST, DELETE } from '../shortcuts/route';
import { getSession } from '@/lib/auth/session';
import {
  listShortcuts, createShortcut, deleteShortcut, getShortcut,
} from '@/lib/azure/lakehouse-shortcuts';
import {
  resolveAndTestAdls, createTablesShortcut, dropShortcutObject, externalSourceGate, bindExternalSource,
} from '@/lib/azure/shortcut-engines';

function getReq(qs: string) { return { nextUrl: new URL(`http://x/api/lakehouse/shortcuts?${qs}`) } as any; }
function postReq(body: any) { return { json: async () => body } as any; }
function delReq(qs: string) { return { nextUrl: new URL(`http://x/api/lakehouse/shortcuts?${qs}`) } as any; }

const sess = { claims: { upn: 'u@x', tid: 't1' } };

beforeEach(() => {
  vi.resetAllMocks();
  (externalSourceGate as any).mockReturnValue(null);
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
