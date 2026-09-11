/**
 * postgres-flex-client — the subscription listing is `nextLink`-WALKED and
 * reports whether it is WHOLE.
 *
 * Why this file exists (independent re-review of PR #4344, 2026-09-07, blocking
 * finding 1): `listServers()` was a single `armRequest()` that returned
 * `res.value`. Every caller therefore received PAGE ONE of the subscription and
 * treated it as the subscription. One of those callers is the existence gate in
 * front of `POST /api/items/postgres-flexible-server`, the only irreversible
 * write in this wave — a server on page 2+ read as absent, so Loom minted a new
 * admin password and overwrote `pg-admin-<name>`, which is the LIVE server's
 * credential, and then told the operator that no server of that name existed in
 * the subscription. That last sentence is the `deploy-integrity.md` R7 shape the
 * route had just been rewritten to remove.
 *
 * The route-level consequences are asserted in
 * `app/api/items/postgres-flexible-server/__tests__/provision-credentials.test.ts`
 * (which mocks this client). THIS file measures the client itself, against a
 * mocked ARM transport, so the two halves of the fix are each covered by a test
 * that fails without it:
 *
 *   - the walk follows `nextLink` verbatim (it is an absolute URL carrying an
 *     opaque continuation token, so it must NOT be re-based onto the ARM host);
 *   - a walk that ends on the page CAP is reported as `truncatedBy: 'pages'`,
 *     which is a THIRD state — neither "found" nor "absent";
 *   - a walk that ends on an absent `nextLink` is reported as `truncatedBy:
 *     null`, and that is the only value that licenses a caller to act on
 *     absence.
 *
 * MUTATION RECEIPT (measured 2026-09-07, applied alone, reverted after;
 * `npx vitest run lib/azure/__tests__/postgres-flex-paging.test.ts`):
 *   - revert `listServersResult` to the single-page `armRequest` + `res.value`
 *     (returning `truncatedBy: null, pagesFetched: 1`) → RC=1, 6 failed / 3
 *     passed. The multi-page cases collect 1 server instead of 3, the
 *     continuation URL is never requested (`urls[1]` is undefined), and both
 *     third-state cases fail on `expected null to be 'pages'` — i.e. a capped
 *     walk became indistinguishable from a complete one, which is exactly the
 *     defect.
 *
 * No real Azure I/O: the credential and `fetchWithTimeout` are mocked, the ARM
 * bodies are the real `{ value, nextLink }` envelope shape.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const urls: string[] = [];
/** url -> the ARM list envelope to answer with. */
let responder: (url: string) => any = () => ({ value: [] });

vi.mock('@azure/identity', () => {
  class Cred { async getToken() { return { token: 'TOK', expiresOnTimestamp: Date.now() + 3600_000 }; } }
  return { DefaultAzureCredential: Cred, ManagedIdentityCredential: Cred, ChainedTokenCredential: Cred };
});
vi.mock('@/lib/azure/aca-managed-identity', () => ({ AcaManagedIdentityCredential: class { async getToken() { return null; } } }));
vi.mock('@/lib/azure/fetch-with-timeout', () => ({
  FetchTimeoutError: class FetchTimeoutError extends Error { timeoutMs = 0; },
  fetchWithTimeout: vi.fn(async (url: string) => {
    urls.push(url);
    return { ok: true, status: 200, text: async () => JSON.stringify(responder(url)) } as any;
  }),
}));

const SUB = 'sub-1';
const LIST = `https://management.azure.com/subscriptions/${SUB}/providers/Microsoft.DBforPostgreSQL/flexibleServers?api-version=2024-08-01`;
const server = (name: string) => ({
  id: `/subscriptions/${SUB}/resourceGroups/rg1/providers/Microsoft.DBforPostgreSQL/flexibleServers/${name}`,
  name,
  location: 'eastus',
  properties: { fullyQualifiedDomainName: `${name}.postgres.database.azure.com`, state: 'Ready' },
});
/** ARM hands back an absolute continuation URL, not a path. */
const cont = (n: number) => `https://management.azure.com/subscriptions/${SUB}/providers/Microsoft.DBforPostgreSQL/flexibleServers?api-version=2024-08-01&$skipToken=PAGE${n}`;

const SAVED = { ...process.env };
beforeEach(() => {
  urls.length = 0;
  process.env.LOOM_SUBSCRIPTION_ID = SUB;
  delete process.env.LOOM_ARM_PAGING_MAX_PAGES;
  delete process.env.LOOM_ARM_PAGING_BUDGET_MS;
});
afterEach(() => { process.env = { ...SAVED }; vi.clearAllMocks(); });

