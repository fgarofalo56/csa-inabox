/**
 * #3015 — the wizard's scan must run on the SAME scanner as
 * POST /api/deploy/discovery, not a parallel weaker one.
 *
 * Guard-that-callers-exist: these tests mock `lib/deploy/discovery-scanner`
 * and go RED if GET /api/setup/discover-services reverts to its own raw
 * Resource Graph fetch (the mocked module would go uncalled) or resumes
 * counting coverage from matched rows instead of the ledger.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const getSessionMock = vi.fn(
  () => ({ claims: { oid: 'oid-test', upn: 'u@t.com' }, exp: Date.now() / 1000 + 3600 }) as any,
);
vi.mock('@/lib/auth/session', () => ({
  getSession: () => getSessionMock(),
  tenantScopeId: (s: any) => s?.claims?.tid ?? s?.claims?.oid,
}));

vi.mock('@azure/identity', () => {
  class Cred {
    async getToken() {
      return { token: 'tk', expiresOnTimestamp: Date.now() + 3600_000 };
    }
  }
  return { DefaultAzureCredential: Cred, ManagedIdentityCredential: Cred, ChainedTokenCredential: Cred };
});

vi.mock('@/lib/azure/cosmos-client', () => ({
  featurePermissionsContainer: async () => ({
    items: { query: () => ({ fetchAll: async () => ({ resources: [] }) }) },
  }),
}));

const acquireCredentialsMock = vi.fn(async () => ({ userToken: 'user-tk', uamiToken: null }));
const scanMock = vi.fn();
vi.mock('@/lib/deploy/discovery-scanner', () => ({
  acquireCredentials: (...a: unknown[]) => acquireCredentialsMock(...(a as [])),
  scanForAdoptionCandidates: (...a: unknown[]) => scanMock(...(a as [])),
}));

const SUB_A = '11111111-1111-1111-1111-111111111111';
const SUB_B = '22222222-2222-2222-2222-222222222222';

function candidate(serviceKey: string, name: string, sub: string) {
  return {
    serviceKey,
    id: `/subscriptions/${sub}/resourceGroups/rg1/providers/x/${name}`,
    name,
    resourceGroup: 'rg1',
    subscriptionId: sub,
    subscriptionName: 'Sub',
    location: 'eastus2',
    sku: {},
    networkPosture: 'public',
    privateEndpointCount: 0,
    tags: {},
    looksLoomOwned: false,
    credentialTier: 'user',
    discoveredAt: 'now',
  };
}

/** A DiscoveryResult where 12-requested / 2-with-hits would previously read "2 scanned". */
function discoveryResult() {
  const mkLedger = (id: string, status: string, matched: number) => ({
    subscriptionId: id,
    displayName: `Sub ${id.slice(0, 4)}`,
    status,
    credentialTier: 'user',
    matchedResources: matched,
    established: 'test fixture',
  });
  return {
    subscriptions: [
      mkLedger(SUB_A, 'scanned', 1),
      mkLedger(SUB_B, 'scanned', 0), // scanned AND empty — still counts as scanned
      mkLedger('33333333-3333-3333-3333-333333333333', 'no-access', 0),
    ],
    services: [
      {
        serviceKey: 'aisearch',
        label: 'AI Search',
        family: 'ai',
        cls: 'adoptable',
        usedFor: 'x',
        mutations: [],
        candidates: [candidate('aisearch', 'srch1', SUB_A)],
        recommendation: 'adopt',
        recommendationReason: 'one found',
        uncertain: false,
      },
      {
        serviceKey: 'storage-adls',
        label: 'Storage',
        family: 'platform',
        cls: 'adoptable',
        usedFor: 'x',
        mutations: [],
        candidates: [candidate('storage-adls', 'stlake1', SUB_A)],
        recommendation: 'adopt',
        recommendationReason: 'one found',
        uncertain: false,
      },
    ],
    credentialTier: 'user',
    truncatedBy: null,
    scannedAt: 'now',
    summary: 'Read 2 of 3 subscriptions; 1 could not be read.',
  };
}

