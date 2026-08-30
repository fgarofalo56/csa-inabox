/**
 * #3750 — THE UNITY ROW MUST CARRY THE FIELD NAMES THE GENERIC READER KEYS ON.
 *
 * `recordUnityAccess` wrote the verb as `operation` and the securable as
 * `securableFqn`. `/api/admin/audit-logs` queries, filters and dedupes on `kind`
 * and `key`, and `AuditPanel` renders exactly those two. On a live tenant where
 * Unity traffic was 100% of what the Audit tab showed, every Kind badge was an
 * EMPTY outline pill and every Key cell a "—", and the Event-kind dropdown could
 * never offer a Unity value because `kinds` is built with `.filter(Boolean)`.
 *
 * Two halves, both tested here:
 *
 *   WRITE  the choke point stamps `kind` and `key` alongside `operation` and
 *          `securableFqn`, so the SERVER-SIDE `c.kind = @kind` filter works for
 *          every row written from now on.
 *   READ   the route repairs rows ALREADY in Cosmos, which cannot be rewritten
 *          — as a FALLBACK that never overrides a real `kind`.
 *
 * The read half's control is the one that matters: a normalizer that overwrote
 * `kind` unconditionally would satisfy the positive assertion and corrupt every
 * non-Unity row, so there is an explicit case for that.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const auditCreate = vi.fn();
const emitAuditEvent = vi.fn();
const cosmosQuery = vi.fn();

vi.mock('@azure/identity', () => {
  class FakeCred {
    async getToken() { return { token: 'fake-aad-token', expiresOnTimestamp: Date.now() + 3_600_000 }; }
  }
  return { DefaultAzureCredential: FakeCred, ManagedIdentityCredential: FakeCred, ChainedTokenCredential: FakeCred };
});
vi.mock('@/lib/azure/arm-credential', () => ({ uamiArmCredential: () => ({ getToken: vi.fn() }) }));
vi.mock('@/lib/azure/cosmos-client', () => ({
  auditLogContainer: async () => ({
    items: {
      create: auditCreate,
      query: (spec: unknown) => ({ fetchAll: async () => cosmosQuery(spec) }),
    },
  }),
  metastoreRegistrationsContainer: async () => ({
    items: { query: () => ({ fetchAll: async () => ({ resources: [] }) }) },
  }),
}));
vi.mock('@/lib/admin/audit-stream', () => ({ emitAuditEvent }));
vi.mock('@/lib/auth/session', () => ({
  getSession: () => ({
    claims: { oid: 'oid-alice', upn: 'alice@contoso.com', tid: 'tenant-1', name: 'Alice' },
    exp: Math.floor(Date.now() / 1000) + 3600,
  }),
}));

import { flushUnityAudit, UNITY_SECURABLE_ALL } from '../unity-audit';
import { listCatalogs } from '../unity-catalog-client';

const ENV = ['LOOM_UC_BACKEND', 'LOOM_UNITY_URL', 'LOOM_UNITY_AUTH_MODE'];

function response(status: number, body: unknown = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    text: async () => JSON.stringify(body),
    json: async () => body,
  } as unknown as Response;
}

beforeEach(() => {
  for (const k of ENV) delete process.env[k];
  auditCreate.mockReset();
  emitAuditEvent.mockReset();
  cosmosQuery.mockReset();
  auditCreate.mockResolvedValue({});
  cosmosQuery.mockResolvedValue({ resources: [] });
  process.env.LOOM_UNITY_AUTH_MODE = 'anonymous';
});

afterEach(() => {
  for (const k of ENV) delete process.env[k];
  vi.unstubAllGlobals();
});

describe('#3750 WRITE — the Cosmos row carries kind + key', () => {
  it('a catalog read stamps kind = operation and key = securableFqn', async () => {
    process.env.LOOM_UC_BACKEND = 'oss';
    process.env.LOOM_UNITY_URL = 'https://loom-unity.internal';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(200, { catalogs: [] })));

    await listCatalogs('ignored-host');
    await flushUnityAudit();

    expect(auditCreate).toHaveBeenCalledTimes(1);
    const row = auditCreate.mock.calls[0][0] as Record<string, unknown>;

    // The generic reader's names.
    expect(row.kind).toBe('catalog.list');
    expect(row.key).toBe(UNITY_SECURABLE_ALL);
    // The Unity-native names are NOT dropped — the SIEM/KQL views read them.
    expect(row.operation).toBe('catalog.list');
    expect(row.securableFqn).toBe(UNITY_SECURABLE_ALL);
    // A badge renders `kind`; an empty string is what produced the blank pill.
    expect(String(row.kind).length).toBeGreaterThan(0);
  });
});

// The READ half — the route's fallback for rows already in Cosmos — is covered
// against the ROUTE'S OWN exported normalizer in
// app/api/admin/audit-logs/__tests__/kind-key-3750.test.ts. It lives there
// rather than here so it asserts on the real function and not on a copy of it.
