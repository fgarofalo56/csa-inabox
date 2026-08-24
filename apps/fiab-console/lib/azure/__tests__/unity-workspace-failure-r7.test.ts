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

  it('never renders a zero / absent / non-numeric status AS a status', () => {
    // ORIGINAL INTENT, PRESERVED: `NaN`, `'nope'` and `0` must never be
    // interpolated as if they were an HTTP status.
    //
    // ASSERTION CHANGED, DELIBERATELY: this used to require /unreachable/i for
    // all five. That encoded the very inference this suite now rejects —
    // "no readable status" is NOT evidence of a transport failure. None of
    // these five carries transport evidence, so the honest answer is that the
    // cause was not established. `describeWorkspaceFailure` says exactly that.
    for (const bad of [undefined, null, 0, NaN, 'nope']) {
      const out = describeWorkspaceFailure(HOST, { status: bad as any, message: 'x' });
      expect(out, String(bad)).not.toMatch(/responded\s+(0|NaN|nope|undefined|null)/i);
      expect(out, String(bad)).toMatch(/cause not established/i);
      // ...and it must NOT claim unreachability it cannot support.
      expect(out, String(bad)).not.toMatch(/unreachable/i);
      expect(out, String(bad)).toContain('x');
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

/**
 * ROUND 3 — the two arms where the round-2 copy asserted a cause the code never
 * established. Both are STRICTLY WORSE than the string they replaced: the
 * original was self-contradictory ("unreachable: 200") and therefore
 * self-flagging; the replacement was confident, plausible and false.
 *
 * Reachability of both, traced at the PR head and reproduced before fixing:
 *   LOOM_UC_BACKEND=oss (admin-plane/main.bicep pins 'oss' on GCC-High / IL5)
 *    -> listAllMetastores -> listMetastoresFromWorkspace -> ucFetch
 *    -> ossUcAuthHeader()  [INSIDE ucFetch's try]
 *         |- OssUcAuthNotConfiguredError  (hint, NO status)          -> ARM 1
 *         '- exchangeForInternalUcToken -> UcTokenExchangeError(msg, res.status)
 *            at the two sites AFTER `if (!res.ok)`, i.e. status is 2xx    -> ARM 2
 *    -> catch -> describeWorkspaceFailure(host, e)
 */
describe('#3924 R3 — provenance, not just presence of a number', () => {
  // The two messages below are the VERBATIM production strings from
  // uc-token-exchange.ts, at the only two sites that can carry a 2xx.
  const NON_JSON = 'Loom Unity returned a non-JSON token-exchange response.';
  const NO_TOKEN = 'Loom Unity token-exchange response carried no access_token.';

  it('a 2xx from the TOKEN EXCHANGE is never reported as a workspace rejection', () => {
    // 200 is the PRODUCTION cardinality — `res.ok` is true for 200-299, and a
    // token endpoint answering 200 with an unusable body is the realistic case.
    // Mutating at the production value is the point: a bypass special-cased to
    // some other status would survive a fixture that used a different one.
    for (const message of [NON_JSON, NO_TOKEN]) {
      const out = describeWorkspaceFailure(HOST, {
        name: 'UcTokenExchangeError', status: 200, message,
      });
      // THE DEFECT: the workspace rejected nothing, and was never asked.
      expect(out, message).not.toMatch(/rejected the request/i);
      expect(out, message).not.toMatch(/denied access/i);
      // The endpoint that actually answered must be named.
      expect(out, message).toMatch(/token-exchange endpoint/i);
      expect(out, message).toContain('200');
      expect(out, message).toContain(message);
    }
  });

  it('POPULATION: no non-error status is ever called a rejection', () => {
    // The round-2 implementation's `else` arm silently absorbed EVERYTHING from
    // 1 to 400. The pinned answered-set was all >= 401, so the whole class below
    // it was untested. Pinned by length AND distinct-count so it cannot shrink
    // unnoticed, exactly as the answered-set above is.
    const nonError = [100, 200, 201, 202, 204, 301, 302, 304, 307, 399];
    expect(nonError).toHaveLength(10);
    expect(new Set(nonError).size).toBe(10);

    for (const status of nonError) {
      // via the token exchange...
      const viaExchange = describeWorkspaceFailure(HOST, {
        name: 'UcTokenExchangeError', status, message: NO_TOKEN,
      });
      expect(viaExchange, `exchange ${status}`).not.toMatch(/rejected the request/i);
      expect(viaExchange, `exchange ${status}`).toMatch(/token-exchange endpoint/i);

      // ...and from any other producer. "rejected" must not appear here either:
      // a non-error response did not refuse anything.
      const direct = describeWorkspaceFailure(HOST, { status, message: 'boom' });
      expect(direct, `direct ${status}`).not.toMatch(/rejected the request/i);
      expect(direct, `direct ${status}`).toMatch(/non-error status/i);
      expect(direct, `direct ${status}`).toContain(String(status));
      expect(direct, `direct ${status}`).toContain('boom');
    }
  });

  it('a 4xx/5xx from the TOKEN EXCHANGE is attributed to the exchange, not the workspace', () => {
    // The exchange endpoint refusing our principal is a real and common state
    // (uc-token-exchange.ts throws with res.status inside `if (!res.ok)`), and
    // it is NOT the workspace denying access to a metastore. Conflating the two
    // sends an operator to Unity RBAC to debug an Entra problem.
    const out = describeWorkspaceFailure(HOST, {
      name: 'UcTokenExchangeError', status: 403,
      message: 'Loom Unity rejected the token exchange (HTTP 403). PERMISSION_DENIED',
    });
    expect(out).toMatch(/token-exchange endpoint/i);
    expect(out).toMatch(/refused the token exchange/i);
    // The plain-workspace verb must NOT be used for an exchange failure.
    const workspace403 = describeWorkspaceFailure(HOST, { status: 403, message: 'PERMISSION_DENIED' });
    expect(workspace403).toMatch(/denied access/i);
    expect(out).not.toBe(workspace403);
  });

  it('an honest CONFIG GATE is not reported as unreachable, and keeps its remediation', () => {
    // OssUcAuthNotConfiguredError: carries `hint`, carries NO `status`, and is
    // thrown BEFORE any request leaves the process. The round-2 copy rendered it
    // as "unreachable - no HTTP response" and discarded bicepModule/followUp.
    const e = {
      name: 'OssUcAuthNotConfiguredError',
      message:
        'Loom Unity authorization is not configured: LOOM_UNITY_CLIENT_ID | LOOM_UNITY_AUDIENCE | LOOM_UNITY_TOKEN',
      hint: {
        missingEnvVar: 'LOOM_UNITY_CLIENT_ID | LOOM_UNITY_AUDIENCE | LOOM_UNITY_TOKEN',
        bicepModule: 'platform/fiab/bicep/modules/compute/loom-unity-app.bicep',
        followUp: 'Set LOOM_UNITY_CLIENT_ID so the Console mints api://<client-id>/.default.',
      },
    };
    const out = describeWorkspaceFailure(HOST, e);

    expect(out).not.toMatch(/unreachable/i);
    expect(out).not.toMatch(/no HTTP response/i);
    expect(out).toMatch(/no request was attempted/i);
    // The remediation must survive into the string an operator actually reads.
    expect(out).toContain('loom-unity-app.bicep');
    expect(out).toContain('LOOM_UNITY_CLIENT_ID');
    expect(out).toContain(e.message);
  });

  it('DISCRIMINATOR: a config gate and a real transport failure differ', () => {
    // Both carry NO status. Under the round-2 implementation they were
    // BYTE-IDENTICAL in shape - both took the "unreachable" arm - so a test
    // asserting only one of them could not tell them apart. This is the branch
    // where the two inputs can actually differ, which is where the assertion
    // belongs.
    const gate = describeWorkspaceFailure(HOST, {
      name: 'OssUcAuthNotConfiguredError',
      message: 'Loom Unity authorization is not configured: LOOM_UNITY_CLIENT_ID',
      hint: { missingEnvVar: 'LOOM_UNITY_CLIENT_ID' },
    });
    const transport = describeWorkspaceFailure(HOST, {
      name: 'TypeError',
      message: 'fetch failed',
      cause: { code: 'ECONNREFUSED' },
    });

    expect(gate).not.toBe(transport);
    expect(gate).toMatch(/no request was attempted/i);
    expect(transport).toMatch(/unreachable/i);
    expect(transport).toContain('ECONNREFUSED');
  });

  it('"unreachable" requires POSITIVE transport evidence, and names it', () => {
    // POPULATION: five distinct evidence shapes, pinned. Each must yield
    // "unreachable" AND surface the evidence token, so a future edit cannot
    // keep the word while dropping the justification for it.
    const evidenced: Array<[any, RegExp]> = [
      [{ name: 'FetchTimeoutError', message: 'Request to https://x timed out after 30000ms' }, /timed out/i],
      [{ name: 'AbortError', message: 'This operation was aborted' }, /aborted/i],
      [{ name: 'TypeError', message: 'fetch failed', cause: { code: 'ENOTFOUND' } }, /ENOTFOUND/],
      [{ message: 'connect ECONNREFUSED 10.0.0.7:8080' }, /ECONNREFUSED/],
      [{ message: 'getaddrinfo EAI_AGAIN loom-unity.internal' }, /EAI_AGAIN/],
    ];
    expect(evidenced).toHaveLength(5);
    for (const [e, evidenceRe] of evidenced) {
      const out = describeWorkspaceFailure(HOST, e);
      expect(out, e.message).toMatch(/unreachable/i);
      expect(out, e.message).toMatch(evidenceRe);
    }

    // And WITHOUT evidence the word must not appear at all.
    const unknown = describeWorkspaceFailure(HOST, { name: 'TypeError', message: 'x.y is not a function' });
    expect(unknown).not.toMatch(/unreachable/i);
    expect(unknown).toMatch(/cause not established/i);
  });

  it('reads a status carried as statusCode / response.status, not only .status', () => {
    // Azure SDK RestError uses `statusCode`; some wrappers keep the whole
    // `response`. Reading only `.status` made a 403 from those shapes
    // indistinguishable from "no response at all" - the same absence-is-evidence
    // inference, one property name over.
    for (const [label, e] of [
      ['statusCode', { name: 'RestError', statusCode: 403, message: 'Forbidden' }],
      ['response.status', { name: 'RestError', response: { status: 403 }, message: 'Forbidden' }],
    ] as Array<[string, any]>) {
      const out = describeWorkspaceFailure(HOST, e);
      expect(out, label).not.toMatch(/unreachable/i);
      expect(out, label).not.toMatch(/cause not established/i);
      expect(out, label).toContain('403');
      expect(out, label).toMatch(/denied access/i);
    }
  });

  it('preserves the account-admin wording in EVERY arm, not just the answered one', () => {
    // The /account.?admin/i consumer gate (metastores/route.ts:129) reads the
    // rendered string. A new arm that drops `message` disables that gate for
    // that arm only - a partial failure no single-arm test would catch.
    const ADMIN = 'This API is only available to account admins';
    const arms = [
      { status: 403, message: ADMIN },                                        // answered
      { name: 'UcTokenExchangeError', status: 200, message: ADMIN },          // exchange 2xx
      { name: 'UcTokenExchangeError', status: 403, message: ADMIN },          // exchange 4xx
      { status: 204, message: ADMIN },                                        // non-error
      { message: 'connect ECONNREFUSED 1.2.3.4:443 ' + ADMIN },               // transport
      { message: ADMIN },                                                     // cause unknown
      { name: 'OssUcAuthNotConfiguredError', message: ADMIN, hint: { missingEnvVar: 'X' } }, // gate
    ];
    expect(arms).toHaveLength(7);
    for (const [i, e] of arms.entries()) {
      expect(/account.?admin/i.test(describeWorkspaceFailure(HOST, e)), `arm ${i}`).toBe(true);
    }
  });
});
