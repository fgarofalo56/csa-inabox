/**
 * Route contract for /api/admin/api-gateway/environments/**: session + admin
 * gate, `{ ok, data, error }` envelope, and the 409 refusal listing the blocking
 * publications. Ports are the in-memory doubles; no Cosmos.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextResponse } from 'next/server';
import { makeDeps } from '@/lib/api-gateway/environments/__tests__/fixtures';
import type { AppliedPublication } from '@/lib/api-gateway/environments/types';

const state = vi.hoisted(() => ({ session: null as unknown, admin: true, world: null as unknown, findings: undefined as unknown }));

vi.mock('@/lib/auth/session', () => ({
  getSession: () => state.session,
  tenantScopeId: (s: { claims: { tid?: string; oid: string } }) => s.claims.tid || s.claims.oid,
}));
vi.mock('@/lib/auth/feature-gate', () => ({
  // W1-8: routes are withCapability('apiplane-admin'); state.admin models holding it (or being a tenant admin)
  enforceCapability: async () => (state.admin ? null : NextResponse.json({ ok: false, error: 'forbidden' }, { status: 403 })),
  isTenantAdmin: () => state.admin,
}));
vi.mock('@/lib/api-gateway/environments/deps', () => ({
  getEnvironmentDeps: () => (state.world as { deps: unknown }).deps,
  getFindingsSource: () => state.findings,
}));
// The real registration is exercised in findings-wiring.test.ts; here the findings source is `state.findings`.
vi.mock('@/lib/api-gateway/observe/register', () => ({}));

import * as rootRoute from '../route';
import * as keyRoute from '../[key]/route';
import * as matrixRoute from '../matrix/route';
import * as reclassifyRoute from '../reclassify/route';
import * as suggestionsRoute from '../suggestions/route';
import * as findingsRoute from '../findings/route';

// W1-8: the handlers are withCapability-wrapped (req, ctx); these tests drive them loosely, as before.
type Loose = (req?: Request, ctx?: unknown) => Promise<Response>;
const loose = (h: unknown) => h as Loose;
const getRoot = loose(rootRoute.GET), postRoot = loose(rootRoute.POST), putSettings = loose(rootRoute.PUT);
const putKey = loose(keyRoute.PUT), delKey = loose(keyRoute.DELETE);
const getMatrix = loose(matrixRoute.GET), postReclassify = loose(reclassifyRoute.POST);
const getSuggestions = loose(suggestionsRoute.GET), getFindings = loose(findingsRoute.GET);

const PUB: AppliedPublication = { id: 'pub-1', displayName: 'Orders MCP', gatewayId: 'g1', resources: [{ kind: 'mcp', id: 'm1' }] };
const req = (body?: unknown) => new Request('http://x/api', { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) });
const call = async (r: Response | Promise<Response>) => { const res = await r; return { status: res.status, body: await res.json() }; };

beforeEach(async () => {
  state.session = { claims: { oid: 'oid-1', tid: 'tid-1', upn: 'admin@contoso.com' } };
  state.admin = true;
  state.findings = undefined;
  const w = makeDeps({ publications: [PUB] });
  // the in-memory fixtures seed under TENANT 't-1'; the session tenant must match
  state.session = { claims: { oid: 'oid-1', tid: 't-1', upn: 'admin@contoso.com' } };
  await w.classification.seed({ kind: 'gateway', id: 'g1', displayName: 'Gateway One', environmentKey: 'development', armTags: { env: 'dev' } });
  await w.classification.seed({ kind: 'gateway', id: 'g2', displayName: 'Gateway Two', environmentKey: null, armTags: { Environment: 'prod' } });
  await w.classification.seed({ kind: 'mcp', id: 'm1', displayName: 'Orders', environmentKey: 'development' });
  state.world = w;
});

describe('auth gate', () => {
  it('401 without a session and 403 for a non-admin, on every route', async () => {
    const handlers: Array<() => Promise<Response> | Response> = [
      () => getRoot(), () => postRoot(req({ displayName: 'x' })), () => putSettings(req({ requireClassification: true })),
      () => putKey(req({}), { params: { key: 'test' } }), () => delKey(req(), { params: { key: 'test' } }),
      () => getMatrix(), () => postReclassify(req({ changes: [] })), () => getSuggestions(), () => getFindings(),
    ];
    state.session = null;
    for (const h of handlers) expect((await call(h())).status).toBe(401);
    state.session = { claims: { oid: 'o', tid: 't-1' } };
    state.admin = false;
    for (const h of handlers) expect((await call(h())).status).toBe(403);
    // positive control: the same handlers answer for an admin
    state.admin = true;
    expect((await call(getRoot())).status).toBe(200);
  });
});

describe('catalog routes', () => {
  it('GET returns the six seeded environments, usage counts, and the unclassified count in {ok, data}', async () => {
    const { status, body } = await call(getRoot());
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.data.environments.map((e: { key: string }) => e.key)).toEqual(['development', 'test', 'qc', 'staging', 'production', 'sandbox']);
    expect(body.data.usage).toEqual({ development: 2 });
    expect(body.data.unclassified).toBe(1);
    expect(body.data.registryAvailable).toBe(true);
  });

  it('GET on a fresh tenant with no registry shows the catalog with registryAvailable false and no error', async () => {
    state.world = makeDeps({ withRegistry: false });
    const { status, body } = await call(getRoot());
    expect(status).toBe(200);
    expect(body.data).toMatchObject({ registryAvailable: false, unclassified: 0, usage: {} });
    expect(body.error).toBeUndefined();
  });

  it('POST creates, a duplicate is a 400 with {ok:false,error}, PUT settings validates its body', async () => {
    expect((await call(postRoot(req({ displayName: 'Perf' })))).body.ok).toBe(true);
    const dup = await call(postRoot(req({ displayName: 'Perf' })));
    expect(dup.status).toBe(400);
    expect(dup.body).toMatchObject({ ok: false });
    expect(typeof dup.body.error).toBe('string');
    expect((await call(postRoot(req({})))).status).toBe(400);
    expect((await call(putSettings(req({ requireClassification: 'yes' })))).status).toBe(400);
    const on = await call(putSettings(req({ requireClassification: false })));
    expect(on.body.data.settings.requireClassification).toBe(false);
  });

  it('DELETE refuses a built-in and an in-use environment, accepts an unused custom one', async () => {
    await call(postRoot(req({ displayName: 'Perf' })));
    expect((await call(delKey(req(), { params: { key: 'production' } }))).status).toBe(400);
    expect((await call(delKey(req(), { params: { key: 'development' } }))).status).toBe(400);
    expect((await call(delKey(req(), { params: { key: 'perf' } }))).body.ok).toBe(true);
  });

  it('matrix is derived: Production gateway x Unclassified resource is blocked', async () => {
    const { body } = await call(getMatrix());
    const cell = body.data.cells.find((c: { gatewayEnv: string | null; resourceEnv: string | null }) => c.gatewayEnv === 'production' && c.resourceEnv === null);
    expect(cell.verdict.level).toBe('blocked');
    expect(body.data.cells).toHaveLength(49);
  });
});

describe('reclassify route', () => {
  it('409 lists the blocking publication; the same gateway moving with its resource returns 200', async () => {
    const refused = await call(postReclassify(req({ changes: [{ kind: 'gateway', id: 'g1', environmentKey: 'production' }] })));
    expect(refused.status).toBe(409);
    expect(refused.body.ok).toBe(false);
    expect(refused.body.blocking).toEqual([expect.objectContaining({ id: 'pub-1', displayName: 'Orders MCP' })]);
    const moved = await call(postReclassify(req({ changes: [{ kind: 'gateway', id: 'g1', environmentKey: 'production' }, { kind: 'mcp', id: 'm1', environmentKey: 'production' }] })));
    expect(moved.status).toBe(200);
    expect(moved.body.data.changed).toBe(2);
  });

  it('rejects malformed changes with 400', async () => {
    expect((await call(postReclassify(req({})))).status).toBe(400);
    expect((await call(postReclassify(req({ changes: [{ kind: 'bogus', id: 'g1', environmentKey: null }] })))).status).toBe(400);
    expect((await call(postReclassify(req({ changes: [{ kind: 'gateway', id: 'g1' }] })))).status).toBe(400);
    expect((await call(postReclassify(req({ changes: [{ kind: 'gateway', id: 'g1', environmentKey: null }] })))).status).toBe(200);
  });
});

describe('suggestions and findings routes', () => {
  it('suggestions propose only for the UNCLASSIFIED gateway (g2 -> production), not the classified one', async () => {
    const { body } = await call(getSuggestions());
    expect(body.data.suggestions).toEqual([expect.objectContaining({ resourceId: 'g2', environmentKey: 'production', tagValue: 'prod' })]);
  });

  it('findings: unavailable with no source (honest, empty), real when a source is registered', async () => {
    expect((await call(getFindings())).body.data).toEqual({ findings: [], available: false });
    state.findings = {
      gatewayMcpServers: async () => [{ gatewayId: 'g2', serverId: 's1', name: 'tools', url: 'https://mcp.contoso.com/sse' }],
      mcpEndpoints: async () => [{ kind: 'mcp', id: 'm1', displayName: 'Orders', environmentKey: 'production', url: 'https://mcp.contoso.com/sse' }],
    };
    // g2 is unclassified, m1 is the production MCP endpoint in this scenario: unclassified x production = blocked
    const w = state.world as ReturnType<typeof makeDeps>;
    await w.classification.seed({ kind: 'mcp', id: 'm1', displayName: 'Orders', environmentKey: 'production' });
    const { body } = await call(getFindings());
    expect(body.data.available).toBe(true);
    expect(body.data.findings).toHaveLength(1);
    expect(body.data.findings[0]).toMatchObject({ gatewayId: 'g2', severity: 'advisory' });
  });
});
