/**
 * The shortcut routes keep BOTH sets of checks: the lakehouse item check
 * (reach, then edit rights) and the stored-credential checks (the secret
 * resolver's owner check, the Test route's tenant check, and redacted error
 * text).
 *
 * Each route has a positive case that passes every check, then one test per
 * check. Each check's test changes ONLY the input that check reads, so the
 * other checks would pass it. Every check test holds exactly one assertion, a
 * tuple, and the value that turns it red is named above it. The create route
 * checks a credential name twice: up front, then again when the SAS value is
 * read. The SAS owner test turns red only when both are removed. The
 * identity-path owner test never reads a value, so it turns red when the
 * up-front check alone is removed.
 *
 * The REAL resolver, refusal envelope and redaction run. The value read
 * (`getKeyVaultSecret`), the mint record (`getShortcutSecretOwnerRecord`), item
 * access, the registry and the engines are mocked.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/auth/session', () => ({ getSession: vi.fn() }));
vi.mock('@/lib/auth/item-access', () => ({ resolveItemAccessByOid: vi.fn() }));
vi.mock('../_lib/legacy-container-key', () => ({ legacyContainerKeyFor: vi.fn() }));
vi.mock('@/lib/azure/adls-client', () => ({ getAccountName: vi.fn(() => 'loomacct') }));
vi.mock('@/lib/azure/lakehouse-shortcuts', () => ({
  listShortcuts: vi.fn(),
  createShortcut: vi.fn(),
  deleteShortcut: vi.fn(),
  getShortcut: vi.fn(),
  updateShortcutStatus: vi.fn(),
  listShortcutSecretBindings: vi.fn(),
}));
vi.mock('@/lib/azure/shortcut-engines', () => ({
  resolveAndTestAdls: vi.fn(),
  createTablesShortcut: vi.fn(),
  dropShortcutObject: vi.fn(),
  dropExternalBinding: vi.fn(),
  dropDeltaSharingCredential: vi.fn(),
  bindExternalSource: vi.fn(),
  externalSourceGate: vi.fn(() => null),
  testEngineObject: vi.fn(),
  refreshDeltaSharingCredential: vi.fn(),
}));
vi.mock('@/lib/azure/shortcut-credentials', () => ({
  getKeyVaultSecret: vi.fn(),
  keyVaultConfigGate: vi.fn(() => null),
}));
vi.mock('@/lib/azure/kv-secrets-client', () => ({
  getShortcutSecretOwnerRecord: vi.fn(),
  getShortcutSecretValue: vi.fn(),
}));
vi.mock('@/lib/azure/shortcut-client', async (orig) => ({
  ...(await orig<typeof import('@/lib/azure/shortcut-client')>()),
  listAdlsWithSas: vi.fn(),
}));
vi.mock('@/lib/azure/graph-drive-client', () => ({
  headDriveItem: vi.fn(),
  parseSharepointUri: vi.fn(),
  graphDriveConfigGate: vi.fn(() => null),
}));

import { GET, POST as CREATE, DELETE } from '../shortcuts/route';
import { POST as TEST } from '../shortcuts/test/route';
import { getSession } from '@/lib/auth/session';
import { resolveItemAccessByOid } from '@/lib/auth/item-access';
import { legacyContainerKeyFor } from '../_lib/legacy-container-key';
import {
  listShortcuts, createShortcut, deleteShortcut, getShortcut, updateShortcutStatus, listShortcutSecretBindings,
} from '@/lib/azure/lakehouse-shortcuts';
import { externalSourceGate, dropShortcutObject, resolveAndTestAdls } from '@/lib/azure/shortcut-engines';
import { getKeyVaultSecret } from '@/lib/azure/shortcut-credentials';
import { getShortcutSecretOwnerRecord } from '@/lib/azure/kv-secrets-client';
import { listAdlsWithSas, ShortcutSourceError } from '@/lib/azure/shortcut-client';

const vault = getKeyVaultSecret as unknown as ReturnType<typeof vi.fn>;
const ownerRecord = getShortcutSecretOwnerRecord as unknown as ReturnType<typeof vi.fn>;
const access = resolveItemAccessByOid as unknown as ReturnType<typeof vi.fn>;
const calls = (fn: unknown) => (fn as ReturnType<typeof vi.fn>).mock.calls.length;

const LH = 'bronze';
const ROW_ID = 'bronze:files::ext';
const HOST_PATH = 'https://partner.dfs.core.windows.net/data';
// Low-entropy placeholder. The redaction drops the whole query string, so the
// value's shape does not matter; it only has to be findable.
const SENTINEL = 'fixture-sig-sentinel';
const errorWithQuery = () => new ShortcutSourceError(`ADLS list failed at ${HOST_PATH}?resource=filesystem&sig=${SENTINEL}`, 'adls_list_failed', 502);

/**
 * True when `text` names HOST_PATH: every URL in it is PARSED, and its origin
 * plus path is compared with `===`. Not `text.includes(HOST_PATH)`: that is
 * also satisfied by a different host that merely contains this one, and CodeQL
 * flags it (js/incomplete-url-substring-sanitization). False when the route
 * drops the URL from the message (for example a generic "list failed" text),
 * or names another host or path.
 */