function req(qs = '') {
  return { nextUrl: { searchParams: new URLSearchParams(qs) } } as any;
}

beforeEach(() => {
  process.env.LOOM_TENANT_ADMIN_OID = 'oid-test';
  getSessionMock.mockReturnValue({ claims: { oid: 'oid-test', upn: 'u@t.com' }, exp: Date.now() / 1000 + 3600 } as any);
  scanMock.mockReset();
  acquireCredentialsMock.mockClear();
});

afterEach(() => {
  delete process.env.LOOM_TENANT_ADMIN_OID;
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('GET /api/setup/discover-services — shared scanner (#3015)', () => {
  it('401 when unauthenticated', async () => {
    getSessionMock.mockReturnValue(null as any);
    const { GET } = await import('@/app/api/setup/discover-services/route');
    const r = await GET(req());
    expect(r.status).toBe(401);
  });

  it('calls the SHARED discovery scanner over everything visible (empty scope)', async () => {
    scanMock.mockResolvedValue({ ok: true, result: discoveryResult() });
    const { GET } = await import('@/app/api/setup/discover-services/route');
    const r = await GET(req('boundary=Commercial'));
    expect(r.status).toBe(200);
    expect(acquireCredentialsMock).toHaveBeenCalledWith('oid-test');
    expect(scanMock).toHaveBeenCalledTimes(1);
    expect(scanMock.mock.calls[0][0]).toEqual({ subscriptions: [] });
  });

  it('maps candidates onto the wizard service rows, including storage-adls → storage', async () => {
    scanMock.mockResolvedValue({ ok: true, result: discoveryResult() });
    const { GET } = await import('@/app/api/setup/discover-services/route');
    const r = await GET(req());
    const j = await r.json();
    const search = j.services.find((s: any) => s.key === 'aisearch');
    expect(search.candidates).toEqual([{ name: 'srch1', rg: 'rg1', sub: SUB_A, region: 'eastus2' }]);
    expect(search.recommendation).toBe('use-existing');
    expect(search.existing[0].resourceGroup).toBe('rg1');
    // The catalog keys storage as 'storage-adls'; the CLI/wizard key is 'storage'.
    const storage = j.services.find((s: any) => s.key === 'storage');
    expect(storage.candidates[0].name).toBe('stlake1');
    // The on/off pseudo-service keeps its row with no candidates.
    const fw = j.services.find((s: any) => s.key === 'firewall');
    expect(fw.candidates).toEqual([]);
    expect(fw.allowExisting).toBe(false);
  });

  it('coverage is counted from the LEDGER, never from matched rows', async () => {
    scanMock.mockResolvedValue({ ok: true, result: discoveryResult() });
    const { GET } = await import('@/app/api/setup/discover-services/route');
    const r = await GET(req());
    const j = await r.json();
    // 2 subscriptions were READ (one of them empty); 1 was no-access. The old
    // subsSeen.size arithmetic would have said 1 (only SUB_A carried a match).
    expect(j.subscriptionsScanned).toBe(2);
    expect(j.ledger).toHaveLength(3);
    expect(j.ledger.find((l: any) => l.status === 'no-access')).toBeTruthy();
    expect(j.coverage).toContain('could not be read');
  });

  it('503 honest gate when the scan could not look — never an empty-estate claim', async () => {
    scanMock.mockResolvedValue({
      ok: false,
      code: 'no_access',
      error: 'Loom could not read any of the subscriptions requested for this scan.',
      established: 'user: could not list subscriptions (403)',
    });
    const { GET } = await import('@/app/api/setup/discover-services/route');
    const r = await GET(req());
    const j = await r.json();
    expect(r.status).toBe(503);
    expect(j.ok).toBe(false);
    expect(j.error).toContain('could not read');
    expect(j.hint).toContain('403');
  });
});
