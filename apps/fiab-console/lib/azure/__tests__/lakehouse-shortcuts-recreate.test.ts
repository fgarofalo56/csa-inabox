/**
 * The shortcut registry as the RECORD of who a row's credential belongs to:
 * re-creating a row with a different credential makes the caller its creator,
 * and every stored `statusDetail` is redacted.
 *
 * The REAL lakehouse-shortcuts module and the REAL shortcut-secret resolver run
 * over an in-memory stand-in for the Cosmos container (point read, upsert, and
 * the one cross-partition query `listShortcutSecretBindings` issues, evaluated
 * with the same predicate). The vault reads and the mint-record read are mocked.
 *
 * WHAT BREAKS EACH LOAD-BEARING ASSERTION:
 *   - "re-create with a different credential makes the caller the creator":
 *     the pre-change upsert (`createdBy: existing?.createdBy ?? def.createdBy`,
 *     `createdAt: existing?.createdAt ?? now`). For the LEGACY (no mint record)
 *     fixture that keeps Alice — with her EARLIER createdAt — as the creator of
 *     a row now binding Bob's credential, so the earliest-binder rule hands Bob's
 *     credential to Alice and the "Alice is refused" assertion goes red.
 *   - "same credential keeps the creator": resetting on every re-create.
 *   - "statusDetail is redacted": storing `def.statusDetail` verbatim — the
 *     fixture's sentinel sits in a `sig=` query parameter of a URL.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

type Doc = Record<string, any>;
const store = new Map<string, Doc>();
const key = (pk: string, id: string) => `${pk}\u0000${id}`;

const fakeContainer = {
  item: (id: string, pk: string) => ({
    read: async () => {
      const d = store.get(key(pk, id));
      if (!d) throw Object.assign(new Error('not found'), { code: 404 });
      return { resource: structuredClone(d) };
    },
  }),
  items: {
    upsert: async (doc: Doc) => {
      store.set(key(doc.lakehouseId, doc.id), structuredClone(doc));
      return { resource: structuredClone(doc) };
    },
    query: (spec: { query: string; parameters: { name: string; value: string }[] }) => ({
      fetchAll: async () => {
        // Only the bindings query is issued in these tests; evaluate its predicate.
        expect(spec.query).toContain('LOWER(TRIM(c.credentialRef.keyVaultSecret)) = @n');
        const n = spec.parameters.find((p) => p.name === '@n')!.value;
        const resources = [...store.values()]
          .filter((d) => typeof d.credentialRef?.keyVaultSecret === 'string'
            && d.credentialRef.keyVaultSecret.trim().toLowerCase() === n)
          .map((d) => ({ lakehouseId: d.lakehouseId, id: d.id, createdBy: d.createdBy, createdByOid: d.createdByOid, createdAt: d.createdAt }));
        return { resources };
      },
    }),
  },
};

vi.mock('../cosmos-client', () => ({ lakehouseShortcutsContainer: async () => fakeContainer }));
vi.mock('../shortcut-credentials', () => ({ getKeyVaultSecret: vi.fn(async () => 'value'), keyVaultConfigGate: vi.fn(() => null) }));
vi.mock('../kv-secrets-client', () => ({
  getShortcutSecretOwnerRecord: vi.fn(async () => ({ exists: true, owner: null })),
  getShortcutSecretValue: vi.fn(),
}));

import { createShortcut, updateShortcutStatus, getShortcut, shortcutId } from '../lakehouse-shortcuts';
import { resolveShortcutSecret, ShortcutSecretOwnershipError } from '../shortcut-secret-resolver';
import { getShortcutSecretOwnerRecord } from '../kv-secrets-client';

const ownerRecord = getShortcutSecretOwnerRecord as unknown as ReturnType<typeof vi.fn>;
const ALICE = { kind: 'principal' as const, via: 'request' as const, oid: 'oid-alice', upn: 'alice@contoso.com', lakehouseId: 'lh' };
const BOB = { kind: 'principal' as const, via: 'request' as const, oid: 'oid-bob', upn: 'bob@contoso.com', lakehouseId: 'lh' };

const base = { lakehouseId: 'lh', name: 'partner', kind: 'files' as const, targetType: 's3' as const, targetUri: 's3://b/k' };
const ID = shortcutId('lh', 'files', '', 'partner');

beforeEach(() => {
  store.clear();
  vi.useRealTimers();
  ownerRecord.mockResolvedValue({ exists: true, owner: null }); // legacy names: no mint record
});

async function at<T>(iso: string, fn: () => Promise<T>): Promise<T> {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(iso));
  try { return await fn(); } finally { vi.useRealTimers(); }
}

describe('re-create resets the creator when the credential changes', () => {
  it('Bob re-creating Alice\'s row with his credential: the row is Bob\'s, and Alice cannot use Bob\'s credential', async () => {
    // Bob bound loom-sc-b first, in a row of his own.
    await at('2026-02-01T00:00:00Z', () => createShortcut({ ...base, name: 'bobs-own', credentialRef: { kind: 'awsKeys', keyVaultSecret: 'loom-sc-b' }, createdBy: BOB.upn, createdByOid: BOB.oid }));
    // Alice's row, created EARLIER than Bob's binding.
    await at('2026-01-01T00:00:00Z', () => createShortcut({ ...base, credentialRef: { kind: 'awsKeys', keyVaultSecret: 'loom-sc-a' }, createdBy: ALICE.upn, createdByOid: ALICE.oid }));
    // Bob re-creates Alice's id with his credential.
    await at('2026-03-01T00:00:00Z', () => createShortcut({ ...base, credentialRef: { kind: 'awsKeys', keyVaultSecret: 'loom-sc-b' }, createdBy: BOB.upn, createdByOid: BOB.oid }));

    const row = (await getShortcut('lh', ID))!;
    expect(row.createdBy).toBe('bob@contoso.com');
    expect(row.createdByOid).toBe('oid-bob');
    expect(row.createdAt).toBe('2026-03-01T00:00:00.000Z');

    await expect(resolveShortcutSecret('loom-sc-b', ALICE)).rejects.toBeInstanceOf(ShortcutSecretOwnershipError);
    await expect(resolveShortcutSecret('loom-sc-b', BOB)).resolves.toBe('value');
    // Test on the row resolves as its creator — now Bob — and succeeds.
    await expect(resolveShortcutSecret('loom-sc-b', { kind: 'principal', via: 'row', oid: row.createdByOid, upn: row.createdBy, lakehouseId: 'lh' }))
      .resolves.toBe('value');
  });

  it('the reverse: Alice re-creating Bob\'s row with her credential makes it hers, and Bob cannot use Alice\'s', async () => {
    await at('2026-02-01T00:00:00Z', () => createShortcut({ ...base, name: 'alices-own', credentialRef: { kind: 'awsKeys', keyVaultSecret: 'loom-sc-a' }, createdBy: ALICE.upn, createdByOid: ALICE.oid }));
    await at('2026-01-01T00:00:00Z', () => createShortcut({ ...base, credentialRef: { kind: 'awsKeys', keyVaultSecret: 'loom-sc-b' }, createdBy: BOB.upn, createdByOid: BOB.oid }));
    await at('2026-03-01T00:00:00Z', () => createShortcut({ ...base, credentialRef: { kind: 'awsKeys', keyVaultSecret: 'loom-sc-a' }, createdBy: ALICE.upn, createdByOid: ALICE.oid }));

    const row = (await getShortcut('lh', ID))!;
    expect(row.createdBy).toBe('alice@contoso.com');
    await expect(resolveShortcutSecret('loom-sc-a', BOB)).rejects.toBeInstanceOf(ShortcutSecretOwnershipError);
    await expect(resolveShortcutSecret('loom-sc-a', ALICE)).resolves.toBe('value');
  });

  it('a re-create that keeps the same credential keeps the original creator', async () => {
    await at('2026-01-01T00:00:00Z', () => createShortcut({ ...base, credentialRef: { kind: 'awsKeys', keyVaultSecret: 'loom-sc-a' }, createdBy: ALICE.upn, createdByOid: ALICE.oid }));
    await at('2026-03-01T00:00:00Z', () => createShortcut({ ...base, credentialRef: { kind: 'awsKeys', keyVaultSecret: 'loom-sc-a' }, status: 'error', statusDetail: 'x', createdBy: BOB.upn, createdByOid: BOB.oid }));
    const row = (await getShortcut('lh', ID))!;
    expect(row.createdBy).toBe('alice@contoso.com');
    expect(row.createdAt).toBe('2026-01-01T00:00:00.000Z');
  });
});

describe('statusDetail is redacted before it is stored', () => {
  const SENTINEL = 'Qz7Kx2Vb9Wm4Jt6Ln1Rp8Hc3';
  const detail = `ADLS endpoint unreachable: https://acct.dfs.core.windows.net/fs?resource=filesystem&sv=2024-01-01&sig=${SENTINEL} timed out`;

  it('createShortcut and updateShortcutStatus both store the redacted text', async () => {
    const created = await createShortcut({ ...base, status: 'error', statusDetail: detail, createdBy: ALICE.upn });
    expect(created.statusDetail).not.toContain(SENTINEL);
    expect(created.statusDetail).toContain('https://acct.dfs.core.windows.net/fs');
    expect(created.statusDetail).toContain('timed out');
    const stored = (await getShortcut('lh', ID))!;
    expect(stored.statusDetail).not.toContain(SENTINEL);

    const updated = await updateShortcutStatus('lh', ID, 'error', detail);
    expect(updated!.statusDetail).not.toContain(SENTINEL);
    expect(updated!.statusDetail).toContain('timed out');
    expect((await getShortcut('lh', ID))!.statusDetail).not.toContain(SENTINEL);
  });

  it('a padded stored credential name is still found by the ownership lookup', async () => {
    await createShortcut({ ...base, credentialRef: { kind: 'awsKeys', keyVaultSecret: '  loom-sc-pad ' }, createdBy: ALICE.upn, createdByOid: ALICE.oid });
    await expect(resolveShortcutSecret('loom-sc-pad', ALICE)).resolves.toBe('value');
    await expect(resolveShortcutSecret('loom-sc-pad', BOB)).rejects.toBeInstanceOf(ShortcutSecretOwnershipError);
  });
});
