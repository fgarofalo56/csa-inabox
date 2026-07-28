/**
 * Contract test for POST /api/embed/query (N18): embed-token auth (no session),
 * RLS-from-identity threaded into the ONE governed execute path, FLAG0-gated.
 * The N15 run path is stubbed to capture what the route hands it.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

vi.mock('@/lib/admin/runtime-flags', () => ({ runtimeFlag: vi.fn() }));
vi.mock('@/lib/metrics/run', () => ({ runGovernedMetricQuery: vi.fn() }));

import { POST } from '../route';
import { runtimeFlag } from '@/lib/admin/runtime-flags';
import { runGovernedMetricQuery } from '@/lib/metrics/run';
import { mintEmbedToken } from '@/lib/embed/embed-token';

function reqWith(headers: Record<string, string>, body: unknown) {
  return {
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
    json: async () => body,
  } as never;
}

const OWNER = { oid: 'owner-1', tid: 'tenant-1' };
const runMock = runGovernedMetricQuery as unknown as ReturnType<typeof vi.fn>;

beforeAll(() => {
  process.env.SESSION_SECRET = 'test-session-secret-for-embed-tokens';
});

beforeEach(() => {
  vi.clearAllMocks();
  (runtimeFlag as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(true);
  runMock.mockResolvedValue({
    ok: true,
    result: { metric: 'net_revenue', engine: 'synapse', dialect: 'synapse', sql: 'SELECT …', columns: ['net_revenue'], rows: [{ net_revenue: 4200 }], rowCount: 1, executionMs: 5, groupBy: [], cached: false },
  });
});

function tokenFor(rls: Record<string, unknown>, sub = 'viewer@acme.com') {
  return mintEmbedToken({ reportId: 'rep-1', owner: OWNER, identity: { sub, rls: rls as never } }).token;
}

describe('POST /api/embed/query', () => {
  it('authenticates the embed token and threads its RLS claims as filters', async () => {
    const token = tokenFor({ region: 'West' });
    const res = await POST(reqWith({ 'x-loom-embed-token': token }, { metric: 'net_revenue', dimensions: ['region'] }));
    expect(res.status).toBe(200);

    expect(runMock).toHaveBeenCalledTimes(1);
    const [actor, request] = runMock.mock.calls[0];
    // Governed spec resolves under the OWNER; audit provenance is the embed identity.
    expect(actor).toMatchObject({ oid: 'owner-1', tenantId: 'tenant-1', who: 'embed:viewer@acme.com' });
    // The identity's RLS claim is injected as a bound filter predicate.
    expect(request.rls).toEqual([{ dimension: 'region', op: '=', value: 'West' }]);
    expect(request.dimensions).toEqual(['region']);
  });

  it('SAME report, two identities → different RLS predicates handed to the engine', async () => {
    await POST(reqWith({ 'x-loom-embed-token': tokenFor({ region: 'West' }, 'a') }, { metric: 'net_revenue' }));
    await POST(reqWith({ 'x-loom-embed-token': tokenFor({ region: 'East' }, 'b') }, { metric: 'net_revenue' }));
    expect(runMock.mock.calls[0][1].rls).toEqual([{ dimension: 'region', op: '=', value: 'West' }]);
    expect(runMock.mock.calls[1][1].rls).toEqual([{ dimension: 'region', op: '=', value: 'East' }]);
  });

  it('accepts the token via Authorization: Bearer as well', async () => {
    const res = await POST(reqWith({ authorization: `Bearer ${tokenFor({})}` }, { metric: 'net_revenue' }));
    expect(res.status).toBe(200);
    expect(runMock.mock.calls[0][1].rls).toEqual([]);
  });

  it('401 for a missing / invalid / expired token (never executes)', async () => {
    const res = await POST(reqWith({}, { metric: 'net_revenue' }));
    expect(res.status).toBe(401);
    const json = (await res.json()) as { code: string };
    expect(json.code).toBe('embed_unauthorized');
    expect(runMock).not.toHaveBeenCalled();
  });

  it('403-class 503 guided gate when the FLAG0 kill-switch is OFF', async () => {
    (runtimeFlag as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(false);
    const res = await POST(reqWith({ 'x-loom-embed-token': tokenFor({}) }, { metric: 'net_revenue' }));
    expect(res.status).toBe(503);
    expect(runMock).not.toHaveBeenCalled();
  });

  it('400 without a metric', async () => {
    const res = await POST(reqWith({ 'x-loom-embed-token': tokenFor({}) }, {}));
    expect(res.status).toBe(400);
  });

  it('surfaces an honest gate from the run path (e.g. no governed spec)', async () => {
    runMock.mockResolvedValue({ ok: false, status: 412, code: 'no_metrics_spec', error: 'No governed metrics…' });
    const res = await POST(reqWith({ 'x-loom-embed-token': tokenFor({}) }, { metric: 'net_revenue' }));
    expect(res.status).toBe(412);
    const json = (await res.json()) as { code: string };
    expect(json.code).toBe('no_metrics_spec');
  });
});
