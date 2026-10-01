/**
 * The Data shares "Shortcut into lakehouse" flow, end to end through
 * POST /api/lakehouse/shortcuts and POST /api/lakehouse/shortcuts/test, with
 * the vault, the registry, the Unity Catalog provider list and the Databricks
 * calls mocked. The REAL route, resolver, share-provider check and engines run.
 *
 * The request body is built by `buildShareShortcutRequest` — the function the
 * dialog (share-explorer.tsx) posts — so this is the body shipped UI sends.
 *
 * WHAT BREAKS EACH LOAD-BEARING ASSERTION:
 *   - "creates the shortcut": the round-1 policy (loom-dsp- outside the
 *     shortcut-credential name-space → 403), or authorising loom-dsp- by mint
 *     record / first binder (no record and no registry rows exist here → 403).
 *   - "provider not registered → 403, no read, no row": authorising any
 *     loom-dsp- name without consulting the provider list.
 *   - "Test on an existing row created by another user": the same two defects,
 *     on the path that refreshes the Delta Sharing token.
 *   - `keyVaultSecret: 'loom-dsp-acme-corp'` for provider `acme_corp`: the
 *     pre-change dialog body (`loom-dsp-acme_corp`), which the name grammar
 *     refuses and which is not the name the providers route stored.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/auth/session', () => ({ getSession: vi.fn() }));
vi.mock('@/lib/azure/adls-client', () => ({ getAccountName: vi.fn(() => 'loomacct'), listPaths: vi.fn(), containerExistsOn: vi.fn() }));
vi.mock('@/lib/azure/lakehouse-shortcuts', () => ({
  listShortcuts: vi.fn(),
  createShortcut: vi.fn(),
  deleteShortcut: vi.fn(),
  getShortcut: vi.fn(),
  updateShortcutStatus: vi.fn(),
  listShortcutSecretBindings: vi.fn(async () => []),
}));
vi.mock('@/lib/azure/shortcut-credentials', () => ({
  getKeyVaultSecret: vi.fn(),
  keyVaultConfigGate: vi.fn(() => null),
  ensureUcAwsStorageCredential: vi.fn(),
  ensureUcGcpStorageCredential: vi.fn(),
  ensureUcExternalLocation: vi.fn(),
  deleteUcExternalLocation: vi.fn(),
  deleteUcStorageCredential: vi.fn(),
}));
vi.mock('@/lib/azure/kv-secrets-client', () => ({
  getShortcutSecretOwnerRecord: vi.fn(),
  getShortcutSecretValue: vi.fn(),
}));
vi.mock('@/lib/azure/unity-catalog-client', () => ({
  resolveWorkspaceHostnames: vi.fn(),
  listProviders: vi.fn(),
}));
vi.mock('@/lib/azure/databricks-client', () => ({
  listWarehouses: vi.fn(async () => [{ id: 'wh1', name: 'wh', state: 'RUNNING' }]),
  executeStatement: vi.fn(async () => ({ columns: [], rows: [], rowCount: 0, executionMs: 1, truncated: false })),
  databricksConfigGate: vi.fn(() => null),
  writeUcVolumesFile: vi.fn(async () => {}),
  deleteUcVolumesFile: vi.fn(async () => {}),
}));
vi.mock('@/lib/azure/synapse-sql-client', () => ({ serverlessTarget: vi.fn(), executeQuery: vi.fn() }));
vi.mock('@/lib/azure/graph-drive-client', () => ({
  headDriveItem: vi.fn(), parseSharepointUri: vi.fn(), graphDriveConfigGate: vi.fn(() => null),
}));

import { POST as CREATE } from '../shortcuts/route';
import { POST as TEST } from '../shortcuts/test/route';
import { buildShareShortcutRequest } from '@/lib/components/marketplace/share-shortcut-request';
import { getSession } from '@/lib/auth/session';
import { createShortcut, getShortcut, updateShortcutStatus } from '@/lib/azure/lakehouse-shortcuts';
import { getKeyVaultSecret } from '@/lib/azure/shortcut-credentials';
import { getShortcutSecretOwnerRecord } from '@/lib/azure/kv-secrets-client';
import { resolveWorkspaceHostnames, listProviders } from '@/lib/azure/unity-catalog-client';
import { writeUcVolumesFile } from '@/lib/azure/databricks-client';

const vault = getKeyVaultSecret as unknown as ReturnType<typeof vi.fn>;
const PROFILE = { shareCredentialsVersion: 1, endpoint: 'https://sharing.example.net/delta-sharing/', bearerToken: 'tok-1', expirationTime: '2027-01-01T00:00:00Z' };

function postReq(body: any) { return { json: async () => body } as any; }
const body = (providerName: string) => buildShareShortcutRequest({
  lakehouseId: 'lh-item-1', name: '', providerName, shareName: 'agency_a', schema: 'analytics', table: 'metrics',
});

let fetchSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.clearAllMocks();
  (getSession as any).mockReturnValue({ claims: { oid: 'oid-me', upn: 'me@contoso.com', tid: 't1' } });
  (resolveWorkspaceHostnames as any).mockResolvedValue(['adb-1.azuredatabricks.net']);
  (listProviders as any).mockResolvedValue([{ name: 'acme_corp' }]);
  vault.mockResolvedValue(JSON.stringify(PROFILE));
  (createShortcut as any).mockImplementation(async (d: any) => ({ ...d, id: 'lh-item-1:tables::metrics' }));
  (updateShortcutStatus as any).mockImplementation(async (_l: string, id: string, status: string) => ({ id, status }));
  fetchSpy?.mockRestore();
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ items: [] }), { status: 200 }) as any);
});

describe('Data shares → Shortcut into lakehouse', () => {
  it('the dialog body names the secret the providers route stored', () => {
    expect(body('acme_corp').credentialRef.keyVaultSecret).toBe('loom-dsp-acme-corp');
  });

  it('creates the Tables shortcut with the provider\'s stored credential', async () => {
    const res = await CREATE(postReq(body('acme_corp')));
    const j = await res.json();
    expect(res.status).toBe(200);
    expect(j.ok).toBe(true);
    expect(vault).toHaveBeenCalledWith('loom-dsp-acme-corp');
    expect(writeUcVolumesFile).toHaveBeenCalled();
    expect(createShortcut).toHaveBeenCalledWith(expect.objectContaining({
      targetType: 'delta_sharing', status: 'active',
      credentialRef: expect.objectContaining({ keyVaultSecret: 'loom-dsp-acme-corp' }),
    }));
    // Authorised by provider — no mint record is read for a loom-dsp- name.
    expect(getShortcutSecretOwnerRecord).not.toHaveBeenCalled();
  });

  it('refuses a provider that is not registered, with no value read and no row', async () => {
    const res = await CREATE(postReq(body('someone_else')));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/Data shares → Add provider/);
    expect(vault).not.toHaveBeenCalled();
    expect(createShortcut).not.toHaveBeenCalled();
  });

  it('Test on an existing data-share row created by another user refreshes it', async () => {
    (getShortcut as any).mockResolvedValue({
      id: 'lh-item-1:tables::metrics', lakehouseId: 'lh-item-1', name: 'metrics', kind: 'tables',
      targetType: 'delta_sharing', targetUri: 'delta-sharing://agency_a/analytics/metrics',
      engine: 'databricks', engineObject: 'loom.x.metrics', status: 'active',
      credentialRef: { kind: 'deltaSharing', keyVaultSecret: 'loom-dsp-acme-corp' },
      createdBy: 'other@contoso.com', createdByOid: 'oid-other',
    });
    const res = await TEST(postReq({ lakehouseId: 'lh-item-1', id: 'lh-item-1:tables::metrics' }));
    expect(res.status).toBe(200);
    expect(vault).toHaveBeenCalledWith('loom-dsp-acme-corp');
    expect(updateShortcutStatus).toHaveBeenCalledWith('lh-item-1', 'lh-item-1:tables::metrics', 'active', undefined);
  });

  it('Test on a data-share row whose provider is gone returns 403 and leaves the row unchanged', async () => {
    (listProviders as any).mockResolvedValue([]);
    (getShortcut as any).mockResolvedValue({
      id: 'r', lakehouseId: 'lh-item-1', name: 'metrics', kind: 'files', targetType: 'delta_sharing',
      targetUri: 'delta-sharing://agency_a/analytics/metrics', status: 'active',
      credentialRef: { kind: 'deltaSharing', keyVaultSecret: 'loom-dsp-acme-corp' }, createdBy: 'me@contoso.com',
    });
    const res = await TEST(postReq({ lakehouseId: 'lh-item-1', id: 'r' }));
    expect(res.status).toBe(403);
    // WHAT BREAKS IT: appending the generic row hint (Save to Key Vault, which
    // Delta Sharing does not have) instead of the re-add advice.
    const err = (await res.json()).error as string;
    expect(err).toContain('Re-add the provider under Data shares → Add provider with the same provider name');
    expect(err).not.toContain('Save to Key Vault');
    expect(vault).not.toHaveBeenCalled();
    expect(updateShortcutStatus).not.toHaveBeenCalled();
  });

  it('Test on a data-share row whose token is rejected says how to renew it under Data shares', async () => {
    // WHAT BREAKS IT: the round-2 text ("Update the Key Vault secret with a
    // fresh credential file"), an action Loom offers nowhere for loom-dsp-.
    fetchSpy.mockResolvedValue(new Response('{}', { status: 401 }) as any);
    (getShortcut as any).mockResolvedValue({
      id: 'r', lakehouseId: 'lh-item-1', name: 'metrics', kind: 'files', targetType: 'delta_sharing',
      targetUri: 'delta-sharing://agency_a/analytics/metrics', status: 'active',
      credentialRef: { kind: 'deltaSharing', keyVaultSecret: 'loom-dsp-acme-corp' }, createdBy: 'me@contoso.com',
    });
    const res = await TEST(postReq({ lakehouseId: 'lh-item-1', id: 'r' }));
    expect(res.status).toBe(502);
    const j = await res.json();
    expect(j.code).toBe('delta_sharing_auth_failure');
    // WHAT BREAKS IT: the round-3 text, which told the user to remove the
    // provider without unmounting first (Remove is refused while catalogs are
    // mounted) and without keeping the provider name (another name saves a
    // credential this row does not bind).
    expect(j.error).toContain('unmount the provider\'s subscribed catalogs (Use / manage → Unmount)');
    expect(j.error).toContain('Remove is refused while they are mounted');
    expect(j.error).toContain('add it again under the SAME provider name with the new file (Add provider)');
    expect(j.error).not.toContain('Update the Key Vault secret');
  });

  it('a typed Delta Sharing credential name is refused with the Data shares path, no read and no row', async () => {
    // WHAT BREAKS IT: the Save to Key Vault hint for a target that has none.
    const b = body('acme_corp');
    const res = await CREATE(postReq({ ...b, credentialRef: { ...b.credentialRef, keyVaultSecret: 'partner-token' } }));
    expect(res.status).toBe(403);
    const err = (await res.json()).error as string;
    expect(err).toContain('not supported yet (#4854)');
    expect(err).toContain('Create lakehouse shortcut');
    expect(err).not.toContain('Save to Key Vault');
    expect(vault).not.toHaveBeenCalled();
    expect(createShortcut).not.toHaveBeenCalled();
  });
});
