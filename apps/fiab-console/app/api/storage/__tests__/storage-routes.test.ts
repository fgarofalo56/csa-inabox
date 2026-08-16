/**
 * /api/storage/[account]/containers  and  .../[container]/paths
 *
 * These two routes exist because ADLS browsing was HALF built: `listPaths` has
 * taken an optional `account` since the shortcut work, but nothing enumerated
 * an arbitrary account's containers, and /api/lakehouse/paths rejects any
 * container outside the four DLZ ones. A user picking a location outside the
 * DLZ therefore had to type an `abfss://` URI.
 *
 * What is pinned here: the caller is AUTHORIZED and not merely authenticated
 * (both routes shipped as `withSession` only, which made them a confused deputy
 * for the Console UAMI's DLZ-wide storage read), the inputs that reach the
 * storage data plane are bounded (both segments are URL path components and the
 * prefix is appended to them), and a DENIAL is reported as a denial with the
 * exact role to grant — never as an empty container list, which reads to the
 * user as "this account is empty".
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@/lib/auth/session', () => ({
  getSession: vi.fn(),
  // authorize.ts scopes the tenant with this; the real one is
  // `claims.tid || claims.oid`, which is what the fixture below models.
  tenantScopeId: (s: any) => s?.claims?.tid || s?.claims?.oid,
}));
const canAccessDlzPanes = vi.fn();
const loadTenantDomains = vi.fn();
vi.mock('@/lib/auth/domain-role', () => ({ canAccessDlzPanes: (...a: any[]) => canAccessDlzPanes(...a) }));
vi.mock('@/lib/auth/load-domains', () => ({ loadTenantDomains: (...a: any[]) => loadTenantDomains(...a) }));

const itemQuery = vi.fn();
const authorizeWorkspace = vi.fn();
vi.mock('@/lib/auth/workspace-guard', () => ({
  authorizeWorkspace: (...a: any[]) => authorizeWorkspace(...a),
}));
vi.mock('@/lib/azure/cosmos-client', () => ({
  itemsContainer: async () => ({ items: { query: () => ({ fetchAll: () => itemQuery() }) } }),
}));

const listFileSystems = vi.fn();
const listPaths = vi.fn();
vi.mock('@/lib/azure/adls-client', () => ({
  getServiceClientFor: () => ({ listFileSystems: () => listFileSystems() }),
  listPaths: (...a: any[]) => listPaths(...a),
}));

import { GET as CONTAINERS } from '../[account]/containers/route';
import { GET as PATHS } from '../[account]/containers/[container]/paths/route';
import { isValidStorageAccount, isValidContainerName, isSafePrefix } from '../_lib/validate';
import { deploymentLakeAccounts } from '../_lib/authorize';
import { getSession } from '@/lib/auth/session';

const SESSION = { claims: { upn: 'u@contoso.com', oid: 'oid-1', tid: 'tid-1' }, exp: 9_999_999_999 };
/** This deployment's own lake, per LOOM_BRONZE_URL below. */
const LAKE_ACCOUNT = 'loomlake01';
/** An account that is NOT the deployment lake — the confused-deputy target. */
const OTHER_ACCOUNT = 'victimacct99';

function req(qs = '') {
  return { nextUrl: new URL(`http://x/api/storage/acct/containers?${qs}`) } as any;
}
function ctx(params: Record<string, string>) {
  return { params: Promise.resolve(params) } as any;
}
async function* gen(items: unknown[]) {
  for (const i of items) yield i;
}
function httpErr(status: number) {
  const e: any = new Error(`storage ${status}`);
  e.statusCode = status;
  return e;
}
/** The population this PR is built for: signed in, no DLZ standing at all. */
function asWorkspaceUser() {
  (getSession as any).mockReturnValue(SESSION);
  canAccessDlzPanes.mockResolvedValue(false);
  loadTenantDomains.mockResolvedValue([]);
  itemQuery.mockResolvedValue({ resources: [] });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('LOOM_BRONZE_URL', `https://${LAKE_ACCOUNT}.dfs.core.windows.net/bronze`);
  (getSession as any).mockReturnValue(SESSION);
  canAccessDlzPanes.mockResolvedValue(true);
  loadTenantDomains.mockResolvedValue([]);
  itemQuery.mockResolvedValue({ resources: [] });
});
afterEach(() => { vi.unstubAllEnvs(); });

