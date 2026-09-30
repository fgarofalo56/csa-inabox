/**
 * shortcut-secret-resolver — the purpose policy and the ownership check both run
 * BEFORE the vault read, and only then does the resolver delegate.
 *
 * The vault read (`getKeyVaultSecret`) and the registry lookup
 * (`listShortcutSecretBindings`) are mocked; everything else is real — the
 * purpose policy, `sanitizeSecretName`, and the earliest-binder rule.
 *
 * WHAT BREAKS EACH LOAD-BEARING ASSERTION (assertion-design.md):
 *   - "platform secret refused, no vault call": deleting the
 *     `assertSecretReadAllowed` call. The registry mock returns [] so the
 *     ownership check alone would ACCEPT `loom-msal-client-secret` for a
 *     principal, the vault mock would be called, and both the rejection type
 *     and `not.toHaveBeenCalled()` go red.
 *   - "bound by another principal, no vault call": deleting the
 *     `assertShortcutSecretOwned` call — the name passes the policy
 *     (`loom-sc-` prefix), so the vault mock is reached.
 *   - "earliest binder wins": taking `rows[0]` instead of the earliest row.
 *     The fixture lists the LATER row first, with a different owner.
 *   - "item reads only its own name": comparing a prefix instead of the exact
 *     minted name — `loom-shortcut-item-2` shares the prefix with item-1's.
 *   - "owned name resolves": a resolver that refuses everything (or never
 *     delegates) — the value and the exact delegated name are pinned.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../shortcut-credentials', () => ({
  getKeyVaultSecret: vi.fn(),
  keyVaultConfigGate: vi.fn(() => null),
}));
vi.mock('../lakehouse-shortcuts', () => ({
  listShortcutSecretBindings: vi.fn(),
}));

import { getKeyVaultSecret } from '../shortcut-credentials';
import { listShortcutSecretBindings } from '../lakehouse-shortcuts';
import { KeyVaultSecretPolicyError } from '../kv-secret-purpose';
import {
  resolveShortcutSecret,
  assertShortcutSecretUsable,
  ShortcutSecretOwnershipError,
  isShortcutSecretRefusal,
  itemSecretName,
} from '../shortcut-secret-resolver';

const vault = getKeyVaultSecret as unknown as ReturnType<typeof vi.fn>;
const bindings = listShortcutSecretBindings as unknown as ReturnType<typeof vi.fn>;

const ME = { kind: 'principal' as const, upn: 'me@contoso.com' };

beforeEach(() => {
  vi.clearAllMocks();
  vault.mockResolvedValue('resolved-value');
  bindings.mockResolvedValue([]);
});

describe('purpose policy runs before any vault call', () => {
  it.each(['loom-msal-client-secret', 'session-secret', 'loom-internal-token', 'loom-conn-abc', 'some-operator-secret'])(
    'refuses %s for a principal and never reads the vault',
    async (name) => {
      await expect(resolveShortcutSecret(name, ME)).rejects.toBeInstanceOf(KeyVaultSecretPolicyError);
      expect(vault).not.toHaveBeenCalled();
      // The policy runs before ownership, so the registry is not consulted either.
      expect(bindings).not.toHaveBeenCalled();
    },
  );

  it('refuses a platform secret for an item owner too, with no vault call', async () => {
    await expect(resolveShortcutSecret('loom-msal-client-secret', { kind: 'item', itemId: 'item-1' }))
      .rejects.toBeInstanceOf(KeyVaultSecretPolicyError);
    expect(vault).not.toHaveBeenCalled();
  });
});

describe('ownership — principal (lakehouse shortcut registry)', () => {
  it('refuses a loom-sc- name first bound by another principal, with no vault call', async () => {
    bindings.mockResolvedValue([
      { lakehouseId: 'bronze', id: 'bronze:files::theirs', createdBy: 'other@contoso.com', createdAt: '2026-09-01T00:00:00Z' },
    ]);
    const err = await resolveShortcutSecret('loom-sc-4f2a9c1e', ME).catch((e) => e);
    expect(err).toBeInstanceOf(ShortcutSecretOwnershipError);
    expect(err.status).toBe(403);
    expect(isShortcutSecretRefusal(err)).toBe(true);
    expect(vault).not.toHaveBeenCalled();
    // Lookup is by the lower-cased name (Key Vault names are case-insensitive).
    expect(bindings).toHaveBeenCalledWith('loom-sc-4f2a9c1e');
  });

  it('the EARLIEST binding records the owner, whatever order the registry returns', async () => {
    // Later row first, different owner — a rows[0] implementation picks "other".
    bindings.mockResolvedValue([
      { lakehouseId: 'silver', id: 'b', createdBy: 'other@contoso.com', createdAt: '2026-09-20T00:00:00Z' },
      { lakehouseId: 'bronze', id: 'a', createdBy: 'ME@contoso.com', createdAt: '2026-09-01T00:00:00Z' },
    ]);
    await expect(resolveShortcutSecret('loom-sc-4f2a9c1e', ME)).resolves.toBe('resolved-value');
    await expect(resolveShortcutSecret('loom-sc-4f2a9c1e', { kind: 'principal', upn: 'other@contoso.com' }))
      .rejects.toBeInstanceOf(ShortcutSecretOwnershipError);
  });

  it('resolves a loom-sc- name the caller first bound, delegating the exact name', async () => {
    bindings.mockResolvedValue([
      { lakehouseId: 'bronze', id: 'a', createdBy: 'me@contoso.com', createdAt: '2026-09-01T00:00:00Z' },
    ]);
    await expect(resolveShortcutSecret('loom-sc-4f2a9c1e', ME)).resolves.toBe('resolved-value');
    expect(vault).toHaveBeenCalledTimes(1);
    expect(vault).toHaveBeenCalledWith('loom-sc-4f2a9c1e');
  });

  it('resolves a loom-sc- name no row has bound yet (the caller\'s row will record them)', async () => {
    await expect(resolveShortcutSecret('loom-sc-fresh', ME)).resolves.toBe('resolved-value');
    expect(vault).toHaveBeenCalledWith('loom-sc-fresh');
  });

  it('refuses a loom-shortcut- (item-minted) name on the registry path, with no vault call', async () => {
    await expect(resolveShortcutSecret('loom-shortcut-item-1', ME)).rejects.toBeInstanceOf(ShortcutSecretOwnershipError);
    expect(vault).not.toHaveBeenCalled();
    expect(bindings).not.toHaveBeenCalled();
  });

  it('refuses when the principal is unknown, even for an unbound name', async () => {
    await expect(resolveShortcutSecret('loom-sc-fresh', { kind: 'principal', upn: '' }))
      .rejects.toBeInstanceOf(ShortcutSecretOwnershipError);
    await expect(resolveShortcutSecret('loom-sc-fresh', { kind: 'principal', upn: undefined }))
      .rejects.toBeInstanceOf(ShortcutSecretOwnershipError);
    expect(vault).not.toHaveBeenCalled();
  });
});

describe('ownership — item (lakehouse-shortcut item route)', () => {
  it('resolves exactly the name the item route mints for this item', async () => {
    expect(itemSecretName('item-1')).toBe('loom-shortcut-item-1');
    await expect(resolveShortcutSecret('loom-shortcut-item-1', { kind: 'item', itemId: 'item-1' }))
      .resolves.toBe('resolved-value');
    expect(vault).toHaveBeenCalledWith('loom-shortcut-item-1');
    // The item path never consults the registry — its owner is in the name.
    expect(bindings).not.toHaveBeenCalled();
  });

  it('refuses another item\'s credential (same prefix, different id), with no vault call', async () => {
    await expect(resolveShortcutSecret('loom-shortcut-item-2', { kind: 'item', itemId: 'item-1' }))
      .rejects.toBeInstanceOf(ShortcutSecretOwnershipError);
    await expect(resolveShortcutSecret('loom-shortcut-item-10', { kind: 'item', itemId: 'item-1' }))
      .rejects.toBeInstanceOf(ShortcutSecretOwnershipError);
    await expect(resolveShortcutSecret('loom-sc-4f2a9c1e', { kind: 'item', itemId: 'item-1' }))
      .rejects.toBeInstanceOf(ShortcutSecretOwnershipError);
    expect(vault).not.toHaveBeenCalled();
  });

  it('refuses when no item id is supplied', async () => {
    await expect(resolveShortcutSecret('loom-shortcut-', { kind: 'item', itemId: '' }))
      .rejects.toBeInstanceOf(ShortcutSecretOwnershipError);
    expect(vault).not.toHaveBeenCalled();
  });
});

describe('assertShortcutSecretUsable — the check a registry write runs', () => {
  it('applies policy and ownership and never reads the vault', async () => {
    bindings.mockResolvedValue([
      { lakehouseId: 'bronze', id: 'a', createdBy: 'other@contoso.com', createdAt: '2026-09-01T00:00:00Z' },
    ]);
    await expect(assertShortcutSecretUsable('loom-msal-client-secret', ME)).rejects.toBeInstanceOf(KeyVaultSecretPolicyError);
    await expect(assertShortcutSecretUsable('loom-sc-4f2a9c1e', ME)).rejects.toBeInstanceOf(ShortcutSecretOwnershipError);
    bindings.mockResolvedValue([]);
    await expect(assertShortcutSecretUsable('loom-sc-4f2a9c1e', ME)).resolves.toBeUndefined();
    expect(vault).not.toHaveBeenCalled();
  });
});
