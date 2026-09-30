/**
 * /api/lakehouse/shortcuts (create) and /api/lakehouse/shortcuts/test resolve
 * shortcut credentials through lib/azure/shortcut-secret-resolver — name
 * grammar, purpose policy and ownership (the mint record) run before any value
 * is read, a refused name never becomes a registry row, and a refusal on Test
 * leaves the row as it was.
 *
 * The REAL resolver runs; the value read (`getKeyVaultSecret`), the mint-record
 * read (`getShortcutSecretOwnerRecord`), the registry and the engines are mocked.
 *
 * WHAT BREAKS EACH LOAD-BEARING ASSERTION:
 *   - create, SAS path, platform name → 403, no value read, no row: the route
 *     calling `getKeyVaultSecret` directly (the round-0 code).
 *   - create, credential saved by another user → 403, no bind, no row: removing
 *     the up-front `assertShortcutSecretUsable` (bindExternalSource is mocked
 *     here and never refuses).
 *   - create, malformed name → 400: removing the grammar check (the name starts
 *     with `loom-sc-`, so the policy passes it).
 *   - Test, refused credential → 403 AND `updateShortcutStatus` not called:
 *     the round-1 catch block, which wrote `status: 'error'` before returning.
 *     The SAS row and the Delta Sharing row each reach a DIFFERENT catch block
 *     in the Test route; each is killed only by its own twin.
 *   - Test resolves as the row's CREATOR: resolving as the clicker instead — the
 *     positive twin has a different clicker and a record naming the creator.
 *   - SAS probe error: the route's `sanitize` without `redactErrorText` — the
 *     mocked upstream message carries the sentinel in a `sig=` URL parameter.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/auth/session', () => ({ getSession: vi.fn() }));
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
  listAdlsWithSas: vi.fn(async () => ({ entries: [] })),
}));
vi.mock('@/lib/azure/graph-drive-client', () => ({
  headDriveItem: vi.fn(),
  parseSharepointUri: vi.fn(),
  graphDriveConfigGate: vi.fn(() => null),
}));

import { POST as CREATE } from '../shortcuts/route';
import { POST as TEST } from '../shortcuts/test/route';
import { getSession } from '@/lib/auth/session';
import {
  createShortcut, getShortcut, updateShortcutStatus, listShortcutSecretBindings,
} from '@/lib/azure/lakehouse-shortcuts';
import { bindExternalSource, externalSourceGate } from '@/lib/azure/shortcut-engines';
import { getKeyVaultSecret } from '@/lib/azure/shortcut-credentials';
import { getShortcutSecretOwnerRecord } from '@/lib/azure/kv-secrets-client';
import { listAdlsWithSas, ShortcutSourceError } from '@/lib/azure/shortcut-client';

const vault = getKeyVaultSecret as unknown as ReturnType<typeof vi.fn>;
const ownerRecord = getShortcutSecretOwnerRecord as unknown as ReturnType<typeof vi.fn>;
const bindings = listShortcutSecretBindings as unknown as ReturnType<typeof vi.fn>;

function postReq(body: any) { return { json: async () => body } as any; }
const me = { claims: { oid: 'oid-me', upn: 'me@contoso.com', tid: 't1' } };
const recordFor = (oid: string, lakehouseId = 'bronze') => ({ exists: true, owner: { oid, lakehouseId } });

beforeEach(() => {
  vi.resetAllMocks();
  (getSession as any).mockReturnValue(me);
  (externalSourceGate as any).mockReturnValue(null);
  bindings.mockResolvedValue([]);
  ownerRecord.mockResolvedValue(recordFor('oid-me'));
  vault.mockResolvedValue('?sv=2024&sig=abc');
  (listAdlsWithSas as any).mockResolvedValue({ entries: [] });
  (createShortcut as any).mockImplementation(async (d: any) => ({ ...d, id: 'x' }));
  (updateShortcutStatus as any).mockImplementation(async (_l: string, id: string, status: string, statusDetail?: string) => ({ id, status, statusDetail }));
});

const sasBody = (secret: string) => ({
  lakehouseId: 'bronze', name: 'ext', kind: 'files', targetType: 'adls',
  targetUri: 'abfss://data@partner.dfs.core.windows.net/exports',
  credentialRef: { kind: 'sas', keyVaultSecret: secret },
});

describe('POST /api/lakehouse/shortcuts — credential checks', () => {
  it('refuses a platform secret on the SAS path with 403 and no value read or row', async () => {
    const res = await CREATE(postReq(sasBody('loom-msal-client-secret')));
    expect(res.status).toBe(403);
    const j = await res.json();
    expect(j.ok).toBe(false);
    expect(j.error).toContain('Save to Key Vault in the shortcut wizard');
    expect(vault).not.toHaveBeenCalled();
    expect(createShortcut).not.toHaveBeenCalled();
  });

  it('refuses a malformed name with 400 before any check reads anything', async () => {
    for (const bad of ['loom-sc-a/b', ' loom-sc-a', 'loom-sc-a%2Fb']) {
      const res = await CREATE(postReq(sasBody(bad)));
      expect(res.status, bad).toBe(400);
      expect((await res.json()).code).toBe('shortcut_secret_name_invalid');
    }
    expect(ownerRecord).not.toHaveBeenCalled();
    expect(vault).not.toHaveBeenCalled();
    expect(createShortcut).not.toHaveBeenCalled();
  });

  it('refuses a credential another user saved, before binding, with no row', async () => {
    ownerRecord.mockResolvedValue(recordFor('oid-other'));
    const res = await CREATE(postReq({
      lakehouseId: 'bronze', name: 'p', kind: 'files', targetType: 's3', targetUri: 's3://b/k',
      credentialRef: { kind: 'awsKeys', keyVaultSecret: 'loom-sc-theirs' },
    }));
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('shortcut_secret_not_owned');
    expect(bindExternalSource).not.toHaveBeenCalled();
    expect(createShortcut).not.toHaveBeenCalled();
    expect(vault).not.toHaveBeenCalled();
  });

  it('SAS path: resolves the caller\'s own credential and records the caller (oid + UPN) on the row', async () => {
    const res = await CREATE(postReq(sasBody('loom-sc-mine')));
    expect(res.status).toBe(200);
    expect(vault).toHaveBeenCalledWith('loom-sc-mine');
    expect(createShortcut).toHaveBeenCalledWith(expect.objectContaining({ createdBy: 'me@contoso.com', createdByOid: 'oid-me' }));
  });

  it('external path: passes the caller as the credential owner to bindExternalSource', async () => {
    (bindExternalSource as any).mockResolvedValue({ readUri: 's3://b/k' });
    const res = await CREATE(postReq({
      lakehouseId: 'bronze', name: 'p', kind: 'files', targetType: 's3', targetUri: 's3://b/k',
      credentialRef: { kind: 'awsKeys', keyVaultSecret: 'loom-sc-mine' },
    }));
    expect(res.status).toBe(200);
    expect(bindExternalSource).toHaveBeenCalledWith(expect.objectContaining({
      owner: { kind: 'principal', via: 'request', oid: 'oid-me', upn: 'me@contoso.com', tid: 't1', lakehouseId: 'bronze', targetType: 's3' },
    }));
  });

  it('refuses a credential recorded for the same oid in another tenant, before binding, with no row', async () => {
    // WHAT BREAKS IT: the create route building the owner without the session's
    // tid, so the tenant comparison is skipped and the bind runs. The session
    // tid is 't1'; the same record under 't1' binds (the test above).
    ownerRecord.mockResolvedValue({ exists: true, owner: { oid: 'oid-me', tid: 't2', lakehouseId: 'bronze' } });
    const res = await CREATE(postReq({
      lakehouseId: 'bronze', name: 'p', kind: 'files', targetType: 's3', targetUri: 's3://b/k',
      credentialRef: { kind: 'awsKeys', keyVaultSecret: 'loom-sc-mine' },
    }));
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('shortcut_secret_not_owned');
    expect(bindExternalSource).not.toHaveBeenCalled();
    expect(createShortcut).not.toHaveBeenCalled();
    expect(vault).not.toHaveBeenCalled();

    ownerRecord.mockResolvedValue({ exists: true, owner: { oid: 'oid-me', tid: 't1', lakehouseId: 'bronze' } });
    (bindExternalSource as any).mockResolvedValue({ readUri: 's3://b/k' });
    const ok = await CREATE(postReq({
      lakehouseId: 'bronze', name: 'p', kind: 'files', targetType: 's3', targetUri: 's3://b/k',
      credentialRef: { kind: 'awsKeys', keyVaultSecret: 'loom-sc-mine' },
    }));
    expect(ok.status).toBe(200);
    expect(bindExternalSource).toHaveBeenCalledTimes(1);
  });

  it('a SAS-probe error never carries URL query parameters into the response or the stored row', async () => {
    const SENTINEL = 'Vf5Rn8Qw1Zk4Mh7Ld2Tb6Xc9';
    (listAdlsWithSas as any).mockRejectedValue(new ShortcutSourceError(
      `ADLS list failed at https://partner.dfs.core.windows.net/data?resource=filesystem&sig=${SENTINEL}`,
      'adls_list_failed', 502,
    ));
    const res = await CREATE(postReq(sasBody('loom-sc-mine')));
    const j = await res.json();
    expect(j.code).toBe('adls_list_failed');
    expect(j.error).toContain('https://partner.dfs.core.windows.net/data');
    expect(JSON.stringify(j)).not.toContain(SENTINEL);
    const stored = (createShortcut as any).mock.calls[0][0];
    expect(stored.status).toBe('error');
    expect(stored.statusDetail).not.toContain(SENTINEL);
  });
});

describe('POST /api/lakehouse/shortcuts/test — credential checks', () => {
  const row = (secret: string, createdBy: string, createdByOid?: string) => ({
    id: 'bronze:files::ext', lakehouseId: 'bronze', name: 'ext', kind: 'files', targetType: 'adls',
    targetUri: 'abfss://data@partner.dfs.core.windows.net/exports', status: 'active',
    credentialRef: { kind: 'sas', keyVaultSecret: secret }, createdBy, createdByOid,
  });

  it('a policy refusal returns 403 and leaves the row unchanged', async () => {
    (getShortcut as any).mockResolvedValue(row('session-secret', 'me@contoso.com', 'oid-me'));
    const res = await TEST(postReq({ lakehouseId: 'bronze', id: 'bronze:files::ext' }));
    expect(res.status).toBe(403);
    const j = await res.json();
    expect(j.error).toMatch(/^Test uses the credential of the shortcut's owner\./);
    expect(vault).not.toHaveBeenCalled();
    expect(updateShortcutStatus).not.toHaveBeenCalled();
  });

  it('an ownership refusal returns 403, never "sign in again", and leaves the row unchanged', async () => {
    ownerRecord.mockResolvedValue(recordFor('oid-other'));
    (getShortcut as any).mockResolvedValue(row('loom-sc-theirs', 'me@contoso.com', 'oid-me'));
    const res = await TEST(postReq({ lakehouseId: 'bronze', id: 'bronze:files::ext' }));
    expect(res.status).toBe(403);
    const j = await res.json();
    expect(j.error).not.toMatch(/sign in again/i);
    expect(j.error).toContain('Delete the shortcut and re-create it');
    expect(vault).not.toHaveBeenCalled();
    expect(updateShortcutStatus).not.toHaveBeenCalled();
  });

  it('Delta Sharing: a refusal returns 403 and leaves the row unchanged', async () => {
    ownerRecord.mockResolvedValue(recordFor('oid-other'));
    (getShortcut as any).mockResolvedValue({
      ...row('loom-sc-theirs', 'me@contoso.com', 'oid-me'),
      targetType: 'delta_sharing', targetUri: 'share.schema.table',
      credentialRef: { kind: 'deltaSharing', keyVaultSecret: 'loom-sc-theirs' },
    });
    const res = await TEST(postReq({ lakehouseId: 'bronze', id: 'bronze:files::ext' }));
    expect(res.status).toBe(403);
    const j = await res.json();
    expect(j.error).toContain('saved by another user');
    expect(vault).not.toHaveBeenCalled();
    expect(updateShortcutStatus).not.toHaveBeenCalled();
  });

  it('resolves as the row\'s creator when a different user presses Test', async () => {
    // Session is me; the row and the mint record belong to other.
    ownerRecord.mockResolvedValue(recordFor('oid-other'));
    (getShortcut as any).mockResolvedValue(row('loom-sc-theirs', 'other@contoso.com', 'oid-other'));
    const res = await TEST(postReq({ lakehouseId: 'bronze', id: 'bronze:files::ext' }));
    expect(res.status).toBe(200);
    expect(vault).toHaveBeenCalledWith('loom-sc-theirs');
    expect(updateShortcutStatus).toHaveBeenCalledWith('bronze', 'bronze:files::ext', 'active', undefined);
  });
});
