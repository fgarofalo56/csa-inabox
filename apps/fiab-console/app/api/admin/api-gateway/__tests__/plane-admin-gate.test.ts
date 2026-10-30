/**
 * W1-8 (Q9): every route under app/api/admin/api-gateway/** is gated by the apiplane-admin
 * capability. The routes are DISCOVERED by walking the tree, so a route another lane adds
 * later (e.g. gateways/[id]/sync) is checked without editing this file.
 *
 * Breaking values (each assertion names what turns it red):
 *  - discovery floor: an empty/partial walk (wrong root, renamed dir) yields < the 9 known
 *    route files or misses a named path -> the "positive control" tests fail.
 *  - 403 per method: any exported handler still on the old withTenantAdmin gate lets a
 *    capability-holding group member through but ALSO refuses it, and any route with NO gate
 *    answers non-403 to the stranger session -> status assertion fails.
 *  - group text: dropping withPlaneGroupHint leaves the generic "Ask an existing tenant admin"
 *    remediation, which does not contain the group display name -> toContain fails.
 *  - capability-only 200: a route left on requireTenantAdmin answers 403 to the group member.
 *  - audit field: planeCapabilityUsed returning a constant 'tenant-admin' makes the capability-
 *    only write record 'tenant-admin' -> the 'apiplane-admin' toBe fails; returning a constant
 *    'apiplane-admin' makes the tenant-admin write fail the other toBe.
 */
import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeDeps } from '@/lib/api-gateway/environments/__tests__/fixtures';

const GROUP_ID = 'grp-plane-admins';
const GROUP_NAME = 'Loom API Plane Admins';
const TENANT_ADMIN_OID = 'tenant-admin-oid';

const state = vi.hoisted(() => ({
  session: null as unknown,
  grants: [] as Array<Record<string, unknown>>,
  world: null as unknown,
}));

vi.mock('@/lib/auth/session', async (orig) => ({
  ...(await orig<typeof import('@/lib/auth/session')>()),
  getSession: () => state.session,
}));
vi.mock('@/lib/azure/cosmos-client', async (orig) => ({
  ...(await orig<typeof import('@/lib/azure/cosmos-client')>()),
  featurePermissionsContainer: async () => ({
    items: {
      query: (q: { parameters: Array<{ name: string; value: unknown }> }) => ({
        fetchAll: async () => {
          const p = (n: string) => q.parameters.find((x) => x.name === n)?.value as unknown;
          const caps = p('@caps') as string[] | undefined;
          const principals = p('@principals') as string[] | undefined;
          const cap = p('@cap') as string | undefined;
          const resources = state.grants.filter((g) =>
            cap ? g.capabilityId === cap : caps!.includes(g.capabilityId as string) && principals!.includes(g.principalId as string),
          );
          return { resources };
        },
      }),
    },
  }),
}));
vi.mock('@/lib/api-gateway/environments/deps', async (orig) => ({
  ...(await orig<typeof import('@/lib/api-gateway/environments/deps')>()),
  getEnvironmentDeps: () => (state.world as { deps: unknown }).deps,
  getFindingsSource: () => undefined,
}));
vi.mock('@/lib/api-gateway/registry/deps', async (orig) => ({
  ...(await orig<typeof import('@/lib/api-gateway/registry/deps')>()),
  registryDeps: () => ({}),
}));

const ROOT = path.resolve(__dirname, '..');

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === '__tests__' ? [] : walk(p);
    return e.name === 'route.ts' ? [p] : [];
  });
}
const routeFiles = walk(ROOT).sort();
const rel = (f: string) => path.relative(ROOT, f).split(path.sep).join('/');

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
type Handler = (req: unknown, ctx: unknown) => Promise<Response> | Response;

async function handlersOf(file: string): Promise<Array<{ route: string; method: string; fn: Handler }>> {
  const mod = (await import(/* @vite-ignore */ file)) as Record<string, unknown>;
  return METHODS.filter((m) => typeof mod[m] === 'function').map((m) => ({ route: rel(file), method: m, fn: mod[m] as Handler }));
}

const req = (body?: unknown) =>
  ({ nextUrl: new URL('http://x/'), url: 'http://x/', method: 'POST', json: async () => body ?? {} }) as never;
const ctx = () => ({ params: Promise.resolve({ id: 'x', key: 'x' }) });
const session = (claims: { oid: string; groups: string[] }) => ({ claims: { tid: 't-1', upn: `${claims.oid}@contoso.com`, ...claims } });

const STRANGER = session({ oid: 'stranger-oid', groups: ['grp-unrelated'] });
const CAP_ONLY = session({ oid: 'member-oid', groups: [GROUP_ID] });
const TENANT_ADMIN = session({ oid: TENANT_ADMIN_OID, groups: [] });

beforeEach(() => {
  process.env.LOOM_TENANT_ADMIN_OID = TENANT_ADMIN_OID;
  delete process.env.LOOM_TENANT_ADMIN_GROUP_ID;
  state.grants = [
    { id: 'g1', tenantId: 't-1', capabilityId: 'apiplane-admin', principalId: GROUP_ID, principalType: 'group', principalDisplayName: GROUP_NAME, role: 'Admin' },
  ];
  state.world = makeDeps();
  state.session = STRANGER;
});

