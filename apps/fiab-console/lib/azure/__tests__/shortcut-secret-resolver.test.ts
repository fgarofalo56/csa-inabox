/**
 * shortcut-secret-resolver — name grammar, purpose policy and ownership all run
 * BEFORE the value is read, and only then does the resolver delegate.
 *
 * Mocked: the value reads (`getKeyVaultSecret`, `getShortcutSecretValue`), the
 * mint-record read (`getShortcutSecretOwnerRecord`), the registry lookup
 * (`listShortcutSecretBindings`) and the Unity Catalog provider list. Real: the
 * grammar, the purpose policy, `sanitizeSecretName`, the earliest-binder rule
 * and lib/azure/share-provider-access.ts.
 *
 * WHAT BREAKS EACH LOAD-BEARING ASSERTION (assertion-design.md):
 *   - grammar cases: deleting the grammar check. Every fixture starts with
 *     `loom-sc-`, so the policy alone passes it and the mint-record mock is
 *     reached (`ownerRecord` called) — the "no call" assertions go red.
 *   - platform names: deleting the policy call. The mint-record mock says the
 *     caller saved every name, so ownership alone would ACCEPT and the value
 *     mock is reached.
 *   - mint record, other principal: skipping the ownership check.
 *   - mint record, other lakehouse: dropping the lakehouse comparison.
 *   - legacy unbound: treating "no row binds it" as allowed (the round-1 rule).
 *   - earliest binder / missing createdAt: `rows[0]`, or sorting '' first.
 *   - data-share provider: authorising `loom-dsp-` by first binder or not at
 *     all — the fixture has NO registry rows and NO mint record, so only the
 *     provider list can make it resolve, and an unregistered provider must not.
 *   - item: prefix comparison instead of the exact minted name.
 *   - vault option: delegating to the default read for the browse tree.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../shortcut-credentials', () => ({
  getKeyVaultSecret: vi.fn(),
  keyVaultConfigGate: vi.fn(() => null),
}));
vi.mock('../kv-secrets-client', () => ({
  getShortcutSecretOwnerRecord: vi.fn(),
  getShortcutSecretValue: vi.fn(),
}));
vi.mock('../lakehouse-shortcuts', () => ({
  listShortcutSecretBindings: vi.fn(),
}));
vi.mock('../unity-catalog-client', () => ({
  resolveWorkspaceHostnames: vi.fn(),
  listProviders: vi.fn(),
}));

import { getKeyVaultSecret } from '../shortcut-credentials';
import { getShortcutSecretOwnerRecord, getShortcutSecretValue } from '../kv-secrets-client';
import { listShortcutSecretBindings } from '../lakehouse-shortcuts';
import { resolveWorkspaceHostnames, listProviders } from '../unity-catalog-client';
import { KeyVaultSecretPolicyError } from '../kv-secret-purpose';
import {
  resolveShortcutSecret,
  assertShortcutSecretUsable,
  ShortcutSecretOwnershipError,
  ShortcutSecretNameError,
  isShortcutSecretRefusal,
  itemSecretName,
  firstBinding,
  type ShortcutSecretOwner,
} from '../shortcut-secret-resolver';

const vault = getKeyVaultSecret as unknown as ReturnType<typeof vi.fn>;
const shortcutVault = getShortcutSecretValue as unknown as ReturnType<typeof vi.fn>;
const ownerRecord = getShortcutSecretOwnerRecord as unknown as ReturnType<typeof vi.fn>;
const bindings = listShortcutSecretBindings as unknown as ReturnType<typeof vi.fn>;
const hosts = resolveWorkspaceHostnames as unknown as ReturnType<typeof vi.fn>;
const providers = listProviders as unknown as ReturnType<typeof vi.fn>;

const ME: ShortcutSecretOwner = { kind: 'principal', via: 'request', oid: 'oid-me', upn: 'me@contoso.com', lakehouseId: 'lh-1' };
const ROW: ShortcutSecretOwner = { kind: 'principal', via: 'row', oid: 'oid-me', upn: 'me@contoso.com', lakehouseId: 'lh-1' };
const MINE = { exists: true, owner: { oid: 'oid-me', upn: 'me@contoso.com', lakehouseId: 'lh-1' } };

const noCalls = () => {
  expect(vault).not.toHaveBeenCalled();
  expect(shortcutVault).not.toHaveBeenCalled();
};

beforeEach(() => {
  vi.clearAllMocks();
  vault.mockResolvedValue('resolved-value');
  shortcutVault.mockResolvedValue('resolved-from-shortcut-vault');
  ownerRecord.mockResolvedValue(MINE);
  bindings.mockResolvedValue([]);
  hosts.mockResolvedValue(['adb-1.azuredatabricks.net']);
  providers.mockResolvedValue([{ name: 'acme_corp' }]);
});

describe('name grammar runs first — exact, never trimmed', () => {
  const BAD = [
    'loom-sc-x/y', 'loom-sc-x?y', 'loom-sc-x#y', 'loom-sc-x%2Fy', 'loom-sc-..', 'loom-sc-x\u0000',
    'loom-sc-café', ' loom-sc-x', 'loom-sc-x ', 'loom-sc-x\t', '', `loom-sc-${'a'.repeat(120)}`,
  ];
  it.each(BAD.map((b) => [JSON.stringify(b), b]))('refuses %s with no call of any kind', async (_label, bad) => {
    const err = await resolveShortcutSecret(bad, ME).catch((e) => e);
    expect(err).toBeInstanceOf(ShortcutSecretNameError);
    expect(err.status).toBe(400);
    expect(isShortcutSecretRefusal(err)).toBe(true);
    expect(ownerRecord).not.toHaveBeenCalled();
    expect(bindings).not.toHaveBeenCalled();
    noCalls();
  });

  it('refuses a non-string name', async () => {
    await expect(resolveShortcutSecret(123 as unknown as string, ME)).rejects.toBeInstanceOf(ShortcutSecretNameError);
    await expect(resolveShortcutSecret(undefined as unknown as string, ME)).rejects.toBeInstanceOf(ShortcutSecretNameError);
    noCalls();
  });

  it('accepts a 127-character name (the grammar\'s upper bound) and delegates it unchanged', async () => {
    const max = `loom-sc-${'a'.repeat(119)}`;
    expect(max.length).toBe(127);
    await expect(resolveShortcutSecret(max, ME)).resolves.toBe('resolved-value');
    expect(vault).toHaveBeenCalledWith(max);
  });
});

describe('purpose policy runs before ownership', () => {
  it.each(['loom-msal-client-secret', 'session-secret', 'loom-internal-token', 'loom-conn-abc', 'some-operator-secret'])(
    'refuses %s with no metadata or value read, naming only the prefix that passes',
    async (name) => {
      const err = await resolveShortcutSecret(name, ME).catch((e) => e);
      expect(err).toBeInstanceOf(KeyVaultSecretPolicyError);
      expect(err.message).toContain('loom-sc-');
      expect(err.message).not.toContain('loom-shortcut-');
      expect(err.message).toContain('Save to Key Vault in the shortcut wizard');
      expect(ownerRecord).not.toHaveBeenCalled();
      noCalls();
    },
  );
});

describe('loom-sc- — the mint record decides', () => {
  it('resolves the caller\'s own credential, delegating the exact name', async () => {
    await expect(resolveShortcutSecret('loom-sc-s3-lh-1-p-a1b2c3', ME)).resolves.toBe('resolved-value');
    expect(ownerRecord).toHaveBeenCalledWith('loom-sc-s3-lh-1-p-a1b2c3');
    expect(vault).toHaveBeenCalledWith('loom-sc-s3-lh-1-p-a1b2c3');
    // The record decides; the registry is not consulted for a recorded name.
    expect(bindings).not.toHaveBeenCalled();
  });

  it('refuses a credential another principal saved, without reading it', async () => {
    ownerRecord.mockResolvedValue({ exists: true, owner: { oid: 'oid-bob', upn: 'bob@contoso.com', lakehouseId: 'lh-1' } });
    const err = await resolveShortcutSecret('loom-sc-bobs', ME).catch((e) => e);
    expect(err).toBeInstanceOf(ShortcutSecretOwnershipError);
    expect(err.message).toMatch(/saved by another user/);
    expect(err.message).toContain('Save to Key Vault in the shortcut wizard');
    noCalls();
  });

  it('compares oid when both sides carry one — a matching UPN does not override a different oid', async () => {
    ownerRecord.mockResolvedValue({ exists: true, owner: { oid: 'oid-bob', upn: 'me@contoso.com' } });
    await expect(resolveShortcutSecret('loom-sc-x', ME)).rejects.toBeInstanceOf(ShortcutSecretOwnershipError);
    noCalls();
  });

  it('falls back to UPN when the caller has no oid (a stored row created before oids were recorded)', async () => {
    await expect(resolveShortcutSecret('loom-sc-x', { kind: 'principal', via: 'row', upn: 'ME@contoso.com', lakehouseId: 'lh-1' }))
      .resolves.toBe('resolved-value');
  });

  it('refuses a credential saved for a different lakehouse', async () => {
    const err = await resolveShortcutSecret('loom-sc-x', { ...ME, lakehouseId: 'lh-2' } as ShortcutSecretOwner).catch((e) => e);
    expect(err).toBeInstanceOf(ShortcutSecretOwnershipError);
    expect(err.message).toMatch(/different lakehouse/);
    noCalls();
  });

  it('skips the lakehouse comparison when the caller names none (the browse tree)', async () => {
    await expect(resolveShortcutSecret('loom-sc-x', { kind: 'principal', via: 'request', oid: 'oid-me' })).resolves.toBe('resolved-value');
  });

  it('refuses a name that does not exist', async () => {
    ownerRecord.mockResolvedValue({ exists: false, owner: null });
    await expect(resolveShortcutSecret('loom-sc-gone', ME)).rejects.toThrow(/was not found/);
    noCalls();
  });

  it('Test-path wording: names the shortcut owner and a real action, never "sign in again"', async () => {
    ownerRecord.mockResolvedValue({ exists: true, owner: { oid: 'oid-bob' } });
    const err = await resolveShortcutSecret('loom-sc-x', ROW).catch((e) => e);
    expect(err.message).toMatch(/^Test uses the credential of the shortcut's owner\./);
    expect(err.message).toContain('Delete the shortcut and re-create it');
    expect(err.message).not.toMatch(/sign in again/i);
  });

  it('unknown principal: "sign in again" on a request, not on a stored row', async () => {
    const onRequest = await resolveShortcutSecret('loom-sc-x', { kind: 'principal', via: 'request' }).catch((e) => e);
    expect(onRequest.message).toMatch(/Sign in again/);
    const onRow = await resolveShortcutSecret('loom-sc-x', { kind: 'principal', via: 'row' }).catch((e) => e);
    expect(onRow).toBeInstanceOf(ShortcutSecretOwnershipError);
    expect(onRow.message).not.toMatch(/sign in again/i);
    expect(onRow.message).toMatch(/no recorded owner/);
    expect(ownerRecord).not.toHaveBeenCalled();
    noCalls();
  });
});

describe('loom-sc- with no mint record — the earliest-binder fallback', () => {
  beforeEach(() => ownerRecord.mockResolvedValue({ exists: true, owner: null }));

  it('refuses a legacy name that no row binds', async () => {
    const err = await resolveShortcutSecret('loom-sc-legacy', ME).catch((e) => e);
    expect(err).toBeInstanceOf(ShortcutSecretOwnershipError);
    expect(err.message).toMatch(/no recorded owner/);
    expect(bindings).toHaveBeenCalledWith('loom-sc-legacy');
    noCalls();
  });

  it('the EARLIEST binding records the owner, whatever order the registry returns', async () => {
    bindings.mockResolvedValue([
      { lakehouseId: 'silver', id: 'b', createdBy: 'other@contoso.com', createdAt: '2026-09-20T00:00:00Z' },
      { lakehouseId: 'bronze', id: 'a', createdBy: 'ME@contoso.com', createdAt: '2026-09-01T00:00:00Z' },
    ]);
    await expect(resolveShortcutSecret('loom-sc-legacy', ME)).resolves.toBe('resolved-value');
    await expect(resolveShortcutSecret('loom-sc-legacy', { kind: 'principal', via: 'request', upn: 'other@contoso.com' }))
      .rejects.toBeInstanceOf(ShortcutSecretOwnershipError);
  });

  it('a row with no createdAt sorts LAST, so it cannot claim to be first', async () => {
    const rows = [
      { lakehouseId: 'x', id: 'a', createdBy: 'other@contoso.com', createdAt: '' },
      { lakehouseId: 'y', id: 'b', createdBy: 'me@contoso.com', createdAt: '2026-01-01T00:00:00Z' },
    ];
    expect(firstBinding(rows)?.createdBy).toBe('me@contoso.com');
    bindings.mockResolvedValue(rows);
    await expect(resolveShortcutSecret('loom-sc-legacy', ME)).resolves.toBe('resolved-value');
  });

  it('compares createdByOid when the row carries one', async () => {
    bindings.mockResolvedValue([{ lakehouseId: 'x', id: 'a', createdBy: 'me@contoso.com', createdByOid: 'oid-bob', createdAt: '2026-01-01T00:00:00Z' }]);
    await expect(resolveShortcutSecret('loom-sc-legacy', ME)).rejects.toBeInstanceOf(ShortcutSecretOwnershipError);
  });
});

describe('loom-dsp- — authorised by data share provider', () => {
  it('resolves the stored credential of a registered provider (name mapped the way the providers route stores it)', async () => {
    // 'acme_corp' is stored as loom-dsp-acme-corp (sanitizeSecretName).
    await expect(resolveShortcutSecret('loom-dsp-acme-corp', ME)).resolves.toBe('resolved-value');
    expect(vault).toHaveBeenCalledWith('loom-dsp-acme-corp');
    // Not a mint-record or first-binder decision.
    expect(ownerRecord).not.toHaveBeenCalled();
    expect(bindings).not.toHaveBeenCalled();
  });

  it('refuses a provider that is not registered, without reading it', async () => {
    const err = await resolveShortcutSecret('loom-dsp-someone-else', ME).catch((e) => e);
    expect(err).toBeInstanceOf(ShortcutSecretOwnershipError);
    expect(err.message).toMatch(/Data shares → Add provider/);
    noCalls();
  });

  it('refuses when no Databricks workspace is bound', async () => {
    hosts.mockRejectedValue(new Error('not configured'));
    await expect(resolveShortcutSecret('loom-dsp-acme-corp', ME)).rejects.toBeInstanceOf(ShortcutSecretOwnershipError);
    noCalls();
  });
});

describe('item owners (lakehouse-shortcut item route)', () => {
  it('resolves exactly the name the item route mints for this item', async () => {
    expect(itemSecretName('item-1')).toBe('loom-shortcut-item-1');
    await expect(resolveShortcutSecret('loom-shortcut-item-1', { kind: 'item', itemId: 'item-1' })).resolves.toBe('resolved-value');
    expect(vault).toHaveBeenCalledWith('loom-shortcut-item-1');
  });

  it('refuses another item\'s credential (same prefix) and any loom-sc- name', async () => {
    for (const n of ['loom-shortcut-item-2', 'loom-shortcut-item-10', 'loom-sc-4f2a9c1e']) {
      await expect(resolveShortcutSecret(n, { kind: 'item', itemId: 'item-1' })).rejects.toBeInstanceOf(ShortcutSecretOwnershipError);
    }
    noCalls();
  });

  it('the registry path refuses item-minted names', async () => {
    await expect(resolveShortcutSecret('loom-shortcut-item-1', ME)).rejects.toBeInstanceOf(ShortcutSecretOwnershipError);
    noCalls();
  });
});

describe('vault selection and the no-read check', () => {
  it('{ vault: "shortcut" } reads the shortcut vault, not the default read', async () => {
    await expect(resolveShortcutSecret('loom-sc-x', ME, { vault: 'shortcut' })).resolves.toBe('resolved-from-shortcut-vault');
    expect(shortcutVault).toHaveBeenCalledWith('loom-sc-x', 'shortcut-credential');
    expect(vault).not.toHaveBeenCalled();
  });

  it('assertShortcutSecretUsable applies every check and never reads a value', async () => {
    await expect(assertShortcutSecretUsable('loom-sc-a/b', ME)).rejects.toBeInstanceOf(ShortcutSecretNameError);
    await expect(assertShortcutSecretUsable('loom-msal-client-secret', ME)).rejects.toBeInstanceOf(KeyVaultSecretPolicyError);
    ownerRecord.mockResolvedValue({ exists: true, owner: { oid: 'oid-bob' } });
    await expect(assertShortcutSecretUsable('loom-sc-x', ME)).rejects.toBeInstanceOf(ShortcutSecretOwnershipError);
    ownerRecord.mockResolvedValue(MINE);
    await expect(assertShortcutSecretUsable('loom-sc-x', ME)).resolves.toBeUndefined();
    noCalls();
  });
});
