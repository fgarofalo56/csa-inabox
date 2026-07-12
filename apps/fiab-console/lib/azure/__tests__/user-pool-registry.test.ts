/**
 * user-pool-registry (EH-P1-OBO #1800) — behavioral tests for the kind→store
 * resolution, the MSAL silent-acquire refresh, and the route-facing branch
 * decision (resolveUserRead): service default, cache hit, miss→refresh→write-
 * back, and the honest no-consent 403 gate (never a silent downgrade).
 *
 * All sibling stores + MSAL are mocked; the registry logic under test is real.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  sqlCached: null as string | null,
  storageCached: null as string | null,
  kustoCached: null as string | null,
  armCached: null as string | null,
  pbiCached: null as string | null,
  accounts: [] as Array<{ homeAccountId: string; localAccountId?: string }>,
  silentResult: null as { accessToken: string; expiresOn: Date | null } | null,
  silentError: null as Error | null,
  silentCalls: [] as Array<{ scopes: string[] }>,
  saves: [] as Array<{ store: string; args: unknown[] }>,
}));

vi.mock('@/lib/azure/sql-user-token-store', () => ({
  getUserSqlToken: vi.fn(async () => h.sqlCached),
  saveUserSqlToken: vi.fn(async (...args: unknown[]) => {
    h.saves.push({ store: 'sql', args });
    return true;
  }),
}));
vi.mock('@/lib/azure/storage-user-token-store', () => ({
  storageOboScope: () => 'https://storage.azure.com/.default',
  getUserStorageToken: vi.fn(async () => h.storageCached),
  saveUserStorageToken: vi.fn(async (...args: unknown[]) => {
    h.saves.push({ store: 'storage', args });
    return true;
  }),
}));
vi.mock('@/lib/azure/kusto-user-token-store', () => ({
  kustoOboScope: (uri: string) => `${uri.replace(/\/+$/, '')}/.default`,
  getUserKustoToken: vi.fn(async () => h.kustoCached),
  saveUserKustoToken: vi.fn(async (...args: unknown[]) => {
    h.saves.push({ store: 'kusto', args });
    return true;
  }),
}));
vi.mock('@/lib/azure/user-token-store', () => ({
  getUserArmToken: vi.fn(async () => h.armCached),
  saveUserToken: vi.fn(async (...args: unknown[]) => {
    h.saves.push({ store: 'arm', args });
    return true;
  }),
}));
vi.mock('@/lib/azure/pbi-user-token-store', () => ({
  getPbiUserToken: vi.fn(async () => h.pbiCached),
  savePbiUserToken: vi.fn(async (...args: unknown[]) => {
    h.saves.push({ store: 'pbi', args });
    return true;
  }),
}));
vi.mock('@/lib/azure/cloud-endpoints', () => ({
  getSqlSuffix: () => 'database.windows.net',
  armBase: () => 'https://management.azure.com',
  getPbiScope: () => 'https://analysis.windows.net/powerbi/api/.default',
}));
vi.mock('@/lib/auth/msal', () => ({
  getMsalClient: () => ({
    getTokenCache: () => ({ getAllAccounts: async () => h.accounts }),
    acquireTokenSilent: async (req: { scopes: string[] }) => {
      h.silentCalls.push({ scopes: req.scopes });
      if (h.silentError) throw h.silentError;
      return h.silentResult;
    },
  }),
}));

import {
  getUserDataPlaneToken,
  resolveUserRead,
  userTokenGateBody,
  userTokenRemediation,
  USER_TOKEN_GATE_CODE,
} from '@/lib/azure/user-pool-registry';

const OID = '33333333-3333-3333-3333-333333333333';
const CLUSTER = 'https://loomadx.centralus.kusto.windows.net';

beforeEach(() => {
  h.sqlCached = h.storageCached = h.kustoCached = h.armCached = h.pbiCached = null;
  h.accounts = [{ homeAccountId: `${OID}.tenant`, localAccountId: OID }];
  h.silentResult = null;
  h.silentError = null;
  h.silentCalls = [];
  h.saves = [];
});

describe('resolveUserRead — the route branch decision', () => {
  it("'service' mode short-circuits: no store, no MSAL, byte-identical default", async () => {
    const r = await resolveUserRead('service', 'sql', { oid: OID });
    expect(r).toEqual({ mode: 'service' });
    expect(h.silentCalls).toHaveLength(0);
    expect(h.saves).toHaveLength(0);
  });

  it("'user' mode + cached token → user execution with that token", async () => {
    h.sqlCached = 'cached-sql-token';
    const r = await resolveUserRead('user', 'sql', { oid: OID });
    expect(r).toEqual({ mode: 'user', token: 'cached-sql-token' });
    expect(h.silentCalls).toHaveLength(0); // hit — no refresh needed
  });

  it("'user' mode + cache miss → MSAL silent refresh, write-back, user execution", async () => {
    h.silentResult = { accessToken: 'minted-storage-token', expiresOn: new Date(Date.now() + 3600_000) };
    const r = await resolveUserRead('user', 'storage', { oid: OID });
    expect(r).toEqual({ mode: 'user', token: 'minted-storage-token' });
    // Refreshed against the Azure Storage OBO scope + persisted back.
    expect(h.silentCalls).toEqual([{ scopes: ['https://storage.azure.com/.default'] }]);
    expect(h.saves).toEqual([
      { store: 'storage', args: [OID, 'minted-storage-token', expect.any(Date)] },
    ]);
  });

  it("'user' mode + no MSAL account (cold/evicted) → honest 403 gate, NO downgrade", async () => {
    h.accounts = [];
    const r = await resolveUserRead('user', 'storage', { oid: OID });
    expect(r.mode).toBe('gate');
    if (r.mode === 'gate') {
      expect(r.status).toBe(403);
      expect(r.body.ok).toBe(false);
      expect(r.body.code).toBe('NO_USER_STORAGE_TOKEN');
      // Names the exact missing delegated consent (oboRemediation style).
      expect(r.body.error).toMatch(/delegated permission/i);
      expect(r.body.error).toMatch(/storage\.azure\.com/);
    }
  });

  it("'user' mode + consent failure on silent acquire → honest 403 gate", async () => {
    h.silentError = Object.assign(new Error('AADSTS65001: consent required'), {
      errorCode: 'consent_required',
    });
    const r = await resolveUserRead('user', 'sql', { oid: OID });
    expect(r.mode).toBe('gate');
    if (r.mode === 'gate') expect(r.body.code).toBe('NO_USER_SQL_TOKEN');
  });

  it('kusto requires a clusterUri: absent → gate; present → per-cluster scope', async () => {
    const noCluster = await resolveUserRead('user', 'kusto', { oid: OID });
    expect(noCluster.mode).toBe('gate');

    h.silentResult = { accessToken: 'minted-kusto-token', expiresOn: null };
    const withCluster = await resolveUserRead('user', 'kusto', { oid: OID, clusterUri: CLUSTER });
    expect(withCluster).toEqual({ mode: 'user', token: 'minted-kusto-token' });
    expect(h.silentCalls.at(-1)).toEqual({ scopes: [`${CLUSTER}/.default`] });
    expect(h.saves.at(-1)).toEqual({
      store: 'kusto',
      args: [OID, CLUSTER, 'minted-kusto-token', null],
    });
  });
});

describe('getUserDataPlaneToken — kind → store resolution', () => {
  it('routes each kind to its own store', async () => {
    h.sqlCached = 't-sql';
    h.storageCached = 't-storage';
    h.kustoCached = 't-kusto';
    h.armCached = 't-arm';
    h.pbiCached = 't-pbi';
    expect(await getUserDataPlaneToken('sql', { oid: OID })).toBe('t-sql');
    expect(await getUserDataPlaneToken('storage', { oid: OID })).toBe('t-storage');
    expect(await getUserDataPlaneToken('kusto', { oid: OID, clusterUri: CLUSTER })).toBe('t-kusto');
    expect(await getUserDataPlaneToken('arm', { oid: OID })).toBe('t-arm');
    expect(await getUserDataPlaneToken('powerbi', { oid: OID })).toBe('t-pbi');
  });

  it('returns null without an oid (background/non-request context)', async () => {
    expect(await getUserDataPlaneToken('sql', { oid: '' })).toBeNull();
  });

  it('SQL refresh honors LOOM_SYNAPSE_SQL_TOKEN_SCOPE + the F10 gate code stays stable', async () => {
    const prev = process.env.LOOM_SYNAPSE_SQL_TOKEN_SCOPE;
    process.env.LOOM_SYNAPSE_SQL_TOKEN_SCOPE = 'database.usgovcloudapi.net';
    try {
      h.silentResult = { accessToken: 'gov-sql', expiresOn: null };
      expect(await getUserDataPlaneToken('sql', { oid: OID })).toBe('gov-sql');
      expect(h.silentCalls.at(-1)).toEqual({
        scopes: ['https://database.usgovcloudapi.net/user_impersonation'],
      });
    } finally {
      if (prev === undefined) delete process.env.LOOM_SYNAPSE_SQL_TOKEN_SCOPE;
      else process.env.LOOM_SYNAPSE_SQL_TOKEN_SCOPE = prev;
    }
    // The shipped F10 routes already surface NO_USER_SQL_TOKEN — must not drift.
    expect(USER_TOKEN_GATE_CODE.sql).toBe('NO_USER_SQL_TOKEN');
  });
});

describe('honest gate copy', () => {
  it('every kind has a code + remediation naming the missing delegated consent', () => {
    for (const kind of ['sql', 'storage', 'kusto', 'arm', 'powerbi'] as const) {
      const body = userTokenGateBody(kind);
      expect(body.ok).toBe(false);
      expect(body.code).toBe(USER_TOKEN_GATE_CODE[kind]);
      expect(body.error).toBe(userTokenRemediation(kind));
      expect(body.error).toMatch(/sign out and sign back in/i);
      expect(body.error).toMatch(/admin/i);
    }
  });
});