describe('input validation', () => {
  it('bounds the account name', () => {
    expect(isValidStorageAccount('loomlake01')).toBe(true);
    expect(isValidStorageAccount('ab')).toBe(false);
    expect(isValidStorageAccount('Loom-Lake')).toBe(false);
    expect(isValidStorageAccount('a'.repeat(25))).toBe(false);
  });

  it('bounds the container name', () => {
    expect(isValidContainerName('bronze')).toBe(true);
    expect(isValidContainerName('my-container')).toBe(true);
    expect(isValidContainerName('My-Container')).toBe(false);
    expect(isValidContainerName('a--b')).toBe(false);
  });

  it('keeps the prefix inside the container', () => {
    expect(isSafePrefix('')).toBe(true);
    expect(isSafePrefix('Tables/orders')).toBe(true);
    expect(isSafePrefix('../../etc')).toBe(false);
    expect(isSafePrefix('https://evil/x')).toBe(false);
    expect(isSafePrefix('a?comp=list')).toBe(false);
  });
});

/**
 * AUTHORIZATION — the blocker these routes shipped with.
 *
 * `withSession` is AUTHENTICATION. Both routes had nothing else, while `account`
 * came off the URL and the listing ran as the Console UAMI (Storage Blob Data
 * Reader/Contributor across the DLZ). Any signed-in workspace-scoped user could
 * therefore enumerate every container on every reachable account.
 *
 * `check-route-guards` reported violations: 0 on that code, because it counts
 * `withSession` as a guard SIGNAL — presence, not enforcement. So every test
 * below exercises a caller who should be DENIED, and asserts the data plane was
 * never touched, rather than asserting that a wrapper is present.
 */
