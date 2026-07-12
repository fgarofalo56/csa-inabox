/**
 * kusto-user-token-store (EH-P1-OBO #1800) — behavioral tests.
 *
 * Same mocked-Cosmos harness as the storage store's spec, plus the Kusto
 * specifics: PER-CLUSTER keying (two clusters never share a token) and the
 * sovereign-safe per-cluster `.default` scope derivation.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  docs: new Map<string, any>(),
  failWrites: false,
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
      read: async () => ({ resource: h.docs.get(id) }),
    }),
  }),
}));

vi.mock('@/lib/auth/session', () => ({
  encryptAtRest: (s: string) => `enc:${s}`,
  decryptAtRest: (s: string) => s.replace(/^enc:/, ''),
}));

import {
  saveUserKustoToken,
  getUserKustoToken,
  kustoOboScope,
  kustoClusterKey,
} from '@/lib/azure/kusto-user-token-store';

const OID = '22222222-2222-2222-2222-222222222222';
const COMMERCIAL = 'https://loomadx.centralus.kusto.windows.net';
const GOV = 'https://loomadx.usgovvirginia.kusto.usgovcloudapi.net';

beforeEach(() => {
  h.docs.clear();
  h.failWrites = false;
});

describe('kusto-user-token-store', () => {
  it('derives the per-cluster .default scope (sovereign suffix rides the URI)', () => {
    expect(kustoOboScope(COMMERCIAL)).toBe(`${COMMERCIAL}/.default`);
    expect(kustoOboScope(`${GOV}/`)).toBe(`${GOV}/.default`);
  });

  it('normalizes cluster URIs to stable doc-id-safe keys', () => {
    expect(kustoClusterKey(COMMERCIAL)).toBe('loomadx_centralus_kusto_windows_net');
    expect(kustoClusterKey(`${COMMERCIAL}/`)).toBe(kustoClusterKey(COMMERCIAL));
    expect(kustoClusterKey('HTTPS://LoomADX.centralus.kusto.windows.net')).toBe(
      kustoClusterKey(COMMERCIAL),
    );
  });

  it('round-trips per (cluster, oid) — clusters never share a token', async () => {
    const exp = Date.now() + 60 * 60 * 1000;
    expect(await saveUserKustoToken(OID, COMMERCIAL, 'tok-comm', exp)).toBe(true);
    expect(await saveUserKustoToken(OID, GOV, 'tok-gov', exp)).toBe(true);
    expect(await getUserKustoToken(OID, COMMERCIAL)).toBe('tok-comm');
    expect(await getUserKustoToken(OID, GOV)).toBe('tok-gov');
    // Encrypted at rest, kind-tagged, partitioned by oid.
    const doc = h.docs.get(`kustousertoken:${kustoClusterKey(GOV)}:${OID}`);
    expect(doc.enc).toBe('enc:tok-gov');
    expect(doc.kind).toBe('kustousertoken');
    expect(doc.tenantId).toBe(OID);
  });

  it('expiry + 60s safety margin → null (forces the registry refresh)', async () => {
    await saveUserKustoToken(OID, COMMERCIAL, 'tok-soon', Date.now() + 30_000);
    expect(await getUserKustoToken(OID, COMMERCIAL)).toBeNull();
    await saveUserKustoToken(OID, COMMERCIAL, 'tok-fresh', Date.now() + 5 * 60_000);
    expect(await getUserKustoToken(OID, COMMERCIAL)).toBe('tok-fresh');
  });

  it('best-effort write + strict inputs (no oid / cluster / token → false/null)', async () => {
    h.failWrites = true;
    expect(await saveUserKustoToken(OID, COMMERCIAL, 'tok', null)).toBe(false);
    h.failWrites = false;
    expect(await saveUserKustoToken('', COMMERCIAL, 'tok', null)).toBe(false);
    expect(await saveUserKustoToken(OID, '', 'tok', null)).toBe(false);
    expect(await saveUserKustoToken(OID, COMMERCIAL, '', null)).toBe(false);
    expect(await getUserKustoToken('', COMMERCIAL)).toBeNull();
    expect(await getUserKustoToken(OID, '')).toBeNull();
  });
});
