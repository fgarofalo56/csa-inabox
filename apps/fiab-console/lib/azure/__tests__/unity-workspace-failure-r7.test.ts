/**
 * #3841 — a per-workspace federation failure must describe only what the code
 * ESTABLISHED (deploy-integrity R7).
 *
 * THE DEFECT. `listAllMetastores` built every synthetic error row as
 *     `(workspace ${host} unreachable: ${e?.status} ${e?.message})`
 * — hard-coding the word "unreachable" for EVERY throw class while
 * interpolating the HTTP status right beside it. So an authorization denial
 * rendered as "(workspace X unreachable: 403 …)", which is self-contradictory:
 * an HTTP status is *proof the server was reached and answered*.
 *
 * WHY IT MATTERS MORE IN GOV. Databricks Unity Catalog does not exist in Azure
 * Government, so Loom Unity IS the catalog + external-engine federation story
 * there (cloud-parity.md). A false "unreachable" points the next investigator at
 * networking while the container is Healthy with a connected replica — exactly
 * the wrong-cause-assertion R7 exists to prevent.
 *
 * TEST SHAPE. The obvious narrow fix is to special-case 403 and leave every
 * other status saying "unreachable". These tests therefore assert across the
 * WHOLE answered-status class — 401/403/404/429/500/501/503 — plus the one case
 * that genuinely earns the word: a throw carrying no HTTP status at all. The
 * count is pinned so that population cannot shrink silently; 429 and 503 were
 * added after a review showed the original {401,403,404,500,501} left a hole at
 * exactly the status a real Databricks rate-limit produces.
 *
 * They also pin an OUT-OF-LANE CONSUMER CONTRACT: `app/api/catalog/metastores/
 * route.ts` regex-tests this very string with /account.?admin/i to raise the
 * account-admin gate. Dropping the underlying message would silently disable
 * that gate, so a case below proves it survives.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@azure/identity', () => {
  class Cred { async getToken() { return { token: 'STUB.TOKEN', expiresOnTimestamp: Date.now() + 3600_000 }; } }
  return { DefaultAzureCredential: Cred, ManagedIdentityCredential: Cred, ChainedTokenCredential: Cred };
});

import { describeWorkspaceFailure, listAllMetastores, type UCMetastore } from '../unity-catalog-client';

const realFetch = global.fetch;
function mockFetch(handler: (url: string) => any) {
  global.fetch = vi.fn(async (url: any) => {
    const body = await handler(String(url));
    return body instanceof Response ? body : new Response(JSON.stringify(body), { status: 200 });
  }) as any;
}

const HOST = 'adb-123.9.databricks.azure.us';

beforeEach(() => {
  delete process.env.LOOM_DATABRICKS_HOSTNAMES;
  delete process.env.LOOM_DATABRICKS_HOSTNAME;
  delete process.env.LOOM_UC_BACKEND;
});
afterEach(() => { global.fetch = realFetch; vi.restoreAllMocks(); });

describe('#3841 — "unreachable" is reserved for an actual absence of response', () => {
  it('does NOT say unreachable for ANY status the server answered with', () => {
    // POPULATION: seven distinct answered statuses, all asserted, with the count
    // pinned so the set cannot shrink silently — a guard over a shrunken
    // population is green and blind.
    //
    // 429 and 503 are here because a reviewer put 429 BACK into the
    // "unreachable" branch and this suite stayed green at RC=0: the original
    // {401,403,404,500,501} left a hole exactly where a real Databricks
    // rate-limit lands, and a rate-limit is the loudest possible proof that the
    // server was reached and answered.
    const answered = [401, 403, 404, 429, 500, 501, 503];
    expect(answered).toHaveLength(7);
    expect(new Set(answered).size).toBe(7);

    for (const status of answered) {
      const out = describeWorkspaceFailure(HOST, { status, message: 'denied by policy' });
      expect(out, `status ${status}`).not.toMatch(/unreachable/i);
      expect(out, `status ${status}`).toContain(String(status));
      expect(out, `status ${status}`).toContain(HOST);
      // The underlying message is always preserved verbatim.
      expect(out, `status ${status}`).toContain('denied by policy');
    }
  });

  it('a 429 rate-limit is a REJECTION, not an absence of response', () => {
    // Called out on its own because it is the case the original population
    // missed, and because it is the one where "unreachable" is most obviously
    // false: the workspace answered, and it answered "slow down".
    const out = describeWorkspaceFailure(HOST, { status: 429, message: 'Too Many Requests' });
    expect(out).not.toMatch(/unreachable/i);
    expect(out).not.toMatch(/no HTTP response/i);
    expect(out).toContain('429');
    expect(out).toMatch(/rejected the request/i);
  });

  it('DOES say unreachable when there is no HTTP status — the one true case', () => {
    for (const e of [
      { message: 'getaddrinfo ENOTFOUND loom-unity.internal' },
      { message: 'connect ECONNREFUSED 10.0.0.7:8080' },
      { message: 'The operation was aborted due to timeout' },
    ]) {
      const out = describeWorkspaceFailure(HOST, e);
      expect(out).toMatch(/unreachable/i);
      expect(out).toMatch(/no HTTP response/i);
      expect(out).toContain(e.message);
    }
  });

  it('treats a zero / absent / non-numeric status as "no response", not as a status', () => {
    for (const bad of [undefined, null, 0, NaN, 'nope']) {
      const out = describeWorkspaceFailure(HOST, { status: bad as any, message: 'x' });
      expect(out, String(bad)).toMatch(/unreachable/i);
    }
  });

  it('distinguishes a DENIAL from a NOT-FOUND from a SERVER ERROR', () => {
    const denied = describeWorkspaceFailure(HOST, { status: 403, message: 'PERMISSION_DENIED' });
    const missing = describeWorkspaceFailure(HOST, { status: 404, message: 'nope' });
    const broken = describeWorkspaceFailure(HOST, { status: 500, message: 'boom' });

    expect(denied).toMatch(/denied access/i);
    expect(missing).toMatch(/not found/i);
    expect(broken).toMatch(/server error/i);
    // Three distinct classifications, not one string with the number swapped.
    expect(new Set([denied, missing, broken]).size).toBe(3);
  });

  it('PRESERVES the account-admin wording the metastores route regex-tests', () => {
    // app/api/catalog/metastores/route.ts:129 → /account.?admin/i.test(m.name)
    // If this stops matching, the accountAdminGate silently never fires.
    const out = describeWorkspaceFailure(HOST, {
      status: 403,
      message: 'This API is only available to account admins',
    });
    expect(/account.?admin/i.test(out)).toBe(true);
  });
});

describe('#3841 — the classifier is actually WIRED into the federation loop', () => {
  it('a 403 workspace yields an ERROR_ row that does not claim unreachability', async () => {
    process.env.LOOM_DATABRICKS_HOSTNAMES = `good.azuredatabricks.net,${HOST}`;
    mockFetch((url) => (url.includes('good.')
      ? { metastores: [{ metastore_id: 'm1', name: 'good' }] }
      : new Response('{"message":"PERMISSION_DENIED"}', { status: 403 })));

    const out = await listAllMetastores();
    const errRow = out.find((m: UCMetastore) => m.metastore_id.startsWith('ERROR_'));

    // POPULATION: exactly one good row and exactly one error row — so the
    // assertion below is not being made against an empty find().
    expect(out).toHaveLength(2);
    expect(errRow).toBeDefined();
    expect(errRow!.workspace_hostname).toBe(HOST);

    // THE REGRESSION, end to end.
    expect(errRow!.name).not.toMatch(/unreachable/i);
    expect(errRow!.name).toContain('403');
    expect(errRow!.name).toMatch(/denied access/i);
  });

  it('keeps the ERROR_ id prefix that two BFF routes branch on', async () => {
    // app/api/catalog/metastores/route.ts:128 and app/api/catalog/browse/route.ts:69
    // both do metastore_id.startsWith('ERROR_'). Changing the prose must not
    // change the id contract.
    process.env.LOOM_DATABRICKS_HOSTNAMES = HOST;
    mockFetch(() => new Response('{"message":"nope"}', { status: 404 }));

    const out = await listAllMetastores();
    expect(out).toHaveLength(1);
    expect(out[0].metastore_id).toBe(`ERROR_${HOST}`);
    expect(out[0].workspace_hostname).toBe(HOST);
  });
});