describe('route discovery (positive control: an empty glob cannot pass)', () => {
  it('finds at least the nine known route files, including gateways and environments', () => {
    const found = routeFiles.map(rel);
    for (const expected of [
      'gateways/route.ts', 'gateways/[id]/route.ts', 'environments/route.ts', 'environments/[key]/route.ts',
      'environments/matrix/route.ts', 'environments/reclassify/route.ts', 'environments/findings/route.ts',
      'environments/suggestions/route.ts', 'runtime/route.ts',
    ]) expect(found, `route walk missed ${expected}; walked ${found.length} files under ${ROOT}`).toContain(expected);
    expect(found.length).toBeGreaterThanOrEqual(9);
  });

  it('exports at least 13 handlers across them (GET/POST/PUT/DELETE counted per route)', async () => {
    const all = (await Promise.all(routeFiles.map(handlersOf))).flat();
    expect(all.length).toBeGreaterThanOrEqual(13);
    // a route file that exports no handler would pass the per-method loop vacuously
    for (const f of routeFiles) expect((await handlersOf(f)).length, `${rel(f)} exports no handler`).toBeGreaterThan(0);
  });
});

describe('every plane admin route refuses a session holding neither tenant admin nor the capability', () => {
  it('401 with no session, 403 naming the group to join with a stranger, on every exported method', async () => {
    const all = (await Promise.all(routeFiles.map(handlersOf))).flat();
    for (const h of all) {
      state.session = null;
      expect((await h.fn(req(), ctx())).status, `${h.method} ${h.route} without a session`).toBe(401);

      state.session = STRANGER;
      const res = await h.fn(req(), ctx());
      expect(res.status, `${h.method} ${h.route} for a session with neither tenant admin nor apiplane-admin`).toBe(403);
      const body = await res.json();
      expect(body.capability, `${h.method} ${h.route}`).toBe('apiplane-admin');
      expect(body.remediation, `${h.method} ${h.route} must name the group to join`).toContain(GROUP_NAME);
      expect(body.groups, `${h.method} ${h.route}`).toEqual([{ id: GROUP_ID, displayName: GROUP_NAME }]);
    }
  }, 60_000);

  it('when NO group holds the capability the 403 says so and points at /admin/permissions', async () => {
    state.grants = [];
    const { GET } = await import('../runtime/route');
    const res = await (GET as Handler)(req(), ctx());
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.remediation).toContain('No Entra group holds the apiplane-admin capability');
    expect(body.remediation).toContain('/admin/permissions');
    expect(body.remediation).not.toContain(GROUP_NAME);
  });
});

describe('capability holders and tenant admins pass', () => {
  it('a session holding ONLY the capability gets 200 on read routes, with the holder group in Runtime', async () => {
    state.session = CAP_ONLY;
    const { GET: runtimeGet } = await import('../runtime/route');
    const runtime = await (runtimeGet as Handler)(req(), ctx());
    expect(runtime.status).toBe(200);
    const body = await runtime.json();
    expect(body.data.groups).toEqual([{ id: GROUP_ID, displayName: GROUP_NAME, role: 'Admin' }]);
    expect(body.data.capabilityUsed).toBe('apiplane-admin');
    expect(body.data.remediation).toBeNull();

    const { GET: matrixGet } = await import('../environments/matrix/route');
    const matrix = await (matrixGet as Handler)(req(), ctx());
    expect(matrix.status).toBe(200);
    expect((await matrix.json()).data.cells).toHaveLength(49);
  });

  it('Runtime reports the remediation when no group holds the capability (tenant admin can still read it)', async () => {
    state.grants = [];
    state.session = TENANT_ADMIN;
    const { GET } = await import('../runtime/route');
    const body = await (await (GET as Handler)(req(), ctx())).json();
    expect(body.data.groups).toEqual([]);
    expect(body.data.remediation).toContain('No Entra group holds the apiplane-admin capability');
    expect(body.data.capabilityUsed).toBe('tenant-admin');
  });

  it('a write by the capability-only session is audited with capability "apiplane-admin"', async () => {
    state.session = CAP_ONLY;
    const { POST } = await import('../environments/route');
    const res = await (POST as Handler)(req({ displayName: 'Perf' }), ctx());
    expect(res.status).toBe(200);
    const audit = (state.world as ReturnType<typeof makeDeps>).audit;
    expect(audit).toHaveLength(1);
    expect(audit[0].capability).toBe('apiplane-admin');
    expect(audit[0].actorOid).toBe('member-oid');
  });

  it('a tenant admin WITHOUT the capability still gets 200 (superset) and the audit says "tenant-admin"', async () => {
    state.grants = [];
    state.session = TENANT_ADMIN;
    const { POST } = await import('../environments/route');
    const res = await (POST as Handler)(req({ displayName: 'Perf' }), ctx());
    expect(res.status).toBe(200);
    const audit = (state.world as ReturnType<typeof makeDeps>).audit;
    expect(audit).toHaveLength(1);
    expect(audit[0].capability).toBe('tenant-admin');
  });

  it('the registry actor (gateway writes) carries the same capability value', async () => {
    const { actorFromSession } = await import('@/lib/api-gateway/registry/actor');
    expect(actorFromSession(CAP_ONLY as never).capability).toBe('apiplane-admin');
    expect(actorFromSession(TENANT_ADMIN as never).capability).toBe('tenant-admin');
  });
});