describe('authorization (not just authentication)', () => {
  it('DENIES a signed-in workspace user an account outside the deployment lake — and never touches storage', async () => {
    asWorkspaceUser();
    const res = await CONTAINERS(req(), ctx({ account: OTHER_ACCOUNT }));
    const j = await res.json();
    expect(res.status).toBe(403);
    expect(j.ok).toBe(false);
    expect(j.error).toMatch(/not authorized/i);
    // The whole point: the UAMI was never driven at an account this caller
    // has no standing on.
    expect(listFileSystems).not.toHaveBeenCalled();
  });

  it('DENIES the same caller the paths route too — the sibling is not a way around it', async () => {
    asWorkspaceUser();
    const res = await PATHS(req('prefix=Tables'), ctx({ account: OTHER_ACCOUNT, container: 'raw' }));
    expect(res.status).toBe(403);
    expect(await res.json().then((j: any) => j.error)).toMatch(/not authorized/i);
    expect(listPaths).not.toHaveBeenCalled();
  });

  it('the denial does not vary with whether the account EXISTS (no existence oracle)', async () => {
    // dfsUrl(account) is public DNS, so a 403/404/502 split evaluated BEFORE
    // authorization would let any signed-in user probe storage-account names
    // globally. Authorization runs first, so Loom never asks — and therefore
    // cannot tell the caller. Same account both times; only what storage WOULD
    // have said differs.
    asWorkspaceUser();
    listFileSystems.mockReturnValue(gen([{ name: 'secrets' }]));
    const exists = await CONTAINERS(req(), ctx({ account: OTHER_ACCOUNT }));
    listFileSystems.mockImplementation(() => { throw httpErr(404); });
    const absent = await CONTAINERS(req(), ctx({ account: OTHER_ACCOUNT }));

    expect(exists.status).toBe(403);
    expect(absent.status).toBe(exists.status);
    expect((await absent.json()).error).toBe((await exists.json()).error);
    expect(listFileSystems).not.toHaveBeenCalled();
  });

  it("ALLOWS any signed-in session this deployment's own lake account (parity with /api/lakehouse/paths)", async () => {
    asWorkspaceUser();
    listFileSystems.mockReturnValue(gen([{ name: 'bronze' }]));
    const res = await CONTAINERS(req(), ctx({ account: LAKE_ACCOUNT }));
    expect(res.status).toBe(200);
    expect((await res.json()).containers[0].name).toBe('bronze');
    // T1 is env-only: no tenant/domain lookup on the path every adopting editor takes.
    expect(loadTenantDomains).not.toHaveBeenCalled();
  });

  it('ALLOWS a DLZ-authoritative caller (tenant admin / domain admin) an arbitrary account', async () => {
    canAccessDlzPanes.mockResolvedValue(true);
    listFileSystems.mockReturnValue(gen([{ name: 'raw' }]));
    const res = await CONTAINERS(req(), ctx({ account: OTHER_ACCOUNT }));
    expect(res.status).toBe(200);
    expect(listFileSystems).toHaveBeenCalled();
  });

  it("ALLOWS an account a lakehouse the caller can ACCESS is bound to", async () => {
    asWorkspaceUser();
    itemQuery.mockResolvedValue({ resources: [{ id: 'lh-1', workspaceId: 'ws-1' }] });
    authorizeWorkspace.mockResolvedValue(null); // null == authorized
    listFileSystems.mockReturnValue(gen([{ name: 'raw' }]));
    const res = await CONTAINERS(req(), ctx({ account: OTHER_ACCOUNT }));
    expect(res.status).toBe(200);
    // The CANONICAL ladder (owner → tenant admin → shared ACL), read-scoped —
    // NOT a `workspaces.item(id, tenantId)` point read, which can only answer
    // "did this caller CREATE it?" and refuses every non-creator member.
    expect(authorizeWorkspace).toHaveBeenCalledWith(SESSION, 'ws-1', { allowReadRoles: true });
  });

  it('DENIES when the caller cannot access the workspace that binds it', async () => {
    asWorkspaceUser();
    itemQuery.mockResolvedValue({ resources: [{ id: 'lh-1', workspaceId: 'ws-other' }] });
    authorizeWorkspace.mockResolvedValue({ status: 404 }); // a denial response
    const res = await CONTAINERS(req(), ctx({ account: OTHER_ACCOUNT }));
    expect(res.status).toBe(403);
    expect(listFileSystems).not.toHaveBeenCalled();
  });

  it('FAILS CLOSED when the authorization evidence itself is unreadable', async () => {
    // An authorization check that cannot reach its evidence has verified
    // nothing. "I could not tell" must never be read as "allowed", and the
    // message must not claim a cause it did not establish (deploy-integrity R7).
    asWorkspaceUser();
    loadTenantDomains.mockRejectedValue(new Error('Cosmos unreachable'));
    const res = await CONTAINERS(req(), ctx({ account: OTHER_ACCOUNT }));
    const j = await res.json();
    expect(res.status).toBe(403);
    expect(j.error).toMatch(/could not establish/i);
    expect(j.error).not.toMatch(/not authorized/i);
    expect(listFileSystems).not.toHaveBeenCalled();
  });

  it('parses the deployment lake accounts out of the configured LOOM_*_URL set', () => {
    expect(deploymentLakeAccounts().has(LAKE_ACCOUNT)).toBe(true);
    expect(deploymentLakeAccounts().has(OTHER_ACCOUNT)).toBe(false);
    vi.stubEnv('LOOM_BRONZE_URL', '');
    expect(deploymentLakeAccounts().size).toBe(0);
  });
});

