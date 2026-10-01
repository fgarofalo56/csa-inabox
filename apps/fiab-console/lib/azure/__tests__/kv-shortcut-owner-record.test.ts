/**
 * The shortcut credential mint record on the wire: `putShortcutSecret` writes
 * the owner as Key Vault tags, and `getShortcutSecretOwnerRecord` reads them
 * back from the versions listing (metadata only — never a value read).
 *
 * WHAT BREAKS EACH LOAD-BEARING ASSERTION:
 *   - tags on PUT: dropping `tags` from the body, or not lower-casing oid/UPN
 *     (the resolver compares lower-cased).
 *   - newest ENABLED version: taking the first listed version — the fixture
 *     lists an older version (Bob) first and a disabled newer one (Eve) too.
 *   - 404 → exists:false: reporting a missing secret as "no record", which the
 *     resolver would then send to the legacy fallback.
 *   - metadata only: requesting `/secrets/<name>?` (the value endpoint).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));
vi.mock('@/lib/azure/fetch-with-timeout', () => ({ fetchWithTimeout: (...a: any[]) => fetchMock(...(a as [])) }));
vi.mock('@azure/identity', () => {
  class Cred { async getToken() { return { token: 'T' }; } }
  return { ChainedTokenCredential: Cred, DefaultAzureCredential: Cred, ManagedIdentityCredential: Cred };
});
vi.mock('@/lib/azure/aca-managed-identity', () => {
  class Cred { async getToken() { return { token: 'T' }; } }
  return { AcaManagedIdentityCredential: Cred };
});

import { putShortcutSecret, getShortcutSecretOwnerRecord, SHORTCUT_OWNER_TAGS } from '../kv-secrets-client';

beforeEach(() => {
  fetchMock.mockReset();
  process.env.LOOM_SHORTCUT_KEYVAULT = 'https://loomkv.vault.azure.net';
});

describe('putShortcutSecret — owner tags', () => {
  it('writes the owner as tags beside the value', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 200 }));
    await putShortcutSecret('loom-sc-x', 'v', { oid: 'OID-A', upn: 'Alice@Contoso.com', tid: 'T1', lakehouseId: 'lh-1' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('https://loomkv.vault.azure.net/secrets/loom-sc-x?api-version=7.4');
    expect(JSON.parse(init.body)).toEqual({
      value: 'v',
      tags: {
        [SHORTCUT_OWNER_TAGS.purpose]: 'shortcut-credential',
        [SHORTCUT_OWNER_TAGS.oid]: 'oid-a',
        [SHORTCUT_OWNER_TAGS.upn]: 'alice@contoso.com',
        [SHORTCUT_OWNER_TAGS.tid]: 't1',
        [SHORTCUT_OWNER_TAGS.lakehouseId]: 'lh-1',
      },
    });
  });
});

describe('getShortcutSecretOwnerRecord', () => {
  const version = (created: number, enabled: boolean, oid?: string) => ({
    id: `v${created}`, attributes: { enabled, created }, tags: oid ? { [SHORTCUT_OWNER_TAGS.oid]: oid, [SHORTCUT_OWNER_TAGS.lakehouseId]: 'lh-1' } : {},
  });

  it('reads the newest ENABLED version\'s owner from the versions listing', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      value: [version(100, true, 'oid-bob'), version(300, false, 'oid-eve'), version(200, true, 'oid-alice')],
    }), { status: 200 }));
    const r = await getShortcutSecretOwnerRecord('loom-sc-x');
    expect(r).toEqual({ exists: true, owner: expect.objectContaining({ oid: 'oid-alice', lakehouseId: 'lh-1' }) });
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toBe('https://loomkv.vault.azure.net/secrets/loom-sc-x/versions?api-version=7.4&maxresults=25');
  });

  it('reports a secret with no owner tags as existing with no record', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ value: [version(1, true)] }), { status: 200 }));
    expect(await getShortcutSecretOwnerRecord('loom-sc-legacy')).toEqual({ exists: true, owner: null });
  });

  it('reports a missing secret as not existing', async () => {
    fetchMock.mockResolvedValue(new Response('{"error":{}}', { status: 404 }));
    expect(await getShortcutSecretOwnerRecord('loom-sc-gone')).toEqual({ exists: false, owner: null });
  });

  it('throws on any other failure rather than reporting "no record"', async () => {
    fetchMock.mockResolvedValue(new Response('denied', { status: 403 }));
    await expect(getShortcutSecretOwnerRecord('loom-sc-x')).rejects.toThrow(/403/);
  });
});