describe('listServersResult — the walk', () => {
  it('follows nextLink across pages and returns EVERY server, not page one', async () => {
    responder = (url) => {
      if (url.includes('$skipToken=PAGE2')) return { value: [server('pg3')] };
      if (url.includes('$skipToken=PAGE1')) return { value: [server('pg2')], nextLink: cont(2) };
      return { value: [server('pg1')], nextLink: cont(1) };
    };
    const { listServersResult } = await import('../postgres-flex-client');
    const r = await listServersResult();
    expect(r.servers.map((s) => s.name)).toEqual(['pg1', 'pg2', 'pg3']);
    expect(r.pagesFetched).toBe(3);
    // Ended on an absent nextLink — the list is WHOLE.
    expect(r.truncatedBy).toBeNull();
  });

  it('requests the continuation URL VERBATIM — it carries an opaque token', async () => {
    responder = (url) => (url.includes('$skipToken=PAGE1') ? { value: [server('pg2')] } : { value: [server('pg1')], nextLink: cont(1) });
    const { listServersResult } = await import('../postgres-flex-client');
    await listServersResult();
    expect(urls[0]).toBe(LIST);
    expect(urls[1]).toBe(cont(1));
    // A re-based nextLink would double the host; assert it never happens.
    expect(urls.every((u) => u.split('https://').length === 2)).toBe(true);
  });

  it('maps every page through mapServer (fqdn/state survive the walk)', async () => {
    responder = (url) => (url.includes('$skipToken') ? { value: [server('pg2')] } : { value: [server('pg1')], nextLink: cont(1) });
    const { listServersResult } = await import('../postgres-flex-client');
    const r = await listServersResult();
    expect(r.servers[1]).toMatchObject({ name: 'pg2', fqdn: 'pg2.postgres.database.azure.com', state: 'Ready', resourceGroup: 'rg1' });
  });

  it('a single complete page is truncatedBy: null — silence means WHOLE', async () => {
    responder = () => ({ value: [server('pg1')] });
    const { listServersResult } = await import('../postgres-flex-client');
    const r = await listServersResult();
    expect(r.truncatedBy).toBeNull();
    expect(r.pagesFetched).toBe(1);
    expect(urls).toHaveLength(1);
  });

  it('an empty first page with no nextLink is ABSENCE, and says so', async () => {
    responder = () => ({ value: [] });
    const { listServersResult } = await import('../postgres-flex-client');
    const r = await listServersResult();
    expect(r.servers).toEqual([]);
    expect(r.truncatedBy).toBeNull();
  });
});

describe('listServersResult — the third state', () => {
  it('reports truncatedBy: "pages" when the chain outlives the page cap', async () => {
    process.env.LOOM_ARM_PAGING_MAX_PAGES = '3';
    // An endless chain: every page hands back another nextLink.
    let n = 0;
    responder = () => ({ value: [server(`pg${n++}`)], nextLink: cont(n) });
    const { listServersResult } = await import('../postgres-flex-client');
    const r = await listServersResult();
    expect(r.pagesFetched).toBe(3);
    expect(r.servers).toHaveLength(3);
    // The rows are kept — but the caller is TOLD the list is not whole.
    expect(r.truncatedBy).toBe('pages');
  });

  it('a capped walk is not distinguishable from a complete one by ROWS alone — only by truncatedBy', async () => {
    process.env.LOOM_ARM_PAGING_MAX_PAGES = '1';
    responder = () => ({ value: [], nextLink: cont(1) });
    const { listServersResult } = await import('../postgres-flex-client');
    const r = await listServersResult();
    // Zero rows, exactly like a genuinely empty subscription…
    expect(r.servers).toEqual([]);
    // …and this is the ONLY thing that tells them apart. A caller reading rows
    // alone would call an unread subscription "free".
    expect(r.truncatedBy).toBe('pages');
  });
});

describe('listServers — rows-only wrapper', () => {
  it('returns the walked rows, so pickers see page 2+ too', async () => {
    responder = (url) => (url.includes('$skipToken') ? { value: [server('pg2')] } : { value: [server('pg1')], nextLink: cont(1) });
    const { listServers } = await import('../postgres-flex-client');
    expect((await listServers()).map((s) => s.name)).toEqual(['pg1', 'pg2']);
  });

  it('still fails fast without a subscription', async () => {
    delete process.env.LOOM_SUBSCRIPTION_ID;
    const { listServers } = await import('../postgres-flex-client');
    await expect(listServers()).rejects.toThrow(/LOOM_SUBSCRIPTION_ID/);
    expect(urls).toHaveLength(0);
  });
});