describe('GET /api/storage/[account]/containers', () => {
  it('401 without a session', async () => {
    (getSession as any).mockReturnValue(null);
    expect((await CONTAINERS(req(), ctx({ account: 'loomlake01' }))).status).toBe(401);
  });

  it('400 on an invalid account name (no data-plane call)', async () => {
    const res = await CONTAINERS(req(), ctx({ account: 'BAD NAME' }));
    expect(res.status).toBe(400);
    expect(listFileSystems).not.toHaveBeenCalled();
  });

  it('lists containers with their sovereign-correct data-plane URLs', async () => {
    listFileSystems.mockReturnValue(gen([{ name: 'raw' }, { name: 'bronze' }]));
    const j = await (await CONTAINERS(req(), ctx({ account: 'loomlake01' }))).json();
    expect(j.ok).toBe(true);
    expect(j.containers.map((c: any) => c.name)).toEqual(['bronze', 'raw']);
    expect(j.containers[0].url).toContain('loomlake01.dfs.');
    expect(j.host).toContain('loomlake01.dfs.');
  });

  it('a 403 names the exact role and the scope it must be at — it is NOT an empty list', async () => {
    listFileSystems.mockImplementation(() => { throw httpErr(403); });
    const res = await CONTAINERS(req(), ctx({ account: 'loomlake01' }));
    const j = await res.json();
    expect(res.status).toBe(403);
    expect(j.ok).toBe(false);
    expect(j.error).toContain('Storage Blob Data Reader');
    expect(j.error).toContain('account-scope');
    expect(j.containers).toBeUndefined();
  });

  it('an unclassified failure says it could not list, not that there is nothing', async () => {
    listFileSystems.mockImplementation(() => { throw new Error('DNS lookup failed'); });
    const res = await CONTAINERS(req(), ctx({ account: 'loomlake01' }));
    expect(res.status).toBe(502);
    expect((await res.json()).error).toContain('Could not list containers');
  });
});

describe('GET /api/storage/[account]/containers/[container]/paths', () => {
  it('401 without a session', async () => {
    (getSession as any).mockReturnValue(null);
    expect((await PATHS(req(), ctx({ account: 'a1b2c3', container: 'raw' }))).status).toBe(401);
  });

  it('walks an arbitrary account + container (what /api/lakehouse/paths cannot do)', async () => {
    listPaths.mockResolvedValue([{ name: 'Tables/orders', isDirectory: true, size: 0 }]);
    const j = await (await PATHS(req('prefix=Tables'), ctx({ account: 'loomlake01', container: 'raw' }))).json();
    expect(j.ok).toBe(true);
    expect(listPaths).toHaveBeenCalledWith('raw', 'Tables', 200, 'loomlake01');
    expect(j.paths[0].name).toBe('Tables/orders');
  });

  it('400 on a traversal prefix, before any data-plane call', async () => {
    const res = await PATHS(req('prefix=../../other'), ctx({ account: 'loomlake01', container: 'raw' }));
    expect(res.status).toBe(400);
    expect(listPaths).not.toHaveBeenCalled();
  });

  it('caps maxResults and reports the truncation instead of implying completeness', async () => {
    listPaths.mockResolvedValue(Array.from({ length: 1000 }, (_, i) => ({ name: `f${i}`, isDirectory: false, size: 1 })));
    const j = await (await PATHS(req('maxResults=99999'), ctx({ account: 'loomlake01', container: 'raw' }))).json();
    expect(listPaths).toHaveBeenCalledWith('raw', '', 1000, 'loomlake01');
    expect(j.truncated).toBe(true);
  });

  it('a 403 names the role rather than returning an empty folder', async () => {
    listPaths.mockRejectedValue(httpErr(403));
    const res = await PATHS(req(), ctx({ account: 'loomlake01', container: 'raw' }));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toContain('Storage Blob Data Reader');
  });
});