const namesHostPath = (text: unknown): boolean =>
  (String(text ?? '').match(/https?:\/\/[^\s'"<>]+/g) ?? []).some((raw) => {
    try {
      const u = new URL(raw);
      return `${u.origin}${u.pathname}` === HOST_PATH;
    } catch {
      return false;
    }
  });
// The helper's own controls: the fixture URL matches, and a host that only
// CONTAINS the expected one does not (the case `.includes` would accept).
describe('namesHostPath (the URL check the redaction tests use)', () => {
  it('matches the fixture URL and refuses a host that only contains it', () => {
    expect([
      namesHostPath(`failed at ${HOST_PATH}?sig=x`),
      namesHostPath('failed at https://partner.dfs.core.windows.net.example/data'),
      namesHostPath('list failed'),
    ]).toEqual([true, false, false]);
  });
});

const me = { claims: { oid: 'oid-me', upn: 'me@contoso.com', tid: 't1' } };
const recordFor = (oid: string, tid?: string) => ({ exists: true, owner: { oid, lakehouseId: LH, ...(tid ? { tid } : {}) } });
const grant = (canWrite: boolean) => async (_s: unknown, id: string) => ({
  item: { id, workspaceId: 'ws-1', itemType: 'lakehouse' }, role: canWrite ? 'Member' : 'Viewer', via: 'workspace', canWrite,
});
const postReq = (body: any) => ({ json: async () => body }) as any;
const urlReq = (qs: string) => ({ nextUrl: new URL(`http://x/api/lakehouse/shortcuts?${qs}`) }) as any;

const sasBody = {
  lakehouseId: LH, name: 'ext', kind: 'files', targetType: 'adls',
  targetUri: 'abfss://data@partner.dfs.core.windows.net/exports',
  credentialRef: { kind: 'sas', keyVaultSecret: 'loom-sc-mine' },
};
const myRow = {
  id: ROW_ID, lakehouseId: LH, name: 'ext', kind: 'files', targetType: 'adls',
  targetUri: 'abfss://data@partner.dfs.core.windows.net/exports', status: 'active',
  credentialRef: { kind: 'sas', keyVaultSecret: 'loom-sc-mine' }, createdBy: 'me@contoso.com', createdByOid: 'oid-me',
};

beforeEach(() => {
  vi.resetAllMocks();
  (getSession as any).mockReturnValue(me);
  access.mockImplementation(grant(true));
  (legacyContainerKeyFor as any).mockResolvedValue(null);
  (externalSourceGate as any).mockReturnValue(null);
  (listShortcutSecretBindings as any).mockResolvedValue([]);
  ownerRecord.mockResolvedValue(recordFor('oid-me'));
  vault.mockResolvedValue('?sv=2024&sig=abc');
  (listAdlsWithSas as any).mockResolvedValue({ entries: [] });
  (listShortcuts as any).mockResolvedValue([myRow]);
  (getShortcut as any).mockImplementation(async (key: string, id: string) => (key === LH && id === ROW_ID ? myRow : null));
  (createShortcut as any).mockImplementation(async (d: any) => ({ ...d, id: ROW_ID }));
  (deleteShortcut as any).mockResolvedValue(undefined);
  (dropShortcutObject as any).mockResolvedValue(undefined);
  (updateShortcutStatus as any).mockImplementation(async (_k: string, id: string, status: string, statusDetail?: string) => ({ id, status, statusDetail }));
});

describe('GET /api/lakehouse/shortcuts — item check and redacted errors', () => {
  it('positive: a reachable lakehouse lists its rows', async () => {
    const res = await GET(urlReq(`lakehouseId=${LH}`));
    const j = await res.json();
    expect([res.status, j.data?.length, calls(listShortcuts)]).toEqual([200, 1, 1]);
  });

  // Red when the item check's refusal is not returned (the registry is read: 1, or the status is not 404).
  it('item check: an unreachable lakehouse is 404 item_not_found with no registry read', async () => {
    access.mockResolvedValue(null);
    const res = await GET(urlReq(`lakehouseId=${LH}`));
    const j = await res.json();
    expect([res.status, j.code, calls(listShortcuts)]).toEqual([404, 'item_not_found', 0]);
  });

  // Red when `sanitize` drops `redactErrorText` (the sentinel is in the response: true).
  it('redaction: a registry failure answers 502 with the URL kept and its query string removed', async () => {
    (listShortcuts as any).mockRejectedValue(errorWithQuery());
    const res = await GET(urlReq(`lakehouseId=${LH}`));
    const j = await res.json();
    expect([res.status, namesHostPath(j.error), JSON.stringify(j).includes(SENTINEL)]).toEqual([502, true, false]);
  });
});

describe('POST /api/lakehouse/shortcuts (create) — item check, owner check, redacted errors', () => {
  it('positive: the caller\'s own credential on a lakehouse they can edit creates the row', async () => {
    const res = await CREATE(postReq(sasBody));
    expect([res.status, calls(vault), calls(createShortcut)]).toEqual([200, 1, 1]);
  });

  // Red when the item check's refusal is not returned (the mint record is read, or a row is written).
  it('item check: an unreachable lakehouse is 404 item_not_found before any credential check', async () => {
    access.mockResolvedValue(null);
    const res = await CREATE(postReq(sasBody));
    const j = await res.json();
    expect([res.status, j.code, calls(ownerRecord), calls(vault), calls(createShortcut)]).toEqual([404, 'item_not_found', 0, 0, 0]);
  });

  // Red when the edit-rights check is dropped (status 200, one value read, one row).
  it('item check: a read-only role is 403 read_only before any credential check', async () => {
    access.mockImplementation(grant(false));
    const res = await CREATE(postReq(sasBody));
    const j = await res.json();
    expect([res.status, j.code, calls(ownerRecord), calls(vault), calls(createShortcut)]).toEqual([403, 'read_only', 0, 0, 0]);
  });

  // Red when the credential is read without either name check (status 200, one value read, one row).
  // Removing only one of the two leaves this green: the other still refuses.
  it('owner check: a credential another user saved is 403 shortcut_secret_not_owned, with no value read and no row', async () => {
    ownerRecord.mockResolvedValue(recordFor('oid-other'));
    const res = await CREATE(postReq(sasBody));
    const j = await res.json();
    expect([res.status, j.code, calls(vault), calls(createShortcut)]).toEqual([403, 'shortcut_secret_not_owned', 0, 0]);
  });

  // The SAS path above also resolves the value, so it refuses even without the
  // up-front name check. This path stores `credentialRef` on the row and never
  // reads the value (a `bearer` credential on an ADLS target goes the identity
  // route), so only the up-front check refuses it.
  const bearerBody = { ...sasBody, credentialRef: { kind: 'bearer', keyVaultSecret: 'loom-sc-mine' } };

  // Positive for the case below: the caller's own name on this path creates the
  // row without reading the value (vault 0), so the refusal below is the name check.
  it('positive: the caller\'s own credential name on the identity path creates the row without reading the value', async () => {
    (resolveAndTestAdls as any).mockResolvedValue({ abfssUri: 'abfss://data@partner.dfs.core.windows.net/exports' });
    const res = await CREATE(postReq(bearerBody));
    expect([res.status, calls(vault), calls(createShortcut)]).toEqual([200, 0, 1]);
  });

  // Red when `assertShortcutSecretUsable` is not called (status 200, one row recording the name).
  it('owner check (up-front): a credential name another user saved is refused on a path that never reads the value', async () => {
    (resolveAndTestAdls as any).mockResolvedValue({ abfssUri: 'abfss://data@partner.dfs.core.windows.net/exports' });
    ownerRecord.mockResolvedValue(recordFor('oid-other'));
    const res = await CREATE(postReq(bearerBody));
    const j = await res.json();
    expect([res.status, j.code, calls(vault), calls(createShortcut)]).toEqual([403, 'shortcut_secret_not_owned', 0, 0]);
  });

  // Red when `sanitize` drops `redactErrorText` (the sentinel is in the response or the stored row: true).
  it('redaction: a probe failure keeps the URL and removes its query string, in the response and the stored row', async () => {
    (listAdlsWithSas as any).mockRejectedValue(errorWithQuery());
    const res = await CREATE(postReq(sasBody));
    const j = await res.json();
    const stored = (createShortcut as any).mock.calls[0]?.[0];
    expect([res.status, j.code, namesHostPath(j.error), JSON.stringify(j).includes(SENTINEL), String(stored?.statusDetail).includes(SENTINEL)])
      .toEqual([502, 'adls_list_failed', true, false, false]);
  });
});

describe('DELETE /api/lakehouse/shortcuts — item check and redacted errors', () => {
  it('positive: a row on a lakehouse the caller can edit is deleted', async () => {
    const res = await DELETE(urlReq(`lakehouseId=${LH}&id=${ROW_ID}`));
    expect([res.status, (deleteShortcut as any).mock.calls]).toEqual([200, [[LH, ROW_ID]]]);
  });

  // Red when the item check's refusal is not returned (the row is read or deleted).
  it('item check: an unreachable lakehouse is 404 item_not_found with no row read or deleted', async () => {
    access.mockResolvedValue(null);
    const res = await DELETE(urlReq(`lakehouseId=${LH}&id=${ROW_ID}`));
    const j = await res.json();
    expect([res.status, j.code, calls(getShortcut), calls(deleteShortcut)]).toEqual([404, 'item_not_found', 0, 0]);
  });

  // Red when the edit-rights check is dropped (status 200, one delete).
  it('item check: a read-only role is 403 read_only with nothing deleted', async () => {
    access.mockImplementation(grant(false));
    const res = await DELETE(urlReq(`lakehouseId=${LH}&id=${ROW_ID}`));
    const j = await res.json();
    expect([res.status, j.code, calls(deleteShortcut)]).toEqual([403, 'read_only', 0]);
  });

  // Red when `sanitize` drops `redactErrorText` (the sentinel is in the response: true).
  it('redaction: a delete failure answers 502 with the URL kept and its query string removed', async () => {
    (deleteShortcut as any).mockRejectedValue(errorWithQuery());
    const res = await DELETE(urlReq(`lakehouseId=${LH}&id=${ROW_ID}`));
    const j = await res.json();
    expect([res.status, namesHostPath(j.error), JSON.stringify(j).includes(SENTINEL)]).toEqual([502, true, false]);
  });
});

describe('POST /api/lakehouse/shortcuts/test — item check, owner and tenant checks, redacted errors', () => {
  const run = () => TEST(postReq({ lakehouseId: LH, id: ROW_ID }));

  it('positive: the creator\'s credential on a lakehouse the caller can edit re-tests the row', async () => {
    const res = await run();
    expect([res.status, calls(vault), (updateShortcutStatus as any).mock.calls]).toEqual([200, 1, [[LH, ROW_ID, 'active', undefined]]]);
  });

  // Red when the item check's refusal is not returned (the row is read, or its status written).
  it('item check: an unreachable lakehouse is 404 item_not_found with no row read', async () => {
    access.mockResolvedValue(null);
    const res = await run();
    const j = await res.json();
    expect([res.status, j.code, calls(getShortcut), calls(vault), calls(updateShortcutStatus)]).toEqual([404, 'item_not_found', 0, 0, 0]);
  });

  // Red when the edit-rights check is dropped (status 200, one value read, one status write).
  it('item check: a read-only role is 403 read_only with nothing probed or written', async () => {
    access.mockImplementation(grant(false));
    const res = await run();
    const j = await res.json();
    expect([res.status, j.code, calls(vault), calls(updateShortcutStatus)]).toEqual([403, 'read_only', 0, 0]);
  });

  // Red when the credential is read without the resolver (status 200, one value read, one status write).
  it('owner check: a credential the row\'s creator did not save is 403 shortcut_secret_not_owned, row unchanged', async () => {
    ownerRecord.mockResolvedValue(recordFor('oid-other'));
    const res = await run();
    const j = await res.json();
    expect([res.status, j.code, calls(vault), calls(updateShortcutStatus)]).toEqual([403, 'shortcut_secret_not_owned', 0, 0]);
  });

  // The tenant check (#4860): the row's tenant is compared with the tenant the
  // credential was saved under. Both cases below use the creator's own oid, so
  // only the tenant differs between them.
  it('positive: a row whose tenant matches the recorded one re-tests the row', async () => {
    ownerRecord.mockResolvedValue(recordFor('oid-me', 't1'));
    (getShortcut as any).mockResolvedValue({ ...myRow, tenantId: 't1' });
    const res = await run();
    expect([res.status, calls(vault), calls(updateShortcutStatus)]).toEqual([200, 1, 1]);
  });

  // Red when the owner is built without `tid: sc.tenantId` (status 200, one value read, one status write).
  it('tenant check: a row whose tenant differs from the recorded one is 403 shortcut_secret_not_owned, row unchanged', async () => {
    ownerRecord.mockResolvedValue(recordFor('oid-me', 't1'));
    (getShortcut as any).mockResolvedValue({ ...myRow, tenantId: 't2' });
    const res = await run();
    const j = await res.json();
    expect([res.status, j.code, calls(vault), calls(updateShortcutStatus)]).toEqual([403, 'shortcut_secret_not_owned', 0, 0]);
  });

  // Red when `sanitize` drops `redactErrorText` (the sentinel is in the response or the stored status: true).
  it('redaction: a probe failure keeps the URL and removes its query string, in the response and the stored status', async () => {
    (listAdlsWithSas as any).mockRejectedValue(errorWithQuery());
    const res = await run();
    const j = await res.json();
    const detail = (updateShortcutStatus as any).mock.calls[0]?.[3];
    expect([res.status, j.code, namesHostPath(j.error), JSON.stringify(j).includes(SENTINEL), String(detail).includes(SENTINEL)])
      .toEqual([502, 'adls_list_failed', true, false, false]);
  });
});
