/**
 * /api/lakehouse/shortcuts (create) and /api/lakehouse/shortcuts/test resolve
 * shortcut credentials through lib/azure/shortcut-secret-resolver — the purpose
 * policy and the ownership check run before any vault read, and a refused name
 * never becomes a registry row.
 *
 * The REAL resolver runs; the vault read (`getKeyVaultSecret`) and the registry
 * are mocked.
 *
 * WHAT BREAKS EACH LOAD-BEARING ASSERTION:
 *   - create, SAS path, platform name → 403 + no vault read: the route calling
 *     `getKeyVaultSecret` directly (the pre-change code) reads the vault and
 *     returns the listing result instead.
 *   - create, external path, name bound by another principal → 403 + no row +
 *     no bind: removing the up-front `assertShortcutSecretUsable` check lets the
 *     request reach `bindExternalSource` (mocked here, so it never refuses).
 *   - test, row whose creator is not the credential's first binder → 403 + no
 *     vault read: resolving on behalf of the CALLER instead of the row creator
 *     would still refuse here, so the positive twin pins the other direction —
 *     the creator's own row resolves even when a different user presses Test.
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
  networkFailureReason: vi.fn(() => 'network error'),
}));
vi.mock('@/lib/azure/shortcut-credentials', () => ({
  getKeyVaultSecret: vi.fn(),
  keyVaultConfigGate: vi.fn(() => null),
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
import { listAdlsWithSas } from '@/lib/azure/shortcut-client';

const vault = getKeyVaultSecret as unknown as ReturnType<typeof vi.fn>;
const bindings = listShortcutSecretBindings as unknown as ReturnType<typeof vi.fn>;

function postReq(body: any) { return { json: async () => body } as any; }
const me = { claims: { upn: 'me@contoso.com', tid: 't1' } };

const BOUND_BY_OTHER = [
  { lakehouseId: 'bronze', id: 'bronze:files::theirs', createdBy: 'other@contoso.com', createdAt: '2026-09-01T00:00:00Z' },
];

beforeEach(() => {
  vi.resetAllMocks();
  (getSession as any).mockReturnValue(me);
  (externalSourceGate as any).mockReturnValue(null);
  bindings.mockResolvedValue([]);
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

describe('POST /api/lakehouse/shortcuts — credential policy', () => {
  it('refuses a platform secret on the SAS path with 403 and no vault read or row', async () => {
    const res = await CREATE(postReq(sasBody('loom-msal-client-secret')));
    expect(res.status).toBe(403);
    expect((await res.json()).ok).toBe(false);
    expect(vault).not.toHaveBeenCalled();
    expect(createShortcut).not.toHaveBeenCalled();
  });

  it('refuses a loom-sc- name first bound by another principal, before binding, with no row', async () => {
    bindings.mockResolvedValue(BOUND_BY_OTHER);
    const res = await CREATE(postReq({
      lakehouseId: 'bronze', name: 'p', kind: 'files', targetType: 's3', targetUri: 's3://b/k',
      credentialRef: { kind: 'awsKeys', keyVaultSecret: 'loom-sc-4f2a9c1e' },
    }));
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('shortcut_secret_not_owned');
    expect(bindExternalSource).not.toHaveBeenCalled();
    expect(createShortcut).not.toHaveBeenCalled();
    expect(vault).not.toHaveBeenCalled();
  });

  it('SAS path: resolves the caller\'s own unbound loom-sc- name and creates the row', async () => {
    const res = await CREATE(postReq(sasBody('loom-sc-mine')));
    expect(res.status).toBe(200);
    expect(vault).toHaveBeenCalledWith('loom-sc-mine');
    expect(createShortcut).toHaveBeenCalledWith(expect.objectContaining({ createdBy: 'me@contoso.com' }));
  });

  it('external path: passes the caller as the credential owner to bindExternalSource', async () => {
    (bindExternalSource as any).mockResolvedValue({ readUri: 's3://b/k' });
    const res = await CREATE(postReq({
      lakehouseId: 'bronze', name: 'p', kind: 'files', targetType: 's3', targetUri: 's3://b/k',
      credentialRef: { kind: 'awsKeys', keyVaultSecret: 'loom-sc-mine' },
    }));
    expect(res.status).toBe(200);
    expect(bindExternalSource).toHaveBeenCalledWith(
      expect.objectContaining({ owner: { kind: 'principal', upn: 'me@contoso.com' } }),
    );
  });
});

describe('POST /api/lakehouse/shortcuts/test — credential policy', () => {
  const row = (secret: string, createdBy: string) => ({
    id: 'bronze:files::ext', lakehouseId: 'bronze', name: 'ext', kind: 'files', targetType: 'adls',
    targetUri: 'abfss://data@partner.dfs.core.windows.net/exports',
    credentialRef: { kind: 'sas', keyVaultSecret: secret }, createdBy,
  });

  it('refuses a row whose platform credential name fails the policy, with no vault read', async () => {
    (getShortcut as any).mockResolvedValue(row('session-secret', 'me@contoso.com'));
    const res = await TEST(postReq({ lakehouseId: 'bronze', id: 'bronze:files::ext' }));
    expect(res.status).toBe(403);
    expect(vault).not.toHaveBeenCalled();
    expect(updateShortcutStatus).toHaveBeenCalledWith('bronze', 'bronze:files::ext', 'error', expect.any(String));
  });

  it('refuses a row whose creator is not the credential\'s first binder, with no vault read', async () => {
    bindings.mockResolvedValue(BOUND_BY_OTHER);
    (getShortcut as any).mockResolvedValue(row('loom-sc-4f2a9c1e', 'me@contoso.com'));
    const res = await TEST(postReq({ lakehouseId: 'bronze', id: 'bronze:files::ext' }));
    expect(res.status).toBe(403);
    expect(vault).not.toHaveBeenCalled();
  });

  it('resolves the row creator\'s own credential even when another user presses Test', async () => {
    // Session is me@; the row and the first binding belong to other@.
    bindings.mockResolvedValue(BOUND_BY_OTHER);
    (getShortcut as any).mockResolvedValue(row('loom-sc-4f2a9c1e', 'other@contoso.com'));
    const res = await TEST(postReq({ lakehouseId: 'bronze', id: 'bronze:files::ext' }));
    expect(res.status).toBe(200);
    expect(vault).toHaveBeenCalledWith('loom-sc-4f2a9c1e');
  });
});
