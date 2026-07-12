/**
 * storage-user-token-store (EH-P1-OBO #1800) — behavioral tests.
 *
 * Cosmos + at-rest crypto are mocked (in-memory doc map / reversible marker),
 * exercising the REAL store logic: round-trip, expiry + safety margin, the
 * best-effort write contract, and the swallow-all read contract. Mirrors the
 * sibling sql/pbi user-token stores' semantics.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  docs: new Map<string, any>(),
  failWrites: false,
  failReads: false,
}));

vi.mock('@/lib/azure/cosmos-client', () => ({
  tenantSettingsContainer: async () => ({
    items: {
      upsert: async (doc: any) => {
        if (h.failWrites) throw new Error('cosmos down');
        h.docs.set(doc.id, doc);
        return { resource: doc };
      },
    },
    item: (id: string) => ({
      read: async () => {
        if (h.failReads) throw new Error('cosmos down');
        return { resource: h.docs.get(id) };
      },
    }),
  }),
}));

vi.mock('@/lib/auth/session', () => ({
  encryptAtRest: (s: string) => `enc:${s}`,
  decryptAtRest: (s: string) => s.replace(/^enc:/, ''),
}));

import {
  saveUserStorageToken,
  getUserStorageToken,
  storageOboScope,
  STORAGE_OBO_RESOURCE,
} from '@/lib/azure/storage-user-token-store';

const OID = '11111111-1111-1111-1111-111111111111';

beforeEach(() => {
  h.docs.clear();
  h.failWrites = false;
  h.failReads = false;
});

describe('storage-user-token-store', () => {
  it('exposes the cloud-invariant Azure Storage OBO scope (.default form)', () => {
    expect(STORAGE_OBO_RESOURCE).toBe('https://storage.azure.com');
    expect(storageOboScope()).toBe('https://storage.azure.com/.default');
  });

  it('round-trips a token (cache hit), encrypted at rest', async () => {
    const exp = new Date(Date.now() + 60 * 60 * 1000);
    expect(await saveUserStorageToken(OID, 'tok-abc', exp)).toBe(true);
    // Encrypted at rest — never the raw token in the doc.
    const doc = h.docs.get(`storageusertoken:${OID}`);
    expect(doc.enc).toBe('enc:tok-abc');
    expect(doc.kind).toBe('storageusertoken');
    expect(doc.tenantId).toBe(OID);
    expect(await getUserStorageToken(OID)).toBe('tok-abc');
  });

  it('cache miss → null (no doc; wrong kind)', async () => {
    expect(await getUserStorageToken(OID)).toBeNull();
    h.docs.set(`storageusertoken:${OID}`, { id: `storageusertoken:${OID}`, kind: 'other' });
    expect(await getUserStorageToken(OID)).toBeNull();
  });

  it('expired token → null; within the 60s safety margin → null (forces refresh)', async () => {
    await saveUserStorageToken(OID, 'tok-old', Date.now() - 1000);
    expect(await getUserStorageToken(OID)).toBeNull();
    await saveUserStorageToken(OID, 'tok-soon', Date.now() + 30_000); // < 60s margin
    expect(await getUserStorageToken(OID)).toBeNull();
    await saveUserStorageToken(OID, 'tok-fresh', Date.now() + 5 * 60_000);
    expect(await getUserStorageToken(OID)).toBe('tok-fresh');
  });

  it('best-effort write: Cosmos failure returns false, never throws', async () => {
    h.failWrites = true;
    await expect(saveUserStorageToken(OID, 'tok', new Date())).resolves.toBe(false);
  });

  it('swallow-all read: Cosmos failure returns null, never throws', async () => {
    h.failReads = true;
    await expect(getUserStorageToken(OID)).resolves.toBeNull();
  });

  it('rejects empty inputs (no oid / no token)', async () => {
    expect(await saveUserStorageToken('', 'tok', null)).toBe(false);
    expect(await saveUserStorageToken(OID, '', null)).toBe(false);
    expect(await getUserStorageToken('')).toBeNull();
  });
});
